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
  it("rejects non-canonical adaptive bounds instead of hiding them with a clamp", () => {
    expect(() => geometryFor([{ x: 0.85, y: 0.7, w: 6, h: 0.5 }, { x: -2, y: -1, w: 18.5, h: 9 }])).toThrow(/TEMPLATE_COORDINATE_SPACE_MISMATCH/);
  });

  it("keeps the content frame inside the slide when an off-canvas helper is explicitly separated", () => {
    const geometry = compileTemplateGrammar({
      ...elements,
      slides: [{ id: "S01", elements: [
        ...elements.slides[0].elements,
        { id: "S01-helper-1", slideId: "S01", type: "shape", role: "unknown", confidence: 0, bounds: { x: -2, y: -1, w: 18.5, h: 9 }, zIndex: 3, offCanvasHelper: true, features: {} },
      ] }],
    } as unknown as typeof elements).geometry;
    expectInsideCanvas(geometry);
    expect(geometry.contentFrame).toMatchObject({ x: 0.85, y: 0.7, w: 8, h: 2.3 });
  });

  it("rejects every unclassified off-canvas edge rather than collapsing it", () => {
    const { w: slideW, h: slideH } = elements.source.slideSize;
    expect(() => geometryFor([{ x: slideW + 2, y: 1, w: 3, h: 1 }])).toThrow(/TEMPLATE_COORDINATE_SPACE_MISMATCH/);
    expect(() => geometryFor([{ x: 1, y: slideH + 2, w: 3, h: 1 }])).toThrow(/TEMPLATE_COORDINATE_SPACE_MISMATCH/);
    expect(() => geometryFor([{ x: -6, y: 1, w: 3, h: 1 }])).toThrow(/TEMPLATE_COORDINATE_SPACE_MISMATCH/);
    expect(() => geometryFor([{ x: 1, y: -6, w: 3, h: 1 }])).toThrow(/TEMPLATE_COORDINATE_SPACE_MISMATCH/);
  });

  it("leaves an ordinary in-canvas template untouched", () => {
    const geometry = geometryFor([{ x: 0.85, y: 0.7, w: 6, h: 0.5 }, { x: 0.85, y: 1.5, w: 8, h: 1 }]);
    expectInsideCanvas(geometry);
    expect(geometry.contentFrame).toMatchObject({ x: 0.85, y: 0.7, w: 8, h: 1.8 });
  });
});
