import { describe, expect, it } from "vitest";
import { buildPilotAuthoringContext, buildPilotDeckEnvelope, buildPilotSpecArtifact, validatePilotSlides } from "../../src/pilot-authoring";

const ref = { sourceId: "brief", excerptId: "e1" };
const plan = {
  version: 1,
  title: "Decision",
  narrativeThesis: "Proceed carefully",
  slides: [
    { id: "S01", storyBeat: "opening", thesis: "Proceed carefully", function: "cover", primaryEvidence: [ref], secondaryEvidence: [], visualIntent: "single_focal", density: "low", takeaway: "Frame" },
    { id: "S02", storyBeat: "evidence", thesis: "The pilot improved", function: "statement", primaryEvidence: [ref], secondaryEvidence: [], visualIntent: "hierarchy", density: "medium", takeaway: "Evidence" },
    { id: "S03", storyBeat: "insight", thesis: "Risk remains bounded", function: "statement", primaryEvidence: [ref], secondaryEvidence: [], visualIntent: "hierarchy", density: "medium", takeaway: "Risk" },
    { id: "S04", storyBeat: "closing", thesis: "Approve the rollout", function: "action", primaryEvidence: [ref], secondaryEvidence: [], visualIntent: "flow", density: "low", takeaway: "Decision" },
  ],
};
const compositionPlan = {
  version: 1,
  slides: [
    { id: "S01", candidates: [{ layout: "title", composition: "cover", rank: 1 }] },
    { id: "S02", candidates: [{ layout: "statement", composition: "hero_evidence", rank: 1 }] },
    { id: "S03", candidates: [{ layout: "statement", composition: "claim_actions", rank: 1 }] },
    { id: "S04", candidates: [{ layout: "statement", composition: "claim_actions", rank: 1 }] },
  ],
};
const slides = {
  version: 1,
  slides: [
    { id: "S01", role: "cover", storyBeat: "opening", headline: "Proceed carefully", claims: [{ text: "Proceed carefully", kind: "interpretation", status: "verified" }], composition: "cover", sourceRefs: [ref], layout: "title", content: { subtitle: "Pilot decision" } },
    { id: "S02", role: "evidence", storyBeat: "evidence", headline: "The pilot improved", claims: [{ text: "The pilot improved", kind: "interpretation", status: "verified" }], composition: "hero_evidence", sourceRefs: [ref], layout: "statement", content: { body: "The measured pilot improved.", proofs: ["Evidence"] } },
    { id: "S03", role: "insight", storyBeat: "insight", headline: "Risk remains bounded", claims: [{ text: "Risk remains bounded", kind: "interpretation", status: "verified" }], composition: "claim_actions", sourceRefs: [ref], layout: "statement", content: { body: "Risk remains bounded.", proofs: ["Control"] } },
  ],
};

const contract = {
  sources: [{ kind: "prompt", id: "brief", text: "Evidence" }],
  purpose: "internal",
  audience: "Leadership",
  audienceDecision: "Approve",
  designDirection: "balanced",
  presentationStyle: "corporate",
  storyline: ["opening", "evidence", "insight", "closing"],
  language: "en-US",
  slideCount: 4,
  brand: { kind: "default" },
  fonts: { heading: "Arial", body: "Arial" },
  aspectRatio: "16:9",
};

describe("pilot authoring", () => {
  it("accepts only the selected slides and resolved composition shortlist", () => {
    const result = validatePilotSlides(slides, { slideIds: ["S01", "S02", "S03"] }, plan, compositionPlan);
    expect(result.qa).toEqual({ status: "pass", findings: [] });
  });

  it("hard-fails story or composition drift", () => {
    const broken = structuredClone(slides);
    broken.slides[1].headline = "A rewritten claim";
    broken.slides[1].claims[0].text = "A rewritten claim";
    broken.slides[2].composition = "hero_evidence";
    const result = validatePilotSlides(broken, { slideIds: ["S01", "S02", "S03"] }, plan, compositionPlan);
    expect(result.qa.findings).toContainEqual(expect.objectContaining({ code: "PILOT_STORY_DRIFT", severity: "hard", slideId: "S02" }));
    expect(result.qa.findings).toContainEqual(expect.objectContaining({ code: "PILOT_COMPOSITION_OUTSIDE_SHORTLIST", severity: "hard", slideId: "S03" }));
  });

  it("creates a three-slide render envelope without mutating the full contract", () => {
    const validated = validatePilotSlides(slides, { slideIds: ["S01", "S02", "S03"] }, plan, compositionPlan);
    const spec = buildPilotSpecArtifact(validated.input, { selectionDigest: "a".repeat(64), deckPlanDigest: "b".repeat(64), compositionPlanDigest: "c".repeat(64) });
    const envelope = buildPilotDeckEnvelope(contract, "Decision", spec);
    expect(envelope.contract.slideCount).toBe(3);
    expect(envelope.slides.map((slide) => slide.id)).toEqual(["S01", "S02", "S03"]);
    expect(contract.slideCount).toBe(4);
  });

  it("filters composition context to pilot ids", () => {
    const context = buildPilotAuthoringContext({ slides: [] }, { themeId: "corporate" }, compositionPlan, { slideIds: ["S01", "S03"] });
    expect(context.composition.map((entry) => entry.id)).toEqual(["S01", "S03"]);
  });
});
