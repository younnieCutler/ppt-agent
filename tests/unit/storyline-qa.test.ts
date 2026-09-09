import { describe, expect, it } from "vitest";
import { storylineBlueprintDigest, validateStorylineBlueprint } from "../../src/storyline";

const contract = {
  sources: [{ kind: "prompt", id: "brief", text: "Quarterly strategy brief" }],
  purpose: "executive",
  audience: "Executive committee",
  objective: "Decide whether to fund the rollout",
  audienceDecision: "Approve the rollout",
  designDirection: "balanced",
  presentationStyle: "executive",
  storyline: ["opening", "evidence", "closing"],
  language: "en-US",
  slideCount: 3,
  brand: { kind: "default" },
  fonts: { heading: "Arial", body: "Arial" },
  fontDelivery: "managed_device",
  editability: "native_editable",
  aspectRatio: "16:9",
};

const contentModel = {
  version: 1,
  sources: [{
    sourceId: "brief",
    excerpts: [
      { id: "e1", locator: "p1", text: "Enterprise revenue grew 18%." },
      { id: "e2", locator: "p2", text: "Pilot conversion increased from 11% to 16%." },
      { id: "e3", locator: "p3", text: "The rollout requires one additional approval gate." },
    ],
  }],
};

const storyline = {
  version: 1,
  title: "Rollout decision",
  narrativeThesis: "The pilot supports a controlled rollout.",
  audienceDecision: "Approve the rollout",
  slides: [
    { id: "S01", storyBeat: "opening", assertion: "The pilot supports a controlled rollout", evidenceRefs: [{ sourceId: "brief", excerptId: "e1" }], implication: "Growth is material enough to warrant a decision.", decisionImpact: "Frames the approval question.", visualStrategy: "statement", speakerNotes: "Open with the decision." },
    { id: "S02", storyBeat: "evidence", assertion: "Conversion improved by five points in the pilot", evidenceRefs: [{ sourceId: "brief", excerptId: "e2" }], implication: "The operating signal improved, not just top-line volume.", decisionImpact: "Reduces demand-side uncertainty.", visualStrategy: "before_after", speakerNotes: "Keep the causal claim narrow." },
    { id: "S03", storyBeat: "closing", assertion: "A controlled rollout should retain one approval gate", evidenceRefs: [{ sourceId: "brief", excerptId: "e3" }], implication: "Expansion can proceed without removing governance.", decisionImpact: "Approve rollout with the gate retained.", visualStrategy: "roadmap", speakerNotes: "Close on the decision." },
  ],
};

describe("StorylineBlueprint QA", () => {
  it("passes a grounded, decision-oriented storyline", () => {
    const report = validateStorylineBlueprint(storyline, contract, contentModel);
    expect(report.status).toBe("pass");
    expect(report.findings).toEqual([]);
    expect(storylineBlueprintDigest(storyline)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hard-fails evidence that is absent from the ContentModel", () => {
    const broken = structuredClone(storyline);
    broken.slides[1].evidenceRefs = [{ sourceId: "brief", excerptId: "invented" }];
    const report = validateStorylineBlueprint(broken, contract, contentModel);
    expect(report.status).toBe("fail");
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "STORYLINE_EVIDENCE_NOT_IN_CONTENT_MODEL", severity: "hard", slideId: "S02" }));
  });

  it("flags repeated assertions as a blocking review risk", () => {
    const repetitive = structuredClone(storyline);
    repetitive.slides[1].assertion = "The pilot supports a controlled rollout.";
    const report = validateStorylineBlueprint(repetitive, contract, contentModel);
    expect(report.status).toBe("review");
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "DUPLICATE_ASSERTION", severity: "risk", slideId: "S02" }));
  });

  it("keeps semantic judgment severity closed", () => {
    const report = validateStorylineBlueprint(storyline, contract, contentModel, [
      { code: "THESIS_NOT_SUPPORTED", slideId: "S02", message: "The evidence does not support the assertion.", severity: "risk" },
    ]);
    expect(report.status).toBe("fail");
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "THESIS_NOT_SUPPORTED", severity: "hard" }));
  });
});
