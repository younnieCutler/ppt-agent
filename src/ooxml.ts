import fs from "node:fs";
import JSZip from "jszip";

// ponytail: regex over the raw part XML instead of a full XML/DOM parser. This is safe because
// every part read here is produced by our own deterministic renderer (pptxgenjs), not arbitrary
// third-party XML — the shapes it emits are well-known and stable. If a future renderer change
// (or a Company Template Pack fill) introduces XML this can't see through, add a real parser then.

export type NativeObjectCounts = { text: number; shapes: number; connectors: number; table: number; chart: number; source_image: number };

export type SlideOoxmlFacts = {
  typefaces: string[];
  nativeObjects: NativeObjectCounts;
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

const EAST_ASIAN_PATTERN = /[぀-ヿ㐀-䶿一-鿿가-힣豈-﫿]/;

function attr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`));
  return match?.[1];
}

function typefacesIn(xml: string): string[] {
  return [...xml.matchAll(/<a:(?:latin|ea|cs)\s+typeface="([^"]*)"/g)].map((match) => match[1]).filter((typeface) => typeface.length > 0);
}

function visibleTextIn(xml: string): string {
  return [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => match[1]).join(" ");
}

function slideSizeIn(presentationXml: string): { cx: number; cy: number } {
  const tag = presentationXml.match(/<p:sldSz[^/]*\/>/)?.[0] ?? "";
  return { cx: Number(attr(tag, "cx") ?? "0"), cy: Number(attr(tag, "cy") ?? "0") };
}

function shapeXmlBlocks(xml: string, tag: string): string[] {
  return xml.match(new RegExp(`<${tag}>.*?</${tag}>`, "gs")) ?? [];
}

function analyzeSlide(xml: string, slideSize: { cx: number; cy: number }): SlideOoxmlFacts {
  const nativeObjects: NativeObjectCounts = { text: 0, shapes: 0, connectors: 0, table: 0, chart: 0, source_image: 0 };
  let fullSlideImage = false;

  for (const pic of shapeXmlBlocks(xml, "p:pic")) {
    nativeObjects.source_image += 1;
    const ext = pic.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"\/>/);
    if (ext && slideSize.cx > 0 && slideSize.cy > 0) {
      const [, cx, cy] = ext;
      if (Number(cx) / slideSize.cx > 0.95 && Number(cy) / slideSize.cy > 0.95) fullSlideImage = true;
    }
  }
  for (const frame of shapeXmlBlocks(xml, "p:graphicFrame")) {
    if (frame.includes("<a:tbl>")) nativeObjects.table += 1;
    if (frame.includes("c:chart")) nativeObjects.chart += 1;
  }
  nativeObjects.connectors += shapeXmlBlocks(xml, "p:cxnSp").length;
  for (const sp of shapeXmlBlocks(xml, "p:sp")) {
    const isLine = /prstGeom\s+prst="line"/.test(sp);
    if (isLine) {
      // The deterministic renderer draws pipeline/architecture/roadmap edges as a plain line
      // autoshape rather than a true `p:cxnSp` connector. Level 1 QA treats it as satisfying a
      // `connectors` requirement; Level 3 PowerPoint QA is stricter (checks `shape.Connector`).
      nativeObjects.connectors += 1;
      continue;
    }
    const hasVisibleText = /<a:t>[^<]*\S[^<]*<\/a:t>/.test(sp);
    if (hasVisibleText) nativeObjects.text += 1;
    else nativeObjects.shapes += 1;
  }

  const typefaces = [...new Set(typefacesIn(xml))];
  const eastAsianTypefaces = [...xml.matchAll(/<a:ea\s+typeface="([^"]*)"/g)].map((match) => match[1]).filter((typeface) => typeface.length > 0);
  const visibleText = visibleTextIn(xml);
  return {
    typefaces,
    nativeObjects,
    fullSlideImage: fullSlideImage && nativeObjects.text === 0,
    hasEastAsianText: EAST_ASIAN_PATTERN.test(visibleText),
    hasEastAsianTypeface: eastAsianTypefaces.length > 0,
  };
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

  const relTargets = new Map([...presentationRels.matchAll(/<Relationship\s+Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((match) => [match[1], match[2]]));
  const orderedRelIds = [...presentationXml.matchAll(/<p:sldId\s+id="\d+"\s+r:id="([^"]+)"\/>/g)].map((match) => match[1]);
  const slidePaths = orderedRelIds.map((relId) => relTargets.get(relId)).filter((target): target is string => Boolean(target));
  if (slidePaths.length === 0) return empty;

  const slideSize = slideSizeIn(presentationXml);
  const slides: SlideOoxmlFacts[] = [];
  for (const relativePath of slidePaths) {
    const xml = await zip.file(`ppt/${relativePath}`)?.async("string");
    if (xml === undefined) return empty;
    slides.push(analyzeSlide(xml, slideSize));
  }

  const embeddedFonts = Object.keys(zip.files).some((name) => name.startsWith("ppt/fonts/") && name.endsWith(".fntdata"));
  return { parseOk: true, slideCount: slides.length, embeddedFonts, slides };
}
