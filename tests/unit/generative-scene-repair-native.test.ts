import { describe, expect, it } from "vitest";
import type { TemplateConstraintProfile } from "../../src/brand-constraints";
import type { GenerativeSceneIntent } from "../../src/generative-scene";
import { applyGenerativeSceneRepair, type GenerativeSceneRepairRequest } from "../../src/generative-scene-repair";

const sourceDigest = "a".repeat(64);
const requestDigest = "b".repeat(64);

function brand(): TemplateConstraintProfile {
  return {
    version: 1,
    compilerVersion: "1",
    sourceDigest,
    elementsDigest: "c".repeat(64),
    canvas: { w: 13.333, h: 7.5 },
    immutableRegions: [],
    contentRegions: [{ id: "content-main", bounds: { x: 0.8, y: 0.6, w: 11.7, h: 6.1 } }],
    styleVocabulary: {
      fonts: ["Arial"], textColors: ["111111"], fillColors: ["FFFFFF"], strokeColors: ["113A5C"], backgroundColors: ["FFFFFF"],
      textRoles: ["title", "body", "label"],
    },
    policies: { chrome: "immutable", colors: "template_only", fonts: "template_only" },
  };
}

function scene(): GenerativeSceneIntent {
  return {
    version: 3,
    slideId: "S02",
    semanticIntent: "quantitative",
    headline: "Editable native chart",
    contentRegionId: "content-main",
    layout: { strategy: "model_authored", nodes: [
      { id: "headline", role: "headline", text: "Editable native chart", frame: { x: 0, y: 0, w: 0.7, h: 0.12 } },
      { id: "chart", role: "chart", datasetRef: "sales", chartType: "bar", frame: { x: 0.1, y: 0.25, w: 0.8, h: 0.6 } },
    ] },
    constraints: { chrome: "immutable", colors: "template_only", fonts: "template_only" },
  };
}

function request(): GenerativeSceneRepairRequest {
  return {
    version: 1,
    requestDigest,
    sourceDigest,
    criticRequestDigest: "d".repeat(64),
    round: 1,
    slideId: "S02",
    constraints: {
      preserveAllText: true,
      preserveTextNodeIds: true,
      preserveSemanticIntent: true,
      preserveHeadline: true,
      chrome: "immutable",
      colors: "template_only",
      fonts: "template_only",
      allowedOperations: ["set_frame", "set_emphasis", "set_group", "set_style_role", "set_component_preference", "add_structure", "remove_structure"],
    },
    findings: [],
    deckFindings: [],
    scores: {},
    scene: scene(),
  };
}

function response(operations: unknown[]) {
  return {
    version: 1,
    requestDigest,
    sourceDigest,
    slideId: "S02",
    operations,
    rationale: "Targeted visual repair only.",
  };
}

describe("Scene v3 native primitive repair boundary", () => {
  it("allows geometry repair of a native chart without changing its semantic/data reference", () => {
    const repaired = applyGenerativeSceneRepair(request(), response([
      { op: "set_frame", nodeId: "chart", frame: { x: 0.16, y: 0.25, w: 0.7, h: 0.6 } },
    ]), brand());
    const chart = repaired.layout.nodes.find((node) => node.id === "chart");
    expect(chart?.frame.x).toBe(0.16);
    expect(chart?.role).toBe("chart");
    if (chart?.role === "chart") {
      expect(chart.datasetRef).toBe("sales");
      expect(chart.chartType).toBe("bar");
    }
  });

  it("forbids text-style or template-component mutation on native primitives", () => {
    expect(() => applyGenerativeSceneRepair(request(), response([
      { op: "set_style_role", nodeId: "chart", styleRole: "body" },
    ]), brand())).toThrow(/TEXT_ONLY_OPERATION/);

    expect(() => applyGenerativeSceneRepair(request(), response([
      { op: "set_component_preference", nodeId: "chart", componentPreference: "card" },
    ]), brand())).toThrow(/NATIVE_COMPONENT_PREFERENCE_FORBIDDEN/);
  });
});
