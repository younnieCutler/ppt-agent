import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * All run-scoped intermediate artifacts live here, never in the user's output directory. The name
 * is a fixed, two-segment shape (".ppt-agent/runs") deliberately, not a configurable root: the
 * safety of `removeRunWorkspace` below depends on being able to recognise that shape structurally,
 * without trusting a separately-passed "this is the project dir" argument that could be wrong (an
 * env var pointing somewhere else, a caller's stale cwd) and silently authorize deleting the wrong
 * directory tree.
 */
const RUNS_SEGMENTS = [".ppt-agent", "runs"];

function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "run";
}

/** ISO-ish but filesystem-safe: sorts lexicographically in creation order. */
function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export type RunWorkspace = { runId: string; runDir: string };

/**
 * Creates a fresh, hidden run directory under `<projectDir>/.ppt-agent/runs/`. The run id embeds a
 * timestamp and a short random suffix so two runs started in the same process tick (or two hosts
 * racing on the same project) never collide.
 */
export function createRunWorkspace(projectDir: string, name: string): RunWorkspace {
  const runId = `${timestamp()}-${slugify(name)}-${crypto.randomBytes(3).toString("hex")}`;
  const runDir = path.join(path.resolve(projectDir), ...RUNS_SEGMENTS, runId);
  fs.mkdirSync(runDir, { recursive: true });
  return { runId, runDir };
}

/**
 * Deletes a run workspace — but only a path whose own shape proves it is a run directory: its
 * immediate parent chain must end in `.ppt-agent/runs/<runId>`. Checking this structurally, rather
 * than against a separately supplied "project dir," means the guard cannot be defeated by a caller
 * whose notion of the project root (an env var, a stale cwd) disagrees with where `runDir` actually
 * lives — the one thing standing between a cleanup bug and deleting `organizations/`, `outputs/`,
 * or the project root itself stays true regardless of that mismatch.
 */
export function removeRunWorkspace(runDir: string): void {
  const resolvedRunDir = path.resolve(runDir);
  const segments = resolvedRunDir.split(path.sep);
  const runsIndex = segments.length - 1 - RUNS_SEGMENTS.length;
  const isContained = runsIndex >= 0 && RUNS_SEGMENTS.every((segment, offset) => segments[runsIndex + offset] === segment);
  if (!isContained) {
    throw new Error(`Refusing to remove workspace: ${resolvedRunDir} does not end in ${RUNS_SEGMENTS.join("/")}/<runId>.`);
  }
  fs.rmSync(resolvedRunDir, { recursive: true, force: true });
}
