import { classifyKiroLine, classifyKiroOutput, stripKiroAnsi } from "../output.js";

export interface KiroToolCall {
  name: string;
  detail: string;
  purpose: string | null;
  duration: string | null;
}

export interface KiroParsedOutput {
  /**
   * The model's prose with the tool chrome (invocation lines, purposes, diff
   * rows, completion timings, footer metrics) removed. Tool *output* stays in —
   * kiro renders it indistinguishably from prose, and dropping it would lose
   * real content from the run summary.
   */
  summary: string;
  toolCalls: KiroToolCall[];
  /** Footer metrics keyed by label, e.g. `{ Time: "9s" }`. */
  metrics: Record<string, string>;
}

export function parseKiroOutput(stdout: string): KiroParsedOutput {
  const lines = classifyKiroOutput(stdout);
  const summaryParts: string[] = [];
  const toolCalls: KiroToolCall[] = [];
  const metrics: Record<string, string> = {};

  for (const line of lines) {
    switch (line.kind) {
      case "assistant":
      case "text": {
        const text = line.text.trim();
        if (text) summaryParts.push(text);
        break;
      }
      case "tool_call":
        toolCalls.push({ name: line.name, detail: line.detail, purpose: null, duration: null });
        break;
      case "tool_purpose": {
        const current = toolCalls[toolCalls.length - 1];
        if (current && current.purpose === null) current.purpose = line.text;
        break;
      }
      case "tool_completed": {
        const current = toolCalls[toolCalls.length - 1];
        if (current && current.duration === null) current.duration = line.duration;
        break;
      }
      case "metric":
        metrics[line.label] = line.value;
        break;
      case "diff":
        break;
    }
  }

  return { summary: summaryParts.join("\n").trim(), toolCalls, metrics };
}

/**
 * First meaningful stderr line, used to describe a non-zero exit. kiro prints
 * its trust banner and its timing footer on stderr as well, so a naive
 * "first non-empty line" reports the banner instead of the error.
 */
export function describeKiroFailure(stderr: string): string {
  const noise = [
    /^All tools are now trusted/,
    /^Agents can sometimes do unexpected things/,
    /^Learn more at /,
  ];
  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = stripKiroAnsi(rawLine).trim();
    if (!line) continue;
    if (noise.some((pattern) => pattern.test(line))) continue;
    if (classifyKiroLine(line)?.kind === "metric") continue;
    return line;
  }
  return "";
}
