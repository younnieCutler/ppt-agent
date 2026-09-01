import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pptxgen from "pptxgenjs";
import { describe, expect, it } from "vitest";
import { extractTemplateElements } from "../../src/template-analysis";
import { compileTemplateComponents } from "../../src/template-components";
import { transformTemplateComponents } from "../../src/template-transform";

async function mixedCoordinateFixture(): Promise<{ dir: string; source: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-mixed-coordinate-"));
  const source = path.join(dir, "mixed-template.pptx");
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";

  for (let index = 0; index < 4; index += 1) {
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    const overflow = index === 0 || index === 3;
    slide.addText(`Headline ${index + 1}`, {
      x: 0.85,
      y: 0.9,
      w: overflow ? 15.816 : 6.0,
      h: 0.5,
      fontFace: "Arial",
      fontSize: 24,
      bold: true,
      color: "111111",
      name: `Title ${index + 1}`,
    });
    slide.addText(`Body ${index + 1}`, {
      x: 0.85,
      y: 1.8,
      w: 5.6,
      h: 0.6,
      fontFace: "Arial",
      fontSize: 14,
      color: "444444",
      name: `Body ${index + 1}`,
    });
  }

  await pptx.writeFile({ fileName: source });
  return { dir, source };
}

function headlineElements(elements: Awaited<ReturnType<typeof extractTemplateElements>>) {
  // Coordinate behavior is the contract under test. cNvPr names are metadata and can differ
  // across PowerPoint/PptxGenJS versions, so select the top-most authored text shape instead.
  return elements.slides.map((slide) => slide.elements
    .filter((element) => element.type === "text")
    .sort((left, right) => left.bounds.y - right.bounds.y)[0]);
}

function headlineXs(elements: Awaited<ReturnType<typeof extractTemplateElements>>): number[] {
  return headlineElements(elements).map((element) => element?.bounds.x ?? -1);
}

describe("mixed-template coordinate regression", () => {
  it("accepts a consistent overflow edge on half the slides without shifting canonical origins", async () => {
    const fixture = await mixedCoordinateFixture();
    try {
      const elements = await extractTemplateElements(fixture.source);
      expect(elements.coordinateSpace?.mode).toBe("scaled");
      expect(elements.coordinateSpace?.sourceFrame.w).toBeGreaterThan(elements.source.slideSize.w);
      expect(headlineXs(elements).every((x) => Math.abs(x - 0.85) < 0.001)).toBe(true);
      expect(headlineElements(elements).every((element) => Boolean(element) && element!.bounds.x + element!.bounds.w <= elements.source.slideSize.w + 1e-6)).toBe(true);

      const components = compileTemplateComponents(elements);
      const output = path.join(fixture.dir, "normalized.pptx");
      await transformTemplateComponents(fixture.source, output, components, []);
      expect(fs.existsSync(output)).toBe(true);

      const normalized = await extractTemplateElements(output);
      expect(headlineXs(normalized).every((x) => Math.abs(x - 0.85) < 0.001)).toBe(true);
      expect(normalized.slides.flatMap((slide) => slide.elements).every((element) => element.offCanvasHelper || element.bounds.x + element.bounds.w <= normalized.source.slideSize.w + 1e-6)).toBe(true);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("still rejects competing overflow frames instead of guessing a global transform", async () => {
    const fixture = await mixedCoordinateFixture();
    try {
      // Make slide 4 disagree with slide 1: both overflow, but to different far edges.
      const bytes = fs.readFileSync(fixture.source);
      // Rebuild rather than patch OOXML so the regression stays independent of package internals.
      const conflicting = path.join(fixture.dir, "conflicting-template.pptx");
      const pptx = new pptxgen();
      pptx.layout = "LAYOUT_WIDE";
      for (let index = 0; index < 4; index += 1) {
        const slide = pptx.addSlide();
        const width = index === 0 ? 15.816 : index === 3 ? 17.2 : 6.0;
        slide.addText(`Headline ${index + 1}`, { x: 0.85, y: 0.9, w: width, h: 0.5, fontFace: "Arial", fontSize: 24, name: `Title ${index + 1}` });
        slide.addText(`Body ${index + 1}`, { x: 0.85, y: 1.8, w: 5.6, h: 0.6, fontFace: "Arial", fontSize: 14, name: `Body ${index + 1}` });
      }
      await pptx.writeFile({ fileName: conflicting });
      expect(bytes.length).toBeGreaterThan(0);
      await expect(extractTemplateElements(conflicting)).rejects.toThrow(/TEMPLATE_COORDINATE_SPACE_MISMATCH/);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});