import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runChildProcess, readLatestKiroSession } = vi.hoisted(() => ({
  runChildProcess: vi.fn(),
  readLatestKiroSession: vi.fn(async () => null),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    runChildProcess,
    ensureCommandResolvable: vi.fn(async () => undefined),
    resolveCommandForLogs: vi.fn(async () => "/usr/local/bin/kiro-cli"),
    readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
  };
});

vi.mock("./sessions.js", () => ({ readLatestKiroSession }));

import { executeKiroCli as execute } from "./execute.js";

let home: string;
let workspace: string;
/** The profile is deleted when the run ends, so capture it while kiro "runs". */
let capturedProfile: Record<string, unknown> | null;
let capturedProfilePath: string | null;

function agentProfileDir() {
  return path.join(home, ".kiro", "agents");
}

function buildContext(config: Record<string, unknown> = {}, context: Record<string, unknown> = {}) {
  return {
    runId: "6df88c24-8e14-478b-9c5f-d459fa5baed4",
    agent: { id: "agent-1", companyId: "company-1", name: "Founding Engineer", role: "engineer" },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { cwd: workspace, ...config },
    context: { taskId: "task-1", ...context },
    onLog: vi.fn(async () => {}),
    onMeta: vi.fn(async () => {}),
    authToken: "token-1",
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kiro-execute-"));
  home = path.join(root, "home");
  workspace = path.join(root, "workspace");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("KIRO_HOME", path.join(home, ".kiro"));
  capturedProfile = null;
  capturedProfilePath = null;

  runChildProcess.mockImplementation(async (_runId: string, _command: string, args: string[]) => {
    const agentIndex = args.indexOf("--agent");
    if (agentIndex >= 0) {
      capturedProfilePath = path.join(agentProfileDir(), `${args[agentIndex + 1]}.json`);
      capturedProfile = JSON.parse(await fs.readFile(capturedProfilePath, "utf-8"));
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "\x1b[38;5;141m> \x1b[0mDone.\x1b[0m",
      stderr: "",
    };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Kiro CLI fallback agent profile", () => {
  it("grants every tool so --trust-all-tools has something to trust", async () => {
    await execute(buildContext() as never);

    // Regression guard: `tools: []` is an empty allowlist, which leaves the
    // agent with no shell/read/write and makes it hallucinate tool output.
    expect(capturedProfile).toMatchObject({
      tools: ["*"],
      allowedTools: ["*"],
      includeMcpJson: true,
    });
  });

  it("carries the system prompt and passes the task as the positional input", async () => {
    const ctx = buildContext();
    await execute(ctx as never);

    expect(typeof capturedProfile?.prompt).toBe("string");
    const args = runChildProcess.mock.calls[0]?.[2] as string[];
    expect(args.slice(0, 4)).toEqual(["chat", "--no-interactive", "--trust-all-tools", "--agent"]);
    expect(args[args.length - 1]).toContain("You are agent agent-1");
  });

  it("writes the profile outside the workspace and never into the project", async () => {
    await execute(buildContext() as never);

    expect(capturedProfilePath?.startsWith(agentProfileDir())).toBe(true);
    await expect(fs.stat(path.join(workspace, ".kiro"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the profile once the run is over", async () => {
    await execute(buildContext() as never);

    await expect(fs.stat(capturedProfilePath as string)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sweeps stale profiles earlier versions left inside the project", async () => {
    const legacyDir = path.join(workspace, ".kiro", "agents");
    await fs.mkdir(legacyDir, { recursive: true });
    const leaked = path.join(legacyDir, "paperclip-385233e0.json");
    await fs.writeFile(leaked, "{}");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fs.utimes(leaked, twoDaysAgo, twoDaysAgo);

    await execute(buildContext() as never);

    await expect(fs.stat(leaked)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sweeps profiles a killed run left behind, but spares recent ones", async () => {
    await fs.mkdir(agentProfileDir(), { recursive: true });
    const stale = path.join(agentProfileDir(), "paperclip-deadbeef.json");
    const recent = path.join(agentProfileDir(), "paperclip-fresh01.json");
    const foreign = path.join(agentProfileDir(), "my-own-agent.json");
    for (const file of [stale, recent, foreign]) await fs.writeFile(file, "{}");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fs.utimes(stale, twoDaysAgo, twoDaysAgo);

    await execute(buildContext() as never);

    await expect(fs.stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(recent)).resolves.toBeDefined();
    await expect(fs.stat(foreign)).resolves.toBeDefined();
  });

  it("uses the configured cwd when the explicit override is enabled", async () => {
    const hostWorkspace = path.join(path.dirname(workspace), "host-workspace");
    await fs.mkdir(hostWorkspace, { recursive: true });

    await execute(buildContext(
      { preferConfiguredCwd: true },
      { paperclipWorkspace: { cwd: hostWorkspace } },
    ) as never);

    const options = runChildProcess.mock.calls[0]?.[3] as { cwd: string };
    expect(options.cwd).toBe(workspace);
  });

  it("keeps Paperclip's execution workspace as the default", async () => {
    const hostWorkspace = path.join(path.dirname(workspace), "host-workspace");
    await fs.mkdir(hostWorkspace, { recursive: true });

    await execute(buildContext(
      {},
      { paperclipWorkspace: { cwd: hostWorkspace } },
    ) as never);

    const options = runChildProcess.mock.calls[0]?.[3] as { cwd: string };
    expect(options.cwd).toBe(hostWorkspace);
  });

  it("falls back to the auto model instead of kiro's global default", async () => {
    await execute(buildContext() as never);

    expect(capturedProfile?.model).toBe("gpt-5.6-sol");
  });

  it("maps a legacy model id onto a model kiro actually offers", async () => {
    await execute(buildContext({ model: "claude-sonnet-4-20250514" }) as never);

    expect(capturedProfile?.model).toBe("claude-sonnet-4");
  });

  it("names the source of an unknown model instead of leaving kiro to fail alone", async () => {
    const ctx = buildContext({ model: "gpt-4o" });
    await execute(ctx as never);

    const warning = ctx.onLog.mock.calls.map(([, chunk]) => chunk).join("");
    expect(warning).toContain('Model "gpt-4o" is not offered by Kiro');
    expect(warning).toContain("claude-sonnet-4.6");
  });

  it("inherits a markdown base agent into the temporary Paperclip profile", async () => {
    const dir = agentProfileDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "aws-sa.md"), `---
model: claude-opus-5
tools: ["*"]
mcpServers:
  genius:
    command: genius-mcp
resources:
  - file://~/.amz/config.yaml
  - skill://~/.kiro/skills/*/SKILL.md
---
You are an AWS Solutions Architect.

Use Genius first.
`);

    await execute(buildContext({ baseAgent: "aws-sa" }) as never);

    expect(capturedProfile).toMatchObject({
      model: "gpt-5.6-sol",
      mcpServers: { genius: { command: "genius-mcp" } },
      resources: ["file://~/.amz/config.yaml", "skill://~/.kiro/skills/*/SKILL.md"],
      tools: ["*", "@genius"],
      allowedTools: ["*", "@genius"],
    });
    expect(capturedProfile?.prompt).toContain("You are an AWS Solutions Architect.");
  });

  it("lets an explicit Paperclip model override the base agent model", async () => {
    const dir = agentProfileDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "aws-sa.md"), `---\nmodel: claude-opus-5\n---\nSA prompt`);

    await execute(buildContext({ baseAgent: "aws-sa", model: "claude-sonnet-4.6" }) as never);

    expect(capturedProfile?.model).toBe("claude-sonnet-4.6");
  });

  it("fails closed when the requested base agent does not exist", async () => {
    await expect(execute(buildContext({ baseAgent: "missing" }) as never)).rejects.toThrow(
      'Base agent "missing" was not found',
    );
    expect(runChildProcess).not.toHaveBeenCalled();
  });
});

describe("Kiro CLI fallback MCP wiring", () => {
  async function writeKiroMcpJson(root: string, body: string) {
    await fs.mkdir(path.join(root, ".kiro", "settings"), { recursive: true });
    await fs.writeFile(path.join(root, ".kiro", "settings", "mcp.json"), body);
  }

  it("allowlists the servers from kiro's own mcp.json", async () => {
    await writeKiroMcpJson(home, '{"mcpServers":{"Roblox_Studio":{"command":"/bin/StudioMCP"}}}');

    await execute(buildContext() as never);

    // includeMcpJson alone configures the server but withholds its tools.
    expect(capturedProfile?.tools).toEqual(["*", "@Roblox_Studio"]);
    expect(capturedProfile?.allowedTools).toEqual(["*", "@Roblox_Studio"]);
  });

  it("writes Paperclip's own connections into the profile with their bearer token", async () => {
    const ctx = buildContext();
    (ctx as Record<string, unknown>).runtimeMcp = {
      getServers: () => [
        { name: "linear", url: "https://paperclip.local/mcp/linear", token: "tok-1", connectionId: "c1" },
      ],
    };

    await execute(ctx as never);

    expect(capturedProfile?.mcpServers).toEqual({
      linear: {
        url: "https://paperclip.local/mcp/linear",
        headers: { Authorization: "Bearer tok-1" },
      },
    });
    expect(capturedProfile?.tools).toEqual(["*", "@linear"]);
  });

  it("combines both sources and logs what the run can reach", async () => {
    await writeKiroMcpJson(home, '{"mcpServers":{"Roblox_Studio":{}}}');
    const ctx = buildContext();
    (ctx as Record<string, unknown>).runtimeMcp = {
      getServers: () => [{ name: "linear", url: "https://paperclip.local/mcp/linear", token: "t" }],
    };

    await execute(ctx as never);

    expect(capturedProfile?.tools).toEqual(["*", "@Roblox_Studio", "@linear"]);
    const logged = ctx.onLog.mock.calls.map(([, chunk]) => chunk).join("");
    expect(logged).toContain("MCP servers available to this run: Roblox_Studio, linear.");
  });

  it("never logs the token it just wrote", async () => {
    const ctx = buildContext();
    (ctx as Record<string, unknown>).runtimeMcp = {
      getServers: () => [{ name: "linear", url: "https://paperclip.local/mcp/linear", token: "s3cret" }],
    };

    await execute(ctx as never);

    expect(ctx.onLog.mock.calls.map(([, chunk]) => chunk).join("")).not.toContain("s3cret");
  });

  it("omits mcpServers entirely when Paperclip has no connections", async () => {
    await writeKiroMcpJson(home, '{"mcpServers":{"Roblox_Studio":{}}}');

    await execute(buildContext() as never);

    // Regression guard: an empty `mcpServers: {}` suppresses the
    // `includeMcpJson` merge in kiro, so kiro's own servers would silently
    // disappear from a run that has no Paperclip connections.
    expect(capturedProfile).not.toHaveProperty("mcpServers");
    expect(capturedProfile?.tools).toEqual(["*", "@Roblox_Studio"]);
  });

  it("does not fail the run when the host's MCP accessor throws", async () => {
    const ctx = buildContext();
    (ctx as Record<string, unknown>).runtimeMcp = {
      getServers: () => {
        throw new Error("connection registry unavailable");
      },
    };

    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(0);
    expect(capturedProfile).not.toHaveProperty("mcpServers");
  });
});

describe("Kiro CLI fallback paperclip api url", () => {
  function childEnv() {
    return (runChildProcess.mock.calls[0]?.[3] as { env: Record<string, string> }).env;
  }

  it("hands the agent the loopback API even when the host is configured with the public one", async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "https://paperclip.ateam.dev.eggs.de");
    vi.stubEnv("PAPERCLIP_LISTEN_PORT", "3100");
    const ctx = buildContext();

    await execute(ctx as never);

    expect(childEnv().PAPERCLIP_API_URL).toBe("http://127.0.0.1:3100");
    expect(ctx.onLog.mock.calls.map(([, chunk]) => chunk).join("")).toContain(
      "is not local; this run calls the Paperclip API at http://127.0.0.1:3100",
    );
  });

  it("overrides a public API URL coming from the agent config", async () => {
    vi.stubEnv("PAPERCLIP_LISTEN_PORT", "3100");

    await execute(buildContext({ env: { PAPERCLIP_API_URL: "https://paperclip.ateam.dev.eggs.de" } }) as never);

    expect(childEnv().PAPERCLIP_API_URL).toBe("http://127.0.0.1:3100");
  });

  it("keeps loopback calls off any configured HTTP proxy", async () => {
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");

    await execute(buildContext() as never);

    expect(childEnv().NO_PROXY).toBe("localhost,127.0.0.1,::1");
    expect(childEnv().no_proxy).toBe("localhost,127.0.0.1,::1");
  });

  it("names the local API base in the prompt", async () => {
    vi.stubEnv("PAPERCLIP_LISTEN_PORT", "3100");

    await execute(buildContext() as never);

    const args = runChildProcess.mock.calls[0]?.[2] as string[];
    expect(args[args.length - 1]).toContain("Paperclip API base URL: http://127.0.0.1:3100");
  });

  it("spells out the auth header the status update needs", async () => {
    // Without it the server answers "Issue not found", which agents read as a
    // wrong route and then hunt for company-scoped variants that do not exist.
    await execute(buildContext() as never);

    const prompt = (runChildProcess.mock.calls[0]?.[2] as string[]).at(-1) as string;
    expect(prompt).toContain('-H "Authorization: Bearer $PAPERCLIP_API_KEY"');
    expect(prompt).toContain('PATCH "$PAPERCLIP_API_URL/api/issues/task-1"');
    expect(prompt).toContain('POST "$PAPERCLIP_API_URL/api/issues/task-1/comments"');
    expect(prompt).toContain("/api/companies/<id>/issues/<id>` does not exist");
  });

  it("hands the comment-wake fetch the auth header too", async () => {
    await execute(buildContext({}, { wakeCommentId: "comment-9" }) as never);

    const prompt = (runChildProcess.mock.calls[0]?.[2] as string[]).at(-1) as string;
    const profilePrompt = capturedProfile?.prompt as string;
    const both = `${prompt}\n${profilePrompt}`;
    expect(both).toContain('curl -sS "$PAPERCLIP_API_URL/api/issues/task-1/comments/comment-9"');
    expect(both).toContain('-H "Authorization: Bearer $PAPERCLIP_API_KEY"');
  });
});

describe("Kiro CLI fallback thinking effort", () => {
  it("passes the configured effort through to kiro", async () => {
    await execute(buildContext({ effort: "high" }) as never);

    const args = runChildProcess.mock.calls[0]?.[2] as string[];
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });

  it("accepts the schema's own spelling of the field", async () => {
    await execute(buildContext({ thinkingEffort: "max" }) as never);

    const args = runChildProcess.mock.calls[0]?.[2] as string[];
    expect(args[args.indexOf("--effort") + 1]).toBe("max");
  });

  it("omits the flag when no effort is configured", async () => {
    await execute(buildContext() as never);

    expect(runChildProcess.mock.calls[0]?.[2]).not.toContain("--effort");
  });

  it("warns about an effort kiro would silently ignore", async () => {
    const ctx = buildContext({ effort: "ludicrous" });
    await execute(ctx as never);

    expect(ctx.onLog.mock.calls.map(([, chunk]) => chunk).join("")).toContain(
      'Effort "ludicrous" from effort is not one of low, medium, high, xhigh, max; the flag is omitted.',
    );
  });
});

describe("Kiro CLI fallback execution result", () => {
  it("reports the session kiro wrote so the next heartbeat can resume it", async () => {
    readLatestKiroSession.mockResolvedValueOnce({
      sessionId: "5ee45b59",
      updatedAt: "2026-08-06T14:39:22.469Z",
    } as never);

    const result = await execute(buildContext() as never);

    expect(result.sessionId).toBe("5ee45b59");
    expect(result.sessionParams).toEqual({ sessionId: "5ee45b59", cwd: workspace });
    expect(result.sessionDisplayId).toBe("5ee45b59");
  });

  it("omits session fields when kiro reports no usable session", async () => {
    const result = await execute(buildContext() as never);

    expect(result.sessionParams).toBeUndefined();
    expect(result.summary).toBe("Done.");
  });

  it("resumes a stored session that belongs to this directory", async () => {
    const ctx = buildContext();
    ctx.runtime = {
      sessionId: "prev-session",
      sessionParams: { sessionId: "prev-session", cwd: workspace },
      sessionDisplayId: "prev-session",
      taskKey: null,
    } as never;

    await execute(ctx as never);

    const args = runChildProcess.mock.calls[0]?.[2] as string[];
    expect(args).toContain("--resume-id");
    expect(args[args.indexOf("--resume-id") + 1]).toBe("prev-session");
  });

  it("ignores a stored session recorded for a different directory", async () => {
    const ctx = buildContext();
    ctx.runtime = {
      sessionId: "prev-session",
      sessionParams: { sessionId: "prev-session", cwd: "/somewhere/else" },
      sessionDisplayId: "prev-session",
      taskKey: null,
    } as never;

    await execute(ctx as never);

    expect(runChildProcess.mock.calls[0]?.[2]).not.toContain("--resume-id");
  });

  it("surfaces the real error instead of kiro's trust banner on failure", async () => {
    runChildProcess.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: [
        "\x1b[32mAll tools are now trusted (!).\x1b[0m",
        "Agents can sometimes do unexpected things so understand the risks.",
        "The model 'claude-opus-4.6' is not available.",
      ].join("\n"),
    } as never);

    const result = await execute(buildContext() as never);

    expect(result.errorMessage).toBe("The model 'claude-opus-4.6' is not available.");
  });
});
