import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deckSchema, contentModelSchema } from "../../src/schema";
import { applyRepair, buildRepairContext, loadRepairState, recordRepairAttempt } from "../../src/repair";
import { buildDeckContext } from "../../src/visual";

const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/deck.json"), "utf8"));
const contentModelFixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/content-model.json"), "utf8"));
const allLayoutsFixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/all-layouts.json"), "utf8"));
const allLayoutsContentModel = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/content-model-all-layouts.json"), "utf8"));

const deck = deckSchema.parse(fixture);
const contentModel = contentModelSchema.parse(contentModelFixture);

describe("buildRepairContext", () => {
  it("scopes context to exactly one slide and never leaks other slides or raw source text", () => {
    const context = buildRepairContext(deck, "S02", contentModel, undefined, undefined, "run/visual/slide-002.png");
    expect(context.slide.id).toBe("S02");
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("S01");
    expect(serialized).not.toContain("S03");
  });

  it("resolves only the target slide's cited excerpts", () => {
    const context = buildRepairContext(deck, "S02", contentModel, undefined, undefined, "");
    expect(context.excerpts).toEqual([{ sourceId: "prompt", excerptId: "R001", id: "R001", locator: "prompt", text: "A comparison and data flow deck" }]);
  });

  it("filters findings and reference selection to the target slide/contract only", () => {
    const visualQaReport = { findings: [{ severity: "risk", code: "WEAK_VISUAL_HIERARCHY", slideId: "S02", message: "x" }, { severity: "risk", code: "OTHER", slideId: "S01", message: "y" }] };
    const context = buildRepairContext(deck, "S02", contentModel, visualQaReport, [], "");
    expect(context.findings).toHaveLength(1);
    expect(context.findings[0].slideId).toBe("S02");
  });

  it("stays within the repair efficiency KPI: scoped context is well under 25% of full deck+content-model size", () => {
    const fullDeck = deckSchema.parse(allLayoutsFixture);
    const fullContentModel = contentModelSchema.parse(allLayoutsContentModel);
    const targetId = fullDeck.slides[1].id;
    const context = buildRepairContext(fullDeck, targetId, fullContentModel, undefined, undefined, "");
    const contextSize = JSON.stringify(context).length;
    const fullSize = JSON.stringify({ deck: fullDeck, contentModel: fullContentModel }).length;
    expect(contextSize).toBeLessThan(0.25 * fullSize);
  });
});

describe("buildDeckContext token budget", () => {
  it("stays under the ~2k token (8000 char) retrieval budget", () => {
    const context = buildDeckContext(deck, deck.slides.map((slide) => slide.id));
    expect(JSON.stringify(context).length).toBeLessThan(8000);
  });
});

describe("applyRepair invariants", () => {
  const original = deck.slides[1];
  const validReplacement = { ...original, headline: "Batch and streaming solve different needs, revised" };

  it("accepts a valid replacement that preserves id, storyBeat, and grounding", () => {
    const result = applyRepair(deck, "S02", validReplacement, contentModel);
    expect(result.deck.slides[1].headline).toBe(validReplacement.headline);
    expect(result.regressionScope).toBe("slide");
  });

  it("flags regressionScope as deck-level when composition changes", () => {
    const changedComposition = { ...original, composition: "diagnosis_matrix" };
    const result = applyRepair(deck, "S02", changedComposition, contentModel);
    expect(result.regressionScope).toBe("deck");
  });

  function codeOf(fn: () => unknown): string | undefined {
    try {
      fn();
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    }
  }

  it("rejects a replacement with a different id", () => {
    expect(codeOf(() => applyRepair(deck, "S02", { ...validReplacement, id: "S99" }, contentModel))).toBe("REPAIR_ID_DRIFT");
  });

  it("rejects a replacement with a different storyBeat", () => {
    expect(codeOf(() => applyRepair(deck, "S02", { ...validReplacement, storyBeat: "design" }, contentModel))).toBe("REPAIR_NARRATIVE_ROLE_DRIFT");
  });

  it("rejects a replacement that introduces an ungrounded source reference", () => {
    const ungrounded = { ...validReplacement, sourceRefs: [{ sourceId: "prompt", excerptId: "R999" }] };
    expect(codeOf(() => applyRepair(deck, "S02", ungrounded, contentModel))).toBe("REPAIR_GROUNDING_WEAKENED");
  });

  it("rejects a replacement that drops a required native chart in favor of a non-chart composition", () => {
    const fullDeck = deckSchema.parse(allLayoutsFixture);
    const fullContentModel = contentModelSchema.parse(allLayoutsContentModel);
    const chartSlide = fullDeck.slides.find((slide) => slide.layout === "chart")!;
    const rasterized = { ...chartSlide, layout: "statement", composition: "hero_evidence", content: { body: "x".repeat(10), proofs: [] } };
    expect(codeOf(() => applyRepair(fullDeck, chartSlide.id, rasterized, fullContentModel))).toBe("REPAIR_RASTERIZED_NATIVE");
  });
});

describe("repair-state attempts cap", () => {
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-repair-")), "repair-state.json");

  afterEach(() => {
    if (fs.existsSync(statePath)) fs.rmSync(statePath);
  });

  it("records up to 2 attempts per slide and blocks a 3rd", () => {
    recordRepairAttempt(statePath, "S02", ["WEAK_VISUAL_HIERARCHY"], "in_progress");
    recordRepairAttempt(statePath, "S02", ["WEAK_VISUAL_HIERARCHY"], "blocked");
    expect(() => recordRepairAttempt(statePath, "S02", [], "blocked")).toThrow(/exhausted/);
    const state = loadRepairState(statePath);
    expect(state.attempts).toBe(2);
    expect(state.slides.S02.status).toBe("blocked");
  });
});
