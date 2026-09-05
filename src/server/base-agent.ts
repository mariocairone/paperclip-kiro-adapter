import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const BASE_AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface KiroBaseAgent {
  name: string;
  sourcePath: string;
  prompt: string;
  model?: string;
  tools?: string[];
  allowedTools?: string[];
  mcpServers?: Record<string, unknown>;
  resources?: string[];
  toolAliases?: Record<string, unknown>;
  toolsSettings?: Record<string, unknown>;
  includeMcpJson?: boolean;
  requireMcpStartup?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return strings.length > 0 ? strings : undefined;
}

function parseMarkdownAgent(raw: string, sourcePath: string): Record<string, unknown> & { prompt?: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) {
    throw new Error(`Base agent ${sourcePath} must start with YAML frontmatter delimited by --- lines.`);
  }

  const metadata = asRecord(parseYaml(match[1] ?? ""));
  if (!metadata) throw new Error(`Base agent ${sourcePath} has invalid YAML frontmatter.`);

  const body = (match[2] ?? "").trim();
  const frontmatterPrompt = asString(metadata.prompt);
  return {
    ...metadata,
    ...(body || frontmatterPrompt ? { prompt: [frontmatterPrompt, body].filter(Boolean).join("\n\n") } : {}),
  };
}

function normalizeBaseAgent(name: string, sourcePath: string, input: Record<string, unknown>): KiroBaseAgent {
  const mcpServers = asRecord(input.mcpServers) ?? undefined;
  const toolAliases = asRecord(input.toolAliases) ?? undefined;
  const toolsSettings = asRecord(input.toolsSettings) ?? undefined;

  return {
    name,
    sourcePath,
    prompt: asString(input.prompt) ?? "",
    ...(asString(input.model) ? { model: asString(input.model) } : {}),
    ...(asStringArray(input.tools) ? { tools: asStringArray(input.tools) } : {}),
    ...(asStringArray(input.allowedTools) ? { allowedTools: asStringArray(input.allowedTools) } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(asStringArray(input.resources) ? { resources: asStringArray(input.resources) } : {}),
    ...(toolAliases ? { toolAliases } : {}),
    ...(toolsSettings ? { toolsSettings } : {}),
    ...(typeof input.includeMcpJson === "boolean" ? { includeMcpJson: input.includeMcpJson } : {}),
    ...(typeof input.requireMcpStartup === "boolean"
      ? { requireMcpStartup: input.requireMcpStartup }
      : {}),
  };
}

export function resolveKiroHome(runtimeEnv: NodeJS.ProcessEnv): string {
  const configured = runtimeEnv.KIRO_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".kiro");
}

export function baseAgentCandidatePaths(name: string, cwd: string, runtimeEnv: NodeJS.ProcessEnv): string[] {
  if (!BASE_AGENT_NAME.test(name)) {
    throw new Error(`Invalid baseAgent "${name}". Use only letters, numbers, dot, underscore, and dash.`);
  }

  const roots = [path.join(cwd, ".kiro", "agents"), path.join(resolveKiroHome(runtimeEnv), "agents")];
  return roots.flatMap((root) => [path.join(root, `${name}.md`), path.join(root, `${name}.json`)]);
}

export async function readKiroBaseAgent(
  name: string,
  cwd: string,
  runtimeEnv: NodeJS.ProcessEnv,
): Promise<KiroBaseAgent> {
  const candidates = baseAgentCandidatePaths(name, cwd, runtimeEnv);
  let sourcePath: string | null = null;
  let raw = "";

  for (const candidate of candidates) {
    try {
      raw = await fs.readFile(candidate, "utf8");
      sourcePath = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  if (!sourcePath) {
    throw new Error(`Base agent "${name}" was not found. Checked: ${candidates.join(", ")}`);
  }

  let parsed: Record<string, unknown>;
  if (sourcePath.endsWith(".md")) {
    parsed = parseMarkdownAgent(raw, sourcePath);
  } else {
    const value: unknown = JSON.parse(raw);
    const record = asRecord(value);
    if (!record) throw new Error(`Base agent ${sourcePath} must contain a JSON object.`);
    parsed = record;
  }

  return normalizeBaseAgent(name, sourcePath, parsed);
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}
