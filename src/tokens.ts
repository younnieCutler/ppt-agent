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
  /** `phase-marker` when run.jsonl recorded the boundaries; `artifact-mtime-window` when inferred. */
  attribution: "phase-marker" | "artifact-mtime-window" | "mixed";
  window: { from: string; to: string; closedBy: "explicit" | "last-phase-boundary" | "open" };
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

export type PhaseBoundary = { phase: PhaseName; at: number };

const markerFile = "run.jsonl";

/**
 * Records that `phase` just completed. Called by the CLI commands that end each phase, so boundaries
 * are observed rather than inferred — mtime inference cannot tell a phase's completion from a later
 * incidental touch of the same file, and gives no end to the measurement window at all.
 */
export function markPhase(runDir: string, phase: PhaseName, at = Date.now()): void {
  const resolved = path.resolve(runDir);
  fs.mkdirSync(resolved, { recursive: true });
  fs.appendFileSync(path.join(resolved, markerFile), `${JSON.stringify({ phase, at: new Date(at).toISOString() })}\n`);
}

function readMarkers(runDir: string): PhaseBoundary[] {
  const markerPath = path.join(path.resolve(runDir), markerFile);
  if (!fs.existsSync(markerPath)) return [];
  const boundaries: PhaseBoundary[] = [];
  for (const line of fs.readFileSync(markerPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as { phase: PhaseName; at: string };
      if (phaseNames.includes(entry.phase)) boundaries.push({ phase: entry.phase, at: Date.parse(entry.at) });
    } catch { continue; }
  }
  // A phase can be marked more than once (a re-render, a second repair). The last mark is when it
  // actually finished.
  const latest = new Map<PhaseName, number>();
  for (const boundary of boundaries) latest.set(boundary.phase, Math.max(latest.get(boundary.phase) ?? 0, boundary.at));
  return [...latest].map(([phase, at]) => ({ phase, at }));
}

/**
 * Phase boundaries, in chronological order. Each entry marks the moment its phase *finished*, so a
 * turn belongs to the first boundary it has not yet crossed.
 *
 * Recorded markers win. Artifact mtimes are the fallback, and exist only so runs produced before
 * markers were introduced still report something rather than nothing.
 */
export function phaseBoundaries(runDir: string, specPath?: string): PhaseBoundary[] {
  const resolved = path.resolve(runDir);
  const marked = readMarkers(resolved);
  const markedPhases = new Set(marked.map((boundary) => boundary.phase));
  const repairDir = path.join(resolved, "repair");
  const repairMtimes = fs.existsSync(repairDir)
    ? fs.readdirSync(repairDir).map((slide) => mtimeOf(path.join(repairDir, slide, "context.json"))).filter((value): value is number => value !== undefined)
    : [];
  const inferred: Array<{ phase: PhaseName; at: number | undefined }> = [
    // content-model.json is authored by the agent, not by any CLI command, so it has no marker.
    { phase: "sourceUnderstanding", at: mtimeOf(path.join(resolved, "content-model.json")) },
    { phase: "referenceRetrieval", at: mtimeOf(path.join(resolved, "reference-selection.json")) },
    { phase: "styleResolution", at: mtimeOf(path.join(resolved, "style-context.json")) },
    { phase: "compositionAuthoring", at: specPath ? mtimeOf(path.resolve(specPath)) : undefined },
    { phase: "visualJudgment", at: mtimeOf(path.join(resolved, "visual-qa.json")) },
    { phase: "repair", at: repairMtimes.length > 0 ? Math.max(...repairMtimes) : undefined },
  ];
  return [
    ...marked,
    ...inferred.filter((entry): entry is PhaseBoundary => entry.at !== undefined && !markedPhases.has(entry.phase)),
  ].sort((a, b) => a.at - b.at);
}

/**
 * A boundary marks the moment its phase finished, so a turn belongs to the first boundary it has not
 * yet crossed. Turns past every boundary are in whatever phase follows the last one that completed.
 *
 * `repair` is never inferred. It is the last phase in the pipeline, so a naive "successor" rule
 * would sweep every turn after Visual QA into it and report 100% repair overhead on a run that
 * repaired nothing. A turn only counts as repair when a repair boundary actually exists.
 */
function phaseFor(at: number, boundaries: PhaseBoundary[]): PhaseName {
  const boundary = boundaries.find((entry) => at <= entry.at);
  if (boundary) return boundary.phase;
  const last = boundaries.at(-1);
  if (!last) return "outline";
  const successor = phaseNames[phaseNames.indexOf(last.phase) + 1];
  if (!successor) return last.phase;
  const repairHappened = boundaries.some((entry) => entry.phase === "repair");
  return successor === "repair" && !repairHappened ? last.phase : successor;
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
  /** Epoch ms to stop counting at. Defaults to the last recorded phase boundary. */
  until?: number;
}): TokenReport {
  const resolved = path.resolve(options.runDir);
  // The run directory's own creation marks the start of the run; turns before it belong to whatever
  // the user was doing beforehand and are not this deck's cost. Some filesystems report no birth
  // time, so mtime is the fallback and `since` the explicit override.
  const stats = fs.statSync(resolved);
  const runStart = options.since ?? (stats.birthtimeMs || stats.mtimeMs);
  const boundaries = phaseBoundaries(resolved, options.specPath);
  const markedCount = readMarkers(resolved).length;
  // The window must close, or unrelated work done later in the same session gets billed to this
  // deck. Generation ends at the last phase boundary; everything after it is somebody else's cost.
  const runEnd = options.until ?? boundaries.at(-1)?.at ?? Date.now();
  const turns = readTurns(options.transcriptPath).filter((turn) => turn.at >= runStart && turn.at <= runEnd);

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
    attribution: markedCount === 0 ? "artifact-mtime-window" : markedCount === boundaries.length ? "phase-marker" : "mixed",
    window: {
      from: new Date(runStart).toISOString(),
      to: new Date(runEnd).toISOString(),
      closedBy: options.until ? "explicit" : boundaries.length > 0 ? "last-phase-boundary" : "open",
    },
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
