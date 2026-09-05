import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * The shipped parser is a hand-written CJS file with zero imports (the UI
 * evaluates it in a browser sandbox), so it is loaded here the same way the
 * host does rather than imported as TypeScript.
 */
const require = createRequire(import.meta.url);
const { createStdoutParser, parseStdoutLine } = require("../ui-parser.cjs") as {
  createStdoutParser: () => {
    parseLine: (line: string, ts: string) => Array<Record<string, unknown>>;
    reset: () => void;
  };
  parseStdoutLine: (line: string, ts: string) => Array<Record<string, unknown>>;
};

const TS = "2026-08-06T14:39:22.469Z";

/** Captured verbatim from a real `kiro-cli chat --no-interactive` run. */
const REAL_RUN = [
  "\x1b[38;5;141m> \x1b[0mI'll create the file with \"ping\" and then read it back to you.\x1b[0m\x1b[0m",
  "I'll create the following file: \x1b[38;5;141m/private/tmp/kparse/notes.txt\x1b[0m\x1b[38;5;244m (using tool: write)\x1b[0m",
  'Purpose: Create notes.txt with the word "ping"',
  "",
  "\x1b[49m\x1b[38;5;10m+    1\x1b[0m:\x1b[38;5;10m\x1b[49m ping",
  "\x1b[0m\x1b[K",
  "\x1b[38;5;244m - Completed in 0.11s\x1b[0m",
  '\x1b[38;5;141m> \x1b[0mThe file says "ping".',
];

describe("createStdoutParser", () => {
  it("walks a real run into structured entries", () => {
    const parser = createStdoutParser();
    const entries = REAL_RUN.flatMap((line) => parser.parseLine(line, TS));

    expect(entries.map((entry) => entry.kind)).toEqual([
      "assistant",
      "tool_call",
      "system",
      "diff",
      "tool_result",
      "assistant",
    ]);
  });

  it("pairs a tool result with the call it belongs to", () => {
    const parser = createStdoutParser();
    const entries = REAL_RUN.flatMap((line) => parser.parseLine(line, TS));
    const call = entries.find((entry) => entry.kind === "tool_call");
    const result = entries.find((entry) => entry.kind === "tool_result");

    expect(call?.name).toBe("write");
    expect(call?.toolUseId).toBeTruthy();
    expect(result?.toolUseId).toBe(call?.toolUseId);
  });

  it("attributes a continuation line to the open assistant turn", () => {
    const parser = createStdoutParser();
    parser.parseLine("\x1b[38;5;141m> \x1b[0mThe exact output is:", TS);
    // kiro marks only the first line of a turn, so this one carries no marker.
    expect(parser.parseLine("TOOLS_OK", TS)).toEqual([
      { kind: "assistant", ts: TS, text: "TOOLS_OK" },
    ]);
  });

  it("treats output after a tool call as tool output, not prose", () => {
    const parser = createStdoutParser();
    parser.parseLine("\x1b[38;5;141m> \x1b[0mRunning it now.", TS);
    parser.parseLine("I will run the following command: echo hi (using tool: shell)", TS);

    expect(parser.parseLine("hi", TS)).toEqual([{ kind: "stdout", ts: TS, text: "hi" }]);
  });

  it("drops lines that carried nothing but escape codes", () => {
    const parser = createStdoutParser();
    expect(parser.parseLine("\x1b[0m\x1b[K", TS)).toEqual([]);
    expect(parser.parseLine("\x1b[38;5;252m\x1b[0m\x1b[?25l\x1b[?25l\x1b[0m", TS)).toEqual([]);
    expect(parser.parseLine("", TS)).toEqual([]);
  });

  it("keeps the footer metric out of the prose", () => {
    const parser = createStdoutParser();
    expect(parser.parseLine(" \x1b[38;5;8m▸ Time: 9s", TS)).toEqual([
      { kind: "system", ts: TS, text: "Time: 9s" },
    ]);
  });

  it("forgets the open turn on reset", () => {
    const parser = createStdoutParser();
    parser.parseLine("\x1b[38;5;141m> \x1b[0mstill talking", TS);
    parser.reset();
    expect(parser.parseLine("orphan line", TS)).toEqual([
      { kind: "stdout", ts: TS, text: "orphan line" },
    ]);
  });

  it("leaves ordinary text untouched by the ANSI strip", () => {
    const parser = createStdoutParser();
    expect(parser.parseLine("> array[0] and object[key] survive", TS)).toEqual([
      { kind: "assistant", ts: TS, text: "array[0] and object[key] survive" },
    ]);
  });
});

describe("parseStdoutLine", () => {
  it("still classifies markers without state", () => {
    expect(parseStdoutLine("\x1b[38;5;141m> \x1b[0mhello", TS)).toEqual([
      { kind: "assistant", ts: TS, text: "hello" },
    ]);
    expect(parseStdoutLine("Reading file: /tmp/x, all lines (using tool: read)", TS)).toEqual([
      { kind: "tool_call", ts: TS, name: "read", input: { detail: "Reading file: /tmp/x, all lines" } },
    ]);
  });
});
