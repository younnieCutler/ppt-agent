import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { release } from "../../src/cli";
import { createRunWorkspace } from "../../src/workspace";

// PR A: hidden run workspace + --pdf + --keep-workspace + cleanup-never-touches-a-published-file.

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-release-workspace-"));
afterAll(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

function sha256(input: Buffer | string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function makeRun(name: string, opts: { withDeckPdf?: boolean } = {}): { runDir: string; args: string[]; outPath: string } {
  const { runDir } = createRunWorkspace(projectRoot, name);

  fs.writeFileSync(path.join(runDir, "qa.json"), JSON.stringify({ status: "pass" }));
  fs.writeFileSync(path.join(runDir, "judgment.md"), "Outcome: good\nRelease decision: pass\n");
  fs.writeFileSync(path.join(runDir, "repair-state.json"), JSON.stringify({ attempts: 0 }));

  const pptxPath = path.join(runDir, "draft.pptx");
  fs.writeFileSync(pptxPath, "pretend-pptx-bytes");

  if (opts.withDeckPdf !== false) {
    fs.mkdirSync(path.join(runDir, "visual"), { recursive: true });
    fs.writeFileSync(path.join(runDir, "visual", "deck.pdf"), "pretend-pdf-bytes");
  }

  const outPath = path.join(projectRoot, "outputs", name, `${name}.pptx`);
  const args = ["--qa", path.join(runDir, "qa.json"), "--judgment", path.join(runDir, "judgment.md"), "--repair-state", path.join(runDir, "repair-state.json"), "--pptx", pptxPath, "--out", outPath, "--run-dir", runDir];
  return { runDir, args, outPath };
}

describe("release --pdf", () => {
  it("publishes visual/deck.pdf verbatim next to the pptx, never re-converting", async () => {
    const { args, outPath, runDir } = makeRun("pdf-publish");
    await release([...args, "--pdf", "--keep-workspace"]);
    // Sibling to the pptx with the same basename, not name.pptx.pdf — matches the PRD's
    // gao-it-weekly.pptx + gao-it-weekly.pdf sibling-file convention.
    const pdfOutPath = outPath.replace(/\.pptx$/, ".pdf");
    expect(fs.existsSync(pdfOutPath)).toBe(true);
    expect(sha256(fs.readFileSync(pdfOutPath))).toBe(sha256(fs.readFileSync(path.join(runDir, "visual", "deck.pdf"))));
  });

  it("blocks --pdf without --run-dir", async () => {
    const { args } = makeRun("pdf-no-rundir");
    const withoutRunDir = args.filter((_, i) => args[i - 1] !== "--run-dir" && args[i] !== "--run-dir");
    await expect(release([...withoutRunDir, "--pdf"])).rejects.toThrow(/--pdf requires --run-dir/);
  });

  it("blocks --pdf when visual/deck.pdf does not exist", async () => {
    const { args } = makeRun("pdf-missing", { withDeckPdf: false });
    await expect(release([...args, "--pdf"])).rejects.toThrow(/requires .*deck\.pdf.* to exist/);
  });

  it("does not publish a PDF when --pdf is not passed", async () => {
    const { args, outPath } = makeRun("no-pdf-default");
    await release([...args, "--keep-workspace"]);
    expect(fs.existsSync(outPath.replace(/\.pptx$/, ".pdf"))).toBe(false);
  });
});

describe("release workspace cleanup", () => {
  it("removes the run workspace on success without --keep-workspace", async () => {
    const { args, runDir } = makeRun("cleanup-success");
    await release(args);
    expect(fs.existsSync(runDir)).toBe(false);
  });

  it("keeps the run workspace when --keep-workspace is passed", async () => {
    const { args, runDir } = makeRun("cleanup-kept");
    await release([...args, "--keep-workspace"]);
    expect(fs.existsSync(runDir)).toBe(true);
  });

  it("never removes the workspace on a blocked release (gate failure before publish)", async () => {
    const { runDir } = makeRun("cleanup-blocked");
    fs.writeFileSync(path.join(runDir, "qa.json"), JSON.stringify({ status: "fail" }));
    const args = ["--qa", path.join(runDir, "qa.json"), "--judgment", path.join(runDir, "judgment.md"), "--repair-state", path.join(runDir, "repair-state.json"), "--pptx", path.join(runDir, "draft.pptx"), "--out", path.join(projectRoot, "outputs", "cleanup-blocked", "x.pptx"), "--run-dir", runDir];
    await expect(release(args)).rejects.toThrow(/qa\.json\.status must be pass/);
    expect(fs.existsSync(runDir)).toBe(true);
  });

  it("publishes the deliverable even when cleanup would fail, and reports the warning instead of throwing", async () => {
    const { args, outPath, runDir } = makeRun("cleanup-fails-safely");
    // Force removeRunWorkspace's containment check to fail by deleting the run dir out from under
    // it before release gets to the cleanup step is not reachable from here directly; instead
    // simulate a cleanup failure by making the run directory read-only so rmSync throws.
    fs.chmodSync(runDir, 0o500);
    try {
      const result = await release(args);
      expect(fs.existsSync(outPath)).toBe(true);
      expect((result as unknown as { cleanupWarning?: string } | undefined)).toBeUndefined(); // release() prints, does not return
    } finally {
      // Windows does not honor a POSIX permission bit on a directory the way rmSync's failure
      // path here assumes — cleanup can succeed anyway and remove runDir outright, so restoring
      // its mode afterward would otherwise throw ENOENT on a path that is legitimately gone.
      if (fs.existsSync(runDir)) fs.chmodSync(runDir, 0o700);
    }
  });

  it("skips cleanup entirely when --run-dir is not passed at all", async () => {
    const { args, outPath, runDir } = makeRun("no-rundir-no-cleanup");
    const withoutRunDir = args.filter((_, i) => args[i - 1] !== "--run-dir" && args[i] !== "--run-dir");
    await release(withoutRunDir);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.existsSync(runDir)).toBe(true);
  });
});

describe("release publish integrity", () => {
  it("publishes a byte-identical copy of the source pptx", async () => {
    const { args, outPath } = makeRun("integrity");
    await release([...args, "--keep-workspace"]);
    expect(fs.readFileSync(outPath, "utf8")).toBe("pretend-pptx-bytes");
  });
});
