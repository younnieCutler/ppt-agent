import { describe, expect, it } from "vitest";
import { compileTemplateSemantics } from "../../src/template-semantics";
import type { TemplateElement, TemplateElementsArtifact } from "../../src/template-analysis";

const digest = "b".repeat(64);
const canvas = { w: 13.333, h: 7.5 };

function element(input: Partial<TemplateElement> & Pick<TemplateElement, "id" | "name" | "slideId" | "type" | "role" | "bounds" | "ownership">): TemplateElement {
  return { confidence: 0.95, zIndex: 0, features: {}, ...input };
}

function base(slides: TemplateElementsArtifact["slides"], layouts: TemplateElementsArtifact["layouts"]): TemplateElementsArtifact {
  return {
    version: 1,
    source: { sha256: digest, slideSize: canvas },
    analysisInputs: { templateDigest: digest, analyzerVersion: "6" },
    slides,
    layouts,
    masters: [],
    styles: {},
    strategy: "hybrid",
  };
}

describe("template semantics", () => {
  it("treats GAO-like example slide bodies without placeholders as reference-only design examples", () => {
    const slide = {
      id: "S01",
      sourceSlidePart: "ppt/slides/slide1.xml",
      nativeLayout: { index: 7, name: "Blank", masterIndex: 1 },
      elements: [
        element({ id: "title", name: "Title", slideId: "S01", type: "text", role: "title", bounds: { x: 0.8, y: 0.8, w: 7, h: 0.6 }, ownership: "slide-body-owned" }),
        element({ id: "card-a", name: "Card A", slideId: "S01", type: "shape", role: "surface", bounds: { x: 0.8, y: 2, w: 3.5, h: 2.5 }, ownership: "slide-body-owned" }),
        element({ id: "body", name: "Body", slideId: "S01", type: "text", role: "body", bounds: { x: 1, y: 2.3, w: 3.1, h: 1.2 }, ownership: "slide-body-owned" }),
      ],
    };
    const artifact = base([slide], [{ index: 7, name: "Blank", masterIndex: 1, elements: [] }]);
    const profile = compileTemplateSemantics(artifact);

    expect(profile.slides[0]).toMatchObject({ usage: "reference_only", placeholderCount: 0 });
    expect(profile.slides[0].evidence).toContain("example_body_geometry");
    expect(profile.policies.sourceSlideGeometry).toBe("reference_only_by_default");
  });

  it("keeps A-Force-like placeholder-driven native slides eligible as structural templates", () => {
    const title = element({
      id: "title",
      name: "Title 1",
      slideId: "S01",
      type: "text",
      role: "title",
      bounds: { x: 0.8, y: 0.8, w: 8, h: 0.6 },
      ownership: "slide-body-owned",
      features: { placeholderType: "title" },
    });
    const subtitle = element({
      id: "subtitle",
      name: "Subtitle 2",
      slideId: "S01",
      type: "text",
      role: "subtitle",
      bounds: { x: 0.8, y: 1.6, w: 8, h: 0.5 },
      ownership: "slide-body-owned",
      features: { placeholderType: "subTitle" },
    });
    const artifact = base([
      {
        id: "S01",
        sourceSlidePart: "ppt/slides/slide1.xml",
        nativeLayout: { index: 2, name: "Title Slide", masterIndex: 1 },
        elements: [title, subtitle],
      },
    ], [{
      index: 2,
      name: "Title Slide",
      masterIndex: 1,
      elements: [element({
        id: "layout-title",
        name: "Title 1",
        slideId: "layout-2",
        type: "text",
        role: "title",
        bounds: { x: 0.8, y: 0.8, w: 8, h: 0.6 },
        ownership: "layout-owned",
        features: { placeholderType: "title" },
      })],
    }]);
    const profile = compileTemplateSemantics(artifact);

    expect(profile.slides[0]).toMatchObject({ usage: "structural_template", placeholderCount: 2, contentElementCount: 2 });
    expect(profile.slides[0].evidence).toEqual(expect.arrayContaining(["slide_body_placeholder", "layout_placeholder", "placeholder_dominant_body"]));
  });

  it("does not promote a busy example slide merely because one placeholder survived", () => {
    const elements = [
      element({ id: "title", name: "Title", slideId: "S01", type: "text", role: "title", bounds: { x: 1, y: 0.8, w: 7, h: 0.5 }, ownership: "slide-body-owned", features: { placeholderType: "title" } }),
      element({ id: "body-a", name: "Body A", slideId: "S01", type: "text", role: "body", bounds: { x: 1, y: 2, w: 3, h: 1 }, ownership: "slide-body-owned" }),
      element({ id: "body-b", name: "Body B", slideId: "S01", type: "text", role: "body", bounds: { x: 5, y: 2, w: 3, h: 1 }, ownership: "slide-body-owned" }),
      element({ id: "body-c", name: "Body C", slideId: "S01", type: "text", role: "body", bounds: { x: 9, y: 2, w: 3, h: 1 }, ownership: "slide-body-owned" }),
    ];
    const artifact = base([{ id: "S01", sourceSlidePart: "ppt/slides/slide1.xml", nativeLayout: { index: 1, name: "Body", masterIndex: 1 }, elements }], [{ index: 1, name: "Body", masterIndex: 1, elements: [] }]);
    expect(compileTemplateSemantics(artifact).slides[0].usage).toBe("reference_only");
  });
});
