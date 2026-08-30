import { describe, expect, it } from "vitest";
import type { TemplateComponent, TemplateComponentsArtifact } from "../../src/template-components";
import type { TemplateDesignSystemArtifact } from "../../src/template-design-system";
import { adaptiveCompositionFamilies, planAdaptiveSlide, type AdaptiveSlideIntent } from "../../src/adaptive-composition";

const templateDigest = "a".repeat(64);
const frame = { x: 1, y: 1, w: 10, h: 5 };

const designSystem = {
  version: 1,
  compilerVersion: "2",
  sourceDigest: templateDigest,
  elementsDigest: "b".repeat(64),
  coordinateSpace: { mode: "identity", canvas: { w: 13.333, h: 7.5 }, sourceFrame: { x: 0, y: 0, w: 13.333, h: 7.5 }, scale: { x: 1, y: 1 } },
  canvas: { w: 13.333, h: 7.5 },
  typography: { roles: {}, typeScale: { values: [16], min: 16, max: 16 } },
  colors: { text: [], fill: [], stroke: [], background: [] },
  geometry: { contentFrame: frame, outerMargins: { x: 1, y: 1, w: 1.333, h: 1.5 }, gutters: [0.42] },
  spacing: { rhythm: [0.42] },
  dividers: { orientations: [], thicknesses: [], lengths: [], strokeWidthsPt: [], colors: [] },
  surfaces: { fills: [], borders: [], borderWidthsPt: [] },
  alignmentAnchors: { x: [], y: [] },
} as unknown as TemplateDesignSystemArtifact;

function component(id: string, kind: TemplateComponent["kind"], repeatable = true): TemplateComponent {
  return {
    id,
    kind,
    sourceSlideId: "S01",
    sourceSlidePart: "ppt/slides/slide1.xml",
    elementIds: [`element-${id}`],
    shapeNames: [`shape-${id}`],
    sourceBounds: { x: 1, y: 1, w: 2, h: 1 },
    semanticRoles: [],
    styleRefs: ["style-template"],
    assetProvenance: { kind: "none", sourceSlidePart: "ppt/slides/slide1.xml", sourceElementId: `element-${id}` },
    repeatability: { signal: repeatable ? "repeatable" : "single", count: repeatable ? 4 : 1 },
    resizeFeasibility: { horizontal: "safe", vertical: "safe" },
    observedSiblings: [],
    groupPattern: repeatable ? "horizontal_row" : "single",
    confidence: 0.9,
  };
}

const components = {
  version: 1,
  compilerVersion: "2",
  sourceDigest: templateDigest,
  elementsDigest: "b".repeat(64),
  sourceGeometryDigest: "c".repeat(64),
  canvas: designSystem.canvas,
  coordinateSpace: designSystem.coordinateSpace,
  components: [
    component("title", "title_block", false),
    component("body", "body_block"),
    component("label", "label"),
    component("metric", "metric"),
    component("card", "card"),
    component("list", "list_item"),
  ],
  repeatGroups: [],
} as unknown as TemplateComponentsArtifact;

function intent(family: AdaptiveSlideIntent["family"], blocks: AdaptiveSlideIntent["blocks"]): AdaptiveSlideIntent {
  return { slideId: "S01", family, blocks };
}

function block(id: string, role: AdaptiveSlideIntent["blocks"][number]["role"], text: string, group?: string): AdaptiveSlideIntent["blocks"][number] {
  return { id, role, text, priority: 50, emphasis: "supporting", ...(group ? { group } : {}) };
}

describe("content-first adaptive composition planning", () => {
  it("accepts only semantic host input and rejects geometry or shape identifiers", () => {
    expect(() => planAdaptiveSlide({ templateDigest, designSystem, components, intent: { ...intent("stack", [block("headline", "headline", "A headline")]), x: 1 } as never })).toThrow(/Unrecognized key.*x/);
    expect(() => planAdaptiveSlide({ templateDigest, designSystem, components, intent: { ...intent("stack", [block("headline", "headline", "A headline")]), shapeId: "shape-1" } as never })).toThrow(/Unrecognized key.*shapeId/);
  });

  it("plans all four families inside the observed content frame using observed spacing", () => {
    const cases: Array<[AdaptiveSlideIntent["family"], AdaptiveSlideIntent["blocks"]]> = [
      ["stack", [block("headline", "headline", "The headline", "primary"), block("body", "body", "The body copy", "support")]],
      ["two_column", [block("left", "item", "Left content", "left"), block("right", "item", "Right content", "right")]],
      ["metric_row", [block("m1", "metric", "10"), block("m2", "metric", "20"), block("m3", "metric", "30")]],
      ["repeated_cards", [block("c1", "item", "Card one"), block("c2", "item", "Card two"), block("c3", "item", "Card three")]],
    ];
    expect(adaptiveCompositionFamilies).toEqual(["stack", "two_column", "metric_row", "repeated_cards"]);
    for (const [family, blocks] of cases) {
      const plan = planAdaptiveSlide({ templateDigest, designSystem, components, intent: intent(family, blocks) });
      expect(plan.family).toBe(family);
      expect(plan.contentFrame).toEqual(frame);
      expect(plan.spacing.gap).toBe(0.42);
      expect(plan.placements.map((placement) => placement.blockId)).toEqual(blocks.map((item) => item.id));
      expect(plan.placements.every((placement) => placement.x >= frame.x && placement.y >= frame.y && placement.x + placement.w <= frame.x + frame.w && placement.y + placement.h <= frame.y + frame.h)).toBe(true);
      expect(plan.textAllocation.every((allocation) => allocation.blockId && allocation.charCount > 0)).toBe(true);
      expect(JSON.stringify(plan)).not.toContain("shapeId");
    }
  });

  it("is deterministic for the same template digest, content, and intent", () => {
    const input = { templateDigest, designSystem, components, intent: intent("repeated_cards", [block("one", "item", "One"), block("two", "item", "Two"), block("three", "item", "Three"), block("four", "item", "Four")]) };
    expect(JSON.stringify(planAdaptiveSlide(input))).toBe(JSON.stringify(planAdaptiveSlide(input)));
  });

  it("fails explicitly when the selected family has no template-native capability", () => {
    const noMetrics = { ...components, components: components.components.filter((candidate) => candidate.kind !== "metric") };
    expect(() => planAdaptiveSlide({ templateDigest, designSystem, components: noMetrics, intent: intent("metric_row", [block("m1", "metric", "10")]) })).toThrow(/template-native component capability/);
  });
});
