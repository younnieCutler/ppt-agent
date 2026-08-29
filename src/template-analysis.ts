import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const C_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const EMU_PER_INCH = 914400;

export const semanticRoles = ["title", "subtitle", "heading", "body", "caption", "eyebrow", "label", "key_message", "metric", "metric_label", "annotation", "step", "route", "source", "logo", "footer", "surface", "divider"] as const;
export type SemanticRole = (typeof semanticRoles)[number];
export type TemplateTextStyle = { family?: string; sizePt?: number; weight?: number; italic?: boolean; color?: string; lineHeightRatio?: number; alignment?: "left" | "center" | "right" };
export type TemplateElement = { id: string; slideId: string; type: "text" | "shape" | "line" | "image" | "chart" | "table"; role: SemanticRole | "unknown"; confidence: number; bounds: { x: number; y: number; w: number; h: number }; zIndex: number; styleRef?: string; assetRef?: string; features: { charCount?: number; lineCount?: number; numericOnly?: boolean; placeholderToken?: string } };
export type TemplateElementsArtifact = { version: 1; source: { sha256: string; slideSize: { w: number; h: number } }; slides: Array<{ id: string; elements: TemplateElement[] }>; styles: Record<string, TemplateTextStyle> };

export function classifyTemplateElement(element: Pick<TemplateElement, "id" | "type" | "bounds" | "features">, slideSize: { w: number; h: number }, overrides: Record<string, SemanticRole> = {}): Pick<TemplateElement, "role" | "confidence"> {
  if (overrides[element.id]) return { role: overrides[element.id], confidence: 1 };
  const name = element.id.toLowerCase();
  if (/title|headline/.test(name)) return { role: "title", confidence: 0.95 };
  if (/footer/.test(name)) return element.bounds.y + element.bounds.h >= slideSize.h * 0.9 ? { role: "footer", confidence: 0.85 } : { role: "unknown", confidence: 0 };
  if (/logo/.test(name) && element.type === "image") return { role: "logo", confidence: 0.9 };
  if (/divider|line/.test(name) || element.type === "line") return { role: "divider", confidence: 0.8 };
  if (element.type === "text" && element.features.numericOnly && element.bounds.w >= slideSize.w * 0.15) return { role: "metric", confidence: 0.75 };
  return { role: "unknown", confidence: 0 };
}

export function classifyTemplateElements(artifact: TemplateElementsArtifact, overrides: Record<string, SemanticRole> = {}): TemplateElementsArtifact {
  return {
    ...artifact,
    slides: artifact.slides.map((slide) => ({
      ...slide,
      elements: slide.elements.map((element) => ({ ...element, ...classifyTemplateElement(element, artifact.source.slideSize, overrides) })),
    })),
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

function feature(node: Element): TemplateElement["features"] {
  const text = all(node, A_NS, "t").map((part) => part.textContent ?? "").join("");
  return text ? { charCount: text.length, lineCount: Math.max(1, text.split(/\r?\n/).length), numericOnly: /^\s*[\d.,%¥$]+\s*$/.test(text) || undefined } : {};
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

export async function extractTemplateElements(pptxPath: string): Promise<TemplateElementsArtifact> {
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
  return classifyTemplateElements({ version: 1, source: { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), slideSize }, slides, styles });
}
