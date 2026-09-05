import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AdapterModel } from "@paperclipai/adapter-utils";

const execFileAsync = promisify(execFile);
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const MODEL_DISCOVERY_MAX_BUFFER = 2 * 1024 * 1024;
const MODEL_CACHE_MS = 60_000;

/**
 * Fallback model ids for an unavailable/older kiro-cli. The live catalog is
 * discovered with `kiro-cli chat --list-models -f json` and exposed through
 * ServerAdapterModule.listModels/refreshModels.
 */
export const KIRO_MODEL_IDS = [
  "auto",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-opus-4.8",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "claude-opus-4.7",
  "claude-sonnet-4.6",
  "claude-opus-4.5",
  "claude-sonnet-4.5",
  "claude-sonnet-4",
  "claude-fable-5",
  "claude-haiku-4.5",
  "deepseek-3.2",
  "minimax-m2.5",
  "minimax-m2.1",
  "glm-5",
  "qwen3-coder-next",
  "agi-nova-beta-1m",
] as const;

const MODEL_LABELS: Record<string, string> = {
  auto: "Auto",
  "claude-opus-5": "Claude Opus 5",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-opus-4.8": "Claude Opus 4.8",
  "gpt-5.6-sol": "GPT 5.6 Sol",
  "gpt-5.6-terra": "GPT 5.6 Terra",
  "gpt-5.6-luna": "GPT 5.6 Luna",
  "claude-opus-4.7": "Claude Opus 4.7",
  "claude-sonnet-4.6": "Claude Sonnet 4.6",
  "claude-opus-4.5": "Claude Opus 4.5",
  "claude-sonnet-4.5": "Claude Sonnet 4.5",
  "claude-sonnet-4": "Claude Sonnet 4",
  "claude-fable-5": "Claude Fable 5",
  "claude-haiku-4.5": "Claude Haiku 4.5",
  "deepseek-3.2": "DeepSeek 3.2",
  "minimax-m2.5": "MiniMax M2.5",
  "minimax-m2.1": "MiniMax M2.1",
  "glm-5": "GLM 5",
  "qwen3-coder-next": "Qwen3 Coder Next",
  "agi-nova-beta-1m": "AGI Nova Beta 1M",
};

export const FALLBACK_KIRO_MODELS: AdapterModel[] = KIRO_MODEL_IDS.map((id) => ({
  id,
  label: MODEL_LABELS[id] ?? id,
}));

interface KiroModelListItem {
  model_id?: unknown;
  model_name?: unknown;
}

interface KiroModelListEnvelope {
  models?: unknown;
}

export function parseKiroModelCatalog(stdout: string): AdapterModel[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Kiro model catalog must be an object.");
  }
  const rows = (parsed as KiroModelListEnvelope).models;
  if (!Array.isArray(rows)) throw new Error("Kiro model catalog is missing models[].");

  const models: AdapterModel[] = [];
  const seen = new Set<string>();
  for (const raw of rows as KiroModelListItem[]) {
    if (!raw || typeof raw !== "object") continue;
    const id = typeof raw.model_id === "string" ? raw.model_id.trim() : "";
    if (!id || seen.has(id)) continue;
    const modelName = typeof raw.model_name === "string" ? raw.model_name.trim() : "";
    models.push({ id, label: MODEL_LABELS[id] ?? (modelName || id) });
    seen.add(id);
  }
  if (models.length === 0) throw new Error("Kiro model catalog returned no usable models.");
  return models;
}

let modelCache: { expiresAt: number; models: AdapterModel[] } | null = null;

export async function discoverKiroModels(options: { refresh?: boolean } = {}): Promise<AdapterModel[]> {
  if (!options.refresh && modelCache && modelCache.expiresAt > Date.now()) {
    return modelCache.models.map((model) => ({ ...model }));
  }

  try {
    const { stdout } = await execFileAsync("kiro-cli", ["chat", "--list-models", "-f", "json"], {
      timeout: MODEL_DISCOVERY_TIMEOUT_MS,
      maxBuffer: MODEL_DISCOVERY_MAX_BUFFER,
      env: process.env,
    });
    const models = parseKiroModelCatalog(stdout);
    modelCache = { expiresAt: Date.now() + MODEL_CACHE_MS, models };
    return models.map((model) => ({ ...model }));
  } catch {
    return FALLBACK_KIRO_MODELS.map((model) => ({ ...model }));
  }
}

export function refreshKiroModels(): Promise<AdapterModel[]> {
  modelCache = null;
  return discoverKiroModels({ refresh: true });
}

/** Agents often use provider-specific aliases. Translate the known safe ones. */
const MODEL_ALIASES: Record<string, string> = {
  "claude-sonnet-4-20250514": "claude-sonnet-4",
  "claude-3-5-sonnet-20241022": "claude-sonnet-4",
  "claude-3-opus-20240229": "claude-opus-4.5",
  "claude-sonnet-4-5": "claude-sonnet-4.5",
  "claude-opus-4-5": "claude-opus-4.5",
  "claude-haiku-4-5": "claude-haiku-4.5",
};

export const DEFAULT_KIRO_MODEL = "gpt-5.6-sol";

export interface ResolvedKiroModel {
  id: string;
  requested: string;
  aliased: boolean;
  known: boolean;
}

export const KIRO_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export function isKnownKiroEffort(effort: string): boolean {
  return (KIRO_EFFORT_LEVELS as readonly string[]).includes(effort);
}

export function resolveKiroModel(
  rawModel: unknown,
  knownModels: readonly string[] = KIRO_MODEL_IDS,
): ResolvedKiroModel {
  const requested = typeof rawModel === "string" ? rawModel.trim() : "";
  if (!requested) {
    return { id: DEFAULT_KIRO_MODEL, requested: "", aliased: false, known: true };
  }

  const alias = MODEL_ALIASES[requested];
  const id = alias ?? requested;
  return {
    id,
    requested,
    aliased: alias !== undefined,
    known: knownModels.includes(id),
  };
}
