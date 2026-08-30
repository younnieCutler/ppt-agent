import { describe, expect, it } from "vitest";
import type { SlideSpec } from "../../src/schema";
import type { TemplatePattern } from "../../src/template-patterns";
import type { TemplateComponentsArtifact } from "../../src/template-components";
import type { TemplateDesignSystemArtifact } from "../../src/template-design-system";
import { diagnoseAdaptiveMode, selectAdaptiveMode } from "../../src/adaptive-selection";

const digest = "a".repeat(64);
const slide = (overrides: Record<string, unknown> = {}): SlideSpec => ({
  id: "S01", role: "body", storyBeat: "problem", headline: "The headline", headlineAlignment: "left",
  claims: [{ text: "The headline", kind: "fact", status: "verified" }], composition: "hero_evidence", sourceRefs: [{ sourceId: "source", excerptId: "excerpt" }],
  layout: "statement", content: { body: "The body", proofs: ["Proof one", "Proof two"] }, ...overrides,
} as unknown as SlideSpec);

const pattern = (slots: TemplatePattern["skeleton"]["replaceableSlots"]): TemplatePattern => ({
  id: "pattern-S01", sourceSlideId: "S01", sourceSlideNumber: 1,
  suitableFor: { functions: ["statement"], compositions: ["hero_evidence"], densities: ["medium"], confidence: 0.9 },
  skeleton: { sourceSlidePart: "ppt/slides/slide1.xml", preservedShapeIds: [], replaceableSlots: slots, removableContentIds: [], assetClasses: {} },
  visualSignature: { backgroundTreatment: "plain", compositionFamily: "column_zones", surfaceUsage: "none", density: "medium" },
});

const slot = (id: string, binding: "headline" | "content.body" | "content.proofs[]", maxChars = 100): TemplatePattern["skeleton"]["replaceableSlots"][number] => ({ id, role: binding === "headline" ? "title" : binding === "content.body" ? "body" : "label", binding, shapeId: id, bounds: { x: 1, y: 1, w: 4, h: 1 }, maxChars, maxLines: 2, required: binding === "headline", repeatable: binding.endsWith("[]") });

const designSystem = {
  version: 1, compilerVersion: "2", sourceDigest: digest, elementsDigest: "b".repeat(64),
  coordinateSpace: { mode: "identity", canvas: { w: 13.333, h: 7.5 }, sourceFrame: { x: 0, y: 0, w: 13.333, h: 7.5 }, scale: { x: 1, y: 1 } },
  canvas: { w: 13.333, h: 7.5 }, typography: { roles: {}, typeScale: { values: [16], min: 16, max: 16 } },
  colors: { text: [], fill: [], stroke: [], background: [] }, geometry: { contentFrame: { x: 1, y: 1, w: 10, h: 5 }, outerMargins: { x: 1, y: 1, w: 1, h: 1 }, gutters: [0.25] },
  spacing: { rhythm: [0.25] }, dividers: { orientations: [], thicknesses: [], lengths: [], strokeWidthsPt: [], colors: [] }, surfaces: { fills: [], borders: [], borderWidthsPt: [] }, alignmentAnchors: { x: [], y: [] },
} as unknown as TemplateDesignSystemArtifact;

const component = (id: string, kind: "title_block" | "body_block" | "label"): TemplateComponentsArtifact["components"][number] => ({
  id, kind, sourceSlideId: "S01", sourceSlidePart: "ppt/slides/slide1.xml", elementIds: [id], shapeNames: [id], sourceBounds: { x: 1, y: 1, w: 2, h: 1 }, semanticRoles: [], styleRefs: ["style"], assetProvenance: { kind: "none", sourceSlidePart: "ppt/slides/slide1.xml", sourceElementId: id }, repeatability: { signal: "repeatable", count: 3 }, resizeFeasibility: { horizontal: "safe", vertical: "safe" }, observedSiblings: [], groupPattern: "vertical_stack", confidence: 0.9,
});

const components = { version: 1, compilerVersion: "2", sourceDigest: digest, elementsDigest: "b".repeat(64), sourceGeometryDigest: "c".repeat(64), canvas: designSystem.canvas, coordinateSpace: designSystem.coordinateSpace, components: [component("title", "title_block"), component("body", "body_block"), component("label", "label")], repeatGroups: [] } as unknown as TemplateComponentsArtifact;

describe("exact clone vs adaptive compose selection", () => {
  it("accepts exact_clone only when coverage, cardinality, capacity, and composition all fit", () => {
    const selected = selectAdaptiveMode({ templateDigest: digest, slide: slide(), candidates: [{ rank: 1, pattern: pattern([slot("headline", "headline"), slot("body", "content.body"), slot("proof-1", "content.proofs[]"), slot("proof-2", "content.proofs[]")]) }], designSystem, components });
    expect(selected).toMatchObject({ mode: "exact_clone", chosen: { patternId: "pattern-S01" }, rejectionReasons: [] });
  });

  it("falls back to adaptive_compose with explicit exact-clone rejection reasons", () => {
    const selected = selectAdaptiveMode({ templateDigest: digest, slide: slide(), candidates: [{ rank: 1, pattern: pattern([slot("headline", "headline"), slot("body", "content.body")]) }], designSystem, components });
    expect(selected.mode).toBe("adaptive_compose");
    expect(selected.chosen?.componentFamily).toBe("stack");
    expect(selected.adaptivePlan?.placements).toHaveLength(4);
    expect(selected.rejectionReasons.map((reason) => reason.code)).toContain("semantic_coverage");
  });

  it("reports a hard unsupported result when neither exact clone nor adaptive capability exists", () => {
    const noBody = { ...components, components: components.components.filter((candidate) => candidate.kind !== "body_block") };
    const diagnosis = diagnoseAdaptiveMode({ templateDigest: digest, slide: slide(), candidates: [], designSystem, components: noBody });
    expect(diagnosis.mode).toBe("unsupported");
    expect(diagnosis.rejectionReasons.map((reason) => reason.code)).toContain("adaptive_capability");
    expect(() => selectAdaptiveMode({ templateDigest: digest, slide: slide(), candidates: [], designSystem, components: noBody })).toThrow(/TEMPLATE_COMPOSITION_UNSUPPORTED/);
  });

  it("keeps candidate rank ordering deterministic and records rejected candidates", () => {
    const selected = selectAdaptiveMode({ templateDigest: digest, slide: slide(), candidates: [
      { rank: 2, pattern: pattern([slot("headline", "headline"), slot("body", "content.body"), slot("proof", "content.proofs[]", 1)]) },
      { rank: 1, pattern: pattern([slot("headline", "headline")]) },
    ], designSystem, components });
    expect(selected.mode).toBe("adaptive_compose");
    expect(selected.rejectionReasons.filter((reason) => reason.patternId).length).toBeGreaterThanOrEqual(2);
  });
});
