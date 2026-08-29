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
export type TemplateTextStyle = { family?: string; sizePt?: number; weight?: number; italic?: boolean; color?: string; lineHeightRatio?: number; alignment?: "left" | "center" | "right" };
export type TemplateElement = { id: string; slideId: string; type: "text" | "shape" | "line" | "image" | "chart" | "table"; role: SemanticRole | "unknown"; confidence: number; bounds: { x: number; y: number; w: number; h: number }; zIndex: number; styleRef?: string; assetRef?: string; features: { charCount?: number; lineCount?: number; numericOnly?: boolean; placeholderToken?: string; placeholderType?: string; altText?: string } };
export type TemplateElementsArtifact = { version: 1; source: { sha256: string; slideSize: { w: number; h: number } }; slides: Array<{ id: string; elements: TemplateElement[] }>; styles: Record<string, TemplateTextStyle> };
export type TemplateGrammar = {
  version: 1;
  compilerVersion: string;
  sourceDigest: string;
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

function typographyContext(element: TemplateElement, siblings: TemplateElement[], styles: Record<string, TemplateTextStyle>): TypographyContext {
  const sizes = siblings.filter((sibling) => sibling.type === "text").map((sibling) => (sibling.styleRef ? styles[sibling.styleRef]?.sizePt : undefined)).filter((size): size is number => Boolean(size)).sort((a, b) => a - b);
  if (sizes.length === 0) return {};
  return { sizePt: element.styleRef ? styles[element.styleRef]?.sizePt : undefined, maxSizePt: sizes[sizes.length - 1], medianSizePt: sizes[Math.floor(sizes.length / 2)] };
}

export function classifyTemplateElements(artifact: TemplateElementsArtifact, overrides: Record<string, SemanticRole> = {}): TemplateElementsArtifact {
  return {
    ...artifact,
    slides: artifact.slides.map((slide) => ({
      ...slide,
      elements: slide.elements.map((element) => ({ ...element, ...classifyTemplateElement(element, artifact.source.slideSize, overrides, typographyContext(element, slide.elements, artifact.styles)) })),
    })),
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
    compilerVersion: "1",
    sourceDigest: artifact.source.sha256,
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

function rels(xml: string): Map<string, string> {
  return new Map(all(parse(xml), REL_NS, "Relationship").map((node) => [node.getAttribute("Id") ?? "", node.getAttribute("Target") ?? ""]));
}

function packagePath(base: string, target: string): string {
  return target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join(base, target));
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
  if (!run) return undefined;
  const family = first(run, A_NS, "ea")?.getAttribute("typeface") ?? first(run, A_NS, "latin")?.getAttribute("typeface") ?? undefined;
  const color = first(first(run, A_NS, "solidFill") ?? run, A_NS, "srgbClr")?.getAttribute("val")?.toUpperCase();
  const size = Number(run.getAttribute("sz") ?? "0");
  const weight = run.getAttribute("b") === "1" ? 700 : undefined;
  return { family, sizePt: size ? size / 100 : undefined, weight, italic: run.getAttribute("i") === "1" || undefined, color };
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

function extractSlide(xml: string, slideId: string, styles: Record<string, TemplateTextStyle>): TemplateElement[] {
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
      elements.push({ id: elementId(node, slideId, elements.length), slideId, type, role: "unknown", confidence: 0, bounds, zIndex: elements.length, styleRef: type === "text" ? styleId(textStyle(node) ?? {}, styles) : undefined, features: feature(node) });
    }
  };
  walk(children(root), { x: 0, y: 0, sx: 1, sy: 1 });
  return elements;
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
  const slides = [];
  for (const [index, slide] of all(presentation, P_NS, "sldId").entries()) {
    const target = targets.get(slide.getAttributeNS(R_NS, "id") ?? "");
    if (!target) continue;
    const xml = await zip.file(packagePath("ppt", target))?.async("string");
    if (!xml) throw new Error(`PPTX slide part is missing: ${target}`);
    const id = `S${String(index + 1).padStart(2, "0")}`;
    slides.push({ id, elements: extractSlide(xml, id, styles) });
  }
  return classifyTemplateElements({ version: 1, source: { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), slideSize }, slides, styles }, overrides);
}
