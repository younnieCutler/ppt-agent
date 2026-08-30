import { describe, expect, it } from "vitest";
import type { TemplateElementsArtifact, TemplateElement } from "../../src/template-analysis";
import { compileTemplateComponents } from "../../src/template-components";

const sourceDigest = "a".repeat(64);
const style = {
  title: { family: "Noto Sans JP", sizePt: 32, weight: 700 },
  body: { family: "Noto Sans JP", sizePt: 16, weight: 400 },
  card: { fill: "F5F1E8", stroke: "1A1A1A", strokeWidthPt: 1 },
  metric: { family: "Noto Sans JP", sizePt: 28, weight: 700 },
};

function element(
  id: string,
  slideId: string,
  type: TemplateElement["type"],
  role: TemplateElement["role"],
  bounds: TemplateElement["bounds"],
  styleRef?: string,
  name = id,
): TemplateElement {
  return { id, name, slideId, type, role, confidence: role === "unknown" ? 0 : 0.9, bounds, zIndex: 0, ownership: "slide-body-owned", styleRef, features: {}, ...(type === "image" ? { assetRef: "ppt/media/image1.png" } : {}) };
}

function fixture(): TemplateElementsArtifact {
  const card = (slideId: string, id: string, x: number): TemplateElement => element(id, slideId, "shape", "surface", { x, y: 2, w: 2, h: 1 }, "card");
  const metric = (id: string, x: number): TemplateElement => element(id, "S03", "text", "metric", { x, y: 2, w: 2, h: 0.5 }, "metric");
  return {
    version: 1,
    source: { sha256: sourceDigest, slideSize: { w: 13.333, h: 7.5 } },
    analysisInputs: { templateDigest: sourceDigest, roleOverridesDigest: "b".repeat(64), analyzerVersion: "4" },
    slides: [
      { id: "S01", sourceSlidePart: "ppt/slides/slide1.xml", nativeLayout: { index: 1, name: "Blank", masterIndex: 1 }, elements: [
        element("S01-title", "S01", "text", "title", { x: 1, y: 0.5, w: 6, h: 0.6 }, "title"),
        element("S01-body", "S01", "text", "body", { x: 1, y: 1.2, w: 6, h: 0.8 }, "body"),
        card("S01", "S01-card", 1),
        element("S01-image", "S01", "image", "unknown", { x: 8, y: 1, w: 3, h: 2 }),
      ] },
      { id: "S02", sourceSlidePart: "ppt/slides/slide2.xml", nativeLayout: { index: 1, name: "Blank", masterIndex: 1 }, elements: [card("S02", "S02-card-1", 1), card("S02", "S02-card-2", 4), card("S02", "S02-card-3", 7)] },
      { id: "S03", sourceSlidePart: "ppt/slides/slide3.xml", nativeLayout: { index: 1, name: "Blank", masterIndex: 1 }, elements: [
        metric("S03-metric-1", 1), metric("S03-metric-2", 4), metric("S03-metric-3", 7),
        element("S03-divider", "S03", "line", "divider", { x: 1, y: 3, w: 8, h: 0 }, "card"),
        element("S03-unknown", "S03", "shape", "unknown", { x: 1, y: 4, w: 1, h: 1 }),
      ] },
    ],
    layouts: [],
    masters: [],
    styles: style,
    strategy: "source_slide_pattern",
  };
}

describe("template component catalog", () => {
  it("classifies native components and records repeated cards and metrics deterministically", () => {
    const result = compileTemplateComponents(fixture());

    expect(result.version).toBe(1);
    expect(result.sourceDigest).toBe(sourceDigest);
    expect(result.elementsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.compilerVersion).toMatch(/^\d+$/);
    expect(result.components.find((component) => component.kind === "title_block")?.semanticRoles).toEqual(["title"]);
    expect(result.components.filter((component) => component.kind === "card")).toHaveLength(4);
    expect(result.components.filter((component) => component.sourceSlideId === "S02").every((component) => component.repeatability.signal === "repeatable")).toBe(true);
    expect(result.components.find((component) => component.id === "component-S02-card-1")?.repeatability).toMatchObject({ count: 3, index: 0 });
    expect(result.components.find((component) => component.id === "component-S02-card-1")?.groupPattern).toBe("horizontal_row");
    expect(result.components.filter((component) => component.kind === "metric")).toHaveLength(3);
    expect(result.repeatGroups.map((group) => group.componentIds.length)).toEqual(expect.arrayContaining([3, 3]));
    expect(result.components.find((component) => component.kind === "divider")?.resizeFeasibility.horizontal).toBe("safe");
    expect(result.components.find((component) => component.kind === "media_frame")?.assetProvenance).toMatchObject({ kind: "image", ref: "ppt/media/image1.png" });
    expect(result.components.find((component) => component.id === "component-S03-unknown")?.kind).toBe("unknown");
    expect(result.components.find((component) => component.id === "component-S03-unknown")?.confidence).toBe(0);
    expect(result.components.find((component) => component.id === "component-S02-card-1")?.shapeNames).toEqual(["S02-card-1"]);
    expect(JSON.stringify(result)).toBe(JSON.stringify(compileTemplateComponents(fixture())));
  });
});
