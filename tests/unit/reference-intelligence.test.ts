import { describe, expect, it } from "vitest";
import { applyReferenceSlideRoleLabels, compileReferenceSlideProfiles } from "../../src/reference-intelligence";
import type { TemplateElementsArtifact } from "../../src/template-analysis";

const elements: TemplateElementsArtifact = {
  version: 1,
  source: { sha256: "template-sha", slideSize: { w: 13.333333, h: 7.5 } },
  analysisInputs: { templateDigest: "template-sha", analyzerVersion: "7" },
  slides: [{
    id: "slide-1",
    sourceSlidePart: "ppt/slides/slide1.xml",
    nativeLayout: { index: 1, name: "Title and Content", masterIndex: 1 },
    elements: [
      { id: "title", name: "Title 1", slideId: "slide-1", type: "text", role: "title", confidence: 0.95, bounds: { x: 0.7, y: 0.45, w: 8.7, h: 0.5 }, zIndex: 1, ownership: "slide-body-owned", features: {} },
      { id: "table", name: "Table 1", slideId: "slide-1", type: "table", role: "body", confidence: 0.5, bounds: { x: 0.7, y: 1.45, w: 11.9, h: 4.8 }, zIndex: 2, ownership: "slide-body-owned", features: {} },
      { id: "footer", name: "Footer 1", slideId: "slide-1", type: "text", role: "footer", confidence: 0.95, bounds: { x: 0.7, y: 7.05, w: 11.9, h: 0.2 }, zIndex: 3, ownership: "slide-body-owned", features: {} },
    ],
  }],
  layouts: [],
  masters: [],
  styles: {},
  strategy: "native_layout",
};

describe("reference slide intelligence", () => {
  it("extracts measured geometry without inventing a business role", () => {
    const artifact = compileReferenceSlideProfiles(elements);
    expect(artifact.sourceDigest).toBe("template-sha");
    expect(artifact.slides).toHaveLength(1);
    expect(artifact.slides[0]).toMatchObject({
      slideId: "slide-1",
      businessRole: "unclassified",
      informationBlocks: 2,
      nativeObjects: { text: 2, tables: 1, charts: 0 },
      geometry: {
        titleRegion: { x: 0.7, y: 0.45, w: 8.7, h: 0.5 },
        bodyStart: 1.45,
        footerRegion: { x: 0.7, y: 7.05, w: 11.9, h: 0.2 },
      },
    });
    expect(artifact.slides[0].dominantElement?.id).toBe("table");
  });

  it("applies an explicit host-authored business role label", () => {
    const artifact = compileReferenceSlideProfiles(elements);
    const labeled = applyReferenceSlideRoleLabels(artifact, [{ slideId: "slide-1", businessRole: "financial_table" }]);
    expect(labeled.slides[0].businessRole).toBe("financial_table");
  });

  it("rejects labels for slides that were not measured", () => {
    const artifact = compileReferenceSlideProfiles(elements);
    expect(() => applyReferenceSlideRoleLabels(artifact, [{ slideId: "slide-99", businessRole: "strategy" }])).toThrow(/unknown slide/);
  });
});
