import { describe, expect, it } from "vitest";
import { sessionCodec } from "./session-codec.js";

describe("sessionCodec", () => {
  it("round-trips legacy CLI sessions", () => {
    const params = { sessionId: "cli-session", cwd: "/tmp/work" };
    expect(sessionCodec.deserialize(params)).toEqual(params);
    expect(sessionCodec.serialize(params)).toEqual(params);
    expect(sessionCodec.getDisplayId?.(params)).toBe("cli-session");
  });

  it("round-trips typed ACPX session identity without reducing it to a bare id", () => {
    const params = {
      sessionKey: "paperclip:company:agent:task:fingerprint",
      runtimeSessionName: "runtime-name",
      acpxRecordId: "record-id",
      acpSessionId: "acp-session",
      agentSessionId: "agent-session",
      agent: "kiro",
      cwd: "/tmp/work",
      mode: "persistent",
      stateDir: "/tmp/state",
      configFingerprint: "fingerprint",
    };
    expect(sessionCodec.deserialize(params)).toEqual(params);
    expect(sessionCodec.serialize(params)).toEqual(params);
    expect(sessionCodec.getDisplayId?.(params)).toBe("runtime-name");
  });

  it("rejects unrelated records", () => {
    expect(sessionCodec.deserialize({ nope: true })).toBeNull();
    expect(sessionCodec.serialize({ nope: true })).toBeNull();
  });
});
