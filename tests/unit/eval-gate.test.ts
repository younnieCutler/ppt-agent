import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateBenchmarkRun, writeEvalGateReport } from "../../src/eval-gate";
import { recordRun } from "../../src/score";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-eval-gate-"));
const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/all-layouts.json"), "utf8"));
const deck = { ...fixture, contract: { ...fixture.contract, referenceIds: undefined } };

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function benchmarkDir(benchmark: string): string {
  const dir = path.join(root, "evals", "real-world", benchmark);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writePolicy(benchmark: string): void {
  fs.writeFileSync(path.join(benchmarkDir(benchmark), "policy.yaml"), [
    "version: 1",
    "measurement:",
    "  requireMeasuredTokens: true",
    "budgets:",
    "  totalTokensExclusiveMax: 30000",
    "  hardFailuresMax: 0",
    "regression:",
    "  compareLatestRecorded: true",
    "  maxQualityScoreDrop: 0",
    "  maxQualityPer10kEffectiveTokensDrop: 0",
    "",
  ].join("\n"));
}

function writeRun(name: string, options: { quality?: number; hardFailures?: number; total?: number; effective?: number; measurement?: "measured" | "unavailable" } = {}): string {
  const dir = path.join(root, "runs", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "quality.json"), JSON.stringify({
    status: (options.hardFailures ?? 0) > 0 ? "fail" : "pass",
    qualityScore: options.quality ?? 90,
    hardFailures: options.hardFailures ?? 0,
    hardFailureCodes: [],
    dimensions: {},
  }));
  fs.writeFileSync(path.join(dir, "tokens.json"), JSON.stringify({
    measurement: options.measurement ?? "measured",
    tokenUsage: { total: { total: options.total ?? 20000, effective: options.effective ?? 15000 } },
    tokensPerSlide: 2500,
    effectiveTokensPerSlide: 1875,
    repairOverhead: 0,
  }));
  return dir;
}

function history(benchmark: string, entry: Record<string, unknown>): void {
  fs.writeFileSync(path.join(benchmarkDir(benchmark), "history.jsonl"), `${JSON.stringify({
    benchmark,
    version: "v1",
    date: "2026-09-01",
    tokens: 20000,
    effectiveTokens: 20000,
    qualityPer10kEffectiveTokens: 45,
    qualityScore: 90,
    hardFailures: 0,
    ...entry,
  })}\n`);
}

describe("benchmark evaluation gate", () => {
  it("is a no-op for benchmarks that did not opt into a policy", () => {
    const report = evaluateBenchmarkRun({ projectDir: root, runDir: writeRun("no-policy"), benchmark: "unconfigured" });
    expect(report.status).toBe("not_configured");
    expect(report.findings).toEqual([]);
  });

  it("passes a measured run below the benchmark token budget", () => {
    writePolicy("pass");
    const report = writeEvalGateReport({ projectDir: root, runDir: writeRun("pass"), benchmark: "pass" });
    expect(report.status).toBe("pass");
    expect(report.current).toMatchObject({ qualityScore: 90, totalTokens: 20000, effectiveTokens: 15000 });
    expect(fs.existsSync(path.join(root, "runs", "pass", "eval-gate.json"))).toBe(true);
  });

  it("treats PRD §15's <30k target as exclusive for the opted-in fixture", () => {
    writePolicy("budget");
    const report = evaluateBenchmarkRun({ projectDir: root, runDir: writeRun("budget", { total: 30000 }), benchmark: "budget" });
    expect(report.status).toBe("fail");
    expect(report.findings.map((item) => item.code)).toContain("TOTAL_TOKEN_BUDGET_EXCEEDED");
  });

  it("refuses an unmeasured token denominator", () => {
    writePolicy("unmeasured");
    const report = evaluateBenchmarkRun({ projectDir: root, runDir: writeRun("unmeasured", { measurement: "unavailable" }), benchmark: "unmeasured" });
    expect(report.findings.map((item) => item.code)).toContain("TOKEN_MEASUREMENT_UNAVAILABLE");
  });

  it("blocks quality regression against the latest recorded run even when efficiency improved", () => {
    writePolicy("quality-regression");
    history("quality-regression", {});
    const report = evaluateBenchmarkRun({ projectDir: root, runDir: writeRun("quality-regression", { quality: 89, effective: 15000 }), benchmark: "quality-regression" });
    const codes = report.findings.map((item) => item.code);
    expect(codes).toContain("QUALITY_SCORE_REGRESSION");
    expect(codes).not.toContain("QUALITY_EFFICIENCY_REGRESSION");
  });

  it("blocks quality-per-token regression even when raw quality stayed flat", () => {
    writePolicy("efficiency-regression");
    history("efficiency-regression", {});
    const report = evaluateBenchmarkRun({ projectDir: root, runDir: writeRun("efficiency-regression", { quality: 90, effective: 25000 }), benchmark: "efficiency-regression" });
    expect(report.findings.map((item) => item.code)).toContain("QUALITY_EFFICIENCY_REGRESSION");
  });

  it("recomputes the gate inside recordRun and never appends a failing run", () => {
    const benchmark = "record-block";
    writePolicy(benchmark);
    const historyPath = path.join(benchmarkDir(benchmark), "history.jsonl");
    fs.writeFileSync(historyPath, "");
    const runDir = writeRun("record-block", { total: 30000 });
    expect(() => recordRun({ deck, runDir, benchmark, version: "v2", projectDir: root })).toThrow(/Evaluation gate failed/);
    expect(fs.readFileSync(historyPath, "utf8")).toBe("");
    expect(JSON.parse(fs.readFileSync(path.join(runDir, "eval-gate.json"), "utf8")).status).toBe("fail");
  });
});
