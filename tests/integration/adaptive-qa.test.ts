import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pptxgen from "pptxgenjs";
import { describe, expect, it } from "vitest";
import { extractTemplateElements, compileTemplateGrammar } from "../../src/template-analysis";
import { compileTemplateComponents } from "../../src/template-components";
import { compileTemplateDesignSystem } from "../../src/template-design-system";
import { renderAdaptiveTitle } from "../../src/adaptive-statement";
import { runAdaptiveQa } from "../../src/adaptive-qa";

async function fixture(): Promise<{ dir: string; template: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-adaptive-qa-"));
  const template = path.join(dir, "template.pptx");
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  const slide = pptx.addSlide();
  slide.background = { color: "F5F1E8" };
  slide.addText("SOURCE TITLE", { x: 0.8, y: 0.8, w: 6, h: 0.7, fontFace: "Arial", fontSize: 24, bold: true, color: "1A1A1A" });
  slide.addText("SOURCE SUBTITLE", { x: 0.8, y: 1.7, w: 6, h: 0.4, fontFace: "Arial", fontSize: 12, color: "333333" });
  await pptx.writeFile({ fileName: template });
  return { dir, template };
}

describe("Goal 9 additive adaptive QA gate", () => {
  it("passes a native adaptive output and reports provenance/content hard findings", async () => {
    const source = await fixture();
    try {
      const elements = await extractTemplateElements(source.template);
      const grammar = compileTemplateGrammar(elements);
      const designSystem = compileTemplateDesignSystem(elements, grammar);
      const components = compileTemplateComponents(elements);
      const output = path.join(source.dir, "adaptive-title.pptx");
      const rendered = await renderAdaptiveTitle(source.template, output, designSystem, components, elements, { slideId: "S01", family: "stack", blocks: [{ id: "headline", role: "headline", text: "ADAPTIVE TITLE", priority: 100, emphasis: "primary" }] });
      const pass = await runAdaptiveQa({ templatePath: source.template, outputPath: output, plan: rendered.plan, components });
      expect(pass).toMatchObject({ status: "pass", findings: [] });

      const missingComponentPlan = { ...rendered.plan, placements: rendered.plan.placements.map((placement, index) => index === 0 ? { ...placement, componentId: "missing-component" } : placement) };
      const missing = await runAdaptiveQa({ templatePath: source.template, outputPath: output, plan: missingComponentPlan, components });
      expect(missing.findings.map((finding) => finding.code)).toContain("TEMPLATE_COMPONENT_PROVENANCE_MISSING");

      const droppedContentPlan = { ...rendered.plan, textAllocation: rendered.plan.textAllocation.map((allocation, index) => index === 0 ? { ...allocation, text: "MISSING ADAPTIVE CONTENT" } : allocation) };
      const dropped = await runAdaptiveQa({ templatePath: source.template, outputPath: output, plan: droppedContentPlan, components });
      expect(dropped.findings.map((finding) => finding.code)).toContain("ADAPTIVE_CONTENT_DROPPED");
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });
});
