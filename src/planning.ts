import { allowedCompositions, compositionFamily, contentModelSchema, contractSchema, deckPlanSchema, deckSchema, type CompositionFamily, type ContentModel, type DeckPlan, type PlanVisualIntent, type SlideFunction, type SlideSpec, type SourceRef } from "./schema";
import type { QaFinding } from "./qa";
import { sha256 } from "./provenance";

export const planningFindingSeverity = {
  SLIDE_THESIS_MISSING: "hard",
  PRIMARY_EVIDENCE_MISSING: "hard",
  PRIMARY_EVIDENCE_NOT_IN_CONTENT_MODEL: "hard",
  SECONDARY_EVIDENCE_NOT_IN_CONTENT_MODEL: "hard",
  DECK_PLAN_DIGEST_MISMATCH: "hard",
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

/**
 * The one definition of a DeckPlan's digest. It hashes the *normalized* plan — the schema's own
 * output — so a plan that is re-serialized, re-indented, or key-reordered still digests the same,
 * and every producer and verifier agrees without re-implementing the algorithm.
 */
export function deckPlanDigest(planInput: unknown): string {
  return sha256(JSON.stringify(deckPlanSchema.parse(planInput)));
}

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
    // Authoring contexts hand a worker both evidence sets, so an unresolvable secondary ref is a
    // dangling reference the worker would be asked to cite. Its own code keeps the diagnosis clear.
    for (const ref of slide.secondaryEvidence) {
      if (!refs.has(refKey(ref))) findings.push(finding("SECONDARY_EVIDENCE_NOT_IN_CONTENT_MODEL", `Secondary evidence '${refKey(ref)}' is absent from the ContentModel.`, slide.id));
    }
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
  // Planning is a strict gate on purpose: `composition-resolve` requires `pass`, so a risk finding
  // blocks authoring until it is resolved or the plan is changed. A risk here is not "ship with a
  // caveat" — it is a plan the shortlist would be resolved against, and every slide inherits it.
  return { plan, findings, status: findings.some((item) => item.severity === "hard") ? "fail" : findings.some((item) => item.severity === "risk") ? "review" : "pass" };
}

type CompositionPlanInput = { slides?: Array<{ id?: string; candidates?: Array<{ layout?: string; composition?: string }> }> };

export function verifyDeckAgainstPlan(deckInput: unknown, planInput: unknown, compositionPlanInput: unknown): QaFinding[] {
  const deck = deckSchema.parse(deckInput);
  const plan = deckPlanSchema.parse(planInput);
  const compositionPlan = compositionPlanInput as CompositionPlanInput;
  const findings: QaFinding[] = [];
  const candidatesBySlide = new Map((compositionPlan.slides ?? []).map((slide) => [slide.id, slide.candidates ?? []]));
  // A digest that is only checked for shape proves nothing: it has to be the digest of the plan the
  // deck is being verified against, or a DeckSpec can carry any 64-character string and pass.
  const declared = deckInput as { version?: unknown; planDigest?: unknown };
  if (declared.version === 2 && declared.planDigest !== deckPlanDigest(plan)) {
    findings.push(finding("DECK_PLAN_DIGEST_MISMATCH", "DeckSpec v2 planDigest does not match the digest of deck-plan.json. Re-author the DeckSpec against the current plan."));
  }
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

export const layoutsByFunction: Record<SlideFunction, SlideSpec["layout"][]> = {
  cover: ["title"],
  statement: ["statement"],
  comparison: ["comparison"],
  process: ["process", "pipeline"],
  architecture: ["architecture", "pipeline"],
  quantitative: ["quantitative", "chart"],
  timeline: ["timeline"],
  evidence: ["evidence", "chart"],
  action: ["statement", "process", "timeline"],
};

export type CompositionCatalogEntry = {
  layout: SlideSpec["layout"];
  composition: string;
  family: CompositionFamily;
  visualIntents: PlanVisualIntent[];
  densities: Array<"low" | "medium" | "high">;
};

const compositionProfiles: Record<string, Pick<CompositionCatalogEntry, "visualIntents" | "densities">> = {
  cover: { visualIntents: ["single_focal"], densities: ["low", "medium"] },
  hero_evidence: { visualIntents: ["single_focal", "hierarchy"], densities: ["low", "medium"] },
  claim_actions: { visualIntents: ["hierarchy", "flow"], densities: ["medium"] },
  two_column: { visualIntents: ["contrast"], densities: ["medium", "high"] },
  diagnosis_matrix: { visualIntents: ["contrast", "hierarchy"], densities: ["medium", "high"] },
  ownership_split: { visualIntents: ["contrast"], densities: ["medium"] },
  verdict_contrast: { visualIntents: ["contrast"], densities: ["low", "medium"] },
  sequence: { visualIntents: ["flow", "timeline"], densities: ["low", "medium"] },
  stage_gate: { visualIntents: ["flow"], densities: ["medium", "high"] },
  pipeline_lanes: { visualIntents: ["flow", "hierarchy"], densities: ["medium", "high"] },
  architecture_zones: { visualIntents: ["hierarchy", "network"], densities: ["medium", "high"] },
  central_hub: { visualIntents: ["network", "hierarchy"], densities: ["medium"] },
  layered_stack: { visualIntents: ["hierarchy"], densities: ["medium", "high"] },
  kpi_row: { visualIntents: ["single_focal", "contrast"], densities: ["low", "medium"] },
  ranked_bars: { visualIntents: ["trend", "contrast"], densities: ["medium", "high"] },
  metric_story: { visualIntents: ["single_focal", "hierarchy"], densities: ["low", "medium"] },
  gauge_row: { visualIntents: ["contrast"], densities: ["low", "medium"] },
  sparkline_row: { visualIntents: ["trend"], densities: ["medium", "high"] },
  linear_roadmap: { visualIntents: ["timeline", "flow"], densities: ["low", "medium"] },
  now_next_later: { visualIntents: ["timeline", "hierarchy"], densities: ["medium"] },
  evidence_list: { visualIntents: ["hierarchy"], densities: ["medium", "high"] },
  evidence_panel: { visualIntents: ["hierarchy", "single_focal"], densities: ["low", "medium"] },
  native_chart: { visualIntents: ["trend", "contrast"], densities: ["medium", "high"] },
};

export const compositionCatalog: CompositionCatalogEntry[] = Object.entries(allowedCompositions).flatMap(([layout, compositions]) => compositions.map((composition) => ({
  layout: layout as SlideSpec["layout"],
  composition,
  family: compositionFamily[composition],
  ...compositionProfiles[composition],
}))).sort((left, right) => `${left.layout}:${left.composition}`.localeCompare(`${right.layout}:${right.composition}`));

export type CompositionCandidate = Pick<CompositionCatalogEntry, "layout" | "composition" | "family"> & { rank: 1 | 2 | 3; reasons: string[] };
export type CompositionPlan = { version: 1; slides: Array<{ id: string; candidates: CompositionCandidate[] }> };
type StyleResolverContext = { referenceCompositionPreferences?: string[]; archetypeCompositionPreferences?: string[] };
type TemplateGrammarContext = { compositionPatterns?: Array<{ family: CompositionFamily; visualIntents: PlanVisualIntent[]; density: "low" | "medium" | "high"; confidence: number }> };

function grammarConfidence(entry: CompositionCatalogEntry, intent: DeckPlan["slides"][number], grammar: TemplateGrammarContext): number {
  return Math.max(0, ...(grammar.compositionPatterns ?? [])
    .filter((pattern) => pattern.family === entry.family && pattern.visualIntents.includes(intent.visualIntent) && pattern.density === intent.density)
    .map((pattern) => pattern.confidence));
}

export function resolveCompositionPlan(planInput: unknown, styleInput: StyleResolverContext, grammarInput: TemplateGrammarContext = {}): CompositionPlan {
  const plan = deckPlanSchema.parse(planInput);
  const style = styleInput ?? {};
  const grammar = grammarInput ?? {};
  const recommendedFamilies: CompositionFamily[] = [];
  return {
    version: 1,
    slides: plan.slides.map((intent) => {
      const candidates = compositionCatalog
        .filter((entry) => layoutsByFunction[intent.function].includes(entry.layout))
        .map((entry) => ({
          entry,
          template: grammarConfidence(entry, intent, grammar),
          reference: style.referenceCompositionPreferences?.includes(entry.composition) ? 1 : 0,
          visual: entry.visualIntents.includes(intent.visualIntent) ? 1 : 0,
          density: entry.densities.includes(intent.density) ? 1 : 0,
          rhythm: recommendedFamilies.includes(entry.family) ? 0 : 1,
          archetype: style.archetypeCompositionPreferences?.includes(entry.composition) ? 1 : 0,
        }))
        .sort((left, right) => right.template - left.template
          || right.reference - left.reference
          || right.visual - left.visual
          || right.density - left.density
          || right.rhythm - left.rhythm
          || right.archetype - left.archetype
          || `${left.entry.layout}:${left.entry.composition}`.localeCompare(`${right.entry.layout}:${right.entry.composition}`))
        .slice(0, 3)
        .map(({ entry, template, reference, visual, density, rhythm, archetype }, index) => ({
          layout: entry.layout,
          composition: entry.composition,
          family: entry.family,
          rank: (index + 1) as 1 | 2 | 3,
          reasons: [template ? "template grammar" : "", reference ? "reference preference" : "", visual ? "visual intent" : "", density ? "density" : "", rhythm ? "deck rhythm" : "", archetype ? "archetype preference" : ""].filter(Boolean),
        }));
      recommendedFamilies.push(candidates[0].family);
      if (recommendedFamilies.length > 2) recommendedFamilies.shift();
      return { id: intent.id, candidates };
    }),
  };
}
