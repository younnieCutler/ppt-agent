import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import type { CompositionFamily, PlanVisualIntent, SlideFunction } from "./schema";
import type { SurfaceUsage } from "./style";

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const C_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const EMU_PER_INCH = 914400;

export const semanticRoles = ["title", "subtitle", "heading", "body", "caption", "eyebrow", "label", "key_message", "metric", "metric_label", "annotation", "step", "route", "source", "logo", "footer", "surface", "divider"] as const;
export type SemanticRole = (typeof semanticRoles)[number];
export type TemplateTextStyle = { family?: string; sizePt?: number; weight?: number; italic?: boolean; color?: string; lineHeightRatio?: number; alignment?: "left" | "center" | "right"; fill?: string; stroke?: string; strokeWidthPt?: number };
// Which OOXML part physically contains a shape — PowerPoint's own inheritance model: a slide's own
// body only ever holds what it overrides; anything else a rendered slide shows is inherited from
// its layout or master, which live in their own parts. Ownership is therefore just "which part was
// this element walked out of," not an inference over the rendered result.
export const elementOwnerships = ["master-owned", "layout-owned", "slide-body-owned"] as const;
export type ElementOwnership = (typeof elementOwnerships)[number];
export type TemplateElement = { id: string; /** The raw PowerPoint shape name (`cNvPr@name`) — pptx-automizer selects/modifies/removes shapes by this exact name, never by `id` (a composite, JSON-key-safe string derived from it). */ name: string; slideId: string; type: "text" | "shape" | "line" | "image" | "chart" | "table"; role: SemanticRole | "unknown"; confidence: number; bounds: { x: number; y: number; w: number; h: number }; zIndex: number; ownership: ElementOwnership; styleRef?: string; assetRef?: string; features: { charCount?: number; lineCount?: number; numericOnly?: boolean; placeholderToken?: string; placeholderType?: string; altText?: string } };
// Two independent versions: the extractor that reads a PPTX into elements, and the compiler that
// turns elements into grammar. Either can change without the other, and a pack whose grammar was
// compiled by an older compiler is stale even when its elements are current.
// Bumped to "4": elements now also retain observed shape fill/stroke and slide backgrounds for the
// Design System artifact, in addition to `name`, the raw PowerPoint shape name pptx-automizer
// needs to select/modify/remove a specific shape when cloning a source slide skeleton (PR D) — an
// artifact analyzed before this existed cannot drive that renderer path at all.
// loadOrganizationPack already refuses a pack whose artifacts predate the current analyzer version,
// so each bump *is* the migration path for any pack analyzed before the new field existed.
export const TEMPLATE_ANALYZER_VERSION = "4";
export const TEMPLATE_GRAMMAR_COMPILER_VERSION = "1";
/** Everything the analysis consumed, so a pack can prove its artifacts describe its current inputs. */
export type AnalysisInputs = { templateDigest: string; roleOverridesDigest: string; analyzerVersion: string };
export type TemplateLayoutInfo = { index: number; name: string; masterIndex: number; elements: TemplateElement[]; background?: string };
export type TemplateMasterInfo = { index: number; elements: TemplateElement[]; background?: string };
// A template whose design lives in its masters/layouts (native_layout) needs no per-slide skeleton
// reuse; one whose design lives in example slide bodies on a shared, mostly-empty layout
// (source_slide_pattern — GAO is this shape) needs its actual slide bodies cloned, not redrawn;
// hybrid splits ownership between the two. See detectTemplateStrategy for the heuristic.
export const templateStrategies = ["native_layout", "source_slide_pattern", "hybrid"] as const;
export type TemplateStrategy = (typeof templateStrategies)[number];
export type TemplateElementsArtifact = {
  version: 1;
  source: { sha256: string; slideSize: { w: number; h: number } };
  analysisInputs: AnalysisInputs;
  slides: Array<{ id: string; sourceSlidePart: string; nativeLayout: { index: number; name: string; masterIndex: number }; elements: TemplateElement[]; background?: string }>;
  layouts: TemplateLayoutInfo[];
  masters: TemplateMasterInfo[];
  styles: Record<string, TemplateTextStyle>;
  strategy: TemplateStrategy;
};
export type TemplateGrammar = {
  version: 1;
  compilerVersion: string;
  sourceDigest: string;
  /** Binds this grammar to the exact elements artifact it was compiled from. */
  elementsDigest: string;
  slideSize: { w: number; h: number };
  typography: { families: string[]; titleBodyRatio: number; weightContrast: number; lineHeightRatio: number };
  geometry: { contentFrame: Rect; outerMargins: Rect; gutter: number; spacingScale: number };
  surface: { usage: SurfaceUsage; borderUsage: number; dividerUsage: number; cornerRadius?: number };
  branding: { primaryColors: string[]; accentColors: string[] };
  compositionPatterns: Array<{ id: string; family: CompositionFamily; functions: SlideFunction[]; visualIntents: PlanVisualIntent[]; density: "low" | "medium" | "high"; confidence: number }>;
};

// Role precedence is deliberate: what PowerPoint itself declares (placeholder type) outranks what
// the designer named the shape, which outranks a text token left in the body, which outranks the
// typographic role its size implies, which outranks bare geometry. Every step down that list is a
// weaker claim about intent, and the confidence reported with the role says so.
const PLACEHOLDER_ROLES: Record<string, SemanticRole> = { ctrTitle: "title", title: "title", subTitle: "subtitle", ftr: "footer", sldNum: "footer", dt: "footer", body: "body" };
const NAMED_ROLES: Array<[RegExp, SemanticRole]> = [
  [/title|headline/, "title"],
  [/subtitle|sub-title/, "subtitle"],
  [/eyebrow|kicker/, "eyebrow"],
  [/caption/, "caption"],
  [/source|출처|出典/, "source"],
  [/metric|kpi/, "metric"],
  [/heading/, "heading"],
];

export type TypographyContext = { sizePt?: number; maxSizePt?: number; medianSizePt?: number };

/** Digest of the role overrides as the analyzer consumed them — order-independent, values only. */
export function roleOverridesDigest(overrides: Record<string, SemanticRole> = {}): string {
  const canonical = Object.keys(overrides).sort().map((key) => [key, overrides[key]]);
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function elementsDigest(artifact: TemplateElementsArtifact): string {
  return crypto.createHash("sha256").update(JSON.stringify(artifact)).digest("hex");
}

export function classifyTemplateElement(
  element: Pick<TemplateElement, "id" | "type" | "bounds" | "features">,
  slideSize: { w: number; h: number },
  overrides: Record<string, SemanticRole> = {},
  typography: TypographyContext = {},
): Pick<TemplateElement, "role" | "confidence"> {
  if (overrides[element.id]) return { role: overrides[element.id], confidence: 1 };

  const placeholderRole = PLACEHOLDER_ROLES[element.features.placeholderType ?? ""];
  if (placeholderRole) {
    // A footer placeholder parked in the middle of the canvas is a repurposed placeholder, not chrome.
    if (placeholderRole !== "footer" || element.bounds.y + element.bounds.h >= slideSize.h * 0.8) return { role: placeholderRole, confidence: 0.95 };
  }

  const name = `${element.id} ${element.features.altText ?? ""}`.toLowerCase();
  if (/footer/.test(name)) return element.bounds.y + element.bounds.h >= slideSize.h * 0.9 ? { role: "footer", confidence: 0.85 } : { role: "unknown", confidence: 0 };
  if (/logo/.test(name) && element.type === "image") return { role: "logo", confidence: 0.9 };
  if (/divider|line/.test(name) || element.type === "line") return { role: "divider", confidence: 0.8 };
  // Geometry-only fallbacks for chrome that carries no name signal at all — a real template's
  // background/divider shapes are very often auto-named ("Rectangle 1") rather than labeled, so
  // name matching alone misses them entirely. Found via the GAO private E2E run: its cover
  // background and section-divider rule are both plain filled rectangles named "Rectangle N".
  if ((element.type === "shape" || element.type === "image") && element.bounds.w >= slideSize.w * 0.95 && element.bounds.h >= slideSize.h * 0.95) {
    return { role: "surface", confidence: 0.7 };
  }
  if (element.type === "shape" && element.bounds.w > 0 && element.bounds.h > 0) {
    // Extremely thin on one axis relative to the other — a divider/rule drawn as a filled
    // rectangle. Conservative threshold (30:1) to avoid catching a genuinely thin content bar
    // (a KPI indicator, a progress fill) that happens to be narrow rather than a rule line.
    const aspect = Math.max(element.bounds.w / element.bounds.h, element.bounds.h / element.bounds.w);
    if (aspect >= 30) return { role: "divider", confidence: 0.6 };
  }
  const named = NAMED_ROLES.find(([pattern]) => pattern.test(name));
  if (named) return { role: named[1], confidence: 0.9 };

  const token = element.features.placeholderToken?.toLowerCase();
  if (token) {
    const tokenRole = NAMED_ROLES.find(([pattern]) => pattern.test(token));
    if (tokenRole) return { role: tokenRole[1], confidence: 0.8 };
    if (/body|text|content/.test(token)) return { role: "body", confidence: 0.8 };
  }

  if (element.type === "text" && element.features.numericOnly && element.bounds.w >= slideSize.w * 0.15) return { role: "metric", confidence: 0.75 };

  const { sizePt, maxSizePt, medianSizePt } = typography;
  if (element.type === "text" && sizePt && maxSizePt && medianSizePt) {
    if (sizePt >= maxSizePt * 0.9 && maxSizePt > medianSizePt) return { role: "title", confidence: 0.6 };
    if (sizePt >= medianSizePt * 1.25) return { role: "heading", confidence: 0.55 };
    if (sizePt <= medianSizePt * 0.75) return { role: "caption", confidence: 0.5 };
    return { role: "body", confidence: 0.5 };
  }
  return { role: "unknown", confidence: 0 };
}

function median(sorted: number[]): number {
  const mid = sorted.length / 2;
  // Standard median: for an even count this is the midpoint between the two central values, not
  // either one of them alone — Math.floor(length/2) on its own returns the *upper* of the two
  // central values, which for a 2-element array is simply the max again. That collapsed
  // maxSizePt === medianSizePt on any 2-text-element slide, which failed the classifier's own
  // `maxSizePt > medianSizePt` title check and silently misclassified the larger text as "body".
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[Math.floor(mid)];
}

function typographyContext(element: TemplateElement, siblings: TemplateElement[], styles: Record<string, TemplateTextStyle>): TypographyContext {
  const sizes = siblings.filter((sibling) => sibling.type === "text").map((sibling) => (sibling.styleRef ? styles[sibling.styleRef]?.sizePt : undefined)).filter((size): size is number => Boolean(size)).sort((a, b) => a - b);
  if (sizes.length === 0) return {};
  return { sizePt: element.styleRef ? styles[element.styleRef]?.sizePt : undefined, maxSizePt: sizes[sizes.length - 1], medianSizePt: median(sizes) };
}

function classifyElements(elements: TemplateElement[], slideSize: { w: number; h: number }, overrides: Record<string, SemanticRole>, styles: Record<string, TemplateTextStyle>): TemplateElement[] {
  return elements.map((element) => ({ ...element, ...classifyTemplateElement(element, slideSize, overrides, typographyContext(element, elements, styles)) }));
}

export function classifyTemplateElements(artifact: TemplateElementsArtifact, overrides: Record<string, SemanticRole> = {}): TemplateElementsArtifact {
  return {
    ...artifact,
    slides: artifact.slides.map((slide) => ({ ...slide, elements: classifyElements(slide.elements, artifact.source.slideSize, overrides, artifact.styles) })),
    layouts: artifact.layouts.map((layout) => ({ ...layout, elements: classifyElements(layout.elements, artifact.source.slideSize, overrides, artifact.styles) })),
    masters: artifact.masters.map((master) => ({ ...master, elements: classifyElements(master.elements, artifact.source.slideSize, overrides, artifact.styles) })),
  };
}

export function compileTemplateGrammar(artifact: TemplateElementsArtifact): TemplateGrammar {
  const elements = artifact.slides.flatMap((slide) => slide.elements);
  const styled = (role: SemanticRole) => elements.filter((element) => element.role === role).map((element) => element.styleRef ? artifact.styles[element.styleRef] : undefined).filter((style): style is TemplateTextStyle => Boolean(style));
  const titles = styled("title");
  const bodies = styled("body");
  const titleSize = titles.map((style) => style.sizePt ?? 0).find(Boolean) ?? 1;
  const bodySize = bodies.map((style) => style.sizePt ?? 0).find(Boolean) ?? titleSize;
  const titleWeight = titles.map((style) => style.weight ?? 400).find(Boolean) ?? 400;
  const bodyWeight = bodies.map((style) => style.weight ?? 400).find(Boolean) ?? 400;
  const usable = elements.filter((element) => !["footer", "logo"].includes(element.role));
  const xs = usable.map((element) => element.bounds.x);
  const ys = usable.map((element) => element.bounds.y);
  const rights = usable.map((element) => element.bounds.x + element.bounds.w);
  const bottoms = usable.map((element) => element.bounds.y + element.bounds.h);
  // Real templates park helper shapes off the canvas, and a group's own extents can reach past the
  // slide. The frame is the intersection of the elements' bounding box with the canvas, not the
  // bounding box itself: an unclamped frame is wider than the slide, which makes outerMargins
  // negative and hands the renderer a frame no slide can hold.
  const { w: slideW, h: slideH } = artifact.source.slideSize;
  const clamp = (value: number, limit: number) => Math.min(Math.max(value, 0), limit);
  const left = clamp(xs.length ? Math.min(...xs) : 0, slideW);
  const top = clamp(ys.length ? Math.min(...ys) : 0, slideH);
  const right = clamp(rights.length ? Math.max(...rights) : 0, slideW);
  const bottom = clamp(bottoms.length ? Math.max(...bottoms) : 0, slideH);
  // Everything off one edge collapses the frame to zero area there rather than inverting it.
  const contentFrame = { x: Math.min(left, right), y: Math.min(top, bottom), w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
  const colors = [...new Set(Object.values(artifact.styles).map((style) => style.color).filter((color): color is string => Boolean(color)))];
  const dividerUsage = elements.filter((element) => element.role === "divider").length / Math.max(1, artifact.slides.length);
  const hasMetric = elements.some((element) => element.role === "metric");
  const family: CompositionFamily = hasMetric ? "single_focal" : dividerUsage ? "split_panels" : "column_zones";
  return {
    version: 1,
    compilerVersion: TEMPLATE_GRAMMAR_COMPILER_VERSION,
    sourceDigest: artifact.source.sha256,
    elementsDigest: elementsDigest(artifact),
    slideSize: artifact.source.slideSize,
    typography: { families: [...new Set(Object.values(artifact.styles).map((style) => style.family).filter((family): family is string => Boolean(family)))], titleBodyRatio: titleSize / bodySize, weightContrast: Math.abs(titleWeight - bodyWeight), lineHeightRatio: 1 },
    geometry: { contentFrame, outerMargins: { x: contentFrame.x, y: contentFrame.y, w: artifact.source.slideSize.w - contentFrame.x - contentFrame.w, h: artifact.source.slideSize.h - contentFrame.y - contentFrame.h }, gutter: 0, spacingScale: 1 },
    surface: { usage: dividerUsage ? "sparse" : "none", borderUsage: 0, dividerUsage },
    branding: { primaryColors: colors.slice(0, 1), accentColors: colors.slice(1, 3) },
    compositionPatterns: [{ id: `derived-${family}`, family, functions: hasMetric ? ["quantitative"] : ["statement"], visualIntents: hasMetric ? ["single_focal"] : ["hierarchy"], density: "medium", confidence: 0.7 }],
  };
}

function parse(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
}

function all(scope: Document | Element, namespace: string, name: string): Element[] {
  return Array.from(scope.getElementsByTagNameNS(namespace, name));
}

function first(scope: Document | Element, namespace: string, name: string): Element | undefined {
  return all(scope, namespace, name)[0];
}

type RelEntry = { id: string; type: string; target: string };

function relEntries(xml: string): RelEntry[] {
  return all(parse(xml), REL_NS, "Relationship").map((node) => ({ id: node.getAttribute("Id") ?? "", type: node.getAttribute("Type") ?? "", target: node.getAttribute("Target") ?? "" }));
}

function rels(xml: string): Map<string, string> {
  return new Map(relEntries(xml).map((entry) => [entry.id, entry.target]));
}

/** The slide/layout/master relationship types care about — `Type` is a full URI, this only needs its tail. */
function relByTypeSuffix(entries: RelEntry[], suffix: string): RelEntry | undefined {
  return entries.find((entry) => entry.type.endsWith(suffix));
}

function packagePath(base: string, target: string): string {
  return target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join(base, target));
}

/** OOXML parts are always numbered (`slideLayout7.xml`, `slideMaster2.xml`) — that number is the
 * only stable, cheap identity for de-duplicating layouts/masters shared across many slides. */
function partNumber(partPath: string): number {
  return Number(partPath.match(/(\d+)\.xml$/)?.[1] ?? 0);
}

async function relsForPart(zip: JSZip, partPath: string): Promise<RelEntry[]> {
  const relsPath = `${path.posix.dirname(partPath)}/_rels/${path.posix.basename(partPath)}.rels`;
  const xml = await zip.file(relsPath)?.async("string");
  return xml ? relEntries(xml) : [];
}

type Transform = { x: number; y: number; sx: number; sy: number };
type Rect = { x: number; y: number; w: number; h: number };

function number(node: Element | undefined, name: string): number {
  return Number(node?.getAttribute(name) ?? "0");
}

function transform(node: Element, parent: Transform): { rect: Rect; child: Transform } {
  const xfrm = first(node, A_NS, "xfrm");
  const off = first(xfrm ?? node, A_NS, "off");
  const ext = first(xfrm ?? node, A_NS, "ext");
  const chOff = first(xfrm ?? node, A_NS, "chOff");
  const chExt = first(xfrm ?? node, A_NS, "chExt");
  const x = parent.x + (number(off, "x") - number(chOff, "x")) * parent.sx;
  const y = parent.y + (number(off, "y") - number(chOff, "y")) * parent.sy;
  const w = number(ext, "cx") * parent.sx;
  const h = number(ext, "cy") * parent.sy;
  return {
    rect: { x: x / EMU_PER_INCH, y: y / EMU_PER_INCH, w: w / EMU_PER_INCH, h: h / EMU_PER_INCH },
    child: { x, y, sx: parent.sx * (number(chExt, "cx") ? number(ext, "cx") / number(chExt, "cx") : 1), sy: parent.sy * (number(chExt, "cy") ? number(ext, "cy") / number(chExt, "cy") : 1) },
  };
}

function textStyle(node: Element): TemplateTextStyle | undefined {
  const run = first(node, A_NS, "rPr") ?? first(node, A_NS, "defRPr");
  const paragraph = first(node, A_NS, "pPr");
  if (!run && !paragraph) return undefined;
  const family = first(run ?? node, A_NS, "ea")?.getAttribute("typeface") ?? first(run ?? node, A_NS, "latin")?.getAttribute("typeface") ?? undefined;
  const color = run ? first(first(run, A_NS, "solidFill") ?? run, A_NS, "srgbClr")?.getAttribute("val")?.toUpperCase() : undefined;
  const size = Number(run?.getAttribute("sz") ?? "0");
  const weight = run?.getAttribute("b") === "1" ? 700 : undefined;
  const alignmentName = paragraph?.getAttribute("algn");
  const alignment = alignmentName === "l" ? "left" : alignmentName === "ctr" ? "center" : alignmentName === "r" ? "right" : undefined;
  const lineSpacing = first(paragraph ?? node, A_NS, "spcPct")?.getAttribute("val");
  const lineHeightRatio = lineSpacing ? Number(lineSpacing) / 100000 : undefined;
  return { family, sizePt: size ? size / 100 : undefined, weight, italic: run?.getAttribute("i") === "1" || undefined, color, alignment, lineHeightRatio };
}

function solidColor(node: Element | undefined): string | undefined {
  if (!node) return undefined;
  return first(node, A_NS, "srgbClr")?.getAttribute("val")?.toUpperCase() || undefined;
}

function elementStyle(node: Element, type: TemplateElement["type"]): TemplateTextStyle | undefined {
  const text = type === "text" ? textStyle(node) : undefined;
  const fill = type === "text" ? undefined : solidColor(first(node, A_NS, "solidFill"));
  const line = type === "text" ? undefined : first(node, A_NS, "ln");
  const stroke = solidColor(line);
  const strokeWidth = Number(line?.getAttribute("w") ?? "0");
  const style: TemplateTextStyle = {
    ...text,
    ...(fill ? { fill } : {}),
    ...(stroke ? { stroke } : {}),
    ...(strokeWidth > 0 ? { strokeWidthPt: strokeWidth / 12700 } : {}),
  };
  return Object.values(style).some((value) => value !== undefined) ? style : undefined;
}

function styleId(style: TemplateTextStyle, styles: Record<string, TemplateTextStyle>): string | undefined {
  if (Object.values(style).every((value) => value === undefined)) return undefined;
  const encoded = JSON.stringify(style);
  const existing = Object.entries(styles).find(([, value]) => JSON.stringify(value) === encoded)?.[0];
  if (existing) return existing;
  const id = `style-${crypto.createHash("sha256").update(encoded).digest("hex").slice(0, 12)}`;
  styles[id] = style;
  return id;
}

function elementId(node: Element, slideId: string, index: number): string {
  const name = first(node, P_NS, "cNvPr")?.getAttribute("name") ?? "element";
  return `${slideId}-${name.replace(/[^A-Za-z0-9_-]+/g, "-")}-${index + 1}`;
}

const PLACEHOLDER_TOKEN = /^[\[{<]{1,2}\s*([^\]}>]{1,40}?)\s*[\]}>]{1,2}$/;

function feature(node: Element): TemplateElement["features"] {
  const text = all(node, A_NS, "t").map((part) => part.textContent ?? "").join("");
  // A template's own declarations, not our guesses: <p:ph type> is what PowerPoint binds a shape to,
  // and cNvPr/@descr is where a designer writes what a shape is for when the name is generic.
  const placeholderType = first(node, P_NS, "ph")?.getAttribute("type") ?? undefined;
  const altText = first(node, P_NS, "cNvPr")?.getAttribute("descr") || undefined;
  const placeholderToken = text.trim().match(PLACEHOLDER_TOKEN)?.[1];
  const base = { placeholderType, altText, placeholderToken };
  return text
    ? { ...base, charCount: text.length, lineCount: Math.max(1, text.split(/\r?\n/).length), numericOnly: /^\s*[\d.,%¥$]+\s*$/.test(text) || undefined }
    : base;
}

function typeOf(node: Element): TemplateElement["type"] | undefined {
  if (node.namespaceURI !== P_NS) return undefined;
  if (node.localName === "pic") return "image";
  if (node.localName === "graphicFrame") return first(node, A_NS, "tbl") ? "table" : first(node, C_NS, "chart") || (first(node, A_NS, "graphicData")?.getAttribute("uri") ?? "").includes("/chart") ? "chart" : undefined;
  if (node.localName !== "sp") return undefined;
  if (first(node, A_NS, "t")) return "text";
  return first(node, A_NS, "prstGeom")?.getAttribute("prst") === "line" ? "line" : "shape";
}

function children(node: Element): Element[] {
  return Array.from(node.childNodes).filter((child): child is Element => child.nodeType === 1) as Element[];
}

function backgroundColor(xml: string): string | undefined {
  const root = parse(xml);
  const background = first(root, P_NS, "bg");
  return solidColor(background ? first(background, A_NS, "solidFill") : undefined);
}

function extractSlide(xml: string, slideId: string, styles: Record<string, TemplateTextStyle>, ownership: ElementOwnership): TemplateElement[] {
  const root = first(parse(xml), P_NS, "spTree");
  if (!root) return [];
  const elements: TemplateElement[] = [];
  const walk = (nodes: Element[], parent: Transform): void => {
    for (const node of nodes) {
      if (node.localName === "grpSp") {
        const group = transform(node, parent);
        walk(children(node), group.child);
        continue;
      }
      const type = typeOf(node);
      if (!type) continue;
      const bounds = transform(node, parent).rect;
      const name = first(node, P_NS, "cNvPr")?.getAttribute("name") ?? "";
      elements.push({ id: elementId(node, slideId, elements.length), name, slideId, type, role: "unknown", confidence: 0, bounds, zIndex: elements.length, ownership, styleRef: styleId(elementStyle(node, type) ?? {}, styles), features: feature(node) });
    }
  };
  walk(children(root), { x: 0, y: 0, sx: 1, sy: 1 });
  return elements;
}

// Named, tunable thresholds rather than inline magic numbers — the upgrade path when a real
// template misclassifies is to adjust these against a labeled corpus, not to rewrite the heuristic.
// ponytail: no calibration corpus exists yet; revisit once PR F's GAO run and a few more real
// templates have run through this.
const EMPTY_LAYOUT_ELEMENT_THRESHOLD = 2;
// A real template's "empty" layout still declares zero-sized placeholder metadata (date/footer/
// slide-number placeholders positioned at 0,0,0,0 — PowerPoint keeps these even on a layout named
// "Blank"). Counting every element regardless of size treated a real GAO template's genuinely
// bodyless layout as non-empty (3 raw elements > threshold 2), misdetecting native_layout instead
// of source_slide_pattern. Only elements with real geometry count toward "this layout has design
// content" — a placeholder declaration with no size is metadata, not a design element.
function hasRealGeometry(element: Pick<TemplateElement, "bounds">): boolean {
  return element.bounds.w > 0 && element.bounds.h > 0;
}
const BLANK_LAYOUT_SHARE_THRESHOLD = 0.8;
const NATIVE_LAYOUT_SHARE_THRESHOLD = 0.2;
const MIN_MEDIAN_BODY_ELEMENTS = 3;
const MIN_VISUAL_DIVERSITY = 0.5;

/**
 * `blankLayoutShare` is measured by how few elements the bound layout itself contributes — never
 * by the layout's display name. Names are locale- and theme-dependent ("Blank" is English only by
 * coincidence); emptiness is the actual signal a template author left when the design lives in the
 * slide bodies instead.
 */
export function detectTemplateStrategy(artifact: Pick<TemplateElementsArtifact, "slides" | "layouts">): TemplateStrategy {
  const totalSlides = artifact.slides.length;
  if (totalSlides === 0) return "native_layout";
  const layoutByIndex = new Map(artifact.layouts.map((layout) => [layout.index, layout]));
  const emptyLayoutSlides = artifact.slides.filter((slide) => (layoutByIndex.get(slide.nativeLayout.index)?.elements.filter(hasRealGeometry).length ?? 0) <= EMPTY_LAYOUT_ELEMENT_THRESHOLD).length;
  const blankLayoutShare = emptyLayoutSlides / totalSlides;
  const bodyCounts = artifact.slides.map((slide) => slide.elements.length).sort((a, b) => a - b);
  const medianSlideBodyElements = bodyCounts[Math.floor(bodyCounts.length / 2)] ?? 0;
  // Distinct "shape signatures" (sorted type:role multiset) across slide bodies — a template whose
  // slides are all genuinely different compositions (cover vs. editorial body vs. key-message band)
  // has high diversity even though every slide sits on the same near-empty layout; a template that
  // repeats one body shape over and over does not, and that distinction is exactly what separates a
  // real source_slide_pattern template from a broken/degenerate one.
  const signatures = new Set(artifact.slides.map((slide) => slide.elements.map((element) => `${element.type}:${element.role}`).sort().join("|")));
  const visualPatternDiversity = signatures.size / totalSlides;

  if (blankLayoutShare >= BLANK_LAYOUT_SHARE_THRESHOLD && medianSlideBodyElements >= MIN_MEDIAN_BODY_ELEMENTS && visualPatternDiversity >= MIN_VISUAL_DIVERSITY) {
    return "source_slide_pattern";
  }
  if (blankLayoutShare <= NATIVE_LAYOUT_SHARE_THRESHOLD) return "native_layout";
  return "hybrid";
}

export async function extractTemplateElements(pptxPath: string, overrides: Record<string, SemanticRole> = {}): Promise<TemplateElementsArtifact> {
  const bytes = fs.readFileSync(path.resolve(pptxPath));
  const zip = await JSZip.loadAsync(bytes);
  const presentationXml = await zip.file("ppt/presentation.xml")?.async("string");
  const presentationRels = await zip.file("ppt/_rels/presentation.xml.rels")?.async("string");
  if (!presentationXml || !presentationRels) throw new Error("PPTX is missing presentation relationships.");
  const presentation = parse(presentationXml);
  const size = first(presentation, P_NS, "sldSz");
  const slideSize = { w: number(size, "cx") / EMU_PER_INCH, h: number(size, "cy") / EMU_PER_INCH };
  const targets = rels(presentationRels);
  const styles: Record<string, TemplateTextStyle> = {};
  const slides: TemplateElementsArtifact["slides"] = [];
  const layoutCache = new Map<number, TemplateLayoutInfo>();
  const masterCache = new Map<number, TemplateMasterInfo>();

  async function resolveMaster(layoutPartPath: string): Promise<number> {
    const layoutRels = await relsForPart(zip, layoutPartPath);
    const masterRel = relByTypeSuffix(layoutRels, "/slideMaster");
    if (!masterRel) return 0;
    const masterPartPath = packagePath(path.posix.dirname(layoutPartPath), masterRel.target);
    const masterIndex = partNumber(masterPartPath);
    if (!masterCache.has(masterIndex)) {
      const masterXml = await zip.file(masterPartPath)?.async("string");
      const masterElements = masterXml ? extractSlide(masterXml, `master-${masterIndex}`, styles, "master-owned") : [];
      masterCache.set(masterIndex, { index: masterIndex, elements: masterElements, background: masterXml ? backgroundColor(masterXml) : undefined });
    }
    return masterIndex;
  }

  async function resolveLayout(slidePartPath: string): Promise<{ index: number; name: string; masterIndex: number }> {
    const slideRels = await relsForPart(zip, slidePartPath);
    const layoutRel = relByTypeSuffix(slideRels, "/slideLayout");
    if (!layoutRel) return { index: 0, name: "", masterIndex: 0 };
    const layoutPartPath = packagePath(path.posix.dirname(slidePartPath), layoutRel.target);
    const layoutIndex = partNumber(layoutPartPath);
    if (!layoutCache.has(layoutIndex)) {
      const layoutXml = await zip.file(layoutPartPath)?.async("string");
      const layoutName = layoutXml ? (first(parse(layoutXml), P_NS, "cSld")?.getAttribute("name") ?? "") : "";
      const layoutElements = layoutXml ? extractSlide(layoutXml, `layout-${layoutIndex}`, styles, "layout-owned") : [];
      const masterIndex = await resolveMaster(layoutPartPath);
      layoutCache.set(layoutIndex, { index: layoutIndex, name: layoutName, masterIndex, elements: layoutElements, background: layoutXml ? backgroundColor(layoutXml) : undefined });
    }
    const layout = layoutCache.get(layoutIndex)!;
    return { index: layout.index, name: layout.name, masterIndex: layout.masterIndex };
  }

  for (const [index, slide] of all(presentation, P_NS, "sldId").entries()) {
    const target = targets.get(slide.getAttributeNS(R_NS, "id") ?? "");
    if (!target) continue;
    const slidePartPath = packagePath("ppt", target);
    const xml = await zip.file(slidePartPath)?.async("string");
    if (!xml) throw new Error(`PPTX slide part is missing: ${target}`);
    const id = `S${String(index + 1).padStart(2, "0")}`;
    const nativeLayout = await resolveLayout(slidePartPath);
    slides.push({ id, sourceSlidePart: slidePartPath, nativeLayout, elements: extractSlide(xml, id, styles, "slide-body-owned"), background: backgroundColor(xml) });
  }

  const templateDigest = crypto.createHash("sha256").update(bytes).digest("hex");
  const raw: TemplateElementsArtifact = {
    version: 1,
    source: { sha256: templateDigest, slideSize },
    analysisInputs: { templateDigest, roleOverridesDigest: roleOverridesDigest(overrides), analyzerVersion: TEMPLATE_ANALYZER_VERSION },
    slides,
    layouts: [...layoutCache.values()].sort((a, b) => a.index - b.index),
    masters: [...masterCache.values()].sort((a, b) => a.index - b.index),
    styles,
    strategy: "native_layout",
  };
  const classified = classifyTemplateElements(raw, overrides);
  return { ...classified, strategy: detectTemplateStrategy(classified) };
}
