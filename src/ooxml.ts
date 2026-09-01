import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

// Parsed as XML, not regex: a raw PowerPoint template ships arbitrary package parts whose
// prefixes, attribute order, nesting (grouped shapes), and whitespace are outside our control.
// Lookups are namespace-based so a template that binds `pp:` instead of `p:` still reads correctly.

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const C_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

export type NativeObjectCounts = { text: number; shapes: number; connectors: number; table: number; chart: number; source_image: number };

export type SlideOoxmlFacts = {
  typefaces: string[];
  nativeObjects: NativeObjectCounts;
  chartColors: string[][];
  /** Gradient fills authored by the renderer (slide shapes) or a native chart — never template chrome. */
  gradientFills: number;
  fullSlideImage: boolean;
  hasEastAsianText: boolean;
  hasEastAsianTypeface: boolean;
};

export type PptxOoxmlFacts = {
  parseOk: boolean;
  slideCount: number;
  embeddedFonts: boolean;
  slides: SlideOoxmlFacts[];
};

const EAST_ASIAN_PATTERN = /[぀-ヿ㐀-䶿一-鿿가-힣豈-﫿]/;

// xmldom reports parse problems through a handler instead of throwing.
function parseXml(xml: string): Document | undefined {
  let failed = false;
  const document = new DOMParser({
    onError: (level) => {
      if (level !== "warning") failed = true;
    },
  }).parseFromString(xml, "text/xml");
  return failed || !document?.documentElement ? undefined : (document as unknown as Document);
}

function elements(scope: Document | Element, namespace: string, localName: string): Element[] {
  return Array.from(scope.getElementsByTagNameNS(namespace, localName));
}

function textOf(node: Element): string {
  return node.textContent ?? "";
}

function typefacesIn(scope: Element): string[] {
  return ["latin", "ea", "cs"]
    .flatMap((localName) => elements(scope, A_NS, localName))
    .map((node) => node.getAttribute("typeface") ?? "")
    .filter((typeface) => typeface.length > 0);
}

function chartColorsIn(chartXml: string): string[] {
  const document = parseXml(chartXml);
  if (!document) return [];
  const colors = elements(document, C_NS, "ser")
    .flatMap((series) => elements(series, C_NS, "spPr"))
    .flatMap((properties) => elements(properties, A_NS, "solidFill"))
    .flatMap((fill) => elements(fill, A_NS, "srgbClr"))
    .map((color) => (color.getAttribute("val") ?? "").toUpperCase())
    .filter((color) => color.length > 0);
  return [...new Set(colors)];
}

function chartGradientCount(chartXml: string): number {
  const document = parseXml(chartXml);
  return document ? elements(document, A_NS, "gradFill").length : 0;
}

function analyzeSlide(xml: string, slideSize: { cx: number; cy: number }, chartParts: string[]): SlideOoxmlFacts | undefined {
  const document = parseXml(xml);
  if (!document) return undefined;
  const nativeObjects: NativeObjectCounts = { text: 0, shapes: 0, connectors: 0, table: 0, chart: 0, source_image: 0 };
  let fullSlideImage = false;

  const pictures = elements(document, P_NS, "pic");
  pictures.forEach((picture) => {
    nativeObjects.source_image += 1;
    const extent = elements(picture, A_NS, "ext")[0];
    const cx = Number(extent?.getAttribute("cx") ?? "0");
    const cy = Number(extent?.getAttribute("cy") ?? "0");
    if (slideSize.cx > 0 && slideSize.cy > 0 && cx / slideSize.cx > 0.95 && cy / slideSize.cy > 0.95) fullSlideImage = true;
  });

  const frames = elements(document, P_NS, "graphicFrame");
  frames.forEach((frame) => {
    if (elements(frame, A_NS, "tbl").length > 0) nativeObjects.table += 1;
    const graphicData = elements(frame, A_NS, "graphicData")[0];
    if (elements(frame, C_NS, "chart").length > 0 || (graphicData?.getAttribute("uri") ?? "").includes("/chart")) nativeObjects.chart += 1;
  });

  nativeObjects.connectors += elements(document, P_NS, "cxnSp").length;
  const shapes = elements(document, P_NS, "sp");
  shapes.forEach((shape) => {
    // The deterministic renderer draws pipeline/architecture/roadmap edges as a plain line
    // autoshape rather than a true `p:cxnSp` connector. Level 1 QA treats it as satisfying a
    // `connectors` requirement; Level 3 PowerPoint QA is stricter (checks `shape.Connector`).
    if (elements(shape, A_NS, "prstGeom").some((geometry) => geometry.getAttribute("prst") === "line")) {
      nativeObjects.connectors += 1;
      return;
    }
    if (elements(shape, A_NS, "t").some((run) => textOf(run).trim().length > 0)) nativeObjects.text += 1;
    else nativeObjects.shapes += 1;
  });

  // Everything the slide part itself authors — background, shapes, frames, native charts — minus
  // a picture's own artwork. Template master/layout chrome lives in other parts and is never read
  // here, so source-template master/layout gradients stay out of this count by construction.
  const gradientFills = elements(document, A_NS, "gradFill").length
    - pictures.reduce((total, picture) => total + elements(picture, A_NS, "gradFill").length, 0)
    + chartParts.reduce((total, chartXml) => total + chartGradientCount(chartXml), 0);

  const root = document.documentElement as unknown as Element;
  const typefaces = [...new Set(typefacesIn(root))];
  const eastAsianTypefaces = elements(root, A_NS, "ea").map((node) => node.getAttribute("typeface") ?? "").filter((typeface) => typeface.length > 0);
  const visibleText = elements(root, A_NS, "t").map(textOf).join(" ");
  return {
    typefaces,
    nativeObjects,
    chartColors: chartParts.map(chartColorsIn),
    gradientFills,
    fullSlideImage: fullSlideImage && nativeObjects.text === 0,
    hasEastAsianText: EAST_ASIAN_PATTERN.test(visibleText),
    hasEastAsianTypeface: eastAsianTypefaces.length > 0,
  };
}

function relationshipTargets(relsXml: string): Map<string, { target: string; type: string }> {
  const document = parseXml(relsXml);
  if (!document) return new Map();
  return new Map(
    elements(document, PKG_REL_NS, "Relationship").map((relationship) => [
      relationship.getAttribute("Id") ?? "",
      { target: relationship.getAttribute("Target") ?? "", type: relationship.getAttribute("Type") ?? "" },
    ]),
  );
}

function packagePath(base: string, target: string): string {
  // OOXML package paths are always POSIX, even on Windows.
  return target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join(base, target));
}

export async function readPptxOoxml(pptxPath: string): Promise<PptxOoxmlFacts> {
  const empty: PptxOoxmlFacts = { parseOk: false, slideCount: 0, embeddedFonts: false, slides: [] };
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
  } catch {
    return empty;
  }

  const contentTypes = await zip.file("[Content_Types].xml")?.async("string");
  const presentationXml = await zip.file("ppt/presentation.xml")?.async("string");
  const presentationRels = await zip.file("ppt/_rels/presentation.xml.rels")?.async("string");
  if (!contentTypes || !presentationXml || !presentationRels) return empty;

  const presentation = parseXml(presentationXml);
  if (!presentation) return empty;
  const relTargets = relationshipTargets(presentationRels);
  const slidePaths = elements(presentation, P_NS, "sldId")
    .map((slideId) => relTargets.get(slideId.getAttributeNS(R_NS, "id") ?? "")?.target)
    .filter((target): target is string => Boolean(target));
  if (slidePaths.length === 0) return empty;

  const sldSz = elements(presentation, P_NS, "sldSz")[0];
  const slideSize = { cx: Number(sldSz?.getAttribute("cx") ?? "0"), cy: Number(sldSz?.getAttribute("cy") ?? "0") };

  const slides: SlideOoxmlFacts[] = [];
  for (const relativePath of slidePaths) {
    const slidePackagePath = packagePath("ppt", relativePath);
    const xml = await zip.file(slidePackagePath)?.async("string");
    if (xml === undefined) return empty;
    const slideDir = path.posix.dirname(slidePackagePath);
    const slideRels = await zip.file(`${slideDir}/_rels/${path.posix.basename(slidePackagePath)}.rels`)?.async("string");
    const chartTargets = slideRels
      ? [...relationshipTargets(slideRels).values()].filter((relationship) => relationship.type.endsWith("/chart")).map((relationship) => relationship.target)
      : [];
    const chartParts = (await Promise.all(chartTargets.map(async (target) => (await zip.file(packagePath(slideDir, target))?.async("string")) ?? ""))).filter(Boolean);
    const facts = analyzeSlide(xml, slideSize, chartParts);
    if (!facts) return empty;
    slides.push(facts);
  }

  const embeddedFonts = Object.keys(zip.files).some((name) => name.startsWith("ppt/fonts/") && name.endsWith(".fntdata"));
  return { parseOk: true, slideCount: slides.length, embeddedFonts, slides };
}

function relationshipPath(source: string): string {
  if (!source) return "_rels/.rels";
  const dir = path.posix.dirname(source);
  return path.posix.join(dir, "_rels", `${path.posix.basename(source)}.rels`);
}

/** Removes orphan template parts after pptx-automizer replaces example slides. */
export async function pruneUnreachablePptxParts(pptxPath: string): Promise<void> {
  const resolved = path.resolve(pptxPath);
  const zip = await JSZip.loadAsync(fs.readFileSync(resolved));
  const retained = new Set<string>(["[Content_Types].xml", "_rels/.rels"]);
  for (const name of Object.keys(zip.files)) {
    if (name.startsWith("docProps/") || ["ppt/presProps.xml", "ppt/viewProps.xml", "ppt/tableStyles.xml"].includes(name)) retained.add(name);
  }
  const queue = [""];
  while (queue.length > 0) {
    const source = queue.shift()!;
    const relPath = relationshipPath(source);
    const xml = await zip.file(relPath)?.async("string");
    if (!xml) continue;
    retained.add(relPath);
    const document = parseXml(xml);
    if (!document) throw new Error(`Invalid OOXML relationships: ${relPath}`);
    for (const relationship of elements(document, PKG_REL_NS, "Relationship")) {
      if (relationship.getAttribute("TargetMode") === "External") continue;
      const target = relationship.getAttribute("Target");
      if (!target) continue;
      const targetPath = packagePath(source ? path.posix.dirname(source) : "", target);
      if (!zip.file(targetPath) || retained.has(targetPath)) continue;
      retained.add(targetPath);
      queue.push(targetPath);
    }
  }
  const removed = Object.keys(zip.files).filter((name) => !name.endsWith("/") && !retained.has(name));
  for (const name of removed) zip.remove(name);
  const typesXml = await zip.file("[Content_Types].xml")?.async("string");
  const types = typesXml ? parseXml(typesXml) : undefined;
  if (types) {
    for (const override of elements(types, "http://schemas.openxmlformats.org/package/2006/content-types", "Override")) {
      const partName = (override.getAttribute("PartName") ?? "").replace(/^\//, "");
      if (removed.includes(partName)) override.parentNode?.removeChild(override);
    }
    // parseXml hands back the global Document typing; serializeToString wants xmldom's own node type.
    const serializable = types as unknown as Parameters<XMLSerializer["serializeToString"]>[0];
    zip.file("[Content_Types].xml", new XMLSerializer().serializeToString(serializable));
  }
  const temporary = `${resolved}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, await zip.generateAsync({ type: "nodebuffer" }));
  fs.renameSync(temporary, resolved);
}
