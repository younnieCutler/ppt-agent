import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import pptxgen from "pptxgenjs";
import { describe, expect, it } from "vitest";
import { renderGenerativeDeckRuntime } from "../../src/generative-deck-runtime";
import { generativeSceneIntentSchema } from "../../src/generative-scene";
import { readPptxOoxml } from "../../src/ooxml";
import type { SlideSpec } from "../../src/schema";
import { compileTemplateGrammar, extractTemplateElements } from "../../src/template-analysis";
import { compileTemplateComponents } from "../../src/template-components";
import { compileTemplateDesignSystem } from "../../src/template-design-system";
import { compileTemplatePatterns } from "../../src/template-patterns";

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

async function fixture(): Promise<{ dir: string; template: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-generative-deck-"));
  const template = path.join(dir, "template.pptx");
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";

  const exact = pptx.addSlide();
  exact.background = { color: "F5F1E8" };
  exact.addText("SOURCE EXACT TITLE", { x: 0.8, y: 0.7, w: 10, h: 0.7, fontFace: "Arial", fontSize: 24, bold: true, color: "1A1A1A", name: "Exact Title" });
  exact.addText("SOURCE EXACT BODY", { x: 0.8, y: 1.8, w: 10, h: 1.2, fontFace: "Arial", fontSize: 16, color: "333333", name: "Exact Body" });

  const body = pptx.addSlide();
  body.background = { color: "F5F1E8" };
  body.addText("SOURCE BODY TITLE", { x: 0.8, y: 0.7, w: 10, h: 0.7, fontFace: "Arial", fontSize: 24, bold: true, color: "1A1A1A", name: "Body Title" });
  body.addText("SOURCE BODY COPY", { x: 0.8, y: 1.8, w: 9, h: 1.4, fontFace: "Arial", fontSize: 16, color: "333333", name: "Body Copy" });

  const metric = pptx.addSlide();
  metric.background = { color: "F5F1E8" };
  metric.addText("SOURCE METRIC TITLE", { x: 0.8, y: 0.7, w: 10, h: 0.7, fontFace: "Arial", fontSize: 24, bold: true, color: "1A1A1A", name: "Metric Title" });
  metric.addText("99%", { x: 0.8, y: 2.4, w: 11.2, h: 1.2, fontFace: "Arial", fontSize: 44, bold: true, color: "2357B8", name: "KPI Metric" });

  await pptx.writeFile({ fileName: template });
  return { dir, template };
}

function statementSlide(): SlideSpec {
  return {
    id: "S10",
    role: "body",
    storyBeat: "problem",
    headline: "DECK EXACT TITLE",
    headlineAlignment: "left",
    claims: [{ text: "DECK EXACT TITLE", kind: "fact", status: "verified" }],
    composition: "hero_evidence",
    sourceRefs: [{ sourceId: "source", excerptId: "excerpt" }],
    layout: "statement",
    content: { body: "Exact body", proofs: [] },
  };
}

function quantitativeSlide(): SlideSpec {
  return {
    id: "S11",
    role: "body",
    storyBeat: "evidence",
    headline: "DECK GENERATED METRICS",
    headlineAlignment: "left",
    claims: [{ text: "Three metrics", kind: "fact", status: "verified" }],
    composition: "kpi_row",
    sourceRefs: [{ sourceId: "source", excerptId: "excerpt" }],
    layout: "quantitative",
    content: {
      kind: "kpi",
      metrics: [
        { label: "Direct", value: 45, unit: "%", period: "Now" },
        { label: "Agent", value: 40, unit: "%", period: "Now" },
        { label: "Human", value: 15, unit: "%", period: "Now" },
      ],
    },
  };
}

function metricScene() {
  return generativeSceneIntentSchema.parse({
    version: 2,
    slideId: "S11",
    semanticIntent: "quantitative",
    headline: "DECK GENERATED METRICS",
    layout: {
      strategy: "model_authored",
      nodes: [
        { id: "headline", role: "headline", text: "DECK GENERATED METRICS", frame: { x: 0, y: 0, w: 0.72, h: 0.15 }, emphasis: 1, styleRole: "title", componentPreference: "title_block" },
        { id: "m1", role: "metric", text: "45%", frame: { x: 0, y: 0.34, w: 0.25, h: 0.32 }, emphasis: 1, styleRole: "metric", componentPreference: "metric" },
        { id: "m2", role: "metric", text: "40%", frame: { x: 0.34, y: 0.3, w: 0.3, h: 0.4 }, emphasis: 0.9, styleRole: "metric", componentPreference: "metric" },
        { id: "m3", role: "metric", text: "15%", frame: { x: 0.74, y: 0.38, w: 0.22, h: 0.28 }, emphasis: 0.6, styleRole: "metric", componentPreference: "metric" },
      ],
    },
  });
}

async function visibleSlideXmls(pptxPath: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
  const presentationXml = await zip.file("ppt/presentation.xml")?.async("string");
  const relsXml = await zip.file("ppt/_rels/presentation.xml.rels")?.async("string");
  if (!presentationXml || !relsXml) throw new Error("missing presentation parts");
  const presentation = new DOMParser().parseFromString(presentationXml, "text/xml");
  const rels = new DOMParser().parseFromString(relsXml, "text/xml");
  const targets = new Map(Array.from(rels.getElementsByTagNameNS(REL_NS, "Relationship")).map((node) => [node.getAttribute("Id") ?? "", node.getAttribute("Target") ?? ""]));
  const slideIds = Array.from(presentation.getElementsByTagNameNS(P_NS, "sldId"));
  return Promise.all(slideIds.map(async (node) => {
    const target = targets.get(node.getAttributeNS(R_NS, "id") ?? "");
    if (!target) throw new Error("missing slide relationship");
    const part = target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join("ppt", target));
    return await zip.file(part)?.async("string") ?? "";
  }));
}

describe("generative multi-slide deck runtime", () => {
  it("uses exact_clone when proven, generative_scene otherwise, preserves order, and never falls back to the generic renderer", async () => {
    const source = await fixture();
    try {
      const elements = await extractTemplateElements(source.template);
      const grammar = compileTemplateGrammar(elements);
      const designSystem = compileTemplateDesignSystem(elements, grammar);
      const components = compileTemplateComponents(elements);
      const patterns = compileTemplatePatterns(elements, grammar);
      const exact = statementSlide();
      const generated = quantitativeSlide();
      const output = path.join(source.dir, "deck-output.pptx");

      const result = await renderGenerativeDeckRuntime({
        templatePath: source.template,
        outputPath: output,
        slides: [exact, generated],
        candidatesBySlide: new Map([
          [exact.id, [{ rank: 1, pattern: patterns.patterns[0] }]],
          [generated.id, []],
        ]),
        scenesBySlide: new Map([[generated.id, metricScene()]]),
        elements,
        designSystem,
        components,
      });

      expect(result.decisions.map((decision) => decision.mode)).toEqual(["exact_clone", "generative_scene"]);
      expect(result.manifest).toEqual([
        { slideId: "S10", mode: "exact_clone" },
        { slideId: "S11", mode: "generative_scene" },
      ]);
      expect(await readPptxOoxml(output)).toMatchObject({ parseOk: true, slideCount: 2 });
      const slides = await visibleSlideXmls(output);
      expect(slides).toHaveLength(2);
      expect(slides[0]).toContain("DECK EXACT TITLE");
      expect(slides[1]).toContain("DECK GENERATED METRICS");
      expect(slides[1]).toContain("45%");
      expect(slides[1]).toContain("40%");
      expect(slides[1]).toContain("15%");
      expect(slides.join("\n")).not.toContain("SOURCE ");
      expect([...fs.readdirSync(source.dir)].some((name) => name.startsWith(".ppt-agent-generative-deck-runtime-"))).toBe(false);
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails before publication when a non-exact slide has no Generative Scene", async () => {
    const source = await fixture();
    try {
      const elements = await extractTemplateElements(source.template);
      const grammar = compileTemplateGrammar(elements);
      const designSystem = compileTemplateDesignSystem(elements, grammar);
      const components = compileTemplateComponents(elements);
      const generated = quantitativeSlide();
      const output = path.join(source.dir, "missing-scene.pptx");

      await expect(renderGenerativeDeckRuntime({
        templatePath: source.template,
        outputPath: output,
        slides: [generated],
        candidatesBySlide: new Map([[generated.id, []]]),
        scenesBySlide: new Map(),
        elements,
        designSystem,
        components,
      })).rejects.toThrow(/GENERATIVE_DECK_SCENE_MISSING/);
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  }, 30_000);
});
