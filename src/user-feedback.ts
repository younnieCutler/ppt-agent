import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  feedbackCasePath,
  feedbackCaseSchema,
  feedbackEventSchema,
  recordUserCorrection,
  type FeedbackCase,
} from "./feedback";

function safeCaseId(input: string): string {
  const value = input.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!value || value === "." || value === "..") throw new Error("FEEDBACK_CASE_ID_INVALID: case id must contain at least one safe alphanumeric character.");
  return value;
}

function writeCase(casePath: string, value: FeedbackCase): void {
  const resolved = path.resolve(casePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, resolved);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * Accepts an explicit user correction even when the run was previously considered successful and
 * therefore has no failure-report/feedback-case yet. This closes the most important authority gap:
 * a user never has to convince the system to classify its own mistake as a failure before the
 * correction can become durable product evidence.
 */
export function recordUserCorrectionFromRun(input: {
  runDir: string;
  runId?: string;
  summary: string;
  code?: string;
  evidence?: string[];
  caseId?: string;
}): { feedbackCase: FeedbackCase; casePath: string; created: boolean } {
  const resolvedRunDir = path.resolve(input.runDir);
  const casePath = feedbackCasePath(resolvedRunDir);
  if (fs.existsSync(casePath)) {
    return {
      feedbackCase: recordUserCorrection(casePath, { summary: input.summary, code: input.code, evidence: input.evidence }),
      casePath,
      created: false,
    };
  }

  const runId = input.runId ?? path.basename(resolvedRunDir);
  const at = new Date().toISOString();
  const event = feedbackEventSchema.parse({
    id: `user_correction-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    at,
    source: "user",
    kind: "user_correction",
    summary: input.summary,
    code: input.code,
    evidence: input.evidence ?? [],
    supersedes: [],
  });
  const caseId = safeCaseId(input.caseId ?? `user-correction-${crypto.createHash("sha256").update(`${runId}|${input.summary}`).digest("hex").slice(0, 8)}`);
  const feedbackCase = feedbackCaseSchema.parse({
    version: 1,
    caseId,
    runId,
    createdAt: at,
    updatedAt: at,
    status: "corrected",
    events: [event],
    effectiveConclusionEventId: event.id,
  });
  writeCase(casePath, feedbackCase);
  return { feedbackCase, casePath, created: true };
}
