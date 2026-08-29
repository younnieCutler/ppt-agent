import { describe, expect, it } from "vitest";
import { validateDeckPlan } from "../../src/planning";

const contract = {
  sources: [{ kind: "prompt", id: "brief", text: "Brief" }],
  purpose: "internal",
  audience: "Team",
  storyline: ["opening", "evidence", "closing"],
  language: "en",
  slideCount: 3,
  brand: { kind: "default" },
  fonts: { heading: "Arial", body: "Arial" },
  aspectRatio: "16:9",
};
const contentModel = {
  version: 1,
  sources: [{ sourceId: "brief", excerpts: [{ id: "E01", locator: "1", text: "Grounded fact" }] }],
};
const plan = {
  version: 1,
  title: "Plan",
  narrativeThesis: "One story",
  slides: ["opening", "evidence", "closing"].map((storyBeat, index) => ({
    id: `S0${index + 1}`,
    storyBeat,
    thesis: `Thesis ${index + 1}`,
    function: index === 0 ? "cover" : "evidence",
    primaryEvidence: [{ sourceId: "brief", excerptId: "E01" }],
    secondaryEvidence: [],
    visualIntent: index === 0 ? "single_focal" : "hierarchy",
    density: "medium",
    takeaway: `Takeaway ${index + 1}`,
  })),
};
const codes = (report: ReturnType<typeof validateDeckPlan>) => report.findings.map((finding) => finding.code);

describe("DeckPlan quality gate", () => {
  it("passes a grounded plan", () => {
    expect(validateDeckPlan(plan, contract, contentModel, []).status).toBe("pass");
  });

  it("hard-fails primary evidence absent from the ContentModel", () => {
    const missingRef = { ...plan, slides: [{ ...plan.slides[0], primaryEvidence: [{ sourceId: "brief", excerptId: "missing" }] }, ...plan.slides.slice(1)] };
    expect(codes(validateDeckPlan(missingRef, contract, contentModel, []))).toContain("PRIMARY_EVIDENCE_NOT_IN_CONTENT_MODEL");
  });

  it("hard-fails plan slide counts that drift from the contract", () => {
    expect(codes(validateDeckPlan({ ...plan, slides: [...plan.slides, { ...plan.slides[2], id: "S04" }] }, contract, contentModel, []))).toContain("PLAN_SLIDE_COUNT_MISMATCH");
  });

  it("maps judgment codes to closed severity instead of accepting a supplied severity", () => {
    const report = validateDeckPlan(plan, contract, contentModel, [{ slideId: "S02", code: "MULTIPLE_DOMINANT_CLAIMS", severity: "risk", message: "Two claims compete." }]);
    expect(codes(report)).toContain("MULTIPLE_DOMINANT_CLAIMS");
    expect(report.findings.find((finding) => finding.code === "MULTIPLE_DOMINANT_CLAIMS")?.severity).toBe("hard");
  });
});
