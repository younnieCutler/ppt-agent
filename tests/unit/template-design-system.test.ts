import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPatternFixture } from "../fixtures/pattern-template";
import { compileTemplateGrammar, extractTemplateElements, elementsDigest, type SemanticRole, type TemplateElement, type TemplateElementsArtifact, type TemplateGrammar } from "../../src/template-analysis";
import { compileTemplateDesignSystem } from "../../src/template-design-system";

function syntheticElement(id: string, slideId: string, role: SemanticRole | "unknown", bounds: TemplateElement["bounds"], type: TemplateElement["type"] = "text"): TemplateElement {
  return {
    id,
    name: id,
    slideId,
    type,
    role,
    confidence: role === "unknown" ? 0 : 1,
    bounds,
    zIndex: 0,
    ownership: "slide-body-owned",
    features: {},
  };
}

function syntheticArtifact(slides: TemplateElementsArtifact["slides"]): TemplateElementsArtifact {
  const digest = "a".repeat(64);
  return {
    version: 1,
    source: { sha256: digest, slideSize: { w: 13.333, h: 7.5 } },
    analysisInputs: { templateDigest: digest, roleOverridesDigest: "b".repeat(64), analyzerVersion: "4" },
    slides,
    layouts: [],
    masters: [],
    styles: {},
    strategy: "source_slide_pattern",
  };
}

function syntheticGrammar(elements: TemplateElementsArtifact): TemplateGrammar {
  return {
    version: 1,
    compilerVersion: "1",
    sourceDigest: elements.source.sha256,
    elementsDigest: elementsDigest(elements),
    slideSize: elements.source.slideSize,
    typography: { families: [], titleBodyRatio: 1, weightContrast: 0, lineHeightRatio: 1 },
    geometry: {
      contentFrame: { x: 0, y: 0, w: elements.source.slideSize.w, h: elements.source.slideSize.h },
      outerMargins: { x: 0, y: 0, w: 0, h: 0 },
      gutter: 0,
      spacingScale: 1,
    },
    surface: { usage: "none", borderUsage: 0, dividerUsage: 0 },
    branding: { primaryColors: [], accentColors: [] },
    compositionPatterns: [],
  };
}

describe("template design system compiler", () => {
  it("preserves observed typography, color, geometry, spacing, divider, surface, and anchor vocabulary", async () => {
    const templatePath = await buildPatternFixture();
    try {
      const elements = await extractTemplateElements(templatePath);
      const result = compileTemplateDesignSystem(elements, compileTemplateGrammar(elements));

      expect(result.version).toBe(1);
      expect(result.sourceDigest).toBe(elements.source.sha256);
      expect(result.elementsDigest).toBe(elementsDigest(elements));
      expect(result.compilerVersion).toMatch(/^\d+$/);
      expect(result.canvas).toEqual(elements.source.slideSize);
      expect(result.typography.roles.title?.families).toContain("Georgia");
      expect(result.typography.roles.title?.sizesPt).toMatchObject({ values: [28, 30, 44], min: 28, max: 44 });
      expect(result.typography.roles.caption?.sizesPt?.values).toContain(11);
      expect(result.colors.text).toEqual(expect.arrayContaining(["FFFFFF", "CCCCCC", "1A1A1A"]));
      expect(result.colors.fill).toEqual(expect.arrayContaining(["111111", "E4572E"]));
      expect(result.colors.stroke).toContain("1A1A1A");
      expect(result.colors.background).toEqual(expect.arrayContaining(["111111", "F5F1E8", "FFFFFF"]));
      expect(result.geometry.contentFrame).toBeDefined();
      expect(result.geometry.outerMargins).toBeDefined();
      expect(result.spacing.rhythm.length).toBeGreaterThan(0);
      expect(result.dividers.orientations).toContain("horizontal");
      expect(result.dividers.strokeWidthsPt).toContain(1);
      expect(result.surfaces.fills).toContain("111111");
      expect(result.alignmentAnchors.x).toContain(0.85);
      expect(result.alignmentAnchors.y).toContain(0.6);
      expect(JSON.stringify(result)).not.toContain("FIXTURE_EXAMPLE_BODY_PARAGRAPH");
      expect(JSON.stringify(result)).toBe(JSON.stringify(compileTemplateDesignSystem(elements, compileTemplateGrammar(elements))));
    } finally {
      fs.rmSync(templatePath, { force: true });
      fs.rmSync(`${templatePath}.rels`, { force: true });
      fs.rmSync(templatePath.replace(/template\.pptx$/, ""), { recursive: true, force: true });
    }
  });

  it("does not manufacture spacing between elements that never coexist in one physical part", () => {
    const elements = syntheticArtifact([
      {
        id: "S01",
        sourceSlidePart: "ppt/slides/slide1.xml",
        nativeLayout: { index: 1, name: "Blank", masterIndex: 1 },
        elements: [syntheticElement("s1-body", "S01", "body", { x: 0.5, y: 1, w: 1, h: 1 })],
      },
      {
        id: "S02",
        sourceSlidePart: "ppt/slides/slide2.xml",
        nativeLayout: { index: 1, name: "Blank", masterIndex: 1 },
        elements: [syntheticElement("s2-body", "S02", "body", { x: 3.5, y: 1, w: 1, h: 1 })],
      },
    ]);

    const result = compileTemplateDesignSystem(elements, syntheticGrammar(elements));
    expect(result.spacing.rhythm).toEqual([]);
    expect(result.geometry.gutters).toEqual([]);
    expect(result.spacing.rhythm).not.toContain(2);
  });

  it("derives the adaptive content frame from content-bearing elements, not full-bleed structural chrome", () => {
    const elements = syntheticArtifact([
      {
        id: "S01",
        sourceSlidePart: "ppt/slides/slide1.xml",
        nativeLayout: { index: 1, name: "Blank", masterIndex: 1 },
        elements: [
          syntheticElement("background", "S01", "surface", { x: 0, y: 0, w: 13.333, h: 7.5 }, "shape"),
          syntheticElement("divider", "S01", "divider", { x: 0, y: 4.5, w: 13.333, h: 0.02 }, "line"),
          syntheticElement("title", "S01", "title", { x: 1, y: 1, w: 5, h: 0.5 }),
          syntheticElement("body", "S01", "body", { x: 1, y: 2, w: 8, h: 2 }),
        ],
      },
    ]);

    const result = compileTemplateDesignSystem(elements, syntheticGrammar(elements));
    expect(result.geometry.contentFrame).toEqual({ x: 1, y: 1, w: 8, h: 3 });
    expect(result.geometry.outerMargins).toEqual({ x: 1, y: 1, w: 4.333, h: 3.5 });
    expect(result.surfaces).toBeDefined();
    expect(result.dividers.orientations).toContain("horizontal");
  });

  it("leaves unavailable observations undefined instead of manufacturing defaults", () => {
    const elements = {
      version: 1 as const,
      source: { sha256: "a".repeat(64), slideSize: { w: 13.333, h: 7.5 } },
      analysisInputs: { templateDigest: "a".repeat(64), roleOverridesDigest: "b".repeat(64), analyzerVersion: "4" },
      slides: [{ id: "S01", sourceSlidePart: "ppt/slides/slide1.xml", nativeLayout: { index: 1, name: "Blank", masterIndex: 1 }, elements: [] }],
      layouts: [],
      masters: [],
      styles: {},
      strategy: "native_layout" as const,
    };

    const result = compileTemplateDesignSystem(elements);
    expect(result.typography.roles).toEqual({});
    expect(result.geometry.contentFrame).toBeUndefined();
    expect(result.geometry.outerMargins).toBeUndefined();
    expect(result.spacing.rhythm).toEqual([]);
    expect(result.colors).toEqual({ text: [], fill: [], stroke: [], background: [] });
  });
});
