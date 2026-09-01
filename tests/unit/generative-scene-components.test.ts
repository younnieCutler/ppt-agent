import { describe, expect, it } from "vitest";
import type { TemplateConstraintProfile } from "../../src/brand-constraints";
import { compileGenerativeSceneComponentPlan } from "../../src/generative-scene-components";
import { generativeSceneIntentSchema, resolveGenerativeScene } from "../../src/generative-scene";
import type { ComponentTransformOperation } from "../../src/template-transform";
import type { TemplateComponent, TemplateComponentsArtifact } from "../../src/template-components";

function component(input: Partial<TemplateComponent> & Pick<TemplateComponent, "id" | "kind" | "sourceSlideId">): TemplateComponent {
  const slideNumber = Number(input.sourceSlideId.replace(/^S/, "")) || 1;
  const sourceSlidePart = input.sourceSlidePart ?? `ppt/slides/slide${slideNumber}.xml`;
  return {
    id: input.id,
    kind: input.kind,
    sourceSlideId: input.sourceSlideId,
    sourceSlidePart,
    elementIds: input.elementIds ?? [input.id.replace(/^component-/, "")],
    shapeNames: input.shapeNames ?? [input.id],
    sourceBounds: input.sourceBounds ?? { x: 1, y: 1, w: 2, h: 0.5 },
    semanticRoles: input.semanticRoles ?? [],
    styleRefs: input.styleRefs ?? ["style"],
    assetProvenance: input.assetProvenance ?? { kind: "none", sourceSlidePart, sourceElementId: input.elementIds?.[0] ?? input.id },
    repeatability: input.repeatability ?? { signal: "single", count: 1 },
    resizeFeasibility: input.resizeFeasibility ?? { horizontal: "safe", vertical: "safe" },
    observedSiblings: input.observedSiblings ?? [],
    groupPattern: input.groupPattern ?? "single",
    confidence: input.confidence ?? 0.8,
    ...(input.grouped ? { grouped: true } : {}),
    ...(input.offCanvasHelper ? { offCanvasHelper: true } : {}),
  };
}

function profile(): TemplateConstraintProfile {
  return {
    version: 1,
    compilerVersion: "1",
    sourceDigest: "a".repeat(64),
    elementsDigest: "b".repeat(64),
    canvas: { w: 13.333, h: 7.5 },
    immutableRegions: [
      {
        id: "topbar-repeat",
        sourceElementId: "top-S99",
        sourceSlideId: "S99",
        role: "header_chrome",
        bounds: { x: 0, y: 0, w: 13.333, h: 0.28 },
        reserveSpace: true,
        confidence: 0.94,
        evidence: ["cross_slide_repeat", "stable_geometry", "stable_style", "edge_anchored"],
      },
    ],
    contentRegions: [{ id: "content-main", bounds: { x: 0.8, y: 0.65, w: 11.733, h: 6 } }],
    styleVocabulary: {
      fonts: ["Noto Sans JP"],
      textColors: ["14181C"],
      fillColors: ["FAF9F5", "113A5C"],
      strokeColors: ["113A5C"],
      backgroundColors: ["FAF9F5"],
      textRoles: ["title", "body", "metric", "label", "divider", "surface"],
    },
    policies: { chrome: "immutable", colors: "template_only", fonts: "template_only" },
  };
}

function catalog(extra: TemplateComponent[] = []): TemplateComponentsArtifact {
  return {
    version: 1,
    compilerVersion: "2",
    sourceDigest: "a".repeat(64),
    elementsDigest: "b".repeat(64),
    sourceGeometryDigest: "c".repeat(64),
    canvas: { w: 13.333, h: 7.5 },
    components: [
      component({ id: "top-S01", kind: "card", sourceSlideId: "S01", elementIds: ["top-S01"], sourceBounds: { x: 0, y: 0, w: 13.333, h: 0.28 }, semanticRoles: ["surface"], confidence: 0.95 }),
      component({ id: "old-body-S01", kind: "body_block", sourceSlideId: "S01", semanticRoles: ["body"] }),
      component({ id: "title-S03", kind: "title_block", sourceSlideId: "S03", semanticRoles: ["title"], confidence: 0.99 }),
      component({ id: "body-S04", kind: "body_block", sourceSlideId: "S04", semanticRoles: ["body"], confidence: 0.98 }),
      component({ id: "metric-S08", kind: "metric", sourceSlideId: "S08", semanticRoles: ["metric"], confidence: 0.99 }),
      component({ id: "card-S06", kind: "card", sourceSlideId: "S06", semanticRoles: ["surface"], confidence: 0.97 }),
      component({ id: "divider-S07", kind: "divider", sourceSlideId: "S07", semanticRoles: ["divider"], sourceBounds: { x: 1, y: 1, w: 3, h: 0.02 }, confidence: 0.97 }),
      ...extra,
    ],
    repeatGroups: [],
  };
}

function resolvedScene() {
  const scene = generativeSceneIntentSchema.parse({
    version: 2,
    slideId: "S04",
    semanticIntent: "quantitative",
    headline: "업무 위임 구조",
    layout: {
      strategy: "model_authored",
      nodes: [
        { id: "panel", role: "surface", frame: { x: 0.02, y: 0.22, w: 0.96, h: 0.58 }, componentPreference: "card" },
        { id: "title", role: "headline", text: "업무 위임 구조", frame: { x: 0, y: 0, w: 0.68, h: 0.14 }, emphasis: 1, styleRole: "title", componentPreference: "title_block" },
        { id: "m1", role: "metric", text: "45%", frame: { x: 0.07, y: 0.34, w: 0.22, h: 0.28 }, emphasis: 1, styleRole: "metric", componentPreference: "metric" },
        { id: "m2", role: "metric", text: "40%", frame: { x: 0.39, y: 0.34, w: 0.22, h: 0.28 }, emphasis: 0.8, styleRole: "metric", componentPreference: "metric" },
        { id: "m3", role: "metric", text: "15%", frame: { x: 0.71, y: 0.34, w: 0.2, h: 0.28 }, emphasis: 0.55, styleRole: "metric", componentPreference: "metric" },
      ],
    },
  });
  return resolveGenerativeScene(scene, profile());
}

function operationIndex(operations: ComponentTransformOperation[], operation: ComponentTransformOperation["operation"], componentId: string): number {
  return operations.findIndex((candidate) => candidate.operation === operation && candidate.componentId === componentId);
}

describe("generative Scene component planner", () => {
  it("preserves repeated company chrome and removes old slide content", () => {
    const plan = compileGenerativeSceneComponentPlan(resolvedScene(), "S01", catalog(), profile());

    expect(plan.preservedImmutableComponentIds).toEqual(["top-S01"]);
    expect(plan.operations).not.toContainEqual({ operation: "remove", componentId: "top-S01" });
    expect(plan.operations).toContainEqual({ operation: "remove", componentId: "old-body-S01" });
  });

  it("uses template-native prototypes across source slides at the model-authored bounds", () => {
    const scene = resolvedScene();
    const plan = compileGenerativeSceneComponentPlan(scene, "S01", catalog(), profile());
    const panel = plan.provenance.find((entry) => entry.sceneNodeId === "panel")!;
    const title = plan.provenance.find((entry) => entry.sceneNodeId === "title")!;
    const metrics = plan.provenance.filter((entry) => entry.sceneNodeId.startsWith("m"));

    expect(panel).toMatchObject({ componentId: "card-S06", componentKind: "card", sourceSlideId: "S06" });
    expect(title).toMatchObject({ componentId: "title-S03", sourceSlideId: "S03", text: "업무 위임 구조" });
    expect(metrics).toHaveLength(3);
    expect(metrics.every((entry) => entry.componentId === "metric-S08" && entry.sourceSlideId === "S08")).toBe(true);
    expect(metrics.map((entry) => entry.bounds.x)).toEqual(scene.nodes.filter((node) => node.role === "metric").map((node) => node.bounds.x));
  });

  it("resizes a cloned prototype before moving it to avoid transient canvas overflow", () => {
    const plan = compileGenerativeSceneComponentPlan(resolvedScene(), "S01", catalog(), profile());
    const alias = "generative.m1";
    expect(operationIndex(plan.operations, "resize", alias)).toBeGreaterThan(-1);
    expect(operationIndex(plan.operations, "resize", alias)).toBeLessThan(operationIndex(plan.operations, "move", alias));
    expect(operationIndex(plan.operations, "move", alias)).toBeLessThan(operationIndex(plan.operations, "replace_text", alias));
  });

  it("hard-fails non-immutable grouped base content that cannot be sanitized", () => {
    const grouped = component({ id: "grouped-S01", kind: "body_block", sourceSlideId: "S01", semanticRoles: ["body"], grouped: true });
    expect(() => compileGenerativeSceneComponentPlan(resolvedScene(), "S01", catalog([grouped]), profile())).toThrow(/GENERATIVE_BASE_UNSANITIZABLE/);
  });

  it("rejects stale component-catalog provenance", () => {
    const stale = { ...catalog(), elementsDigest: "f".repeat(64) };
    expect(() => compileGenerativeSceneComponentPlan(resolvedScene(), "S01", stale, profile())).toThrow(/PROVENANCE_MISMATCH/);
  });
});
