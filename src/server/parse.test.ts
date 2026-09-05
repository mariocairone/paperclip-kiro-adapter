import { describe, expect, it } from "vitest";
import { describeKiroFailure, parseKiroOutput } from "./parse.js";

/**
 * Captured verbatim from `kiro-cli chat --no-interactive --trust-all-tools`
 * (write + read tools, escape codes intact). Keep it byte-faithful — the point
 * of these tests is that the parser survives the real rendering.
 */
const REAL_STDOUT = [
  "\x1b[38;5;141m> \x1b[0mI'll create the file with \"ping\" and then read it back to you.\x1b[0m\x1b[0m",
  "I'll create the following file: \x1b[38;5;141m/private/tmp/kparse/notes.txt\x1b[0m\x1b[38;5;244m (using tool: write)\x1b[0m",
  'Purpose: Create notes.txt with the word "ping"',
  "",
  "\x1b[49m\x1b[38;5;10m+    1\x1b[0m:\x1b[38;5;10m\x1b[49m ping",
  "\x1b[0m\x1b[K",
  "Creating: \x1b[38;5;141m/private/tmp/kparse/notes.txt\x1b[0m",
  "\x1b[38;5;244m - Completed in 0.11s\x1b[0m",
  "",
  "Reading file: \x1b[38;5;141m/private/tmp/kparse/notes.txt\x1b[0m, all lines\x1b[38;5;244m (using tool: read)\x1b[0m",
  "\x1b[38;5;10m ✓ \x1b[0mSuccessfully read \x1b[38;5;244m4 bytes\x1b[0m from /private/tmp/kparse/notes.txt",
  "\x1b[38;5;244m - Completed in 0.0s\x1b[0m",
  "",
  '\x1b[38;5;141m> \x1b[0mThe file says "ping".',
].join("\n");

const REAL_STDERR = [
  "\x1b[32mAll tools are now trusted (\x1b[0m\x1b[31m!\x1b[0m\x1b[32m). Kiro will execute tools without asking for confirmation.\x1b[0m",
  "Agents can sometimes do unexpected things so understand the risks.",
  "",
  "Learn more at \x1b[38;5;141mhttps://kiro.dev/docs/cli/chat/security/#using-tools-trust-all-safely\x1b[0m",
  "\x1b[38;5;252m\x1b[0m\x1b[?25l\x1b[?25l\x1b[0m\x1b[0m",
  "\x1b[38;5;8m",
  " ▸ Time: 9s",
].join("\n");

describe("parseKiroOutput", () => {
  it("recovers both tool calls with their purpose and duration", () => {
    const parsed = parseKiroOutput(REAL_STDOUT);

    expect(parsed.toolCalls).toEqual([
      {
        name: "write",
        detail: "I'll create the following file: /private/tmp/kparse/notes.txt",
        purpose: 'Create notes.txt with the word "ping"',
        duration: "0.11s",
      },
      {
        name: "read",
        detail: "Reading file: /private/tmp/kparse/notes.txt, all lines",
        purpose: null,
        duration: "0.0s",
      },
    ]);
  });

  it("keeps prose in the summary and drops the tool chrome", () => {
    const { summary } = parseKiroOutput(REAL_STDOUT);

    expect(summary).toContain("I'll create the file with \"ping\"");
    expect(summary).toContain('The file says "ping".');
    // Invocation lines, purposes, diff rows and timings are chrome, not content.
    expect(summary).not.toContain("using tool:");
    expect(summary).not.toContain("Purpose:");
    expect(summary).not.toContain("Completed in");
    expect(summary).not.toContain("+    1");
  });

  it("strips every escape sequence, including cursor controls", () => {
    const parsed = parseKiroOutput(REAL_STDOUT);
    expect(parsed.summary).not.toMatch(/\x1b/);
    expect(parsed.toolCalls.map((call) => call.detail).join()).not.toMatch(/\x1b/);
  });

  it("collects footer metrics", () => {
    expect(parseKiroOutput(" \x1b[38;5;8m ▸ Time: 9s\n ▸ Credits: 0.42").metrics).toEqual({
      Time: "9s",
      Credits: "0.42",
    });
  });

  it("returns empty results for empty output", () => {
    expect(parseKiroOutput("")).toEqual({ summary: "", toolCalls: [], metrics: {} });
  });
});

describe("describeKiroFailure", () => {
  it("skips the trust banner and reports the real error", () => {
    const stderr = `${REAL_STDERR}\n\x1b[38;5;9mThe model 'claude-opus-4.6' is not available.`;
    expect(describeKiroFailure(stderr)).toBe("The model 'claude-opus-4.6' is not available.");
  });

  it("returns an empty string when stderr carries only banner and timing noise", () => {
    expect(describeKiroFailure(REAL_STDERR)).toBe("");
  });
});
