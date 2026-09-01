import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pptxgen from "pptxgenjs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/adaptive-qa", () => ({
  runAdaptiveQa: vi.fn(async () => ({
    status: "fail" as const,
    findings: [{ severity: "hard" as const, code: "ADAPTIVE_CONTENT_DROPPED" as const, message: "forced regression" }],
  })),
}));

import { extractTemplateElements, compileTemplateGrammar } from "../../src/template-analysis";
import { compileTemplateComponents } from "../../src/template-components";
import { compileTemplateDesignSystem } from "../../src/template-design-system";
import { renderAdaptiveRuntime } from "../../src/adaptive-runtime";
import type { SlideSpec } from "../../src/schema";

async function fixture(): Promise<{ dir: string; template: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-adaptive-runtime-qa-"));
  const template = path.join(dir, "template.pptx");
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  const slide = pptx.addSlide();
  slide.background = { color: "F5F1E8" };
  slide.addText("SOURCE TITLE", { x: 0.8, y: 0.7, w: 10, h: 0.7, fontFace: "Arial", fontSize: 24, bold: true, color: "1A1A1A" });
  slide.addText("SOURCE BODY", { x: 0.8, y: 1.8, w: 10, h: 1.2, fontFace: "Arial", fontSize: 16, color: "333333" });
  slide.addText("SOURCE PROOF", { x: 0.8, y: 3.5, w: 8, h: 0.4, fontFace: "Arial", fontSize: 12, color: "666666" });
  await pptx.writeFile({ fileName: template });
  return { dir, template };
}

function adaptiveSlide(): SlideSpec {
  return {
    id: "S10",
    role: "body",
    storyBeat: "problem",
    headline: "ADAPTIVE TITLE",
    headlineAlignment: "left",
    claims: [{ text: "ADAPTIVE TITLE", kind: "fact", status: "verified" }],
    composition: "hero_evidence",
    sourceRefs: [{ sourceId: "source", excerptId: "excerpt" }],
    layout: "statement",
    content: { body: "Adaptive body", proofs: ["Adaptive proof"] },
  };
}

describe("Goal 10 adaptive QA release gate", () => {
  it("does not publish the final deck when a prepared adaptive slide fails Goal 9 QA", async () => {
    const source = await fixture();
    try {
      const elements = await extractTemplateElements(source.template);
      const grammar = compileTemplateGrammar(elements);
      const designSystem = compileTemplateDesignSystem(elements, grammar);
      const components = compileTemplateComponents(elements);
      const output = path.join(source.dir, "final.pptx");
      await expect(renderAdaptiveRuntime({
        templatePath: source.template,
        scratchPath: source.template,
        outputPath: output,
        slides: [adaptiveSlide()],
        candidatesBySlide: new Map([["S10", []]]),
        elements,
        designSystem,
        components,
      })).rejects.toThrow(/ADAPTIVE_RUNTIME_QA_FAILED.*ADAPTIVE_CONTENT_DROPPED/);
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });
});
