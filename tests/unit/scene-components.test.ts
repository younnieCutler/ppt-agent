import { describe, expect, it } from "vitest";
import { compileSceneComponentPlan } from "../../src/scene-components";
import { composeDefaultScene, resolveSceneGeometry } from "../../src/scene";
import type { TemplateComponentsArtifact, TemplateComponent } from "../../src/template-components";
import type { TemplateDesignSystemArtifact } from "../../src/template-design-system";

function component(input: Partial<TemplateComponent> & Pick<TemplateComponent, "id" | "kind" | "sourceSlideId">): TemplateComponent {
  return {
    id: input.id,
    kind: input.kind,
    sourceSlideId: input.sourceSlideId,
    sourceSlidePart: input.sourceSlidePart ?? `ppt/slides/slide${Number(input.sourceSlideId.slice(1))}.xml`,
    elementIds: input.elementIds ?? [input.id.replace(/^component-/, "")],
    shapeNames: input.shapeNames ?? [input.id],
    sourceBounds: input.sourceBounds ?? { x: 1, y: 1, w: 2, h: 0.5 },
    semanticRoles: input.semanticRoles ?? [],
    styleRefs: input.styleRefs ?? ["style"],
    assetProvenance: input.assetProvenance ?? { kind: "none", sourceSlidePart: input.sourceSlidePart ?? `ppt/slides/slide${Number(input.sourceSlideId.slice(1))}.xml`, sourceElementId: input.id },
    repeatability: input.repeatability ?? { signal: "single", count: 1 },
    resizeFeasibility: input.resizeFeasibility ?? { horizontal: "safe", vertical: "safe" },
    observedSiblings: input.observedSiblings ?? [],
    groupPattern: input.groupPattern ?? "single",
    confidence: input.confidence ?? 0.8,
    ...(input.grouped ? { grouped: true } : {}),
    ...(input.offCanvasHelper ? { offCanvasHelper: true } : {}),
  };
}

function catalog(components: TemplateComponent[]): TemplateComponentsArtifact {
  return {
    version: 1,
    compilerVersion: "2",
    sourceDigest: "a".repeat(64),
    elementsDigest: "b".repeat(64),
    sourceGeometryDigest: "c".repeat(64),
    canvas: { w: 13.333, h: 7.5 },
    components,
    repeatGroups: [],
  };
}

function designSystem(): TemplateDesignSystemArtifact {
  return {
    version: 1,
    compilerVersion: "2",
    sourceDigest: "a".repeat(64),
    elementsDigest: "b".repeat(64),
    canvas: { w: 13.333, h: 7.5 },
    typography: { roles: {}, typeScale: { values: [14, 24, 40] } },
    colors: { text: [], fill: [], stroke: [], background: [] },
    geometry: { contentFrame: { x: 0.8, y: 0.6, w: 11.733, h: 6.2 }, gutters: [0.24] },
    spacing: { rhythm: [0.24] },
    dividers: { orientations: [], thicknesses: [], lengths: [], strokeWidthsPt: [], colors: [] },
    surfaces: { fills: [], borders: [], borderWidthsPt: [] },
    alignmentAnchors: { x: [], y: [] },
  };
}

function metricScene() {
  return resolveSceneGeometry(composeDefaultScene({
    slideId: "S04",
    kind: "metric_strip",
    headline: "핵심 효과",
    blocks: [
      { id: "m1", role: "metric", text: "45%" },
      { id: "m2", role: "metric", text: "40%" },
      { id: "m3", role: "metric", text: "15%" },
    ],
  }), designSystem());
}

describe("vNext scene component planner", () => {
  it("selects template-native prototypes across source slides instead of binding composition to one slide", () => {
    const components = catalog([
      component({ id: "surface-S01", kind: "surface", sourceSlideId: "S01", semanticRoles: ["surface"], confidence: 0.9 }),
      component({ id: "old-title-S01", kind: "title_block", sourceSlideId: "S01", semanticRoles: ["title"], confidence: 0.6 }),
      component({ id: "old-body-S01", kind: "body_block", sourceSlideId: "S01", semanticRoles: ["body"], confidence: 0.6 }),
      component({ id: "title-S03", kind: "title_block", sourceSlideId: "S03", semanticRoles: ["title"], confidence: 0.99 }),
      component({ id: "metric-S01", kind: "metric", sourceSlideId: "S01", semanticRoles: ["metric"], confidence: 0.5 }),
      component({ id: "metric-S08", kind: "metric", sourceSlideId: "S08", semanticRoles: ["metric"], confidence: 0.98 }),
      component({ id: "card-S06", kind: "card", sourceSlideId: "S06", semanticRoles: ["surface"], confidence: 0.95 }),
    ]);

    const plan = compileSceneComponentPlan(metricScene(), "핵심 효과", "S01", components);
    const metricProvenance = plan.provenance.filter((entry) => entry.sceneNodeId.startsWith("m"));

    expect(metricProvenance).toHaveLength(3);
    expect(metricProvenance.every((entry) => entry.componentId === "metric-S08" && entry.sourceSlideId === "S08")).toBe(true);
    expect(plan.provenance.find((entry) => entry.sceneNodeId === "$headline")).toMatchObject({ componentId: "title-S03", sourceSlideId: "S03" });
    expect(plan.operations).toContainEqual({ operation: "remove", componentId: "old-title-S01" });
    expect(plan.operations).toContainEqual({ operation: "remove", componentId: "old-body-S01" });
    expect(plan.operations).not.toContainEqual({ operation: "remove", componentId: "surface-S01" });
  });

  it("lays cloned metric text into the Scene IR zones rather than source component geometry", () => {
    const components = catalog([
      component({ id: "surface-S01", kind: "surface", sourceSlideId: "S01", semanticRoles: ["surface"] }),
      component({ id: "title-S02", kind: "title_block", sourceSlideId: "S02", semanticRoles: ["title"], confidence: 0.9 }),
      component({ id: "metric-S08", kind: "metric", sourceSlideId: "S08", semanticRoles: ["metric"], sourceBounds: { x: 0.8, y: 5.8, w: 11.5, h: 0.5 }, confidence: 0.99 }),
    ]);
    const scene = metricScene();
    const plan = compileSceneComponentPlan(scene, "핵심 효과", "S01", components);

    for (const [index, zone] of scene.zones.entries()) {
      expect(plan.operations).toContainEqual({ operation: "move", componentId: `scene.m${index + 1}`, x: zone.bounds.x, y: zone.bounds.y });
      expect(plan.operations).toContainEqual({ operation: "resize", componentId: `scene.m${index + 1}`, w: zone.bounds.w, h: zone.bounds.h });
    }
  });

  it("hard-fails when a base slide contains non-chrome content that cannot be sanitized losslessly", () => {
    const components = catalog([
      component({ id: "surface-S01", kind: "surface", sourceSlideId: "S01", semanticRoles: ["surface"] }),
      component({ id: "grouped-body", kind: "body_block", sourceSlideId: "S01", semanticRoles: ["body"], grouped: true }),
      component({ id: "title-S02", kind: "title_block", sourceSlideId: "S02", semanticRoles: ["title"] }),
      component({ id: "metric-S08", kind: "metric", sourceSlideId: "S08", semanticRoles: ["metric"] }),
    ]);

    expect(() => compileSceneComponentPlan(metricScene(), "핵심 효과", "S01", components)).toThrow(/SCENE_BASE_UNSANITIZABLE/);
  });
});
