import { displayWidth } from "./typography";
import { adaptiveSlideIntentSchema, planAdaptiveSlide, type AdaptiveSlideIntent, type AdaptiveSlidePlan } from "./adaptive-composition";
import type { TemplateComponentsArtifact } from "./template-components";
import type { TemplateDesignSystemArtifact } from "./template-design-system";
import { hasFullSemanticCoverage, resolveSlotContent, resolveSlotAssignments, type TemplatePattern } from "./template-patterns";
import type { SlideSpec } from "./schema";

export type AdaptiveSelectionCandidate = { rank: number; pattern: TemplatePattern };
export type AdaptiveSelectionReasonCode = "semantic_coverage" | "slot_capacity" | "required_cardinality" | "media_capability" | "composition_compatibility" | "no_exact_candidate" | "adaptive_capability";
export type AdaptiveSelectionReason = { code: AdaptiveSelectionReasonCode; patternId?: string; message: string };
export type AdaptiveSelectionResult = {
  slideId: string;
  mode: "exact_clone" | "adaptive_compose" | "unsupported";
  chosen?: { patternId?: string; componentFamily?: "stack" | "two_column" | "metric_row" | "repeated_cards" };
  adaptivePlan?: AdaptiveSlidePlan;
  rejectionReasons: AdaptiveSelectionReason[];
};

export type AdaptiveSelectionInput = {
  templateDigest: string;
  slide: SlideSpec;
  candidates: AdaptiveSelectionCandidate[];
  designSystem: TemplateDesignSystemArtifact;
  components: TemplateComponentsArtifact;
};

function layoutFunction(slide: SlideSpec): string {
  return slide.layout === "title" ? "cover" : slide.layout;
}

function exactCloneReasons(slide: SlideSpec, candidate: AdaptiveSelectionCandidate, components: TemplateComponentsArtifact): AdaptiveSelectionReason[] {
  const pattern = candidate.pattern;
  const reasons: AdaptiveSelectionReason[] = [];
  const reason = (code: AdaptiveSelectionReasonCode, message: string): void => { reasons.push({ code, patternId: pattern.id, message }); };
  if (!hasFullSemanticCoverage(slide, pattern.skeleton.replaceableSlots)) reason("semantic_coverage", `Pattern '${pattern.id}' does not cover the complete '${slide.layout}' payload.`);
  const assignments = resolveSlotAssignments(pattern, slide);
  if (assignments.some((assignment) => !("remove" in assignment) && assignment.slot.maxChars !== undefined && displayWidth(assignment.text) > assignment.slot.maxChars)) reason("slot_capacity", `Pattern '${pattern.id}' has a slot-capacity overflow.`);
  for (const binding of new Set(pattern.skeleton.replaceableSlots.map((slot) => slot.binding).filter((binding) => binding.endsWith("[]")))) {
    const content = resolveSlotContent(slide, binding);
    const slots = pattern.skeleton.replaceableSlots.filter((slot) => slot.binding === binding);
    if (Array.isArray(content) && content.length > slots.length) reason("required_cardinality", `Pattern '${pattern.id}' has ${slots.length} '${binding}' slots for ${content.length} content items.`);
  }
  if (pattern.suitableFor.functions.length > 0 && !pattern.suitableFor.functions.includes(layoutFunction(slide) as typeof pattern.suitableFor.functions[number])) reason("composition_compatibility", `Pattern '${pattern.id}' is not labeled for '${layoutFunction(slide)}'.`);
  if (pattern.suitableFor.compositions.length > 0 && !pattern.suitableFor.compositions.includes(slide.composition)) reason("composition_compatibility", `Pattern '${pattern.id}' is not labeled for composition '${slide.composition}'.`);
  const mediaNeeded = (slide.layout === "title" && Boolean(slide.content.imagePath)) || (slide.layout === "evidence" && Boolean(slide.content.assetPath));
  if (mediaNeeded && !components.components.some((component) => component.kind === "media_frame" && !component.offCanvasHelper && !component.grouped)) reason("media_capability", `Pattern '${pattern.id}' has no template-native media capability for this slide.`);
  return reasons;
}

function statementIntent(slide: SlideSpec): AdaptiveSlideIntent {
  if (slide.layout !== "statement") throw new Error(`Adaptive compose currently supports statement slides only; '${slide.layout}' is outside Goal 6.`);
  const statement = slide as Extract<SlideSpec, { layout: "statement" }>;
  return adaptiveSlideIntentSchema.parse({
    slideId: statement.id,
    family: "stack",
    blocks: [
      { id: "headline", role: "headline", text: statement.headline, priority: 100, emphasis: "primary" },
      { id: "body", role: "body", text: statement.content.body, priority: 60, emphasis: "secondary" },
      ...statement.content.proofs.map((text, index) => ({ id: `proof-${index + 1}`, role: "support", text, priority: 20, emphasis: "supporting" })),
    ],
  });
}

function adaptiveResult(input: AdaptiveSelectionInput, rejectionReasons: AdaptiveSelectionReason[]): AdaptiveSelectionResult {
  if (input.slide.layout !== "statement") return { slideId: input.slide.id, mode: "unsupported", rejectionReasons: [...rejectionReasons, { code: "adaptive_capability", message: `Adaptive compose currently supports statement slides only; '${input.slide.layout}' is outside Goal 6.` }] };
  const capabilities = new Set(input.components.components.filter((component) => !component.offCanvasHelper && !component.grouped).map((component) => component.kind));
  if (!capabilities.has("title_block") || !capabilities.has("body_block")) return { slideId: input.slide.id, mode: "unsupported", rejectionReasons: [...rejectionReasons, { code: "adaptive_capability", message: "Adaptive statement composition requires template-native title_block and body_block capability." }] };
  try {
    const adaptivePlan = planAdaptiveSlide({ templateDigest: input.templateDigest, designSystem: input.designSystem, components: input.components, intent: statementIntent(input.slide) });
    if (adaptivePlan.textAllocation.some((allocation) => allocation.fits === "no")) return { slideId: input.slide.id, mode: "unsupported", rejectionReasons: [...rejectionReasons, { code: "adaptive_capability", message: "Adaptive statement composition cannot fit all text allocations in the available native component placements." }] };
    return { slideId: input.slide.id, mode: "adaptive_compose", chosen: { componentFamily: adaptivePlan.family }, adaptivePlan, rejectionReasons };
  } catch (error) {
    return { slideId: input.slide.id, mode: "unsupported", rejectionReasons: [...rejectionReasons, { code: "adaptive_capability", message: error instanceof Error ? error.message : String(error) }] };
  }
}

export function diagnoseAdaptiveMode(input: AdaptiveSelectionInput): AdaptiveSelectionResult {
  const rejectionReasons: AdaptiveSelectionReason[] = [];
  const ordered = [...input.candidates].sort((left, right) => left.rank - right.rank || left.pattern.id.localeCompare(right.pattern.id));
  if (ordered.length === 0) rejectionReasons.push({ code: "no_exact_candidate", message: `No exact-clone candidate was supplied for slide '${input.slide.id}'.` });
  for (const candidate of ordered) {
    const reasons = exactCloneReasons(input.slide, candidate, input.components);
    if (reasons.length === 0) return { slideId: input.slide.id, mode: "exact_clone", chosen: { patternId: candidate.pattern.id }, rejectionReasons: [] };
    rejectionReasons.push(...reasons);
  }
  return adaptiveResult(input, rejectionReasons);
}

export function selectAdaptiveMode(input: AdaptiveSelectionInput): AdaptiveSelectionResult {
  const result = diagnoseAdaptiveMode(input);
  if (result.mode === "unsupported") throw new Error(`TEMPLATE_COMPOSITION_UNSUPPORTED: slide '${result.slideId}' supports neither exact_clone nor adaptive_compose. ${result.rejectionReasons.map((reason) => reason.message).join(" ")}`);
  return result;
}
