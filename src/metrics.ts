import fs from "node:fs";
import path from "node:path";
import type { QaFinding } from "./qa";
import type { DeckSpec } from "./schema";

export type Ratio = { numerator: number; denominator: number };

export type P3Metrics = {
  themeId?: string;
  designDirection?: string;
  metrics: {
    brandViolation: Ratio;
    archetypeFit: Ratio;
    chartPaletteViolation: Ratio;
    layoutRepetition: Ratio;
    visualQaFailure: Ratio;
    repairSuccess: Ratio;
    resolutionFailure: Ratio;
    /** Estimated model tokens in style-context.json against the P3 1,000-token budget. */
    contextTokens: Ratio;
  };
};

const brandCodes = new Set(["BRAND_COLOR_VIOLATION", "BRAND_FONT_VIOLATION", "FONT_SUBSTITUTION", "FONT_CONTRACT_DRIFT", "GRADIENT_FILL_FORBIDDEN"]);
const chartPaletteCodes = new Set(["THEME_DATA_COLOR_VIOLATION"]);
const archetypeCodes = new Set(["ARCHETYPE_DENSITY_MISMATCH", "ARCHETYPE_HIERARCHY_MISMATCH", "ARCHETYPE_VISUAL_WEIGHT_MISMATCH"]);
const repetitionCodes = new Set(["REPEATED_LAYOUT_RUN", "REPEATED_COMPOSITION_RUN", "DOMINANT_LAYOUT", "DOMINANT_COMPOSITION", "LAYOUT_REPETITION", "REPEATED_THREE_COLUMN_PATTERN"]);

// A deck-level finding carries no slideId, so it counts against every slide: "this deck repeats
// its layout" is a whole-deck violation, not a zero-slide one.
function slideRatio(findings: QaFinding[], codes: Set<string>, slideCount: number): Ratio {
  const matched = findings.filter((finding) => codes.has(finding.code));
  if (matched.some((finding) => !finding.slideId)) return { numerator: slideCount, denominator: slideCount };
  return { numerator: new Set(matched.map((finding) => finding.slideId)).size, denominator: slideCount };
}

function readJsonIfExists<T>(filePath: string): T | undefined {
  return fs.existsSync(filePath) ? (JSON.parse(fs.readFileSync(filePath, "utf8")) as T) : undefined;
}

export function buildP3Metrics(deck: DeckSpec, runDir: string): P3Metrics {
  const resolved = path.resolve(runDir);
  const slideCount = deck.slides.length;
  const qa = readJsonIfExists<{ findings?: QaFinding[] }>(path.join(resolved, "qa.json"));
  const visual = readJsonIfExists<{ findings?: QaFinding[] }>(path.join(resolved, "visual-qa.json"));
  const style = readJsonIfExists<{ themeId?: string; designDirection?: string }>(path.join(resolved, "resolved-style.json"));
  const repair = readJsonIfExists<{ slides?: Record<string, { status: string }> }>(path.join(resolved, "repair-state.json"));
  const contextPath = path.join(resolved, "style-context.json");
  const findings = [...(qa?.findings ?? []), ...(visual?.findings ?? [])];
  const repairSlides = Object.values(repair?.slides ?? {});

  return {
    themeId: style?.themeId,
    designDirection: style?.designDirection,
    metrics: {
      brandViolation: slideRatio(findings, brandCodes, slideCount),
      // Fit is the positive metric: slides that drew no archetype mismatch.
      archetypeFit: { numerator: slideCount - slideRatio(findings, archetypeCodes, slideCount).numerator, denominator: slideCount },
      chartPaletteViolation: slideRatio(findings, chartPaletteCodes, slideCount),
      layoutRepetition: slideRatio(findings, repetitionCodes, slideCount),
      visualQaFailure: {
        numerator: new Set((visual?.findings ?? []).filter((finding) => finding.severity !== "warning" && finding.slideId).map((finding) => finding.slideId)).size,
        denominator: slideCount,
      },
      repairSuccess: { numerator: repairSlides.filter((entry) => entry.status === "resolved").length, denominator: repairSlides.length },
      resolutionFailure: { numerator: style ? 0 : 1, denominator: 1 },
      contextTokens: { numerator: fs.existsSync(contextPath) ? Math.ceil(fs.statSync(contextPath).size / 4) : 0, denominator: 1000 },
    },
  };
}

export function writeP3Metrics(deck: DeckSpec, runDir: string): P3Metrics {
  const metrics = buildP3Metrics(deck, runDir);
  fs.mkdirSync(path.resolve(runDir), { recursive: true });
  fs.writeFileSync(path.join(path.resolve(runDir), "p3-metrics.json"), JSON.stringify(metrics, null, 2));
  return metrics;
}
