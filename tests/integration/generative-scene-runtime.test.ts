import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { buildSceneFixture, SCENE_FIXTURE_STRINGS } from "../fixtures/scene-template";
import { compileTemplateGrammar, extractTemplateElements } from "../../src/template-analysis";
import { compileTemplateComponents } from "../../src/template-components";
import { compileTemplateDesignSystem } from "../../src/template-design-system";
import { generativeSceneIntentSchema } from "../../src/generative-scene";
import { renderGenerativeSceneRuntime } from "../../src/generative-scene-runtime";

const cleanup = new Set<string>();
afterEach(() => {
  cleanup.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  cleanup.clear();
});

async function packageText(pptxPath: string): Promise<string> {
  const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
  const slideFiles = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  return (await Promise.all(slideFiles.map(async (name) => zip.file(name)?.async("string") ?? ""))).join("\n");
}

describe("brand-constrained generative Scene runtime", () => {
  it("authors model-directed asymmetric metric geometry from template-native components and publishes only after QA", async () => {
    const template = await buildSceneFixture();
    const dir = path.dirname(template);
    cleanup.add(dir);
    const output = path.join(dir, "generative-output.pptx");
    const elements = await extractTemplateElements(template);
    const grammar = compileTemplateGrammar(elements);
    const designSystem = compileTemplateDesignSystem(elements, grammar);
    const components = compileTemplateComponents(elements);
    const intent = generativeSceneIntentSchema.parse({
      version: 2,
      slideId: "S04",
      semanticIntent: "quantitative",
      headline: "업무 위임 가능성",
      layout: {
        strategy: "model_authored",
        nodes: [
          { id: "title", role: "headline", text: "업무 위임 가능성", frame: { x: 0, y: 0, w: 0.64, h: 0.13 }, emphasis: 1, styleRole: "title", componentPreference: "title_block" },
          { id: "m1", role: "metric", text: "45% 직접 판단", frame: { x: 0, y: 0.34, w: 0.3, h: 0.28 }, emphasis: 1, styleRole: "metric", componentPreference: "metric" },
          { id: "m2", role: "metric", text: "40% Agent 위임", frame: { x: 0.35, y: 0.3, w: 0.26, h: 0.32 }, emphasis: 0.82, styleRole: "metric", componentPreference: "metric" },
          { id: "m3", role: "metric", text: "15% 인간 승인", frame: { x: 0.68, y: 0.39, w: 0.2, h: 0.23 }, emphasis: 0.55, styleRole: "metric", componentPreference: "metric" },
        ],
      },
    });

    const result = await renderGenerativeSceneRuntime({ templatePath: template, outputPath: output, intent, elements, designSystem, components });

    expect(result.qa.status).toBe("pass");
    expect(fs.existsSync(output)).toBe(true);
    expect(result.scene.nodes.find((node) => node.id === "m1")?.frame).toEqual({ x: 0, y: 0.34, w: 0.3, h: 0.28 });
    const metrics = result.componentPlan.provenance.filter((entry) => entry.sceneNodeId.startsWith("m"));
    expect(metrics).toHaveLength(3);
    expect(metrics.every((entry) => entry.componentId === metrics[0].componentId)).toBe(true);
    expect(metrics[0].bounds.w).toBeGreaterThan(metrics[2].bounds.w);
    expect(metrics[0].bounds.y).not.toBe(metrics[2].bounds.y);

    const xml = await packageText(output);
    expect(xml).toContain("업무 위임 가능성");
    expect(xml).toContain("45% 직접 판단");
    expect(xml).toContain("40% Agent 위임");
    expect(xml).toContain("15% 인간 승인");
    expect(xml).not.toContain(SCENE_FIXTURE_STRINGS.metricExample);
    expect(xml).not.toContain(SCENE_FIXTURE_STRINGS.metricTitle);
    expect(xml).not.toContain(SCENE_FIXTURE_STRINGS.body);
    expect([...fs.readdirSync(dir)].some((name) => name.startsWith(".ppt-agent-generative-runtime-"))).toBe(false);
  }, 30_000);
});
