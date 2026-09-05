/**
 * kiro-cli renders a human-facing terminal transcript — there is no
 * machine-readable stream format to parse (`--format json` only applies to
 * `--list-models` / `--list-sessions`). This module classifies the rendered
 * lines so the server can build a clean run summary and the UI can show
 * structured turns instead of raw escape codes.
 *
 * Everything here is pure and dependency-free: the server bundle and the
 * browser bundle both import it.
 *
 * A sample turn, after `stripKiroAnsi`:
 *
 *   > I'll create the file with "ping" and then read it back to you.
 *   I'll create the following file: /tmp/notes.txt (using tool: write)
 *   Purpose: Create notes.txt with the word "ping"
 *   +    1: ping
 *    - Completed in 0.11s
 *   > The file says "ping".
 */

/** Full CSI range, including cursor controls such as `ESC[?25l`. */
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function stripKiroAnsi(text: string): string {
  return text.replace(CSI_RE, "");
}

export type KiroLine =
  /** Start of an assistant turn (the `> ` marker). */
  | { kind: "assistant"; text: string }
  /** `… (using tool: shell)` — `detail` is the human description before the marker. */
  | { kind: "tool_call"; name: string; detail: string }
  /** `Purpose: …`, the model's stated reason for the preceding tool call. */
  | { kind: "tool_purpose"; text: string }
  /** ` - Completed in 0.11s` */
  | { kind: "tool_completed"; duration: string }
  /** Inline diff rows emitted by the write/edit tools. */
  | { kind: "diff"; changeType: "add" | "remove"; text: string }
  /** Footer metrics such as ` ▸ Time: 9s` or ` ▸ Credits: 0.4`. */
  | { kind: "metric"; label: string; value: string }
  /** Anything else: prose continuation lines and tool progress output. */
  | { kind: "text"; text: string };

const TOOL_CALL_RE = /^(.*?)\s*\(using tool:\s*([^)]+)\)\s*$/;
const PURPOSE_RE = /^Purpose:\s*(.*)$/;
const COMPLETED_RE = /^\s*-\s*Completed in\s+(.+?)\s*$/;
const METRIC_RE = /^\s*▸\s*([^:]+?)\s*:\s*(.*)$/;
const DIFF_RE = /^([+-])\s*\d+\s*:\s?(.*)$/;
const ASSISTANT_RE = /^>\s?(.*)$/;

/**
 * Classify one rendered line. Returns null for blank lines and for lines that
 * carried nothing but escape codes.
 */
export function classifyKiroLine(rawLine: string): KiroLine | null {
  const line = stripKiroAnsi(rawLine).replace(/\r$/, "");
  if (!line.trim()) return null;

  const assistant = ASSISTANT_RE.exec(line);
  if (assistant) return { kind: "assistant", text: assistant[1] ?? "" };

  const toolCall = TOOL_CALL_RE.exec(line);
  if (toolCall) {
    return {
      kind: "tool_call",
      name: (toolCall[2] ?? "").trim(),
      detail: (toolCall[1] ?? "").trim(),
    };
  }

  const purpose = PURPOSE_RE.exec(line);
  if (purpose) return { kind: "tool_purpose", text: (purpose[1] ?? "").trim() };

  const completed = COMPLETED_RE.exec(line);
  if (completed) return { kind: "tool_completed", duration: completed[1] ?? "" };

  const metric = METRIC_RE.exec(line);
  if (metric) {
    return { kind: "metric", label: (metric[1] ?? "").trim(), value: (metric[2] ?? "").trim() };
  }

  const diff = DIFF_RE.exec(line);
  if (diff) {
    return {
      kind: "diff",
      changeType: diff[1] === "+" ? "add" : "remove",
      text: diff[2] ?? "",
    };
  }

  return { kind: "text", text: line };
}

export function classifyKiroOutput(stdout: string): KiroLine[] {
  const out: KiroLine[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const entry = classifyKiroLine(rawLine);
    if (entry) out.push(entry);
  }
  return out;
}
