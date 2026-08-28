import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { structuralQa } from "../../src/qa";

const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/all-layouts.json"), "utf8"));
const contentModel = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/content-model-all-layouts.json"), "utf8"));

const quantitativeSlide = fixture.slides.find((slide: { layout: string }) => slide.layout === "quantitative");

/** Swap the fixture's quantitative slide for one carrying the metrics and composition under test. */
function deckWith(composition: string, metrics: Array<{ label: string; value: number; unit: string }>) {
  const replacement = {
    ...quantitativeSlide,
    composition,
    content: { ...quantitativeSlide.content, metrics: metrics.map((metric) => ({ ...metric, period: "fixture period" })) },
  };
  return {
    ...fixture,
    slides: fixture.slides.map((slide: { id: string }) => (slide.id === quantitativeSlide.id ? replacement : slide)),
  };
}

const codesFor = (deck: unknown) =>
  structuralQa(deck as never, process.cwd(), contentModel).findings
    .filter((finding) => finding.code === "MISLEADING_QUANTITATIVE_ENCODING" || finding.code === "INCOMPARABLE_METRIC_SCALE");

// The pre-PR5 baseline deck put 200 humanoids, 300,000 accumulated learning hours, and 100 planned
// deployments on one bar row. Every existing gate passed it: the numbers were grounded, the objects
// were native, the geometry was clean, nothing overflowed. The encoding was still a lie.
const baselineMetrics = [
  { label: "ヒューマノイド", value: 200, unit: "体" },
  { label: "累積学習時間", value: 300000, unit: "時間" },
  { label: "導入予定", value: 100, unit: "件" },
];

describe("misleading quantitative encoding", () => {
  it("hard-fails mixed units on a shared-axis composition", () => {
    const findings = codesFor(deckWith("ranked_bars", baselineMetrics));
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("MISLEADING_QUANTITATIVE_ENCODING");
    expect(findings[0].severity).toBe("hard");
    expect(findings[0].message).toContain("3 different units");
  });

  it("names the compositions that legitimately present figures separately", () => {
    expect(codesFor(deckWith("ranked_bars", baselineMetrics))[0].message).toContain("kpi_row");
  });

  it("leaves the same metrics alone on kpi_row and metric_story, which encode no shared axis", () => {
    expect(codesFor(deckWith("kpi_row", baselineMetrics))).toHaveLength(0);
    expect(codesFor(deckWith("metric_story", baselineMetrics))).toHaveLength(0);
  });

  it("still catches the baseline's spread once the units are unified", () => {
    const unified = baselineMetrics.map((metric) => ({ ...metric, unit: "件" }));
    const findings = codesFor(deckWith("ranked_bars", unified));
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("INCOMPARABLE_METRIC_SCALE");
    expect(findings[0].severity).toBe("hard");
    expect(findings[0].message).toContain("3000x");
  });

  it("accepts a single-unit row within a readable range", () => {
    expect(codesFor(deckWith("ranked_bars", [
      { label: "Coverage", value: 82, unit: "%" },
      { label: "Adoption", value: 47, unit: "%" },
      { label: "Retention", value: 91, unit: "%" },
    ]))).toHaveLength(0);
  });

  it("applies to sparkline_row, which also plots one shared axis", () => {
    expect(codesFor(deckWith("sparkline_row", baselineMetrics.map((metric) => ({ ...metric, unit: "件" }))))[0].code).toBe("INCOMPARABLE_METRIC_SCALE");
  });

  // gauge_row's mixed-unit case is unreachable: the schema already pins every gauge metric to '%'.
  // It stays in the shared-axis set for the scale check, where 0.5% beside 100% is still unreadable.
  it("covers gauge_row for scale, with mixed units already blocked upstream by the schema", () => {
    expect(() => codesFor(deckWith("gauge_row", baselineMetrics))).toThrow(/every metric.unit must be '%'/);
    expect(codesFor(deckWith("gauge_row", [
      { label: "Rollout", value: 100, unit: "%" },
      { label: "Escalations", value: 0.5, unit: "%" },
    ]))[0].code).toBe("INCOMPARABLE_METRIC_SCALE");
  });
});

// A gauge is a bounded encoding. Pinning the unit to '%' is not enough on its own: the renderer
// draws `value / 100`, so 250% fills exactly the same arc as 100% and -15% draws nothing.
describe("gauge_row bounded domain", () => {
  it("rejects a value above the 0-100 arc", () => {
    expect(() => codesFor(deckWith("gauge_row", [
      { label: "達成率", value: 250, unit: "%" },
      { label: "進捗", value: 40, unit: "%" },
    ]))).toThrow(/cannot be drawn honestly/);
  });

  it("rejects a negative value", () => {
    expect(() => codesFor(deckWith("gauge_row", [
      { label: "成長率", value: -15, unit: "%" },
      { label: "進捗", value: 40, unit: "%" },
    ]))).toThrow(/cannot be drawn honestly/);
  });

  it("names the compositions that can carry an unbounded value", () => {
    try {
      codesFor(deckWith("gauge_row", [{ label: "達成率", value: 250, unit: "%" }, { label: "進捗", value: 40, unit: "%" }]));
      throw new Error("expected a schema rejection");
    } catch (error) {
      expect(String(error)).toMatch(/kpi_row|ranked_bars/);
    }
  });

  it("accepts values on the arc, including its endpoints", () => {
    expect(codesFor(deckWith("gauge_row", [
      { label: "完了", value: 100, unit: "%" },
      { label: "未着手", value: 0, unit: "%" },
      { label: "進行中", value: 55, unit: "%" },
    ]))).toHaveLength(0);
  });
});
