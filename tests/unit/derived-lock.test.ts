import { describe, expect, it } from "vitest";
import { layoutNames, primaryVisualFor, requiredNativeObjectsFor, type SlideSpec } from "../../src/schema";
import { findingSeverityByCode, visualFindingCodes } from "../../src/visual-qa";

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

  it("locks the closed set of visual finding codes so a new code cannot slip in without a matching repair behavior review", () => {
    expect([...visualFindingCodes]).toEqual([
      "TEXT_VISUALLY_OVERFLOWING",
      "CRITICAL_VISUAL_COLLISION",
      "OFF_CANVAS",
      "MISSING_RENDERED_OBJECT",
      "SEMANTIC_VISUAL_MISMATCH",
      "CHART_UNREADABLE",
      "BRAND_COLOR_VIOLATION",
      "BRAND_FONT_VIOLATION",
      "THEME_DATA_COLOR_VIOLATION",
      "WEAK_VISUAL_HIERARCHY",
      "EXCESSIVE_INFORMATION_DENSITY",
      "LOW_INFORMATION_DENSITY",
      "UNBALANCED_COMPOSITION",
      "EXCESSIVE_CARDIFICATION",
      "MEANINGLESS_DECORATION",
      "LOW_VISUAL_CONTRAST",
      "LOW_CONTRAST_SECONDARY_TEXT",
      "ARCHETYPE_DENSITY_MISMATCH",
      "ARCHETYPE_HIERARCHY_MISMATCH",
      "ARCHETYPE_VISUAL_WEIGHT_MISMATCH",
      "UNNECESSARY_GRADIENT",
      "GENERIC_DASHBOARD_LAYOUT",
      "REPEATED_THREE_COLUMN_PATTERN",
      "ARBITRARY_ICON_USAGE",
      "LAYOUT_REPETITION",
      "INCONSISTENT_SECTION_RHYTHM",
      "REFERENCE_VISUAL_DRIFT",
    ]);
  });

  it("locks severity as a pure function of code, so a judgment-layer finding can never choose its own severity", () => {
    expect(findingSeverityByCode).toEqual({
      TEXT_VISUALLY_OVERFLOWING: "hard",
      CRITICAL_VISUAL_COLLISION: "hard",
      OFF_CANVAS: "hard",
      MISSING_RENDERED_OBJECT: "hard",
      SEMANTIC_VISUAL_MISMATCH: "hard",
      CHART_UNREADABLE: "hard",
      BRAND_COLOR_VIOLATION: "hard",
      BRAND_FONT_VIOLATION: "hard",
      THEME_DATA_COLOR_VIOLATION: "hard",
      WEAK_VISUAL_HIERARCHY: "risk",
      EXCESSIVE_INFORMATION_DENSITY: "risk",
      LOW_INFORMATION_DENSITY: "risk",
      UNBALANCED_COMPOSITION: "risk",
      EXCESSIVE_CARDIFICATION: "risk",
      MEANINGLESS_DECORATION: "risk",
      LOW_VISUAL_CONTRAST: "risk",
      LOW_CONTRAST_SECONDARY_TEXT: "risk",
      ARCHETYPE_DENSITY_MISMATCH: "risk",
      ARCHETYPE_HIERARCHY_MISMATCH: "risk",
      ARCHETYPE_VISUAL_WEIGHT_MISMATCH: "risk",
      UNNECESSARY_GRADIENT: "risk",
      GENERIC_DASHBOARD_LAYOUT: "risk",
      REPEATED_THREE_COLUMN_PATTERN: "risk",
      ARBITRARY_ICON_USAGE: "risk",
      LAYOUT_REPETITION: "risk",
      INCONSISTENT_SECTION_RHYTHM: "risk",
      REFERENCE_VISUAL_DRIFT: "risk",
    });
  });
});
