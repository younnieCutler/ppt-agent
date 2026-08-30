import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import pptxgen from "pptxgenjs";
import { describe, expect, it } from "vitest";
import { extractTemplateElements } from "../../src/template-analysis";
import { compileTemplateComponents } from "../../src/template-components";
import { transformTemplateComponents } from "../../src/template-transform";

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const EMU_PER_INCH = 914400;

async function fixture(withTarget = false, withGraphicFrame = false, blankTarget = false): Promise<{ path: string; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-component-transform-"));
  const output = path.join(dir, "template.pptx");
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  const slide = pptx.addSlide();
  slide.background = { color: "FFFFFF" };
  slide.addText("SOURCE EXAMPLE", { x: 1, y: 1, w: 4, h: 0.6, fontFace: "Noto Sans KR", fontSize: 24, bold: true, color: "14181C", name: "Transform Title" });
  slide.addShape(pptx.ShapeType.line, { x: 1, y: 2, w: 4, h: 0, line: { color: "2F6FD0", width: 1 }, name: "Transform Divider" });
  slide.addImage({ data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+QyaA5AAAAABJRU5ErkJggg==", x: 8, y: 1, w: 2, h: 2, name: "Transform Image" });
  if (withGraphicFrame) slide.addTable([[{ text: "TABLE" }]], { x: 2, y: 4, w: 3, h: 1 });
  if (withTarget) {
    const target = pptx.addSlide();
    if (!blankTarget) target.addText("TARGET", { x: 1, y: 1, w: 3, h: 0.5, fontFace: "Noto Sans KR", fontSize: 18, color: "14181C" });
  }
  await pptx.writeFile({ fileName: output });
  return { path: output, dir };
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

function attrNumber(node: Element | undefined, name: string): number {
  return Number(node?.getAttribute(name) ?? 0);
}

describe("template component transformation engine", () => {
  it("applies semantic clone, resize, move, repeat, text replacement, and remove without leaking source content", async () => {
    const source = await fixture();
    const output = path.join(source.dir, "transformed.pptx");
    try {
      const elements = await extractTemplateElements(source.path);
      const titleElement = elements.slides[0].elements.find((element) => element.type === "text");
      if (titleElement) {
        titleElement.role = "title";
        titleElement.confidence = 1;
      }
      const components = compileTemplateComponents(elements);
      const titleId = components.components.find((component) => component.kind === "title_block")?.id;
      const dividerId = components.components.find((component) => component.kind === "divider")?.id;
      const mediaId = components.components.find((component) => component.kind === "media_frame")?.id;
      expect(titleId).toBeDefined();
      expect(dividerId).toBeDefined();
      expect(mediaId).toBeDefined();

      const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(source.path)).digest("hex");
      const result = await transformTemplateComponents(source.path, output, components, [
        { operation: "resize", componentId: titleId!, w: 5.5, h: 0.8 },
        { operation: "move", componentId: titleId!, x: 2, y: 1 },
        { operation: "clone", componentId: dividerId!, as: "clone-divider" },
        { operation: "clone", componentId: titleId!, as: "clone-title" },
        { operation: "replace_text", componentId: "clone-title", text: "CLONED TITLE" },
        { operation: "repeat", componentId: "clone-title", count: 2, offset: { x: 0, y: 1.2 }, as: "repeat-title" },
        { operation: "replace_text", componentId: "repeat-title.1", text: "REPEAT ONE" },
        { operation: "replace_text", componentId: "repeat-title.2", text: "REPEAT TWO" },
        { operation: "replace_text", componentId: titleId!, text: "FINAL TITLE" },
        { operation: "remove", componentId: mediaId! },
      ]);

      expect(result.createdComponents).toEqual(["clone-divider", "clone-title", "repeat-title.1", "repeat-title.2"]);
      expect(crypto.createHash("sha256").update(fs.readFileSync(source.path)).digest("hex")).toBe(sourceHash);

      const zip = await JSZip.loadAsync(fs.readFileSync(output));
      const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string");
      expect(slideXml).toBeDefined();
      const slide = parse(slideXml!);
      const texts = all(slide, A_NS, "t").map((node) => node.textContent ?? "");
      expect(texts).toEqual(expect.arrayContaining(["FINAL TITLE", "CLONED TITLE", "REPEAT ONE", "REPEAT TWO"]));
      expect(texts).not.toContain("SOURCE EXAMPLE");
      expect(all(slide, P_NS, "pic")).toHaveLength(0);
      expect(all(slide, P_NS, "sp").filter((shape) => first(shape, A_NS, "prstGeom")?.getAttribute("prst") === "line")).toHaveLength(2);
      expect(slideXml).toContain("2F6FD0");
      const finalTitle = all(slide, P_NS, "sp").find((shape) => all(shape, A_NS, "t").some((node) => node.textContent === "FINAL TITLE"));
      const finalTransform = first(finalTitle!, A_NS, "xfrm");
      expect(first(finalTransform!, A_NS, "off")?.getAttribute("x")).toBe(String(Math.round(2 * EMU_PER_INCH)));
      expect(first(finalTransform!, A_NS, "off")?.getAttribute("y")).toBe(String(Math.round(1 * EMU_PER_INCH)));
      expect(first(finalTransform!, A_NS, "ext")?.getAttribute("cx")).toBe(String(Math.round(5.5 * EMU_PER_INCH)));
      expect(first(finalTransform!, A_NS, "ext")?.getAttribute("cy")).toBe(String(Math.round(0.8 * EMU_PER_INCH)));

      const titleStyle = first(parse(await JSZip.loadAsync(fs.readFileSync(source.path)).then(async (sourceZip) => (await sourceZip.file("ppt/slides/slide1.xml")?.async("string"))!)), A_NS, "rPr");
      const outputStyles = all(slide, A_NS, "rPr");
      expect(outputStyles.some((style) => style.getAttribute("sz") === titleStyle?.getAttribute("sz") && style.getAttribute("b") === titleStyle?.getAttribute("b"))).toBe(true);

      for (const shape of all(slide, P_NS, "sp")) {
        const xfrm = first(shape, A_NS, "xfrm");
        const off = first(xfrm ?? shape, A_NS, "off");
        const ext = first(xfrm ?? shape, A_NS, "ext");
        const x = attrNumber(off, "x") / EMU_PER_INCH;
        const y = attrNumber(off, "y") / EMU_PER_INCH;
        const w = attrNumber(ext, "cx") / EMU_PER_INCH;
        const h = attrNumber(ext, "cy") / EMU_PER_INCH;
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x + w).toBeLessThanOrEqual(13.3334);
        expect(y + h).toBeLessThanOrEqual(7.5001);
      }
      expect(zip.file("ppt/media/image1.png")).toBeNull();
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("rejects an out-of-canvas transform before writing an output file", async () => {
    const source = await fixture();
    const output = path.join(source.dir, "overflow.pptx");
    try {
      const elements = await extractTemplateElements(source.path);
      const titleElement = elements.slides[0].elements.find((element) => element.type === "text");
      if (titleElement) titleElement.role = "title";
      const components = compileTemplateComponents(elements);
      const titleId = components.components.find((component) => component.kind === "title_block")?.id;
      await expect(transformTemplateComponents(source.path, output, components, [{ operation: "move", componentId: titleId!, x: 12, y: 1 }])).rejects.toThrow(/COMPONENT_TRANSFORM_OUT_OF_BOUNDS/);
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("rejects an output path that aliases the source through a symlinked directory", async () => {
    const source = await fixture();
    const aliasDir = path.join(source.dir, "source-alias");
    fs.symlinkSync(source.dir, aliasDir, "dir");
    try {
      const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(source.path)).digest("hex");
      const elements = await extractTemplateElements(source.path);
      const titleElement = elements.slides[0].elements.find((element) => element.type === "text");
      if (titleElement) titleElement.role = "title";
      const components = compileTemplateComponents(elements);
      const titleId = components.components.find((component) => component.kind === "title_block")?.id;
      await expect(transformTemplateComponents(source.path, path.join(aliasDir, "template.pptx"), components, [{ operation: "replace_text", componentId: titleId!, text: "ALIAS SAFE" }])).rejects.toThrow(/COMPONENT_TRANSFORM_SOURCE_IMMUTABLE/);
      expect(crypto.createHash("sha256").update(fs.readFileSync(source.path)).digest("hex")).toBe(sourceHash);
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("transforms a graphic-frame component through its p:xfrm bounds", async () => {
    const source = await fixture(false, true);
    const output = path.join(source.dir, "graphic-frame.pptx");
    try {
      const elements = await extractTemplateElements(source.path);
      const components = compileTemplateComponents(elements);
      const tableId = components.components.find((component) => component.assetProvenance.kind === "table")?.id;
      expect(tableId).toBeDefined();
      await transformTemplateComponents(source.path, output, components, [
        { operation: "resize", componentId: tableId!, w: 4, h: 1.5 },
        { operation: "move", componentId: tableId!, x: 4, y: 4.5 },
      ]);
      const zip = await JSZip.loadAsync(fs.readFileSync(output));
      const slide = parse((await zip.file("ppt/slides/slide1.xml")?.async("string"))!);
      const table = all(slide, P_NS, "graphicFrame").find((frame) => all(frame, A_NS, "tbl").length > 0);
      const transform = first(table!, P_NS, "xfrm");
      expect(first(transform!, A_NS, "off")?.getAttribute("x")).toBe(String(Math.round(4 * EMU_PER_INCH)));
      expect(first(transform!, A_NS, "off")?.getAttribute("y")).toBe(String(Math.round(4.5 * EMU_PER_INCH)));
      expect(first(transform!, A_NS, "ext")?.getAttribute("cx")).toBe(String(Math.round(4 * EMU_PER_INCH)));
      expect(first(transform!, A_NS, "ext")?.getAttribute("cy")).toBe(String(Math.round(1.5 * EMU_PER_INCH)));
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown operation instead of treating it as remove", async () => {
    const source = await fixture();
    const output = path.join(source.dir, "unknown-operation.pptx");
    try {
      const elements = await extractTemplateElements(source.path);
      const components = compileTemplateComponents(elements);
      const componentId = components.components.find((component) => component.kind === "media_frame")?.id;
      await expect(transformTemplateComponents(source.path, output, components, [{ operation: "bogus", componentId } as never])).rejects.toThrow(/COMPONENT_TRANSFORM_INVALID/);
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("rejects a lossy replacement when the source text has mixed run styles", async () => {
    const source = await fixture();
    const output = path.join(source.dir, "rich-text.pptx");
    try {
      const zip = await JSZip.loadAsync(fs.readFileSync(source.path));
      const document = parse((await zip.file("ppt/slides/slide1.xml")?.async("string"))!);
      const textShape = all(document, P_NS, "sp").find((shape) => all(shape, A_NS, "t").length > 0)!;
      const originalRun = all(textShape, A_NS, "r")[0];
      const secondRun = originalRun.cloneNode(true) as Element;
      first(secondRun, A_NS, "t")!.textContent = "SECOND";
      first(secondRun, A_NS, "srgbClr")!.setAttribute("val", "2F6FD0");
      first(originalRun, A_NS, "t")!.textContent = "FIRST";
      originalRun.parentNode?.appendChild(secondRun);
      zip.file("ppt/slides/slide1.xml", new XMLSerializer().serializeToString(document as unknown as Parameters<XMLSerializer["serializeToString"]>[0]));
      fs.writeFileSync(source.path, await zip.generateAsync({ type: "nodebuffer" }));
      const components = compileTemplateComponents(await extractTemplateElements(source.path));
      const textId = components.components.find((component) => component.kind === "body_block")?.id;
      expect(textId).toBeDefined();
      await expect(transformTemplateComponents(source.path, output, components, [{ operation: "replace_text", componentId: textId!, text: "LOSSLESS ONLY" }])).rejects.toThrow(/rich or multiline text/);
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed replace_text input before writing a package", async () => {
    const source = await fixture();
    const output = path.join(source.dir, "malformed.pptx");
    try {
      const elements = await extractTemplateElements(source.path);
      const components = compileTemplateComponents(elements);
      const componentId = components.components.find((component) => component.kind === "body_block")?.id;
      expect(componentId).toBeDefined();
      await expect(transformTemplateComponents(source.path, output, components, [{ operation: "replace_text", componentId } as never])).rejects.toThrow(/requires a string text/);
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("rejects text replacement on a non-text graphic component", async () => {
    const source = await fixture(false, true);
    const output = path.join(source.dir, "table-text.pptx");
    try {
      const components = compileTemplateComponents(await extractTemplateElements(source.path));
      const tableId = components.components.find((component) => component.assetProvenance.kind === "table")?.id;
      expect(tableId).toBeDefined();
      await expect(transformTemplateComponents(source.path, output, components, [{ operation: "replace_text", componentId: tableId!, text: "NO DATA LOSS" }])).rejects.toThrow(/not a text shape/);
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("remaps media relationships when cloning a component to another slide", async () => {
    const source = await fixture(true);
    const output = path.join(source.dir, "cross-slide.pptx");
    try {
      const elements = await extractTemplateElements(source.path);
      const components = compileTemplateComponents(elements);
      const mediaId = components.components.find((component) => component.kind === "media_frame" && component.sourceSlideId === "S01")?.id;
      expect(mediaId).toBeDefined();
      await transformTemplateComponents(source.path, output, components, [{ operation: "clone", componentId: mediaId!, targetSlideId: "S02", as: "target-image" }]);
      const zip = await JSZip.loadAsync(fs.readFileSync(output));
      const targetSlide = parse((await zip.file("ppt/slides/slide2.xml")?.async("string"))!);
      const pictures = all(targetSlide, P_NS, "pic");
      expect(pictures).toHaveLength(1);
      const embed = first(pictures[0], A_NS, "blip")?.getAttribute("r:embed");
      const rels = parse((await zip.file("ppt/slides/_rels/slide2.xml.rels")?.async("string"))!);
      const relationship = all(rels, REL_NS, "Relationship").find((candidate) => candidate.getAttribute("Id") === embed);
      expect(relationship?.getAttribute("Type")).toMatch(/\/image$/);
      expect(Object.keys(zip.files).some((name) => name.startsWith("ppt/media/") && !name.endsWith("/"))).toBe(true);
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("can clone onto a blank target slide that has no catalog component", async () => {
    const source = await fixture(true, false, true);
    const output = path.join(source.dir, "blank-target.pptx");
    try {
      const elements = await extractTemplateElements(source.path);
      const components = compileTemplateComponents(elements);
      const mediaId = components.components.find((component) => component.kind === "media_frame" && component.sourceSlideId === "S01")?.id;
      expect(mediaId).toBeDefined();
      await expect(transformTemplateComponents(source.path, output, components, [{ operation: "clone", componentId: mediaId!, targetSlideId: "S02", as: "blank-target-image" }])).resolves.toMatchObject({ createdComponents: ["blank-target-image"] });
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("does not publish an output until package validation finishes", async () => {
    const source = await fixture();
    const output = path.join(source.dir, "validation-failure.pptx");
    try {
      const sourceZip = await JSZip.loadAsync(fs.readFileSync(source.path));
      Object.keys(sourceZip.files).filter((name) => name.startsWith("ppt/media/") && !name.endsWith("/")).forEach((name) => sourceZip.remove(name));
      fs.writeFileSync(source.path, await sourceZip.generateAsync({ type: "nodebuffer" }));
      const elements = await extractTemplateElements(source.path);
      const components = compileTemplateComponents(elements);
      const textId = components.components.find((component) => component.kind === "body_block")?.id;
      expect(textId).toBeDefined();
      fs.writeFileSync(output, "existing output");
      await expect(transformTemplateComponents(source.path, output, components, [{ operation: "replace_text", componentId: textId!, text: "VALIDATION FAILURE" }])).rejects.toThrow(/COMPONENT_RELATION_MISSING/);
      expect(fs.readFileSync(output, "utf8")).toBe("existing output");
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("validates every presentation-listed slide part, not only numeric slide filenames", async () => {
    const source = await fixture();
    const output = path.join(source.dir, "custom-slide-validation.pptx");
    try {
      const zip = await JSZip.loadAsync(fs.readFileSync(source.path));
      const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string");
      const slideRels = await zip.file("ppt/slides/_rels/slide1.xml.rels")?.async("string");
      const presentationRels = await zip.file("ppt/_rels/presentation.xml.rels")?.async("string");
      const contentTypes = await zip.file("[Content_Types].xml")?.async("string");
      zip.file("ppt/slides/custom.xml", slideXml!);
      zip.file("ppt/slides/_rels/custom.xml.rels", slideRels!);
      zip.file("ppt/_rels/presentation.xml.rels", presentationRels!.replace("slides/slide1.xml", "slides/custom.xml"));
      zip.file("[Content_Types].xml", contentTypes!.replace("/ppt/slides/slide1.xml", "/ppt/slides/custom.xml"));
      zip.remove("ppt/slides/slide1.xml");
      zip.remove("ppt/slides/_rels/slide1.xml.rels");
      Object.keys(zip.files).filter((name) => name.startsWith("ppt/media/") && !name.endsWith("/")).forEach((name) => zip.remove(name));
      fs.writeFileSync(source.path, await zip.generateAsync({ type: "nodebuffer" }));
      const components = compileTemplateComponents(await extractTemplateElements(source.path));
      const textId = components.components.find((component) => component.kind === "body_block")?.id;
      expect(textId).toBeDefined();
      fs.writeFileSync(output, "existing output");
      await expect(transformTemplateComponents(source.path, output, components, [{ operation: "replace_text", componentId: textId!, text: "CUSTOM PART" }])).rejects.toThrow(/COMPONENT_RELATION_MISSING/);
      expect(fs.readFileSync(output, "utf8")).toBe("existing output");
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });
});
