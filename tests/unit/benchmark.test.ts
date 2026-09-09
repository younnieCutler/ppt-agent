import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startBenchmarkRun, verifyBenchmarkRunBinding } from "../../src/benchmark";
import { evaluateBenchmarkRun } from "../../src/eval-gate";
import { contractSchema } from "../../src/schema";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(options: { source?: string; sourcePath?: string } = {}): { root: string; benchmark: string; fixtureDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-benchmark-"));
  roots.push(root);
  const benchmark = "demo-benchmark";
  const fixtureDir = path.join(root, "evals", "real-world", benchmark);
  fs.mkdirSync(path.join(fixtureDir, "source"), { recursive: true });
  const sourcePath = options.sourcePath ?? "source/input.md";
  if (!sourcePath.startsWith("..")) fs.writeFileSync(path.join(fixtureDir, sourcePath), options.source ?? "Grounded benchmark source.");
  fs.writeFileSync(path.join(fixtureDir, "task.yaml"), [
    `id: ${benchmark}`,
    "name: Demo benchmark",
    "domain: corporate",
    "referenceMode: none",
    "prompt: Build a grounded three-slide deck.",
    "contract:",
    "  purpose: internal",
    "  audience: Leadership",
    "  language: en",
    "  slideCount: 3",
    "  aspectRatio: '16:9'",
    "  presentationStyle: corporate",
    "  designDirection: balanced",
    "  storyline: [opening, evidence, closing]",
    "  brand:",
    "    kind: default",
    "  fonts:",
    "    heading: Arial",
    "    body: Arial",
    "sources:",
    `  - ${sourcePath}`,
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(fixtureDir, "policy.yaml"), [
    "version: 1",
    "identity:",
    "  requireBoundRun: true",
    "measurement:",
    "  requireMeasuredTokens: true",
    "budgets:",
    "  totalTokensExclusiveMax: 30000",
    "  hardFailuresMax: 0",
    "regression:",
    "  compareLatestRecorded: false",
    "  maxQualityScoreDrop: 0",
    "  maxQualityPer10kEffectiveTokensDrop: 0",
    "",
  ].join("\n"));
  return { root, benchmark, fixtureDir };
}

function writeMeasuredResult(runDir: string): void {
  fs.writeFileSync(path.join(runDir, "quality.json"), JSON.stringify({ qualityScore: 90, hardFailures: 0 }));
  fs.writeFileSync(path.join(runDir, "tokens.json"), JSON.stringify({
    measurement: "measured",
    tokenUsage: { total: { total: 20000, effective: 15000 } },
  }));
}

describe("bound real-world benchmark runs", () => {
  it("creates a fresh run whose contract and sources are bound to the fixture bytes", () => {
    const { root, benchmark } = fixture();
    const started = startBenchmarkRun(root, benchmark);
    expect(started.status).toBe("pass");
    expect(started.runDir).toContain(path.join(".ppt-agent", "runs"));
    expect(fs.existsSync(started.contextPath)).toBe(true);
    expect(fs.existsSync(started.bindingPath)).toBe(true);

    const contract = contractSchema.parse(JSON.parse(fs.readFileSync(started.contractPath, "utf8")));
    expect(contract.slideCount).toBe(3);
    expect(contract.sources).toHaveLength(1);
    expect(contract.sources[0]).toMatchObject({ kind: "file", id: "benchmark-source-01", type: "md" });
    expect(verifyBenchmarkRunBinding(root, started.runDir, benchmark)).toMatchObject({ status: "pass", errors: [] });
  });

  it("fails the binding after source bytes change", () => {
    const { root, benchmark, fixtureDir } = fixture();
    const started = startBenchmarkRun(root, benchmark);
    fs.appendFileSync(path.join(fixtureDir, "source", "input.md"), " changed");
    const check = verifyBenchmarkRunBinding(root, started.runDir, benchmark);
    expect(check.status).toBe("fail");
    expect(check.errors.join(" ")).toMatch(/Bound source changed/);
  });

  it("fails the binding after task or policy bytes change", () => {
    const first = fixture();
    const firstRun = startBenchmarkRun(first.root, first.benchmark);
    fs.appendFileSync(path.join(first.fixtureDir, "task.yaml"), "# changed\n");
    expect(verifyBenchmarkRunBinding(first.root, firstRun.runDir, first.benchmark).errors.join(" ")).toMatch(/task\.yaml changed/);

    const second = fixture();
    const secondRun = startBenchmarkRun(second.root, second.benchmark);
    fs.appendFileSync(path.join(second.fixtureDir, "policy.yaml"), "# changed\n");
    expect(verifyBenchmarkRunBinding(second.root, secondRun.runDir, second.benchmark).errors.join(" ")).toMatch(/policy\.yaml changed/);
  });

  it("surfaces identity drift as a hard eval-gate finding", () => {
    const { root, benchmark, fixtureDir } = fixture();
    const started = startBenchmarkRun(root, benchmark);
    writeMeasuredResult(started.runDir);
    expect(evaluateBenchmarkRun({ projectDir: root, runDir: started.runDir, benchmark }).status).toBe("pass");

    fs.appendFileSync(path.join(fixtureDir, "source", "input.md"), " changed after generation");
    const report = evaluateBenchmarkRun({ projectDir: root, runDir: started.runDir, benchmark });
    expect(report.status).toBe("fail");
    expect(report.findings.map((item) => item.code)).toContain("BENCHMARK_BINDING_INVALID");
  });

  it("rejects fixture source paths that escape the benchmark directory", () => {
    const { root, benchmark } = fixture({ sourcePath: "../outside.md" });
    fs.writeFileSync(path.join(root, "evals", "real-world", "outside.md"), "outside");
    expect(() => startBenchmarkRun(root, benchmark)).toThrow(/escapes its fixture directory/);
  });
});
