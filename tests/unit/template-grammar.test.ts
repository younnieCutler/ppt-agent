import { describe, expect, it } from "vitest";
import { compileTemplateGrammar } from "../../src/template-analysis";

const elements = {
  version: 1,
  source: { sha256: "a".repeat(64), slideSize: { w: 13.333, h: 7.5 } },
  styles: {
    title: { family: "Noto Sans JP", sizePt: 32, weight: 700 },
    body: { family: "Noto Sans JP", sizePt: 16, weight: 400 },
  },
  slides: [{ id: "S01", elements: [
    { id: "S01-Title-1", slideId: "S01", type: "text", role: "title", confidence: 0.95, bounds: { x: 0.85, y: 0.7, w: 6, h: 0.5 }, zIndex: 0, styleRef: "title", features: { charCount: 10 } },
    { id: "S01-body-1", slideId: "S01", type: "text", role: "body", confidence: 0.7, bounds: { x: 0.85, y: 1.5, w: 8, h: 1 }, zIndex: 1, styleRef: "body", features: { charCount: 10 } },
    { id: "S01-line-1", slideId: "S01", type: "line", role: "divider", confidence: 0.8, bounds: { x: 0.85, y: 3, w: 8, h: 0 }, zIndex: 2, features: {} },
  ] }],
} as const;

describe("template grammar compiler", () => {
  it("derives copy-free reusable grammar from element/style IR", () => {
    const grammar = compileTemplateGrammar(elements);
    expect(grammar.sourceDigest).toBe(elements.source.sha256);
    expect(grammar.typography.titleBodyRatio).toBeGreaterThan(1);
    expect(grammar.geometry.contentFrame.x).toBeCloseTo(0.85, 1);
    expect(grammar.compositionPatterns.length).toBeGreaterThan(0);
    expect(JSON.stringify(grammar)).not.toContain("Confidential example sentence");
  });
});

describe("template grammar geometry", () => {
  it("keeps the content frame inside the slide when the template parks shapes off canvas", () => {
    // Observed on a real organization template: a group whose extents reach past the canvas made
    // contentFrame 16.67in wide on a 13.33in slide, and outerMargins went negative.
    const offCanvas = {
      ...elements,
      slides: [{ id: "S01", elements: [
        ...elements.slides[0].elements,
        { id: "S01-parked-1", slideId: "S01", type: "shape", role: "body", confidence: 0.5, bounds: { x: -2, y: -1, w: 18.5, h: 9 }, zIndex: 3, features: {} },
      ] }],
    } as unknown as typeof elements;
    const { contentFrame, outerMargins } = compileTemplateGrammar(offCanvas).geometry;
    expect(contentFrame.x).toBeGreaterThanOrEqual(0);
    expect(contentFrame.y).toBeGreaterThanOrEqual(0);
    expect(contentFrame.x + contentFrame.w).toBeLessThanOrEqual(elements.source.slideSize.w);
    expect(contentFrame.y + contentFrame.h).toBeLessThanOrEqual(elements.source.slideSize.h);
    expect(outerMargins.w).toBeGreaterThanOrEqual(0);
    expect(outerMargins.h).toBeGreaterThanOrEqual(0);
  });
});
