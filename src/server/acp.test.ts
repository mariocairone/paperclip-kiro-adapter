import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { engineExecutor } = vi.hoisted(() => ({
  engineExecutor: vi.fn(async (_ctx: unknown) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    model: null,
    sessionId: "typed-session",
    sessionParams: { sessionKey: "key", acpSessionId: "typed-session" },
    sessionDisplayId: "typed-session",
    resultJson: { status: "completed" },
    summary: "ok",
  })),
}));

vi.mock("@paperclipai/adapter-utils/acpx-engine/execute", () => ({
  createAcpxEngineExecutor: () => engineExecutor,
}));

import {
  assertExplicitKiroAcpAvailable,
  buildKiroAcpCommand,
  buildKiroAcpConfig,
  clearKiroAcpSupportCache,
  createKiroAcpExecutor,
  prepareKiroAcpAgentProfile,
  probeKiroAcpSupport,
  resolveKiroEffort,
  resolveKiroExecutionEngine,
  resolveKiroExecutionEngineForRun,
  shellQuote,
  testKiroAcpEnvironment,
  validateKiroExtraArgs,
} from "./acp.js";
import { buildKiroAgentProfileName, sweepStaleKiroAgentProfiles } from "./agent-profile.js";
import { execute } from "./execute.js";

let root: string;
let home: string;
let kiroHome: string;
let workspace: string;
let commandWithAcp: string;
let commandWithoutAcp: string;
let missingCommand: string;

async function fixtureCommand(name: string, body: string): Promise<string> {
  const target = path.join(root, name);
  await fs.writeFile(target, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return target;
}

function buildContext(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Engineer" },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { cwd: workspace, ...config },
    context: {},
    onLog: vi.fn(async () => undefined),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearKiroAcpSupportCache();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "kiro-acp-test-"));
  home = path.join(root, "home");
  kiroHome = path.join(root, "custom-kiro-home");
  workspace = path.join(root, "workspace");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  commandWithAcp = await fixtureCommand("kiro-acp", "exit 0");
  commandWithoutAcp = await fixtureCommand(
    "kiro-old",
    `echo "error: unrecognized subcommand 'acp'" >&2\nexit 2`,
  );
  missingCommand = path.join(root, "missing-kiro");
  vi.stubEnv("HOME", home);
  vi.stubEnv("KIRO_HOME", kiroHome);
});

afterEach(() => vi.unstubAllEnvs());

describe("engine resolution", () => {
  it("defaults to auto and selects ACP", () => {
    expect(resolveKiroExecutionEngine({})).toEqual({
      engine: "acp",
      configured: "auto",
      explicit: false,
    });
  });

  it("accepts auto, acp, and cli case-insensitively", () => {
    expect(resolveKiroExecutionEngine({ engine: " AUTO " }).configured).toBe("auto");
    expect(resolveKiroExecutionEngine({ engine: "ACP" }).configured).toBe("acp");
    expect(resolveKiroExecutionEngine({ engine: "cli" }).engine).toBe("cli");
  });

  it("rejects an unknown engine", () => {
    expect(() => resolveKiroExecutionEngine({ engine: "magic" })).toThrow("Expected auto, acp, or cli");
  });

  it("falls back only when auto detects a missing acp subcommand", async () => {
    const selection = await resolveKiroExecutionEngineForRun({ config: { command: commandWithoutAcp } });
    expect(selection.engine).toBe("cli");
    expect(selection.fallbackReason).toContain("no \"acp\" subcommand");
  });

  it("does not fall back for a missing binary", async () => {
    const selection = await resolveKiroExecutionEngineForRun({ config: { command: missingCommand } });
    expect(selection.engine).toBe("acp");
    expect(selection.fallbackReason).toBeUndefined();
  });

  it("fails closed when ACP was explicit and the subcommand is missing", async () => {
    await expect(assertExplicitKiroAcpAvailable({ engine: "acp", command: commandWithoutAcp }))
      .rejects.toThrow("explicitly required");
  });

  it("fails closed through the public dispatcher when ACP is explicit", async () => {
    await expect(execute(buildContext({ engine: "acp", command: commandWithoutAcp }) as never))
      .rejects.toThrow("explicitly required");
    expect(engineExecutor).not.toHaveBeenCalled();
  });

  it("recognizes the installed ACP subcommand", async () => {
    expect(await probeKiroAcpSupport(commandWithAcp, { useCache: false })).toMatchObject({ supported: true });
  });
});

describe("ACP command and config", () => {
  it("quotes paths and embedded apostrophes", () => {
    expect(shellQuote("/Applications/Kiro CLI.app/kiro-cli")).toBe("'/Applications/Kiro CLI.app/kiro-cli'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("puts model and effort on the Kiro process command", () => {
    expect(buildKiroAcpCommand({
      command: "kiro-cli",
      agentProfileName: "paperclip-agent",
      model: "claude-sonnet-4.6",
      effort: "max",
    })).toBe("kiro-cli acp --trust-all-tools --agent paperclip-agent --model claude-sonnet-4.6 --effort max");
  });

  it("supports a scoped trust list and an explicit empty list", () => {
    expect(buildKiroAcpCommand({ command: "kiro-cli", trustTools: ["read", "shell"] }))
      .toContain("--trust-tools read,shell");
    expect(buildKiroAcpCommand({ command: "kiro-cli", trustTools: [] }))
      .toBe("kiro-cli acp");
  });

  it.each(["--agent", "--model=x", "--effort", "--resume-id", "--output-format", "--no-interactive"])(
    "rejects reserved extra arg %s",
    (arg) => expect(() => validateKiroExtraArgs([arg])).toThrow("adapter-owned flag"),
  );

  it("uses explicit effort precedence and validates the value", () => {
    expect(resolveKiroEffort({ effort: "xhigh", kiroEffort: "low" })).toMatchObject({ value: "xhigh", source: "effort" });
    expect(resolveKiroEffort({ kiroEffort: "max" })).toMatchObject({ value: "max", source: "kiroEffort" });
    expect(resolveKiroEffort({ effort: "invalid", thinkingEffort: "high" })).toMatchObject({ requested: "invalid", value: null, source: "effort" });
  });

  it("removes every setting that would trigger session/set_config_option", () => {
    const next = buildKiroAcpConfig({
      config: {
        command: "kiro-cli",
        model: "gpt-5.6-sol",
        effort: "high",
        thinkingEffort: "low",
        reasoningEffort: "low",
        modelReasoningEffort: "low",
        fastMode: true,
        extraArgs: ["--agent-engine", "v3"],
      },
      agentProfileName: "paperclip-agent",
      profileFingerprint: "abc",
      model: "claude-sonnet-4.6",
      effort: "high",
    });
    for (const key of ["model", "kiroEffort", "effort", "thinkingEffort", "reasoningEffort", "modelReasoningEffort", "fastMode", "extraArgs"]) {
      expect(next).not.toHaveProperty(key);
    }
    expect(next.agentCommand).toContain("--model claude-sonnet-4.6 --effort high --agent-engine v3");
    expect(next.env).toMatchObject({
      KIRO_PAPERCLIP_PROFILE_FINGERPRINT: "abc",
      NO_PROXY: expect.stringContaining("127.0.0.1"),
    });
  });
});

describe("stable ACP profile", () => {
  it("uses KIRO_HOME, is stable per agent, and writes mode 0600", async () => {
    const prepared = await prepareKiroAcpAgentProfile(buildContext() as never, workspace);
    expect(prepared.profileName).toBe(buildKiroAgentProfileName("agent-1"));
    expect(prepared.profilePath.startsWith(path.join(kiroHome, "agents"))).toBe(true);
    expect((await fs.stat(prepared.profilePath)).mode & 0o777).toBe(0o600);
    const second = await prepareKiroAcpAgentProfile(buildContext() as never, workspace);
    expect(second.profilePath).toBe(prepared.profilePath);
  });

  it("inherits the complete base persona and gives base MCP precedence", async () => {
    const baseDir = path.join(kiroHome, "agents");
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(path.join(baseDir, "aws-sa.json"), JSON.stringify({
      prompt: "Base persona",
      model: "claude-opus-5",
      tools: ["read"],
      allowedTools: ["read"],
      mcpServers: { shared: { command: "base-command" } },
      resources: ["file://resource"],
      toolAliases: { inspect: "read" },
      toolsSettings: { read: { limit: 10 } },
      includeMcpJson: false,
      requireMcpStartup: true,
    }));
    const instructions = path.join(root, "AGENTS.md");
    await fs.writeFile(instructions, "Managed instructions");
    const ctx = buildContext({ baseAgent: "aws-sa", instructionsFilePath: instructions });
    (ctx as Record<string, unknown>).runtimeMcp = {
      getServers: () => [
        { name: "shared", url: "http://runtime/shared", token: "secret" },
        { name: "paperclip", url: "http://runtime/paperclip", token: "token" },
      ],
    };

    const prepared = await prepareKiroAcpAgentProfile(ctx as never, workspace);
    const profile = JSON.parse(await fs.readFile(prepared.profilePath, "utf8"));
    expect(profile).toMatchObject({
      model: "gpt-5.6-sol",
      tools: ["read", "@shared", "@paperclip"],
      allowedTools: ["read", "@shared", "@paperclip"],
      mcpServers: {
        shared: { command: "base-command" },
        paperclip: { url: "http://runtime/paperclip", headers: { Authorization: "Bearer token" } },
      },
      resources: ["file://resource"],
      toolAliases: { inspect: "read" },
      toolsSettings: { read: { limit: 10 } },
      includeMcpJson: false,
      requireMcpStartup: true,
    });
    expect(profile.prompt).toContain("Base persona");
    expect(profile.prompt).toContain("Managed instructions");
    expect(JSON.stringify(profile)).not.toContain("secret");
  });

  it("fails requireMcpStartup when no MCP server exists", async () => {
    await expect(prepareKiroAcpAgentProfile(buildContext({ requireMcpStartup: true }) as never, workspace))
      .rejects.toThrow("no Kiro, base-agent, or runtime MCP server");
  });

  it("sweeps only stale regular adapter profiles", async () => {
    const dir = path.join(kiroHome, "agents");
    await fs.mkdir(dir, { recursive: true });
    const stale = path.join(dir, "paperclip-stale.json");
    const foreign = path.join(dir, "my-agent.json");
    await fs.writeFile(stale, "{}");
    await fs.writeFile(foreign, "{}");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(stale, old, old);
    await fs.utimes(foreign, old, old);
    await sweepStaleKiroAgentProfiles([dir], []);
    await expect(fs.stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(foreign)).resolves.toBeDefined();
  });
});

describe("acpx integration contract", () => {
  it("passes through typed usage only when acpx provides it", async () => {
    engineExecutor.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      usage: { inputTokens: 12, outputTokens: 3 },
      usageBasis: "per_run",
      resultJson: { status: "completed" },
    } as never);
    const result = await createKiroAcpExecutor()(buildContext() as never);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(result.resultJson?.usageJson).toEqual({ inputTokens: 12, outputTokens: 3, basis: "per_run" });
  });

  it("passes startup flags, preserves typed ACP session ids, and documents absent usage", async () => {
    const result = await createKiroAcpExecutor()(buildContext({ model: "gpt-5.6-sol", effort: "high" }) as never);
    const passed = engineExecutor.mock.calls[0]?.[0] as unknown as { config: Record<string, unknown>; runtimeMcp?: unknown };
    expect(passed.config.agentCommand).toContain("--model gpt-5.6-sol --effort high");
    expect(passed.config).not.toHaveProperty("model");
    expect(passed.runtimeMcp).toBeUndefined();
    expect(result.sessionId).toBe("typed-session");
    expect(result.sessionParams).toEqual({ sessionKey: "key", acpSessionId: "typed-session" });
    expect(result.resultJson).toMatchObject({ usageJson: null });
  });
});



describe("ACP preflight validation", () => {
  it("fails when the base agent does not exist", async () => {
    const result = await testKiroAcpEnvironment({
      adapterType: "kiro_acp",
      config: { cwd: workspace, command: commandWithAcp, baseAgent: "missing" },
    } as never);
    expect(result.status).toBe("fail");
    expect(result.checks.some((check) => check.code === "kiro_acp_base_agent_invalid")).toBe(true);
  });

  it("fails when the configured model is unknown", async () => {
    const result = await testKiroAcpEnvironment({
      adapterType: "kiro_acp",
      config: { cwd: workspace, command: commandWithAcp, model: "not-a-kiro-model" },
    } as never);
    expect(result.status).toBe("fail");
    expect(result.checks.some((check) => check.code === "kiro_acp_model_invalid")).toBe(true);
  });
});

describe("ACP MCP inclusion policy", () => {
  it("does not count global mcp.json servers when the base agent disables includeMcpJson", async () => {
    const globalSettings = path.join(kiroHome, "settings");
    const baseDir = path.join(kiroHome, "agents");
    await fs.mkdir(globalSettings, { recursive: true });
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(path.join(globalSettings, "mcp.json"), JSON.stringify({
      mcpServers: { global_only: { command: "global-server" } },
    }));
    await fs.writeFile(path.join(baseDir, "no-global.json"), JSON.stringify({
      prompt: "No global MCP",
      includeMcpJson: false,
      requireMcpStartup: true,
    }));

    await expect(prepareKiroAcpAgentProfile(
      buildContext({ baseAgent: "no-global" }) as never,
      workspace,
    )).rejects.toThrow("no Kiro, base-agent, or runtime MCP server");
  });

  it("allows inline base MCP when includeMcpJson is false", async () => {
    const baseDir = path.join(kiroHome, "agents");
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(path.join(baseDir, "inline-only.json"), JSON.stringify({
      prompt: "Inline MCP",
      includeMcpJson: false,
      requireMcpStartup: true,
      mcpServers: { inline: { command: "inline-server" } },
    }));

    const prepared = await prepareKiroAcpAgentProfile(
      buildContext({ baseAgent: "inline-only" }) as never,
      workspace,
    );
    const profile = JSON.parse(await fs.readFile(prepared.profilePath, "utf8"));
    expect(profile.tools).toContain("@inline");
    expect(profile.includeMcpJson).toBe(false);
  });
});
