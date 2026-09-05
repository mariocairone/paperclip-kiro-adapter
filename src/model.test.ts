import { describe, expect, it } from "vitest";
import { models } from "./index.js";
import {
  DEFAULT_KIRO_MODEL,
  KIRO_MODEL_IDS,
  parseKiroModelCatalog,
  resolveKiroModel,
} from "./model.js";

describe("resolveKiroModel", () => {
  it("defaults to GPT 5.6 Sol when no model is configured", () => {
    for (const empty of [undefined, null, "", "   ", 42]) {
      expect(resolveKiroModel(empty)).toEqual({
        id: DEFAULT_KIRO_MODEL,
        requested: "",
        aliased: false,
        known: true,
      });
    }
  });

  it("passes a real kiro model through untouched", () => {
    for (const id of KIRO_MODEL_IDS) {
      expect(resolveKiroModel(id)).toEqual({ id, requested: id, aliased: false, known: true });
    }
  });

  it("translates the dated Anthropic ids that hiring agents reach for", () => {
    // Observed in the wild: a CEO agent hired an engineer with this id, and the
    // environment test failed with "Model '…' does not exist".
    expect(resolveKiroModel("claude-sonnet-4-20250514")).toMatchObject({
      id: "claude-sonnet-4",
      aliased: true,
      known: true,
    });
    expect(resolveKiroModel("claude-3-opus-20240229")).toMatchObject({
      id: "claude-opus-4.5",
      aliased: true,
    });
    expect(resolveKiroModel("claude-sonnet-4-5")).toMatchObject({
      id: "claude-sonnet-4.5",
      aliased: true,
    });
  });

  it("trims surrounding whitespace", () => {
    expect(resolveKiroModel("  claude-sonnet-4.5  ")).toMatchObject({
      id: "claude-sonnet-4.5",
      known: true,
    });
  });

  it("reports an unknown model instead of silently substituting one", () => {
    const resolved = resolveKiroModel("gpt-5-turbo");
    expect(resolved).toEqual({
      id: "gpt-5-turbo",
      requested: "gpt-5-turbo",
      aliased: false,
      known: false,
    });
  });

  it("every alias target is a model kiro actually offers", () => {
    const aliases = ["claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022", "claude-3-opus-20240229"];
    for (const alias of aliases) {
      expect(KIRO_MODEL_IDS).toContain(resolveKiroModel(alias).id);
    }
  });
});

describe("published model list", () => {
  it("offers exactly the fallback ids the resolver accepts", () => {
    expect(models.map((model) => model.id)).toEqual([...KIRO_MODEL_IDS]);
  });

  it("includes current Opus, Fable, and GPT 5.6 models", () => {
    expect(models.map((model) => model.id)).toEqual(expect.arrayContaining([
      "claude-opus-5",
      "claude-fable-5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]));
  });

  it("parses and deduplicates the live kiro catalog", () => {
    expect(parseKiroModelCatalog(JSON.stringify({
      models: [
        { model_id: "auto", model_name: "auto" },
        { model_id: "claude-opus-5", model_name: "claude-opus-5" },
        { model_id: "claude-opus-5", model_name: "duplicate" },
        { model_id: "future-model", model_name: "Future Model" },
      ],
    }))).toEqual([
      { id: "auto", label: "Auto" },
      { id: "claude-opus-5", label: "Claude Opus 5" },
      { id: "future-model", label: "Future Model" },
    ]);
  });

  it("labels every entry", () => {
    for (const model of models) expect(model.label).toBeTruthy();
  });
});
