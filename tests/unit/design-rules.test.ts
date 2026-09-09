import { describe, expect, it } from "vitest";
import { compileDesignRules, DESIGN_RULE_COMPILER_VERSION } from "../../src/design-rules";
import type { TemplateDesignSystemArtifact } from "../../src/template-design-system";

const designSystem: TemplateDesignSystemArtifact = {
  version: 1,
  compilerVersion: "2",
  sourceDigest: "template-sha",
  elementsDigest: "elements-sha",
  canvas: { w: 13.333333, h: 7.5 },
  typography: {
    roles: {
      title: { families: ["Arial"], sizesPt: { values: [28], min: 28, max: 28 }, weights: [700], alignments: ["left"] },
      body: { families: ["Arial"], sizesPt: { values: [16], min: 16, max: 16 }, weights: [400], alignments: ["left"] },
    },
    typeScale: { values: [16, 28], min: 16, max: 28 },
  },
  colors: {
    text: ["111111"],
    fill: ["FFFFFF", "0A3A66"],
    stroke: ["D9D9D9"],
    background: ["FFFFFF"],
  },
  geometry: {
    contentFrame: { x: 0.72, y: 0.48, w: 11.85, h: 6.14 },
    outerMargins: { x: 0.72, y: 0.48, w: 0.76, h: 0.88 },
    gutters: [0.18, 0.24, 0.36],
  },
  spacing: { rhythm: [0.18, 0.24, 0.36] },
  dividers: { orientations: ["horizontal"], thicknesses: [0.01], lengths: [11.85], strokeWidthsPt: [0.5], colors: ["D9D9D9"] },
  surfaces: { fills: ["FFFFFF"], borders: ["D9D9D9"], borderWidthsPt: [0.5] },
  alignmentAnchors: { x: [0.72, 6.665, 12.57], y: [0.48, 1.42, 7.06] },
};

describe("Design Rule Compiler", () => {
  it("turns observed template measurements into a versioned rule artifact", () => {
    const rules = compileDesignRules(designSystem);
    expect(rules).toMatchObject({
      version: 1,
      compilerVersion: DESIGN_RULE_COMPILER_VERSION,
      sourceDigest: "template-sha",
      canvas: designSystem.canvas,
      tolerances: { geometryInches: 0.02, typographyPt: 0.5, ratio: 0.02 },
      geometry: { contentFrame: designSystem.geometry.contentFrame, gutters: [0.18, 0.24, 0.36] },
      alignmentAnchors: designSystem.alignmentAnchors,
    });
    expect(rules.colors.allowed).toEqual(["0A3A66", "111111", "D9D9D9", "FFFFFF"]);
    expect(rules.designSystemDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts explicit tolerance policy without changing observed vocabularies", () => {
    const rules = compileDesignRules(designSystem, { geometryToleranceInches: 0.01, typographyTolerancePt: 0.25, ratioTolerance: 0.01 });
    expect(rules.tolerances).toEqual({ geometryInches: 0.01, typographyPt: 0.25, ratio: 0.01 });
    expect(rules.spacing.rhythm).toEqual(designSystem.spacing.rhythm);
    expect(rules.typography.roles.title).toEqual(designSystem.typography.roles.title);
  });
});
