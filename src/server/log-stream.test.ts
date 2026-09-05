import { describe, expect, it } from "vitest";
import { createSanitizedLogStream } from "./log-stream.js";

/** ESC, spelled out so the fixtures below survive copy/paste and diffs. */
const E = "\u001b";

function collect() {
  const lines: Array<[string, string]> = [];
  const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
    lines.push([stream, chunk]);
  };
  return { lines, onLog };
}

describe("createSanitizedLogStream", () => {
  it("strips the SGR codes kiro wraps around tool invocations", async () => {
    const { lines, onLog } = collect();
    const stream = createSanitizedLogStream(onLog);

    await stream.onLog(
      "stdout",
      `I will run the following command: ${E}[38;5;141mcurl -sS "$URL"${E}[0m${E}[38;5;244m (using tool: shell)${E}[0m\n`,
    );

    expect(lines).toEqual([
      ["stdout", 'I will run the following command: curl -sS "$URL" (using tool: shell)\n'],
    ]);
  });

  it("emits one call per line even when a chunk carries several", async () => {
    const { lines, onLog } = collect();
    const stream = createSanitizedLogStream(onLog);

    await stream.onLog("stdout", "first\nsecond\nthird\n");

    expect(lines.map(([, chunk]) => chunk)).toEqual(["first\n", "second\n", "third\n"]);
  });

  it("holds a partial line until its newline arrives", async () => {
    const { lines, onLog } = collect();
    const stream = createSanitizedLogStream(onLog);

    await stream.onLog("stdout", "half of a ");
    expect(lines).toEqual([]);

    await stream.onLog("stdout", "line\n");
    expect(lines).toEqual([["stdout", "half of a line\n"]]);
  });

  it("strips an escape sequence split across two chunks", async () => {
    const { lines, onLog } = collect();
    const stream = createSanitizedLogStream(onLog);

    await stream.onLog("stdout", `done ${E}[38;5;`);
    await stream.onLog("stdout", `244m - Completed in 0.49s${E}[0m\n`);

    expect(lines).toEqual([["stdout", "done  - Completed in 0.49s\n"]]);
  });

  it("keeps only the final frame of a carriage-return redraw", async () => {
    const { lines, onLog } = collect();
    const stream = createSanitizedLogStream(onLog);

    await stream.onLog("stdout", "Thinking.\rThinking..\rThinking...\rDone\n");

    expect(lines).toEqual([["stdout", "Done\n"]]);
  });

  it("truncates a line past the limit and reports how much was dropped", async () => {
    const { lines, onLog } = collect();
    const stream = createSanitizedLogStream(onLog, 10);

    await stream.onLog("stdout", `${"x".repeat(25)}\n`);

    expect(lines).toEqual([["stdout", "xxxxxxxxxx… [truncated, 15 more chars]\n"]]);
  });

  it("keeps everything when the limit is disabled", async () => {
    const { lines, onLog } = collect();
    const stream = createSanitizedLogStream(onLog, 0);

    await stream.onLog("stdout", `${"x".repeat(5000)}\n`);

    expect(lines[0]?.[1]).toBe(`${"x".repeat(5000)}\n`);
  });

  it("drops blank and escape-only lines", async () => {
    const { lines, onLog } = collect();
    const stream = createSanitizedLogStream(onLog);

    await stream.onLog("stdout", `${E}[?25l\n\nreal\n`);

    expect(lines).toEqual([["stdout", "real\n"]]);
  });

  it("buffers stdout and stderr independently", async () => {
    const { lines, onLog } = collect();
    const stream = createSanitizedLogStream(onLog);

    await stream.onLog("stdout", "out-partial");
    await stream.onLog("stderr", "err-line\n");
    await stream.onLog("stdout", "-end\n");

    expect(lines).toEqual([
      ["stderr", "err-line\n"],
      ["stdout", "out-partial-end\n"],
    ]);
  });

  it("flushes a trailing line the process left unterminated", async () => {
    const { lines, onLog } = collect();
    const stream = createSanitizedLogStream(onLog);

    await stream.onLog("stdout", "no trailing newline");
    await stream.flush();

    expect(lines).toEqual([["stdout", "no trailing newline\n"]]);
  });

  it("force-flushes a runaway line and drops its tail", async () => {
    const { lines, onLog } = collect();
    const stream = createSanitizedLogStream(onLog, 20);

    await stream.onLog("stdout", "y".repeat(70_000));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[1]).toMatch(/^y{20}… \[truncated, \d+ more chars\]\n$/);

    // The rest of that line is dump tail, not a new line.
    await stream.onLog("stdout", "still the same line\nnext\n");
    expect(lines.map(([, chunk]) => chunk).slice(1)).toEqual(["next\n"]);
  });
});
