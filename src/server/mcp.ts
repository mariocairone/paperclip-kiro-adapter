import fs from "node:fs/promises";
import path from "node:path";
import { resolveKiroHome } from "./base-agent.js";

/**
 * `includeMcpJson: true` puts the servers from kiro's mcp.json files into the
 * agent's *configuration* — `kiro-cli mcp status` lists them for the profile.
 * It does not put their tools into the agent's tool set: `tools` is an
 * allowlist, and the wildcard `"*"` covers built-in tools only. MCP tools are
 * addressed separately, which kiro's own `agent_config.json.example` spells out:
 *
 *   "@mcp_server_name/mcp_tool_name",
 *   "@mcp_server_name_without_tool_specification_to_include_all_tools"
 *
 * Verified against kiro-cli 2.16.1: with `tools: ["*"]` an agent reports only
 * the built-ins, and the same agent with `tools: ["*", "@Roblox_Studio"]`
 * reports the MCP server's tools as well. So every configured server has to be
 * named in the profile or a Paperclip agent silently runs without its MCP tools.
 */

/** kiro merges both of these into the server set for a run. */
export function kiroMcpConfigPaths(cwd: string, runtimeEnv: NodeJS.ProcessEnv = process.env): string[] {
  return [
    path.join(resolveKiroHome(runtimeEnv), "settings", "mcp.json"),
    path.join(cwd, ".kiro", "settings", "mcp.json"),
  ];
}

async function readServerNames(file: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    // No config at this scope is the normal case, not an error.
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return [];
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (!servers || typeof servers !== "object") return [];
    return Object.keys(servers as Record<string, unknown>).filter((name) => name.trim().length > 0);
  } catch {
    // A malformed mcp.json is kiro's problem to report; do not fail the run.
    return [];
  }
}

/**
 * Every MCP server name kiro would load for a run in `cwd`, deduplicated. The
 * workspace file wins over the global one for identical names, which matches
 * kiro's own merge, but for tool-allowlisting only the name matters.
 */
export async function readKiroMcpServerNames(
  cwd: string,
  runtimeEnv: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const perFile = await Promise.all(kiroMcpConfigPaths(cwd, runtimeEnv).map(readServerNames));
  return [...new Set(perFile.flat())].sort();
}

/** `["*", "@Roblox_Studio"]` — the wildcard plus one entry per MCP server. */
export function buildKiroToolAllowlist(serverNames: readonly string[]): string[] {
  return ["*", ...serverNames.map((name) => `@${name}`)];
}

/** Shape kiro accepts for an HTTP MCP server inside an agent profile. */
export interface KiroHttpMcpServer {
  url: string;
  headers?: Record<string, string>;
}

/**
 * kiro addresses servers by name; Paperclip connection names are free text.
 * Keep it to what kiro's own names use so a connection called "My Server (v2)"
 * cannot produce an unaddressable `@My Server (v2)`.
 */
export function sanitizeKiroMcpServerName(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Paperclip hands the adapter its own MCP connections as `{ name, url, token }`
 * — the servers configured inside Paperclip rather than in kiro. kiro reaches
 * them over HTTP and sends `headers` as given: verified against kiro-cli 2.16.1,
 * which put `authorization: Bearer …` on the initialize POST.
 *
 * Names that collide with a server from kiro's own mcp.json are skipped: those
 * are already configured, and redefining them here would silently change which
 * endpoint a tool call reaches.
 */
export interface RuntimeMcpServerLike {
  name?: unknown;
  url?: unknown;
  token?: unknown;
}

export function buildRuntimeMcpServers(
  servers: readonly RuntimeMcpServerLike[],
  takenNames: readonly string[] = [],
): Record<string, KiroHttpMcpServer> {
  const taken = new Set(takenNames);
  const out: Record<string, KiroHttpMcpServer> = {};

  for (const server of servers) {
    if (typeof server?.name !== "string" || typeof server.url !== "string") continue;
    const name = sanitizeKiroMcpServerName(server.name);
    const url = server.url.trim();
    if (!name || !url || taken.has(name) || out[name]) continue;

    const token = typeof server.token === "string" ? server.token.trim() : "";
    out[name] = token
      ? { url, headers: { Authorization: `Bearer ${token}` } }
      : { url };
  }

  return out;
}
