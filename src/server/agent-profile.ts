import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { KiroBaseAgent } from "./base-agent.js";
import { resolveKiroHome, uniqueStrings } from "./base-agent.js";

export const STALE_AGENT_PROFILE_MS = 24 * 60 * 60 * 1000;
export const AGENT_PROFILE_PREFIX = "paperclip-";

export interface KiroAgentProfile {
  name: string;
  model?: string;
  mcpServers?: Record<string, unknown>;
  tools: string[];
  allowedTools: string[];
  toolAliases: Record<string, unknown>;
  resources: string[];
  toolsSettings: Record<string, unknown>;
  includeMcpJson: boolean;
  requireMcpStartup?: boolean;
  prompt: string;
}

export async function ensureKiroAgentProfileDir(
  cwd: string,
  runtimeEnv: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const globalDir = path.join(resolveKiroHome(runtimeEnv), "agents");
  try {
    await fs.mkdir(globalDir, { recursive: true });
    return globalDir;
  } catch {
    const workspaceDir = path.join(cwd, ".kiro", "agents");
    await fs.mkdir(workspaceDir, { recursive: true });
    return workspaceDir;
  }
}

export async function sweepStaleKiroAgentProfiles(
  dirs: readonly string[],
  keepNames: readonly string[],
): Promise<void> {
  const cutoff = Date.now() - STALE_AGENT_PROFILE_MS;
  const keep = new Set(keepNames.map((name) => `${name}.json`));

  await Promise.all(dirs.map(async (dir) => {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    await Promise.all(entries
      .filter((entry) => entry.startsWith(AGENT_PROFILE_PREFIX) && entry.endsWith(".json"))
      .filter((entry) => !keep.has(entry))
      .map(async (entry) => {
        const target = path.join(dir, entry);
        try {
          const stat = await fs.lstat(target);
          if (stat.isFile() && stat.mtimeMs < cutoff) await fs.rm(target);
        } catch {
          // A concurrent run may have replaced or removed the file.
        }
      }));
  }));
}

export function buildKiroAgentProfileName(agentId: string): string {
  const normalizedId = agentId.trim() || "agent";
  const slug = normalizedId
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "agent";
  const digest = createHash("sha256").update(normalizedId).digest("hex").slice(0, 10);
  return `${AGENT_PROFILE_PREFIX}${slug}-${digest}`;
}

export function buildKiroAgentProfile(input: {
  name: string;
  model: string;
  systemPrompt: string;
  baseAgent?: KiroBaseAgent | null;
  kiroMcpServerNames: readonly string[];
  runtimeMcpServers: Record<string, unknown>;
  requireMcpStartup?: boolean;
}): KiroAgentProfile {
  const base = input.baseAgent;
  const baseMcpServers = base?.mcpServers ?? {};
  const inlineMcpServers = { ...input.runtimeMcpServers, ...baseMcpServers };
  const mcpServerNames = uniqueStrings([
    ...input.kiroMcpServerNames,
    ...Object.keys(baseMcpServers),
    ...Object.keys(input.runtimeMcpServers),
  ]);
  const mcpTools = mcpServerNames.map((name) => `@${name}`);
  const baseTools = base?.tools ?? ["*"];
  const tools = uniqueStrings([...baseTools, ...mcpTools]);
  const allowedTools = uniqueStrings([...(base?.allowedTools ?? baseTools), ...mcpTools]);

  return {
    name: input.name,
    model: input.model,
    ...(Object.keys(inlineMcpServers).length > 0 ? { mcpServers: inlineMcpServers } : {}),
    tools,
    allowedTools,
    toolAliases: base?.toolAliases ?? {},
    resources: base?.resources ?? [],
    toolsSettings: base?.toolsSettings ?? {},
    includeMcpJson: base?.includeMcpJson ?? true,
    ...((input.requireMcpStartup ?? base?.requireMcpStartup) !== undefined
      ? { requireMcpStartup: input.requireMcpStartup ?? base?.requireMcpStartup }
      : {}),
    prompt: input.systemPrompt,
  };
}

export function fingerprintKiroAgentProfile(profile: KiroAgentProfile): string {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}

export async function writeKiroAgentProfile(
  profilePath: string,
  profile: KiroAgentProfile,
): Promise<void> {
  await fs.mkdir(path.dirname(profilePath), { recursive: true });
  const tempPath = `${profilePath}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await fs.open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(profile, null, 2)}\n`, "utf8");
    await handle.close();
    await fs.rename(tempPath, profilePath);
    await fs.chmod(profilePath, 0o600);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
