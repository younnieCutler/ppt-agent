import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import pptxgen from "pptxgenjs";
import { describe, expect, it } from "vitest";
import { extractTemplateElements, compileTemplateGrammar } from "../../src/template-analysis";
import { compileTemplateComponents } from "../../src/template-components";
import { compileTemplateDesignSystem } from "../../src/template-design-system";
import { compileTemplatePatterns, type TemplatePattern } from "../../src/template-patterns";
import { renderAdaptiveRuntime } from "../../src/adaptive-runtime";
import { readPptxOoxml } from "../../src/ooxml";
import type { SlideSpec } from "../../src/schema";

async function fixture(): Promise<{ dir: string; template: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-adaptive-runtime-"));
  const template = path.join(dir, "template.pptx");
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  const exact = pptx.addSlide();
  exact.background = { color: "F5F1E8" };
  exact.addText("SOURCE EXACT TITLE", { x: 0.8, y: 0.7, w: 10, h: 0.7, fontFace: "Arial", fontSize: 24, bold: true, color: "1A1A1A" });
  exact.addText("SOURCE EXACT BODY", { x: 0.8, y: 1.8, w: 10, h: 1.2, fontFace: "Arial", fontSize: 16, color: "333333" });
  const adaptive = pptx.addSlide();
  adaptive.background = { color: "F5F1E8" };
  adaptive.addText("SOURCE ADAPTIVE TITLE", { x: 0.8, y: 0.7, w: 10, h: 0.7, fontFace: "Arial", fontSize: 24, bold: true, color: "1A1A1A" });
  adaptive.addText("SOURCE ADAPTIVE BODY", { x: 0.8, y: 1.8, w: 10, h: 1.2, fontFace: "Arial", fontSize: 16, color: "333333" });
  adaptive.addText("SOURCE ADAPTIVE PROOF", { x: 0.8, y: 3.5, w: 8, h: 0.4, fontFace: "Arial", fontSize: 12, color: "666666" });
  adaptive.addText("SOURCE ADAPTIVE PROOF 2", { x: 0.8, y: 4.1, w: 8, h: 0.4, fontFace: "Arial", fontSize: 12, color: "666666" });
  await pptx.writeFile({ fileName: template });
  return { dir, template };
}

function deckSlide(id: string, headline: string, body: string, proofs: string[]): SlideSpec {
  return { id, role: "body", storyBeat: "problem", headline, headlineAlignment: "left", claims: [{ text: headline, kind: "fact", status: "verified" }], composition: "hero_evidence", sourceRefs: [{ sourceId: "source", excerptId: "excerpt" }], layout: "statement", content: { body, proofs } };
}

describe("Goal 10 raw PPTX adaptive runtime policy", () => {
  it("selects exact clone or adaptive compose and never emits a generic renderer slide", async () => {
    const source = await fixture();
    try {
      const elements = await extractTemplateElements(source.template);
      const grammar = compileTemplateGrammar(elements);
      const designSystem = compileTemplateDesignSystem(elements, grammar);
      const components = compileTemplateComponents(elements);
      const patterns = compileTemplatePatterns(elements, grammar);
      const exactSlide = deckSlide("S01", "ADAPTIVE EXACT TITLE", "Exact body", []);
      const adaptiveSlide = deckSlide("S02", "ADAPTIVE COMPOSE TITLE", "Adaptive body", ["Proof one", "Proof two"]);
      const badAdaptivePattern: TemplatePattern = { ...patterns.patterns[1], id: "pattern-S02-headline-only", skeleton: { ...patterns.patterns[1].skeleton, replaceableSlots: patterns.patterns[1].skeleton.replaceableSlots.filter((slot) => slot.binding === "headline") } };
      const output = path.join(source.dir, "final.pptx");
      const result = await renderAdaptiveRuntime({
        templatePath: source.template,
        scratchPath: source.template,
        outputPath: output,
        slides: [exactSlide, adaptiveSlide],
        candidatesBySlide: new Map([
          ["S01", [{ rank: 1, pattern: patterns.patterns[0] }]],
          ["S02", [{ rank: 1, pattern: badAdaptivePattern }]],
        ]),
        elements,
        designSystem,
        components,
      });
      expect(result.decisions.map((decision) => decision.mode)).toEqual(["exact_clone", "adaptive_compose"]);
      expect(result.manifest.every((entry) => entry.mode !== "renderer")).toBe(true);
      expect(await readPptxOoxml(output)).toMatchObject({ parseOk: true, slideCount: 2 });
      const outputXml = await JSZip.loadAsync(fs.readFileSync(output)).then(async (zip) => Promise.all(Object.keys(zip.files).filter((file) => /^ppt\/slides\/.*\.xml$/.test(file)).map((file) => zip.file(file)!.async("string"))));
      expect(outputXml.join("\n")).toContain("ADAPTIVE COMPOSE TITLE");
      expect(outputXml.join("\n")).toContain("Proof two");
      expect(outputXml.join("\n")).not.toContain("SOURCE ");
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });
});
