import { describe, expect, it } from "vitest";
import { checkTemplateFidelityUnproven, checkTemplatePatternNotFound, checkTemplateSlotCapacity } from "../../src/template-fidelity";
import type { TemplatePattern } from "../../src/template-patterns";
import type { SlideSpec } from "../../src/schema";

describe("checkTemplateFidelityUnproven", () => {
  it("fires hard when a source_slide_pattern deck has any generically-rendered slide", () => {
    const findings = checkTemplateFidelityUnproven("source_slide_pattern", [
      { slideId: "S01", mode: "pattern:pattern-S01" },
      { slideId: "S02", mode: "renderer" },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "hard", code: "TEMPLATE_FIDELITY_UNPROVEN", slideId: "S02" });
  });

  it("never fires for hybrid — mixing pattern and generic slides is legitimate there", () => {
    expect(checkTemplateFidelityUnproven("hybrid", [{ slideId: "S01", mode: "renderer" }])).toHaveLength(0);
  });

  it("never fires for native_layout", () => {
    expect(checkTemplateFidelityUnproven("native_layout", [{ slideId: "S01", mode: "renderer" }])).toHaveLength(0);
  });

  it("does not fire when every slide used a pattern", () => {
    expect(checkTemplateFidelityUnproven("source_slide_pattern", [{ slideId: "S01", mode: "pattern:pattern-S01" }])).toHaveLength(0);
  });
});

describe("checkTemplatePatternNotFound", () => {
  it("fires hard for a source_slide_pattern slide with an empty candidate shortlist", () => {
    const findings = checkTemplatePatternNotFound("source_slide_pattern", { slides: [{ id: "S01", candidates: [] }, { id: "S02", candidates: [{}] }] });
    expect(findings).toEqual([{ severity: "hard", code: "TEMPLATE_PATTERN_NOT_FOUND", slideId: "S01", message: expect.any(String) }]);
  });

  it("never fires for native_layout or hybrid", () => {
    expect(checkTemplatePatternNotFound("native_layout", { slides: [{ id: "S01", candidates: [] }] })).toHaveLength(0);
    expect(checkTemplatePatternNotFound("hybrid", { slides: [{ id: "S01", candidates: [] }] })).toHaveLength(0);
  });
});

describe("checkTemplateSlotCapacity", () => {
  const pattern = (maxChars: number, required: boolean): TemplatePattern => ({
    id: "p1", sourceSlideId: "S01", sourceSlideNumber: 1,
    suitableFor: { functions: [], compositions: [], densities: ["low"], confidence: 0.5 },
    skeleton: {
      sourceSlidePart: "ppt/slides/slide1.xml", preservedShapeIds: [], removableContentIds: [], assetClasses: {},
      replaceableSlots: [{ id: "slot1", role: "title", binding: "headline", shapeId: "Title", bounds: { x: 0, y: 0, w: 1, h: 1 }, maxChars, required }],
    },
    visualSignature: { backgroundTreatment: "plain", compositionFamily: "single_focal", surfaceUsage: "none", density: "low" },
  });

  const slide: SlideSpec = {
    id: "S01", role: "opener", storyBeat: "opening", headline: "A headline far too long for a ten-character budget", headlineAlignment: "left",
    claims: [{ text: "x" }], composition: "cover", sourceRefs: [{ sourceId: "s", excerptId: "e" }],
    layout: "title", content: {},
  } as unknown as SlideSpec;

  it("reports TEMPLATE_SLOT_OVERFLOW (hard) when a required slot overflows", () => {
    const findings = checkTemplateSlotCapacity({ slides: [slide] }, new Map([["S01", pattern(10, true)]]));
    expect(findings).toEqual([expect.objectContaining({ severity: "hard", code: "TEMPLATE_SLOT_OVERFLOW", slideId: "S01" })]);
  });

  it("reports TEMPLATE_SLOT_TRUNCATED (risk) when a non-required slot overflows", () => {
    const findings = checkTemplateSlotCapacity({ slides: [slide] }, new Map([["S01", pattern(10, false)]]));
    expect(findings).toEqual([expect.objectContaining({ severity: "risk", code: "TEMPLATE_SLOT_TRUNCATED", slideId: "S01" })]);
  });

  it("reports nothing when the content fits", () => {
    expect(checkTemplateSlotCapacity({ slides: [slide] }, new Map([["S01", pattern(1000, true)]]))).toHaveLength(0);
  });

  it("reports nothing for a slide with no chosen pattern", () => {
    expect(checkTemplateSlotCapacity({ slides: [slide] }, new Map())).toHaveLength(0);
  });
});
