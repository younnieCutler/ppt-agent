import { z } from "zod";
import { deckPlanSchema, deckSchema, slideSchema, type DeckPlan, type DeckSpec, type SlideSpec, type SourceRef } from "./schema";
import type { QaFinding } from "./qa";
import { sha256 } from "./provenance";

export const pilotSlidesInputSchema = z.object({
  version: z.literal(1),
  slides: z.array(slideSchema).min(3).max(5),
}).strict();

export type PilotSlidesInput = z.infer<typeof pilotSlidesInputSchema>;

export const pilotSpecArtifactSchema = z.object({
  version: z.literal(1),
  selectionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  deckPlanDigest: z.string().regex(/^[a-f0-9]{64}$/),
  compositionPlanDigest: z.string().regex(/^[a-f0-9]{64}$/),
  slides: z.array(slideSchema).min(3).max(5),
}).strict();

export type PilotSpecArtifact = z.infer<typeof pilotSpecArtifactSchema>;

export const pilotAuthoringFindingSeverity = {
  PILOT_SELECTION_MISMATCH: "hard",
  PILOT_STORY_DRIFT: "hard",
  PILOT_PRIMARY_EVIDENCE_MISSING: "hard",
  PILOT_UNPLANNED_EVIDENCE: "hard",
  PILOT_COMPOSITION_OUTSIDE_SHORTLIST: "hard",
} as const;

type PilotAuthoringFindingCode = keyof typeof pilotAuthoringFindingSeverity;

export type PilotAuthoringQa = {
  status: "pass" | "fail";
  findings: QaFinding[];
};

type PilotSelection = { slideIds: string[] };
type CompositionPlan = { slides: Array<{ id: string; candidates: Array<{ layout: string; composition: string; rank?: number; reasons?: string[] }> }> };

type PilotAuthoringContext = {
  version: 1;
  kind: "pilot_authoring";
  story: unknown;
  style: unknown;
  composition: Array<{ id: string; candidates: CompositionPlan["slides"][number]["candidates"] }>;
};

function finding(code: PilotAuthoringFindingCode, message: string, slideId?: string): QaFinding {
  return { code, message, slideId, severity: pilotAuthoringFindingSeverity[code] };
}

function refKey(ref: SourceRef): string {
  return `${ref.sourceId}:${ref.excerptId}`;
}

export function buildPilotAuthoringContext(
  pilotStoryContext: unknown,
  styleContext: unknown,
  compositionPlanInput: unknown,
  selection: PilotSelection,
): PilotAuthoringContext {
  const compositionPlan = compositionPlanInput as CompositionPlan;
  const byId = new Map(compositionPlan.slides.map((slide) => [slide.id, slide]));
  return {
    version: 1,
    kind: "pilot_authoring",
    story: pilotStoryContext,
    style: styleContext,
    composition: selection.slideIds.map((id) => {
      const entry = byId.get(id);
      if (!entry) throw new Error(`Pilot authoring context is missing composition candidates for '${id}'.`);
      return { id, candidates: entry.candidates };
    }),
  };
}

export function buildSingleSlideAuthoringContext(
  slideStoryContext: unknown,
  styleContext: unknown,
  compositionPlanInput: unknown,
  slideId: string,
): PilotAuthoringContext {
  return buildPilotAuthoringContext(slideStoryContext, styleContext, compositionPlanInput, { slideIds: [slideId] });
}

export function validatePilotSlides(
  input: unknown,
  selection: PilotSelection,
  planInput: unknown,
  compositionPlanInput: unknown,
): { input: PilotSlidesInput; qa: PilotAuthoringQa } {
  const parsed = pilotSlidesInputSchema.parse(input);
  const plan = deckPlanSchema.parse(planInput);
  const compositionPlan = compositionPlanInput as CompositionPlan;
  const planById = new Map(plan.slides.map((slide) => [slide.id, slide]));
  const compositionById = new Map(compositionPlan.slides.map((slide) => [slide.id, slide.candidates]));
  const findings: QaFinding[] = [];

  const authoredIds = parsed.slides.map((slide) => slide.id);
  if (JSON.stringify(authoredIds) !== JSON.stringify(selection.slideIds)) {
    findings.push(finding("PILOT_SELECTION_MISMATCH", `Pilot slides must match selection exactly and in order (expected ${selection.slideIds.join(", ")}; received ${authoredIds.join(", ")}).`));
  }

  for (const slide of parsed.slides) {
    const planned = planById.get(slide.id);
    if (!planned) {
      findings.push(finding("PILOT_SELECTION_MISMATCH", `Pilot slide '${slide.id}' is absent from DeckPlan.`, slide.id));
      continue;
    }
    if (slide.storyBeat !== planned.storyBeat || slide.headline !== planned.thesis) {
      findings.push(finding("PILOT_STORY_DRIFT", "Pilot slide must preserve planned storyBeat and thesis exactly.", slide.id));
    }

    const authoredRefs = new Set(slide.sourceRefs.map(refKey));
    const primary = planned.primaryEvidence.map(refKey);
    const allowed = new Set([...planned.primaryEvidence, ...planned.secondaryEvidence].map(refKey));
    const missingPrimary = primary.filter((key) => !authoredRefs.has(key));
    const unplanned = [...authoredRefs].filter((key) => !allowed.has(key));
    if (missingPrimary.length > 0) {
      findings.push(finding("PILOT_PRIMARY_EVIDENCE_MISSING", `Pilot slide is missing primary evidence: ${missingPrimary.join(", ")}.`, slide.id));
    }
    if (unplanned.length > 0) {
      findings.push(finding("PILOT_UNPLANNED_EVIDENCE", `Pilot slide introduces unplanned evidence: ${unplanned.join(", ")}.`, slide.id));
    }

    const candidates = compositionById.get(slide.id) ?? [];
    if (!candidates.some((candidate) => candidate.layout === slide.layout && candidate.composition === slide.composition)) {
      findings.push(finding("PILOT_COMPOSITION_OUTSIDE_SHORTLIST", `Pilot slide ${slide.layout}/${slide.composition} is outside its resolved composition shortlist.`, slide.id));
    }
  }

  return { input: parsed, qa: { status: findings.length === 0 ? "pass" : "fail", findings } };
}

export function buildPilotSpecArtifact(
  slides: PilotSlidesInput,
  digests: { selectionDigest: string; deckPlanDigest: string; compositionPlanDigest: string },
): PilotSpecArtifact {
  return pilotSpecArtifactSchema.parse({ version: 1, ...digests, slides: slides.slides });
}

/**
 * A pilot render envelope is a normal DeckSpec only so the existing render/Core QA/template
 * runtimes can be reused unchanged. It is not a release artifact: the original contract is copied
 * with slideCount reduced to the selected pilot size, while slide ids and all authored content stay
 * untouched. The original full-deck contract remains authoritative in the parent run directory.
 */
export function buildPilotDeckEnvelope(fullContractInput: unknown, title: string, pilot: PilotSpecArtifact): DeckSpec {
  const contract = { ...(fullContractInput as Record<string, unknown>), slideCount: pilot.slides.length };
  return deckSchema.parse({ contract, title: `[PILOT] ${title}`, slides: pilot.slides });
}

export function pilotSpecDigest(input: unknown): string {
  return sha256(JSON.stringify(pilotSpecArtifactSchema.parse(input)));
}

export function pilotEnvelopeDigest(input: unknown): string {
  return sha256(JSON.stringify(deckSchema.parse(input)));
}
