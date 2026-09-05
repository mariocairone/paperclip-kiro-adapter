import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  DEFAULT_ACP_ENGINE_MODE,
  DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS,
  DEFAULT_ACP_ENGINE_PERMISSION_MODE,
  DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
} from "@paperclipai/adapter-utils/acpx-engine/constants";
import type { AcpxEngineExecutorOptions } from "@paperclipai/adapter-utils/acpx-engine/execute";
import { asString, asStringArray, joinPromptSections, parseObject } from "@paperclipai/adapter-utils/server-utils";

import { KIRO_EFFORT_LEVELS, KIRO_MODEL_IDS, isKnownKiroEffort, resolveKiroModel } from "../model.js";
import {
  buildKiroAgentProfile,
  buildKiroAgentProfileName,
  ensureKiroAgentProfileDir,
  fingerprintKiroAgentProfile,
  sweepStaleKiroAgentProfiles,
  writeKiroAgentProfile,
} from "./agent-profile.js";
import { ensureLocalhostBypassesProxy, isLocalApiUrl, resolveLocalApiUrl } from "./api-url.js";
import { readKiroBaseAgent } from "./base-agent.js";
import type { RuntimeMcpServerLike } from "./mcp.js";
import { buildRuntimeMcpServers, readKiroMcpServerNames } from "./mcp.js";
import { assembleKiroSkillContent } from "./skills.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRootDir = path.resolve(moduleDir, "../..");
const execFileAsync = promisify(execFile);
const ACP_PROBE_TIMEOUT_MS = 15_000;

export const KIRO_ACPX_AGENT = "kiro";
export const ACP_SUPPORT_CACHE_TTL_MS = 5 * 60 * 1000;

export type KiroConfiguredEngine = "auto" | "acp" | "cli";
export type KiroExecutionEngine = "acp" | "cli";

export interface KiroEngineSelection {
  engine: KiroExecutionEngine;
  configured: KiroConfiguredEngine;
  explicit: boolean;
  fallbackReason?: string;
}

export type KiroAcpSupport =
  | { supported: true; detail?: string }
  | { supported: false; reason: "missing_command" | "no_acp_subcommand"; detail: string };

const acpSupportCache = new Map<string, { at: number; value: KiroAcpSupport }>();
const RESERVED_EXTRA_ARGS = new Set([
  "--agent",
  "--model",
  "--effort",
  "--resume-id",
  "--output-format",
  "--no-interactive",
]);

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function resolveKiroExecutionEngine(config: Record<string, unknown>): KiroEngineSelection {
  const raw = firstNonEmptyString(config.engine)?.toLowerCase() ?? "auto";
  if (raw === "auto") return { engine: "acp", configured: "auto", explicit: false };
  if (raw === "acp") return { engine: "acp", configured: "acp", explicit: true };
  if (raw === "cli") return { engine: "cli", configured: "cli", explicit: true };
  throw new Error(`Invalid Kiro engine "${raw}". Expected auto, acp, or cli.`);
}

export function clearKiroAcpSupportCache(): void {
  acpSupportCache.clear();
}

function readProcessError(error: unknown): { code?: string; killed: boolean; stderr: string } {
  const record = (error ?? {}) as { code?: unknown; killed?: unknown; stderr?: unknown };
  return {
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    killed: record.killed === true,
    stderr: typeof record.stderr === "string" ? record.stderr : "",
  };
}

export async function probeKiroAcpSupport(
  command: string,
  options: {
    pathValue?: string;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    useCache?: boolean;
  } = {},
): Promise<KiroAcpSupport> {
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const now = options.now ?? Date.now;
  const useCache = options.useCache ?? true;
  const cacheKey = JSON.stringify([command, pathValue]);
  const cached = acpSupportCache.get(cacheKey);
  if (useCache && cached && now() - cached.at < ACP_SUPPORT_CACHE_TTL_MS) return cached.value;

  let value: KiroAcpSupport;
  try {
    await execFileAsync(command, ["acp", "--help"], {
      env: { ...(options.env ?? process.env), PATH: pathValue },
      timeout: ACP_PROBE_TIMEOUT_MS,
    });
    value = { supported: true };
  } catch (error) {
    const { code, killed, stderr } = readProcessError(error);
    if (code === "ENOENT") {
      value = { supported: false, reason: "missing_command", detail: `${command} was not found.` };
    } else if (/unrecognized subcommand|unknown subcommand|unexpected argument/i.test(stderr)) {
      value = {
        supported: false,
        reason: "no_acp_subcommand",
        detail: stderr.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "",
      };
    } else {
      value = {
        supported: true,
        ...(killed
          ? { detail: `${command} acp --help timed out; assuming ACP support.` }
          : { detail: `${command} acp --help failed for an unrelated reason; assuming ACP support.` }),
      };
    }
  }

  if (useCache) acpSupportCache.set(cacheKey, { at: now(), value });
  return value;
}

function configPath(config: Record<string, unknown>): string {
  const env = parseObject(config.env);
  return typeof env.PATH === "string" && env.PATH.trim() ? env.PATH : process.env.PATH ?? "";
}

export async function resolveKiroExecutionEngineForRun(input: {
  config: Record<string, unknown>;
}): Promise<KiroEngineSelection> {
  const selection = resolveKiroExecutionEngine(input.config);
  if (selection.configured !== "auto") return selection;
  const command = firstNonEmptyString(input.config.command) ?? "kiro-cli";
  const support = await probeKiroAcpSupport(command, { pathValue: configPath(input.config) });
  if (!support.supported && support.reason === "no_acp_subcommand") {
    return {
      engine: "cli",
      configured: "auto",
      explicit: false,
      fallbackReason: `${command} has no "acp" subcommand.`,
    };
  }
  return selection;
}

export async function assertExplicitKiroAcpAvailable(config: Record<string, unknown>): Promise<void> {
  const selection = resolveKiroExecutionEngine(config);
  if (selection.configured !== "acp") return;
  const command = firstNonEmptyString(config.command) ?? "kiro-cli";
  const support = await probeKiroAcpSupport(command, { pathValue: configPath(config) });
  if (!support.supported && support.reason === "no_acp_subcommand") {
    throw new Error(`Kiro ACP was explicitly required, but ${command} has no "acp" subcommand.`);
  }
}

export function formatKiroAcpFallbackMessage(reason: string): string {
  return `[paperclip] Kiro ACP unavailable; auto mode is falling back to the CLI wrapper. ${reason} Set engine=acp to fail closed or engine=cli to select the wrapper.\n`;
}

export function shellQuote(token: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(token) ? token : `'${token.replace(/'/g, `'\\''`)}'`;
}

export function validateKiroExtraArgs(args: readonly string[]): void {
  for (const arg of args) {
    const flag = arg.split("=", 1)[0] ?? arg;
    if (RESERVED_EXTRA_ARGS.has(flag)) {
      throw new Error(`extraArgs cannot override adapter-owned flag ${flag}.`);
    }
  }
}

export function resolveKiroTrustTools(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  if (!Array.isArray(value) && typeof value !== "string") {
    throw new Error("trustTools must be a comma-separated string or string array.");
  }
  const names = values.map((entry) => {
    if (typeof entry !== "string") throw new Error("trustTools entries must be strings.");
    return entry.trim();
  }).filter(Boolean);
  return [...new Set(names)];
}

export function resolveKiroEffort(config: Record<string, unknown>): {
  requested: string | null;
  value: string | null;
  source: string | null;
} {
  const ordered: Array<[string, unknown]> = [
    ["effort", config.effort],
    ["thinkingEffort", config.thinkingEffort],
    ["reasoningEffort", config.reasoningEffort],
    ["modelReasoningEffort", config.modelReasoningEffort],
    // Read-only migration compatibility for configurations saved by pre-0.1 builds.
    ["kiroEffort", config.kiroEffort],
  ];
  for (const [source, raw] of ordered) {
    const requested = firstNonEmptyString(raw);
    if (!requested) continue;
    return { requested, value: isKnownKiroEffort(requested) ? requested : null, source };
  }
  return { requested: null, value: null, source: null };
}

export interface KiroAcpCommandInput {
  command: string;
  agentProfileName?: string | null;
  model?: string | null;
  effort?: string | null;
  trustTools?: readonly string[] | null;
  extraArgs?: readonly string[];
}

export function buildKiroAcpCommand(input: KiroAcpCommandInput): string {
  validateKiroExtraArgs(input.extraArgs ?? []);
  const parts = [shellQuote(input.command), "acp"];
  if (input.trustTools === null || input.trustTools === undefined) {
    parts.push("--trust-all-tools");
  } else if (input.trustTools.length > 0) {
    parts.push("--trust-tools", shellQuote(input.trustTools.join(",")));
  }
  if (input.agentProfileName) parts.push("--agent", shellQuote(input.agentProfileName));
  if (input.model) parts.push("--model", shellQuote(input.model));
  if (input.effort) parts.push("--effort", shellQuote(input.effort));
  for (const arg of input.extraArgs ?? []) parts.push(shellQuote(arg));
  return parts.join(" ");
}

export function withLoopbackProxyBypass(configEnv: Record<string, unknown>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(configEnv)) if (typeof value === "string") next[key] = value;
  ensureLocalhostBypassesProxy(next);
  return next;
}

export function forceLocalPaperclipApiUrlForEngine(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = (env.PAPERCLIP_RUNTIME_API_URL ?? env.PAPERCLIP_API_URL ?? "").trim();
  if (configured && isLocalApiUrl(configured)) return null;
  env.PAPERCLIP_RUNTIME_API_URL = resolveLocalApiUrl(env);
  return configured || null;
}

export function buildKiroAcpConfig(input: {
  config: Record<string, unknown>;
  agentProfileName: string;
  profileFingerprint: string;
  model: string;
  effort: string | null;
}): Record<string, unknown> {
  const { config } = input;
  const command = firstNonEmptyString(config.command) ?? "kiro-cli";
  const extraArgs = asStringArray(config.extraArgs);
  validateKiroExtraArgs(extraArgs);
  const trustTools = resolveKiroTrustTools(config.trustTools);
  const stateDir = firstNonEmptyString(config.stateDir, config.acpStateDir);
  const mode = firstNonEmptyString(config.mode, config.acpMode) ?? DEFAULT_ACP_ENGINE_MODE;
  const permissionMode = firstNonEmptyString(config.permissionMode, config.acpPermissionMode) ?? DEFAULT_ACP_ENGINE_PERMISSION_MODE;
  const nonInteractivePermissions = firstNonEmptyString(
    config.nonInteractivePermissions,
    config.acpNonInteractivePermissions,
  ) ?? DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS;
  const warmHandleIdleMs = config.warmHandleIdleMs ?? config.acpWarmHandleIdleMs ?? DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS;
  const env = withLoopbackProxyBypass(parseObject(config.env));
  env.KIRO_PAPERCLIP_PROFILE_FINGERPRINT = input.profileFingerprint;

  const next: Record<string, unknown> = {
    ...config,
    agent: KIRO_ACPX_AGENT,
    agentCommand: buildKiroAcpCommand({
      command,
      agentProfileName: input.agentProfileName,
      model: input.model,
      effort: input.effort,
      trustTools,
      extraArgs,
    }),
    mode,
    permissionMode,
    nonInteractivePermissions,
    warmHandleIdleMs,
    env,
    ...(stateDir ? { stateDir } : {}),
  };

  for (const key of [
    "model",
    "kiroEffort",
    "effort",
    "thinkingEffort",
    "reasoningEffort",
    "modelReasoningEffort",
    "fastMode",
    "extraArgs",
    "instructionsFilePath",
  ]) delete next[key];
  return next;
}

function readRuntimeMcpServers(ctx: AdapterExecutionContext): RuntimeMcpServerLike[] {
  try {
    const servers = ctx.runtimeMcp?.getServers?.();
    return Array.isArray(servers) ? servers : [];
  } catch {
    return [];
  }
}

function resolveAcpCwd(ctx: AdapterExecutionContext, config: Record<string, unknown>): string {
  const workspaceCwd = asString(parseObject(ctx.context.paperclipWorkspace).cwd, "");
  const configuredCwd = asString(config.cwd, "");
  return config.preferConfiguredCwd === true && configuredCwd
    ? configuredCwd
    : workspaceCwd || configuredCwd || process.cwd();
}

function runtimeEnvironment(config: Record<string, unknown>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(parseObject(config.env))) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export interface PreparedKiroAcpProfile {
  profileName: string;
  profilePath: string;
  fingerprint: string;
  model: string;
  mcpServerNames: string[];
}

export async function prepareKiroAcpAgentProfile(
  ctx: AdapterExecutionContext,
  cwd: string,
): Promise<PreparedKiroAcpProfile> {
  const config = parseObject(ctx.config);
  const env = runtimeEnvironment(config);
  const profileName = buildKiroAgentProfileName(ctx.agent.id);
  const profileDir = await ensureKiroAgentProfileDir(cwd, env);
  const profilePath = path.join(profileDir, `${profileName}.json`);
  await sweepStaleKiroAgentProfiles([profileDir, path.join(cwd, ".kiro", "agents")], [profileName]);

  const baseAgentName = firstNonEmptyString(config.baseAgent);
  const baseAgent = baseAgentName ? await readKiroBaseAgent(baseAgentName, cwd, env) : null;
  const resolvedModel = resolveKiroModel(config.model);
  const model = resolvedModel.id === "auto" && baseAgent?.model ? baseAgent.model : resolvedModel.id;
  const effectiveIncludeMcpJson = baseAgent?.includeMcpJson ?? true;
  const kiroMcpServerNames = effectiveIncludeMcpJson
    ? await readKiroMcpServerNames(cwd, env)
    : [];
  const baseMcpServerNames = Object.keys(baseAgent?.mcpServers ?? {});
  const runtimeMcpServers = buildRuntimeMcpServers(
    readRuntimeMcpServers(ctx),
    [...kiroMcpServerNames, ...baseMcpServerNames],
  );
  const mcpServerNames = [...new Set([
    ...kiroMcpServerNames,
    ...baseMcpServerNames,
    ...Object.keys(runtimeMcpServers),
  ])];

  const requireMcpStartup = typeof config.requireMcpStartup === "boolean"
    ? config.requireMcpStartup
    : baseAgent?.requireMcpStartup;
  if (requireMcpStartup && mcpServerNames.length === 0) {
    throw new Error("requireMcpStartup is enabled, but no Kiro, base-agent, or runtime MCP server is configured.");
  }

  let instructions = "";
  const instructionsPath = firstNonEmptyString(config.instructionsFilePath);
  if (instructionsPath) {
    try {
      instructions = (await fs.readFile(instructionsPath, "utf8")).trim();
    } catch (error) {
      await ctx.onLog("stderr", `[paperclip] Warning: could not read instructions file "${instructionsPath}": ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  const skillContent = await assembleKiroSkillContent(config);
  const systemPrompt = joinPromptSections([baseAgent?.prompt, skillContent, instructions]);
  const profile = buildKiroAgentProfile({
    name: profileName,
    model,
    systemPrompt,
    baseAgent,
    kiroMcpServerNames,
    runtimeMcpServers,
    requireMcpStartup,
  });
  await writeKiroAgentProfile(profilePath, profile);

  return {
    profileName,
    profilePath,
    fingerprint: fingerprintKiroAgentProfile(profile),
    model,
    mcpServerNames,
  };
}

type KiroAcpExecutorOptions = Omit<AcpxEngineExecutorOptions, "adapterType" | "moduleDir" | "packageRootDir">;
type KiroAcpExecutor = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

function withKiroAcpDefaults(options: KiroAcpExecutorOptions): AcpxEngineExecutorOptions {
  return {
    resolveBillingIdentity: () => ({ provider: "kiro", biller: "kiro", billingType: "subscription" }),
    ...options,
    adapterType: "kiro_acp",
    moduleDir,
    packageRootDir,
  };
}

export function createKiroAcpExecutor(options: KiroAcpExecutorOptions = {}): KiroAcpExecutor {
  let executor: KiroAcpExecutor | null = null;
  return async (ctx) => {
    if (!executor) {
      const { createAcpxEngineExecutor } = await import("@paperclipai/adapter-utils/acpx-engine/execute");
      executor = createAcpxEngineExecutor(withKiroAcpDefaults(options));
    }

    const config = parseObject(ctx.config);
    validateKiroExtraArgs(asStringArray(config.extraArgs));
    const effort = resolveKiroEffort(config);
    if (effort.requested && !effort.value) {
      await ctx.onLog("stderr", `[paperclip] Effort "${effort.requested}" from ${effort.source} is invalid; expected ${KIRO_EFFORT_LEVELS.join(", ")}. The flag is omitted.\n`);
    }
    const resolvedModel = resolveKiroModel(config.model);
    if (resolvedModel.aliased) {
      await ctx.onLog("stderr", `[paperclip] Model "${resolvedModel.requested}" is not a Kiro model id; using "${resolvedModel.id}".\n`);
    } else if (!resolvedModel.known) {
      await ctx.onLog("stderr", `[paperclip] Model "${resolvedModel.requested}" is not offered by Kiro; expected one of: ${KIRO_MODEL_IDS.join(", ")}.\n`);
    }

    const cwd = resolveAcpCwd(ctx, config);
    const replacedApiUrl = forceLocalPaperclipApiUrlForEngine();
    if (replacedApiUrl) {
      await ctx.onLog("stderr", `[paperclip] PAPERCLIP_API_URL "${replacedApiUrl}" is not local; this run calls the Paperclip API at ${resolveLocalApiUrl()}.\n`);
    }
    const prepared = await prepareKiroAcpAgentProfile(ctx, cwd);
    if (prepared.mcpServerNames.length > 0) {
      await ctx.onLog("stderr", `[paperclip] MCP servers available to this run: ${prepared.mcpServerNames.join(", ")}.\n`);
    }

    const paperclipWorkspace = parseObject(ctx.context.paperclipWorkspace);
    const effectiveContext = config.preferConfiguredCwd === true
      ? { ...ctx.context, paperclipWorkspace: { ...paperclipWorkspace, cwd } }
      : ctx.context;
    const result = await executor({
      ...ctx,
      context: effectiveContext,
      runtimeMcp: undefined,
      config: buildKiroAcpConfig({
        config: { ...config, cwd },
        agentProfileName: prepared.profileName,
        profileFingerprint: prepared.fingerprint,
        model: prepared.model,
        effort: effort.value,
      }),
    });

    const usageJson = result.usage
      ? { ...result.usage, basis: result.usageBasis ?? null }
      : null;
    return {
      ...result,
      model: result.model ?? prepared.model,
      resultJson: { ...(result.resultJson ?? {}), usageJson },
    };
  };
}

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testKiroAcpEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = parseObject(ctx.config);
  const checks: AdapterEnvironmentCheck[] = [];
  const command = firstNonEmptyString(config.command) ?? "kiro-cli";
  const cwd = asString(config.cwd, process.cwd());

  try {
    await fs.mkdir(cwd, { recursive: true });
    checks.push({ code: "kiro_acp_cwd_valid", level: "info", message: `Working directory is valid: ${cwd}` });
  } catch (error) {
    checks.push({ code: "kiro_acp_cwd_invalid", level: "error", message: error instanceof Error ? error.message : "Invalid working directory", detail: cwd });
  }

  const runtimeEnv = runtimeEnvironment(config);
  let baseAgentModel: string | undefined;
  const baseAgentName = firstNonEmptyString(config.baseAgent);
  if (baseAgentName) {
    try {
      const baseAgent = await readKiroBaseAgent(baseAgentName, cwd, runtimeEnv);
      baseAgentModel = baseAgent.model;
      checks.push({
        code: "kiro_acp_base_agent_valid",
        level: "info",
        message: `Base Kiro agent "${baseAgentName}" is valid: ${baseAgent.sourcePath}`,
      });
    } catch (error) {
      checks.push({
        code: "kiro_acp_base_agent_invalid",
        level: "error",
        message: error instanceof Error ? error.message : `Base Kiro agent "${baseAgentName}" is invalid.`,
      });
    }
  }

  const requestedModel = resolveKiroModel(config.model);
  const effectiveModel = requestedModel.id === "auto" && baseAgentModel
    ? resolveKiroModel(baseAgentModel)
    : requestedModel;
  if (effectiveModel.aliased) {
    checks.push({
      code: "kiro_acp_model_aliased",
      level: "warn",
      message: `Model "${effectiveModel.requested}" is mapped to "${effectiveModel.id}".`,
    });
  } else if (!effectiveModel.known) {
    checks.push({
      code: "kiro_acp_model_invalid",
      level: "error",
      message: `Kiro does not offer a model called "${effectiveModel.requested}".`,
      hint: `Use one of: ${KIRO_MODEL_IDS.join(", ")}.`,
    });
  } else {
    checks.push({
      code: "kiro_acp_model_valid",
      level: "info",
      message: `Kiro model is valid: ${effectiveModel.id}`,
    });
  }

  const support = await probeKiroAcpSupport(command, { pathValue: configPath(config), useCache: false });
  if (support.supported) {
    checks.push({ code: "kiro_acp_subcommand_available", level: "info", message: `${command} provides the acp subcommand.` });
  } else {
    checks.push({
      code: support.reason === "missing_command" ? "kiro_acp_command_missing" : "kiro_acp_subcommand_missing",
      level: resolveKiroExecutionEngine(config).configured === "auto" && support.reason === "no_acp_subcommand" ? "warn" : "error",
      message: support.detail,
    });
  }

  try {
    validateKiroExtraArgs(asStringArray(config.extraArgs));
  } catch (error) {
    checks.push({ code: "kiro_reserved_extra_arg", level: "error", message: error instanceof Error ? error.message : String(error) });
  }
  const effort = resolveKiroEffort(config);
  if (effort.requested && !effort.value) {
    checks.push({ code: "kiro_acp_effort_invalid", level: "error", message: `Effort "${effort.requested}" is invalid.`, hint: `Use one of: ${KIRO_EFFORT_LEVELS.join(", ")}.` });
  }
  checks.push({
    code: "kiro_acp_usage_unavailable",
    level: "info",
    message: "Kiro 2.21 emits private credit metadata, but acpx 0.12 does not expose it; usageJson remains null unless standard typed usage is surfaced.",
  });

  return { adapterType: ctx.adapterType, status: summarizeStatus(checks), checks, testedAt: new Date().toISOString() };
}
