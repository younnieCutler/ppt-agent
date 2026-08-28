import { describe, expect, it } from "vitest";
import { layoutNames, primaryVisualFor, requiredNativeObjectsFor, type SlideSpec } from "../../src/schema";

// executionLock used to be an LLM-authored field the schema merely cross-checked against
// these same facts. It is gone now; this test locks the derivation itself so a future edit
// to schema.ts cannot silently change what native objects/visual a composition implies.

const expectedVisualByLayout: Record<(typeof layoutNames)[number], string> = {
  title: "cover_typography",
  statement: "evidence_panel",
  comparison: "comparison",
  process: "process",
  pipeline: "pipeline",
  architecture: "architecture",
  quantitative: "chart",
  timeline: "timeline",
  evidence: "evidence_panel",
  chart: "chart",
};

const expectedNativeObjectsByComposition: Record<string, string[]> = {
  cover: ["text"], hero_evidence: ["text", "shapes"], claim_actions: ["text", "shapes"],
  two_column: ["text", "shapes"], diagnosis_matrix: ["text", "shapes"], ownership_split: ["text", "shapes"],
  sequence: ["text", "shapes", "connectors"], stage_gate: ["text", "shapes"],
  pipeline_lanes: ["text", "shapes", "connectors"], architecture_zones: ["text", "shapes", "connectors"],
  kpi_row: ["text", "shapes"], ranked_bars: ["text", "shapes"], metric_story: ["text", "shapes"],
  gauge_row: ["text", "shapes"], sparkline_row: ["text", "connectors"],
  linear_roadmap: ["text", "shapes", "connectors"], now_next_later: ["text", "shapes"],
  evidence_list: ["text"], evidence_panel: ["text"],
  native_chart: ["text", "chart"],
};

function slideStub(layout: string, composition: string, content: Record<string, unknown> = {}): SlideSpec {
  return { layout, composition, content } as unknown as SlideSpec;
}

describe("derived editability contract", () => {
  it("derives the same primary visual as the retired executionLock cross-check, for every layout", () => {
    for (const layout of layoutNames) {
      expect(primaryVisualFor(layout)).toBe(expectedVisualByLayout[layout]);
    }
  });

  it("derives the same required native objects as the retired executionLock cross-check, for every composition", () => {
    for (const [composition, expected] of Object.entries(expectedNativeObjectsByComposition)) {
      expect(requiredNativeObjectsFor(slideStub("statement", composition))).toEqual(expected);
    }
  });

  it("adds source_image only when the slide actually carries a source-owned image", () => {
    expect(requiredNativeObjectsFor(slideStub("title", "cover", { imagePath: "cover.png" }))).toContain("source_image");
    expect(requiredNativeObjectsFor(slideStub("title", "cover", {}))).not.toContain("source_image");
    expect(requiredNativeObjectsFor(slideStub("evidence", "evidence_panel", { assetPath: "chart.png" }))).toContain("source_image");
  });
});
