import { describe, expect, it } from "vitest";
import { generativeSceneIntentSchema, resolveGenerativeScene, type GenerativeSceneIntent } from "../../src/generative-scene";
import type { TemplateConstraintProfile } from "../../src/brand-constraints";

function profile(): TemplateConstraintProfile {
  return {
    version: 1,
    compilerVersion: "1",
    sourceDigest: "a".repeat(64),
    elementsDigest: "b".repeat(64),
    canvas: { w: 13.333, h: 7.5 },
    immutableRegions: [
      {
        id: "logo",
        sourceElementId: "logo-source",
        sourceSlideId: "master-1",
        role: "logo",
        bounds: { x: 11.65, y: 0.78, w: 0.7, h: 0.35 },
        reserveSpace: true,
        confidence: 0.99,
        evidence: ["master_or_layout_owned", "stable_geometry", "stable_asset", "edge_anchored"],
      },
      {
        id: "background",
        sourceElementId: "background-source",
        sourceSlideId: "master-1",
        role: "persistent_decoration",
        bounds: { x: 0, y: 0, w: 13.333, h: 7.5 },
        reserveSpace: false,
        confidence: 0.99,
        evidence: ["master_or_layout_owned", "stable_geometry"],
      },
    ],
    contentRegions: [{ id: "content-main", bounds: { x: 0.8, y: 0.75, w: 11.733, h: 5.95 } }],
    styleVocabulary: {
      fonts: ["Noto Sans JP"],
      textColors: ["14181C"],
      fillColors: ["FAF9F5", "113A5C"],
      strokeColors: ["113A5C"],
      backgroundColors: ["FAF9F5"],
      textRoles: ["title", "subtitle", "heading", "body", "caption", "eyebrow", "label", "key_message", "metric", "metric_label", "annotation", "step", "route", "source", "logo", "footer", "surface", "divider"],
    },
    policies: { chrome: "immutable", colors: "template_only", fonts: "template_only" },
  };
}

function asymmetricComparison(): GenerativeSceneIntent {
  return generativeSceneIntentSchema.parse({
    version: 2,
    slideId: "S04",
    semanticIntent: "comparison",
    headline: "기존 방식과 Agentic Workflow",
    contentRegionId: "content-main",
    layout: {
      strategy: "model_authored",
      nodes: [
        { id: "title", role: "headline", text: "기존 방식과 Agentic Workflow", frame: { x: 0, y: 0, w: 0.72, h: 0.16 }, emphasis: 1, styleRole: "title", componentPreference: "title_block" },
        { id: "legacy", role: "item", text: "사람이 요청마다 직접 실행", frame: { x: 0, y: 0.24, w: 0.38, h: 0.52 }, emphasis: 0.55, group: "legacy", styleRole: "body" },
        { id: "agent", role: "item", text: "Agent가 계획·실행·검증", frame: { x: 0.44, y: 0.21, w: 0.56, h: 0.62 }, emphasis: 0.9, group: "agent", styleRole: "body" },
      ],
    },
    constraints: { chrome: "immutable", colors: "template_only", fonts: "template_only" },
  });
}

describe("brand-constrained generative Scene", () => {
  it("allows asymmetric model-authored normalized composition without exposing physical PPTX geometry", () => {
    const resolved = resolveGenerativeScene(asymmetricComparison(), profile());
    const legacy = resolved.nodes.find((node) => node.id === "legacy")!;
    const agent = resolved.nodes.find((node) => node.id === "agent")!;

    expect(legacy.frame.w).toBe(0.38);
    expect(agent.frame.w).toBe(0.56);
    expect(agent.bounds.w).toBeGreaterThan(legacy.bounds.w);
    expect(resolved.contentRegion).toEqual({ x: 0.8, y: 0.75, w: 11.733, h: 5.95 });
    expect(resolved.brandConstraintDigestInput.sourceDigest).toBe("a".repeat(64));
  });

  it("rejects arbitrary host color/font/shape identity fields at the contract boundary", () => {
    const scene = asymmetricComparison() as unknown as Record<string, unknown>;
    const layout = scene.layout as { strategy: string; nodes: Array<Record<string, unknown>> };
    layout.nodes[0] = { ...layout.nodes[0], color: "FF00FF", font: "Comic Sans MS", shapeId: "42" };

    expect(() => generativeSceneIntentSchema.parse(scene)).toThrow();
  });

  it("rejects normalized geometry that escapes the approved content canvas", () => {
    const raw = {
      ...asymmetricComparison(),
      layout: {
        strategy: "model_authored" as const,
        nodes: [{ id: "bad", role: "body" as const, text: "overflow", frame: { x: 0.8, y: 0.2, w: 0.3, h: 0.2 }, emphasis: 0.5 }],
      },
    };
    expect(() => generativeSceneIntentSchema.parse(raw)).toThrow(/exceeds the content region width/);
  });

  it("hard-fails when model-authored content collides with immutable corporate chrome", () => {
    const scene = generativeSceneIntentSchema.parse({
      version: 2,
      slideId: "S02",
      semanticIntent: "statement",
      headline: "Brand guard",
      layout: {
        strategy: "model_authored",
        nodes: [
          { id: "collision", role: "headline", text: "Do not cover the logo", frame: { x: 0.88, y: 0, w: 0.12, h: 0.1 }, emphasis: 1, styleRole: "title" },
        ],
      },
    });

    expect(() => resolveGenerativeScene(scene, profile())).toThrow(/IMMUTABLE_COLLISION/);
  });

  it("does not treat a full-canvas immutable background as forbidden content space", () => {
    const scene = generativeSceneIntentSchema.parse({
      version: 2,
      slideId: "S03",
      semanticIntent: "quantitative",
      headline: "Three metrics",
      layout: {
        strategy: "model_authored",
        nodes: [
          { id: "m1", role: "metric", text: "45%", frame: { x: 0, y: 0.3, w: 0.28, h: 0.35 }, emphasis: 1, styleRole: "metric", componentPreference: "metric" },
          { id: "m2", role: "metric", text: "40%", frame: { x: 0.36, y: 0.3, w: 0.28, h: 0.35 }, emphasis: 0.8, styleRole: "metric", componentPreference: "metric" },
          { id: "m3", role: "metric", text: "15%", frame: { x: 0.72, y: 0.3, w: 0.25, h: 0.35 }, emphasis: 0.5, styleRole: "metric", componentPreference: "metric" },
        ],
      },
    });

    expect(resolveGenerativeScene(scene, profile()).nodes).toHaveLength(3);
  });

  it("rejects relaxed brand policy profiles", () => {
    const relaxed = { ...profile(), policies: { chrome: "immutable" as const, colors: "template_only" as const, fonts: "template_only" as const } };
    (relaxed.policies as { colors: string }).colors = "creative";
    expect(() => resolveGenerativeScene(asymmetricComparison(), relaxed as TemplateConstraintProfile)).toThrow(/BRAND_POLICY_UNSUPPORTED/);
  });
});
