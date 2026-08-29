import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRunWorkspace, removeRunWorkspace } from "../../src/workspace";

// Regression class this guards against: a cleanup bug that resolves outside .ppt-agent/runs/ and
// deletes something that is not run-scoped (organizations/, outputs/, the project root). The guard
// is structural (does runDir's own path end in .ppt-agent/runs/<id>?), not dependent on a
// separately supplied "project dir" that could disagree with where runDir actually lives.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-workspace-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("createRunWorkspace", () => {
  it("creates a directory under <projectDir>/.ppt-agent/runs/", () => {
    const { runDir, runId } = createRunWorkspace(root, "gao-it-weekly");
    expect(fs.existsSync(runDir)).toBe(true);
    expect(runDir).toBe(path.join(root, ".ppt-agent", "runs", runId));
    expect(runDir.startsWith(path.join(root, ".ppt-agent", "runs"))).toBe(true);
  });

  it("produces a distinct runId on every call, even for the same name in the same tick", () => {
    const a = createRunWorkspace(root, "same-name");
    const b = createRunWorkspace(root, "same-name");
    expect(a.runId).not.toBe(b.runId);
    expect(fs.existsSync(a.runDir)).toBe(true);
    expect(fs.existsSync(b.runDir)).toBe(true);
  });

  it("slugifies an unfriendly name instead of producing a broken path", () => {
    const { runDir } = createRunWorkspace(root, "GAO IT/AI Weekly ブリーフィング");
    expect(fs.existsSync(runDir)).toBe(true);
  });
});

describe("removeRunWorkspace containment guard", () => {
  it("removes a run directory that is genuinely inside .ppt-agent/runs/", () => {
    const { runDir } = createRunWorkspace(root, "to-delete");
    fs.writeFileSync(path.join(runDir, "scratch.json"), "{}");
    removeRunWorkspace(runDir);
    expect(fs.existsSync(runDir)).toBe(false);
  });

  it("refuses to remove outputs/ even if passed directly as runDir", () => {
    const outputs = path.join(root, "outputs");
    fs.mkdirSync(outputs, { recursive: true });
    expect(() => removeRunWorkspace(outputs)).toThrow(/Refusing to remove workspace/);
    expect(fs.existsSync(outputs)).toBe(true);
  });

  it("refuses to remove organizations/ even if passed directly as runDir", () => {
    const orgs = path.join(root, "organizations");
    fs.mkdirSync(orgs, { recursive: true });
    expect(() => removeRunWorkspace(orgs)).toThrow(/Refusing to remove workspace/);
    expect(fs.existsSync(orgs)).toBe(true);
  });

  it("refuses a path-traversal runDir that escapes .ppt-agent/runs/ via ..", () => {
    const { runDir } = createRunWorkspace(root, "escape-attempt");
    const escaped = path.join(runDir, "..", "..", "..");
    expect(() => removeRunWorkspace(escaped)).toThrow(/Refusing to remove workspace/);
  });

  it("refuses .ppt-agent/runs/ itself (the container, not a run)", () => {
    const { runDir } = createRunWorkspace(root, "any");
    const runsRoot = path.dirname(runDir);
    expect(() => removeRunWorkspace(runsRoot)).toThrow(/Refusing to remove workspace/);
    expect(fs.existsSync(runsRoot)).toBe(true);
  });

  it("refuses the project root itself", () => {
    expect(() => removeRunWorkspace(root)).toThrow(/Refusing to remove workspace/);
  });

  it("refuses an arbitrary directory that merely contains a .ppt-agent/runs-shaped subpath in its middle, not at the tail", () => {
    // e.g. someone points --run-dir at .ppt-agent/runs/<id>/extra — one segment too deep is fine
    // structurally (it still *ends* differently), but a directory that only has the right prefix
    // and then diverges must not be accepted.
    const decoy = path.join(root, "not-runs", ".ppt-agent", "runs");
    fs.mkdirSync(decoy, { recursive: true });
    expect(() => removeRunWorkspace(path.dirname(decoy))).toThrow(/Refusing to remove workspace/);
  });
});
