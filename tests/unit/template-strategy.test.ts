import { describe, expect, it } from "vitest";
import { detectTemplateStrategy, extractTemplateElements, type TemplateElementsArtifact } from "../../src/template-analysis";
import { buildPatternFixture, FIXTURE_STRINGS } from "../fixtures/pattern-template";

describe("template inspection: layout/master ownership + strategy detection", () => {
  it("records nativeLayout (index/name/masterIndex) and sourceSlidePart per slide", async () => {
    const artifact = await extractTemplateElements(await buildPatternFixture());
    expect(artifact.slides).toHaveLength(3);
    for (const slide of artifact.slides) {
      expect(slide.sourceSlidePart).toMatch(/^ppt\/slides\/slide\d+\.xml$/);
      expect(slide.nativeLayout.index).toBeGreaterThan(0);
      expect(typeof slide.nativeLayout.name).toBe("string");
      expect(slide.nativeLayout.masterIndex).toBeGreaterThan(0);
    }
  });

  it("classifies every element's ownership as the OOXML part it was actually walked out of", async () => {
    const artifact = await extractTemplateElements(await buildPatternFixture());
    for (const slide of artifact.slides) {
      expect(new Set(slide.elements.map((element) => element.ownership))).toEqual(new Set(["slide-body-owned"]));
    }
    for (const layout of artifact.layouts) {
      expect(layout.elements.every((element) => element.ownership === "layout-owned")).toBe(true);
    }
    for (const master of artifact.masters) {
      expect(master.elements.every((element) => element.ownership === "master-owned")).toBe(true);
    }
  });

  it("detects source_slide_pattern on a template whose 3 slides share one near-empty layout with rich, distinct bodies", async () => {
    const artifact = await extractTemplateElements(await buildPatternFixture());
    // All 3 slides share pptxgenjs's one default layout — this is the Blank-layout-is-legal case.
    const layoutIndexes = new Set(artifact.slides.map((slide) => slide.nativeLayout.index));
    expect(layoutIndexes.size).toBe(1);
    expect(artifact.strategy).toBe("source_slide_pattern");
    expect(detectTemplateStrategy(artifact)).toBe("source_slide_pattern");
  });

  it("does not persist any example sentence text in the artifact", async () => {
    const artifact = await extractTemplateElements(await buildPatternFixture());
    const serialized = JSON.stringify(artifact);
    for (const text of Object.values(FIXTURE_STRINGS)) expect(serialized).not.toContain(text);
  });

  it("a shared-layout template is not a failure by itself — detection never reads layout display name", () => {
    // Two synthetic artifacts, identical in every strategy-relevant way, differing only in the
    // layout's display name (one literally named "Blank", one given an unrelated theme-specific
    // name) — detectTemplateStrategy must return the same strategy for both, because layout names
    // are locale/theme-dependent and never inspected by the heuristic.
    // Three genuinely different bodies (cover / editorial / key-message shaped role sets), the same
    // condition that makes the real fixture above detect as source_slide_pattern — this is what
    // separates a real template from a degenerate one that merely repeats one body shape.
    const roleSetsById: Record<string, Array<["text" | "shape", "title" | "body" | "divider" | "key_message" | "subtitle" | "caption"]>> = {
      S01: [["text", "title"], ["text", "subtitle"], ["shape", "divider"]],
      S02: [["text", "title"], ["text", "body"], ["text", "caption"], ["shape", "divider"]],
      S03: [["shape", "divider"], ["text", "key_message"]],
    };
    const baseSlide = (id: string, layoutIndex: number) => ({
      id,
      sourceSlidePart: `ppt/slides/${id}.xml`,
      nativeLayout: { index: layoutIndex, name: "irrelevant", masterIndex: 1 },
      elements: roleSetsById[id].map(([type, role], i) => ({ id: `${id}-${i}`, slideId: id, type, role, confidence: 0.9, bounds: { x: 0, y: i, w: 1, h: 1 }, zIndex: i, ownership: "slide-body-owned" as const, features: {} })),
    });
    const artifactWithName = (name: string): Pick<TemplateElementsArtifact, "slides" | "layouts"> => ({
      slides: [baseSlide("S01", 1), baseSlide("S02", 1), baseSlide("S03", 1)],
      layouts: [{ index: 1, name, masterIndex: 1, elements: [] }],
    });
    expect(detectTemplateStrategy(artifactWithName("Blank"))).toBe(detectTemplateStrategy(artifactWithName("Custom Layout Name Not Blank")));
    expect(detectTemplateStrategy(artifactWithName("Blank"))).toBe("source_slide_pattern");
  });

  it("detects native_layout when the bound layout itself carries the real content, not the slide body", () => {
    const richLayoutSlide = (id: string) => ({
      id,
      sourceSlidePart: `ppt/slides/${id}.xml`,
      nativeLayout: { index: 1, name: "Title and Content", masterIndex: 1 },
      elements: [], // nothing overridden at the slide-body level — everything comes from the layout
    });
    const artifact: Pick<TemplateElementsArtifact, "slides" | "layouts"> = {
      slides: [richLayoutSlide("S01"), richLayoutSlide("S02"), richLayoutSlide("S03")],
      layouts: [{
        index: 1,
        name: "Title and Content",
        masterIndex: 1,
        elements: Array.from({ length: 5 }, (_, i) => ({ id: `layout-${i}`, slideId: "layout-1", type: "text" as const, role: "title" as const, confidence: 0.9, bounds: { x: 0, y: 0, w: 1, h: 1 }, zIndex: i, ownership: "layout-owned" as const, features: {} })),
      }],
    };
    expect(detectTemplateStrategy(artifact)).toBe("native_layout");
  });
});
