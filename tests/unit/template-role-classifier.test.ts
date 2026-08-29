import { describe, expect, it } from "vitest";
import { classifyTemplateElement } from "../../src/template-analysis";

const slideSize = { w: 13.333, h: 7.5 };

describe("template role classifier", () => {
  it("prefers placeholder-like names over geometry", () => {
    expect(classifyTemplateElement({ id: "S01-Title-1", type: "text", bounds: { x: 0.5, y: 5, w: 2, h: 0.4 }, features: {} }, slideSize)).toMatchObject({ role: "title", confidence: 0.95 });
  });

  it("only calls bottom-edge text a footer", () => {
    expect(classifyTemplateElement({ id: "S01-Footer-1", type: "text", bounds: { x: 0.5, y: 7.1, w: 2, h: 0.2 }, features: {} }, slideSize)).toMatchObject({ role: "footer" });
    expect(classifyTemplateElement({ id: "S01-Footer-1", type: "text", bounds: { x: 0.5, y: 2, w: 2, h: 0.2 }, features: {} }, slideSize).role).toBe("unknown");
  });

  it("classifies numeric focal text as a metric and lets explicit overrides win", () => {
    expect(classifyTemplateElement({ id: "S01-value-1", type: "text", bounds: { x: 1, y: 1, w: 3, h: 1 }, features: { numericOnly: true } }, slideSize).role).toBe("metric");
    expect(classifyTemplateElement({ id: "S01-value-1", type: "text", bounds: { x: 1, y: 1, w: 3, h: 1 }, features: { numericOnly: true } }, slideSize, { "S01-value-1": "heading" }).role).toBe("heading");
  });
});
