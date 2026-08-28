import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildTokenReport, markPhase, projectSlug, readTurns } from "../../src/tokens";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-tokens-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const base = Date.parse("2026-08-28T10:00:00.000Z");
const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString();

function turn(minutes: number, output: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: at(minutes),
    ...extra,
    message: {
      role: "assistant",
      usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: output },
    },
  });
}

/** A run directory whose artifact mtimes place the phase boundaries at known minute offsets. */
function makeRun(name: string, artifacts: Record<string, number>): string {
  const runDir = path.join(root, name);
  fs.mkdirSync(runDir, { recursive: true });
  for (const [file, minutes] of Object.entries(artifacts)) {
    const target = path.join(runDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{}");
    fs.utimesSync(target, new Date(base + minutes * 60_000), new Date(base + minutes * 60_000));
  }
  fs.utimesSync(runDir, new Date(base), new Date(base));
  return runDir;
}

function makeTranscript(name: string, lines: string[]): string {
  const file = path.join(root, `${name}.jsonl`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

describe("transcript parsing", () => {
  it("derives the Claude Code project directory slug from the project path", () => {
    expect(projectSlug("C:\\Users\\dev\\Documents\\ppt-agent")).toBe("C--Users-dev-Documents-ppt-agent");
    expect(projectSlug("/home/dev/ppt-agent")).toBe("-home-dev-ppt-agent");
  });

  it("reads usage from assistant turns and ignores everything else", () => {
    const transcript = makeTranscript("mixed", [
      turn(1, 500),
      JSON.stringify({ type: "user", timestamp: at(2), message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "summary", leafUuid: "x" }),
      "{ not json",
      "",
    ]);
    const turns = readTurns(transcript);
    expect(turns).toHaveLength(1);
    expect(turns[0].usage).toMatchObject({ input: 10, cacheCreation: 100, cacheRead: 1000, output: 500 });
  });

  it("separates total from effective by exactly the cache-read sum", () => {
    const transcript = makeTranscript("cache", [turn(1, 500), turn(2, 300)]);
    const report = buildTokenReport({ runDir: makeRun("cache", {}), transcriptPath: transcript, slides: 8, since: base, until: base + 60 * 60_000 });
    expect(report.tokenUsage.total.total - report.tokenUsage.total.effective).toBe(2000);
    expect(report.tokenUsage.total.turns).toBe(2);
  });
});

describe("phase attribution", () => {
  const artifacts = {
    "content-model.json": 10,
    "style-context.json": 20,
    "visual-qa.json": 40,
    "repair/S04/context.json": 50,
  };

  it("assigns each turn to the phase whose artifact window contains it", () => {
    const transcript = makeTranscript("phases", [turn(5, 100), turn(15, 200), turn(30, 400), turn(45, 800), turn(55, 1600)]);
    const report = buildTokenReport({ runDir: makeRun("phases", artifacts), transcriptPath: transcript, slides: 8, since: base });
    const outputOf = (phase: keyof typeof report.tokenUsage.phases) => report.tokenUsage.phases[phase].output;
    expect(outputOf("sourceUnderstanding")).toBe(100);
    expect(outputOf("styleResolution")).toBe(200);
    expect(outputOf("visualJudgment")).toBe(400);
    // turn(55) falls outside the window: generation ended at the last boundary, minute 50.
    expect(outputOf("repair")).toBe(800);
    expect(report.tokenUsage.total.turns).toBe(4);
    expect(report.attribution).toBe("artifact-mtime-window");
  });

  it("excludes turns that predate the run directory", () => {
    const transcript = makeTranscript("before", [turn(-30, 9999), turn(5, 100)]);
    const report = buildTokenReport({ runDir: makeRun("before", artifacts), transcriptPath: transcript, slides: 8, since: base });
    expect(report.tokenUsage.total.output).toBe(100);
  });

  it("reports sidechain cost separately rather than hiding it", () => {
    const transcript = makeTranscript("sidechain", [turn(5, 100), turn(6, 700, { isSidechain: true })]);
    const report = buildTokenReport({ runDir: makeRun("sidechain", artifacts), transcriptPath: transcript, slides: 8, since: base });
    expect(report.tokenUsage.total.output).toBe(800);
    expect(report.tokenUsage.sidechain.output).toBe(700);
  });

  it("does not report repair overhead on a run that never repaired anything", () => {
    const runDir = makeRun("no-repair", { "content-model.json": 10, "style-context.json": 20 });
    const transcript = makeTranscript("no-repair", [turn(5, 100), turn(30, 400)]);
    const report = buildTokenReport({ runDir, transcriptPath: transcript, slides: 8, since: base, until: base + 60 * 60_000 });
    // Past the last boundary (styleResolution) the run is authoring compositions, not repairing.
    expect(report.tokenUsage.phases.compositionAuthoring.output).toBe(400);
    expect(report.tokenUsage.phases.repair.output).toBe(0);
    expect(report.repairOverhead).toBe(0);
  });

  it("computes repair overhead as a share of total", () => {
    const transcript = makeTranscript("overhead", [turn(5, 100), turn(45, 100)]);
    const report = buildTokenReport({ runDir: makeRun("overhead", artifacts), transcriptPath: transcript, slides: 8, since: base });
    expect(report.repairOverhead).toBeCloseTo(0.5, 2);
  });

  // `repair` is the last phase in the pipeline, so a naive successor rule sweeps everything after
  // Visual QA into it and reports 100% repair overhead on a run that repaired nothing.
  it("keeps repair overhead at zero when Visual QA ran but no repair followed", () => {
    const runDir = makeRun("visual-no-repair", {
      "content-model.json": 10,
      "style-context.json": 20,
      "visual-qa.json": 40,
      // deliberately no repair/<slide>/context.json
    });
    const transcript = makeTranscript("visual-no-repair", [turn(30, 400), turn(45, 900), turn(50, 300)]);
    const report = buildTokenReport({ runDir, transcriptPath: transcript, slides: 8, since: base, until: base + 60 * 60_000 });
    expect(report.tokenUsage.phases.repair.output).toBe(0);
    expect(report.repairOverhead).toBe(0);
    expect(report.tokenUsage.phases.visualJudgment.output).toBe(400 + 900 + 300);
  });
});

describe("measurement window", () => {
  it("closes at the last phase boundary, so later unrelated work is not billed to this deck", () => {
    const runDir = makeRun("window", { "content-model.json": 10, "visual-qa.json": 40 });
    // The last two turns are the user doing something else in the same session afterwards.
    const transcript = makeTranscript("window", [turn(20, 100), turn(35, 200), turn(90, 50_000), turn(120, 50_000)]);
    const report = buildTokenReport({ runDir, transcriptPath: transcript, slides: 8, since: base });
    expect(report.tokenUsage.total.output).toBe(300);
    expect(report.window.closedBy).toBe("last-phase-boundary");
    expect(Date.parse(report.window.to)).toBe(base + 40 * 60_000);
  });

  it("accepts an explicit end", () => {
    const runDir = makeRun("explicit-window", { "content-model.json": 10, "visual-qa.json": 40 });
    const transcript = makeTranscript("explicit-window", [turn(20, 100), turn(90, 900)]);
    const report = buildTokenReport({ runDir, transcriptPath: transcript, slides: 8, since: base, until: base + 100 * 60_000 });
    expect(report.tokenUsage.total.output).toBe(1000);
    expect(report.window.closedBy).toBe("explicit");
  });
});

describe("recorded phase markers", () => {
  it("prefers recorded boundaries over artifact mtimes and says so", () => {
    const runDir = makeRun("markers", { "content-model.json": 10 });
    markPhase(runDir, "styleResolution", base + 20 * 60_000);
    markPhase(runDir, "visualJudgment", base + 40 * 60_000);
    const transcript = makeTranscript("markers", [turn(15, 100), turn(30, 200)]);
    const report = buildTokenReport({ runDir, transcriptPath: transcript, slides: 8, since: base });
    expect(report.attribution).toBe("mixed"); // content-model.json has no marker; it is inferred
    expect(report.tokenUsage.phases.styleResolution.output).toBe(100);
    expect(report.tokenUsage.phases.visualJudgment.output).toBe(200);
  });

  // The real repair flow is: repair-context writes the brief, the model authors a replacement, then
  // repair-apply lands it. Marking only at repair-context would close the window before any
  // authoring happened, and drop the entire cost of the repair from the report.
  it("counts the authoring turns between repair-context and repair-apply", () => {
    const runDir = makeRun("repair-flow", {});
    markPhase(runDir, "visualJudgment", base + 40 * 60_000);
    markPhase(runDir, "repair", base + 50 * 60_000); // repair-context
    markPhase(runDir, "repair", base + 60 * 60_000); // repair-apply
    const transcript = makeTranscript("repair-flow", [
      turn(30, 1000), // Visual QA judgment
      turn(55, 400), // the model authoring the replacement slide
    ]);
    const report = buildTokenReport({ runDir, transcriptPath: transcript, slides: 8, since: base });

    expect(Date.parse(report.window.to)).toBe(base + 60 * 60_000);
    expect(report.tokenUsage.phases.repair.output).toBe(400);
    expect(report.tokenUsage.phases.visualJudgment.output).toBe(1000);
    expect(report.repairOverhead).toBeGreaterThan(0);
  });

  it("still accounts for a repair that was started but never applied", () => {
    const runDir = makeRun("repair-abandoned", {});
    markPhase(runDir, "visualJudgment", base + 40 * 60_000);
    markPhase(runDir, "repair", base + 50 * 60_000); // repair-context, no repair-apply
    const transcript = makeTranscript("repair-abandoned", [turn(45, 300)]);
    const report = buildTokenReport({ runDir, transcriptPath: transcript, slides: 8, since: base });
    expect(report.tokenUsage.phases.repair.output).toBe(300);
    expect(Date.parse(report.window.to)).toBe(base + 50 * 60_000);
  });

  it("treats the last mark of a repeated phase as when it finished", () => {
    const runDir = makeRun("remark", {});
    markPhase(runDir, "compositionAuthoring", base + 10 * 60_000);
    markPhase(runDir, "compositionAuthoring", base + 50 * 60_000);
    const transcript = makeTranscript("remark", [turn(30, 700)]);
    const report = buildTokenReport({ runDir, transcriptPath: transcript, slides: 8, since: base });
    expect(report.attribution).toBe("phase-marker");
    expect(report.tokenUsage.phases.compositionAuthoring.output).toBe(700);
  });
});

describe("per-slide cost", () => {
  it("divides by accepted slides once Visual QA has failed some", () => {
    const runDir = makeRun("accepted", { "content-model.json": 10 });
    fs.writeFileSync(path.join(runDir, "visual-qa.json"), JSON.stringify({
      findings: [
        { severity: "hard", code: "CHART_UNREADABLE", slideId: "S04", message: "x" },
        { severity: "risk", code: "WEAK_VISUAL_HIERARCHY", slideId: "S05", message: "x" },
        { severity: "warning", code: "LAYOUT_REPETITION", slideId: "S06", message: "x" },
      ],
    }));
    const transcript = makeTranscript("accepted", [turn(5, 790)]);
    const report = buildTokenReport({ runDir, transcriptPath: transcript, slides: 8, since: base });
    expect(report.acceptedSlides).toBe(6);
    expect(report.tokensPerSlide).toBeCloseTo(report.tokenUsage.total.total / 8, 2);
    expect(report.tokensPerAcceptedSlide).toBeCloseTo(report.tokenUsage.total.total / 6, 2);
  });
});
