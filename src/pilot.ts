import { deckPlanSchema, type DeckPlan } from "./schema";

export type PilotSelection = {
  version: 1;
  strategy: "representative_v1";
  slideIds: string[];
  reasons: Record<string, string[]>;
};

type SlideIntent = DeckPlan["slides"][number];

const densityWeight: Record<SlideIntent["density"], number> = { low: 1, medium: 2, high: 3 };

function evidenceCount(slide: SlideIntent): number {
  return slide.primaryEvidence.length + slide.secondaryEvidence.length;
}

function challengeScore(slide: SlideIntent): number {
  return densityWeight[slide.density] * 10 + evidenceCount(slide);
}

function noveltyScore(slide: SlideIntent, selected: SlideIntent[]): number {
  const functions = new Set(selected.map((item) => item.function));
  const visualIntents = new Set(selected.map((item) => item.visualIntent));
  const beats = new Set(selected.map((item) => item.storyBeat));
  return (functions.has(slide.function) ? 0 : 40)
    + (visualIntents.has(slide.visualIntent) ? 0 : 30)
    + (beats.has(slide.storyBeat) ? 0 : 20)
    + densityWeight[slide.density] * 3
    + Math.min(5, evidenceCount(slide));
}

/**
 * Picks a small, representative pilot without an LLM call.
 *
 * 1) opening/cover anchors the deck's identity;
 * 2) the densest/evidence-heaviest remaining slide stress-tests the system;
 * 3) the most structurally novel remaining slide checks visual/narrative range.
 *
 * Ties preserve deck order so the same DeckPlan always yields the same pilot.
 */
export function selectPilotSlides(planInput: unknown, requestedCount = 3): PilotSelection {
  const plan = deckPlanSchema.parse(planInput);
  const count = Math.max(1, Math.min(requestedCount, plan.slides.length));
  const selected: SlideIntent[] = [];
  const reasons: Record<string, string[]> = {};

  const anchor = plan.slides.find((slide) => slide.function === "cover")
    ?? plan.slides.find((slide) => slide.storyBeat === "opening")
    ?? plan.slides[0];
  selected.push(anchor);
  reasons[anchor.id] = ["deck anchor"];

  if (selected.length < count) {
    const remaining = plan.slides.filter((slide) => !selected.some((item) => item.id === slide.id));
    const hardest = remaining.reduce((best, slide) => challengeScore(slide) > challengeScore(best) ? slide : best, remaining[0]);
    selected.push(hardest);
    reasons[hardest.id] = ["highest authoring challenge", `density:${hardest.density}`, `evidence:${evidenceCount(hardest)}`];
  }

  while (selected.length < count) {
    const remaining = plan.slides.filter((slide) => !selected.some((item) => item.id === slide.id));
    const novel = remaining.reduce((best, slide) => noveltyScore(slide, selected) > noveltyScore(best, selected) ? slide : best, remaining[0]);
    selected.push(novel);
    reasons[novel.id] = ["maximizes pilot diversity", `function:${novel.function}`, `visual:${novel.visualIntent}`];
  }

  return { version: 1, strategy: "representative_v1", slideIds: selected.map((slide) => slide.id), reasons };
}
