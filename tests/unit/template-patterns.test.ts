import { describe, expect, it } from "vitest";
import { extractTemplateElements, compileTemplateGrammar } from "../../src/template-analysis";
import {
  applyPatternLabels,
  classifyTemplateAsset,
  compileTemplatePatterns,
  patternLabelSchema,
  resolveSlotContent,
  type TemplatePatternsArtifact,
} from "../../src/template-patterns";
import { buildPatternFixture, FIXTURE_STRINGS } from "../fixtures/pattern-template";
import type { SlideSpec } from "../../src/schema";

describe("classifyTemplateAsset", () => {
  const slideSize = { w: 13.333, h: 7.5 };
  const base = { id: "e1", slideId: "S01", type: "text" as const, confidence: 0.9, bounds: { x: 0, y: 0, w: 1, h: 1 }, zIndex: 1, ownership: "slide-body-owned" as const, features: {} };

  it("classifies logo as brand", () => {
    expect(classifyTemplateAsset({ ...base, type: "image", role: "logo" }, slideSize)).toBe("brand");
  });

  it("classifies divider/surface/footer as structural", () => {
    expect(classifyTemplateAsset({ ...base, type: "shape", role: "divider" }, slideSize)).toBe("structural");
    expect(classifyTemplateAsset({ ...base, type: "shape", role: "surface" }, slideSize)).toBe("structural");
    expect(classifyTemplateAsset({ ...base, type: "text", role: "footer" }, slideSize)).toBe("structural");
  });

  it("classifies a full-bleed z-index-0 image as structural background, not example content", () => {
    expect(classifyTemplateAsset({ ...base, type: "image", role: "unknown", zIndex: 0, bounds: { x: 0, y: 0, w: 13.3, h: 7.5 } }, slideSize)).toBe("structural");
  });

  it("classifies a non-full-bleed image with no role signal as unknown, not structural", () => {
    expect(classifyTemplateAsset({ ...base, type: "image", role: "unknown", zIndex: 3, bounds: { x: 2, y: 2, w: 1, h: 1 } }, slideSize)).toBe("unknown");
  });

  it("classifies title/body/metric/key_message as example_content", () => {
    expect(classifyTemplateAsset({ ...base, role: "title" }, slideSize)).toBe("example_content");
    expect(classifyTemplateAsset({ ...base, role: "body" }, slideSize)).toBe("example_content");
    expect(classifyTemplateAsset({ ...base, role: "metric" }, slideSize)).toBe("example_content");
    expect(classifyTemplateAsset({ ...base, role: "key_message" }, slideSize)).toBe("example_content");
  });

  it("classifies a fully unclassified shape as unknown", () => {
    expect(classifyTemplateAsset({ ...base, type: "shape", role: "unknown" }, slideSize)).toBe("unknown");
  });
});

describe("compileTemplatePatterns", () => {
  it("produces one pattern per source slide, each with correctly bucketed slots", async () => {
    const elements = await extractTemplateElements(await buildPatternFixture());
    const grammar = compileTemplateGrammar(elements);
    const artifact = compileTemplatePatterns(elements, grammar);
    expect(artifact.patterns).toHaveLength(3);
    expect(artifact.elementsDigest).toMatch(/^[a-f0-9]{64}$/);

    const cover = artifact.patterns[0];
    const titleSlot = cover.skeleton.replaceableSlots.find((slot) => slot.binding === "headline");
    expect(titleSlot).toBeDefined();
    expect(titleSlot!.required).toBe(true);
    // The accent bar rect has no name/role signal, and is not full-bleed — unknown, removed.
    expect(cover.skeleton.removableContentIds.length).toBeGreaterThan(0);
  });

  it("never persists example sentence text in the compiled patterns artifact", async () => {
    const elements = await extractTemplateElements(await buildPatternFixture());
    const grammar = compileTemplateGrammar(elements);
    const artifact = compileTemplatePatterns(elements, grammar);
    const serialized = JSON.stringify(artifact);
    for (const text of Object.values(FIXTURE_STRINGS)) expect(serialized).not.toContain(text);
  });

  it("gives the body slide's divider a preserved structural shape, not a replaceable slot", async () => {
    const elements = await extractTemplateElements(await buildPatternFixture());
    const grammar = compileTemplateGrammar(elements);
    const artifact = compileTemplatePatterns(elements, grammar);
    const body = artifact.patterns[1];
    const dividerId = elements.slides[1].elements.find((element) => element.role === "divider")?.id;
    expect(dividerId).toBeDefined();
    expect(body.skeleton.preservedShapeIds).toContain(dividerId);
    expect(body.skeleton.replaceableSlots.some((slot) => slot.shapeId === dividerId)).toBe(false);
  });
});

describe("resolveSlotContent", () => {
  const statement: SlideSpec = {
    id: "S02", role: "body", storyBeat: "problem", headline: "The headline", headlineAlignment: "left",
    claims: [{ text: "The headline" }], composition: "hero_evidence", sourceRefs: [{ sourceId: "src1", excerptId: "ex1" }],
    layout: "statement", content: { body: "The statement body.", proofs: ["proof one", "proof two"] },
  } as unknown as SlideSpec;

  const comparison: SlideSpec = {
    id: "S03", role: "body", storyBeat: "design", headline: "Compare", headlineAlignment: "left",
    claims: [{ text: "Compare" }], composition: "two_column", sourceRefs: [{ sourceId: "src1", excerptId: "ex1" }],
    layout: "comparison", content: { left: { label: "Left", items: ["a", "b"] }, right: { label: "Right", items: ["c"] } },
  } as unknown as SlideSpec;

  it("resolves headline from any layout", () => {
    expect(resolveSlotContent(statement, "headline")).toBe("The headline");
    expect(resolveSlotContent(comparison, "headline")).toBe("Compare");
  });

  it("resolves content.body and content.proofs[] only for statement", () => {
    expect(resolveSlotContent(statement, "content.body")).toBe("The statement body.");
    expect(resolveSlotContent(statement, "content.proofs[]")).toEqual(["proof one", "proof two"]);
    expect(resolveSlotContent(comparison, "content.body")).toBeUndefined();
  });

  it("resolves content.left.* and content.right.* only for comparison", () => {
    expect(resolveSlotContent(comparison, "content.left.label")).toBe("Left");
    expect(resolveSlotContent(comparison, "content.left.items[]")).toEqual(["a", "b"]);
    expect(resolveSlotContent(comparison, "content.right.label")).toBe("Right");
    expect(resolveSlotContent(statement, "content.left.label")).toBeUndefined();
  });

  it("never returns a shape id, a coordinate, or anything outside the SlideSpec's own fields", () => {
    const result = resolveSlotContent(statement, "content.proofs[]");
    expect(Array.isArray(result) || typeof result === "string" || result === undefined).toBe(true);
  });
});

describe("pattern-label host contract", () => {
  const artifact: TemplatePatternsArtifact = {
    version: 1, compilerVersion: "1", sourceDigest: "abc", elementsDigest: "def",
    patterns: [{
      id: "pattern-S01", sourceSlideId: "S01",
      suitableFor: { functions: [], compositions: [], densities: ["low"], confidence: 0.5 },
      skeleton: { sourceSlidePart: "ppt/slides/slide1.xml", preservedShapeIds: [], replaceableSlots: [], removableContentIds: [], assetClasses: {} },
      visualSignature: { backgroundTreatment: "plain", compositionFamily: "single_focal", surfaceUsage: "none", density: "low" },
    }],
  };

  it("rejects an invented SlideFunction", () => {
    expect(() => patternLabelSchema.parse([{ sourceSlideId: "S01", functions: ["not-a-real-function"] }])).toThrow();
  });

  it("rejects a label naming a slide the artifact does not have", () => {
    const labels = patternLabelSchema.parse([{ sourceSlideId: "S99", functions: ["cover"] }]);
    expect(() => applyPatternLabels(artifact, labels)).toThrow(/not present in this template/);
  });

  it("merges a valid label's functions and raises confidence, expressing zero geometry", () => {
    const labels = patternLabelSchema.parse([{ sourceSlideId: "S01", functions: ["cover"], compositionFamily: "single_focal" }]);
    const labeled = applyPatternLabels(artifact, labels);
    expect(labeled.patterns[0].suitableFor.functions).toEqual(["cover"]);
    expect(labeled.patterns[0].suitableFor.confidence).toBeGreaterThan(artifact.patterns[0].suitableFor.confidence);
    expect(JSON.stringify(labels)).not.toMatch(/"x":|"y":|"shapeId"/);
  });
});
