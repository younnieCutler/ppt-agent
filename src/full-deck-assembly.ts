import { z } from "zod";
import { deckPlanSchema, deckV2Schema, slideSchema, type DeckPlan, type DeckSpec, type SlideSpec, type SourceRef } from "./schema";
import { pilotSpecArtifactSchema, type PilotSpecArtifact } from "./pilot-authoring";
import type { QaFinding } from "./qa";
import { sha256 } from "./provenance";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const fullSlideInputSchema = z.object({
  version: z.literal(1),
  slide: slideSchema,
}).strict();

export type FullSlideInput = z.infer<typeof fullSlideInputSchema>;

export const fullSlideArtifactSchema = z.object({
  version: z.literal(1),
  deckPlanDigest: digestSchema,
  compositionPlanDigest: digestSchema,
  storylineDigest: digestSchema,
  pilotApprovalDigest: digestSchema,
  slide: slideSchema,
}).strict();

export type FullSlideArtifact = z.infer<typeof fullSlideArtifactSchema>;

type CompositionPlan = {
  slides: Array<{
    id: string;
    candidates: Array<{ layout: string; composition: string; rank?: number; reasons?: string[] }>;
  }>;
};

export const fullDeckAssemblyFindingSeverity = {
  FULL_SLIDE_IS_APPROVED_PILOT: "hard",
  FULL_SLIDE_ID_MISMATCH: "hard",
  FULL_SLIDE_STORY_DRIFT: "hard",
  FULL_SLIDE_PRIMARY_EVIDENCE_MISSING: "hard",
  FULL_SLIDE_UNPLANNED_EVIDENCE: "hard",
  FULL_SLIDE_COMPOSITION_OUTSIDE_SHORTLIST: "hard",
  FULL_SLIDE_PROVENANCE_STALE: "hard",
  FULL_SLIDE_MISSING: "hard",
  FULL_SLIDE_DUPLICATE: "hard",
  FULL_SLIDE_UNEXPECTED: "hard",
  PILOT_SLIDE_NOT_IN_PLAN: "hard",
} as const;

type FullDeckAssemblyFindingCode = keyof typeof fullDeckAssemblyFindingSeverity;

function finding(code: FullDeckAssemblyFindingCode, message: string, slideId?: string): QaFinding {
  return { code, message, slideId, severity: fullDeckAssemblyFindingSeverity[code] };
}

function refKey(ref: SourceRef): string {
  return `${ref.sourceId}:${ref.excerptId}`;
}

export function validateFullSlideInput(
  input: unknown,
  expectedSlideId: string,
  pilotSlideIds: Iterable<string>,
  planInput: unknown,
  compositionPlanInput: unknown,
): { input: FullSlideInput; findings: QaFinding[] } {
  const parsed = fullSlideInputSchema.parse(input);
  const plan = deckPlanSchema.parse(planInput);
  const compositionPlan = compositionPlanInput as CompositionPlan;
  const pilotIds = new Set(pilotSlideIds);
  const findings: QaFinding[] = [];
  const slide = parsed.slide;

  if (pilotIds.has(expectedSlideId) || pilotIds.has(slide.id)) {
    findings.push(finding("FULL_SLIDE_IS_APPROVED_PILOT", `Slide '${slide.id}' is part of the approved pilot and must be reused, never re-authored.`, slide.id));
  }
  if (slide.id !== expectedSlideId) {
    findings.push(finding("FULL_SLIDE_ID_MISMATCH", `Expected slide '${expectedSlideId}' but received '${slide.id}'.`, slide.id));
  }

  const planned = plan.slides.find((candidate) => candidate.id === expectedSlideId);
  if (!planned) {
    findings.push(finding("FULL_SLIDE_ID_MISMATCH", `Slide '${expectedSlideId}' is absent from DeckPlan.`, slide.id));
    return { input: parsed, findings };
  }
  if (slide.storyBeat !== planned.storyBeat || slide.headline !== planned.thesis) {
    findings.push(finding("FULL_SLIDE_STORY_DRIFT", "Full-deck slide must preserve the approved storyBeat and thesis exactly.", slide.id));
  }

  const authoredRefs = new Set(slide.sourceRefs.map(refKey));
  const primary = planned.primaryEvidence.map(refKey);
  const allowed = new Set([...planned.primaryEvidence, ...planned.secondaryEvidence].map(refKey));
  const missingPrimary = primary.filter((key) => !authoredRefs.has(key));
  const unplanned = [...authoredRefs].filter((key) => !allowed.has(key));
  if (missingPrimary.length > 0) {
    findings.push(finding("FULL_SLIDE_PRIMARY_EVIDENCE_MISSING", `Slide is missing primary evidence: ${missingPrimary.join(", ")}.`, slide.id));
  }
  if (unplanned.length > 0) {
    findings.push(finding("FULL_SLIDE_UNPLANNED_EVIDENCE", `Slide introduces unplanned evidence: ${unplanned.join(", ")}.`, slide.id));
  }

  const candidates = compositionPlan.slides.find((candidate) => candidate.id === expectedSlideId)?.candidates ?? [];
  if (!candidates.some((candidate) => candidate.layout === slide.layout && candidate.composition === slide.composition)) {
    findings.push(finding("FULL_SLIDE_COMPOSITION_OUTSIDE_SHORTLIST", `Slide ${slide.layout}/${slide.composition} is outside its resolved composition shortlist.`, slide.id));
  }
  return { input: parsed, findings };
}

export function buildFullSlideArtifact(
  input: FullSlideInput,
  digests: { deckPlanDigest: string; compositionPlanDigest: string; storylineDigest: string; pilotApprovalDigest: string },
): FullSlideArtifact {
  return fullSlideArtifactSchema.parse({ version: 1, ...digests, slide: input.slide });
}

export function fullSlideArtifactDigest(input: unknown): string {
  return sha256(JSON.stringify(fullSlideArtifactSchema.parse(input)));
}

export type FullDeckAssemblyDigests = {
  deckPlanDigest: string;
  compositionPlanDigest: string;
  storylineDigest: string;
  pilotApprovalDigest: string;
};

export type FullDeckAssemblyResult = {
  status: "pass" | "fail";
  findings: QaFinding[];
  deck?: DeckSpec;
  pilotSlidesReused: string[];
  authoredSlides: string[];
};

function artifactSourceIsCurrent(artifact: FullSlideArtifact, digests: FullDeckAssemblyDigests): boolean {
  return artifact.deckPlanDigest === digests.deckPlanDigest
    && artifact.compositionPlanDigest === digests.compositionPlanDigest
    && artifact.storylineDigest === digests.storylineDigest
    && artifact.pilotApprovalDigest === digests.pilotApprovalDigest;
}

export function assembleFullDeck(
  fullContractInput: unknown,
  planInput: unknown,
  compositionPlanInput: unknown,
  pilotSpecInput: unknown,
  artifactInputs: unknown[],
  digests: FullDeckAssemblyDigests,
): FullDeckAssemblyResult {
  const plan: DeckPlan = deckPlanSchema.parse(planInput);
  const pilot: PilotSpecArtifact = pilotSpecArtifactSchema.parse(pilotSpecInput);
  const artifacts = artifactInputs.map((input) => fullSlideArtifactSchema.parse(input));
  const findings: QaFinding[] = [];
  const planIds = new Set(plan.slides.map((slide) => slide.id));
  const pilotIds = new Set<string>();

  for (const slide of pilot.slides) {
    if (!planIds.has(slide.id)) findings.push(finding("PILOT_SLIDE_NOT_IN_PLAN", `Approved pilot slide '${slide.id}' is absent from the current DeckPlan.`, slide.id));
    pilotIds.add(slide.id);
  }

  const artifactsById = new Map<string, FullSlideArtifact>();
  for (const artifact of artifacts) {
    const id = artifact.slide.id;
    if (artifactsById.has(id)) {
      findings.push(finding("FULL_SLIDE_DUPLICATE", `Multiple full-slide artifacts were supplied for '${id}'.`, id));
      continue;
    }
    artifactsById.set(id, artifact);
    if (pilotIds.has(id)) findings.push(finding("FULL_SLIDE_IS_APPROVED_PILOT", `Artifact '${id}' attempts to replace an approved pilot slide.`, id));
    if (!planIds.has(id)) findings.push(finding("FULL_SLIDE_UNEXPECTED", `Artifact '${id}' is not present in the current DeckPlan.`, id));
    if (!artifactSourceIsCurrent(artifact, digests)) findings.push(finding("FULL_SLIDE_PROVENANCE_STALE", `Artifact '${id}' was authored against stale planning or pilot approval inputs.`, id));
  }

  const expectedAuthoredIds = plan.slides.map((slide) => slide.id).filter((id) => !pilotIds.has(id));
  for (const id of expectedAuthoredIds) {
    const artifact = artifactsById.get(id);
    if (!artifact) {
      findings.push(finding("FULL_SLIDE_MISSING", `No validated full-slide artifact exists for '${id}'.`, id));
      continue;
    }
    const validated = validateFullSlideInput({ version: 1, slide: artifact.slide }, id, pilotIds, plan, compositionPlanInput);
    findings.push(...validated.findings);
  }

  if (findings.length > 0) {
    return { status: "fail", findings, pilotSlidesReused: [...pilotIds], authoredSlides: expectedAuthoredIds.filter((id) => artifactsById.has(id)) };
  }

  const pilotById = new Map(pilot.slides.map((slide) => [slide.id, slide]));
  const slides: SlideSpec[] = plan.slides.map((planned) => {
    const pilotSlide = pilotById.get(planned.id);
    if (pilotSlide) return pilotSlide;
    return artifactsById.get(planned.id)!.slide;
  });
  const deck = deckV2Schema.parse({
    version: 2,
    planDigest: digests.deckPlanDigest,
    contract: fullContractInput,
    title: plan.title,
    slides,
  });
  return { status: "pass", findings: [], deck, pilotSlidesReused: [...pilotIds], authoredSlides: expectedAuthoredIds };
}

export function fullDeckDigest(input: unknown): string {
  return sha256(JSON.stringify(deckV2Schema.parse(input)));
}
