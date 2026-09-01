import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GenerativeAuthoringRequest } from "../../src/generative-authoring";
import { renderGenerativeDeckWithVisualCritic } from "../../src/generative-critic-runtime";
import { generativeSceneIntentSchema } from "../../src/generative-scene";
import type { SlideSpec } from "../../src/schema";
import { compileTemplateGrammar, extractTemplateElements } from "../../src/template-analysis";
import { compileTemplateComponents } from "../../src/template-components";
import { compileTemplateDesignSystem } from "../../src/template-design-system";
import type { VisualRenderBackend } from "../../src/visual";
import { buildSceneFixture } from "../fixtures/scene-template";

const cleanup = new Set<string>();
afterEach(() => {
  cleanup.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  cleanup.clear();
});

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function quantitativeSlide(): SlideSpec {
  return {
    id: "S10",
    role: "body",
    storyBeat: "evidence",
    headline: "Agent work is becoming measurable",
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
    slideId: "S10",
    semanticIntent: "quantitative",
    headline: "Agent work is becoming measurable",
    layout: {
      strategy: "model_authored",
      nodes: [
        { id: "headline", role: "headline", text: "Agent work is becoming measurable", frame: { x: 0, y: 0, w: 0.72, h: 0.15 }, emphasis: 1, styleRole: "title", componentPreference: "title_block" },
        { id: "m1", role: "metric", text: "45%", frame: { x: 0, y: 0.34, w: 0.3, h: 0.28 }, emphasis: 1, styleRole: "metric", componentPreference: "metric" },
        { id: "m2", role: "metric", text: "40%", frame: { x: 0.35, y: 0.3, w: 0.26, h: 0.32 }, emphasis: 0.82, styleRole: "metric", componentPreference: "metric" },
        { id: "m3", role: "metric", text: "15%", frame: { x: 0.68, y: 0.39, w: 0.2, h: 0.23 }, emphasis: 0.55, styleRole: "metric", componentPreference: "metric" },
      ],
    },
  });
}

function authoringRequest(sourceDigest: string, elementsDigest: string): GenerativeAuthoringRequest {
  return {
    version: 1,
    requestDigest: "c".repeat(64),
    sourceDigest,
    elementsDigest,
    instructions: {
      compositionAuthority: "model_authored",
      coordinateSpace: "normalized_content_region_0_1",
      sourceSlideGeometry: "reference_only",
      preserveAllContentAtoms: true,
      forbidInventedText: true,
      chrome: "immutable",
      colors: "template_only",
      fonts: "template_only",
    },
    brand: {
      contentRegionId: "content-main",
      allowedFonts: ["Aptos", "Aptos Display"],
      allowedColors: ["172033", "2357B8", "F7F4ED"],
      allowedTextStyleRoles: ["title", "metric"],
      allowedComponentKinds: ["title_block", "metric"],
      blockedRegions: [],
    },
    references: [],
    slides: [{
      id: "S10",
      semanticIntent: "quantitative",
      storyBeat: "evidence",
      layout: "quantitative",
      headline: "Agent work is becoming measurable",
      headlineAlignment: "left",
      compositionHint: "kpi_row",
      contentAtoms: [
        { id: "S10.headline", text: "Agent work is becoming measurable", roleHint: "headline", importance: "primary", group: "headline" },
      ],
      relationships: [],
    }],
  };
}

function mockBackend(): VisualRenderBackend {
  return {
    name: "libreoffice",
    probe: () => ({ available: true, detail: "test backend" }),
    render: async (_pptxPath, outputDir, slideMap) => slideMap.map((entry) => {
      const imagePath = path.join(outputDir, `mock-${entry.slideId}.png`);
      fs.writeFileSync(imagePath, `mock render for ${entry.slideId}`);
      return { slideId: entry.slideId, index: entry.index, path: imagePath };
    }),
  };
}

function criticResponse(request: { requestDigest: string; sourceDigest: string; renderDigest: string }, score: number) {
  return {
    version: 1 as const,
    requestDigest: request.requestDigest,
    sourceDigest: request.sourceDigest,
    renderDigest: request.renderDigest,
    slides: [{
      slideId: "S10",
      scores: {
        visualHierarchy: score,
        compositionBalance: score,
        purposeFit: score,
        readability: score,
        professionalism: score,
        templateFit: score,
      },
      findings: score >= 8 ? [] : [{ code: "UNBALANCED_COMPOSITION" as const, message: "Needs a clearer focal metric.", nodeIds: ["m1"], repairable: true }],
      summary: score >= 8 ? "Ready" : "Repair required",
    }],
    deckFindings: [],
  };
}

async function runtimeFixture(outputName: string) {
  const templatePath = await buildSceneFixture();
  const dir = path.dirname(templatePath);
  cleanup.add(dir);
  const elements = await extractTemplateElements(templatePath);
  const grammar = compileTemplateGrammar(elements);
  const designSystem = compileTemplateDesignSystem(elements, grammar);
  const components = compileTemplateComponents(elements);
  const slide = quantitativeSlide();
  const scene = metricScene();
  const outputPath = path.join(dir, outputName);
  return {
    dir,
    outputPath,
    input: {
      templatePath,
      outputPath,
      slides: [slide],
      candidatesBySlide: new Map([[slide.id, []]]),
      scenesBySlide: new Map([[slide.id, scene]]),
      elements,
      designSystem,
      components,
      authoringRequest: authoringRequest(elements.source.sha256, designSystem.elementsDigest),
      visualBackend: mockBackend(),
    },
  };
}

describe("Generative critic runtime publication gate", () => {
  it("does not publish when the critic itself fails", async () => {
    const fixture = await runtimeFixture("critic-failure.pptx");
    await expect(renderGenerativeDeckWithVisualCritic({
      ...fixture.input,
      judge: async () => { throw new Error("critic unavailable"); },
      repair: async () => { throw new Error("repair should not run"); },
    })).rejects.toThrow(/critic unavailable/);
    expect(fs.existsSync(fixture.outputPath)).toBe(false);
  }, 30_000);

  it("does not publish when two repair rounds are exhausted", async () => {
    const fixture = await runtimeFixture("critic-exhausted.pptx");
    await expect(renderGenerativeDeckWithVisualCritic({
      ...fixture.input,
      judge: async (request) => criticResponse(request, 6),
      repair: async (request) => ({
        version: 1,
        requestDigest: request.requestDigest,
        sourceDigest: request.sourceDigest,
        slideId: request.slideId,
        rationale: "Keep the same content and increase focal emphasis.",
        operations: [{ op: "set_emphasis", nodeId: "m1", emphasis: 1 }],
      }),
    })).rejects.toThrow(/GENERATIVE_CRITIC_REPAIR_EXHAUSTED/);
    expect(fs.existsSync(fixture.outputPath)).toBe(false);
  }, 30_000);

  it("publishes exactly the PPTX digest judged on the passing round and cleans successful workspaces", async () => {
    const fixture = await runtimeFixture("critic-pass.pptx");
    let judgedDigest = "";
    const result = await renderGenerativeDeckWithVisualCritic({
      ...fixture.input,
      judge: async (request) => {
        judgedDigest = request.renderDigest;
        return criticResponse(request, 9);
      },
      repair: async () => { throw new Error("repair should not run for a passing deck"); },
    });

    expect(result.critic.rounds).toBe(0);
    expect(fs.existsSync(fixture.outputPath)).toBe(true);
    expect(sha256File(fixture.outputPath)).toBe(judgedDigest);
    expect([...fs.readdirSync(fixture.dir)].some((name) => name.startsWith(".ppt-agent-generative-critic-"))).toBe(false);
  }, 30_000);
});
