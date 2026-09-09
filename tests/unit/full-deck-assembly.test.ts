import { describe, expect, it } from "vitest";
import { assembleFullDeck, buildFullSlideArtifact, fullSlideInputSchema, validateFullSlideInput } from "../../src/full-deck-assembly";

const ref = { sourceId: "brief", excerptId: "E01" };
const digests = {
  deckPlanDigest: "a".repeat(64),
  compositionPlanDigest: "b".repeat(64),
  storylineDigest: "c".repeat(64),
  pilotApprovalDigest: "d".repeat(64),
};

const contract = {
  sources: [{ kind: "prompt", id: "brief", text: "Brief" }],
  purpose: "internal",
  audience: "Team",
  storyline: ["opening", "evidence", "insight", "closing"],
  language: "en",
  slideCount: 5,
  brand: { kind: "default" },
  fonts: { heading: "Arial", body: "Arial" },
  aspectRatio: "16:9",
};

const beats = ["opening", "evidence", "evidence", "insight", "closing"] as const;
const plan = {
  version: 1,
  title: "Full deck",
  narrativeThesis: "One decision narrative",
  slides: beats.map((storyBeat, index) => ({
    id: `S0${index + 1}`,
    storyBeat,
    thesis: `Thesis ${index + 1}`,
    function: "statement" as const,
    primaryEvidence: [ref],
    secondaryEvidence: [],
    visualIntent: "hierarchy" as const,
    density: "medium" as const,
    takeaway: `Takeaway ${index + 1}`,
  })),
};

const compositionPlan = {
  slides: plan.slides.map((slide) => ({
    id: slide.id,
    candidates: [{ layout: "statement", composition: "hero_evidence", rank: 1 }],
  })),
};

function slide(index: number) {
  return {
    id: `S0${index}`,
    role: "body",
    storyBeat: beats[index - 1],
    headline: `Thesis ${index}`,
    claims: [{ text: `Thesis ${index}`, kind: "fact" as const, status: "verified" as const }],
    composition: "hero_evidence",
    sourceRefs: [ref],
    layout: "statement" as const,
    content: { body: `Body ${index}`, proofs: [] },
  };
}

const pilot = {
  version: 1 as const,
  selectionDigest: "e".repeat(64),
  deckPlanDigest: digests.deckPlanDigest,
  compositionPlanDigest: digests.compositionPlanDigest,
  slides: [slide(1), slide(2), slide(3)],
};

function artifact(index: number) {
  return buildFullSlideArtifact(fullSlideInputSchema.parse({ version: 1, slide: slide(index) }), digests);
}

describe("full deck assembly", () => {
  it("reuses approved pilot slides and assembles only validated non-pilot slides in DeckPlan order", () => {
    const result = assembleFullDeck(contract, plan, compositionPlan, pilot, [artifact(4), artifact(5)], digests);
    expect(result.status).toBe("pass");
    expect(result.pilotSlidesReused).toEqual(["S01", "S02", "S03"]);
    expect(result.authoredSlides).toEqual(["S04", "S05"]);
    expect(result.deck?.slides.map((item) => item.id)).toEqual(["S01", "S02", "S03", "S04", "S05"]);
    expect(result.deck?.slides[0]).toEqual(fullSlideInputSchema.parse({ version: 1, slide: pilot.slides[0] }).slide);
    expect(result.deck?.slides[1]).toEqual(fullSlideInputSchema.parse({ version: 1, slide: pilot.slides[1] }).slide);
    expect(result.deck?.slides[2]).toEqual(fullSlideInputSchema.parse({ version: 1, slide: pilot.slides[2] }).slide);
    expect((result.deck as { version?: number })?.version).toBe(2);
    expect((result.deck as { planDigest?: string })?.planDigest).toBe(digests.deckPlanDigest);
  });

  it("blocks assembly until every non-pilot slide exists", () => {
    const result = assembleFullDeck(contract, plan, compositionPlan, pilot, [artifact(4)], digests);
    expect(result.status).toBe("fail");
    expect(result.findings.map((finding) => finding.code)).toContain("FULL_SLIDE_MISSING");
    expect(result.deck).toBeUndefined();
  });

  it("rejects stale slide artifacts even when their visible content still matches the plan", () => {
    const stale = { ...artifact(4), compositionPlanDigest: "f".repeat(64) };
    const result = assembleFullDeck(contract, plan, compositionPlan, pilot, [stale, artifact(5)], digests);
    expect(result.status).toBe("fail");
    expect(result.findings.map((finding) => finding.code)).toContain("FULL_SLIDE_PROVENANCE_STALE");
  });

  it("refuses to spend a second authoring pass on an approved pilot slide", () => {
    const result = validateFullSlideInput({ version: 1, slide: slide(1) }, "S01", pilot.slides.map((item) => item.id), plan, compositionPlan);
    expect(result.findings.map((finding) => finding.code)).toContain("FULL_SLIDE_IS_APPROVED_PILOT");
  });

  it("locks non-pilot authoring to the approved thesis, evidence, and composition shortlist", () => {
    const changed = {
      ...slide(4),
      headline: "A new thesis",
      claims: [{ text: "A new thesis", kind: "fact" as const, status: "verified" as const }],
      sourceRefs: [{ sourceId: "brief", excerptId: "UNPLANNED" }],
      composition: "claim_actions",
    };
    const result = validateFullSlideInput({ version: 1, slide: changed }, "S04", pilot.slides.map((item) => item.id), plan, compositionPlan);
    const codes = result.findings.map((finding) => finding.code);
    expect(codes).toContain("FULL_SLIDE_STORY_DRIFT");
    expect(codes).toContain("FULL_SLIDE_PRIMARY_EVIDENCE_MISSING");
    expect(codes).toContain("FULL_SLIDE_UNPLANNED_EVIDENCE");
    expect(codes).toContain("FULL_SLIDE_COMPOSITION_OUTSIDE_SHORTLIST");
  });
});
