import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deckPlanDigest, validateDeckPlan, verifyDeckAgainstPlan } from "../../src/planning";

const deck = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/deck.json"), "utf8"));
const ref = deck.slides[0].sourceRefs[0];
const plan = {
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
const compositionPlan = { version: 1, slides: deck.slides.map((slide: { id: string; layout: string; composition: string }) => ({ id: slide.id, candidates: [{ layout: slide.layout, composition: slide.composition, family: "single_focal", rank: 1, reasons: [] }] })) };
const contentModel = { version: 1, sources: [{ sourceId: ref.sourceId, excerpts: [{ id: ref.excerptId, locator: "1", text: "Grounded fact" }] }] };
const codes = (findings: Array<{ code: string }>) => findings.map((finding) => finding.code);

describe("DeckSpec v2 planDigest contract", () => {
  it("accepts a DeckSpec carrying the digest of the plan it was authored against", () => {
    const v2 = { ...deck, version: 2, planDigest: deckPlanDigest(plan) };
    expect(codes(verifyDeckAgainstPlan(v2, plan, compositionPlan))).not.toContain("DECK_PLAN_DIGEST_MISMATCH");
  });

  it("rejects an arbitrary well-formed digest", () => {
    const v2 = { ...deck, version: 2, planDigest: "a".repeat(64) };
    expect(codes(verifyDeckAgainstPlan(v2, plan, compositionPlan))).toContain("DECK_PLAN_DIGEST_MISMATCH");
  });

  it("rejects a DeckSpec whose plan changed after it was authored", () => {
    const v2 = { ...deck, version: 2, planDigest: deckPlanDigest(plan) };
    const editedPlan = { ...plan, narrativeThesis: "A different story." };
    expect(codes(verifyDeckAgainstPlan(v2, editedPlan, compositionPlan))).toContain("DECK_PLAN_DIGEST_MISMATCH");
  });

  it("digests the normalized plan, so re-serialization alone is not drift", () => {
    // Same plan, keys written in a different order and with different indentation.
    const reordered = Object.fromEntries(Object.entries(plan).reverse());
    expect(deckPlanDigest(JSON.parse(JSON.stringify(reordered, null, 4)))).toBe(deckPlanDigest(plan));
  });
});

describe("planned evidence resolution", () => {
  it("reports unresolvable secondary evidence with its own code", () => {
    const withDanglingSecondary = { ...plan, slides: [{ ...plan.slides[0], secondaryEvidence: [{ sourceId: ref.sourceId, excerptId: "E404" }] }, ...plan.slides.slice(1)] };
    const report = validateDeckPlan(withDanglingSecondary, deck.contract, contentModel, []);
    expect(codes(report.findings)).toContain("SECONDARY_EVIDENCE_NOT_IN_CONTENT_MODEL");
    expect(codes(report.findings)).not.toContain("PRIMARY_EVIDENCE_NOT_IN_CONTENT_MODEL");
    expect(report.status).toBe("fail");
  });

  it("passes when every planned reference resolves", () => {
    const withSecondary = { ...plan, slides: [{ ...plan.slides[0], secondaryEvidence: [ref] }, ...plan.slides.slice(1)] };
    expect(codes(validateDeckPlan(withSecondary, deck.contract, contentModel, []).findings)).not.toContain("SECONDARY_EVIDENCE_NOT_IN_CONTENT_MODEL");
  });
});
