import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { renderDeck } from "../../src/renderer";
import { assertFontsInstalled } from "../../src/fonts";
import { structuralQa } from "../../src/qa";
import { recordRun, scoreDeck, writeQualityReport } from "../../src/score";

// The pre-PR5 `AI WEEKLY UPDATE` deck, held as the first real-world regression baseline. Its job is
// to keep failing: every finding asserted here is a defect the PRD names, and a version that stops
// detecting one of them has regressed, whatever its unit-test count says.
const fixtureDir = path.resolve(__dirname, "../../evals/real-world/jp-ai-weekly-update");
const deck = JSON.parse(fs.readFileSync(path.join(fixtureDir, "baseline/deck.json"), "utf8"));
const contentModel = JSON.parse(fs.readFileSync(path.join(fixtureDir, "baseline/content-model.json"), "utf8"));
const rubric = parse(fs.readFileSync(path.join(fixtureDir, "rubric.yaml"), "utf8")) as {
  knownFindings: Array<{ code: string; severity: string; detector: string; reproducedInFixture?: boolean }>;
};

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-jp-baseline-"));
afterAll(() => fs.rmSync(runDir, { recursive: true, force: true }));

const report = structuralQa(deck, process.cwd(), contentModel);
const codes = new Set(report.findings.map((finding) => finding.code));

describe("jp-ai-weekly-update regression baseline", () => {
  it("keeps the baseline artifacts under version control", () => {
    expect(fs.existsSync(path.join(fixtureDir, "baseline/pre-pr5.pdf"))).toBe(true);
    expect(fs.existsSync(path.join(fixtureDir, "baseline/pre-pr5.pptx"))).toBe(true);
  });

  // Rendering needs the deck's Japanese typeface installed; the structural findings below do not.
  // Skipping here keeps the regression assertions running on machines without Meiryo.
  const fontAvailable = (() => {
    try { assertFontsInstalled(deck.contract.fonts); return true; } catch { return false; }
  })();

  it.skipIf(!fontAvailable)("still renders — the deck is semantically wrong, not structurally broken", async () => {
    const pptxPath = path.join(runDir, "baseline.pptx");
    await expect(renderDeck(deck, pptxPath, process.cwd(), { contentModel })).resolves.toMatchObject({ outputPath: pptxPath });
  });

  it("detects every structural finding the rubric says this baseline carries", () => {
    const expected = rubric.knownFindings.filter((finding) => finding.detector === "structural" && finding.reproducedInFixture !== false);
    expect(expected.length).toBeGreaterThan(0);
    for (const finding of expected) expect([...codes]).toContain(finding.code);
  });

  it("hard-fails on the misleading quantitative encoding, so the deck can never be released", () => {
    const misleading = report.findings.filter((finding) => finding.code === "MISLEADING_QUANTITATIVE_ENCODING");
    expect(misleading).toHaveLength(1);
    expect(misleading[0]).toMatchObject({ severity: "hard", slideId: "S05" });
    expect(report.status).toBe("fail");
  });

  it("measures the Japanese headlines at their rendered width, not their codepoint count", () => {
    const overlong = report.findings.filter((finding) => finding.code === "TEXT_WRAP_RISK" && finding.message.startsWith("Headline"));
    expect(overlong.map((finding) => finding.slideId)).toEqual(["S02", "S03", "S07"]);
    // Every one of these headlines is under 64 codepoints; only column measurement catches them.
    for (const finding of overlong) {
      expect(deck.slides.find((slide: { id: string }) => slide.id === finding.slideId).headline.length).toBeLessThan(64);
    }
  });

  it("records quality alongside its cost, and refuses to call a hard failure a pass", () => {
    fs.writeFileSync(path.join(runDir, "qa.json"), JSON.stringify(report));
    fs.writeFileSync(path.join(runDir, "tokens.json"), JSON.stringify({
      tokenUsage: { total: { total: 70000, effective: 52000 } },
      tokensPerSlide: 8750,
      repairOverhead: 0,
    }));
    const quality = writeQualityReport(deck, runDir, {
      scores: {
        contentFidelity: 88, narrativeQuality: 82, visualHierarchy: 58, semanticVisualization: 44,
        layoutVariety: 51, typographyReadability: 47, purposeFit: 70, antiSlop: 74,
      },
    });
    expect(quality.status).toBe("fail");
    expect(quality.hardFailureCodes).toContain("MISLEADING_QUANTITATIVE_ENCODING");

    const { record } = recordRun({ deck, runDir, benchmark: "jp-ai-weekly-update", version: "pre-pr5-test", projectDir: runDir });
    expect(record).toMatchObject({ slides: 8, tokens: 70000, tokensPerSlide: 8750, hardFailures: 1 });
    expect(record.qualityScore).toBe(quality.qualityScore);
  });

  it("does not let the judgment layer score a reference dimension this task has no reference for", () => {
    expect(() => scoreDeck(deck, runDir, { scores: { referenceGrammarFit: 90 } })).toThrow();
  });
});
