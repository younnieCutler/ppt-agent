import { describe, expect, it } from "vitest";
import { classifyTemplateElement } from "../../src/template-analysis";

const slideSize = { w: 13.333, h: 7.5 };

describe("template role classifier", () => {
  it("prefers placeholder-like names over geometry", () => {
    expect(classifyTemplateElement({ id: "S01-Title-1", type: "text", bounds: { x: 0.5, y: 5, w: 2, h: 0.4 }, features: {} }, slideSize)).toMatchObject({ role: "title", confidence: 0.9 });
  });

  it("ranks the template's own declarations above the shape name", () => {
    // A designer's name is a hint; <p:ph type> is what PowerPoint actually binds the shape to.
    expect(classifyTemplateElement({ id: "S01-TextBox-3", type: "text", bounds: { x: 0.5, y: 0.4, w: 8, h: 1 }, features: { placeholderType: "ctrTitle" } }, slideSize)).toMatchObject({ role: "title", confidence: 0.95 });
    expect(classifyTemplateElement({ id: "S01-Shape-4", type: "text", bounds: { x: 0.5, y: 7.1, w: 4, h: 0.3 }, features: { placeholderType: "ftr" } }, slideSize)).toMatchObject({ role: "footer" });
    // A footer placeholder dragged into the middle of the canvas is a repurposed shape, not chrome.
    expect(classifyTemplateElement({ id: "S01-Shape-5", type: "text", bounds: { x: 0.5, y: 2, w: 4, h: 0.3 }, features: { placeholderType: "ftr" } }, slideSize).role).not.toBe("footer");
  });

  it("reads alt text and body placeholder tokens when the shape name says nothing", () => {
    expect(classifyTemplateElement({ id: "S01-Rectangle-9", type: "text", bounds: { x: 1, y: 6, w: 4, h: 0.3 }, features: { altText: "Source note" } }, slideSize)).toMatchObject({ role: "source", confidence: 0.9 });
    expect(classifyTemplateElement({ id: "S01-Rectangle-8", type: "text", bounds: { x: 1, y: 2, w: 4, h: 1 }, features: { placeholderToken: "{{body}}" } }, slideSize)).toMatchObject({ role: "body", confidence: 0.8 });
  });

  it("falls back to typographic rank before giving up", () => {
    const bounds = { x: 1, y: 2, w: 6, h: 1 };
    const typography = { maxSizePt: 40, medianSizePt: 16 };
    expect(classifyTemplateElement({ id: "S01-Rectangle-1", type: "text", bounds, features: {} }, slideSize, { ...typography, sizePt: 40 }).role).toBe("title");
    expect(classifyTemplateElement({ id: "S01-Rectangle-2", type: "text", bounds, features: {} }, slideSize, { ...typography, sizePt: 22 }).role).toBe("heading");
    expect(classifyTemplateElement({ id: "S01-Rectangle-3", type: "text", bounds, features: {} }, slideSize, { ...typography, sizePt: 16 }).role).toBe("body");
    expect(classifyTemplateElement({ id: "S01-Rectangle-4", type: "text", bounds, features: {} }, slideSize, { ...typography, sizePt: 10 }).role).toBe("caption");
    // Without typography there is nothing left to claim, and an invented role is worse than none.
    expect(classifyTemplateElement({ id: "S01-Rectangle-5", type: "text", bounds, features: {} }, slideSize).role).toBe("unknown");
  });

  it("only calls bottom-edge text a footer", () => {
    expect(classifyTemplateElement({ id: "S01-Footer-1", type: "text", bounds: { x: 0.5, y: 7.1, w: 2, h: 0.2 }, features: {} }, slideSize)).toMatchObject({ role: "footer" });
    expect(classifyTemplateElement({ id: "S01-Footer-1", type: "text", bounds: { x: 0.5, y: 2, w: 2, h: 0.2 }, features: {} }, slideSize).role).toBe("unknown");
  });

  it("classifies numeric focal text as a metric", () => {
    expect(classifyTemplateElement({ id: "S01-value-1", type: "text", bounds: { x: 1, y: 1, w: 3, h: 1 }, features: { numericOnly: true } }, slideSize).role).toBe("metric");
  });
});
