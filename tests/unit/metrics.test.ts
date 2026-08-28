import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildP3Metrics } from "../../src/metrics";
import { deckSchema } from "../../src/schema";

const fixture = deckSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/all-layouts.json"), "utf8")));

function runDirWith(files: Record<string, unknown>): string {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-metrics-"));
  Object.entries(files).forEach(([name, value]) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value)));
  return runDir;
}

describe("p3-metrics", () => {
  it("reports a clean run as zero violations against the full slide denominator", () => {
    const runDir = runDirWith({
      "qa.json": { findings: [] },
      "visual-qa.json": { findings: [] },
      "resolved-style.json": { themeId: "analytical", designDirection: "dense" },
      "style-context.json": { themeId: "analytical" },
    });
    const metrics = buildP3Metrics(fixture, runDir);
    expect(metrics.themeId).toBe("analytical");
    expect(metrics.metrics.brandViolation).toEqual({ numerator: 0, denominator: fixture.slides.length });
    expect(metrics.metrics.archetypeFit).toEqual({ numerator: fixture.slides.length, denominator: fixture.slides.length });
    expect(metrics.metrics.resolutionFailure).toEqual({ numerator: 0, denominator: 1 });
    expect(metrics.metrics.contextTokens.numerator).toBeLessThan(1000);
  });

  it("counts violating slides, charges a deck-level finding to the whole deck, and tracks repair outcomes", () => {
    const slideId = fixture.slides[1].id;
    const runDir = runDirWith({
      "qa.json": {
        findings: [
          { severity: "hard", code: "FONT_SUBSTITUTION", slideId, message: "" },
          { severity: "risk", code: "DOMINANT_LAYOUT", message: "" },
        ],
      },
      "visual-qa.json": { findings: [{ severity: "risk", code: "ARCHETYPE_DENSITY_MISMATCH", slideId, message: "" }] },
      "repair-state.json": { attempts: 2, slides: { [slideId]: { attempts: 1, lastFindings: [], status: "resolved" }, S03: { attempts: 2, lastFindings: [], status: "blocked" } } },
    });
    const metrics = buildP3Metrics(fixture, runDir);
    expect(metrics.metrics.brandViolation).toEqual({ numerator: 1, denominator: fixture.slides.length });
    expect(metrics.metrics.layoutRepetition).toEqual({ numerator: fixture.slides.length, denominator: fixture.slides.length });
    expect(metrics.metrics.archetypeFit.numerator).toBe(fixture.slides.length - 1);
    expect(metrics.metrics.visualQaFailure).toEqual({ numerator: 1, denominator: fixture.slides.length });
    expect(metrics.metrics.repairSuccess).toEqual({ numerator: 1, denominator: 2 });
    // No resolved-style.json: the run never got a deterministic style resolution.
    expect(metrics.metrics.resolutionFailure).toEqual({ numerator: 1, denominator: 1 });
  });
});
