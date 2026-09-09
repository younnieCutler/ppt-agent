import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";

export const evalPolicySchema = z.object({
  version: z.literal(1),
  measurement: z.object({
    requireMeasuredTokens: z.boolean(),
  }).strict(),
  budgets: z.object({
    totalTokensExclusiveMax: z.number().int().positive().optional(),
    hardFailuresMax: z.number().int().nonnegative(),
  }).strict(),
  regression: z.object({
    compareLatestRecorded: z.boolean(),
    maxQualityScoreDrop: z.number().min(0),
    maxQualityPer10kEffectiveTokensDrop: z.number().min(0),
  }).strict(),
}).strict();

export type EvalPolicy = z.infer<typeof evalPolicySchema>;

export const evalGateFindingSeverity = {
  TOKEN_MEASUREMENT_UNAVAILABLE: "hard",
  TOTAL_TOKEN_BUDGET_EXCEEDED: "hard",
  HARD_FAILURE_BUDGET_EXCEEDED: "hard",
  QUALITY_SCORE_REGRESSION: "hard",
  QUALITY_EFFICIENCY_REGRESSION: "hard",
} as const;

export type EvalGateFindingCode = keyof typeof evalGateFindingSeverity;
export type EvalGateFinding = {
  severity: "hard";
  code: EvalGateFindingCode;
  message: string;
};

export type EvalGateMetrics = {
  qualityScore: number;
  hardFailures: number;
  totalTokens: number;
  effectiveTokens: number;
  qualityPer10kEffectiveTokens: number;
};

export type EvalGateBaseline = EvalGateMetrics & {
  version: string;
  date: string;
};

export type EvalGateReport = {
  status: "pass" | "fail" | "not_configured";
  benchmark: string;
  policyPath?: string;
  current?: EvalGateMetrics;
  baseline?: EvalGateBaseline;
  findings: EvalGateFinding[];
};

type QualityFile = {
  qualityScore: number;
  hardFailures: number;
};

type TokensFile = {
  measurement?: "measured" | "unavailable";
  tokenUsage: { total: { total: number; effective: number } };
};

type HistoryLine = {
  benchmark: string;
  version: string;
  date: string;
  tokens: number;
  effectiveTokens: number;
  qualityPer10kEffectiveTokens: number;
  qualityScore: number;
  hardFailures: number;
};

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8")) as T;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function policyPath(projectDir: string, benchmark: string): string {
  return path.join(path.resolve(projectDir), "evals", "real-world", benchmark, "policy.yaml");
}

function historyPath(projectDir: string, benchmark: string): string {
  return path.join(path.resolve(projectDir), "evals", "real-world", benchmark, "history.jsonl");
}

function latestHistoryRecord(projectDir: string, benchmark: string): HistoryLine | undefined {
  const filePath = historyPath(projectDir, benchmark);
  if (!fs.existsSync(filePath)) return undefined;
  const lines = fs.readFileSync(filePath, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[index]);
    } catch (error) {
      throw new Error(`Benchmark history is malformed at ${filePath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const entry = parsed as Partial<HistoryLine>;
    if (entry.benchmark !== benchmark) continue;
    if (typeof entry.version !== "string" || typeof entry.date !== "string" || typeof entry.tokens !== "number" || typeof entry.effectiveTokens !== "number" || typeof entry.qualityPer10kEffectiveTokens !== "number" || typeof entry.qualityScore !== "number" || typeof entry.hardFailures !== "number") {
      throw new Error(`Benchmark history has an invalid record at ${filePath}:${index + 1}.`);
    }
    return entry as HistoryLine;
  }
  return undefined;
}

function finding(code: EvalGateFindingCode, message: string): EvalGateFinding {
  return { severity: evalGateFindingSeverity[code], code, message };
}

export function loadEvalPolicy(projectDir: string, benchmark: string): { policy?: EvalPolicy; path: string } {
  const filePath = policyPath(projectDir, benchmark);
  if (!fs.existsSync(filePath)) return { path: filePath };
  const parsed = parseYaml(fs.readFileSync(filePath, "utf8"));
  return { policy: evalPolicySchema.parse(parsed), path: filePath };
}

export function evaluateBenchmarkRun(options: { projectDir: string; runDir: string; benchmark: string }): EvalGateReport {
  const { policy, path: configuredPolicyPath } = loadEvalPolicy(options.projectDir, options.benchmark);
  if (!policy) return { status: "not_configured", benchmark: options.benchmark, findings: [] };

  const runDir = path.resolve(options.runDir);
  const qualityPath = path.join(runDir, "quality.json");
  const tokensPath = path.join(runDir, "tokens.json");
  if (!fs.existsSync(qualityPath)) throw new Error(`Evaluation gate requires ${qualityPath}. Run \`score\` first.`);
  if (!fs.existsSync(tokensPath)) throw new Error(`Evaluation gate requires ${tokensPath}. Run \`tokens\` first.`);

  const quality = readJson<QualityFile>(qualityPath);
  const tokens = readJson<TokensFile>(tokensPath);
  if (!Number.isFinite(quality.qualityScore) || !Number.isFinite(quality.hardFailures)) throw new Error("quality.json does not contain finite qualityScore/hardFailures values.");
  const totalTokens = tokens.tokenUsage?.total?.total;
  const effectiveTokens = tokens.tokenUsage?.total?.effective;
  if (!Number.isFinite(totalTokens) || !Number.isFinite(effectiveTokens)) throw new Error("tokens.json does not contain finite total/effective token values.");

  const current: EvalGateMetrics = {
    qualityScore: quality.qualityScore,
    hardFailures: quality.hardFailures,
    totalTokens,
    effectiveTokens,
    qualityPer10kEffectiveTokens: effectiveTokens > 0 ? round(quality.qualityScore / (effectiveTokens / 10_000)) : 0,
  };
  const findings: EvalGateFinding[] = [];

  if (policy.measurement.requireMeasuredTokens && tokens.measurement !== "measured") {
    findings.push(finding("TOKEN_MEASUREMENT_UNAVAILABLE", "Token measurement is unavailable. A benchmark cannot pass with an unmeasured cost denominator."));
  }
  if (policy.budgets.totalTokensExclusiveMax !== undefined && current.totalTokens >= policy.budgets.totalTokensExclusiveMax) {
    findings.push(finding("TOTAL_TOKEN_BUDGET_EXCEEDED", `Total tokens must stay below ${policy.budgets.totalTokensExclusiveMax}; measured ${current.totalTokens}.`));
  }
  if (current.hardFailures > policy.budgets.hardFailuresMax) {
    findings.push(finding("HARD_FAILURE_BUDGET_EXCEEDED", `Hard failures must be <= ${policy.budgets.hardFailuresMax}; measured ${current.hardFailures}.`));
  }

  const previous = policy.regression.compareLatestRecorded ? latestHistoryRecord(options.projectDir, options.benchmark) : undefined;
  const baseline = previous ? {
    version: previous.version,
    date: previous.date,
    qualityScore: previous.qualityScore,
    hardFailures: previous.hardFailures,
    totalTokens: previous.tokens,
    effectiveTokens: previous.effectiveTokens,
    qualityPer10kEffectiveTokens: previous.qualityPer10kEffectiveTokens,
  } satisfies EvalGateBaseline : undefined;

  if (baseline && current.qualityScore < baseline.qualityScore - policy.regression.maxQualityScoreDrop) {
    findings.push(finding("QUALITY_SCORE_REGRESSION", `Quality score regressed from ${baseline.qualityScore} to ${current.qualityScore}; allowed drop is ${policy.regression.maxQualityScoreDrop}.`));
  }
  if (baseline && current.qualityPer10kEffectiveTokens < baseline.qualityPer10kEffectiveTokens - policy.regression.maxQualityPer10kEffectiveTokensDrop) {
    findings.push(finding("QUALITY_EFFICIENCY_REGRESSION", `Quality per 10k effective tokens regressed from ${baseline.qualityPer10kEffectiveTokens} to ${current.qualityPer10kEffectiveTokens}; allowed drop is ${policy.regression.maxQualityPer10kEffectiveTokensDrop}.`));
  }

  return {
    status: findings.length === 0 ? "pass" : "fail",
    benchmark: options.benchmark,
    policyPath: configuredPolicyPath,
    current,
    baseline,
    findings,
  };
}

export function writeEvalGateReport(options: { projectDir: string; runDir: string; benchmark: string }): EvalGateReport {
  const report = evaluateBenchmarkRun(options);
  const outputPath = path.join(path.resolve(options.runDir), "eval-gate.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  return report;
}

export function assertEvalGate(options: { projectDir: string; runDir: string; benchmark: string }): EvalGateReport {
  const report = writeEvalGateReport(options);
  if (report.status === "fail") {
    throw new Error(`Evaluation gate failed for '${options.benchmark}': ${report.findings.map((item) => item.code).join(", ")}. See ${path.join(path.resolve(options.runDir), "eval-gate.json")}.`);
  }
  return report;
}
