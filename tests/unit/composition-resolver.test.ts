import { describe, expect, it } from "vitest";
import { layoutsByFunction, resolveCompositionPlan } from "../../src/planning";

const ref = { sourceId: "brief", excerptId: "E01" };
const plan = {
  version: 1,
  title: "Plan",
  narrativeThesis: "One story",
  slides: [
    { id: "S01", storyBeat: "opening", thesis: "Open", function: "architecture", primaryEvidence: [ref], secondaryEvidence: [], visualIntent: "network", density: "medium", takeaway: "Open" },
    { id: "S02", storyBeat: "evidence", thesis: "Compare", function: "comparison", primaryEvidence: [ref], secondaryEvidence: [], visualIntent: "contrast", density: "medium", takeaway: "Compare" },
    { id: "S03", storyBeat: "closing", thesis: "Act", function: "action", primaryEvidence: [ref], secondaryEvidence: [], visualIntent: "flow", density: "medium", takeaway: "Act" },
  ],
} as const;

describe("semantic composition resolver", () => {
  it("returns byte-identical deterministic shortlists", () => {
    expect(JSON.stringify(resolveCompositionPlan(plan, {}))).toBe(JSON.stringify(resolveCompositionPlan(plan, {})));
  });

  it("never returns a layout outside the function contract", () => {
    const resolved = resolveCompositionPlan(plan, {});
    for (const slide of resolved.slides) {
      const intent = plan.slides.find((item) => item.id === slide.id)!;
      expect(slide.candidates.every((candidate) => (layoutsByFunction[intent.function] as readonly string[]).includes(candidate.layout))).toBe(true);
    }
  });

  it("lets high-confidence organization grammar outrank reference preferences", () => {
    const resolved = resolveCompositionPlan(plan, { referenceCompositionPreferences: ["architecture_zones"] }, {
      compositionPatterns: [{ family: "radial", visualIntents: ["network"], density: "medium", confidence: 0.9 }],
    });
    expect(resolved.slides[0].candidates[0]).toMatchObject({ layout: "architecture", composition: "central_hub" });
  });

  it("avoids three identical recommended families when compatible alternatives exist", () => {
    const actionPlan = { ...plan, slides: plan.slides.map((slide, index) => ({ ...slide, id: `S0${index + 1}`, function: "action" as const, visualIntent: "flow" as const })) };
    const families = resolveCompositionPlan(actionPlan, {}).slides.map((slide) => slide.candidates[0].family);
    expect(new Set(families).size).toBeGreaterThan(1);
  });
});
