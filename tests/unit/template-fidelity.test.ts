import { describe, expect, it } from "vitest";
import { checkTemplateFidelityUnproven, checkTemplatePatternNotFound, checkTemplateSemanticContentDropped, checkTemplateSlotCapacity } from "../../src/template-fidelity";
import { patternFitsSlide } from "../../src/template-patterns";
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

  it("defers an empty exact shortlist to the adaptive runtime when explicitly enabled", () => {
    expect(checkTemplatePatternNotFound("source_slide_pattern", { slides: [{ id: "S01", candidates: [] }] }, { adaptiveRuntime: true })).toHaveLength(0);
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

describe("checkTemplateSemanticContentDropped: pattern-specific semantic contract, independent of the REQUIRED_NATIVE_OBJECT_MISSING exemption", () => {
  const headlineOnlyPattern: TemplatePattern = {
    id: "p-headline-only", sourceSlideId: "S01", sourceSlideNumber: 1,
    suitableFor: { functions: [], compositions: [], densities: ["low"], confidence: 0.5 },
    skeleton: {
      sourceSlidePart: "ppt/slides/slide1.xml", preservedShapeIds: [], removableContentIds: [], assetClasses: {},
      replaceableSlots: [{ id: "slot1", role: "title", binding: "headline", shapeId: "Title", bounds: { x: 0, y: 0, w: 1, h: 1 }, required: true }],
    },
    visualSignature: { backgroundTreatment: "plain", compositionFamily: "single_focal", surfaceUsage: "none", density: "low" },
  };
  const withBodySlot: TemplatePattern = {
    ...headlineOnlyPattern,
    id: "p-with-body",
    skeleton: {
      ...headlineOnlyPattern.skeleton,
      replaceableSlots: [...headlineOnlyPattern.skeleton.replaceableSlots, { id: "slot2", role: "body", binding: "content.body", shapeId: "Body", bounds: { x: 0, y: 0, w: 1, h: 1 }, required: false }],
    },
  };

  const processSlide: SlideSpec = {
    id: "S01", role: "body", storyBeat: "implementation", headline: "Ship it in three stages", headlineAlignment: "left",
    claims: [{ text: "x" }], composition: "sequence", sourceRefs: [{ sourceId: "s", excerptId: "e" }],
    layout: "process", content: { steps: [{ id: "a", label: "Design" }, { id: "b", label: "Build" }] },
  } as unknown as SlideSpec;

  it("fires hard when the chosen pattern has no slot for the slide's real (non-headline) payload", () => {
    const findings = checkTemplateSemanticContentDropped({ slides: [processSlide] }, new Map([["S01", headlineOnlyPattern]]));
    expect(findings).toEqual([expect.objectContaining({ severity: "hard", code: "TEMPLATE_SEMANTIC_CONTENT_DROPPED", slideId: "S01" })]);
  });

  it("does not fire once a slot resolves the layout's real content (content.body generalizes to process.steps)", () => {
    expect(checkTemplateSemanticContentDropped({ slides: [processSlide] }, new Map([["S01", withBodySlot]]))).toHaveLength(0);
  });

  it("does not fire for title/quantitative layouts — a cover's payload is legitimately just its headline/subtitle", () => {
    const cover: SlideSpec = {
      id: "S01", role: "opener", storyBeat: "opening", headline: "Cover", headlineAlignment: "left",
      claims: [{ text: "Cover" }], composition: "cover", sourceRefs: [{ sourceId: "s", excerptId: "e" }],
      layout: "title", content: {},
    } as unknown as SlideSpec;
    expect(checkTemplateSemanticContentDropped({ slides: [cover] }, new Map([["S01", headlineOnlyPattern]]))).toHaveLength(0);
  });

  it("reports nothing for a slide with no chosen pattern", () => {
    expect(checkTemplateSemanticContentDropped({ slides: [processSlide] }, new Map())).toHaveLength(0);
  });
});

describe("patternFitsSlide", () => {
  const headlineOnlyPattern: TemplatePattern = {
    id: "p-headline-only", sourceSlideId: "S01", sourceSlideNumber: 1,
    suitableFor: { functions: [], compositions: [], densities: ["low"], confidence: 0.5 },
    skeleton: {
      sourceSlidePart: "ppt/slides/slide1.xml", preservedShapeIds: [], removableContentIds: [], assetClasses: {},
      replaceableSlots: [{ id: "slot1", role: "title", binding: "headline", shapeId: "Title", bounds: { x: 0, y: 0, w: 1, h: 1 }, required: true }],
    },
    visualSignature: { backgroundTreatment: "plain", compositionFamily: "single_focal", surfaceUsage: "none", density: "low" },
  };
  const withBodySlot: TemplatePattern = {
    ...headlineOnlyPattern,
    id: "p-with-body",
    skeleton: {
      ...headlineOnlyPattern.skeleton,
      replaceableSlots: [...headlineOnlyPattern.skeleton.replaceableSlots, { id: "slot2", role: "body", binding: "content.body", shapeId: "Body", bounds: { x: 0, y: 0, w: 1, h: 1 }, required: false }],
    },
  };
  const evidenceSlide: SlideSpec = {
    id: "S01", role: "body", storyBeat: "evidence", headline: "Three findings", headlineAlignment: "left",
    claims: [{ text: "Three findings" }], composition: "evidence_list", sourceRefs: [{ sourceId: "s", excerptId: "e" }],
    layout: "evidence", content: { bullets: ["First", "Second", "Third"] },
  } as unknown as SlideSpec;

  it("rejects a candidate that would drop the slide's real content — this is what the Pattern Resolver's rank fallback selects away from", () => {
    expect(patternFitsSlide(headlineOnlyPattern, evidenceSlide)).toBe(false);
  });

  it("accepts a candidate whose slot resolves the slide's real content and fits", () => {
    expect(patternFitsSlide(withBodySlot, evidenceSlide)).toBe(true);
  });

  const quantitativeSlide: SlideSpec = {
    id: "S01", role: "body", storyBeat: "evidence", headline: "42% adoption", headlineAlignment: "left",
    claims: [{ text: "42% adoption" }], composition: "ranked_bars", sourceRefs: [{ sourceId: "s", excerptId: "e" }],
    layout: "quantitative", content: { kind: "bar", metrics: [{ label: "Adoption", value: 42, unit: "%", period: "Q3" }] },
  } as unknown as SlideSpec;

  it("rejects a headline-only pattern for a quantitative slide — metrics is its real payload and was previously exempt from this check entirely", () => {
    expect(patternFitsSlide(headlineOnlyPattern, quantitativeSlide)).toBe(false);
  });

  it("accepts a pattern with a content.metrics[] slot for a quantitative slide", () => {
    const withMetricsSlot: TemplatePattern = {
      ...headlineOnlyPattern,
      skeleton: { ...headlineOnlyPattern.skeleton, replaceableSlots: [...headlineOnlyPattern.skeleton.replaceableSlots, { id: "slot2", role: "metric", binding: "content.metrics[]", shapeId: "Metric", bounds: { x: 0, y: 0, w: 1, h: 1 }, required: false }] },
    };
    expect(patternFitsSlide(withMetricsSlot, quantitativeSlide)).toBe(true);
  });

  it("does not let a `source` slot alone count as real content — every slide has sourceRefs regardless of layout, so this must not defeat the check", () => {
    const sourceOnlyPattern: TemplatePattern = {
      ...headlineOnlyPattern,
      skeleton: { ...headlineOnlyPattern.skeleton, replaceableSlots: [...headlineOnlyPattern.skeleton.replaceableSlots, { id: "slot2", role: "source", binding: "source", shapeId: "Source", bounds: { x: 0, y: 0, w: 1, h: 1 }, required: false }] },
    };
    expect(patternFitsSlide(sourceOnlyPattern, evidenceSlide)).toBe(false);
    expect(patternFitsSlide(sourceOnlyPattern, quantitativeSlide)).toBe(false);
  });

  const comparisonSlide: SlideSpec = {
    id: "S01", role: "body", storyBeat: "design", headline: "Old vs new", headlineAlignment: "left",
    claims: [{ text: "Old vs new" }], composition: "two_column", sourceRefs: [{ sourceId: "s", excerptId: "e" }],
    layout: "comparison", content: { left: { label: "Before", items: ["Manual", "Slow"] }, right: { label: "After", items: ["Automated", "Fast"] } },
  } as unknown as SlideSpec;

  it("rejects a pattern that only resolves one side of a comparison — full coverage means BOTH sides, not just some slot resolving", () => {
    const leftOnlyPattern: TemplatePattern = {
      ...headlineOnlyPattern,
      skeleton: { ...headlineOnlyPattern.skeleton, replaceableSlots: [...headlineOnlyPattern.skeleton.replaceableSlots, { id: "slot2", role: "label", binding: "content.left.items[]", shapeId: "Left", bounds: { x: 0, y: 0, w: 1, h: 1 }, required: false }] },
    };
    // Before the full-coverage fix, this passed: "some non-headline slot resolved" was satisfied
    // by the left side alone, silently dropping the right side entirely.
    expect(patternFitsSlide(leftOnlyPattern, comparisonSlide)).toBe(false);
  });

  it("accepts a pattern that resolves both sides of a comparison independently", () => {
    const bothSidesPattern: TemplatePattern = {
      ...headlineOnlyPattern,
      skeleton: {
        ...headlineOnlyPattern.skeleton,
        replaceableSlots: [
          ...headlineOnlyPattern.skeleton.replaceableSlots,
          { id: "slot2", role: "label", binding: "content.left.items[]", shapeId: "Left", bounds: { x: 0, y: 0, w: 1, h: 1 }, required: false },
          { id: "slot3", role: "label", binding: "content.right.items[]", shapeId: "Right", bounds: { x: 0, y: 0, w: 1, h: 1 }, required: false },
        ],
      },
    };
    expect(patternFitsSlide(bothSidesPattern, comparisonSlide)).toBe(true);
  });

  it("accepts a pattern that resolves comparison content via a single content.body slot — it already flattens both sides", () => {
    expect(patternFitsSlide(withBodySlot, comparisonSlide)).toBe(true);
  });

  it("rejects both-sides-granular coverage when the slide also has a delta — only content.body's flattening carries it", () => {
    const bothSidesPattern: TemplatePattern = {
      ...headlineOnlyPattern,
      skeleton: {
        ...headlineOnlyPattern.skeleton,
        replaceableSlots: [
          ...headlineOnlyPattern.skeleton.replaceableSlots,
          { id: "slot2", role: "label", binding: "content.left.items[]", shapeId: "Left", bounds: { x: 0, y: 0, w: 1, h: 1 }, required: false },
          { id: "slot3", role: "label", binding: "content.right.items[]", shapeId: "Right", bounds: { x: 0, y: 0, w: 1, h: 1 }, required: false },
        ],
      },
    };
    const withDelta: SlideSpec = { ...comparisonSlide, content: { ...comparisonSlide.content, delta: "3x faster" } } as unknown as SlideSpec;
    expect(patternFitsSlide(bothSidesPattern, withDelta)).toBe(false);
    expect(patternFitsSlide(withBodySlot, withDelta)).toBe(true);
  });

  it("title: a populated subtitle requires a resolved subhead slot, not just the headline", () => {
    const coverWithSubtitle: SlideSpec = {
      id: "S01", role: "opener", storyBeat: "opening", headline: "Launch", headlineAlignment: "left",
      claims: [{ text: "Launch" }], composition: "cover", sourceRefs: [{ sourceId: "s", excerptId: "e" }],
      layout: "title", content: { subtitle: "Q3 2026" },
    } as unknown as SlideSpec;
    expect(patternFitsSlide(headlineOnlyPattern, coverWithSubtitle)).toBe(false);
    const withSubhead: TemplatePattern = {
      ...headlineOnlyPattern,
      skeleton: { ...headlineOnlyPattern.skeleton, replaceableSlots: [...headlineOnlyPattern.skeleton.replaceableSlots, { id: "slot2", role: "subtitle", binding: "subhead", shapeId: "Subtitle", bounds: { x: 0, y: 0, w: 1, h: 1 }, required: false }] },
    };
    expect(patternFitsSlide(withSubhead, coverWithSubtitle)).toBe(true);
    // No subtitle at all: headline alone is still full coverage.
    const coverNoSubtitle: SlideSpec = { ...coverWithSubtitle, content: {} } as unknown as SlideSpec;
    expect(patternFitsSlide(headlineOnlyPattern, coverNoSubtitle)).toBe(true);
  });

  it("statement: populated proofs[] requires its own resolved slot, not folded into content.body", () => {
    const statementWithProofs: SlideSpec = {
      id: "S01", role: "body", storyBeat: "problem", headline: "It works", headlineAlignment: "left",
      claims: [{ text: "It works" }], composition: "hero_evidence", sourceRefs: [{ sourceId: "s", excerptId: "e" }],
      layout: "statement", content: { body: "The claim.", proofs: ["Proof A", "Proof B"] },
    } as unknown as SlideSpec;
    expect(patternFitsSlide(withBodySlot, statementWithProofs)).toBe(false);
    const withProofsSlot: TemplatePattern = {
      ...withBodySlot,
      skeleton: { ...withBodySlot.skeleton, replaceableSlots: [...withBodySlot.skeleton.replaceableSlots, { id: "slot3", role: "annotation", binding: "content.proofs[]", shapeId: "Proofs", bounds: { x: 0, y: 0, w: 1, h: 1 }, required: false }] },
    };
    expect(patternFitsSlide(withProofsSlot, statementWithProofs)).toBe(true);
  });

  it("evidence: a populated assetPath has no slot mechanism to carry it — no pattern can have full coverage, the same honest rejection as architecture/pipeline/chart", () => {
    const evidenceWithImage: SlideSpec = {
      id: "S01", role: "body", storyBeat: "evidence", headline: "The chart shows it", headlineAlignment: "left",
      claims: [{ text: "The chart shows it" }], composition: "evidence_panel", sourceRefs: [{ sourceId: "s", excerptId: "e" }],
      layout: "evidence", content: { assetPath: "chart.png", bullets: ["Point one"] },
    } as unknown as SlideSpec;
    expect(patternFitsSlide(withBodySlot, evidenceWithImage)).toBe(false);
  });
});
