import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  effectiveFeedbackConclusion,
  loadFeedbackCase,
  promoteFeedbackCase,
  recordFailure,
  recordSystemDiagnosis,
  recordUserCorrection,
} from "../../src/feedback";

const tempDirs: string[] = [];

function tempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ppt-agent-${name}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("persistent feedback learning loop", () => {
  it("records a failed run as both failure-report.json and a feedback case", () => {
    const runDir = tempDir("feedback-failure");
    const result = recordFailure({
      runDir,
      runId: "run-001",
      stage: "template-routing",
      code: "SPARSE_TEMPLATE_UNSUPPORTED",
      message: "Template patterns cannot carry the planned semantic structure.",
      evidence: ["render-manifest.json"],
    });

    expect(fs.existsSync(path.join(runDir, "failure-report.json"))).toBe(true);
    expect(fs.existsSync(result.casePath)).toBe(true);
    expect(result.feedbackCase.events[0]).toMatchObject({ source: "system", kind: "failure", code: "SPARSE_TEMPLATE_UNSUPPORTED" });
  });

  it("treats a user correction as authoritative over the current automated diagnosis", () => {
    const runDir = tempDir("feedback-user-wins");
    const { casePath } = recordFailure({
      runDir,
      stage: "template-analysis",
      code: "LOGO_MISSING",
      message: "Generated output has no logo.",
    });
    const diagnosed = recordSystemDiagnosis(casePath, {
      code: "ASSET_PRUNED",
      summary: "The logo was probably removed during package pruning.",
    });
    const diagnosis = effectiveFeedbackConclusion(diagnosed);
    expect(diagnosis?.source).toBe("system");

    const corrected = recordUserCorrection(casePath, {
      code: "MANUAL_FALLBACK_OMITTED_VECTOR_LOGO",
      summary: "The template analyzer failed first; the manual fallback recreated layout/colors and omitted the vector logo.",
      evidence: ["user-observed root cause"],
    });
    const effective = effectiveFeedbackConclusion(corrected);

    expect(effective).toMatchObject({ source: "user", kind: "user_correction", code: "MANUAL_FALLBACK_OMITTED_VECTOR_LOGO" });
    expect(effective?.supersedes).toEqual([diagnosis?.id]);
    expect(corrected.status).toBe("corrected");
  });

  it("never lets a later automated diagnosis silently overwrite an accepted user correction", () => {
    const runDir = tempDir("feedback-no-system-overwrite");
    const { casePath } = recordFailure({
      runDir,
      stage: "render",
      code: "OUTPUT_WRONG",
      message: "Rendered deck does not satisfy the requested structure.",
    });
    recordSystemDiagnosis(casePath, { summary: "Initial automated hypothesis." });
    const corrected = recordUserCorrection(casePath, { summary: "User correction is the accepted root-cause direction." });
    const userEvent = effectiveFeedbackConclusion(corrected);

    const afterAutomation = recordSystemDiagnosis(casePath, { summary: "A later automated alternative hypothesis." });
    const effective = effectiveFeedbackConclusion(afterAutomation);
    const lastEvent = afterAutomation.events.at(-1);

    expect(effective?.id).toBe(userEvent?.id);
    expect(effective?.source).toBe("user");
    expect(lastEvent).toMatchObject({ source: "system", kind: "diagnosis", advisory: true });
    expect(lastEvent?.supersedes).toEqual([]);
  });

  it("allows a newer user correction to supersede an earlier user correction", () => {
    const runDir = tempDir("feedback-user-recorrect");
    const { casePath } = recordFailure({ runDir, stage: "qa", code: "BAD_DIAGNOSIS", message: "Something failed." });
    const first = recordUserCorrection(casePath, { summary: "First correction." });
    const firstEvent = effectiveFeedbackConclusion(first);
    const second = recordUserCorrection(casePath, { summary: "Second correction with better evidence." });
    const secondEvent = effectiveFeedbackConclusion(second);

    expect(secondEvent?.summary).toBe("Second correction with better evidence.");
    expect(secondEvent?.supersedes).toEqual([firstEvent?.id]);
  });

  it("promotes a corrected case into persistent regression knowledge without losing the correction", () => {
    const root = tempDir("feedback-promote");
    const runDir = path.join(root, ".ppt-agent", "runs", "run-001");
    fs.mkdirSync(runDir, { recursive: true });
    const { casePath } = recordFailure({
      runDir,
      stage: "template-routing",
      code: "SPARSE_TEMPLATE_SEMANTIC_LOSS",
      message: "Sparse 4:3 template was routed through thin source-slide patterns.",
      caseId: "sparse-template-4x3",
    });
    recordSystemDiagnosis(casePath, { summary: "The template itself is incapable of producing the requested deck." });
    const corrected = recordUserCorrection(casePath, {
      summary: "Treat the input as a brand shell: preserve 4:3/master/theme/chrome and generate semantic slide bodies.",
      code: "SPARSE_TEMPLATE_ROUTING_GAP",
    });
    const userEventId = effectiveFeedbackConclusion(corrected)?.id;

    const result = promoteFeedbackCase(casePath, {
      projectDir: root,
      expectedBehavior: "Sparse templates route to generative composition on the source canvas without mixed aspect ratios or semantic loss.",
      testPath: "tests/integration/sparse-template-routing.test.ts",
      fixturePath: "tests/fixtures/sparse-template-4x3.pptx",
    });
    const promoted = loadFeedbackCase(result.promotedPath);

    expect(result.promotedPath).toBe(path.join(root, "feedback-cases", "sparse-template-4x3.json"));
    expect(promoted.status).toBe("promoted");
    expect(promoted.regression?.testPath).toBe("tests/integration/sparse-template-routing.test.ts");
    expect(promoted.effectiveConclusionEventId).toBe(userEventId);
    expect(effectiveFeedbackConclusion(promoted)?.source).toBe("user");
  });
});
