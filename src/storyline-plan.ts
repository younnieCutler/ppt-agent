import { deckPlanSchema, type SourceRef } from "./schema";
import { storylineBlueprintSchema } from "./storyline";
import type { QaFinding } from "./qa";

export const storylinePlanFindingSeverity = {
  STORYLINE_PLAN_SLIDE_COUNT_MISMATCH: "hard",
  STORYLINE_PLAN_ORDER_DRIFT: "hard",
  STORYLINE_PLAN_STORY_BEAT_DRIFT: "hard",
  STORYLINE_PLAN_ASSERTION_DRIFT: "hard",
  STORYLINE_PLAN_EVIDENCE_DRIFT: "hard",
} as const;

type StorylinePlanFindingCode = keyof typeof storylinePlanFindingSeverity;

function finding(code: StorylinePlanFindingCode, message: string, slideId?: string): QaFinding {
  return { code, message, slideId, severity: storylinePlanFindingSeverity[code] };
}

function refKey(ref: SourceRef): string {
  return `${ref.sourceId}:${ref.excerptId}`;
}

/**
 * Verifies that DeckPlan is a projection of the approved StorylineBlueprint rather than a second
 * opportunity to rewrite the argument. Composition metadata may be added, but slide identity,
 * story beat, assertion and evidence remain locked.
 */
export function verifyDeckPlanAgainstStoryline(planInput: unknown, storylineInput: unknown): QaFinding[] {
  const plan = deckPlanSchema.parse(planInput);
  const storyline = storylineBlueprintSchema.parse(storylineInput);
  const findings: QaFinding[] = [];

  if (plan.slides.length !== storyline.slides.length) {
    findings.push(finding("STORYLINE_PLAN_SLIDE_COUNT_MISMATCH", "DeckPlan and StorylineBlueprint slide counts differ."));
    return findings;
  }

  plan.slides.forEach((slide, index) => {
    const source = storyline.slides[index];
    if (slide.id !== source.id) {
      findings.push(finding("STORYLINE_PLAN_ORDER_DRIFT", `DeckPlan slide '${slide.id}' does not match storyline position ${index + 1} ('${source.id}').`, slide.id));
      return;
    }
    if (slide.storyBeat !== source.storyBeat) {
      findings.push(finding("STORYLINE_PLAN_STORY_BEAT_DRIFT", `DeckPlan storyBeat '${slide.storyBeat}' does not match storyline '${source.storyBeat}'.`, slide.id));
    }
    if (slide.thesis !== source.assertion) {
      findings.push(finding("STORYLINE_PLAN_ASSERTION_DRIFT", "DeckPlan thesis must preserve the approved storyline assertion exactly.", slide.id));
    }

    const planned = new Set([...slide.primaryEvidence, ...slide.secondaryEvidence].map(refKey));
    const approved = new Set(source.evidenceRefs.map(refKey));
    const missing = [...approved].filter((key) => !planned.has(key));
    const invented = [...planned].filter((key) => !approved.has(key));
    if (missing.length > 0 || invented.length > 0) {
      findings.push(finding(
        "STORYLINE_PLAN_EVIDENCE_DRIFT",
        `DeckPlan evidence must exactly preserve storyline evidence (missing: ${missing.join(", ") || "none"}; unapproved: ${invented.join(", ") || "none"}).`,
        slide.id,
      ));
    }
  });

  return findings;
}
