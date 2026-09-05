import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  resolveCommandForLogs,
  renderTemplate,
  runChildProcess,
  readPaperclipRuntimeSkillEntries,
} from "@paperclipai/adapter-utils/server-utils";
import { KIRO_EFFORT_LEVELS, KIRO_MODEL_IDS, resolveKiroModel } from "../model.js";
import {
  assertExplicitKiroAcpAvailable,
  createKiroAcpExecutor,
  formatKiroAcpFallbackMessage,
  resolveKiroEffort,
  resolveKiroExecutionEngineForRun,
  resolveKiroTrustTools,
  validateKiroExtraArgs,
} from "./acp.js";
import { ensureLocalhostBypassesProxy, isLocalApiUrl, resolveLocalApiUrl } from "./api-url.js";
import { readKiroBaseAgent, resolveKiroHome, uniqueStrings } from "./base-agent.js";
import { DEFAULT_LOG_LINE_LIMIT, createSanitizedLogStream } from "./log-stream.js";
import type { RuntimeMcpServerLike } from "./mcp.js";
import { buildRuntimeMcpServers, readKiroMcpServerNames } from "./mcp.js";
import { describeKiroFailure, parseKiroOutput } from "./parse.js";
import { readLatestKiroSession } from "./sessions.js";
import { resolveKiroDesiredSkillNames } from "./skills.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const executeKiroAcp = createKiroAcpExecutor();

/** Profiles left behind by a killed run are swept once they are older than this. */
const STALE_AGENT_PROFILE_MS = 24 * 60 * 60 * 1000;

/**
 * kiro-cli discovers agent profiles by name from `$KIRO_HOME/agents` (or
 * `~/.kiro/agents` when KIRO_HOME is unset) and from `<cwd>/.kiro/agents`.
 * Use the same KIRO_HOME that the child process receives; otherwise the adapter
 * writes a valid profile into one home while kiro searches another and silently
 * falls back to the user's default agent.
 */
async function ensureKiroAgentProfileDir(cwd: string, runtimeEnv: NodeJS.ProcessEnv): Promise<string> {
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

/**
 * Remove profiles from earlier runs that never reached their cleanup (SIGKILL,
 * crash, host reboot). Only old files are touched so concurrent runs are safe.
 * The workspace directory is swept as well: earlier versions wrote profiles
 * there, and those leftovers sit inside the user's project.
 */
async function sweepStaleKiroAgentProfiles(dirs: string[], currentName: string): Promise<void> {
  const cutoff = Date.now() - STALE_AGENT_PROFILE_MS;
  await Promise.all(dirs.map(async (dir) => {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      // Missing or unreadable directory is not worth failing a run over.
      return;
    }
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith("paperclip-") && entry.endsWith(".json"))
        .filter((entry) => entry !== `${currentName}.json`)
        .map(async (entry) => {
          const target = path.join(dir, entry);
          try {
            const stat = await fs.stat(target);
            if (stat.mtimeMs < cutoff) await fs.rm(target, { force: true });
          } catch {
            // Raced with another run's cleanup — nothing to do.
          }
        }),
    );
  }));
}

/**
 * Assembles skill content as markdown blocks to be injected into the prompt.
 * Reads skill SKILL.md files and wraps them in <skill> tags.
 */
async function assembleSkillContent(config: Record<string, unknown>): Promise<string | null> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredNames = resolveKiroDesiredSkillNames(config, availableEntries);

  if (desiredNames.length === 0) {
    return null;
  }

  const blocks: string[] = [];
  for (const skillName of desiredNames) {
    const entry = availableEntries.find((e) => e.key === skillName);
    if (!entry) continue;

    const skillMdPath = path.join(entry.source, "SKILL.md");
    try {
      const content = await fs.readFile(skillMdPath, "utf-8");
      blocks.push(`<skill name="${entry.runtimeName}">\n${content.trim()}\n</skill>`);
    } catch {
      // Skip if SKILL.md doesn't exist or can't be read
      continue;
    }
  }

  if (blocks.length === 0) {
    return null;
  }

  return `<skills>\n${blocks.join("\n\n")}\n</skills>`;
}

/**
 * `runtimeMcp` is optional on the execution context and is provided by the
 * host, so treat both its absence and a throwing implementation as "no servers"
 * rather than failing a run over it.
 */
function readRuntimeMcpServers(ctx: AdapterExecutionContext): RuntimeMcpServerLike[] {
  try {
    const servers = ctx.runtimeMcp?.getServers?.();
    return Array.isArray(servers) ? servers : [];
  } catch {
    return [];
  }
}

async function fetchIssueContent(apiUrl: string, apiKey: string, issueId: string): Promise<string> {
  try {
    const res = await fetch(`${apiUrl}/api/issues/${issueId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return "";
    const data = await res.json() as Record<string, unknown>;
    const title = typeof data.title === "string" ? data.title : "";
    const description = typeof data.description === "string" ? data.description : "";
    const parts = [title, description].filter(Boolean);
    return parts.join("\n\n");
  } catch {
    return "";
  }
}

const DEFAULT_PROMPT_TEMPLATE = `You are agent {{agent.id}} ({{agent.name}}). You are waking up in a Paperclip heartbeat.

## CRITICAL: Follow the Paperclip Skill

You MUST follow the **Heartbeat Procedure** defined in the paperclip skill above. This is not optional reference documentation — it is your mandatory operating procedure.

## MANDATORY: Update Status Before Exiting

Before you exit this heartbeat, you MUST update the issue via the Paperclip API at \`{{apiUrl}}\` (the value of \`$PAPERCLIP_API_URL\`) — never at a public Paperclip URL, which is behind SSO and answers API calls with a login redirect.

**Every request needs \`Authorization: Bearer $PAPERCLIP_API_KEY\`.** Without that header the server cannot resolve the issue and answers \`{"error":"Issue not found"}\`. That response means the header is missing or wrong — it does not mean the route is wrong. There are no company-scoped issue routes: \`/api/companies/<id>/issues/<id>\` does not exist and returns \`API route not found\`. Use these calls exactly as written.

Work is complete, or blocked (then name the unblock owner and action in the comment):

\`\`\`bash
curl -sS -X PATCH "$PAPERCLIP_API_URL/api/issues/{{context.taskId}}" \\
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \\
  -d '{"status": "done", "comment": "what you did and how you verified it"}'
\`\`\`

Still in progress — post a comment instead of changing the status (the field is \`body\`):

\`\`\`bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/issues/{{context.taskId}}/comments" \\
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \\
  -d '{"body": "progress so far and what comes next"}'
\`\`\`

If a call fails, check the auth header and the response body before changing the URL. Do not guess at other route shapes, and do not fall back to writing a status file into the workspace — a report on disk is not a status update.

**Never exit a heartbeat without updating status or posting a comment.** The Paperclip system tracks your work through these API calls.

## Task Context

{{taskContent}}

## Environment

- Working directory: {{cwd}}
- Paperclip API base URL: {{apiUrl}}
- Task ID: {{context.taskId}}
- Wake reason: {{context.wakeReason}}`;

/**
 * Builds additional prompt content for comment-triggered wakes.
 * This is injected BEFORE the default prompt when PAPERCLIP_WAKE_COMMENT_ID is set.
 */
function buildCommentWakePrompt(taskId: string, wakeCommentId: string): string {
  return `## IMPORTANT: Comment-Triggered Wake

This heartbeat was triggered by a comment. The environment variable PAPERCLIP_WAKE_COMMENT_ID=${wakeCommentId} is set.

**You MUST fetch and read this comment FIRST before doing any other work:**

\`\`\`bash
curl -sS "$PAPERCLIP_API_URL/api/issues/${taskId}/comments/${wakeCommentId}" \\
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
\`\`\`

The comment may contain new instructions, questions, or context that changes what you should do. Do not just work on the task description — respond to the comment.

---

`;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const selection = await resolveKiroExecutionEngineForRun({ config: ctx.config });
  if (selection.fallbackReason) {
    await ctx.onLog("stderr", formatKiroAcpFallbackMessage(selection.fallbackReason));
  }
  if (selection.engine === "acp") {
    await assertExplicitKiroAcpAvailable(ctx.config);
    return executeKiroAcp(ctx);
  }
  return executeKiroCli(ctx);
}

/** Legacy `kiro-cli chat` lane retained for compatibility and explicit engine=cli. */
export async function executeKiroCli(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const command = asString(config.command, "kiro-cli");
  // Shared with testEnvironment so a run and its environment test can never
  // disagree about which model they use.
  const resolvedModel = resolveKiroModel(config.model);
  const configuredModel = resolvedModel.id;
  if (resolvedModel.aliased) {
    await onLog(
      "stderr",
      `[paperclip] Model "${resolvedModel.requested}" is not a Kiro model id; using "${configuredModel}".\n`,
    );
  } else if (!resolvedModel.known) {
    // kiro aborts on an unknown id with wording that never says where the id
    // came from. Agents that hire other agents write this field, so name it.
    await onLog(
      "stderr",
      `[paperclip] Model "${resolvedModel.requested}" is not offered by Kiro; the run will fail. ` +
        `Set the agent's model to one of: ${KIRO_MODEL_IDS.join(", ")}.\n`,
    );
  }
  const effortResolution = resolveKiroEffort(config);
  const effort = effortResolution.value ?? "";
  if (effortResolution.requested && !effortResolution.value) {
    await onLog(
      "stderr",
      `[paperclip] Effort "${effortResolution.requested}" from ${effortResolution.source} is not one of ${KIRO_EFFORT_LEVELS.join(", ")}; the flag is omitted.\n`,
    );
  }
  const extraArgs = asStringArray(config.extraArgs);
  validateKiroExtraArgs(extraArgs);
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const logLineLimit = asNumber(config.logLineLimit, DEFAULT_LOG_LINE_LIMIT);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const baseAgentName = asString(config.baseAgent, "").trim();

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const configuredCwd = asString(config.cwd, "");
  const preferConfiguredCwd = config.preferConfiguredCwd === true;
  const cwd = preferConfiguredCwd && configuredCwd
    ? configuredCwd
    : workspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    null;
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;

  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim()
      ? context.wakeReason.trim()
      : null;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;

  // Extract wake comment ID (from wakeCommentId or commentId in context)
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;

  // Extract approval context
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;

  // Extract linked issue IDs
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");

  if (workspaceCwd) env.PAPERCLIP_WORKSPACE_CWD = workspaceCwd;

  const envConfig = parseObject(config.env);
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  // kiro runs on the same host as the Paperclip server, so its API calls go
  // over loopback. A public base URL is answered by the reverse proxy's SSO
  // with a login redirect instead of JSON, which fails every call the agent
  // makes — so the local URL wins over both the host env and the agent config.
  const localApiUrl = resolveLocalApiUrl();
  const configuredApiUrl = (env.PAPERCLIP_API_URL ?? "").trim();
  if (configuredApiUrl && !isLocalApiUrl(configuredApiUrl)) {
    await onLog(
      "stderr",
      `[paperclip] PAPERCLIP_API_URL "${configuredApiUrl}" is not local; this run calls the Paperclip API at ${localApiUrl}.\n`,
    );
  }
  env.PAPERCLIP_API_URL = localApiUrl;
  ensureLocalhostBypassesProxy(env);

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, { runtimeEnv, resolvedCommand });

  const baseAgent = baseAgentName
    ? await readKiroBaseAgent(baseAgentName, cwd, runtimeEnv)
    : null;
  const model = configuredModel === "auto" && baseAgent?.model
    ? baseAgent.model
    : configuredModel;
  if (baseAgent) {
    await onLog(
      "stderr",
      `[paperclip] Inheriting Kiro base agent "${baseAgent.name}" from ${baseAgent.sourcePath}.\n`,
    );
  }

  // Read instructions file and prepend to prompt
  let instructionsContent = "";
  if (instructionsFilePath) {
    try {
      instructionsContent = (await fs.readFile(instructionsFilePath, "utf-8")).trim();
    } catch (err) {
      await onLog("stderr", `[paperclip] Warning: could not read instructions file "${instructionsFilePath}": ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  const promptTemplate = asString(config.promptTemplate, DEFAULT_PROMPT_TEMPLATE);

  // Fetch issue content server-side so kiro gets the task directly
  const taskId = asString(context.taskId, "") || asString(context.issueId, "");
  const apiUrl = env.PAPERCLIP_API_URL;
  const apiKey = authToken ?? "";
  // Note: In local_trusted mode, apiKey may be empty but the API still works
  const taskContent = taskId
    ? await fetchIssueContent(apiUrl, apiKey, taskId)
    : "";

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    cwd,
    apiUrl,
    taskContent: taskContent || "(no task content available)",
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context: {
      ...context,
      runId,
      wakeReason: asString(context.wakeReason, ""),
      wakeCommentId: wakeCommentId || "",
      taskId,
      issueId: asString(context.issueId, ""),
    },
  };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();

  // Assemble skill content from the skills directory
  const skillContent = await assembleSkillContent(config);

  // Build comment-wake prompt if triggered by a comment
  const commentWakePrompt = wakeCommentId && taskId
    ? buildCommentWakePrompt(taskId, wakeCommentId)
    : null;

  // Split prompt into system-level context (loaded via --agent profile) and
  // user-level task message (passed as [INPUT] argument). This prevents kiro-cli
  // from treating the Paperclip instrumentation as a prompt injection attempt.
  const systemPrompt = joinPromptSections([
    baseAgent?.prompt,
    skillContent,
    instructionsContent,
    sessionHandoffNote,
    commentWakePrompt,
  ]);
  const userMessage = renderedPrompt;
  const prompt = joinPromptSections([systemPrompt, userMessage]);

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;

  // Write a temporary agent profile so kiro-cli loads the Paperclip context as
  // a trusted system prompt rather than treating it as user input (which triggers
  // prompt-injection detection).
  const agentProfileDir = await ensureKiroAgentProfileDir(cwd, runtimeEnv);
  const agentProfileName = `paperclip-${runId.slice(0, 8)}`;
  const agentProfilePath = path.join(agentProfileDir, `${agentProfileName}.json`);
  await sweepStaleKiroAgentProfiles(
    [agentProfileDir, path.join(cwd, ".kiro", "agents")],
    agentProfileName,
  );
  // `tools` is an allowlist, not a trust list: an empty array leaves the agent
  // with no shell/read/write at all, and --trust-all-tools then has nothing to
  // trust. "*" covers the built-in tools; MCP servers need their own `@name`
  // entry on top of `includeMcpJson`, or their tools never reach the agent.
  const kiroServerNames = await readKiroMcpServerNames(cwd, runtimeEnv);
  const baseMcpServers = baseAgent?.mcpServers ?? {};
  const baseMcpServerNames = Object.keys(baseMcpServers);
  // Paperclip's own MCP connections never appear in kiro's mcp.json; they are
  // handed to the adapter per run and have to be written into the profile.
  // A base agent owns its named servers, so Paperclip connections cannot
  // silently replace them.
  const runtimeMcpServers = buildRuntimeMcpServers(
    readRuntimeMcpServers(ctx),
    [...kiroServerNames, ...baseMcpServerNames],
  );
  const inlineMcpServers = { ...baseMcpServers, ...runtimeMcpServers };
  const mcpServerNames = uniqueStrings([
    ...kiroServerNames,
    ...baseMcpServerNames,
    ...Object.keys(runtimeMcpServers),
  ]);
  const mcpTools = mcpServerNames.map((name) => `@${name}`);
  const baseTools = baseAgent?.tools ?? ["*"];
  const tools = uniqueStrings([...baseTools, ...mcpTools]);
  const allowedTools = uniqueStrings([
    ...(baseAgent?.allowedTools ?? baseTools),
    ...mcpTools,
  ]);
  if (mcpServerNames.length > 0) {
    await onLog(
      "stderr",
      `[paperclip] MCP servers available to this run: ${mcpServerNames.join(", ")}.\n`,
    );
  }
  const agentProfile = {
    name: agentProfileName,
    model,
    // An *empty* `mcpServers: {}` suppresses the `includeMcpJson` merge in
    // kiro-cli, so only write this key when a base agent or Paperclip adds a
    // concrete inline server.
    ...(Object.keys(inlineMcpServers).length > 0 ? { mcpServers: inlineMcpServers } : {}),
    tools,
    allowedTools,
    toolAliases: baseAgent?.toolAliases ?? {},
    resources: baseAgent?.resources ?? [],
    toolsSettings: baseAgent?.toolsSettings ?? {},
    includeMcpJson: baseAgent?.includeMcpJson ?? true,
    ...((typeof config.requireMcpStartup === "boolean" || baseAgent?.requireMcpStartup !== undefined)
      ? { requireMcpStartup: typeof config.requireMcpStartup === "boolean"
          ? config.requireMcpStartup
          : baseAgent?.requireMcpStartup }
      : {}),
    prompt: systemPrompt,
  };
  await fs.writeFile(agentProfilePath, JSON.stringify(agentProfile, null, 2), { mode: 0o600 });
  await fs.chmod(agentProfilePath, 0o600);

  const trustTools = resolveKiroTrustTools(config.trustTools);
  const args = ["chat", "--no-interactive"];
  if (trustTools === null) args.push("--trust-all-tools");
  else if (trustTools.length > 0) args.push("--trust-tools", trustTools.join(","));
  args.push("--agent", agentProfileName);
  if (effort) args.push("--effort", effort);
  if (sessionId) args.push("--resume-id", sessionId);
  if (extraArgs.length > 0) args.push(...extraArgs);
  // Pass the task-specific message as the [INPUT] positional argument
  args.push(userMessage);

  if (onMeta) {
    await onMeta({
      adapterType: "kiro_acp",
      command: resolvedCommand,
      cwd,
      commandArgs: args,
      commandNotes: [
        `Agent profile written to ${agentProfilePath}`,
        ...(baseAgent ? [`Base Kiro agent inherited from ${baseAgent.sourcePath}`] : []),
        ...(instructionsFilePath ? [`Instructions prepended from ${instructionsFilePath}`] : []),
      ],
      env: loggedEnv,
      prompt,
      promptMetrics: {
        promptChars: prompt.length,
        bootstrapPromptChars:
          (baseAgent?.prompt.length ?? 0) + instructionsContent.length + (skillContent?.length ?? 0),
        sessionHandoffChars: sessionHandoffNote.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
      context,
    });
  }

  const runStartedAt = new Date();
  // kiro writes a terminal transcript; the run log renders text. Sanitize the
  // stream so the log shows lines instead of escape codes and JSON dumps.
  const logStream = createSanitizedLogStream(onLog, logLineLimit);
  let proc;
  try {
    proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog: logStream.onLog,
    });
  } finally {
    await logStream.flush();
    // Clean up temporary agent profile
    await fs.rm(agentProfilePath, { force: true }).catch(() => {});
  }

  const parsed = parseKiroOutput(proc.stdout);

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      errorCode: "timeout",
    };
  }

  if ((proc.exitCode ?? 0) !== 0) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: describeKiroFailure(proc.stderr) || `kiro-cli exited with code ${proc.exitCode ?? -1}`,
      summary: parsed.summary || undefined,
    };
  }

  // kiro-cli never reports the session it wrote, so ask it afterwards. Without
  // this the `--resume-id` above can never fire and every heartbeat starts cold.
  const session = await readLatestKiroSession(command, cwd, runtimeEnv, runStartedAt);

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage: null,
    summary: parsed.summary,
    model: model || null,
    ...(session
      ? {
          sessionId: session.sessionId,
          sessionParams: { sessionId: session.sessionId, cwd },
          sessionDisplayId: session.sessionId,
        }
      : {}),
  };
}
