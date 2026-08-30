import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import pptxgen from "pptxgenjs";
import { describe, expect, it } from "vitest";
import { canonicalizeTemplateElements, compileTemplateGrammar, extractTemplateElements } from "../../src/template-analysis";
import { compileTemplateComponents } from "../../src/template-components";
import { compileTemplatePatterns } from "../../src/template-patterns";
import { transformTemplateComponents } from "../../src/template-transform";
import { applyPatternSkeleton } from "../../src/template";
import type { SlideSpec } from "../../src/schema";

async function coordinateMismatchFixture(): Promise<{ dir: string; path: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-coordinate-space-"));
  const output = path.join(dir, "template.pptx");
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  for (const index of [1, 2]) {
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: "FFFFFF" }, line: { color: "FFFFFF" }, name: `Canvas ${index}` });
    slide.addText(`EXAMPLE CONTENT ${index}`, { x: 0.85, y: 1, w: 15.816, h: 0.5, fontFace: "Arial", fontSize: 20, color: "111111", name: `Body ${index}` });
    slide.addShape(pptx.ShapeType.line, { x: 0.85, y: 6, w: 15.816, h: 0, line: { color: "111111", width: 1 }, name: `Divider ${index}` });
    slide.addShape(pptx.ShapeType.rect, { x: -2, y: -1, w: 18.5, h: 9, fill: { color: "FF0000" }, line: { color: "FF0000" }, name: `Off-canvas helper ${index}` });
  }
  await pptx.writeFile({ fileName: output });
  return { dir, path: output };
}

describe("template coordinate-space canonicalization", () => {
  it("canonicalizes repeated adaptive bounds to p:sldSz and keeps off-canvas helpers separate", async () => {
    const source = await coordinateMismatchFixture();
    try {
      const elements = await extractTemplateElements(source.path);
      const canvas = elements.source.slideSize;
      expect(canvas).toMatchObject({ w: expect.closeTo(13.333, 3), h: expect.closeTo(7.5, 3) });
      expect(elements.coordinateSpace?.mode).toBe("scaled");
      expect(elements.coordinateSpace?.sourceFrame.w).toBeGreaterThan(canvas.w);

      const content = elements.slides.flatMap((slide) => slide.elements).filter((element) => element.type === "text");
      expect(content).not.toHaveLength(0);
      expect(content.every((element) => element.bounds.x >= 0 && element.bounds.y >= 0 && element.bounds.x + element.bounds.w <= canvas.w && element.bounds.y + element.bounds.h <= canvas.h)).toBe(true);

      const helpers = elements.slides.flatMap((slide) => slide.elements).filter((element) => element.offCanvasHelper);
      expect(helpers).toHaveLength(2);
      expect(helpers.every((element) => element.bounds.x + element.bounds.w > canvas.w)).toBe(true);

      const grammar = compileTemplateGrammar(elements);
      expect(grammar.geometry.contentFrame.x + grammar.geometry.contentFrame.w).toBeLessThanOrEqual(canvas.w);
      const patterns = compileTemplatePatterns(elements, grammar);
      expect(patterns.patterns.flatMap((pattern) => pattern.skeleton.replaceableSlots).every((slot) => slot.bounds.x + slot.bounds.w <= canvas.w)).toBe(true);
      expect(patterns.patterns.flatMap((pattern) => pattern.skeleton.offCanvasHelperIds ?? [])).toHaveLength(2);
      const components = compileTemplateComponents(elements);
      expect(components.components.filter((component) => !component.offCanvasHelper).every((component) => component.sourceBounds.x + component.sourceBounds.w <= canvas.w)).toBe(true);
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("writes transformed adaptive content inside the canonical canvas while preserving helpers", async () => {
    const source = await coordinateMismatchFixture();
    const output = path.join(source.dir, "adaptive-output.pptx");
    try {
      const elements = await extractTemplateElements(source.path);
      const components = compileTemplateComponents(elements);
      const body = components.components.find((component) => component.kind === "body_block");
      const dividerName = elements.slides.flatMap((slide) => slide.elements).find((element) => element.type === "line")?.name;
      expect(body).toBeDefined();
      expect(dividerName).toBeTruthy();
      await transformTemplateComponents(source.path, output, components, [{ operation: "replace_text", componentId: body!.id, text: "CANONICAL CONTENT" }]);

      const rendered = await extractTemplateElements(output);
      const canvas = rendered.source.slideSize;
      const content = rendered.slides.flatMap((slide) => slide.elements).filter((element) => element.type === "text");
      expect(content.every((element) => element.bounds.x + element.bounds.w <= canvas.w && element.bounds.y + element.bounds.h <= canvas.h)).toBe(true);
      expect(rendered.slides.flatMap((slide) => slide.elements).filter((element) => element.offCanvasHelper)).toHaveLength(2);
      const outputZip = await JSZip.loadAsync(fs.readFileSync(output));
      const slideXml = await Promise.all(Object.keys(outputZip.files).filter((file) => /^ppt\/slides\/.*\.xml$/.test(file)).map((file) => outputZip.file(file)!.async("string")));
      expect(slideXml.join("\n")).toContain("CANONICAL CONTENT");
      const dividerXml = slideXml.find((xml) => xml.includes(`name="${dividerName}"`))!;
      const divider = new DOMParser().parseFromString(dividerXml, "text/xml") as unknown as Document;
      const dividerShape = Array.from(divider.getElementsByTagNameNS("http://schemas.openxmlformats.org/presentationml/2006/main", "sp") as unknown as Element[]).find((shape) => shape.getElementsByTagNameNS("http://schemas.openxmlformats.org/presentationml/2006/main", "cNvPr")[0]?.getAttribute("name") === dividerName)!;
      const xfrm = dividerShape.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "xfrm")[0];
      const off = xfrm.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "off")[0];
      const ext = xfrm.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "ext")[0];
      expect(Number(off.getAttribute("x")) + Number(ext.getAttribute("cx"))).toBeLessThanOrEqual(Math.round(canvas.w * 914400));
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("positions pattern slots with canonical bounds instead of replaying the raw source frame", async () => {
    const source = await coordinateMismatchFixture();
    const output = path.join(source.dir, "pattern-output.pptx");
    try {
      const elements = await extractTemplateElements(source.path);
      const grammar = compileTemplateGrammar(elements);
      const patterns = compileTemplatePatterns(elements, grammar);
      const dividerName = elements.slides.flatMap((slide) => slide.elements).find((element) => element.type === "line")?.name;
      const slides = elements.slides.map((slide) => ({
        id: slide.id,
        role: "body",
        storyBeat: "problem",
        headline: `Headline ${slide.id}`,
        headlineAlignment: "left",
        claims: [{ text: `Headline ${slide.id}` }],
        composition: "hero_evidence",
        sourceRefs: [{ sourceId: "fixture-source", excerptId: "fixture-excerpt" }],
        layout: "statement",
        content: { body: `BODY ${slide.id}`, proofs: [] },
      } as unknown as SlideSpec));
      await applyPatternSkeleton(source.path, source.path, output, slides, new Map(patterns.patterns.map((pattern) => [pattern.sourceSlideId, pattern])), { strategy: "source_slide_pattern" });

      const rendered = await extractTemplateElements(output);
      const canvas = rendered.source.slideSize;
      const content = rendered.slides.flatMap((slide) => slide.elements).filter((element) => element.type === "text");
      expect(content.every((element) => element.bounds.x + element.bounds.w <= canvas.w && element.bounds.y + element.bounds.h <= canvas.h)).toBe(true);
      expect(rendered.slides.flatMap((slide) => slide.elements).filter((element) => element.offCanvasHelper)).toHaveLength(2);
      const outputZip = await JSZip.loadAsync(fs.readFileSync(output));
      const slideXml = await Promise.all(Object.keys(outputZip.files).filter((file) => /^ppt\/slides\/.*\.xml$/.test(file)).map((file) => outputZip.file(file)!.async("string")));
      const dividerXml = slideXml.find((xml) => xml.includes(`name="${dividerName}"`))!;
      const divider = new DOMParser().parseFromString(dividerXml, "text/xml") as unknown as Document;
      const dividerShape = Array.from(divider.getElementsByTagNameNS("http://schemas.openxmlformats.org/presentationml/2006/main", "sp") as unknown as Element[]).find((shape) => shape.getElementsByTagNameNS("http://schemas.openxmlformats.org/presentationml/2006/main", "cNvPr")[0]?.getAttribute("name") === dividerName)!;
      const xfrm = dividerShape.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "xfrm")[0];
      const off = xfrm.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "off")[0];
      const ext = xfrm.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "ext")[0];
      expect(Number(off.getAttribute("x")) + Number(ext.getAttribute("cx"))).toBeLessThanOrEqual(Math.round(canvas.w * 914400));
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("rejects stale or missing coordinate metadata at downstream boundaries", async () => {
    const source = await coordinateMismatchFixture();
    const output = path.join(source.dir, "stale-output.pptx");
    try {
      const elements = await extractTemplateElements(source.path);
      const malformed = { ...elements, coordinateSpace: { ...elements.coordinateSpace!, mode: "identity" as const } };
      expect(() => compileTemplateGrammar(malformed)).toThrow(/TEMPLATE_COORDINATE_SPACE_INVALID/);

      const components = compileTemplateComponents(elements);
      const { coordinateSpace: _coordinateSpace, ...withoutCoordinateSpace } = components;
      await expect(transformTemplateComponents(source.path, output, withoutCoordinateSpace as typeof components, [])).rejects.toThrow(/TEMPLATE_COORDINATE_SPACE_METADATA_MISSING/);
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("does not infer a global source frame from a one-slide overflow", async () => {
    const source = await coordinateMismatchFixture();
    try {
      const elements = await extractTemplateElements(source.path);
      const firstSlide = elements.slides[0];
      const text = firstSlide.elements.find((element) => element.type === "text")!;
      const rawText = { ...text, bounds: { ...text.bounds, x: text.bounds.x / elements.coordinateSpace!.scale.x, w: text.bounds.w / elements.coordinateSpace!.scale.x } };
      const inconsistent = {
        ...elements,
        coordinateSpace: undefined,
        slides: elements.slides.map((slide, index) => index === 0 ? { ...slide, elements: slide.elements.map((element) => element.id === text.id ? rawText : element) } : slide),
      };
      expect(() => canonicalizeTemplateElements(inconsistent)).toThrow(/cross-slide source-frame evidence/);
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("supports mixed-width adaptive content when the source-frame edge repeats across slides", async () => {
    const source = await coordinateMismatchFixture();
    try {
      const elements = await extractTemplateElements(source.path);
      const mixed = {
        ...elements,
        coordinateSpace: undefined,
        slides: elements.slides.map((slide) => {
          const text = slide.elements.find((element) => element.type === "text")!;
          const rawText = { ...text, bounds: { ...text.bounds, x: text.bounds.x / elements.coordinateSpace!.scale.x, w: text.bounds.w / elements.coordinateSpace!.scale.x } };
          return {
            ...slide,
            elements: [...slide.elements.map((element) => element.id === text.id ? rawText : element), { ...text, id: `${text.id}-narrow`, name: `${text.name}-narrow`, bounds: { ...text.bounds, w: 4 } }],
          };
        }),
      };
      expect(canonicalizeTemplateElements(mixed).coordinateSpace?.mode).toBe("scaled");
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("keeps an explicitly marked helper out of inference even when a role override calls it body", async () => {
    const source = await coordinateMismatchFixture();
    try {
      const elements = await extractTemplateElements(source.path);
      const overriddenHelper = {
        ...elements,
        slides: elements.slides.map((slide) => ({ ...slide, elements: slide.elements.map((element) => element.offCanvasHelper ? { ...element, role: "body" as const } : element) })),
      };
      expect(() => compileTemplateGrammar(overriddenHelper)).not.toThrow();
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("rejects unnamed adaptive shapes instead of leaving raw source geometry in a pattern", async () => {
    const source = await coordinateMismatchFixture();
    try {
      const elements = await extractTemplateElements(source.path);
      const unnamed = {
        ...elements,
        slides: elements.slides.map((slide, index) => index === 0 ? { ...slide, elements: slide.elements.map((element) => element.type === "text" ? { ...element, name: "" } : element) } : slide),
      };
      expect(() => compileTemplatePatterns(unnamed, compileTemplateGrammar(unnamed))).toThrow(/has no PowerPoint shape name/);
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate structural selectors before scaled output can retain raw bounds", async () => {
    const source = await coordinateMismatchFixture();
    try {
      const elements = await extractTemplateElements(source.path);
      const duplicated = {
        ...elements,
        slides: elements.slides.map((slide, index) => index === 0 ? {
          ...slide,
          elements: slide.elements.map((element) => ["surface", "divider"].includes(element.role) ? { ...element, name: "duplicate structural selector" } : element),
        } : slide),
      };
      expect(() => compileTemplateComponents(duplicated)).toThrow(/duplicate non-helper shape names/);
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("rejects a component catalog with missing entries before publishing output", async () => {
    const source = await coordinateMismatchFixture();
    const output = path.join(source.dir, "missing-component.pptx");
    try {
      const elements = await extractTemplateElements(source.path);
      const components = compileTemplateComponents(elements);
      const tampered = { ...components, components: components.components.slice(1) };
      await expect(transformTemplateComponents(source.path, output, tampered, [])).rejects.toThrow(/missing or has extra components/);
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });
});
