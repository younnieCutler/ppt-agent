import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import pptxgen from "pptxgenjs";
import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { compileTemplateGrammar, extractTemplateElements } from "../../src/template-analysis";
import { compileTemplateComponents } from "../../src/template-components";
import { compileTemplateDesignSystem } from "../../src/template-design-system";
import { renderAdaptiveComparison, renderAdaptiveQuantitative } from "../../src/adaptive-statement";

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const EMU_PER_INCH = 914400;
type Rect = { x: number; y: number; w: number; h: number };

async function fixture(kind: "comparison" | "quantitative"): Promise<{ dir: string; template: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-adaptive-goal7-"));
  const template = path.join(dir, `${kind}.pptx`);
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  const slide = pptx.addSlide();
  slide.background = { color: "F5F1E8" };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: "F5F1E8" }, line: { color: "F5F1E8" } });
  if (kind === "comparison") {
    slide.addShape(pptx.ShapeType.rect, { x: 0.7, y: 1.1, w: 4.2, h: 5.2, fill: { color: "FFFFFF" }, line: { color: "D8D0C0", width: 1 }, altText: "left panel" });
    slide.addShape(pptx.ShapeType.rect, { x: 5.5, y: 1.1, w: 7.1, h: 5.2, fill: { color: "FFFFFF" }, line: { color: "D8D0C0", width: 1 }, altText: "right panel" });
    slide.addText("SOURCE LEFT LABEL", { x: 1, y: 1.45, w: 3.4, h: 0.35, fontFace: "Arial", fontSize: 16, bold: true, color: "1A1A1A", name: "left-kicker" });
    slide.addText("SOURCE RIGHT LABEL", { x: 5.8, y: 1.45, w: 5.8, h: 0.35, fontFace: "Arial", fontSize: 16, bold: true, color: "1A1A1A", name: "right-kicker" });
    slide.addText("SOURCE LEFT ITEM", { x: 1, y: 2.05, w: 3.4, h: 0.35, fontFace: "Arial", fontSize: 12, color: "333333", name: "left-content-1" });
    ["SOURCE RIGHT ITEM 1", "SOURCE RIGHT ITEM 2", "SOURCE RIGHT ITEM 3"].forEach((text, index) => slide.addText(text, { x: 5.8, y: 2.05 + index * 0.55, w: 5.8, h: 0.35, fontFace: "Arial", fontSize: 12, color: "333333", name: `right-content-${index + 1}` }));
    slide.addShape(pptx.ShapeType.line, { x: 5.8, y: 5.55, w: 5.8, h: 0, line: { color: "D8D0C0", width: 1 }, name: "comparison-divider" });
  } else {
    ["10", "20"].forEach((text, index) => slide.addText(text, { x: index === 0 ? 0.8 : 8.5, y: 1.4, w: 4, h: 0.6, fontFace: "Arial", fontSize: 18, bold: true, color: "1A1A1A", name: `metric-${index + 1}` }));
  }
  await pptx.writeFile({ fileName: template });
  if (kind === "comparison") {
    const zip = await JSZip.loadAsync(fs.readFileSync(template));
    const slidePath = "ppt/slides/slide1.xml";
    let slideXml = await zip.file(slidePath)!.async("string");
    slideXml = slideXml.replace('name="Shape 1"', 'name="Shape 1" descr="left panel"').replace('name="Shape 2"', 'name="Shape 2" descr="right panel"');
    zip.file(slidePath, slideXml);
    fs.writeFileSync(template, await zip.generateAsync({ type: "nodebuffer" }));
  }
  return { dir, template };
}

async function artifacts(template: string) {
  const elements = await extractTemplateElements(template);
  const grammar = compileTemplateGrammar(elements);
  return { elements, designSystem: compileTemplateDesignSystem(elements, grammar), components: compileTemplateComponents(elements) };
}

async function describedShapeBounds(filePath: string): Promise<Record<string, Rect>> {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
  const document = new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
  const result: Record<string, Rect> = {};
  for (const shape of Array.from(document.getElementsByTagNameNS(P_NS, "sp")) as Element[]) {
    const cNvPr = Array.from(shape.getElementsByTagNameNS(P_NS, "cNvPr"))[0] as Element | undefined;
    const description = cNvPr?.getAttribute("descr") ?? "";
    if (!description) continue;
    const xfrm = Array.from(shape.getElementsByTagNameNS(A_NS, "xfrm"))[0] as Element | undefined;
    const off = xfrm ? Array.from(xfrm.getElementsByTagNameNS(A_NS, "off"))[0] as Element | undefined : undefined;
    const ext = xfrm ? Array.from(xfrm.getElementsByTagNameNS(A_NS, "ext"))[0] as Element | undefined : undefined;
    if (!off || !ext) continue;
    result[description] = {
      x: Number(off.getAttribute("x") ?? 0) / EMU_PER_INCH,
      y: Number(off.getAttribute("y") ?? 0) / EMU_PER_INCH,
      w: Number(ext.getAttribute("cx") ?? 0) / EMU_PER_INCH,
      h: Number(ext.getAttribute("cy") ?? 0) / EMU_PER_INCH,
    };
  }
  return result;
}

function union(placements: Array<{ x: number; y: number; w: number; h: number }>, frame: Rect): Rect {
  const x = Math.min(...placements.map((placement) => placement.x));
  const right = Math.max(...placements.map((placement) => placement.x + placement.w));
  return { x, y: frame.y, w: right - x, h: frame.h };
}

describe("Goal 7 adaptive comparison and quantitative vertical slices", () => {
  it("transforms comparison groups and their native panels with the same asymmetric geometry", async () => {
    const source = await fixture("comparison");
    try {
      const compiled = await artifacts(source.template);
      const output = path.join(source.dir, "adaptive-comparison.pptx");
      const result = await renderAdaptiveComparison(source.template, output, compiled.designSystem, compiled.components, compiled.elements, {
        slideId: "S01",
        family: "two_column",
        blocks: [
          { id: "left-label", role: "support", text: "ADAPTIVE LEFT", group: "left", priority: 80, emphasis: "secondary" },
          { id: "left-item-1", role: "item", text: "Left item", group: "left" },
          { id: "right-label", role: "support", text: "ADAPTIVE RIGHT", group: "right", priority: 80, emphasis: "secondary" },
          { id: "right-item-1", role: "item", text: "Right item one", group: "right" },
          { id: "right-item-2", role: "item", text: "Right item two", group: "right" },
          { id: "right-item-3", role: "item", text: "Right item three", group: "right" },
          { id: "delta", role: "support", text: "ADAPTIVE DELTA", group: "right", priority: 90, emphasis: "primary" },
        ],
      });
      expect(result.qa).toMatchObject({ status: "pass", findings: [] });
      const leftPlacements = result.plan.placements.filter((placement) => placement.blockId.startsWith("left-"));
      const rightPlacements = result.plan.placements.filter((placement) => placement.blockId.startsWith("right-") || placement.blockId === "delta");
      expect(leftPlacements[0].w).not.toBe(rightPlacements[0].w);
      const expectedLeft = union(leftPlacements, result.plan.contentFrame);
      const expectedRight = union(rightPlacements, result.plan.contentFrame);
      const panels = await describedShapeBounds(output);
      expect(panels["left panel"]).toBeDefined();
      expect(panels["right panel"]).toBeDefined();
      expect(panels["left panel"].x).toBeCloseTo(expectedLeft.x, 4);
      expect(panels["left panel"].w).toBeCloseTo(expectedLeft.w, 4);
      expect(panels["left panel"].y).toBeCloseTo(expectedLeft.y, 4);
      expect(panels["left panel"].h).toBeCloseTo(expectedLeft.h, 4);
      expect(panels["right panel"].x).toBeCloseTo(expectedRight.x, 4);
      expect(panels["right panel"].w).toBeCloseTo(expectedRight.w, 4);
      expect(panels["right panel"].y).toBeCloseTo(expectedRight.y, 4);
      expect(panels["right panel"].h).toBeCloseTo(expectedRight.h, 4);
      const outputXml = await JSZip.loadAsync(fs.readFileSync(output)).then(async (zip) => Promise.all(Object.keys(zip.files).filter((file) => /^ppt\/slides\/.*\.xml$/.test(file)).map((file) => zip.file(file)!.async("string"))));
      expect(outputXml.join("\n")).toContain("ADAPTIVE DELTA");
      expect(outputXml.join("\n")).not.toContain("SOURCE LEFT");
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("repeats and reflows native metric components without dropping metric context", async () => {
    const source = await fixture("quantitative");
    try {
      const compiled = await artifacts(source.template);
      const output = path.join(source.dir, "adaptive-quantitative.pptx");
      const result = await renderAdaptiveQuantitative(source.template, output, compiled.designSystem, compiled.components, compiled.elements, {
        slideId: "S01",
        family: "metric_row",
        blocks: [1, 2, 3, 4, 5].map((index) => ({ id: `metric-${index}`, role: "metric" as const, text: `Metric ${index}: ${index * 10}% · Q2 · vs Q1 · Note ${index}`, priority: index === 1 ? 100 : 50, emphasis: index === 1 ? "primary" as const : "supporting" as const })),
      });
      expect(result.qa).toMatchObject({ status: "pass", findings: [] });
      expect(result.plan.placements).toHaveLength(5);
      expect(result.plan.rows).toBeGreaterThan(1);
      expect(result.plan.textAllocation[0].text).toContain("Q2");
      const outputXml = await JSZip.loadAsync(fs.readFileSync(output)).then(async (zip) => Promise.all(Object.keys(zip.files).filter((file) => /^ppt\/slides\/.*\.xml$/.test(file)).map((file) => zip.file(file)!.async("string"))));
      expect(outputXml.join("\n")).toContain("Note 5");
      expect(outputXml.join("\n")).not.toContain("SOURCE METRIC");
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });
});
