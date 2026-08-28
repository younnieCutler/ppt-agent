import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildTokenReport, resolveTranscript } from "../../src/tokens";

// Regression: the real Japan Career Agent `/ppt` run reported `tokensPerSlide: 0` because
// `resolveTranscript` picked the newest `.jsonl` in the project slug directory, and the newest one
// was not the session that did the work. `tokens.json` must never present a measurement failure as
// a legitimately free run.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-tokens-unavailable-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const base = Date.parse("2026-08-28T10:00:00.000Z");
const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString();

function turn(minutes: number, output: number): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: at(minutes),
    message: { role: "assistant", usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output } },
  });
}

function makeRun(name: string, artifactMinutes: Record<string, number>): string {
  const runDir = path.join(root, name);
  fs.mkdirSync(runDir, { recursive: true });
  for (const [file, minutes] of Object.entries(artifactMinutes)) {
    const target = path.join(runDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{}");
    fs.utimesSync(target, new Date(base + minutes * 60_000), new Date(base + minutes * 60_000));
  }
  fs.utimesSync(runDir, new Date(base), new Date(base));
  return runDir;
}

function makeTranscript(name: string, lines: string[], mtimeMinutes: number): string {
  const file = path.join(root, `${name}.jsonl`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  fs.utimesSync(file, new Date(base + mtimeMinutes * 60_000), new Date(base + mtimeMinutes * 60_000));
  return file;
}

describe("token measurement failure reporting", () => {
  it("reports measurement: unavailable with null ratios instead of 0 when no turns fall in the window", () => {
    const runDir = makeRun("empty-window", { "content-model.json": 10, "visual-qa.json": 40 });
    const transcript = makeTranscript("empty-window-transcript", [turn(500, 100)], 500); // long after the run's window
    const report = buildTokenReport({ runDir, transcriptPath: transcript, slides: 8, since: base, until: base + 60 * 60_000 });
    expect(report.measurement).toBe("unavailable");
    expect(report.unavailableReason).toBeTruthy();
    expect(report.tokensPerSlide).toBeNull();
    expect(report.effectiveTokensPerSlide).toBeNull();
    expect(report.tokensPerAcceptedSlide).toBeNull();
    expect(report.repairOverhead).toBeNull();
  });

  it("reports measurement: measured with real numbers when turns exist in the window", () => {
    const runDir = makeRun("real-window", { "content-model.json": 10 });
    const transcript = makeTranscript("real-window-transcript", [turn(5, 500)], 5);
    const report = buildTokenReport({ runDir, transcriptPath: transcript, slides: 8, since: base, until: base + 60 * 60_000 });
    expect(report.measurement).toBe("measured");
    expect(report.unavailableReason).toBeUndefined();
    expect(report.tokensPerSlide).not.toBeNull();
  });
});

describe("transcript selection", () => {
  it("picks the transcript that actually covers the measurement window over the merely-newest one", () => {
    const projectDir = path.join(root, "some-project");
    const slugDir = path.join(root, "claude-home", ".claude", "projects", projectDir.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(slugDir, { recursive: true });

    // The wrong-but-newer session: touched after the run, contributes no turns to the window.
    const wrongSession = path.join(slugDir, "wrong-session.jsonl");
    fs.writeFileSync(wrongSession, `${turn(500, 999)}\n`);
    fs.utimesSync(wrongSession, new Date(base + 999 * 60_000), new Date(base + 999 * 60_000));

    // The right-but-older session: this is the one that actually did the /ppt work.
    const rightSession = path.join(slugDir, "right-session.jsonl");
    fs.writeFileSync(rightSession, `${turn(5, 100)}\n${turn(10, 200)}\n`);
    fs.utimesSync(rightSession, new Date(base + 10 * 60_000), new Date(base + 10 * 60_000));

    const window = { from: base, to: base + 60 * 60_000 };
    const resolved = resolveTranscript(projectDir, path.join(root, "claude-home"), window);
    expect(resolved).toBe(rightSession);
  });

  it("without a window, falls back to newest-by-mtime (unchanged legacy behavior)", () => {
    const projectDir = path.join(root, "legacy-project");
    const slugDir = path.join(root, "claude-home-legacy", ".claude", "projects", projectDir.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(slugDir, { recursive: true });
    const older = path.join(slugDir, "older.jsonl");
    fs.writeFileSync(older, "{}\n");
    fs.utimesSync(older, new Date(base), new Date(base));
    const newer = path.join(slugDir, "newer.jsonl");
    fs.writeFileSync(newer, "{}\n");
    fs.utimesSync(newer, new Date(base + 60_000), new Date(base + 60_000));
    expect(resolveTranscript(projectDir, path.join(root, "claude-home-legacy"))).toBe(newer);
  });
});
