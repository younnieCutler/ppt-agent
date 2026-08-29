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

type Bounds = { x: number; y: number; w: number; h: number };

function geometryFor(bounds: Bounds[]): ReturnType<typeof compileTemplateGrammar>["geometry"] {
  const artifact = {
    ...elements,
    slides: [{ id: "S01", elements: bounds.map((box, index) => ({ id: `S01-shape-${index}`, slideId: "S01", type: "shape", role: "body", confidence: 0.5, bounds: box, zIndex: index, features: {} })) }],
  } as unknown as typeof elements;
  return compileTemplateGrammar(artifact).geometry;
}

function expectInsideCanvas(geometry: ReturnType<typeof geometryFor>): void {
  const { w: slideW, h: slideH } = elements.source.slideSize;
  const { contentFrame, outerMargins } = geometry;
  expect(contentFrame.x).toBeGreaterThanOrEqual(0);
  expect(contentFrame.y).toBeGreaterThanOrEqual(0);
  expect(contentFrame.x).toBeLessThanOrEqual(slideW);
  expect(contentFrame.y).toBeLessThanOrEqual(slideH);
  expect(contentFrame.x + contentFrame.w).toBeLessThanOrEqual(slideW);
  expect(contentFrame.y + contentFrame.h).toBeLessThanOrEqual(slideH);
  expect(contentFrame.w).toBeGreaterThanOrEqual(0);
  expect(contentFrame.h).toBeGreaterThanOrEqual(0);
  expect(outerMargins.w).toBeGreaterThanOrEqual(0);
  expect(outerMargins.h).toBeGreaterThanOrEqual(0);
}

describe("template grammar geometry", () => {
  it("keeps the content frame inside the slide when the template parks shapes off canvas", () => {
    // Observed on a real organization template: a group whose extents reach past the canvas made
    // contentFrame 16.67in wide on a 13.33in slide, and outerMargins went negative.
    const geometry = geometryFor([{ x: 0.85, y: 0.7, w: 6, h: 0.5 }, { x: -2, y: -1, w: 18.5, h: 9 }]);
    expectInsideCanvas(geometry);
    expect(geometry.contentFrame).toMatchObject({ x: 0, y: 0, w: elements.source.slideSize.w, h: elements.source.slideSize.h });
  });

  it("collapses the frame instead of inverting it when everything sits off one edge", () => {
    const { w: slideW, h: slideH } = elements.source.slideSize;
    const right = geometryFor([{ x: slideW + 2, y: 1, w: 3, h: 1 }]);
    expectInsideCanvas(right);
    expect(right.contentFrame).toMatchObject({ x: slideW, w: 0 });

    const below = geometryFor([{ x: 1, y: slideH + 2, w: 3, h: 1 }]);
    expectInsideCanvas(below);
    expect(below.contentFrame).toMatchObject({ y: slideH, h: 0 });

    const leftOfSlide = geometryFor([{ x: -6, y: 1, w: 3, h: 1 }]);
    expectInsideCanvas(leftOfSlide);
    expect(leftOfSlide.contentFrame).toMatchObject({ x: 0, w: 0 });

    const aboveSlide = geometryFor([{ x: 1, y: -6, w: 3, h: 1 }]);
    expectInsideCanvas(aboveSlide);
    expect(aboveSlide.contentFrame).toMatchObject({ y: 0, h: 0 });
  });

  it("leaves an ordinary in-canvas template untouched", () => {
    const geometry = geometryFor([{ x: 0.85, y: 0.7, w: 6, h: 0.5 }, { x: 0.85, y: 1.5, w: 8, h: 1 }]);
    expectInsideCanvas(geometry);
    expect(geometry.contentFrame).toMatchObject({ x: 0.85, y: 0.7, w: 8, h: 1.8 });
  });
});
