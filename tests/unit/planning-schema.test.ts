import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deckPlanSchema, deckSchema, deckV2Schema } from "../../src/schema";

const deck = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/deck.json"), "utf8"));
const ref = deck.slides[0].sourceRefs[0];
const validPlan = {
  version: 1,
  title: deck.title,
  narrativeThesis: "A traceable story.",
  slides: deck.slides.map((slide: { id: string; storyBeat: string; headline: string }, index: number) => ({
    id: slide.id,
    storyBeat: slide.storyBeat,
    thesis: slide.headline,
    function: index === 0 ? "cover" : "evidence",
    primaryEvidence: [ref],
    secondaryEvidence: [],
    visualIntent: index === 0 ? "single_focal" : "hierarchy",
    density: "medium",
    takeaway: slide.headline,
  })),
};

describe("DeckPlan and DeckSpec v2 schemas", () => {
  it("accepts a valid DeckPlan", () => {
    expect(deckPlanSchema.parse(validPlan).version).toBe(1);
  });

  it("requires primary evidence on every slide", () => {
    const withoutPrimaryEvidence = { ...validPlan, slides: [{ ...validPlan.slides[0], primaryEvidence: [] }, ...validPlan.slides.slice(1)] };
    expect(() => deckPlanSchema.parse(withoutPrimaryEvidence)).toThrow();
  });

  it("rejects duplicate DeckPlan slide ids", () => {
    const duplicateIds = { ...validPlan, slides: [{ ...validPlan.slides[0] }, { ...validPlan.slides[0] }, validPlan.slides[2]] };
    expect(() => deckPlanSchema.parse(duplicateIds)).toThrow(/unique/i);
  });

  it("requires a plan digest on DeckSpec v2", () => {
    const planDigest = "a".repeat(64);
    expect(deckV2Schema.parse({ ...deck, version: 2, planDigest })).toBeTruthy();
    expect(() => deckV2Schema.parse({ ...deck, version: 2 })).toThrow();
  });

  it("keeps existing unversioned DeckSpecs compatible", () => {
    expect(deckSchema.parse(deck)).toBeTruthy();
  });
});
