import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import pptxgen from "pptxgenjs";
import { describe, expect, it } from "vitest";
import { compileTemplateGrammar, extractTemplateElements } from "../../src/template-analysis";
import { compileTemplateComponents } from "../../src/template-components";
import { compileTemplateDesignSystem } from "../../src/template-design-system";
import { renderAdaptiveEvidence, renderAdaptiveProcess, renderAdaptiveTimeline, renderAdaptiveTitle } from "../../src/adaptive-statement";

async function fixture(): Promise<{ dir: string; template: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-adaptive-goal8-"));
  const template = path.join(dir, "text-layouts.pptx");
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  const slide = pptx.addSlide();
  slide.background = { color: "F5F1E8" };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: "F5F1E8" }, line: { color: "F5F1E8" } });
  slide.addText("SOURCE TITLE", { x: 0.8, y: 0.6, w: 10, h: 0.7, fontFace: "Arial", fontSize: 24, bold: true, color: "1A1A1A" });
  slide.addText("SOURCE SUBTITLE", { x: 0.8, y: 1.5, w: 10, h: 0.4, fontFace: "Arial", fontSize: 16, color: "333333" });
  ["SOURCE STEP 1", "SOURCE STEP 2", "SOURCE STEP 3", "SOURCE STEP 4"].forEach((text, index) => slide.addText(text, { x: 0.8, y: 2.2 + index * 0.7, w: 10, h: 0.4, fontFace: "Arial", fontSize: 13, color: "333333" }));
  slide.addShape(pptx.ShapeType.line, { x: 0.8, y: 5.5, w: 10, h: 0, line: { color: "D8D0C0", width: 1 } });
  await pptx.writeFile({ fileName: template });
  return { dir, template };
}

async function artifacts(template: string) {
  const elements = await extractTemplateElements(template);
  const grammar = compileTemplateGrammar(elements);
  return { elements, designSystem: compileTemplateDesignSystem(elements, grammar), components: compileTemplateComponents(elements) };
}

async function slideXml(filePath: string): Promise<string> {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  return Promise.all(Object.keys(zip.files).filter((file) => /^ppt\/slides\/.*\.xml$/.test(file)).map((file) => zip.file(file)!.async("string"))).then((parts) => parts.join("\n"));
}

describe("Goal 8 adaptive text-representable layouts", () => {
  it("renders process, timeline, evidence, and text-only title without source examples", async () => {
    const source = await fixture();
    try {
      const compiled = await artifacts(source.template);
      const intents: Array<[string, (template: string, output: string, designSystem: typeof compiled.designSystem, components: typeof compiled.components, elements: typeof compiled.elements, intent: unknown) => Promise<{ qa: { status: string; findings: unknown[] }; plan: { placements: unknown[] } }>, unknown]> = [
        ["process", renderAdaptiveProcess, { slideId: "S01", family: "repeated_cards", blocks: ["Capture", "Map", "Review"].map((label, index) => ({ id: `step-${index + 1}`, role: "item", text: `${label} · detail ${index + 1} · members: source-${index + 1}` })) }],
        ["timeline", renderAdaptiveTimeline, { slideId: "S01", family: "repeated_cards", blocks: [{ id: "m1", role: "item", text: "2026-01 · Start · Open" }, { id: "m2", role: "item", text: "2026-02 · Ship · Release" }] }],
        ["evidence", renderAdaptiveEvidence, { slideId: "S01", family: "stack", blocks: [{ id: "caption", role: "support", text: "Evidence caption" }, { id: "bullet-1", role: "item", text: "Evidence one" }, { id: "bullet-2", role: "item", text: "Evidence two" }] }],
        ["title", renderAdaptiveTitle, { slideId: "S01", family: "stack", blocks: [{ id: "headline", role: "headline", text: "Adaptive title", priority: 100, emphasis: "primary" }, { id: "subtitle", role: "body", text: "Adaptive subtitle" }] }],
      ];
      for (const [kind, render, intent] of intents) {
        const output = path.join(source.dir, `adaptive-${kind}.pptx`);
        const result = await render(source.template, output, compiled.designSystem, compiled.components, compiled.elements, intent);
        expect(result.qa).toMatchObject({ status: "pass", findings: [] });
        expect(result.plan.placements.length).toBeGreaterThan(0);
        const xml = await slideXml(output);
        expect(xml).toContain(kind === "process" ? "members: source-1" : kind === "timeline" ? "2026-02" : kind === "evidence" ? "Evidence two" : "Adaptive title");
        expect(xml).not.toContain("SOURCE ");
      }
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });

  it("replaces an existing native media frame for a title image", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-adaptive-goal8-media-"));
    const template = path.join(dir, "title-media.pptx");
    const asset = path.join(dir, "replacement.png");
    const sourceImage = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+QyaA5AAAAABJRU5ErkJggg==";
    const targetImage = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/Sc4B4QAAAABJRU5ErkJggg==";
    try {
      const pptx = new pptxgen();
      pptx.layout = "LAYOUT_WIDE";
      const slide = pptx.addSlide();
      slide.background = { color: "F5F1E8" };
      slide.addText("SOURCE MEDIA TITLE", { x: 0.8, y: 0.8, w: 6, h: 0.7, fontFace: "Arial", fontSize: 24, bold: true, color: "1A1A1A" });
      slide.addText("SOURCE MEDIA SUBTITLE", { x: 0.8, y: 1.7, w: 6, h: 0.4, fontFace: "Arial", fontSize: 12, color: "333333" });
      slide.addImage({ data: `data:image/png;base64,${sourceImage}`, x: 8, y: 1, w: 4, h: 4 });
      await pptx.writeFile({ fileName: template });
      fs.writeFileSync(asset, Buffer.from(targetImage, "base64"));
      const compiled = await artifacts(template);
      const output = path.join(dir, "adaptive-title-media.pptx");
      const result = await renderAdaptiveTitle(template, output, compiled.designSystem, compiled.components, compiled.elements, { slideId: "S01", family: "stack", mediaPath: asset, blocks: [{ id: "headline", role: "headline", text: "ADAPTIVE MEDIA TITLE", priority: 100, emphasis: "primary" }] });
      expect(result.qa).toMatchObject({ status: "pass", findings: [] });
      const zip = await JSZip.loadAsync(fs.readFileSync(output));
      const media = await Promise.all(Object.keys(zip.files).filter((file) => file.startsWith("ppt/media/") && !zip.files[file].dir).map((file) => zip.file(file)!.async("nodebuffer")));
      expect(media.some((bytes) => Buffer.compare(bytes, Buffer.from(targetImage, "base64")) === 0)).toBe(true);
      expect(media.some((bytes) => Buffer.compare(bytes, Buffer.from(sourceImage, "base64")) === 0)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
