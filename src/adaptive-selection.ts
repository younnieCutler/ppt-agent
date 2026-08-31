import { displayWidth } from "./typography";
import { adaptiveSlideIntentSchema, planAdaptiveSlide, type AdaptiveSlideIntent, type AdaptiveSlidePlan } from "./adaptive-composition";
import type { TemplateComponentsArtifact } from "./template-components";
import type { TemplateDesignSystemArtifact } from "./template-design-system";
import { hasFullSemanticCoverage, resolveSlotContent, resolveSlotAssignments, type TemplatePattern } from "./template-patterns";
import type { SlideSpec } from "./schema";

export type AdaptiveSelectionCandidate = { rank: number; pattern: TemplatePattern };
export type AdaptiveSelectionReasonCode = "semantic_coverage" | "slot_capacity" | "required_cardinality" | "media_capability" | "composition_compatibility" | "no_exact_candidate" | "adaptive_capability";
export type AdaptiveSelectionReason = { code: AdaptiveSelectionReasonCode; patternId?: string; message: string };
export type AdaptiveSelectionContent =
  | { layout: "title"; content: Extract<SlideSpec, { layout: "title" }>["content"] }
  | { layout: "comparison"; content: Extract<SlideSpec, { layout: "comparison" }>["content"] }
  | { layout: "quantitative"; content: Extract<SlideSpec, { layout: "quantitative" }>["content"] }
  | { layout: "process"; content: Extract<SlideSpec, { layout: "process" }>["content"] }
  | { layout: "timeline"; content: Extract<SlideSpec, { layout: "timeline" }>["content"] }
  | { layout: "evidence"; content: Extract<SlideSpec, { layout: "evidence" }>["content"] };
export type AdaptiveSelectionResult = {
  slideId: string;
  mode: "exact_clone" | "adaptive_compose" | "unsupported";
  chosen?: { patternId?: string; componentFamily?: "stack" | "two_column" | "metric_row" | "repeated_cards" };
  adaptivePlan?: AdaptiveSlidePlan;
  adaptiveContent?: AdaptiveSelectionContent;
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

function comparisonIntent(slide: Extract<SlideSpec, { layout: "comparison" }>): AdaptiveSlideIntent {
  const blocks: AdaptiveSlideIntent["blocks"] = [
    { id: "left-label", role: "support", text: slide.content.left.label, group: "left", priority: 80, emphasis: "secondary" },
    ...slide.content.left.items.map((text, index) => ({ id: `left-item-${index + 1}`, role: "item" as const, text, group: "left", priority: 50, emphasis: "supporting" as const })),
    { id: "right-label", role: "support", text: slide.content.right.label, group: "right", priority: 80, emphasis: "secondary" },
    ...slide.content.right.items.map((text, index) => ({ id: `right-item-${index + 1}`, role: "item" as const, text, group: "right", priority: 50, emphasis: "supporting" as const })),
  ];
  if (slide.content.delta) blocks.push({ id: "delta", role: "support", text: slide.content.delta, group: "right", priority: 90, emphasis: "primary", preferredComponentKind: "key_message" });
  return adaptiveSlideIntentSchema.parse({ slideId: slide.id, family: "two_column", blocks });
}

function metricText(metric: Extract<SlideSpec, { layout: "quantitative" }>["content"]["metrics"][number]): string {
  return [
    `${metric.label}: ${metric.value}${metric.unit}`,
    metric.period,
    metric.comparisonBasis ? `vs ${metric.comparisonBasis}` : undefined,
    metric.note,
  ].filter((part): part is string => Boolean(part)).join(" · ");
}

function quantitativeIntent(slide: Extract<SlideSpec, { layout: "quantitative" }>): AdaptiveSlideIntent {
  return adaptiveSlideIntentSchema.parse({
    slideId: slide.id,
    family: "metric_row",
    blocks: slide.content.metrics.map((metric, index) => ({ id: `metric-${index + 1}`, role: "metric", text: metricText(metric), priority: index === 0 ? 100 : 50, emphasis: index === 0 ? "primary" : "supporting" })),
  });
}

function joinedText(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

function processIntent(slide: Extract<SlideSpec, { layout: "process" }>): AdaptiveSlideIntent {
  return adaptiveSlideIntentSchema.parse({
    slideId: slide.id,
    family: "repeated_cards",
    blocks: slide.content.steps.map((step, index) => ({
      id: `step-${step.id}`,
      role: "item",
      text: joinedText([step.label, step.detail, step.members?.length ? `members: ${step.members.join(", ")}` : undefined]),
      priority: index === 0 ? 80 : 50,
      emphasis: index === 0 ? "primary" : "supporting",
      preferredComponentKind: "list_item",
    })),
  });
}

function timelineIntent(slide: Extract<SlideSpec, { layout: "timeline" }>): AdaptiveSlideIntent {
  return adaptiveSlideIntentSchema.parse({
    slideId: slide.id,
    family: "repeated_cards",
    blocks: slide.content.milestones.map((milestone, index) => ({
      id: `milestone-${index + 1}`,
      role: "item",
      text: joinedText([milestone.date, milestone.label, milestone.detail]),
      priority: index === 0 ? 80 : 50,
      emphasis: index === 0 ? "primary" : "supporting",
      preferredComponentKind: "list_item",
    })),
  });
}

function evidenceIntent(slide: Extract<SlideSpec, { layout: "evidence" }>): AdaptiveSlideIntent {
  const blocks: AdaptiveSlideIntent["blocks"] = [];
  if (slide.content.caption) blocks.push({ id: "caption", role: "support", text: slide.content.caption, priority: 80, emphasis: "secondary", preferredComponentKind: "label" });
  blocks.push(...slide.content.bullets.map((text, index) => ({ id: `bullet-${index + 1}`, role: "item" as const, text, priority: 50, emphasis: "supporting" as const })));
  return adaptiveSlideIntentSchema.parse({ slideId: slide.id, family: "stack", blocks, ...(slide.content.assetPath ? { mediaPath: slide.content.assetPath } : {}) });
}

function titleIntent(slide: Extract<SlideSpec, { layout: "title" }>): AdaptiveSlideIntent {
  const blocks: AdaptiveSlideIntent["blocks"] = [{ id: "headline", role: "headline", text: slide.headline, priority: 100, emphasis: "primary" }];
  if (slide.content.kicker) blocks.push({ id: "kicker", role: "support", text: slide.content.kicker, priority: 90, emphasis: "secondary", preferredComponentKind: "label" });
  if (slide.content.subtitle) blocks.push({ id: "subtitle", role: "body", text: slide.content.subtitle, priority: 70, emphasis: "secondary" });
  return adaptiveSlideIntentSchema.parse({ slideId: slide.id, family: "stack", blocks, ...(slide.content.imagePath ? { mediaPath: slide.content.imagePath } : {}) });
}

function adaptiveResult(input: AdaptiveSelectionInput, rejectionReasons: AdaptiveSelectionReason[]): AdaptiveSelectionResult {
  const usable = input.components.components.filter((component) => !component.offCanvasHelper && !component.grouped && component.kind !== "unknown");
  let intent: AdaptiveSlideIntent;
  let adaptiveContent: AdaptiveSelectionContent | undefined;
  if (input.slide.layout === "statement") {
    const capabilities = new Set(usable.map((component) => component.kind));
    if (!capabilities.has("title_block") || !capabilities.has("body_block")) return { slideId: input.slide.id, mode: "unsupported", rejectionReasons: [...rejectionReasons, { code: "adaptive_capability", message: "Adaptive statement composition requires template-native title_block and body_block capability." }] };
    intent = statementIntent(input.slide);
  } else if (input.slide.layout === "comparison") {
    if (!usable.some((component) => component.kind === "card" || component.kind === "surface")) return { slideId: input.slide.id, mode: "unsupported", rejectionReasons: [...rejectionReasons, { code: "adaptive_capability", message: "Adaptive comparison composition requires a template-native card or surface component." }] };
    intent = comparisonIntent(input.slide);
    adaptiveContent = { layout: "comparison", content: input.slide.content };
  } else if (input.slide.layout === "quantitative") {
    if (!usable.some((component) => component.kind === "metric")) return { slideId: input.slide.id, mode: "unsupported", rejectionReasons: [...rejectionReasons, { code: "adaptive_capability", message: "Adaptive quantitative composition requires a template-native metric component." }] };
    intent = quantitativeIntent(input.slide);
    adaptiveContent = { layout: "quantitative", content: input.slide.content };
  } else if (input.slide.layout === "process") {
    if (!usable.some((component) => ["list_item", "body_block", "label"].includes(component.kind))) return { slideId: input.slide.id, mode: "unsupported", rejectionReasons: [...rejectionReasons, { code: "adaptive_capability", message: "Adaptive process composition requires a template-native step or text component." }] };
    intent = processIntent(input.slide);
    adaptiveContent = { layout: "process", content: input.slide.content };
  } else if (input.slide.layout === "timeline") {
    if (!usable.some((component) => ["list_item", "body_block", "label"].includes(component.kind))) return { slideId: input.slide.id, mode: "unsupported", rejectionReasons: [...rejectionReasons, { code: "adaptive_capability", message: "Adaptive timeline composition requires a template-native step or label component." }] };
    intent = timelineIntent(input.slide);
    adaptiveContent = { layout: "timeline", content: input.slide.content };
  } else if (input.slide.layout === "evidence") {
    intent = evidenceIntent(input.slide);
    adaptiveContent = { layout: "evidence", content: input.slide.content };
  } else if (input.slide.layout === "title") {
    if (!usable.some((component) => component.kind === "title_block")) return { slideId: input.slide.id, mode: "unsupported", rejectionReasons: [...rejectionReasons, { code: "adaptive_capability", message: "Adaptive title composition requires a template-native title component." }] };
    if (input.slide.content.kicker && !usable.some((component) => component.kind === "label")) return { slideId: input.slide.id, mode: "unsupported", rejectionReasons: [...rejectionReasons, { code: "adaptive_capability", message: "Title kicker requires a matching template-native label component." }] };
    intent = titleIntent(input.slide);
    adaptiveContent = { layout: "title", content: input.slide.content };
  } else {
    return { slideId: input.slide.id, mode: "unsupported", rejectionReasons: [...rejectionReasons, { code: "adaptive_capability", message: `Adaptive compose currently supports text-representable layouts only; '${input.slide.layout}' remains outside Goal 8.` }] };
  }
  if (intent.mediaPath && !usable.some((component) => component.kind === "media_frame")) return { slideId: input.slide.id, mode: "unsupported", rejectionReasons: [...rejectionReasons, { code: "media_capability", message: `Layout '${input.slide.layout}' requires a template-native media_frame capability for '${intent.mediaPath}'.` }] };
  try {
    const adaptivePlan = planAdaptiveSlide({ templateDigest: input.templateDigest, designSystem: input.designSystem, components: input.components, intent });
    if (adaptivePlan.textAllocation.some((allocation) => allocation.fits === "no")) return { slideId: input.slide.id, mode: "unsupported", rejectionReasons: [...rejectionReasons, { code: "adaptive_capability", message: "Adaptive composition cannot fit all text allocations in the available native component placements." }] };
    return { slideId: input.slide.id, mode: "adaptive_compose", chosen: { componentFamily: adaptivePlan.family }, adaptivePlan, adaptiveContent, rejectionReasons };
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
