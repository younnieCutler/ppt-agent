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

const component = (id: string, kind: TemplateComponentsArtifact["components"][number]["kind"]): TemplateComponentsArtifact["components"][number] => ({
  id, kind, sourceSlideId: "S01", sourceSlidePart: "ppt/slides/slide1.xml", elementIds: [id], shapeNames: [id], sourceBounds: { x: 1, y: 1, w: 2, h: 1 }, semanticRoles: [], styleRefs: ["style"], assetProvenance: { kind: "none", sourceSlidePart: "ppt/slides/slide1.xml", sourceElementId: id }, repeatability: { signal: "repeatable", count: 3 }, resizeFeasibility: { horizontal: "safe", vertical: "safe" }, observedSiblings: [], groupPattern: "vertical_stack", confidence: 0.9,
});

const components = { version: 1, compilerVersion: "2", sourceDigest: digest, elementsDigest: "b".repeat(64), sourceGeometryDigest: "c".repeat(64), canvas: designSystem.canvas, coordinateSpace: designSystem.coordinateSpace, components: [component("title", "title_block"), component("body", "body_block"), component("label", "label"), component("card", "card"), component("metric", "metric"), component("list", "list_item"), component("divider", "divider")], repeatGroups: [] } as unknown as TemplateComponentsArtifact;

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

  it("plans comparison content with asymmetric groups and preserves an un-emphasized delta", () => {
    const selected = selectAdaptiveMode({
      templateDigest: digest,
      slide: slide({
        id: "S02",
        layout: "comparison",
        composition: "two_column",
        content: {
          left: { label: "Legacy", items: ["One constraint"] },
          right: { label: "Adaptive", items: ["First constraint", "Second constraint", "Third constraint", "Fourth constraint"] },
          delta: "Choose by constraint.",
        },
      }),
      candidates: [],
      designSystem,
      components,
    });
    expect(selected.mode).toBe("adaptive_compose");
    expect(selected.chosen?.componentFamily).toBe("two_column");
    expect(selected.adaptiveContent).toMatchObject({ layout: "comparison", content: { left: { label: "Legacy" }, right: { items: ["First constraint", "Second constraint", "Third constraint", "Fourth constraint"] }, delta: "Choose by constraint." } });
    const left = selected.adaptivePlan!.placements.filter((placement) => placement.blockId.startsWith("left-"));
    const right = selected.adaptivePlan!.placements.filter((placement) => placement.blockId.startsWith("right-") || placement.blockId === "delta");
    expect(left[0].w).not.toBe(right[0].w);
    expect(selected.adaptivePlan!.textAllocation.map((allocation) => allocation.text)).toContain("Choose by constraint.");
    expect(selected.adaptivePlan!.textAllocation.some((allocation) => allocation.text === "The headline")).toBe(true);
    expect(selected.adaptivePlan!.textAllocation.some((allocation) => allocation.text === "The headline")).toBe(true);
  });

  it("uses a native emphasis component for comparison delta when one exists", () => {
    const withEmphasis = { ...components, components: [...components.components, component("emphasis", "key_message")] };
    const selected = selectAdaptiveMode({
      templateDigest: digest,
      slide: slide({
        id: "S02",
        layout: "comparison",
        composition: "two_column",
        content: { left: { label: "A", items: ["A item"] }, right: { label: "B", items: ["B item"] }, delta: "Delta" },
      }),
      candidates: [],
      designSystem,
      components: withEmphasis,
    });
    expect(selected.adaptivePlan!.placements.find((placement) => placement.blockId === "delta")?.componentKind).toBe("key_message");
  });

  it("reflows quantitative metrics and preserves period, comparison basis, and note", () => {
    const metrics = Array.from({ length: 5 }, (_, index) => ({
      label: `Metric ${index + 1}`,
      value: index + 1,
      unit: "%",
      period: "Q2",
      comparisonBasis: "Q1",
      note: "Grounded note",
    }));
    const selected = selectAdaptiveMode({
      templateDigest: digest,
      slide: slide({ id: "S02", layout: "quantitative", composition: "kpi_row", content: { kind: "kpi", metrics } }),
      candidates: [],
      designSystem,
      components,
    });
    expect(selected.mode).toBe("adaptive_compose");
    expect(selected.chosen?.componentFamily).toBe("metric_row");
    expect(selected.adaptiveContent).toMatchObject({ layout: "quantitative", content: { metrics } });
    expect(selected.adaptivePlan!.placements).toHaveLength(5);
    expect(selected.adaptivePlan!.rows).toBeGreaterThan(1);
    expect(selected.adaptivePlan!.textAllocation[0].text).toContain("Q2");
    expect(selected.adaptivePlan!.textAllocation[0].text).toContain("Q1");
    expect(selected.adaptivePlan!.textAllocation[0].text).toContain("Grounded note");
    expect(selected.adaptivePlan!.textAllocation.some((allocation) => allocation.text === "The headline")).toBe(true);
    expect(selected.adaptivePlan!.textAllocation.some((allocation) => allocation.text === "The headline")).toBe(true);
  });

  it("hard-fails quantitative adaptive composition without a native metric component", () => {
    const noMetrics = { ...components, components: components.components.filter((candidate) => candidate.kind !== "metric") };
    const diagnosis = diagnoseAdaptiveMode({
      templateDigest: digest,
      slide: slide({ id: "S02", layout: "quantitative", composition: "kpi_row", content: { kind: "kpi", metrics: [{ label: "Metric", value: 10, unit: "%", period: "Q2" }] } }),
      candidates: [],
      designSystem,
      components: noMetrics,
    });
    expect(diagnosis.mode).toBe("unsupported");
    expect(diagnosis.rejectionReasons.map((reason) => reason.code)).toContain("adaptive_capability");
    expect(() => selectAdaptiveMode({ templateDigest: digest, slide: slide({ id: "S02", layout: "quantitative", composition: "kpi_row", content: { kind: "kpi", metrics: [{ label: "Metric", value: 10, unit: "%", period: "Q2" }] } }), candidates: [], designSystem, components: noMetrics })).toThrow(/TEMPLATE_COMPOSITION_UNSUPPORTED/);
  });

  it("repeats process steps and preserves detail and members as semantic content", () => {
    const selected = selectAdaptiveMode({
      templateDigest: digest,
      slide: slide({ id: "S02", layout: "process", composition: "sequence", content: { steps: [
        { id: "capture", label: "Capture", detail: "Collect evidence", members: ["Source", "Event"] },
        { id: "map", label: "Map", detail: "Connect requirements", members: ["Skill"] },
        { id: "review", label: "Review", detail: "Approve output", members: ["Draft"] },
      ] } }),
      candidates: [],
      designSystem,
      components,
    });
    expect(selected.mode).toBe("adaptive_compose");
    expect(selected.chosen?.componentFamily).toBe("repeated_cards");
    expect(selected.adaptiveContent?.layout).toBe("process");
    expect((selected.adaptiveContent as Extract<typeof selected.adaptiveContent, { layout: "process" }>).content.steps[0]).toMatchObject({ label: "Capture", members: ["Source", "Event"] });
    expect(selected.adaptivePlan!.placements.every((placement) => placement.componentKind === "list_item")).toBe(true);
    expect(selected.adaptivePlan!.textAllocation[0].text).toContain("Source");
  });

  it("uses repeated native text components for timeline milestones", () => {
    const selected = selectAdaptiveMode({
      templateDigest: digest,
      slide: slide({ id: "S02", layout: "timeline", composition: "linear_roadmap", content: { milestones: [
        { label: "Start", date: "2026-01", detail: "Open" },
        { label: "Ship", date: "2026-02", detail: "Release" },
      ] } }),
      candidates: [],
      designSystem,
      components,
    });
    expect(selected.mode).toBe("adaptive_compose");
    expect(selected.chosen?.componentFamily).toBe("repeated_cards");
    expect(selected.adaptiveContent).toMatchObject({ layout: "timeline", content: { milestones: [{ date: "2026-01" }, { date: "2026-02" }] } });
    expect(selected.adaptivePlan!.textAllocation.map((allocation) => allocation.text).join(" ")).toContain("2026-02");
  });

  it("supports evidence and text-only title while gating media on a native media frame", () => {
    const evidence = selectAdaptiveMode({
      templateDigest: digest,
      slide: slide({ id: "S02", layout: "evidence", composition: "evidence_list", content: { caption: "Caption", bullets: ["Bullet one", "Bullet two"] } }),
      candidates: [],
      designSystem,
      components,
    });
    expect(evidence.mode).toBe("adaptive_compose");
    expect(evidence.adaptiveContent).toMatchObject({ layout: "evidence", content: { caption: "Caption", bullets: ["Bullet one", "Bullet two"] } });

    const title = selectAdaptiveMode({
      templateDigest: digest,
      slide: slide({ id: "S02", layout: "title", composition: "cover", content: { kicker: "Kicker", subtitle: "Subtitle" } }),
      candidates: [],
      designSystem,
      components,
    });
    expect(title.mode).toBe("adaptive_compose");
    expect(title.adaptiveContent).toMatchObject({ layout: "title", content: { kicker: "Kicker", subtitle: "Subtitle" } });

    const withAsset = diagnoseAdaptiveMode({
      templateDigest: digest,
      slide: slide({ id: "S02", layout: "evidence", composition: "evidence_panel", content: { assetPath: "/tmp/evidence.png", bullets: ["Bullet"] } }),
      candidates: [],
      designSystem,
      components,
    });
    expect(withAsset.mode).toBe("unsupported");
    expect(withAsset.rejectionReasons.map((reason) => reason.code)).toContain("media_capability");

    const withMedia = { ...components, components: [...components.components, component("media", "media_frame")] };
    const mediaTitle = selectAdaptiveMode({
      templateDigest: digest,
      slide: slide({ id: "S02", layout: "title", composition: "cover", content: { subtitle: "Subtitle", imagePath: "/tmp/title.png" } }),
      candidates: [],
      designSystem,
      components: withMedia,
    });
    expect(mediaTitle.mode).toBe("adaptive_compose");
    expect(mediaTitle.adaptivePlan?.media).toMatchObject({ componentId: "media", assetPath: "/tmp/title.png" });
  });

  it("keeps structured architecture, pipeline, and chart outside the text adaptive scope", () => {
    for (const layout of ["architecture", "pipeline", "chart"] as const) {
      const diagnosis = diagnoseAdaptiveMode({ templateDigest: digest, slide: slide({ id: "S02", layout, composition: layout === "architecture" ? "architecture_zones" : layout === "pipeline" ? "pipeline_lanes" : "native_chart", content: {} }), candidates: [], designSystem, components });
      expect(diagnosis.mode).toBe("unsupported");
      expect(diagnosis.rejectionReasons.map((reason) => reason.code)).toContain("adaptive_capability");
    }
  });
});
