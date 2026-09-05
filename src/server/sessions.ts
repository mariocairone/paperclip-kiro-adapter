import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** kiro writes the session a moment after the process prints its last line. */
const CLOCK_SKEW_MS = 5_000;
const LIST_SESSIONS_TIMEOUT_MS = 15_000;
const LIST_SESSIONS_MAX_BUFFER = 8 * 1024 * 1024;

export interface KiroSessionRef {
  sessionId: string;
  updatedAt: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * `kiro-cli chat --list-sessions -f json` emits
 * `[{ cwd, sessions: [{ sessionId, updatedAt, … }] }]`, one group per directory
 * kiro has seen. Pick the newest session belonging to this run's directory.
 *
 * `cwdCandidates` exists because kiro reports the *resolved* path — a run in
 * `/tmp/x` comes back as `/private/tmp/x` on macOS.
 */
export function pickLatestKiroSession(
  stdout: string,
  opts: { cwdCandidates: string[]; notBefore?: Date },
): KiroSessionRef | null {
  const start = stdout.indexOf("[");
  if (start < 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const wanted = new Set(
    opts.cwdCandidates
      .map((candidate) => candidate.replace(/\/+$/, ""))
      .filter((candidate) => candidate.length > 0),
  );
  const floor = opts.notBefore ? opts.notBefore.getTime() - CLOCK_SKEW_MS : null;

  let best: KiroSessionRef | null = null;
  let bestTime = Number.NEGATIVE_INFINITY;

  for (const groupRaw of parsed) {
    const group = asRecord(groupRaw);
    if (!group) continue;
    const groupCwd = asNonEmptyString(group.cwd)?.replace(/\/+$/, "");
    if (!groupCwd || !wanted.has(groupCwd)) continue;
    if (!Array.isArray(group.sessions)) continue;

    for (const sessionRaw of group.sessions) {
      const session = asRecord(sessionRaw);
      if (!session) continue;
      const sessionId = asNonEmptyString(session.sessionId) ?? asNonEmptyString(session.session_id);
      const updatedAt = asNonEmptyString(session.updatedAt) ?? asNonEmptyString(session.updated_at);
      if (!sessionId || !updatedAt) continue;
      const updatedTime = Date.parse(updatedAt);
      if (!Number.isFinite(updatedTime)) continue;
      // A session older than this run belongs to some earlier conversation;
      // adopting it would resume the wrong thread.
      if (floor !== null && updatedTime < floor) continue;
      if (updatedTime <= bestTime) continue;
      best = { sessionId, updatedAt };
      bestTime = updatedTime;
    }
  }

  return best;
}

/**
 * Ask kiro which session it just wrote for `cwd`. kiro-cli has no way to report
 * its session id on the run itself, so this is the only way to make
 * `--resume-id` work across heartbeats. Never throws: a run that produced work
 * must not fail because the follow-up lookup did.
 */
export async function readLatestKiroSession(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  notBefore: Date,
): Promise<KiroSessionRef | null> {
  const cwdCandidates = [cwd];
  try {
    const resolved = await fs.realpath(cwd);
    if (resolved !== cwd) cwdCandidates.push(resolved);
  } catch {
    // Directory vanished — the listing simply won't match.
  }

  try {
    const { stdout } = await execFileAsync(command, ["chat", "--list-sessions", "-f", "json"], {
      cwd,
      env,
      timeout: LIST_SESSIONS_TIMEOUT_MS,
      maxBuffer: LIST_SESSIONS_MAX_BUFFER,
    });
    return pickLatestKiroSession(stdout, { cwdCandidates, notBefore });
  } catch {
    return null;
  }
}
