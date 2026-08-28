import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Token telemetry.
//
// There is no LLM SDK in this repo — every model call is the agent conversation executing SKILL.md,
// so no provider response is available to read `usage` from. The only honest source of real numbers
// is the Claude Code session transcript, which records `message.usage` per assistant turn.
//
// Phase attribution is necessarily approximate: nothing tags a turn with the pipeline phase it
// belongs to. We bind phases to the mtimes of the artifacts each CLI command writes into the run
// directory, and label the result so the approximation is never mistaken for provider metadata.

export const phaseNames = [
  "outline",
  "sourceUnderstanding",
  "referenceRetrieval",
  "styleResolution",
  "compositionAuthoring",
  "visualJudgment",
  "repair",
] as const;

export type PhaseName = (typeof phaseNames)[number];

export type TokenTotals = {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
  /** Everything the provider billed context for, cache hits included. */
  total: number;
  /**
   * Cache reads are charged at a small fraction of fresh input, so `total` overstates the real cost
   * of a well-cached run. PRD §15's per-slide targets are scored against this figure.
   */
  effective: number;
  turns: number;
};

export type TokenReport = {
  benchmark?: string;
  transcript: string;
  attribution: "artifact-mtime-window";
  window: { from: string; to: string };
  slides: number;
  acceptedSlides: number;
  tokenUsage: {
    total: TokenTotals;
    sidechain: TokenTotals;
    phases: Record<PhaseName, TokenTotals>;
  };
  tokensPerSlide: number;
  effectiveTokensPerSlide: number;
  tokensPerAcceptedSlide: number;
  repairOverhead: number;
};

type Turn = { at: number; sidechain: boolean; usage: TokenTotals };

function emptyTotals(): TokenTotals {
  return { input: 0, cacheCreation: 0, cacheRead: 0, output: 0, total: 0, effective: 0, turns: 0 };
}

function add(into: TokenTotals, from: TokenTotals): void {
  into.input += from.input;
  into.cacheCreation += from.cacheCreation;
  into.cacheRead += from.cacheRead;
  into.output += from.output;
  into.total += from.total;
  into.effective += from.effective;
  into.turns += from.turns;
}

/** Claude Code stores transcripts under a directory named after the project path with every non-alphanumeric character replaced by a dash. */
export function projectSlug(projectDir: string): string {
  return projectDir.replace(/[^a-zA-Z0-9]/g, "-");
}

export function resolveTranscript(projectDir: string, home = os.homedir()): string {
  const dir = path.join(home, ".claude", "projects", projectSlug(projectDir));
  if (!fs.existsSync(dir)) {
    throw new Error(`No Claude Code transcript directory for this project (${dir}). Pass --transcript <path> to point at the session JSONL explicitly.`);
  }
  const sessions = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (sessions.length === 0) {
    throw new Error(`No session transcript found in ${dir}. Pass --transcript <path> explicitly.`);
  }
  return path.join(dir, sessions[0].name);
}

export function readTurns(transcriptPath: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of fs.readFileSync(transcriptPath, "utf8").split("\n")) {
    if (line.trim() === "" || !line.includes("output_tokens")) continue;
    let entry: any;
    // A transcript is appended to live; a torn final line is normal, not an error.
    try { entry = JSON.parse(line); } catch { continue; }
    const usage = entry?.message?.usage;
    if (entry?.type !== "assistant" || !usage || !entry.timestamp) continue;
    const input = usage.input_tokens ?? 0;
    const cacheCreation = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    turns.push({
      at: Date.parse(entry.timestamp),
      sidechain: Boolean(entry.isSidechain),
      usage: {
        input,
        cacheCreation,
        cacheRead,
        output,
        total: input + cacheCreation + cacheRead + output,
        effective: input + cacheCreation + output,
        turns: 1,
      },
    });
  }
  return turns;
}

function mtimeOf(filePath: string): number | undefined {
  return fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : undefined;
}

/**
 * Phase boundaries, in pipeline order. Each entry marks the moment its phase *finished*, so a turn
 * belongs to the first boundary that has not yet passed. Missing artifacts simply drop out.
 */
function phaseBoundaries(runDir: string, specPath?: string): Array<{ phase: PhaseName; at: number }> {
  const resolved = path.resolve(runDir);
  const repairDir = path.join(resolved, "repair");
  const repairMtimes = fs.existsSync(repairDir)
    ? fs.readdirSync(repairDir).map((slide) => mtimeOf(path.join(repairDir, slide, "context.json"))).filter((value): value is number => value !== undefined)
    : [];
  const candidates: Array<{ phase: PhaseName; at: number | undefined }> = [
    { phase: "sourceUnderstanding", at: mtimeOf(path.join(resolved, "content-model.json")) },
    { phase: "referenceRetrieval", at: mtimeOf(path.join(resolved, "reference-selection.json")) },
    { phase: "styleResolution", at: mtimeOf(path.join(resolved, "style-context.json")) },
    { phase: "compositionAuthoring", at: specPath ? mtimeOf(path.resolve(specPath)) : undefined },
    { phase: "visualJudgment", at: mtimeOf(path.join(resolved, "visual-qa.json")) },
    { phase: "repair", at: repairMtimes.length > 0 ? Math.max(...repairMtimes) : undefined },
  ];
  return candidates
    .filter((entry): entry is { phase: PhaseName; at: number } => entry.at !== undefined)
    .sort((a, b) => a.at - b.at);
}

/**
 * A boundary marks the moment its phase finished, so a turn belongs to the first boundary it has not
 * yet crossed. Turns past every boundary are in whatever phase follows the last one that completed —
 * calling them all `repair` would report 100% repair overhead on a run that never repaired anything.
 */
function phaseFor(at: number, boundaries: Array<{ phase: PhaseName; at: number }>): PhaseName {
  const boundary = boundaries.find((entry) => at <= entry.at);
  if (boundary) return boundary.phase;
  const last = boundaries.at(-1);
  if (!last) return "outline";
  return phaseNames[Math.min(phaseNames.indexOf(last.phase) + 1, phaseNames.length - 1)];
}

function readJsonIfExists<T>(filePath: string): T | undefined {
  return fs.existsSync(filePath) ? (JSON.parse(fs.readFileSync(filePath, "utf8")) as T) : undefined;
}

export function buildTokenReport(options: {
  runDir: string;
  transcriptPath: string;
  slides: number;
  specPath?: string;
  benchmark?: string;
  /** Epoch ms to start counting from. Defaults to the run directory's creation time. */
  since?: number;
}): TokenReport {
  const resolved = path.resolve(options.runDir);
  // The run directory's own creation marks the start of the run; turns before it belong to whatever
  // the user was doing beforehand and are not this deck's cost. Some filesystems report no birth
  // time, so mtime is the fallback and `since` the explicit override.
  const stats = fs.statSync(resolved);
  const runStart = options.since ?? (stats.birthtimeMs || stats.mtimeMs);
  const boundaries = phaseBoundaries(resolved, options.specPath);
  const turns = readTurns(options.transcriptPath).filter((turn) => turn.at >= runStart);

  const total = emptyTotals();
  const sidechain = emptyTotals();
  const phases = Object.fromEntries(phaseNames.map((name) => [name, emptyTotals()])) as Record<PhaseName, TokenTotals>;

  for (const turn of turns) {
    add(total, turn.usage);
    if (turn.sidechain) add(sidechain, turn.usage);
    add(phases[phaseFor(turn.at, boundaries)], turn.usage);
  }

  const visual = readJsonIfExists<{ findings?: Array<{ severity: string; slideId?: string }> }>(path.join(resolved, "visual-qa.json"));
  const failedSlides = new Set((visual?.findings ?? []).filter((finding) => finding.severity !== "warning" && finding.slideId).map((finding) => finding.slideId));
  const acceptedSlides = Math.max(0, options.slides - failedSlides.size);
  const ratio = (numerator: number, denominator: number): number => (denominator > 0 ? Math.round((numerator / denominator) * 100) / 100 : 0);

  return {
    benchmark: options.benchmark,
    transcript: options.transcriptPath,
    attribution: "artifact-mtime-window",
    window: { from: new Date(runStart).toISOString(), to: new Date(turns.at(-1)?.at ?? runStart).toISOString() },
    slides: options.slides,
    acceptedSlides,
    tokenUsage: { total, sidechain, phases },
    tokensPerSlide: ratio(total.total, options.slides),
    effectiveTokensPerSlide: ratio(total.effective, options.slides),
    tokensPerAcceptedSlide: ratio(total.total, acceptedSlides),
    repairOverhead: ratio(phases.repair.total, total.total),
  };
}

export function writeTokenReport(options: Parameters<typeof buildTokenReport>[0]): TokenReport {
  const report = buildTokenReport(options);
  const outPath = path.join(path.resolve(options.runDir), "tokens.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  return report;
}
