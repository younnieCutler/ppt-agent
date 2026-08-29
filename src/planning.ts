import { contentModelSchema, contractSchema, deckPlanSchema, deckSchema, type ContentModel, type DeckPlan, type SourceRef } from "./schema";
import type { QaFinding } from "./qa";

export const planningFindingSeverity = {
  SLIDE_THESIS_MISSING: "hard",
  PRIMARY_EVIDENCE_MISSING: "hard",
  PRIMARY_EVIDENCE_NOT_IN_CONTENT_MODEL: "hard",
  PLAN_SLIDE_COUNT_MISMATCH: "hard",
  PLAN_STORY_BEAT_DRIFT: "hard",
  MULTIPLE_DOMINANT_CLAIMS: "hard",
  VISUAL_INTENT_MISMATCH: "risk",
  REPEATED_VISUAL_INTENT: "risk",
  DENSITY_STYLE_MISMATCH: "risk",
  WEAK_NARRATIVE_PROGRESSION: "risk",
} as const;

type PlanningFindingCode = keyof typeof planningFindingSeverity;
type PlanningJudgment = { slideId?: string; code: PlanningFindingCode; message: string };
export type PlanningQaReport = { status: "pass" | "review" | "fail"; findings: QaFinding[]; plan: DeckPlan };

function refKey(ref: SourceRef): string {
  return `${ref.sourceId}:${ref.excerptId}`;
}

function knownRefs(contentModel: ContentModel): Set<string> {
  return new Set(contentModel.sources.flatMap((source) => source.excerpts.map((excerpt) => `${source.sourceId}:${excerpt.id}`)));
}

function finding(code: PlanningFindingCode, message: string, slideId?: string): QaFinding {
  return { code, message, slideId, severity: planningFindingSeverity[code] };
}

export function validateDeckPlan(planInput: unknown, contractInput: unknown, contentModelInput: unknown, judgmentInput: unknown): PlanningQaReport {
  const plan = deckPlanSchema.parse(planInput);
  const contract = contractSchema.parse(contractInput);
  const contentModel = contentModelSchema.parse(contentModelInput);
  const findings: QaFinding[] = [];
  const refs = knownRefs(contentModel);
  if (plan.slides.length !== contract.slideCount) findings.push(finding("PLAN_SLIDE_COUNT_MISMATCH", "DeckPlan slide count must equal contract.slideCount."));
  for (const slide of plan.slides) {
    if (!slide.thesis.trim()) findings.push(finding("SLIDE_THESIS_MISSING", "Every slide requires a thesis.", slide.id));
    if (slide.primaryEvidence.length === 0) findings.push(finding("PRIMARY_EVIDENCE_MISSING", "Every slide requires primary evidence.", slide.id));
    if (!contract.storyline.includes(slide.storyBeat)) findings.push(finding("PLAN_STORY_BEAT_DRIFT", `Story beat '${slide.storyBeat}' is absent from the contract storyline.`, slide.id));
    for (const ref of slide.primaryEvidence) {
      if (!refs.has(refKey(ref))) findings.push(finding("PRIMARY_EVIDENCE_NOT_IN_CONTENT_MODEL", `Primary evidence '${refKey(ref)}' is absent from the ContentModel.`, slide.id));
    }
  }
  if (Array.isArray(judgmentInput)) {
    for (const value of judgmentInput) {
      if (!value || typeof value !== "object") continue;
      const judgment = value as Partial<PlanningJudgment>;
      if (typeof judgment.code === "string" && judgment.code in planningFindingSeverity && typeof judgment.message === "string") {
        findings.push(finding(judgment.code as PlanningFindingCode, judgment.message, judgment.slideId));
      }
    }
  }
  return { plan, findings, status: findings.some((item) => item.severity === "hard") ? "fail" : findings.some((item) => item.severity === "risk") ? "review" : "pass" };
}

type CompositionPlan = { slides?: Array<{ id?: string; candidates?: Array<{ layout?: string; composition?: string }> }> };

export function verifyDeckAgainstPlan(deckInput: unknown, planInput: unknown, compositionPlanInput: unknown): QaFinding[] {
  const deck = deckSchema.parse(deckInput);
  const plan = deckPlanSchema.parse(planInput);
  const compositionPlan = compositionPlanInput as CompositionPlan;
  const findings: QaFinding[] = [];
  const candidatesBySlide = new Map((compositionPlan.slides ?? []).map((slide) => [slide.id, slide.candidates ?? []]));
  if (deck.slides.length !== plan.slides.length) return [finding("PLAN_SLIDE_COUNT_MISMATCH", "DeckSpec and DeckPlan slide counts differ.")];
  deck.slides.forEach((slide, index) => {
    const intent = plan.slides[index];
    if (slide.id !== intent.id || slide.storyBeat !== intent.storyBeat || slide.headline !== intent.thesis) {
      findings.push(finding("PLAN_STORY_BEAT_DRIFT", "DeckSpec must preserve the planned id, story beat, and thesis.", slide.id));
    }
    const refs = new Set(slide.sourceRefs.map(refKey));
    const allowed = new Set([...intent.primaryEvidence, ...intent.secondaryEvidence].map(refKey));
    if (intent.primaryEvidence.some((ref) => !refs.has(refKey(ref))) || slide.sourceRefs.some((ref) => !allowed.has(refKey(ref)))) {
      findings.push(finding("PRIMARY_EVIDENCE_MISSING", "DeckSpec source references must include every primary ref and no unplanned ref.", slide.id));
    }
    const candidates = candidatesBySlide.get(slide.id) ?? [];
    if (candidates.length > 0 && !candidates.some((candidate) => candidate.layout === slide.layout && candidate.composition === slide.composition)) {
      findings.push(finding("VISUAL_INTENT_MISMATCH", "DeckSpec layout/composition is outside the resolved shortlist.", slide.id));
    }
  });
  return findings;
}
