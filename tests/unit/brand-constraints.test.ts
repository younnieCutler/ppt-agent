import { describe, expect, it } from "vitest";
import { compileTemplateConstraintProfile } from "../../src/brand-constraints";
import { elementsDigest, type TemplateElement, type TemplateElementsArtifact } from "../../src/template-analysis";
import type { TemplateDesignSystemArtifact } from "../../src/template-design-system";

const digest = "a".repeat(64);
const canvas = { w: 13.333, h: 7.5 };

function element(input: Partial<TemplateElement> & Pick<TemplateElement, "id" | "name" | "slideId" | "type" | "role" | "bounds" | "ownership">): TemplateElement {
  return {
    confidence: 0.95,
    zIndex: 0,
    features: {},
    ...input,
  };
}

function artifact(): TemplateElementsArtifact {
  const slides = Array.from({ length: 5 }, (_, index) => {
    const slideId = `S${String(index + 1).padStart(2, "0")}`;
    const repeatedTopBar = element({
      id: `top-${index}`,
      name: "Corporate Top Bar",
      slideId,
      type: "shape",
      role: "surface",
      bounds: { x: 0, y: 0, w: canvas.w, h: 0.28 },
      ownership: "slide-body-owned",
      styleRef: "chrome",
    });
    const oneOffPanel = element({
      id: `panel-${index}`,
      name: "Content Panel",
      slideId,
      type: "shape",
      role: "surface",
      bounds: { x: 1.2 + index * 0.05, y: 2, w: 4, h: 2.2 },
      ownership: "slide-body-owned",
      styleRef: "panel",
    });
    return {
      id: slideId,
      sourceSlidePart: `ppt/slides/slide${index + 1}.xml`,
      nativeLayout: { index: 1, name: "Body", masterIndex: 1 },
      elements: [repeatedTopBar, oneOffPanel],
      background: "FAF9F5",
    };
  });

  return {
    version: 1,
    source: { sha256: digest, slideSize: canvas },
    analysisInputs: { templateDigest: digest, analyzerVersion: "6" },
    slides,
    layouts: [{
      index: 1,
      name: "Body",
      masterIndex: 1,
      background: "FAF9F5",
      elements: [element({
        id: "layout-footer",
        name: "Footer",
        slideId: "layout-1",
        type: "text",
        role: "footer",
        bounds: { x: 0.8, y: 7.08, w: 4.2, h: 0.2 },
        ownership: "layout-owned",
        styleRef: "footer",
      })],
    }],
    masters: [{
      index: 1,
      background: "FAF9F5",
      elements: [
        element({
          id: "master-bg",
          name: "Background",
          slideId: "master-1",
          type: "shape",
          role: "surface",
          bounds: { x: 0, y: 0, w: canvas.w, h: canvas.h },
          ownership: "master-owned",
          styleRef: "background",
        }),
        element({
          id: "master-logo",
          name: "GAO Logo",
          slideId: "master-1",
          type: "image",
          role: "logo",
          bounds: { x: 11.9, y: 0.2, w: 0.8, h: 0.32 },
          ownership: "master-owned",
          assetRef: "logo-image",
        }),
      ],
    }],
    styles: {
      chrome: { fill: "113A5C" },
      panel: { fill: "F2EFE6" },
      footer: { family: "Noto Sans JP", sizePt: 8, color: "425466" },
      background: { fill: "FAF9F5" },
    },
    strategy: "source_slide_pattern",
  };
}

function designSystem(source: TemplateElementsArtifact): TemplateDesignSystemArtifact {
  return {
    version: 1,
    compilerVersion: "2",
    sourceDigest: source.source.sha256,
    elementsDigest: elementsDigest(source),
    canvas,
    typography: {
      roles: {
        title: { families: ["Noto Sans JP"], sizesPt: { values: [30], min: 30, max: 30 } },
        body: { families: ["Noto Sans JP"], sizesPt: { values: [14], min: 14, max: 14 } },
      },
      typeScale: { values: [14, 30], min: 14, max: 30 },
    },
    colors: { text: ["14181C"], fill: ["FAF9F5", "113A5C"], stroke: ["113A5C"], background: ["FAF9F5"] },
    geometry: { contentFrame: { x: 0.8, y: 0.75, w: 11.733, h: 5.95 }, outerMargins: { x: 0.8, y: 0.75, w: 0.8, h: 0.8 }, gutters: [0.24] },
    spacing: { rhythm: [0.24] },
    dividers: { orientations: [], thicknesses: [], lengths: [], strokeWidthsPt: [], colors: [] },
    surfaces: { fills: ["FAF9F5", "113A5C"], borders: [], borderWidthsPt: [] },
    alignmentAnchors: { x: [0.8, 12.533], y: [0.75, 6.7] },
  };
}

describe("brand-constrained template profile", () => {
  it("locks inherited logo/footer and repeated corporate chrome while leaving one-off content panels generative", () => {
    const source = artifact();
    const profile = compileTemplateConstraintProfile(source, designSystem(source));

    expect(profile.policies).toEqual({ chrome: "immutable", colors: "template_only", fonts: "template_only" });
    expect(profile.styleVocabulary.fonts).toEqual(["Noto Sans JP"]);
    expect(profile.immutableRegions.some((region) => region.role === "logo" && region.reserveSpace)).toBe(true);
    expect(profile.immutableRegions.some((region) => region.role === "footer_chrome" && region.reserveSpace)).toBe(true);
    expect(profile.immutableRegions.some((region) => region.role === "header_chrome" && region.evidence.includes("cross_slide_repeat"))).toBe(true);
    expect(profile.immutableRegions.some((region) => region.sourceElementId.startsWith("panel-"))).toBe(false);
  });

  it("keeps a full-canvas template surface immutable without stealing the content canvas", () => {
    const source = artifact();
    const profile = compileTemplateConstraintProfile(source, designSystem(source));
    const background = profile.immutableRegions.find((region) => region.sourceElementId === "master-bg");

    expect(background?.reserveSpace).toBe(false);
    expect(profile.contentRegions).toEqual([{ id: "content-main", bounds: { x: 0.8, y: 0.75, w: 11.733, h: 5.95 } }]);
  });

  it("refuses stale Design System provenance", () => {
    const source = artifact();
    const stale = { ...designSystem(source), elementsDigest: "f".repeat(64) };
    expect(() => compileTemplateConstraintProfile(source, stale)).toThrow(/PROVENANCE_MISMATCH/);
  });
});
