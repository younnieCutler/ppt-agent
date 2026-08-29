import { z } from "zod";
import { slideFunctionSchema, type CompositionFamily, type DeckPlan, type SlideFunction, type SlideSpec } from "./schema";
import type { CompositionPlan } from "./planning";
import { elementsDigest, type SemanticRole, type TemplateElement, type TemplateElementsArtifact, type TemplateGrammar } from "./template-analysis";
import { displayWidth } from "./typography";

/**
 * The closed set of `SlideSpec` field paths a template slot can be bound to. The host authors
 * semantic content and picks a pattern; it never touches a `shapeId` or a coordinate. Extend this
 * union (and `resolveSlotContent` below) only when a real pattern needs a binding it doesn't have —
 * it stays closed so an invented path fails at compile time, not at render time.
 */
export const slotBindingPaths = [
  "headline",
  "subhead",
  "content.body",
  "content.steps[]",
  "content.proofs[]",
  "content.metrics[]",
  "content.left.label",
  "content.left.items[]",
  "content.right.label",
  "content.right.items[]",
  "source",
] as const;
export type SlotBindingPath = (typeof slotBindingPaths)[number];

export type TemplateSlot = {
  id: string;
  role: SemanticRole;
  /** The one thing a `slotBindings` dictionary would have expressed — kept on the slot itself so
   * there is exactly one place a slot's mapping lives, not two that can drift apart. */
  binding: SlotBindingPath;
  /** The raw PowerPoint shape name — pptx-automizer's selector, not our composite element id. */
  shapeId: string;
  bounds: { x: number; y: number; w: number; h: number };
  maxChars?: number;
  maxLines?: number;
  required: boolean;
  repeatable?: boolean;
};

/**
 * `structural` / `brand` — keep, never touched by injection.
 * `example_content` — the template author's own placeholder; must be replaced or removed, never
 * survive to the delivered package (see `TEMPLATE_EXAMPLE_CONTENT_LEAK` / `_MEDIA_LEAK`, PR E).
 * `unknown` — no role or geometry signal ties it to either bucket; rejected by default rather than
 * guessed at, since guessing wrong here means either destroying real template chrome or leaking a
 * sample asset. See the classifier's own comments for exactly which cases fall into this.
 */
export const assetClasses = ["structural", "brand", "example_content", "unknown"] as const;
export type AssetClass = (typeof assetClasses)[number];

export type TemplatePattern = {
  id: string;
  sourceSlideId: string;
  sourceSlideNumber: number;
  suitableFor: { functions: SlideFunction[]; compositions: string[]; densities: Array<"low" | "medium" | "high">; confidence: number };
  skeleton: {
    sourceSlidePart: string;
    /** Raw PowerPoint shape names (never touched — preserved by simply not acting on them). */
    preservedShapeIds: string[];
    replaceableSlots: TemplateSlot[];
    /** Raw PowerPoint shape names the renderer removes via pptx-automizer's name-selector API. */
    removableContentIds: string[];
    /** Keyed by our own element id (template-analysis.ts), not shape name — bookkeeping only. */
    assetClasses: Record<string, AssetClass>;
  };
  visualSignature: { backgroundTreatment: string; compositionFamily: CompositionFamily; surfaceUsage: string; density: "low" | "medium" | "high" };
};

export const TEMPLATE_PATTERN_COMPILER_VERSION = "1";

export type TemplatePatternsArtifact = {
  version: 1;
  compilerVersion: string;
  sourceDigest: string;
  /** Binds this artifact to the exact elements artifact it was compiled from — same discipline as
   * TemplateGrammar.elementsDigest, so a patterns file compiled from stale elements is detectable. */
  elementsDigest: string;
  patterns: TemplatePattern[];
};

// The canonical "preserve" roles (PRD §10): background, logo/watermark, dividers, surfaces/bands,
// footer structure. Everything else that carries a classified role is content a template author put
// in as an example, which is exactly why cloning a skeleton needs sanitization at all.
const preservedRoles = new Set<SemanticRole>(["divider", "surface", "footer"]);

// A short numeral run (a "02" section-index label, a step number, a column number) is exactly the
// kind of thing a template author's example content puts on top of otherwise-structural chrome —
// but it is still example content, not the chrome itself. If the geometry-based role fallbacks
// (full-bleed → surface, extreme aspect ratio → divider) or a future heuristic ever mis-signal one
// of these as structural, treating it as chrome would ship the literal example number in every
// generated deck. A real divider/surface/footer shape is essentially never itself a bare 1-3 digit
// numeral, so this is a safe defensive floor, not a behavior change for genuine chrome.
function isBareNumericLabel(element: TemplateElement): boolean {
  return element.type === "text" && Boolean(element.features.numericOnly) && (element.features.charCount ?? 0) <= 3;
}

export function classifyTemplateAsset(element: TemplateElement, _slideSize: { w: number; h: number }): AssetClass {
  if (element.role === "logo") return "brand";
  if (preservedRoles.has(element.role as SemanticRole) && !isBareNumericLabel(element)) return "structural";
  // A full-bleed, z-index-0 image is genuinely ambiguous: it could be template chrome (a
  // background texture) or a cover photograph the template author put in as an example — a real
  // company cover slide's sample photo satisfies this geometry test exactly as well as a texture
  // does. There is no signal here telling the two apart, so — same rule as any other unnamed,
  // unclassified element in this function — it defaults to `unknown` (removed on clone) rather
  // than assumed brand chrome and shipped in every generated deck.
  if (element.role === "unknown") return "unknown";
  // Every other classified role (title, subtitle, heading, body, caption, eyebrow, label,
  // key_message, metric, metric_label, annotation, step, route, source) is content, not chrome.
  return "example_content";
}

// Only roles with an unambiguous, real SlideSpec field become a bindable slot. A classified
// example_content role with no entry here (heading, caption, eyebrow, label, metric_label,
// annotation, step, route) cannot be grounded deterministically — per PRD §10 it is removed, not
// left half-bound to nothing.
const ROLE_TO_BINDING: Partial<Record<SemanticRole, SlotBindingPath>> = {
  title: "headline",
  subtitle: "subhead",
  body: "content.body",
  key_message: "content.body",
  metric: "content.metrics[]",
  step: "content.steps[]",
  source: "source",
};

/**
 * Approximate glyph-advance/line-height model, not real font metrics — same caveat as
 * src/typography.ts's own wrap simulation. Good enough to reject an obviously oversized slot
 * candidate in the Pattern Resolver (PR D); live measurement stays with `qa --powerpoint`.
 */
function estimateSlotCapacity(bounds: { w: number; h: number }, sizePt: number | undefined): { maxChars: number; maxLines: number } {
  const fontSize = sizePt ?? 18;
  const avgGlyphWidthIn = (fontSize / 72) * 0.55;
  const lineHeightIn = (fontSize / 72) * 1.2;
  const columnsPerLine = Math.max(1, Math.floor(bounds.w / avgGlyphWidthIn));
  const maxLines = Math.max(1, Math.floor(bounds.h / lineHeightIn));
  return { maxChars: columnsPerLine * maxLines, maxLines };
}

function densityOf(elementCount: number): "low" | "medium" | "high" {
  return elementCount <= 3 ? "low" : elementCount <= 6 ? "medium" : "high";
}

/**
 * One pattern per source slide — replacing the single deck-wide synthetic pattern
 * `compileTemplateGrammar` emits with the real, per-slide skeleton a source_slide_pattern strategy
 * actually needs to clone. `suitableFor.functions`/`compositions` start empty: which SlideFunction a
 * slide serves (cover, key-message, ...) is not something element geometry alone can prove — that is
 * exactly the judgment `pattern-label` lets the host supply after looking at `template-preview`'s
 * montage, never a coordinate or a shapeId.
 */
export function compileTemplatePatterns(elements: TemplateElementsArtifact, _grammar: TemplateGrammar): TemplatePatternsArtifact {
  const patterns: TemplatePattern[] = elements.slides.map((slide) => {
    const preservedShapeIds: string[] = [];
    const removableContentIds: string[] = [];
    const replaceableSlots: TemplateSlot[] = [];
    const elementAssetClasses: Record<string, AssetClass> = {};
    const nameOccurrences = new Map<string, number>();
    for (const element of slide.elements) nameOccurrences.set(element.name, (nameOccurrences.get(element.name) ?? 0) + 1);
    const hasReliableName = (element: TemplateElement) => Boolean(element.name) && nameOccurrences.get(element.name) === 1;

    for (const element of slide.elements) {
      const reliablyNamed = hasReliableName(element);
      const assetClass = reliablyNamed ? classifyTemplateAsset(element, elements.source.slideSize) : "unknown";
      elementAssetClasses[element.id] = assetClass;
      if (assetClass === "structural" || assetClass === "brand") {
        preservedShapeIds.push(element.name);
        continue;
      }
      if (assetClass === "unknown") {
        // Structural-by-role but ambiguously named elements are simply left alone (preserved by
        // inaction is always safe); anything else ambiguous is removed defensively rather than
        // risk a name-collision hitting the wrong shape. A bare numeral is never "left alone" by
        // this rule even if role-classified as structural — see isBareNumericLabel's own comment;
        // an ambiguously-named one only reaches this branch (classifyTemplateAsset is never called
        // for it), so the guard has to be re-checked here too, not just there.
        if (reliablyNamed === false && preservedRoles.has(element.role as SemanticRole) && !isBareNumericLabel(element)) continue;
        if (element.name) removableContentIds.push(element.name);
        continue;
      }
      const binding = element.type === "text" ? ROLE_TO_BINDING[element.role as SemanticRole] : undefined;
      if (!binding) {
        removableContentIds.push(element.name);
        continue;
      }
      const style = element.styleRef ? elements.styles[element.styleRef] : undefined;
      const { maxChars, maxLines } = estimateSlotCapacity(element.bounds, style?.sizePt);
      replaceableSlots.push({
        id: element.id,
        role: element.role as SemanticRole,
        binding,
        shapeId: element.name,
        bounds: element.bounds,
        maxChars,
        maxLines,
        required: binding === "headline",
        repeatable: binding.endsWith("[]") ? true : undefined,
      });
    }

    const dividerCount = slide.elements.filter((element) => element.role === "divider").length;
    const hasMetric = slide.elements.some((element) => element.role === "metric");
    const density = densityOf(slide.elements.length);
    const compositionFamily: CompositionFamily = hasMetric ? "single_focal" : dividerCount ? "split_panels" : "column_zones";

    return {
      id: `pattern-${slide.id}`,
      sourceSlideId: slide.id,
      sourceSlideNumber: Number(slide.id.replace(/^S/, "")),
      suitableFor: { functions: [], compositions: [], densities: [density], confidence: 0.5 },
      skeleton: { sourceSlidePart: slide.sourceSlidePart, preservedShapeIds: [...new Set(preservedShapeIds)], replaceableSlots, removableContentIds: [...new Set(removableContentIds)], assetClasses: elementAssetClasses },
      visualSignature: {
        backgroundTreatment: slide.elements.some((element) => element.role === "surface") ? "surface" : "plain",
        compositionFamily,
        surfaceUsage: dividerCount ? "sparse" : "none",
        density,
      },
    };
  });

  return {
    version: 1,
    compilerVersion: TEMPLATE_PATTERN_COMPILER_VERSION,
    sourceDigest: elements.source.sha256,
    elementsDigest: elementsDigest(elements),
    patterns,
  };
}

/**
 * The whole "host authors semantic content, runtime resolves it into slots" contract in one pure
 * function: given a slide and a binding path, look up the real SlideSpec field — never a shapeId,
 * never a coordinate. Returns `undefined` when the binding does not apply to this slide's layout
 * (e.g. `content.left.label` on a `statement` slide), which the caller treats as "no content for
 * this slot," not an error.
 */
/** Flattens a process step's label, optional detail, and optional member list into one string —
 * shared by `content.body` (process content joined into a single body-role slot) and
 * `content.steps[]` (one slot per step) so neither drops `detail`/`members` while the other keeps
 * them. */
function flattenStep(step: { label: string; detail?: string; members?: string[] }): string {
  const parts = [step.label];
  if (step.detail) parts.push(step.detail);
  if (step.members && step.members.length > 0) parts.push(`(${step.members.join(", ")})`);
  return parts.join(" — ");
}

/** `detail` is optional (schema: `{label, date, detail?}`) — dropping it when present is exactly
 * the kind of silent loss `content.body`'s per-layout flattening exists to avoid. */
function flattenMilestone(milestone: { label: string; date: string; detail?: string }): string {
  const base = `${milestone.date} — ${milestone.label}`;
  return milestone.detail ? `${base}: ${milestone.detail}` : base;
}

/** `period` is a required field (schema: `period: z.string().min(1)`) and was previously dropped
 * entirely — not an optional nuance but a real field the slide always has. `comparisonBasis`/
 * `note` are genuinely optional and included only when present. */
function flattenMetric(metric: { label: string; value: number; unit: string; period: string; comparisonBasis?: string; note?: string }): string {
  const parts = [`${metric.label} ${metric.value}${metric.unit} (${metric.period})`];
  if (metric.comparisonBasis) parts.push(`vs ${metric.comparisonBasis}`);
  if (metric.note) parts.push(metric.note);
  return parts.join(", ");
}

export function resolveSlotContent(slide: SlideSpec, binding: SlotBindingPath): string | string[] | undefined {
  switch (binding) {
    case "headline":
      return slide.headline;
    case "subhead":
      return slide.layout === "title" ? slide.content.subtitle : undefined;
    case "content.body":
      // A "body"/"key_message"-role slot is the one general-purpose text container most real
      // templates have, and it is the only slot most patterns offer beyond the headline — so
      // rather than binding it to `statement.body` alone (leaving process/evidence/timeline/
      // comparison content with nowhere to go but silently removed), every layout whose real
      // payload can be flattened into readable text degrades into this slot instead of being
      // dropped. `architecture`/`pipeline`/`chart` genuinely cannot (their payload is a graph or
      // a chart, not prose) and stay unsupported here — a pattern with only this slot is not a
      // fit for those layouts, which the Pattern Resolver's capacity/content check must reject.
      if (slide.layout === "statement") return slide.content.body;
      if (slide.layout === "process") return slide.content.steps.map(flattenStep);
      if (slide.layout === "evidence") return slide.content.caption ? [...slide.content.bullets, slide.content.caption] : slide.content.bullets;
      if (slide.layout === "timeline") return slide.content.milestones.map(flattenMilestone);
      if (slide.layout === "comparison") {
        const sides = [`${slide.content.left.label}: ${slide.content.left.items.join(", ")}`, `${slide.content.right.label}: ${slide.content.right.items.join(", ")}`];
        return slide.content.delta ? [...sides, slide.content.delta] : sides;
      }
      return undefined;
    case "content.steps[]":
      return slide.layout === "process" ? slide.content.steps.map(flattenStep) : undefined;
    case "content.proofs[]":
      return slide.layout === "statement" ? slide.content.proofs : undefined;
    case "content.metrics[]":
      return slide.layout === "quantitative" ? slide.content.metrics.map(flattenMetric) : undefined;
    case "content.left.label":
      return slide.layout === "comparison" ? slide.content.left.label : undefined;
    case "content.left.items[]":
      return slide.layout === "comparison" ? slide.content.left.items : undefined;
    case "content.right.label":
      return slide.layout === "comparison" ? slide.content.right.label : undefined;
    case "content.right.items[]":
      return slide.layout === "comparison" ? slide.content.right.items : undefined;
    case "source":
      // No modeled citation-display-string field exists yet — the first grounded source id is the
      // closest real value until one does. Never fabricated free text.
      return slide.sourceRefs[0]?.sourceId;
    default:
      return undefined;
  }
}

// `headline` and `source` resolve on every slide regardless of layout (every SlideSpec has a
// headline; `sourceRefs` is required, min 1) — a pattern offering only one of these would trivially
// pass a "did any non-headline slot resolve" test without carrying any of the slide's actual
// layout-specific payload. Neither counts as evidence a pattern carries real content.
const UNIVERSAL_BINDINGS = new Set<SlotBindingPath>(["headline", "source"]);

export function slotCarriesRealContent(slide: SlideSpec, slot: Pick<TemplateSlot, "binding">): boolean {
  if (UNIVERSAL_BINDINGS.has(slot.binding)) return false;
  const content = resolveSlotContent(slide, slot.binding);
  return content !== undefined && (!Array.isArray(content) || content.length > 0);
}

export type SlotAssignment = { slot: TemplateSlot; text: string } | { slot: TemplateSlot; remove: true };

/**
 * Maps a slide's resolved content onto the pattern's actual shapes — one per shape, never the same
 * full string duplicated into every shape that happens to share a binding. A pattern with K slots
 * bound to `content.body` (a real GAO shape) previously received the same fully-joined string in
 * all K of them; this groups slots by binding (document order preserved) and distributes item i to
 * slot i instead:
 *
 * - a list-shaped resolution (`content.metrics[]`, `content.body`'s process/evidence/timeline/
 *   comparison branches, …) maps item i onto group slot i; leftover slots (fewer items than
 *   slots) are removed; leftover items (more items than slots) join onto the *last* slot, same
 *   fallback the old single-slot behavior always had.
 * - a scalar resolution (`headline`, `subhead`, `source`) only fills the first slot in the group;
 *   any additional slots sharing that binding are removed rather than repeating the same text.
 * - an empty resolution empties every slot in the group; if any of them is `required`, throws
 *   (every slot sharing a binding was compiled with the same `required` flag, so "any" and "all"
 *   agree here).
 */
export function resolveSlotAssignments(pattern: TemplatePattern, slide: SlideSpec): SlotAssignment[] {
  const groups = new Map<SlotBindingPath, TemplateSlot[]>();
  for (const slot of pattern.skeleton.replaceableSlots) {
    const group = groups.get(slot.binding);
    if (group) group.push(slot);
    else groups.set(slot.binding, [slot]);
  }
  const assignments: SlotAssignment[] = [];
  for (const [binding, slots] of groups) {
    const content = resolveSlotContent(slide, binding);
    const isEmpty = content === undefined || (Array.isArray(content) && content.length === 0);
    if (isEmpty) {
      if (slots.some((slot) => slot.required)) {
        throw new Error(`Pattern '${pattern.id}' required slot (binding '${binding}') has no content for slide '${slide.id}'.`);
      }
      slots.forEach((slot) => assignments.push({ slot, remove: true }));
      continue;
    }
    if (!Array.isArray(content)) {
      // Scalar content only ever fills the first slot of the group — repeating a headline or a
      // source id into every sibling shape would be the same duplication bug, just for a binding
      // that happens not to be list-shaped.
      assignments.push({ slot: slots[0], text: content });
      slots.slice(1).forEach((slot) => assignments.push({ slot, remove: true }));
      continue;
    }
    if (content.length <= slots.length) {
      content.forEach((item, index) => assignments.push({ slot: slots[index], text: item }));
      // Fewer items than slots: the unused tail of the group is removed, not left holding stale
      // example content or a repeat of the last item.
      for (let index = content.length; index < slots.length; index++) assignments.push({ slot: slots[index], remove: true });
    } else {
      // More items than slots: fill every slot but the last one-for-one, then the last slot
      // absorbs everything remaining, joined — same "collapse" fallback a single over-full slot
      // always had, just now only for genuine overflow instead of every slot in the group.
      const lastIndex = slots.length - 1;
      for (let index = 0; index < lastIndex; index++) assignments.push({ slot: slots[index], text: content[index] });
      assignments.push({ slot: slots[lastIndex], text: content.slice(lastIndex).join(" · ") });
    }
  }
  return assignments;
}

/**
 * Per-layout full-coverage contract: not "did *some* slot resolve *something*", but "does the set
 * of slots that actually resolved cover this layout's *whole* real payload". Every list-shaped
 * binding (`content.steps[]`, `content.body` for process/evidence/timeline, `content.metrics[]`,
 * `content.left/right.items[]`) always maps the *entire* underlying array when it resolves at all
 * — `resolveSlotContent` never slices a partial page of it — so the only place partial coverage
 * was actually possible is `comparison`, which is the one layout whose payload is split across two
 * independent bindings (`content.left.items[]` and `content.right.items[]`): a pattern with only
 * one of the two previously passed the old "any slot resolved" test while silently dropping the
 * other side. `content.body`'s comparison branch already flattens both sides into one string, so a
 * pattern using it alone still has full coverage without needing both granular slots.
 */
export function hasFullSemanticCoverage(slide: SlideSpec, slots: TemplateSlot[]): boolean {
  const resolves = (binding: SlotBindingPath) => slots.some((slot) => slot.binding === binding && slotCarriesRealContent(slide, slot));
  switch (slide.layout) {
    case "title":
      // A cover's real payload is legitimately just its headline — but when the slide actually
      // has a subtitle, that subtitle is part of the "whole" payload this function is answering
      // for, not an optional nicety a pattern can silently drop.
      return !slide.content.subtitle || resolves("subhead");
    case "evidence":
      // caption folds into content.body's flattening (see resolveSlotContent) — a resolved
      // content.body slot already carries it. assetPath is an image reference with no slot
      // mechanism at all (SlotBindingPath only carries text); a slide that names one has no
      // pattern-clone path that preserves it, the same honest "not supported" outcome as
      // architecture/pipeline/chart below rather than silently shipping without the image.
      return !slide.content.assetPath && resolves("content.body");
    case "timeline":
      return resolves("content.body"); // milestone.detail folds into the flattening
    case "statement":
      // proofs[] is its own distinct binding (a template's "proof chip" shapes are a different
      // kind of element than its body paragraph), so it is required independently when present —
      // not folded into content.body the way evidence's caption is.
      return resolves("content.body") && (slide.content.proofs.length === 0 || resolves("content.proofs[]"));
    case "process":
      return resolves("content.body") || resolves("content.steps[]"); // both flatten detail/members
    case "quantitative":
      return resolves("content.metrics[]"); // period/comparisonBasis/note fold into the flattening
    case "comparison":
      // delta only survives through content.body's flattening — the granular left/right slots
      // have no shape to carry it, so a slide with a delta needs content.body specifically, not
      // just "both sides independently".
      if (slide.content.delta) return resolves("content.body");
      return resolves("content.body") || (resolves("content.left.items[]") && resolves("content.right.items[]"));
    case "architecture":
    case "pipeline":
    case "chart":
      // No binding exists for a graph or a chart's structured payload yet (nodes/edges/zones/
      // dataRef) — no pattern can ever have full coverage for these today, which is the honest
      // "not supported" outcome rather than a silent headline-only render.
      return false;
    default:
      return false;
  }
}

/**
 * Whether cloning `pattern` for `slide` would actually carry the slide's whole real payload, not
 * just its headline or a fragment of it — and would not visibly overflow a required slot. The
 * Pattern Resolver uses this to pick the first candidate (by rank) that fits rather than always
 * rendering rank 1, and `checkTemplateSemanticContentDropped` (template-fidelity.ts) uses the same
 * `hasFullSemanticCoverage` question to catch it after the fact if a caller renders directly
 * against a resolved pattern without going through this gate.
 */
export function patternFitsSlide(pattern: TemplatePattern, slide: SlideSpec): boolean {
  const slots = pattern.skeleton.replaceableSlots;
  if (!hasFullSemanticCoverage(slide, slots)) return false;
  return !slots.some((slot) => {
    if (!slot.required || slot.maxChars === undefined) return false;
    const content = resolveSlotContent(slide, slot.binding);
    if (content === undefined) return false;
    const text = Array.isArray(content) ? content.join(" · ") : content;
    return displayWidth(text) > slot.maxChars;
  });
}

export type PatternSelectionEntry = {
  slideId: string;
  chosen?: { patternId: string; rank: number };
  rejected: Array<{ patternId: string; rank: number; reason: string }>;
};

/**
 * Walks each slide's ranked candidate shortlist and picks the first one `patternFitsSlide` accepts
 * — never unconditionally rank 1. A slide with no fitting candidate at all gets no resolved
 * pattern (the caller falls through to the generic renderer for it); this never throws.
 */
export function selectPatternsForSlides(
  patternPlan: { slides: Array<{ id: string; candidates: Array<{ patternId: string; rank: number }> }> },
  patternsById: Map<string, TemplatePattern>,
  slidesById: Map<string, SlideSpec>,
): { resolvedPatterns: Map<string, TemplatePattern>; selectionLog: PatternSelectionEntry[] } {
  const resolvedPatterns = new Map<string, TemplatePattern>();
  const selectionLog: PatternSelectionEntry[] = [];
  for (const slide of patternPlan.slides) {
    const slideSpec = slidesById.get(slide.id);
    const rejected: PatternSelectionEntry["rejected"] = [];
    let chosen: PatternSelectionEntry["chosen"];
    for (const candidate of [...slide.candidates].sort((a, b) => a.rank - b.rank)) {
      const pattern = patternsById.get(candidate.patternId);
      if (!pattern || !slideSpec) continue;
      if (patternFitsSlide(pattern, slideSpec)) {
        resolvedPatterns.set(slide.id, pattern);
        chosen = { patternId: candidate.patternId, rank: candidate.rank };
        break;
      }
      rejected.push({ patternId: candidate.patternId, rank: candidate.rank, reason: "content would be dropped or a required slot would overflow" });
    }
    selectionLog.push({ slideId: slide.id, chosen, rejected });
  }
  return { resolvedPatterns, selectionLog };
}

// ---------------------------------------------------------------------------------------------
// Host-authored pattern labeling — the one artifact in this whole pipeline a host can write that
// touches pattern classification, and it can express zero geometry: an enum value, never a
// shapeId or a coordinate. Same idiom as visual-findings.json (src/visual-qa.ts) — an invented
// SlideFunction/CompositionFamily is rejected at parse time, not silently accepted.
// ---------------------------------------------------------------------------------------------

const compositionFamilyValues: CompositionFamily[] = ["single_focal", "split_panels", "column_zones", "horizontal_sequence", "stacked_rows", "radial", "plot"];

export const patternLabelSchema = z.array(z.object({
  sourceSlideId: z.string().min(1),
  functions: z.array(slideFunctionSchema).min(1),
  compositionFamily: z.enum(compositionFamilyValues as [CompositionFamily, ...CompositionFamily[]]).optional(),
}));
export type PatternLabel = z.infer<typeof patternLabelSchema>[number];

/** Merges host-authored labels into `suitableFor`; a label naming a slide the artifact does not
 * have is rejected — a typo'd sourceSlideId should fail loudly, not be silently ignored. */
export function applyPatternLabels(artifact: TemplatePatternsArtifact, labels: PatternLabel[]): TemplatePatternsArtifact {
  const bySlideId = new Map(labels.map((label) => [label.sourceSlideId, label]));
  const knownSlideIds = new Set(artifact.patterns.map((pattern) => pattern.sourceSlideId));
  const unknown = labels.filter((label) => !knownSlideIds.has(label.sourceSlideId));
  if (unknown.length > 0) throw new Error(`pattern-labels.json names slide(s) not present in this template: ${unknown.map((label) => label.sourceSlideId).join(", ")}.`);
  return {
    ...artifact,
    patterns: artifact.patterns.map((pattern) => {
      const label = bySlideId.get(pattern.sourceSlideId);
      if (!label) return pattern;
      return {
        ...pattern,
        suitableFor: {
          ...pattern.suitableFor,
          functions: label.functions as SlideFunction[],
          confidence: Math.max(pattern.suitableFor.confidence, 0.9),
        },
        visualSignature: label.compositionFamily ? { ...pattern.visualSignature, compositionFamily: label.compositionFamily } : pattern.visualSignature,
      };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Pattern Resolver — runs right after Composition Resolver, before a DeckSpec exists. Like
// CompositionPlan, this produces a ranked shortlist, not a single final choice: there is no
// authored slide text yet at this stage to check a slot's capacity against, so that check (and
// TEMPLATE_SLOT_OVERFLOW) happens later, once the DeckSpec that must fall within this shortlist
// has real content — exactly the same division of labor resolveCompositionPlan already uses.
// ---------------------------------------------------------------------------------------------

export type PatternCandidate = { patternId: string; sourceSlideId: string; rank: 1 | 2 | 3; reasons: string[] };
export type PatternPlan = { version: 1; slides: Array<{ id: string; candidates: PatternCandidate[] }> };

type CompositionPlanContext = Pick<CompositionPlan, "slides">;

/**
 * Every real slide has a headline; a pattern with no slot bound to `"headline"` cannot be used at
 * all, so this is a hard filter — never merely a scoring dimension a low-confidence pattern could
 * still win on. Slot *capacity* is not checked here (see the module comment above); only whether
 * the pattern can hold a headline in the first place.
 */
function canHoldHeadline(pattern: TemplatePattern): boolean {
  return pattern.skeleton.replaceableSlots.some((slot) => slot.binding === "headline");
}

export function resolvePatternPlan(deckPlan: DeckPlan, compositionPlan: CompositionPlanContext, patterns: TemplatePatternsArtifact): PatternPlan {
  const compositionBySlide = new Map(compositionPlan.slides.map((slide) => [slide.id, slide.candidates[0]]));
  let previousPatternId: string | undefined;

  return {
    version: 1,
    slides: deckPlan.slides.map((intent) => {
      const topComposition = compositionBySlide.get(intent.id);
      const candidates = patterns.patterns
        .filter(canHoldHeadline)
        .map((pattern) => {
          const familyMatch = topComposition ? pattern.visualSignature.compositionFamily === topComposition.family : false;
          const functionMatch = pattern.suitableFor.functions.includes(intent.function);
          const densityMatch = pattern.suitableFor.densities.includes(intent.density);
          const repetitionPenalty = pattern.id === previousPatternId ? 0 : 1;
          return {
            pattern,
            familyMatch: familyMatch ? 1 : 0,
            functionMatch: functionMatch ? 1 : 0,
            densityMatch: densityMatch ? 1 : 0,
            repetitionPenalty,
            confidence: pattern.suitableFor.confidence,
          };
        })
        .sort((left, right) => right.functionMatch - left.functionMatch
          || right.familyMatch - left.familyMatch
          || right.densityMatch - left.densityMatch
          || right.confidence - left.confidence
          || right.repetitionPenalty - left.repetitionPenalty
          || left.pattern.id.localeCompare(right.pattern.id))
        .slice(0, 3)
        .map(({ pattern, familyMatch, functionMatch, densityMatch, repetitionPenalty }, index) => ({
          patternId: pattern.id,
          sourceSlideId: pattern.sourceSlideId,
          rank: (index + 1) as 1 | 2 | 3,
          reasons: [
            functionMatch ? "slide function" : "",
            familyMatch ? "composition family" : "",
            densityMatch ? "density" : "",
            repetitionPenalty ? "" : "recently used",
          ].filter(Boolean),
        }));
      if (candidates.length > 0) previousPatternId = candidates[0].patternId;
      return { id: intent.id, candidates };
    }),
  };
}
