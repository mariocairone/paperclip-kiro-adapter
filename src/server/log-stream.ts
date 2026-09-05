import { stripKiroAnsi } from "../output.js";

/**
 * kiro-cli writes a terminal transcript: 256-colour SGR codes around every tool
 * invocation, carriage-return redraws for its spinner, and whatever a tool
 * printed — for a `curl` against the Paperclip API that is one multi-kilobyte
 * JSON line. Forwarding those chunks to `onLog` verbatim puts the raw escape
 * codes into the run log, because the run log is rendered as text, not by a
 * terminal emulator.
 *
 * So sanitize on the way out: assemble whole lines, drop the escape codes,
 * resolve carriage-return redraws to their final frame, and cap the length of a
 * single line. Only the human-facing log is affected — `proc.stdout`, and with
 * it the run summary and session detection, still sees the original bytes.
 */

/** Longest line kept intact. Beyond this a line is a data dump, not a message. */
export const DEFAULT_LOG_LINE_LIMIT = 2000;

/**
 * Hard cap on unterminated output held in memory. A tool that streams megabytes
 * without a newline must not grow the buffer until the run dies.
 */
const MAX_BUFFERED_CHARS = 64 * 1024;

export type LogFn = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;

export interface SanitizedLogStream {
  /** Drop-in replacement for the host's `onLog`. */
  onLog: LogFn;
  /** Emits whatever the process left without a trailing newline. */
  flush: () => Promise<void>;
}

function truncateLine(line: string, limit: number): string {
  if (limit <= 0 || line.length <= limit) return line;
  const dropped = line.length - limit;
  return `${line.slice(0, limit)}… [truncated, ${dropped} more chars]`;
}

/**
 * A terminal shows only what follows the last carriage return, so progress
 * redraws collapse to their final frame instead of stacking up.
 */
function lastFrame(line: string): string {
  const cr = line.lastIndexOf("\r");
  return cr === -1 ? line : line.slice(cr + 1);
}

export function createSanitizedLogStream(
  onLog: LogFn,
  lineLimit: number = DEFAULT_LOG_LINE_LIMIT,
): SanitizedLogStream {
  const buffers: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
  /** Set once a line was force-flushed at MAX_BUFFERED_CHARS; its tail is dropped. */
  const overflowing: Record<"stdout" | "stderr", boolean> = { stdout: false, stderr: false };

  function render(rawLine: string): string {
    // Strip only on complete lines: an escape sequence can straddle two chunks.
    return truncateLine(stripKiroAnsi(lastFrame(rawLine)), lineLimit);
  }

  async function emit(stream: "stdout" | "stderr", rawLine: string): Promise<void> {
    const line = render(rawLine);
    if (!line) return;
    await onLog(stream, `${line}\n`);
  }

  async function onSanitizedLog(stream: "stdout" | "stderr", chunk: string): Promise<void> {
    if (!chunk) return;
    buffers[stream] += chunk;

    let newline = buffers[stream].indexOf("\n");
    while (newline !== -1) {
      const rawLine = buffers[stream].slice(0, newline).replace(/\r$/, "");
      buffers[stream] = buffers[stream].slice(newline + 1);
      if (overflowing[stream]) {
        // The head of this line already went out; the rest is dump tail.
        overflowing[stream] = false;
      } else {
        await emit(stream, rawLine);
      }
      newline = buffers[stream].indexOf("\n");
    }

    if (buffers[stream].length > MAX_BUFFERED_CHARS) {
      await emit(stream, buffers[stream]);
      buffers[stream] = "";
      overflowing[stream] = true;
    }
  }

  async function flush(): Promise<void> {
    for (const stream of ["stdout", "stderr"] as const) {
      const rest = buffers[stream];
      buffers[stream] = "";
      const wasOverflowing = overflowing[stream];
      overflowing[stream] = false;
      if (rest && !wasOverflowing) await emit(stream, rest);
    }
  }

  return { onLog: onSanitizedLog, flush };
}
