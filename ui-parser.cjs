"use strict";

/**
 * Paperclip UI transcript parser for kiro-cli.
 *
 * Contract: this file is fetched by the Paperclip UI and evaluated in a browser
 * sandbox. It must have ZERO runtime imports and no side effects, which is why
 * the line classifier is duplicated here instead of imported from src/output.ts.
 * Keep the two in sync when kiro's rendering changes.
 *
 * kiro-cli renders a human-facing terminal transcript — there is no
 * machine-readable stream mode (`--format json` covers only `--list-models` and
 * `--list-sessions`). A real run looks like this once escape codes are stripped:
 *
 *   > I'll create the file with "ping" and then read it back to you.
 *   I'll create the following file: /tmp/notes.txt (using tool: write)
 *   Purpose: Create notes.txt with the word "ping"
 *   +    1: ping
 *    - Completed in 0.11s
 *   > The file says "ping".
 */

/** Full CSI range, including cursor controls such as ESC[?25l, plus OSC sequences. */
function stripAnsi(text) {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

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
function classifyLine(rawLine) {
  const line = stripAnsi(rawLine).replace(/\r$/, "");
  if (!line.trim()) return null;

  const assistant = ASSISTANT_RE.exec(line);
  if (assistant) return { kind: "assistant", text: assistant[1] || "" };

  const toolCall = TOOL_CALL_RE.exec(line);
  if (toolCall) {
    return {
      kind: "tool_call",
      name: (toolCall[2] || "").trim(),
      detail: (toolCall[1] || "").trim(),
    };
  }

  const purpose = PURPOSE_RE.exec(line);
  if (purpose) return { kind: "tool_purpose", text: (purpose[1] || "").trim() };

  const completed = COMPLETED_RE.exec(line);
  if (completed) return { kind: "tool_completed", duration: completed[1] || "" };

  const metric = METRIC_RE.exec(line);
  if (metric) {
    return { kind: "metric", label: (metric[1] || "").trim(), value: (metric[2] || "").trim() };
  }

  const diff = DIFF_RE.exec(line);
  if (diff) {
    return { kind: "diff", changeType: diff[1] === "+" ? "add" : "remove", text: diff[2] || "" };
  }

  return { kind: "text", text: line };
}

/**
 * Stateful parser. State is what a line-at-a-time parser cannot do: kiro marks
 * only the FIRST line of an assistant turn with `> `, so continuation lines are
 * indistinguishable from tool output without remembering whether a turn is
 * open. It also lets tool results be paired with the call they belong to.
 */
function createStdoutParser() {
  let inAssistantTurn = false;
  let openToolUseId = null;
  let toolCounter = 0;

  function parseLine(line, ts) {
    const classified = classifyLine(line);
    if (!classified) return [];

    switch (classified.kind) {
      case "assistant":
        inAssistantTurn = true;
        return classified.text ? [{ kind: "assistant", ts, text: classified.text }] : [];

      case "tool_call": {
        inAssistantTurn = false;
        openToolUseId = "kiro-tool-" + ++toolCounter;
        return [{
          kind: "tool_call",
          ts,
          name: classified.name,
          toolUseId: openToolUseId,
          input: classified.detail ? { detail: classified.detail } : {},
        }];
      }

      case "tool_purpose":
        return [{ kind: "system", ts, text: "Purpose: " + classified.text }];

      case "tool_completed": {
        const entry = {
          kind: "tool_result",
          ts,
          toolUseId: openToolUseId || "",
          content: "Completed in " + classified.duration,
          isError: false,
        };
        openToolUseId = null;
        return [entry];
      }

      case "diff":
        inAssistantTurn = false;
        return [{ kind: "diff", ts, changeType: classified.changeType, text: classified.text }];

      case "metric":
        inAssistantTurn = false;
        return [{ kind: "system", ts, text: classified.label + ": " + classified.value }];

      case "text":
        // Inside an open turn this is the model still talking; otherwise it is
        // output produced by whatever tool ran last.
        if (inAssistantTurn) {
          return [{ kind: "assistant", ts, text: classified.text }];
        }
        return [{ kind: "stdout", ts, text: classified.text }];

      default:
        return [{ kind: "stdout", ts, text: classified.text || "" }];
    }
  }

  function reset() {
    inAssistantTurn = false;
    openToolUseId = null;
    toolCounter = 0;
  }

  return { parseLine, reset };
}

/**
 * Stateless fallback for hosts that do not use `createStdoutParser`. Cannot
 * attribute continuation lines, so they surface as plain stdout.
 */
function parseStdoutLine(line, ts) {
  const classified = classifyLine(line);
  if (!classified) return [];

  switch (classified.kind) {
    case "assistant":
      return classified.text ? [{ kind: "assistant", ts, text: classified.text }] : [];
    case "tool_call":
      return [{
        kind: "tool_call",
        ts,
        name: classified.name,
        input: classified.detail ? { detail: classified.detail } : {},
      }];
    case "tool_purpose":
      return [{ kind: "system", ts, text: "Purpose: " + classified.text }];
    case "tool_completed":
      return [{
        kind: "tool_result",
        ts,
        toolUseId: "",
        content: "Completed in " + classified.duration,
        isError: false,
      }];
    case "diff":
      return [{ kind: "diff", ts, changeType: classified.changeType, text: classified.text }];
    case "metric":
      return [{ kind: "system", ts, text: classified.label + ": " + classified.value }];
    default:
      return [{ kind: "stdout", ts, text: classified.text || "" }];
  }
}

module.exports = { createStdoutParser, parseStdoutLine };
