import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseAgentCandidatePaths, readKiroBaseAgent, resolveKiroHome } from "./base-agent.js";

let home: string;
let cwd: string;

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kiro-base-agent-"));
  home = path.join(root, "home");
  cwd = path.join(root, "workspace");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(home);
});

afterEach(() => vi.restoreAllMocks());

async function writeAgent(root: string, name: string, body: string, extension = "md") {
  const dir = path.join(root, ".kiro", "agents");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.${extension}`), body);
}

describe("resolveKiroHome", () => {
  it("uses KIRO_HOME when the child process receives it", () => {
    expect(resolveKiroHome({ KIRO_HOME: "/custom/kiro" })).toBe("/custom/kiro");
  });

  it("falls back to ~/.kiro", () => {
    expect(resolveKiroHome({})).toBe(path.join(home, ".kiro"));
  });
});

describe("readKiroBaseAgent", () => {
  it("parses a Genius markdown persona including MCP and resources", async () => {
    await writeAgent(home, "aws-sa", `---
description: AWS Solutions Architect
model: claude-opus-5
tools: ["*"]
mcpServers:
  genius:
    command: genius-mcp
resources:
  - file://~/.amz/config.yaml
  - skill://~/.kiro/skills/*/SKILL.md
welcomeMessage: |
  Welcome
---
You are an AWS Solutions Architect.

Use Genius first.
`);

    const agent = await readKiroBaseAgent("aws-sa", cwd, { KIRO_HOME: path.join(home, ".kiro") });

    expect(agent).toMatchObject({
      name: "aws-sa",
      model: "claude-opus-5",
      tools: ["*"],
      mcpServers: { genius: { command: "genius-mcp" } },
      resources: ["file://~/.amz/config.yaml", "skill://~/.kiro/skills/*/SKILL.md"],
      prompt: "You are an AWS Solutions Architect.\n\nUse Genius first.",
    });
    expect(agent.prompt).not.toContain("Welcome");
  });

  it("prefers a workspace persona over the global one", async () => {
    await writeAgent(home, "aws-sa", `---\nmodel: global\n---\nGlobal prompt`);
    await writeAgent(cwd, "aws-sa", `---\nmodel: workspace\n---\nWorkspace prompt`);

    const agent = await readKiroBaseAgent("aws-sa", cwd, { KIRO_HOME: path.join(home, ".kiro") });

    expect(agent.model).toBe("workspace");
    expect(agent.prompt).toBe("Workspace prompt");
  });

  it("supports JSON agents", async () => {
    await writeAgent(home, "worker", JSON.stringify({ prompt: "JSON prompt", tools: ["read"] }), "json");

    expect(await readKiroBaseAgent("worker", cwd, { KIRO_HOME: path.join(home, ".kiro") })).toMatchObject({
      prompt: "JSON prompt",
      tools: ["read"],
    });
  });

  it("rejects path traversal", () => {
    expect(() => baseAgentCandidatePaths("../aws-sa", cwd, {})).toThrow("Invalid baseAgent");
  });

  it("reports every path checked when the persona is missing", async () => {
    await expect(readKiroBaseAgent("missing", cwd, {})).rejects.toThrow(
      /Base agent "missing" was not found\. Checked:/,
    );
  });
});
