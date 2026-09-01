import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPatternFixture } from "../fixtures/pattern-template";
import { compileTemplateGrammar, extractTemplateElements, elementsDigest } from "../../src/template-analysis";
import { compileTemplateDesignSystem } from "../../src/template-design-system";

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
