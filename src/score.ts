import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { QaFinding } from "./qa";
import type { DeckSpec } from "./schema";

// Quality scoring for the real-world eval set.
//
// Same trust model as visual-qa: the judgment layer supplies numbers, never weights and never
// severity. Weights live here so a run cannot quietly reweight itself into a better score, and a
// hard structural failure overrides the aggregate outright — a deck that misencodes its data is not
// an 84 with an asterisk.

/** PRD §10. Weights sum to 100. */
export const dimensionWeights = {
  contentFidelity: 20,
  narrativeQuality: 15,
  visualHierarchy: 15,
  semanticVisualization: 10,
  referenceGrammarFit: 10,
  layoutVariety: 10,
  typographyReadability: 10,
  purposeFit: 5,
  antiSlop: 5,
} as const;

export type Dimension = keyof typeof dimensionWeights;
export const dimensionNames = Object.keys(dimensionWeights) as Dimension[];

export const scoreInputSchema = z
  .object({
    scores: z.record(z.enum(dimensionNames as [Dimension, ...Dimension[]]), z.number().min(0).max(100)),
    notes: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type ScoreInput = z.infer<typeof scoreInputSchema>;

export type QualityReport = {
  status: "pass" | "fail";
  qualityScore: number;
  hardFailures: number;
  hardFailureCodes: string[];
  /** Dimensions actually counted, with the weights used after any renormalisation. */
  weights: Partial<Record<Dimension, number>>;
  dimensions: Partial<Record<Dimension, number>>;
  notes?: Record<string, string>;
};

function readFindings(filePath: string): QaFinding[] {
  if (!fs.existsSync(filePath)) return [];
  const report = JSON.parse(fs.readFileSync(filePath, "utf8")) as { findings?: QaFinding[] };
  return report.findings ?? [];
}

export function scoreDeck(deck: DeckSpec, runDir: string, rawScores: unknown): QualityReport {
  const parsed = scoreInputSchema.safeParse(rawScores);
  if (!parsed.success) {
    throw new Error(`scores file failed schema validation: ${parsed.error.message}`);
  }

  // A deck generated with no reference cannot earn referenceGrammarFit, so scoring it against the
  // full 100 would cap every no-reference deck at 90. The PRD requires the no-reference path to stay
  // first-class, so the weight is redistributed across the remaining dimensions instead.
  const hasReference = (deck.contract.referenceIds ?? []).length > 0;
  const counted = dimensionNames.filter((name) => hasReference || name !== "referenceGrammarFit");

  const missing = counted.filter((name) => parsed.data.scores[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`scores file is missing required dimensions: ${missing.join(", ")}.`);
  }
  if (!hasReference && parsed.data.scores.referenceGrammarFit !== undefined) {
    throw new Error("referenceGrammarFit was scored, but this deck's contract declares no referenceIds. Remove it.");
  }

  const declaredTotal = counted.reduce((sum, name) => sum + dimensionWeights[name], 0);
  const weights: Partial<Record<Dimension, number>> = {};
  const dimensions: Partial<Record<Dimension, number>> = {};
  let weighted = 0;
  for (const name of counted) {
    const weight = (dimensionWeights[name] / declaredTotal) * 100;
    weights[name] = Math.round(weight * 100) / 100;
    dimensions[name] = parsed.data.scores[name]!;
    weighted += parsed.data.scores[name]! * weight;
  }

  const hard = [...readFindings(path.join(path.resolve(runDir), "qa.json")), ...readFindings(path.join(path.resolve(runDir), "visual-qa.json"))]
    .filter((finding) => finding.severity === "hard");

  return {
    status: hard.length > 0 ? "fail" : "pass",
    qualityScore: Math.round((weighted / 100) * 10) / 10,
    hardFailures: hard.length,
    hardFailureCodes: [...new Set(hard.map((finding) => finding.code))].sort(),
    weights,
    dimensions,
    ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
  };
}

export function writeQualityReport(deck: DeckSpec, runDir: string, rawScores: unknown): QualityReport {
  const report = scoreDeck(deck, runDir, rawScores);
  fs.mkdirSync(path.resolve(runDir), { recursive: true });
  fs.writeFileSync(path.join(path.resolve(runDir), "quality.json"), JSON.stringify(report, null, 2));
  return report;
}

export type HistoryRecord = {
  benchmark: string;
  version: string;
  date: string;
  slides: number;
  tokens: number;
  effectiveTokens: number;
  tokensPerSlide: number;
  /** PRD §15's per-slide targets are read against effective tokens, so history carries both. */
  effectiveTokensPerSlide: number;
  /** PRD §14. Quality is never comparable across versions without its cost denominator. */
  qualityPer10kEffectiveTokens: number;
  repairOverhead: number;
  qualityScore: number;
  hardFailures: number;
  hardFailureCodes: string[];
  dimensions: Partial<Record<Dimension, number>>;
};

/** Appends one quality-regression line to `evals/real-world/<benchmark>/history.jsonl`. */
export function recordRun(options: {
  deck: DeckSpec;
  runDir: string;
  benchmark: string;
  version: string;
  projectDir: string;
}): { record: HistoryRecord; historyPath: string } {
  const resolved = path.resolve(options.runDir);
  const quality = JSON.parse(fs.readFileSync(path.join(resolved, "quality.json"), "utf8")) as QualityReport;
  const tokensPath = path.join(resolved, "tokens.json");
  if (!fs.existsSync(tokensPath)) {
    throw new Error("tokens.json is missing from the run directory. Quality is never recorded without its cost context — run `tokens` first.");
  }
  const tokens = JSON.parse(fs.readFileSync(tokensPath, "utf8")) as {
    measurement?: "measured" | "unavailable";
    tokenUsage: { total: { total: number; effective: number } };
    tokensPerSlide: number | null;
    effectiveTokensPerSlide?: number | null;
    repairOverhead: number | null;
  };
  // A quality score recorded against an unmeasured 0-token run reads as "free," which is exactly
  // the misleading result this field exists to prevent — refuse to merge it rather than record it.
  if (tokens.measurement === "unavailable") {
    throw new Error("tokens.json reports measurement: \"unavailable\" — token telemetry failed for this run. Fix transcript attribution (--transcript/--session-id) and re-run `tokens` before recording.");
  }

  const effective = tokens.tokenUsage.total.effective;
  const round = (value: number): number => Math.round(value * 100) / 100;

  const record: HistoryRecord = {
    benchmark: options.benchmark,
    version: options.version,
    date: new Date().toISOString().slice(0, 10),
    slides: options.deck.slides.length,
    tokens: tokens.tokenUsage.total.total,
    effectiveTokens: effective,
    // Non-null: the `measurement === "unavailable"` guard above already returned before this
    // point whenever tokens.json's per-slide ratios could be null.
    tokensPerSlide: tokens.tokensPerSlide ?? round(tokens.tokenUsage.total.total / Math.max(1, options.deck.slides.length)),
    effectiveTokensPerSlide: tokens.effectiveTokensPerSlide ?? round(effective / Math.max(1, options.deck.slides.length)),
    // A quality score that rose while cost rose faster is not an improvement. Dividing here keeps
    // the two numbers from being read apart in the history file.
    qualityPer10kEffectiveTokens: effective > 0 ? round(quality.qualityScore / (effective / 10_000)) : 0,
    repairOverhead: tokens.repairOverhead ?? 0,
    qualityScore: quality.qualityScore,
    hardFailures: quality.hardFailures,
    hardFailureCodes: quality.hardFailureCodes,
    dimensions: quality.dimensions,
  };

  const historyPath = path.join(options.projectDir, "evals", "real-world", options.benchmark, "history.jsonl");
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.appendFileSync(historyPath, `${JSON.stringify(record)}\n`);
  return { record, historyPath };
}
