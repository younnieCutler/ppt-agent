import { z } from "zod";
import { slideFunctionSchema, type CompositionFamily, type DeckPlan, type SlideFunction, type SlideSpec } from "./schema";
import type { CompositionPlan } from "./planning";
import { elementsDigest, type SemanticRole, type TemplateElement, type TemplateElementsArtifact, type TemplateGrammar } from "./template-analysis";

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

export function classifyTemplateAsset(element: TemplateElement, _slideSize: { w: number; h: number }): AssetClass {
  if (element.role === "logo") return "brand";
  if (preservedRoles.has(element.role as SemanticRole)) return "structural";
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
        // risk a name-collision hitting the wrong shape.
        if (reliablyNamed === false && preservedRoles.has(element.role as SemanticRole)) continue;
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
export function resolveSlotContent(slide: SlideSpec, binding: SlotBindingPath): string | string[] | undefined {
  switch (binding) {
    case "headline":
      return slide.headline;
    case "subhead":
      return slide.layout === "title" ? slide.content.subtitle : undefined;
    case "content.body":
      return slide.layout === "statement" ? slide.content.body : undefined;
    case "content.proofs[]":
      return slide.layout === "statement" ? slide.content.proofs : undefined;
    case "content.metrics[]":
      return slide.layout === "quantitative" ? slide.content.metrics.map((metric) => `${metric.label} ${metric.value}${metric.unit}`) : undefined;
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
