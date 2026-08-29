import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import type { QaFinding } from "./qa";
import type { DeckSpec, SlideSpec } from "./schema";
import { resolveSlotContent, slotCarriesRealContent, type TemplatePattern } from "./template-patterns";
import type { TemplateStrategy } from "./template-analysis";
import { displayWidth } from "./typography";

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function parse(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
}

function all(scope: Document | Element, namespace: string, name: string): Element[] {
  return Array.from(scope.getElementsByTagNameNS(namespace, name));
}

function first(scope: Document | Element, namespace: string, name: string): Element | undefined {
  return all(scope, namespace, name)[0];
}

async function readPart(pptxPath: string, partPath: string): Promise<string | undefined> {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.resolve(pptxPath)));
  return zip.file(partPath)?.async("string");
}

/** Every `<a:t>` run under a slide's spTree, decoded — the raw XML source has entities escaped, so
 * a leak check must compare decoded text against decoded text, never a substring of the raw file. */
function allTextIn(spTree: Element): string {
  return all(spTree, A_NS, "t").map((node) => node.textContent ?? "").join("\n");
}

function shapeNamesToTexts(spTree: Element, names: Set<string>): string[] {
  return [...all(spTree, P_NS, "sp"), ...all(spTree, P_NS, "pic"), ...all(spTree, P_NS, "graphicFrame")]
    .filter((node) => names.has(first(node, P_NS, "cNvPr")?.getAttribute("name") ?? ""))
    .map((node) => allTextIn(node))
    .filter((text) => text.trim().length > 0);
}

export type RenderManifestEntry = { slideId: string; mode: string };

async function resolveOutputSlideParts(pptxPath: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.resolve(pptxPath)));
  const presentationXml = await zip.file("ppt/presentation.xml")?.async("string");
  const relsXml = await zip.file("ppt/_rels/presentation.xml.rels")?.async("string");
  if (!presentationXml || !relsXml) return [];
  const targets = new Map(all(parse(relsXml), REL_NS, "Relationship").map((node) => [node.getAttribute("Id") ?? "", node.getAttribute("Target") ?? ""]));
  return all(parse(presentationXml), P_NS, "sldId")
    .map((node) => targets.get(node.getAttributeNS(R_NS, "id") ?? ""))
    .filter((target): target is string => Boolean(target))
    .map((target) => (target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join("ppt", target))));
}

/**
 * slideId -> its actual part path in the OUTPUT package, resolved from presentation.xml's own
 * slide order — never assumed as `ppt/slides/slideN.xml`. pptx-automizer numbers newly added slide
 * parts continuing from the root template's original part count (`removeExistingSlides` drops them
 * from the presentation *relationship* list, not from the file numbering sequence), so "deck slide
 * N lives at slideN.xml" is not a safe assumption once any template merge has happened — a real
 * bug this module's own tests caught: reading a nonexistent `slide1.xml` silently returned no
 * findings instead of surfacing that verification never actually happened.
 */
async function outputSlidePartsBySlideId(pptxPath: string, deck: Pick<DeckSpec, "slides">): Promise<Map<string, string>> {
  const parts = await resolveOutputSlideParts(pptxPath);
  const entries = deck.slides.map((slide, index): [string, string | undefined] => [slide.id, parts[index]]);
  return new Map(entries.filter((entry): entry is [string, string] => Boolean(entry[1])));
}

export function patternIdFromMode(mode: string): string | undefined {
  return mode.startsWith("pattern:") ? mode.slice("pattern:".length) : undefined;
}

/**
 * Hard: verbatim source example text surviving in the delivered package. Reads `template.pptx`
 * directly at check time rather than any cached artifact — the elements/patterns artifacts
 * deliberately never persist example strings (see template-analysis.ts), so this is the only place
 * the actual text exists to compare against.
 */
export async function checkTemplateExampleTextLeak(
  outputPptxPath: string,
  templatePath: string,
  deck: Pick<DeckSpec, "slides">,
  manifest: RenderManifestEntry[],
  patternsById: Map<string, TemplatePattern>,
): Promise<QaFinding[]> {
  const findings: QaFinding[] = [];
  const partsBySlideId = await outputSlidePartsBySlideId(outputPptxPath, deck);
  for (const entry of manifest) {
    const patternId = patternIdFromMode(entry.mode);
    const pattern = patternId ? patternsById.get(patternId) : undefined;
    if (!pattern) continue;
    const sourceXml = await readPart(templatePath, pattern.skeleton.sourceSlidePart);
    const sourceRoot = sourceXml ? first(parse(sourceXml), P_NS, "spTree") : undefined;
    if (!sourceRoot) continue;
    const namesToCheck = new Set([...pattern.skeleton.removableContentIds, ...pattern.skeleton.replaceableSlots.map((slot) => slot.shapeId)]);
    const exampleTexts = shapeNamesToTexts(sourceRoot, namesToCheck);
    if (exampleTexts.length === 0) continue;
    const outputPart = partsBySlideId.get(entry.slideId);
    if (!outputPart) continue;
    const outputXml = await readPart(outputPptxPath, outputPart);
    const outputRoot = outputXml ? first(parse(outputXml), P_NS, "spTree") : undefined;
    if (!outputRoot) continue;
    const outputText = allTextIn(outputRoot);
    for (const text of exampleTexts) {
      if (outputText.includes(text)) {
        findings.push({ severity: "hard", code: "TEMPLATE_EXAMPLE_CONTENT_LEAK", slideId: entry.slideId, message: `Template example text survived in the rendered output: "${text}".` });
      }
    }
  }
  return findings;
}

/**
 * Hard: a shape the pattern declared removable (an example photo, sample chart, sample table) is
 * still present — as a picture or graphic frame, specifically, not text (that's the text check's
 * job) — in the delivered slide. Checked against the OUTPUT package directly: this verifies the
 * renderer's own removal promise actually took effect, not merely that the renderer intended it.
 */
export async function checkTemplateExampleMediaLeak(
  outputPptxPath: string,
  deck: Pick<DeckSpec, "slides">,
  manifest: RenderManifestEntry[],
  patternsById: Map<string, TemplatePattern>,
): Promise<QaFinding[]> {
  const findings: QaFinding[] = [];
  const partsBySlideId = await outputSlidePartsBySlideId(outputPptxPath, deck);
  for (const entry of manifest) {
    const patternId = patternIdFromMode(entry.mode);
    const pattern = patternId ? patternsById.get(patternId) : undefined;
    if (!pattern) continue;
    const outputPart = partsBySlideId.get(entry.slideId);
    if (!outputPart) continue;
    const outputXml = await readPart(outputPptxPath, outputPart);
    const outputRoot = outputXml ? first(parse(outputXml), P_NS, "spTree") : undefined;
    if (!outputRoot) continue;
    const removableNames = new Set(pattern.skeleton.removableContentIds);
    const survivingMedia = [...all(outputRoot, P_NS, "pic"), ...all(outputRoot, P_NS, "graphicFrame")]
      .filter((node) => removableNames.has(first(node, P_NS, "cNvPr")?.getAttribute("name") ?? ""));
    for (const node of survivingMedia) {
      const name = first(node, P_NS, "cNvPr")?.getAttribute("name") ?? "(unnamed)";
      findings.push({ severity: "hard", code: "TEMPLATE_EXAMPLE_MEDIA_LEAK", slideId: entry.slideId, message: `Template example media survived in the rendered output: '${name}'.` });
    }
  }
  return findings;
}

/**
 * Hard: a source_slide_pattern template rendered a slide with the generic renderer instead of a
 * cloned pattern, with nothing recording that as an intentional exception. `hybrid` legitimately
 * mixes both — this only fires for a pure source_slide_pattern strategy, where a silent fallback
 * to the generic renderer is exactly what this whole architecture exists to prevent.
 */
export function checkTemplateFidelityUnproven(strategy: TemplateStrategy, manifest: RenderManifestEntry[]): QaFinding[] {
  if (strategy !== "source_slide_pattern") return [];
  return manifest
    .filter((entry) => entry.mode === "renderer")
    .map((entry) => ({ severity: "hard" as const, code: "TEMPLATE_FIDELITY_UNPROVEN", slideId: entry.slideId, message: "This template's design lives in its source slide bodies (strategy: source_slide_pattern), but this slide was rendered generically instead of cloned from a source-slide pattern." }));
}

/**
 * Hard: a pattern's declared preservedShapeIds must survive by name in the output slide — a
 * structural diff, not a judgment call. Missing one means the clone step (or something after it)
 * dropped chrome the pattern promised to keep untouched.
 */
export async function checkTemplatePatternStructureDrift(
  outputPptxPath: string,
  deck: Pick<DeckSpec, "slides">,
  manifest: RenderManifestEntry[],
  patternsById: Map<string, TemplatePattern>,
): Promise<QaFinding[]> {
  const findings: QaFinding[] = [];
  const partsBySlideId = await outputSlidePartsBySlideId(outputPptxPath, deck);
  for (const entry of manifest) {
    const patternId = patternIdFromMode(entry.mode);
    const pattern = patternId ? patternsById.get(patternId) : undefined;
    if (!pattern || pattern.skeleton.preservedShapeIds.length === 0) continue;
    const outputPart = partsBySlideId.get(entry.slideId);
    if (!outputPart) continue;
    const outputXml = await readPart(outputPptxPath, outputPart);
    const outputRoot = outputXml ? first(parse(outputXml), P_NS, "spTree") : undefined;
    if (!outputRoot) continue;
    const survivingNames = new Set([...all(outputRoot, P_NS, "sp"), ...all(outputRoot, P_NS, "pic"), ...all(outputRoot, P_NS, "graphicFrame"), ...all(outputRoot, P_NS, "cxnSp")].map((node) => first(node, P_NS, "cNvPr")?.getAttribute("name") ?? ""));
    const missing = pattern.skeleton.preservedShapeIds.filter((name) => !survivingNames.has(name));
    if (missing.length > 0) {
      findings.push({ severity: "hard", code: "TEMPLATE_PATTERN_STRUCTURE_DRIFT", slideId: entry.slideId, message: `Pattern '${pattern.id}' declared these shapes preserved, but they are missing from the rendered output: ${missing.join(", ")}.` });
    }
  }
  return findings;
}

/** Runs every deterministic template check together — the CLI's one entry point. */
export async function templateFidelityQa(
  outputPptxPath: string,
  templatePath: string,
  deck: Pick<DeckSpec, "slides">,
  manifest: RenderManifestEntry[],
  patterns: TemplatePattern[],
  strategy: TemplateStrategy,
): Promise<QaFinding[]> {
  const patternsById = new Map(patterns.map((pattern) => [pattern.id, pattern]));
  return [
    ...checkTemplateFidelityUnproven(strategy, manifest),
    ...(await checkTemplateExampleTextLeak(outputPptxPath, templatePath, deck, manifest, patternsById)),
    ...(await checkTemplateExampleMediaLeak(outputPptxPath, deck, manifest, patternsById)),
    ...(await checkTemplatePatternStructureDrift(outputPptxPath, deck, manifest, patternsById)),
  ];
}

/**
 * Hard: the Pattern Resolver's own shortlist for a slide came up empty on a source_slide_pattern
 * template — no candidate pattern could hold this slide at all. This repo has no per-layout
 * fallbackPolicy override yet (a real future refinement); until one exists, an empty shortlist on
 * a pure source_slide_pattern template is always hard rather than silently falling back to the
 * generic renderer, which is exactly what this whole architecture exists to prevent.
 */
export function checkTemplatePatternNotFound(strategy: TemplateStrategy, patternPlan: { slides: Array<{ id: string; candidates: unknown[] }> }): QaFinding[] {
  if (strategy !== "source_slide_pattern") return [];
  return patternPlan.slides
    .filter((slide) => slide.candidates.length === 0)
    .map((slide) => ({ severity: "hard" as const, code: "TEMPLATE_PATTERN_NOT_FOUND", slideId: slide.id, message: "No source-slide pattern could hold this slide (no candidate had a headline-bindable slot). Add or relabel a source-slide pattern, or change this slide's composition." }));
}

/**
 * A slot's `maxChars`/`maxLines` are an approximate glyph-advance model (see
 * estimateSlotCapacity in template-patterns.ts), not real font metrics — same caveat as every
 * other text-budget check in this codebase. `required` slots overflowing is hard: the content has
 * nowhere else to go. A non-required slot's repeatable content that overflows is truncated to what
 * fits and reported as risk, not silently dropped without a trace.
 */
export function checkTemplateSlotCapacity(deck: Pick<DeckSpec, "slides">, chosenPatterns: Map<string, TemplatePattern>): QaFinding[] {
  const findings: QaFinding[] = [];
  for (const slide of deck.slides as SlideSpec[]) {
    const pattern = chosenPatterns.get(slide.id);
    if (!pattern) continue;
    for (const slot of pattern.skeleton.replaceableSlots) {
      const content = resolveSlotContent(slide, slot.binding);
      if (content === undefined || slot.maxChars === undefined) continue;
      const text = Array.isArray(content) ? content.join(" · ") : content;
      const width = displayWidth(text);
      if (width > slot.maxChars) {
        const severity = slot.required ? "hard" : "risk";
        const code = slot.required ? "TEMPLATE_SLOT_OVERFLOW" : "TEMPLATE_SLOT_TRUNCATED";
        findings.push({ severity, code, slideId: slide.id, message: `Slot '${slot.id}' (binding '${slot.binding}') needs ${width} display columns but the pattern's shape holds an estimated ${slot.maxChars}. ${slot.required ? "Shorten the content or choose a different pattern candidate." : "Excess content will be truncated at render time."}` });
      }
    }
  }
  return findings;
}

/**
 * A pattern-rendered slide is exempt from `REQUIRED_NATIVE_OBJECT_MISSING` (a promise about
 * connector/shape *geometry* the generic renderer's own composition contract makes, and a
 * pattern's editability guarantee comes from being real copied shapes, not from matching that
 * contract — see the exemption's own comment in qa.ts). That exemption must never be read as
 * covering *content* too: this is the independent, non-exempted check for whether the slide's real
 * payload — not just its headline — actually reached a slot. Only `title` is skipped, matching
 * `patternFitsSlide`'s own reasoning (a cover's payload is legitimately its headline/subtitle).
 * `quantitative` is checked like every other layout — `content.metrics[]` is its real payload and
 * a headline-only pattern must not pass just because it also happens to carry a `source` slot
 * (`slotCarriesRealContent` excludes `headline`/`source` from counting, since both resolve on
 * every slide regardless of layout and prove nothing about this slide's actual content).
 */
export function checkTemplateSemanticContentDropped(deck: Pick<DeckSpec, "slides">, chosenPatterns: Map<string, TemplatePattern>): QaFinding[] {
  const findings: QaFinding[] = [];
  for (const slide of deck.slides as SlideSpec[]) {
    const pattern = chosenPatterns.get(slide.id);
    if (!pattern) continue;
    if (slide.layout === "title") continue;
    const carriesRealContent = pattern.skeleton.replaceableSlots.some((slot) => slotCarriesRealContent(slide, slot));
    if (!carriesRealContent) {
      findings.push({
        severity: "hard",
        code: "TEMPLATE_SEMANTIC_CONTENT_DROPPED",
        slideId: slide.id,
        message: `Pattern '${pattern.id}' has no slot bound to slide '${slide.id}''s non-headline content (layout '${slide.layout}'). Cloning this pattern would render only the headline; the composition's real payload has nowhere to go and would be silently dropped.`,
      });
    }
  }
  return findings;
}
