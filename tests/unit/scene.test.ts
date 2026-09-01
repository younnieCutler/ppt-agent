import { describe, expect, it } from "vitest";
import { composeDefaultScene, resolveSceneGeometry, sceneIntentSchema, selectMeaningfulSceneGap } from "../../src/scene";
import type { TemplateDesignSystemArtifact } from "../../src/template-design-system";

function designSystem(overrides: Partial<TemplateDesignSystemArtifact> = {}): TemplateDesignSystemArtifact {
  return {
    version: 1,
    compilerVersion: "2",
    sourceDigest: "a".repeat(64),
    elementsDigest: "b".repeat(64),
    canvas: { w: 13.333, h: 7.5 },
    typography: { roles: {}, typeScale: { values: [14, 24, 40], min: 14, max: 40 } },
    colors: { text: ["14181C"], fill: ["FAF9F5"], stroke: ["E2DFD5"], background: ["FFFFFF"] },
    geometry: { contentFrame: { x: 0.8, y: 0.6, w: 11.733, h: 6.2 }, outerMargins: { x: 0.8, y: 0.6, w: 0.8, h: 0.7 }, gutters: [0.002083, 0.24, 0.32] },
    spacing: { rhythm: [0.002083, 0.24, 0.32] },
    dividers: { orientations: [], thicknesses: [], lengths: [], strokeWidthsPt: [], colors: [] },
    surfaces: { fills: [], borders: [], borderWidthsPt: [] },
    alignmentAnchors: { x: [], y: [] },
    ...overrides,
  };
}

describe("vNext Scene IR", () => {
  it("does not expose physical x/y/w/h coordinates to the host intent", () => {
    const scene = composeDefaultScene({
      slideId: "S04",
      kind: "metric_strip",
      headline: "업무 위임 비율",
      blocks: [
        { id: "m1", role: "metric", text: "45% 직접 판단", emphasis: "primary" },
        { id: "m2", role: "metric", text: "40% Agent 위임" },
        { id: "m3", role: "metric", text: "15% 인간 승인" },
      ],
    });

    expect(scene.zones).toHaveLength(3);
    expect(scene.zones.map((zone) => [zone.colStart, zone.colSpan])).toEqual([[0, 4], [4, 4], [8, 4]]);
    expect(JSON.stringify(scene)).not.toMatch(/"x"|"y"|"w"|"h"/);
  });

  it("renders three metrics as a true horizontal strip, never a one-column stack", () => {
    const scene = composeDefaultScene({
      slideId: "S04",
      kind: "metric_strip",
      headline: "업무 위임 비율",
      blocks: [
        { id: "m1", role: "metric", text: "45%" },
        { id: "m2", role: "metric", text: "40%" },
        { id: "m3", role: "metric", text: "15%" },
      ],
    });
    const resolved = resolveSceneGeometry(scene, designSystem());

    expect(resolved.zones).toHaveLength(3);
    expect(resolved.zones.every((zone) => zone.bounds.w < resolved.frame.w / 2)).toBe(true);
    expect(new Set(resolved.zones.map((zone) => zone.bounds.y)).size).toBe(1);
    expect(resolved.zones[0].bounds.x).toBeLessThan(resolved.zones[1].bounds.x);
    expect(resolved.zones[1].bounds.x).toBeLessThan(resolved.zones[2].bounds.x);
  });

  it("uses a 2x2 composition for four metrics instead of stretching four full-width rows", () => {
    const scene = composeDefaultScene({
      slideId: "S09",
      kind: "metric_strip",
      headline: "핵심 효과",
      blocks: [1, 2, 3, 4].map((value) => ({ id: `m${value}`, role: "metric" as const, text: `${value} metric` })),
    });
    const resolved = resolveSceneGeometry(scene, designSystem());

    expect(new Set(resolved.zones.map((zone) => zone.bounds.x)).size).toBe(2);
    expect(new Set(resolved.zones.map((zone) => zone.bounds.y)).size).toBe(2);
    expect(resolved.zones.every((zone) => zone.bounds.w < resolved.frame.w)).toBe(true);
  });

  it("preserves two semantic groups as two columns", () => {
    const scene = composeDefaultScene({
      slideId: "S07",
      kind: "split",
      headline: "Human vs Agent",
      blocks: [
        { id: "h1", role: "item", text: "판단", group: "human" },
        { id: "h2", role: "item", text: "맥락", group: "human" },
        { id: "a1", role: "item", text: "반복 실행", group: "agent" },
        { id: "a2", role: "item", text: "대량 처리", group: "agent" },
      ],
    });
    const resolved = resolveSceneGeometry(scene, designSystem());

    expect(resolved.zones).toHaveLength(2);
    expect(resolved.zones[0].bounds.x + resolved.zones[0].bounds.w).toBeLessThan(resolved.zones[1].bounds.x);
    expect(scene.nodes.filter((node) => node.zoneId === "group-1").map((node) => node.group)).toEqual(["human", "human"]);
    expect(scene.nodes.filter((node) => node.zoneId === "group-2").map((node) => node.group)).toEqual(["agent", "agent"]);
  });

  it("keeps a five-step process perceptually horizontal", () => {
    const scene = composeDefaultScene({
      slideId: "S05",
      kind: "sequence",
      headline: "Agentic workflow",
      blocks: ["요청", "계획", "실행", "검증", "승인"].map((text, index) => ({ id: `step-${index + 1}`, role: "step" as const, text })),
    });
    const resolved = resolveSceneGeometry(scene, designSystem());

    expect(resolved.zones).toHaveLength(5);
    expect(new Set(resolved.zones.map((zone) => zone.bounds.y)).size).toBe(1);
    expect(resolved.zones.map((zone) => zone.bounds.x)).toEqual([...resolved.zones.map((zone) => zone.bounds.x)].sort((a, b) => a - b));
  });

  it("rejects host zones that escape the bounded semantic grid", () => {
    expect(() => sceneIntentSchema.parse({
      version: 1,
      slideId: "S01",
      kind: "statement",
      headline: "headline",
      grid: { columns: 12, rows: 12 },
      zones: [{ id: "bad", colStart: 10, colSpan: 4, rowStart: 2, rowSpan: 5, align: "start", valign: "start" }],
      nodes: [{ id: "body", role: "body", text: "body", zoneId: "bad", order: 0, emphasis: "supporting" }],
    })).toThrow(/semantic column grid/);
  });

  it("ignores incidental micro-gaps when selecting template spacing", () => {
    const gap = selectMeaningfulSceneGap(designSystem());
    expect(gap).toEqual({ value: 0.24, source: "spacing.rhythm" });
    expect(gap.value).toBeGreaterThan(0.1);
  });
});
