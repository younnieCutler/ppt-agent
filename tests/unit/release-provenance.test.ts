import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { release } from "../../src/cli";

// Regression: a Japan Career Agent deliverable PDF was produced minutes after Visual QA judged
// the montage, by a different converter, and released without anyone re-checking it against what
// was actually judged. `release --visual-qa` must require --run-dir and a matching
// visual/render-provenance.json, not merely accept them when present.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-release-provenance-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function sha256(input: Buffer | string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function makeBaseArgs(name: string, pptxContent = "pretend-pptx-bytes"): { runDir: string; pptxPath: string; args: string[] } {
  const runDir = path.join(root, name);
  fs.mkdirSync(runDir, { recursive: true });

  const qaPath = path.join(runDir, "qa.json");
  fs.writeFileSync(qaPath, JSON.stringify({ status: "pass" }));

  const judgmentPath = path.join(runDir, "judgment.md");
  fs.writeFileSync(judgmentPath, "Outcome: good\nRelease decision: pass\n");

  const repairStatePath = path.join(runDir, "repair-state.json");
  fs.writeFileSync(repairStatePath, JSON.stringify({ attempts: 0 }));

  const pptxPath = path.join(runDir, "draft.pptx");
  fs.writeFileSync(pptxPath, pptxContent);

  const outPath = path.join(runDir, "release.pptx");

  const args = ["--qa", qaPath, "--judgment", judgmentPath, "--repair-state", repairStatePath, "--pptx", pptxPath, "--out", outPath];
  return { runDir, pptxPath, args };
}

function writeVisualQa(runDir: string, overrides: { status?: string; findings?: Array<{ severity: string }> } = {}): string {
  const visualQaPath = path.join(runDir, "visual-qa.json");
  fs.writeFileSync(visualQaPath, JSON.stringify({ status: overrides.status ?? "pass", findings: overrides.findings ?? [] }));
  return visualQaPath;
}

function writeProvenance(runDir: string, pptxSha256: string): void {
  fs.mkdirSync(path.join(runDir, "visual"), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "visual", "render-provenance.json"),
    JSON.stringify({ pptxSha256, specSha256: sha256("unused"), renderedAt: new Date().toISOString(), slideIds: ["S01"] }),
  );
}

describe("release provenance requirements", () => {
  it("releases fine without --visual-qa at all (unaffected legacy path)", async () => {
    const { args } = makeBaseArgs("no-visual-qa");
    await expect(release(args)).resolves.toBeUndefined();
  });

  it("blocks when --visual-qa is passed without --run-dir", async () => {
    const { runDir, args } = makeBaseArgs("missing-rundir");
    const visualQaPath = writeVisualQa(runDir);
    await expect(release([...args, "--visual-qa", visualQaPath])).rejects.toThrow(/--run-dir is required/);
  });

  it("blocks when --run-dir is given but visual/render-provenance.json does not exist", async () => {
    const { runDir, args } = makeBaseArgs("missing-provenance");
    const visualQaPath = writeVisualQa(runDir);
    await expect(release([...args, "--visual-qa", visualQaPath, "--run-dir", runDir])).rejects.toThrow(/render-provenance\.json does not exist/);
  });

  it("blocks on a digest mismatch between the released pptx and the judged one", async () => {
    const { runDir, args } = makeBaseArgs("digest-mismatch");
    const visualQaPath = writeVisualQa(runDir);
    writeProvenance(runDir, sha256("a completely different pptx"));
    await expect(release([...args, "--visual-qa", visualQaPath, "--run-dir", runDir])).rejects.toThrow(/digest mismatch/);
  });

  it("releases when the pptx digest matches what visual-qa judged", async () => {
    const { runDir, pptxPath, args } = makeBaseArgs("digest-match");
    const visualQaPath = writeVisualQa(runDir);
    writeProvenance(runDir, sha256(fs.readFileSync(pptxPath)));
    await expect(release([...args, "--visual-qa", visualQaPath, "--run-dir", runDir])).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(runDir, "release.pptx"))).toBe(true);
  });
});
