import { describe, expect, it } from "vitest";
import { buildSlideAuthoringContext, buildStorylinePlanningContext, planningContextBytes } from "../../src/planning-context";
import { selectPilotSlides } from "../../src/pilot";
import { verifyDeckPlanAgainstStoryline } from "../../src/storyline-plan";

const contentModel = {
  version: 1,
  sources: [{
    sourceId: "brief",
    excerpts: [
      { id: "e1", locator: "p1", text: "Enterprise revenue grew 18%." },
      { id: "e2", locator: "p2", text: "Pilot conversion increased from 11% to 16%." },
      { id: "e3", locator: "p3", text: "The rollout requires one additional approval gate." },
      { id: "unused", locator: "p99", text: "This unrelated excerpt should never enter a slide-local context." },
    ],
  }],
};

const storyline = {
  version: 1,
  title: "Rollout decision",
  narrativeThesis: "The pilot supports a controlled rollout.",
  audienceDecision: "Approve the rollout",
  slides: [
    { id: "S01", storyBeat: "opening", assertion: "The pilot supports a controlled rollout", evidenceRefs: [{ sourceId: "brief", excerptId: "e1" }], implication: "Growth is material enough to warrant a decision.", decisionImpact: "Frames the approval question.", visualStrategy: "statement", speakerNotes: "Do not replay this during planning." },
    { id: "S02", storyBeat: "evidence", assertion: "Conversion improved by five points in the pilot", evidenceRefs: [{ sourceId: "brief", excerptId: "e2" }, { sourceId: "brief", excerptId: "e1" }], implication: "The operating signal improved, not just top-line volume.", decisionImpact: "Reduces demand-side uncertainty.", visualStrategy: "before_after", speakerNotes: "Also omitted from planning context." },
    { id: "S03", storyBeat: "closing", assertion: "A controlled rollout should retain one approval gate", evidenceRefs: [{ sourceId: "brief", excerptId: "e3" }], implication: "Expansion can proceed without removing governance.", decisionImpact: "Approve rollout with the gate retained.", visualStrategy: "roadmap", speakerNotes: "Close on the decision." },
  ],
};

const plan = {
  version: 1,
  title: "Rollout decision",
  narrativeThesis: "The pilot supports a controlled rollout.",
  slides: [
    { id: "S01", storyBeat: "opening", thesis: "The pilot supports a controlled rollout", function: "cover", primaryEvidence: [{ sourceId: "brief", excerptId: "e1" }], secondaryEvidence: [], visualIntent: "single_focal", density: "low", takeaway: "Decision frame" },
    { id: "S02", storyBeat: "evidence", thesis: "Conversion improved by five points in the pilot", function: "quantitative", primaryEvidence: [{ sourceId: "brief", excerptId: "e2" }], secondaryEvidence: [{ sourceId: "brief", excerptId: "e1" }], visualIntent: "trend", density: "high", takeaway: "Pilot improved" },
    { id: "S03", storyBeat: "closing", thesis: "A controlled rollout should retain one approval gate", function: "action", primaryEvidence: [{ sourceId: "brief", excerptId: "e3" }], secondaryEvidence: [], visualIntent: "timeline", density: "medium", takeaway: "Retain governance" },
  ],
};

describe("token-efficient planning contexts", () => {
  it("deduplicates evidence and omits speaker notes and unrelated ContentModel excerpts", () => {
    const context = buildStorylinePlanningContext(storyline, contentModel);
    expect(context.evidence.map((entry) => entry.key)).toEqual(["brief:e1", "brief:e2", "brief:e3"]);
    expect(JSON.stringify(context)).not.toContain("Do not replay this during planning");
    expect(JSON.stringify(context)).not.toContain("unrelated excerpt");
  });

  it("builds a slide-local context rather than replaying the whole storyline", () => {
    const full = buildStorylinePlanningContext(storyline, contentModel);
    const local = buildSlideAuthoringContext(storyline, contentModel, "S02");
    expect(local.slides.map((slide) => slide.id)).toEqual(["S02"]);
    expect(local.evidence.map((entry) => entry.key)).toEqual(["brief:e2", "brief:e1"]);
    expect(planningContextBytes(local)).toBeLessThan(planningContextBytes(full));
  });
});

describe("storyline-to-plan gate", () => {
  it("accepts a DeckPlan that preserves storyline assertions and evidence", () => {
    expect(verifyDeckPlanAgainstStoryline(plan, storyline)).toEqual([]);
  });

  it("hard-fails thesis or evidence drift", () => {
    const broken = structuredClone(plan);
    broken.slides[1].thesis = "A stronger but unapproved claim";
    broken.slides[1].secondaryEvidence = [];
    const findings = verifyDeckPlanAgainstStoryline(broken, storyline);
    expect(findings).toContainEqual(expect.objectContaining({ code: "STORYLINE_PLAN_ASSERTION_DRIFT", severity: "hard", slideId: "S02" }));
    expect(findings).toContainEqual(expect.objectContaining({ code: "STORYLINE_PLAN_EVIDENCE_DRIFT", severity: "hard", slideId: "S02" }));
  });
});

describe("deterministic pilot selection", () => {
  it("selects an anchor, the hardest slide, then a structurally different slide without an LLM", () => {
    const fourSlidePlan = structuredClone(plan);
    fourSlidePlan.slides.push({ id: "S04", storyBeat: "evidence", thesis: "A second evidence view", function: "evidence", primaryEvidence: [{ sourceId: "brief", excerptId: "e3" }], secondaryEvidence: [], visualIntent: "hierarchy", density: "low", takeaway: "Different structure" });
    const selection = selectPilotSlides(fourSlidePlan);
    expect(selection.slideIds).toEqual(["S01", "S02", "S03"]);
    expect(selection.strategy).toBe("representative_v1");
  });
});
