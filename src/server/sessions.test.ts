import { describe, expect, it } from "vitest";
import { pickLatestKiroSession } from "./sessions.js";

/** Shape captured from `kiro-cli chat --list-sessions -f json`. */
const LISTING = JSON.stringify([
  {
    cwd: "/private/tmp/kparse",
    sessions: [
      { sessionId: "newest", source: "v3", title: "…", updatedAt: "2026-08-06T14:39:22.469Z" },
      { sessionId: "older", source: "v3", title: "…", updatedAt: "2026-08-06T14:37:18.284Z" },
    ],
  },
  {
    cwd: "/Users/someone/other-project",
    sessions: [
      { sessionId: "foreign", source: "v3", title: "…", updatedAt: "2026-08-06T15:00:00.000Z" },
    ],
  },
]);

const RUN_START = new Date("2026-08-06T14:39:00.000Z");

describe("pickLatestKiroSession", () => {
  it("picks the newest session for the run's directory", () => {
    expect(pickLatestKiroSession(LISTING, { cwdCandidates: ["/private/tmp/kparse"] })).toEqual({
      sessionId: "newest",
      updatedAt: "2026-08-06T14:39:22.469Z",
    });
  });

  it("matches the resolved path kiro reports, not just the requested one", () => {
    // A run in /tmp/kparse is listed by kiro as /private/tmp/kparse on macOS.
    const picked = pickLatestKiroSession(LISTING, {
      cwdCandidates: ["/tmp/kparse", "/private/tmp/kparse"],
    });
    expect(picked?.sessionId).toBe("newest");
  });

  it("never adopts a session from another directory", () => {
    expect(pickLatestKiroSession(LISTING, { cwdCandidates: ["/Users/someone/unrelated"] })).toBeNull();
  });

  it("ignores sessions older than the run", () => {
    const picked = pickLatestKiroSession(LISTING, {
      cwdCandidates: ["/private/tmp/kparse"],
      notBefore: new Date("2026-08-06T16:00:00.000Z"),
    });
    expect(picked).toBeNull();
  });

  it("tolerates the clock skew between the last output and the stored session", () => {
    const picked = pickLatestKiroSession(LISTING, {
      cwdCandidates: ["/private/tmp/kparse"],
      notBefore: new Date("2026-08-06T14:39:25.000Z"),
    });
    expect(picked?.sessionId).toBe("newest");
  });

  it("accepts a trailing slash on the run directory", () => {
    const picked = pickLatestKiroSession(LISTING, { cwdCandidates: ["/private/tmp/kparse/"] });
    expect(picked?.sessionId).toBe("newest");
  });

  it("returns null for malformed or empty output", () => {
    for (const stdout of ["", "not json", "[]", '[{"cwd":"/private/tmp/kparse"}]', "{}"]) {
      expect(pickLatestKiroSession(stdout, { cwdCandidates: ["/private/tmp/kparse"] })).toBeNull();
    }
  });

  it("skips entries without a usable id or timestamp", () => {
    const listing = JSON.stringify([
      {
        cwd: "/w",
        sessions: [
          { sessionId: "no-timestamp" },
          { updatedAt: "2026-08-06T14:39:22.469Z" },
          { sessionId: "bad-timestamp", updatedAt: "not-a-date" },
        ],
      },
    ]);
    expect(pickLatestKiroSession(listing, { cwdCandidates: ["/w"], notBefore: RUN_START })).toBeNull();
  });
});
