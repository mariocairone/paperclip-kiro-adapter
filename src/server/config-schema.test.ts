import { describe, expect, it } from "vitest";
import { getConfigSchema } from "./config-schema.js";

/**
 * Keys the Paperclip host renders itself in `AgentConfigForm` for every
 * adapter. Declaring any of them here produces a second input bound to the same
 * config key — the user sees "Command" and "Model" twice and cannot tell which
 * one wins.
 */
const HOST_RENDERED_KEYS = [
  "command",
  "model",
  "thinkingEffort",
  "cwd",
  "instructionsFilePath",
  "extraArgs",
  "promptTemplate",
];

describe("getConfigSchema", () => {
  it("never duplicates a field the host already renders", () => {
    const keys = getConfigSchema().fields.map((field) => field.key);
    expect(keys.filter((key) => HOST_RENDERED_KEYS.includes(key))).toEqual([]);
  });

  it("declares unique keys", () => {
    const keys = getConfigSchema().fields.map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every field a label and a usable type", () => {
    for (const field of getConfigSchema().fields) {
      expect(field.label, `field ${field.key} needs a label`).toBeTruthy();
      expect(["text", "select", "toggle", "number", "textarea", "combobox"]).toContain(field.type);
      if (field.type === "select") {
        expect(field.options?.length, `select ${field.key} needs options`).toBeGreaterThan(0);
      }
    }
  });

  it("exposes the optional base Kiro agent field", () => {
    expect(getConfigSchema().fields).toContainEqual(
      expect.objectContaining({ key: "baseAgent", type: "text" }),
    );
  });

  it("keeps the run-control fields that the host only offers when editing", () => {
    const keys = getConfigSchema().fields.map((field) => field.key);
    expect(keys).toContain("timeoutSec");
    expect(keys).toContain("graceSec");
  });
});
