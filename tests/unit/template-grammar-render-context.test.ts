import { describe, expect, it } from "vitest";
import { contextFor } from "../../src/renderer";
import type { ResolvedPresentationStyle } from "../../src/style";

const style = (layouts: Record<string, unknown> = {}) => ({
  grammar: { bodyScale: 1, headlineScale: 1, kpiScale: 1, spacingScale: 1, focalVisualScale: 1, copyBudget: 1, surfaceUsage: "none" },
  organization: { map: { layouts, defaultLayout: { contentRegion: { x: 0.72, y: 0.48, w: 11.85, h: 6.14 } } } },
  templateGrammar: { geometry: { contentFrame: { x: 1, y: 1, w: 10, h: 5 } }, surface: { usage: "none" } },
} as unknown as ResolvedPresentationStyle);

describe("template grammar geometry precedence", () => {
  it("uses grammar geometry when a semantic layout has no explicit map binding", () => {
    const rect = contextFor(style(), "comparison").transform({ x: 0.72, y: 0.48, w: 11.85, h: 6.14 });
    expect(rect.x).toBeCloseTo(1);
    expect(rect.y).toBeCloseTo(1);
    expect(rect.w).toBeCloseTo(10);
    expect(rect.h).toBeCloseTo(5);
  });

  it("keeps explicit map geometry ahead of inferred grammar", () => {
    const region = { x: 2, y: 1, w: 8, h: 4 };
    const rect = contextFor(style({ comparison: { contentRegion: region } }), "comparison").transform({ x: 0.72, y: 0.48, w: 11.85, h: 6.14 });
    expect(rect.x).toBeCloseTo(region.x);
    expect(rect.y).toBeCloseTo(region.y);
    expect(rect.w).toBeCloseTo(region.w);
    expect(rect.h).toBeCloseTo(region.h);
  });
});
