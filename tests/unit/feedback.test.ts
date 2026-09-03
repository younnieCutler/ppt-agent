import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  effectiveFeedbackConclusion,
  loadFeedbackCase,
  promoteFeedbackCase,
  recordFailure,
  recordResolution,
  recordSystemDiagnosis,
  recordUserCorrection,
} from "../../src/feedback";
import { recordUserCorrectionFromRun } from "../../src/user-feedback";

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

  it("accepts a user correction even when the run had no prior recorded failure", () => {
    const runDir = tempDir("feedback-success-was-wrong");
    const result = recordUserCorrectionFromRun({
      runDir,
      runId: "run-success-001",
      caseId: "user-found-missed-requirement",
      code: "USER_CORRECTED_PRODUCT_GAP",
      summary: "The run passed its gates, but it still violated the requested behavior.",
      evidence: ["user feedback"],
    });

    expect(result.created).toBe(true);
    expect(fs.existsSync(result.casePath)).toBe(true);
    expect(result.feedbackCase.status).toBe("corrected");
    expect(effectiveFeedbackConclusion(result.feedbackCase)).toMatchObject({
      source: "user",
      kind: "user_correction",
      code: "USER_CORRECTED_PRODUCT_GAP",
    });
  });

  it("preserves a correction-first case when a failure is recorded later", () => {
    const runDir = tempDir("feedback-correction-before-failure");
    const corrected = recordUserCorrectionFromRun({
      runDir,
      runId: "run-correction-first",
      caseId: "correction-first",
      summary: "The run violated the requested behavior despite passing automated gates.",
    });
    const correction = effectiveFeedbackConclusion(corrected.feedbackCase);

    const failed = recordFailure({
      runDir,
      runId: "run-correction-first",
      stage: "render",
      code: "LATE_FAILURE_CLASSIFICATION",
      message: "The failure was classified after the user correction was already accepted.",
    });

    expect(failed.feedbackCase.caseId).toBe("correction-first");
    expect(failed.feedbackCase.status).toBe("corrected");
    expect(effectiveFeedbackConclusion(failed.feedbackCase)?.id).toBe(correction?.id);
    expect(failed.feedbackCase.events).toHaveLength(2);
    expect(failed.feedbackCase.events[0]).toMatchObject({ source: "user", kind: "user_correction" });
    expect(failed.feedbackCase.events[1]).toMatchObject({ source: "system", kind: "failure" });
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

  it("keeps automated diagnoses advisory after a corrected case is resolved", () => {
    const runDir = tempDir("feedback-resolved-user-authority");
    const { casePath } = recordFailure({ runDir, stage: "qa", code: "OUTPUT_WRONG", message: "Failure." });
    recordUserCorrection(casePath, { summary: "User correction is authoritative." });
    const resolved = recordResolution(casePath, { summary: "Implementation fixed the corrected requirement." });
    const resolution = effectiveFeedbackConclusion(resolved);

    const afterAutomation = recordSystemDiagnosis(casePath, { summary: "Late automated alternative hypothesis." });
    const lastEvent = afterAutomation.events.at(-1);

    expect(afterAutomation.status).toBe("resolved");
    expect(effectiveFeedbackConclusion(afterAutomation)?.id).toBe(resolution?.id);
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

  it("refuses to promote a case before it is resolved and covered by a real regression test", () => {
    const root = tempDir("feedback-promote-guard");
    const runDir = path.join(root, ".ppt-agent", "runs", "run-001");
    fs.mkdirSync(runDir, { recursive: true });
    const { casePath } = recordFailure({ runDir, stage: "render", code: "OUTPUT_WRONG", message: "Failure." });
    recordUserCorrection(casePath, { summary: "Corrected requirement." });

    expect(() => promoteFeedbackCase(casePath, {
      projectDir: root,
      expectedBehavior: "Must not regress.",
      testPath: "tests/integration/missing.test.ts",
    })).toThrow(/FEEDBACK_PROMOTION_UNRESOLVED/);

    recordResolution(casePath, { summary: "Implementation fixed the corrected requirement." });
    expect(() => promoteFeedbackCase(casePath, {
      projectDir: root,
      expectedBehavior: "Must not regress.",
      testPath: "tests/integration/missing.test.ts",
    })).toThrow(/FEEDBACK_PROMOTION_TEST_MISSING/);
  });

  it("promotes a resolved corrected case into persistent regression knowledge without erasing the correction", () => {
    const root = tempDir("feedback-promote");
    const runDir = path.join(root, ".ppt-agent", "runs", "run-001");
    const testPath = path.join(root, "tests", "integration", "sparse-template-routing.test.ts");
    const fixturePath = path.join(root, "tests", "fixtures", "sparse-template-4x3.pptx");
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(testPath, "// regression placeholder for unit test\n");
    fs.writeFileSync(fixturePath, "fixture");

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
    const correctionId = effectiveFeedbackConclusion(corrected)?.id;
    const resolved = recordResolution(casePath, { summary: "Sparse brand-shell routing implemented and regression-covered." });
    expect(effectiveFeedbackConclusion(resolved)?.supersedes).toEqual([correctionId]);

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
    expect(promoted.events.some((event) => event.id === correctionId && event.source === "user" && event.kind === "user_correction")).toBe(true);
    expect(promoted.events.some((event) => event.kind === "promotion")).toBe(true);
  });

  it("refuses to overwrite an existing promoted regression case with the same case id", () => {
    const root = tempDir("feedback-promote-collision");
    const testPath = path.join(root, "tests", "integration", "collision.test.ts");
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, "// regression placeholder\n");

    const firstRun = path.join(root, ".ppt-agent", "runs", "run-001");
    fs.mkdirSync(firstRun, { recursive: true });
    const first = recordFailure({
      runDir: firstRun,
      stage: "render",
      code: "FIRST_FAILURE",
      message: "First failure.",
      caseId: "shared-regression-id",
    });
    recordResolution(first.casePath, { summary: "First implementation resolution." });
    const firstPromotion = promoteFeedbackCase(first.casePath, {
      projectDir: root,
      expectedBehavior: "Protect the first regression.",
      testPath: "tests/integration/collision.test.ts",
    });
    const originalPromoted = fs.readFileSync(firstPromotion.promotedPath, "utf8");

    const secondRun = path.join(root, ".ppt-agent", "runs", "run-002");
    fs.mkdirSync(secondRun, { recursive: true });
    const second = recordFailure({
      runDir: secondRun,
      stage: "render",
      code: "SECOND_FAILURE",
      message: "Second failure.",
      caseId: "shared-regression-id",
    });
    recordResolution(second.casePath, { summary: "Second implementation resolution." });

    expect(() => promoteFeedbackCase(second.casePath, {
      projectDir: root,
      expectedBehavior: "Must not replace the first regression.",
      testPath: "tests/integration/collision.test.ts",
    })).toThrow(/FEEDBACK_PROMOTION_CASE_EXISTS/);
    expect(fs.readFileSync(firstPromotion.promotedPath, "utf8")).toBe(originalPromoted);
  });
});
