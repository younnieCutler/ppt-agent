import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repairApply } from "../../src/cli";
import { buildTokenReport, markPhase } from "../../src/tokens";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-repair-apply-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const specPath = path.resolve(__dirname, "../fixtures/deck.json");
const base = Date.parse("2026-08-28T10:00:00.000Z");
const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString();

function turn(minutes: number, output: number): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: at(minutes),
    message: { role: "assistant", usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: output } },
  });
}

/** run dir with the pre-repair phase boundaries already marked, as the real pipeline would leave them. */
function makeRun(name: string): string {
  const runDir = path.join(root, name);
  fs.mkdirSync(runDir, { recursive: true });
  markPhase(runDir, "visualJudgment", base + 40 * 60_000); // t40: Visual QA finished
  markPhase(runDir, "repair", base + 50 * 60_000); // t50: repair-context opened the repair phase
  return runDir;
}

function lastRepairMarkerAt(runDir: string): number {
  const lines = fs.readFileSync(path.join(runDir, "run.jsonl"), "utf8").trim().split("\n");
  const repairs = lines.map((line) => JSON.parse(line)).filter((entry) => entry.phase === "repair");
  return Date.parse(repairs[repairs.length - 1].at);
}

describe("repair-apply phase-boundary telemetry", () => {
  it("records the repair completion boundary even when applyRepair rejects the replacement", async () => {
    const runDir = makeRun("failed-repair");
    const outPath = path.join(runDir, "deck.v2.json");
    const replacementPath = path.join(runDir, "bad-fragment.json");
    fs.writeFileSync(replacementPath, JSON.stringify({})); // fails slideSchema.parse inside applyRepair

    const transcript = path.join(root, "failed-repair.jsonl");
    fs.writeFileSync(transcript, [
      turn(30, 1000), // Visual QA judgment
      turn(55, 400), //  authoring the replacement slide, between repair-context (t50) and repair-apply
    ].join("\n") + "\n");

    const before = Date.now();
    await expect(
      repairApply(["--spec", specPath, "--run-dir", runDir, "--slide", "S02", "--replacement", replacementPath, "--out", outPath]),
    ).rejects.toThrow();

    // The failure path still closed the repair phase: the marker moved past repair-context's t50.
    const closedAt = lastRepairMarkerAt(runDir);
    expect(closedAt).toBeGreaterThanOrEqual(before);
    expect(fs.existsSync(outPath)).toBe(false); // no partial deck written

    const report = buildTokenReport({ runDir, transcriptPath: transcript, slides: 8, since: base });

    // t55 authoring cost lands in the repair phase, not lost outside a window that closed at t50.
    expect(report.tokenUsage.phases.repair.output).toBe(400);
    expect(report.tokenUsage.phases.visualJudgment.output).toBe(1000);
    // Window closes at the repair-apply boundary, not before it.
    expect(Date.parse(report.window.to)).toBe(closedAt);
    expect(Date.parse(report.window.to)).toBeGreaterThan(base + 50 * 60_000);
    expect(report.repairOverhead).toBeGreaterThan(0);
  });

  it("still marks the boundary and writes the deck on a successful repair", async () => {
    const runDir = makeRun("ok-repair");
    const outPath = path.join(runDir, "deck.v2.json");
    const deck = JSON.parse(fs.readFileSync(specPath, "utf8"));
    const original = deck.slides.find((slide: { id: string }) => slide.id === "S02");
    const replacementPath = path.join(runDir, "fragment.json");
    // Same id / storyBeat / claims / native objects — only the headline copy changes.
    fs.writeFileSync(replacementPath, JSON.stringify({
      ...original,
      headline: original.headline,
      claims: original.claims.map((claim: { text: string }, index: number) => (index === 0 ? { ...claim, text: original.headline } : claim)),
    }));

    const before = Date.now();
    await repairApply(["--spec", specPath, "--run-dir", runDir, "--slide", "S02", "--replacement", replacementPath, "--out", outPath]);

    expect(fs.existsSync(outPath)).toBe(true);
    expect(lastRepairMarkerAt(runDir)).toBeGreaterThanOrEqual(before);
  });
});
