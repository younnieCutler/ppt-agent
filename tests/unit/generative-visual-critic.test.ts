import { describe, expect, it } from "vitest";
import type { TemplateConstraintProfile } from "../../src/brand-constraints";
import type { GenerativeAuthoringRequest } from "../../src/generative-authoring";
import { runBoundedGenerativeCriticLoop } from "../../src/generative-critic-loop";
import type { GenerativeSceneIntent } from "../../src/generative-scene";
import { applyGenerativeSceneRepair, buildGenerativeSceneRepairRequest } from "../../src/generative-scene-repair";
import { buildGenerativeVisualCriticRequest, parseGenerativeVisualCriticResponse } from "../../src/generative-visual-critic";

const sourceDigest = "a".repeat(64);
const elementsDigest = "b".repeat(64);

function brand(): TemplateConstraintProfile {
  return {
    version: 1,
    compilerVersion: "1",
    sourceDigest,
    elementsDigest,
    canvas: { w: 13.333, h: 7.5 },
    immutableRegions: [{
      id: "logo",
      sourceElementId: "logo",
      sourceSlideId: "master",
      role: "logo",
      bounds: { x: 11.7, y: 0.2, w: 0.8, h: 0.3 },
      reserveSpace: true,
      confidence: 0.99,
      evidence: ["master_or_layout_owned", "stable_geometry"],
    }],
    contentRegions: [{ id: "content-main", bounds: { x: 0.8, y: 0.7, w: 11.6, h: 5.9 } }],
    styleVocabulary: {
      fonts: ["Noto Sans JP"],
      textColors: ["111111"],
      fillColors: ["F5F1E8"],
      strokeColors: ["113A5C"],
      backgroundColors: ["F5F1E8"],
      textRoles: ["title", "body", "label", "metric", "surface", "divider"],
    },
    policies: { chrome: "immutable", colors: "template_only", fonts: "template_only" },
  };
}

function scene(): GenerativeSceneIntent {
  return {
    version: 2,
    slideId: "S10",
    semanticIntent: "quantitative",
    headline: "Agent work is becoming measurable",
    contentRegionId: "content-main",
    layout: {
      strategy: "model_authored",
      nodes: [
        { id: "headline", role: "headline", text: "Agent work is becoming measurable", frame: { x: 0.04, y: 0.04, w: 0.72, h: 0.12 }, emphasis: 1, styleRole: "title" },
        { id: "metric-a", role: "metric", text: "45", frame: { x: 0.04, y: 0.34, w: 0.22, h: 0.2 }, emphasis: 0.8, styleRole: "metric" },
        { id: "metric-b", role: "metric", text: "40", frame: { x: 0.31, y: 0.34, w: 0.22, h: 0.2 }, emphasis: 0.8, styleRole: "metric" },
        { id: "metric-c", role: "metric", text: "15", frame: { x: 0.58, y: 0.34, w: 0.22, h: 0.2 }, emphasis: 0.8, styleRole: "metric" },
      ],
    },
    constraints: { chrome: "immutable", colors: "template_only", fonts: "template_only" },
  };
}

function authoringRequest(): GenerativeAuthoringRequest {
  return {
    version: 1,
    requestDigest: "c".repeat(64),
    sourceDigest,
    elementsDigest,
    instructions: {
      compositionAuthority: "model_authored",
      coordinateSpace: "normalized_content_region_0_1",
      sourceSlideGeometry: "reference_only",
      preserveAllContentAtoms: true,
      forbidInventedText: true,
      chrome: "immutable",
      colors: "template_only",
      fonts: "template_only",
    },
    brand: {
      contentRegionId: "content-main",
      allowedFonts: ["Noto Sans JP"],
      allowedColors: ["111111", "F5F1E8", "113A5C"],
      allowedTextStyleRoles: ["title", "body", "label", "metric", "surface", "divider"],
      allowedComponentKinds: ["title_block", "metric", "surface", "divider"],
      blockedRegions: [],
    },
    references: [],
    slides: [{
      id: "S10",
      semanticIntent: "quantitative",
      storyBeat: "evidence",
      layout: "quantitative",
      headline: "Agent work is becoming measurable",
      headlineAlignment: "left",
      compositionHint: "metric_story",
      contentAtoms: [
        { id: "S10.headline", text: "Agent work is becoming measurable", roleHint: "headline", importance: "primary", group: "headline" },
        { id: "S10.metric.1.value", text: "45", roleHint: "metric", importance: "primary", group: "metric.1" },
        { id: "S10.metric.2.value", text: "40", roleHint: "metric", importance: "primary", group: "metric.2" },
        { id: "S10.metric.3.value", text: "15", roleHint: "metric", importance: "primary", group: "metric.3" },
      ],
      relationships: [],
    }],
  };
}

function criticResponse(request: ReturnType<typeof buildGenerativeVisualCriticRequest>, score: number, repairable = true) {
  return {
    version: 1 as const,
    requestDigest: request.requestDigest,
    sourceDigest: request.sourceDigest,
    renderDigest: request.renderDigest,
    slides: [{
      slideId: "S10",
      scores: {
        visualHierarchy: score,
        compositionBalance: score,
        purposeFit: score,
        readability: score,
        professionalism: score,
        templateFit: score,
      },
      findings: score >= 8 ? [] : [{ code: "UNBALANCED_COMPOSITION" as const, message: "Metrics feel mechanically even; create a clearer focal metric.", nodeIds: ["metric-a", "metric-b", "metric-c"], repairable }],
      summary: score >= 8 ? "Ready" : "Composition needs one targeted pass",
    }],
    deckFindings: [],
  };
}

describe("Generative visual critic", () => {
  it("routes only below-threshold slides to repair and binds judgment to exact render provenance", () => {
    const request = buildGenerativeVisualCriticRequest({
      authoringRequest: authoringRequest(),
      renderedScenes: [{ slideId: "S10", imagePath: "visual/slide-001.png", imageSha256: "d".repeat(64), scene: scene() }],
      renderDigest: "e".repeat(64),
      round: 0,
    });
    const parsed = parseGenerativeVisualCriticResponse(request, criticResponse(request, 6.5));
    expect(parsed.repairSlideIds).toEqual(["S10"]);
    expect(parsed.passedSlideIds).toEqual([]);

    const stale = criticResponse(request, 8.5);
    stale.renderDigest = "f".repeat(64);
    expect(() => parseGenerativeVisualCriticResponse(request, stale)).toThrow(/RESPONSE_STALE/);
  });

  it("applies targeted geometry repair while freezing all text nodes and corporate constraints", () => {
    const criticRequest = buildGenerativeVisualCriticRequest({
      authoringRequest: authoringRequest(),
      renderedScenes: [{ slideId: "S10", imagePath: "visual/slide-001.png", imageSha256: "d".repeat(64), scene: scene() }],
      renderDigest: "e".repeat(64),
      round: 0,
    });
    const response = criticResponse(criticRequest, 6.5);
    const repairRequest = buildGenerativeSceneRepairRequest(criticRequest, response, "S10");
    const repaired = applyGenerativeSceneRepair(repairRequest, {
      version: 1,
      requestDigest: repairRequest.requestDigest,
      sourceDigest,
      slideId: "S10",
      rationale: "Make the primary metric visually dominant without changing content.",
      operations: [
        { op: "set_frame", nodeId: "metric-a", frame: { x: 0.03, y: 0.3, w: 0.34, h: 0.28 } },
        { op: "set_emphasis", nodeId: "metric-a", emphasis: 1 },
        { op: "set_frame", nodeId: "metric-b", frame: { x: 0.46, y: 0.34, w: 0.2, h: 0.18 } },
        { op: "add_structure", node: { id: "divider-focus", role: "divider", frame: { x: 0.4, y: 0.28, w: 0.01, h: 0.35 }, emphasis: 0.4, componentPreference: "divider" } },
      ],
    }, brand());

    expect(repaired.layout.nodes.find((node) => node.id === "metric-a")?.frame.w).toBe(0.34);
    expect(repaired.layout.nodes.filter((node) => node.role !== "surface" && node.role !== "divider").map((node) => [node.id, node.text]))
      .toEqual(scene().layout.nodes.map((node) => [node.id, node.text]));
    expect(repaired.constraints).toEqual(scene().constraints);
  });

  it("forbids text-node removal and rejects repairs that collide with immutable brand chrome", () => {
    const criticRequest = buildGenerativeVisualCriticRequest({
      authoringRequest: authoringRequest(),
      renderedScenes: [{ slideId: "S10", imagePath: "visual/slide-001.png", imageSha256: "d".repeat(64), scene: scene() }],
      renderDigest: "e".repeat(64),
      round: 0,
    });
    const repairRequest = buildGenerativeSceneRepairRequest(criticRequest, criticResponse(criticRequest, 6), "S10");
    expect(() => applyGenerativeSceneRepair(repairRequest, {
      version: 1, requestDigest: repairRequest.requestDigest, sourceDigest, slideId: "S10", rationale: "bad", operations: [{ op: "remove_structure", nodeId: "metric-a" }],
    }, brand())).toThrow(/TEXT_NODE_REMOVAL_FORBIDDEN/);
  });

  it("runs at most two targeted repair rounds and stops immediately once the critic passes", async () => {
    const calls: number[] = [];
    const result = await runBoundedGenerativeCriticLoop({
      authoringRequest: authoringRequest(),
      initialScenes: new Map([["S10", scene()]]),
      brandProfile: brand(),
      callbacks: {
        render: async (scenes, round) => ({
          renderDigest: String(round + 1).repeat(64),
          slides: [{ slideId: "S10", imagePath: `visual/round-${round}.png`, imageSha256: "d".repeat(64), scene: scenes.get("S10") }].map(({ scene: _scene, ...rest }) => rest),
        }),
        judge: async (request) => {
          calls.push(request.round);
          return criticResponse(request, request.round === 0 ? 6.5 : 8.5);
        },
        repair: async (request) => ({
          version: 1,
          requestDigest: request.requestDigest,
          sourceDigest,
          slideId: request.slideId,
          rationale: "One bounded geometry adjustment",
          operations: [{ op: "set_emphasis", nodeId: "metric-a", emphasis: 1 }],
        }),
      },
    });

    expect(result.status).toBe("pass");
    expect(result.rounds).toBe(1);
    expect(calls).toEqual([0, 1]);
  });

  it("hard-fails after the second repair instead of looping or publishing a weak slide", async () => {
    await expect(runBoundedGenerativeCriticLoop({
      authoringRequest: authoringRequest(),
      initialScenes: new Map([["S10", scene()]]),
      brandProfile: brand(),
      callbacks: {
        render: async (_scenes, round) => ({ renderDigest: String(round + 1).repeat(64), slides: [{ slideId: "S10", imagePath: `visual/${round}.png`, imageSha256: "d".repeat(64) }] }),
        judge: async (request) => criticResponse(request, 6),
        repair: async (request) => ({ version: 1, requestDigest: request.requestDigest, sourceDigest, slideId: request.slideId, rationale: "try", operations: [{ op: "set_emphasis", nodeId: "metric-a", emphasis: 0.95 }] }),
      },
    })).rejects.toThrow(/REPAIR_EXHAUSTED/);
  });
});
