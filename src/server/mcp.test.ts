import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildKiroToolAllowlist,
  buildRuntimeMcpServers,
  kiroMcpConfigPaths,
  readKiroMcpServerNames,
  sanitizeKiroMcpServerName,
} from "./mcp.js";

let tmpHome: string;
let tmpCwd: string;

async function writeMcpJson(root: string, body: string) {
  await fs.mkdir(path.join(root, ".kiro", "settings"), { recursive: true });
  await fs.writeFile(path.join(root, ".kiro", "settings", "mcp.json"), body);
}

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "kiro-mcp-"));
  tmpHome = path.join(base, "home");
  tmpCwd = path.join(base, "cwd");
  await fs.mkdir(tmpHome, { recursive: true });
  await fs.mkdir(tmpCwd, { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  vi.stubEnv("KIRO_HOME", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("kiroMcpConfigPaths", () => {
  it("covers the global and the workspace scope kiro merges", () => {
    expect(kiroMcpConfigPaths("/work")).toEqual([
      path.join(tmpHome, ".kiro", "settings", "mcp.json"),
      path.join("/work", ".kiro", "settings", "mcp.json"),
    ]);
  });

  it("uses the same KIRO_HOME as the child process", () => {
    expect(kiroMcpConfigPaths("/work", { KIRO_HOME: "/custom/kiro" })).toEqual([
      path.join("/custom/kiro", "settings", "mcp.json"),
      path.join("/work", ".kiro", "settings", "mcp.json"),
    ]);
  });
});

describe("readKiroMcpServerNames", () => {
  it("returns nothing when no config exists", async () => {
    expect(await readKiroMcpServerNames(tmpCwd)).toEqual([]);
  });

  it("reads the global config", async () => {
    await writeMcpJson(tmpHome, '{"mcpServers":{"Roblox_Studio":{"command":"/bin/StudioMCP"}}}');

    expect(await readKiroMcpServerNames(tmpCwd)).toEqual(["Roblox_Studio"]);
  });

  it("merges both scopes and deduplicates", async () => {
    await writeMcpJson(tmpHome, '{"mcpServers":{"Roblox_Studio":{},"shared":{}}}');
    await writeMcpJson(tmpCwd, '{"mcpServers":{"shared":{},"workspace_only":{}}}');

    expect(await readKiroMcpServerNames(tmpCwd)).toEqual([
      "Roblox_Studio",
      "shared",
      "workspace_only",
    ]);
  });

  it("survives malformed JSON instead of failing the run", async () => {
    await writeMcpJson(tmpHome, "{ not json");
    await writeMcpJson(tmpCwd, '{"mcpServers":{"still_here":{}}}');

    expect(await readKiroMcpServerNames(tmpCwd)).toEqual(["still_here"]);
  });

  it("ignores a config without an mcpServers object", async () => {
    await writeMcpJson(tmpHome, '{"somethingElse":true}');

    expect(await readKiroMcpServerNames(tmpCwd)).toEqual([]);
  });

  it("skips blank server names", async () => {
    await writeMcpJson(tmpHome, '{"mcpServers":{"":{},"real":{}}}');

    expect(await readKiroMcpServerNames(tmpCwd)).toEqual(["real"]);
  });
});

describe("buildKiroToolAllowlist", () => {
  it("keeps the wildcard alone when no server is configured", () => {
    expect(buildKiroToolAllowlist([])).toEqual(["*"]);
  });

  it("adds one @-entry per server, which is what kiro needs to expose them", () => {
    expect(buildKiroToolAllowlist(["Roblox_Studio", "probe_ws"])).toEqual([
      "*",
      "@Roblox_Studio",
      "@probe_ws",
    ]);
  });
});

describe("sanitizeKiroMcpServerName", () => {
  it("reduces a free-text connection name to something addressable as @name", () => {
    expect(sanitizeKiroMcpServerName("My Server (v2)")).toBe("My_Server_v2");
  });

  it("keeps names that are already valid", () => {
    expect(sanitizeKiroMcpServerName("Roblox_Studio")).toBe("Roblox_Studio");
    expect(sanitizeKiroMcpServerName("linear-mcp")).toBe("linear-mcp");
  });

  it("collapses to empty when nothing usable is left", () => {
    expect(sanitizeKiroMcpServerName("  ***  ")).toBe("");
  });
});

describe("buildRuntimeMcpServers", () => {
  it("turns a Paperclip connection into kiro's HTTP server shape", () => {
    expect(
      buildRuntimeMcpServers([
        { name: "linear", url: "https://paperclip.local/mcp/linear", token: "tok-1" },
      ]),
    ).toEqual({
      linear: {
        url: "https://paperclip.local/mcp/linear",
        headers: { Authorization: "Bearer tok-1" },
      },
    });
  });

  it("omits the auth header when no token was issued", () => {
    expect(buildRuntimeMcpServers([{ name: "open", url: "https://example.test/mcp" }])).toEqual({
      open: { url: "https://example.test/mcp" },
    });
  });

  it("skips entries without a usable name or url", () => {
    expect(
      buildRuntimeMcpServers([
        { name: "", url: "https://example.test/mcp" },
        { name: "no_url" },
        { name: "***", url: "https://example.test/mcp" },
        { url: "https://example.test/mcp" },
      ]),
    ).toEqual({});
  });

  it("does not redefine a server kiro already configures", () => {
    expect(
      buildRuntimeMcpServers(
        [
          { name: "Roblox_Studio", url: "https://impostor.test/mcp", token: "t" },
          { name: "fresh", url: "https://example.test/mcp" },
        ],
        ["Roblox_Studio"],
      ),
    ).toEqual({ fresh: { url: "https://example.test/mcp" } });
  });

  it("keeps the first of two connections that sanitize to the same name", () => {
    expect(
      buildRuntimeMcpServers([
        { name: "my server", url: "https://first.test/mcp" },
        { name: "my/server", url: "https://second.test/mcp" },
      ]),
    ).toEqual({ my_server: { url: "https://first.test/mcp" } });
  });

  it("tolerates an empty list", () => {
    expect(buildRuntimeMcpServers([])).toEqual({});
  });
});
