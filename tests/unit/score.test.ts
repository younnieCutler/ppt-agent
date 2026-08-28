import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dimensionWeights, recordRun, scoreDeck } from "../../src/score";

const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/all-layouts.json"), "utf8"));
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-score-"));

afterAll(() => fs.rmSync(runDir, { recursive: true, force: true }));

const perfectScores = {
  contentFidelity: 100,
  narrativeQuality: 100,
  visualHierarchy: 100,
  semanticVisualization: 100,
  layoutVariety: 100,
  typographyReadability: 100,
  purposeFit: 100,
  antiSlop: 100,
};

const withReference = { ...fixture, contract: { ...fixture.contract, referenceIds: ["REF001"] } };
const noReference = { ...fixture, contract: { ...fixture.contract, referenceIds: undefined } };

function runDirWith(name: string, files: Record<string, unknown>): string {
  const dir = path.join(runDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), JSON.stringify(content));
  return dir;
}

describe("quality scoring", () => {
  it("weights the PRD dimensions to 100", () => {
    expect(Object.values(dimensionWeights).reduce((sum, weight) => sum + weight, 0)).toBe(100);
  });

  it("renormalises when the deck has no reference, so a no-reference deck is not capped at 90", () => {
    const report = scoreDeck(noReference, runDirWith("clean", {}), { scores: perfectScores });
    expect(report.qualityScore).toBe(100);
    expect(report.weights.referenceGrammarFit).toBeUndefined();
    // Reported weights are rounded to 2dp for readability; the score itself uses the exact values.
    expect(Object.values(report.weights).reduce((sum, weight) => sum + (weight ?? 0), 0)).toBeCloseTo(100, 1);
  });

  it("counts referenceGrammarFit at its declared weight when the deck cites a reference", () => {
    const report = scoreDeck(withReference, runDirWith("ref", {}), { scores: { ...perfectScores, referenceGrammarFit: 0 } });
    expect(report.weights.referenceGrammarFit).toBe(10);
    expect(report.qualityScore).toBe(90);
  });

  it("rejects a dimension the rubric does not define", () => {
    expect(() => scoreDeck(noReference, runDir, { scores: { ...perfectScores, vibes: 100 } })).toThrow(/validation/);
  });

  it("rejects a missing dimension rather than scoring it as zero", () => {
    const { antiSlop, ...incomplete } = perfectScores;
    expect(() => scoreDeck(noReference, runDir, { scores: incomplete })).toThrow(/missing required dimensions: antiSlop/);
  });

  it("rejects referenceGrammarFit on a deck that declares no reference", () => {
    expect(() => scoreDeck(noReference, runDir, { scores: { ...perfectScores, referenceGrammarFit: 80 } })).toThrow(/declares no referenceIds/);
  });

  it("rejects a score outside 0-100", () => {
    expect(() => scoreDeck(noReference, runDir, { scores: { ...perfectScores, antiSlop: 140 } })).toThrow(/validation/);
  });

  // A deck that misencodes its data is not a 100 with a footnote.
  it("fails on a hard finding regardless of the aggregate", () => {
    const dir = runDirWith("hard", {
      "qa.json": { findings: [{ severity: "hard", code: "MISLEADING_QUANTITATIVE_ENCODING", slideId: "S07", message: "x" }] },
    });
    const report = scoreDeck(noReference, dir, { scores: perfectScores });
    expect(report.status).toBe("fail");
    expect(report.qualityScore).toBe(100);
    expect(report.hardFailureCodes).toEqual(["MISLEADING_QUANTITATIVE_ENCODING"]);
  });

  it("collects hard findings from visual QA as well as core QA", () => {
    const dir = runDirWith("both", {
      "qa.json": { findings: [{ severity: "risk", code: "TEXT_WRAP_RISK", message: "x" }] },
      "visual-qa.json": { findings: [{ severity: "hard", code: "CHART_UNREADABLE", message: "x" }] },
    });
    expect(scoreDeck(noReference, dir, { scores: perfectScores }).hardFailureCodes).toEqual(["CHART_UNREADABLE"]);
  });
});

describe("regression history", () => {
  it("refuses to record quality without its cost context", () => {
    const dir = runDirWith("no-tokens", { "quality.json": { qualityScore: 80, hardFailures: 0, hardFailureCodes: [], dimensions: {} } });
    expect(() => recordRun({ deck: noReference, runDir: dir, benchmark: "demo", version: "v1", projectDir: runDir })).toThrow(/tokens.json is missing/);
  });

  it("appends one line carrying quality and tokens together", () => {
    const dir = runDirWith("record", {
      "quality.json": { status: "fail", qualityScore: 71.4, hardFailures: 2, hardFailureCodes: ["A", "B"], dimensions: { antiSlop: 91 } },
      "tokens.json": { tokenUsage: { total: { total: 70000, effective: 41000 } }, tokensPerSlide: 8750, repairOverhead: 0.12 },
    });
    const { record, historyPath } = recordRun({ deck: noReference, runDir: dir, benchmark: "demo", version: "pre-pr5", projectDir: runDir });
    expect(record).toMatchObject({ benchmark: "demo", version: "pre-pr5", tokens: 70000, effectiveTokens: 41000, qualityScore: 71.4, hardFailures: 2 });
    expect(fs.readFileSync(historyPath, "utf8").trim().split("\n")).toHaveLength(1);

    recordRun({ deck: noReference, runDir: dir, benchmark: "demo", version: "next", projectDir: runDir });
    expect(fs.readFileSync(historyPath, "utf8").trim().split("\n")).toHaveLength(2);
  });
});
