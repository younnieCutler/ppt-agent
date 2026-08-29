import { describe, expect, it } from "vitest";
import { extractTemplateElements, compileTemplateGrammar } from "../../src/template-analysis";
import {
  applyPatternLabels,
  classifyTemplateAsset,
  compileTemplatePatterns,
  patternLabelSchema,
  resolvePatternPlan,
  resolveSlotContent,
  type TemplatePatternsArtifact,
} from "../../src/template-patterns";
import type { CompositionPlan } from "../../src/planning";
import { buildPatternFixture, FIXTURE_STRINGS } from "../fixtures/pattern-template";
import type { DeckPlan, SlideSpec } from "../../src/schema";

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

  it("classifies a full-bleed z-index-0 image as unknown, not assumed structural background — it could equally be a cover photo the template author left as an example", () => {
    expect(classifyTemplateAsset({ ...base, type: "image", role: "unknown", zIndex: 0, bounds: { x: 0, y: 0, w: 13.3, h: 7.5 } }, slideSize)).toBe("unknown");
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

  it("gives the body slide's divider a preserved structural shape (by its real shape name), not a replaceable slot", async () => {
    const elements = await extractTemplateElements(await buildPatternFixture());
    const grammar = compileTemplateGrammar(elements);
    const artifact = compileTemplatePatterns(elements, grammar);
    const body = artifact.patterns[1];
    const divider = elements.slides[1].elements.find((element) => element.role === "divider");
    expect(divider).toBeDefined();
    // preservedShapeIds/replaceableSlots[].shapeId carry the raw PowerPoint shape name —
    // pptx-automizer selects shapes by name, never by our composite element id.
    expect(body.skeleton.preservedShapeIds).toContain(divider!.name);
    expect(body.skeleton.replaceableSlots.some((slot) => slot.shapeId === divider!.name)).toBe(false);
  });
});

describe("compileTemplatePatterns: ambiguous shape names", () => {
  it("defensively removes an example_content element whose name is not unique on the slide, rather than risk a collision", async () => {
    const elements = await extractTemplateElements(await buildPatternFixture());
    const duplicated = {
      ...elements,
      slides: elements.slides.map((slide, index) => index === 0
        ? { ...slide, elements: slide.elements.map((element) => ({ ...element, name: "Duplicate Name" })) }
        : slide),
    };
    const grammar = compileTemplateGrammar(elements);
    const artifact = compileTemplatePatterns(duplicated, grammar);
    const cover = artifact.patterns[0];
    expect(cover.skeleton.replaceableSlots).toHaveLength(0);
    expect(cover.skeleton.preservedShapeIds).toHaveLength(0);
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

describe("resolvePatternPlan", () => {
  const coverPattern: TemplatePatternsArtifact["patterns"][number] = {
    id: "pattern-S01", sourceSlideId: "S01", sourceSlideNumber: 1,
    suitableFor: { functions: ["cover"], compositions: [], densities: ["low"], confidence: 0.9 },
    skeleton: { sourceSlidePart: "ppt/slides/slide1.xml", preservedShapeIds: [], removableContentIds: [], assetClasses: {}, replaceableSlots: [{ id: "e1", role: "title", binding: "headline", shapeId: "Cover Title", bounds: { x: 0, y: 0, w: 1, h: 1 }, required: true }] },
    visualSignature: { backgroundTreatment: "plain", compositionFamily: "single_focal", surfaceUsage: "none", density: "low" },
  };
  const bodyPattern: TemplatePatternsArtifact["patterns"][number] = {
    id: "pattern-S02", sourceSlideId: "S02", sourceSlideNumber: 2,
    suitableFor: { functions: [], compositions: [], densities: ["medium"], confidence: 0.5 },
    skeleton: { sourceSlidePart: "ppt/slides/slide2.xml", preservedShapeIds: [], removableContentIds: [], assetClasses: {}, replaceableSlots: [{ id: "e2", role: "title", binding: "headline", shapeId: "Body Heading", bounds: { x: 0, y: 0, w: 1, h: 1 }, required: true }] },
    visualSignature: { backgroundTreatment: "plain", compositionFamily: "column_zones", surfaceUsage: "none", density: "medium" },
  };
  const noHeadlinePattern: TemplatePatternsArtifact["patterns"][number] = {
    id: "pattern-S03", sourceSlideId: "S03", sourceSlideNumber: 3,
    suitableFor: { functions: ["cover"], compositions: [], densities: ["low"], confidence: 0.99 },
    skeleton: { sourceSlidePart: "ppt/slides/slide3.xml", preservedShapeIds: [], removableContentIds: [], assetClasses: {}, replaceableSlots: [] },
    visualSignature: { backgroundTreatment: "plain", compositionFamily: "single_focal", surfaceUsage: "none", density: "low" },
  };
  const patterns: TemplatePatternsArtifact = { version: 1, compilerVersion: "1", sourceDigest: "x", elementsDigest: "y", patterns: [coverPattern, bodyPattern, noHeadlinePattern] };

  const deckPlan: DeckPlan = {
    version: 1, title: "t", narrativeThesis: "n",
    slides: [
      { id: "S01", storyBeat: "opening", thesis: "t1", function: "cover", primaryEvidence: [{ sourceId: "s", excerptId: "e" }], secondaryEvidence: [], visualIntent: "single_focal", density: "low", takeaway: "tk1" },
      { id: "S02", storyBeat: "problem", thesis: "t2", function: "statement", primaryEvidence: [{ sourceId: "s", excerptId: "e" }], secondaryEvidence: [], visualIntent: "hierarchy", density: "medium", takeaway: "tk2" },
    ],
  } as unknown as DeckPlan;

  const compositionPlan: CompositionPlan = {
    version: 1,
    slides: [
      { id: "S01", candidates: [{ layout: "title", composition: "cover", family: "single_focal", rank: 1, reasons: [] }] },
      { id: "S02", candidates: [{ layout: "statement", composition: "hero_evidence", family: "column_zones", rank: 1, reasons: [] }] },
    ],
  };

  it("never includes a pattern with no headline-bindable slot, however high its confidence", () => {
    const plan = resolvePatternPlan(deckPlan, compositionPlan, patterns);
    const coverSlide = plan.slides.find((slide) => slide.id === "S01")!;
    expect(coverSlide.candidates.some((candidate) => candidate.patternId === "pattern-S03")).toBe(false);
  });

  it("ranks the function-matching, family-matching pattern first for the cover slide", () => {
    const plan = resolvePatternPlan(deckPlan, compositionPlan, patterns);
    const coverSlide = plan.slides.find((slide) => slide.id === "S01")!;
    expect(coverSlide.candidates[0].patternId).toBe("pattern-S01");
    expect(coverSlide.candidates[0].rank).toBe(1);
  });

  it("ranks the family-matching pattern first for the body slide even with no function label", () => {
    const plan = resolvePatternPlan(deckPlan, compositionPlan, patterns);
    const bodySlide = plan.slides.find((slide) => slide.id === "S02")!;
    expect(bodySlide.candidates[0].patternId).toBe("pattern-S02");
  });

  it("returns a shortlist capped at 3 candidates per slide", () => {
    const plan = resolvePatternPlan(deckPlan, compositionPlan, patterns);
    plan.slides.forEach((slide) => expect(slide.candidates.length).toBeLessThanOrEqual(3));
  });
});
