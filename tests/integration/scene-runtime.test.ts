import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { buildSceneFixture, SCENE_FIXTURE_STRINGS } from "../fixtures/scene-template";
import { compileTemplateGrammar, extractTemplateElements } from "../../src/template-analysis";
import { compileTemplateComponents } from "../../src/template-components";
import { compileTemplateDesignSystem } from "../../src/template-design-system";
import { composeDefaultScene } from "../../src/scene";
import { renderSceneRuntime } from "../../src/scene-runtime";

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

describe("vNext Scene runtime", () => {
  it("authors a true three-column metric scene from one full-width template metric prototype", async () => {
    const template = await buildSceneFixture();
    const dir = path.dirname(template);
    cleanup.add(dir);
    const output = path.join(dir, "scene-output.pptx");
    const elements = await extractTemplateElements(template);
    const grammar = compileTemplateGrammar(elements);
    const designSystem = compileTemplateDesignSystem(elements, grammar);
    const components = compileTemplateComponents(elements);
    const intent = composeDefaultScene({
      slideId: "S04",
      kind: "metric_strip",
      headline: "업무 위임 가능성",
      blocks: [
        { id: "m1", role: "metric", text: "45% 직접 판단", emphasis: "primary" },
        { id: "m2", role: "metric", text: "40% Agent 위임" },
        { id: "m3", role: "metric", text: "15% 인간 승인" },
      ],
    });

    const result = await renderSceneRuntime({ templatePath: template, outputPath: output, intent, elements, designSystem, components });

    expect(result.qa.status).toBe("pass");
    expect(fs.existsSync(output)).toBe(true);
    const metrics = result.componentPlan.provenance.filter((entry) => entry.sceneNodeId.startsWith("m"));
    expect(metrics).toHaveLength(3);
    expect(new Set(metrics.map((entry) => entry.sourceSlideId)).size).toBe(1);
    expect(metrics[0].componentId).toBe(metrics[1].componentId);
    expect(metrics[1].componentId).toBe(metrics[2].componentId);
    expect(new Set(metrics.map((entry) => entry.bounds.y)).size).toBe(1);
    expect(metrics[0].bounds.x).toBeLessThan(metrics[1].bounds.x);
    expect(metrics[1].bounds.x).toBeLessThan(metrics[2].bounds.x);

    const xml = await packageText(output);
    expect(xml).toContain("업무 위임 가능성");
    expect(xml).toContain("45% 직접 판단");
    expect(xml).toContain("40% Agent 위임");
    expect(xml).toContain("15% 인간 승인");
    expect(xml).not.toContain(SCENE_FIXTURE_STRINGS.metricExample);
    expect(xml).not.toContain(SCENE_FIXTURE_STRINGS.metricTitle);
    expect([...fs.readdirSync(dir)].some((name) => name.startsWith(".ppt-agent-scene-runtime-"))).toBe(false);
  }, 30_000);
});
