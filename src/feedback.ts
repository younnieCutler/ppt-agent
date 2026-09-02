import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const feedbackEventSourceSchema = z.enum(["system", "user", "maintainer"]);
export const feedbackEventKindSchema = z.enum(["failure", "diagnosis", "user_correction", "resolution", "promotion"]);

export const feedbackEventSchema = z.object({
  id: z.string().min(1),
  at: z.string().datetime(),
  source: feedbackEventSourceSchema,
  kind: feedbackEventKindSchema,
  summary: z.string().min(1),
  code: z.string().min(1).optional(),
  stage: z.string().min(1).optional(),
  evidence: z.array(z.string().min(1)).default([]),
  supersedes: z.array(z.string().min(1)).default([]),
  advisory: z.boolean().optional(),
}).strict();

export type FeedbackEvent = z.infer<typeof feedbackEventSchema>;

export const failureReportSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  at: z.string().datetime(),
  stage: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1),
  evidence: z.array(z.string().min(1)).default([]),
  casePath: z.string().min(1),
}).strict();

export type FailureReport = z.infer<typeof failureReportSchema>;

export const feedbackCaseSchema = z.object({
  version: z.literal(1),
  caseId: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  runId: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  status: z.enum(["observed", "corrected", "promoted", "resolved"]),
  events: z.array(feedbackEventSchema).min(1),
  effectiveConclusionEventId: z.string().min(1).optional(),
  regression: z.object({
    expectedBehavior: z.string().min(1),
    testPath: z.string().min(1),
    fixturePath: z.string().min(1).optional(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  const ids = value.events.map((event) => event.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["events"], message: "Feedback event ids must be unique." });
  if (value.effectiveConclusionEventId && !ids.includes(value.effectiveConclusionEventId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveConclusionEventId"], message: "Effective conclusion must reference an event in this case." });
  }
  for (const event of value.events) {
    const unknown = event.supersedes.filter((id) => !ids.includes(id));
    if (unknown.length > 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["events"], message: `Event '${event.id}' supersedes unknown event(s): ${unknown.join(", ")}.` });
  }
});

export type FeedbackCase = z.infer<typeof feedbackCaseSchema>;

function now(): string {
  return new Date().toISOString();
}

function eventId(kind: FeedbackEvent["kind"]): string {
  return `${kind}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

function safeCaseId(input: string): string {
  const value = input.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!value || value === "." || value === "..") throw new Error("FEEDBACK_CASE_ID_INVALID: case id must contain at least one safe alphanumeric character.");
  return value;
}

function writeJson(filePath: string, value: unknown): void {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, resolved);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function feedbackCasePath(runDir: string): string {
  return path.join(path.resolve(runDir), "feedback-case.json");
}

export function loadFeedbackCase(casePath: string): FeedbackCase {
  return feedbackCaseSchema.parse(JSON.parse(fs.readFileSync(path.resolve(casePath), "utf8")));
}

export function effectiveFeedbackConclusion(value: FeedbackCase): FeedbackEvent | undefined {
  return value.effectiveConclusionEventId ? value.events.find((event) => event.id === value.effectiveConclusionEventId) : undefined;
}

export function recordFailure(input: {
  runDir: string;
  runId?: string;
  stage: string;
  code: string;
  message: string;
  evidence?: string[];
  caseId?: string;
}): { report: FailureReport; feedbackCase: FeedbackCase; casePath: string; reportPath: string } {
  const resolvedRunDir = path.resolve(input.runDir);
  const runId = input.runId ?? path.basename(resolvedRunDir);
  const caseId = safeCaseId(input.caseId ?? `${input.code}-${crypto.createHash("sha256").update(`${runId}|${input.stage}|${input.message}`).digest("hex").slice(0, 8)}`);
  const at = now();
  const failure: FeedbackEvent = feedbackEventSchema.parse({
    id: eventId("failure"),
    at,
    source: "system",
    kind: "failure",
    summary: input.message,
    code: input.code,
    stage: input.stage,
    evidence: input.evidence ?? [],
    supersedes: [],
  });
  const feedbackCase: FeedbackCase = feedbackCaseSchema.parse({
    version: 1,
    caseId,
    runId,
    createdAt: at,
    updatedAt: at,
    status: "observed",
    events: [failure],
  });
  const casePath = feedbackCasePath(resolvedRunDir);
  writeJson(casePath, feedbackCase);
  const report: FailureReport = failureReportSchema.parse({
    version: 1,
    runId,
    at,
    stage: input.stage,
    code: input.code,
    message: input.message,
    evidence: input.evidence ?? [],
    casePath,
  });
  const reportPath = path.join(resolvedRunDir, "failure-report.json");
  writeJson(reportPath, report);
  return { report, feedbackCase, casePath, reportPath };
}

export function recordSystemDiagnosis(casePath: string, input: { summary: string; code?: string; evidence?: string[] }): FeedbackCase {
  const value = loadFeedbackCase(casePath);
  const current = effectiveFeedbackConclusion(value);
  const userHasAuthority = current?.source === "user" && current.kind === "user_correction";
  const event: FeedbackEvent = feedbackEventSchema.parse({
    id: eventId("diagnosis"),
    at: now(),
    source: "system",
    kind: "diagnosis",
    summary: input.summary,
    code: input.code,
    evidence: input.evidence ?? [],
    supersedes: userHasAuthority || !current ? [] : [current.id],
    ...(userHasAuthority ? { advisory: true } : {}),
  });
  const next: FeedbackCase = feedbackCaseSchema.parse({
    ...value,
    updatedAt: event.at,
    events: [...value.events, event],
    ...(userHasAuthority ? {} : { effectiveConclusionEventId: event.id }),
  });
  writeJson(casePath, next);
  return next;
}

export function recordUserCorrection(casePath: string, input: { summary: string; code?: string; evidence?: string[] }): FeedbackCase {
  const value = loadFeedbackCase(casePath);
  const current = effectiveFeedbackConclusion(value);
  const event: FeedbackEvent = feedbackEventSchema.parse({
    id: eventId("user_correction"),
    at: now(),
    source: "user",
    kind: "user_correction",
    summary: input.summary,
    code: input.code,
    evidence: input.evidence ?? [],
    supersedes: current ? [current.id] : [],
  });
  const next: FeedbackCase = feedbackCaseSchema.parse({
    ...value,
    updatedAt: event.at,
    status: "corrected",
    events: [...value.events, event],
    effectiveConclusionEventId: event.id,
  });
  writeJson(casePath, next);
  return next;
}

export function recordResolution(casePath: string, input: { summary: string; code?: string; evidence?: string[] }): FeedbackCase {
  const value = loadFeedbackCase(casePath);
  const current = effectiveFeedbackConclusion(value);
  const event: FeedbackEvent = feedbackEventSchema.parse({
    id: eventId("resolution"),
    at: now(),
    source: "maintainer",
    kind: "resolution",
    summary: input.summary,
    code: input.code,
    evidence: input.evidence ?? [],
    supersedes: current ? [current.id] : [],
  });
  const next: FeedbackCase = feedbackCaseSchema.parse({
    ...value,
    updatedAt: event.at,
    status: "resolved",
    events: [...value.events, event],
    effectiveConclusionEventId: event.id,
  });
  writeJson(casePath, next);
  return next;
}

export function promoteFeedbackCase(casePath: string, input: {
  projectDir: string;
  expectedBehavior: string;
  testPath: string;
  fixturePath?: string;
}): { feedbackCase: FeedbackCase; promotedPath: string } {
  const value = loadFeedbackCase(casePath);
  const effective = effectiveFeedbackConclusion(value);
  if (!effective) throw new Error("FEEDBACK_PROMOTION_NO_CONCLUSION: record a diagnosis or user correction before promotion.");
  const at = now();
  const promotion: FeedbackEvent = feedbackEventSchema.parse({
    id: eventId("promotion"),
    at,
    source: "maintainer",
    kind: "promotion",
    summary: `Promoted to regression coverage at ${input.testPath}.`,
    evidence: [input.testPath, ...(input.fixturePath ? [input.fixturePath] : [])],
    supersedes: [],
  });
  const next: FeedbackCase = feedbackCaseSchema.parse({
    ...value,
    updatedAt: at,
    status: "promoted",
    events: [...value.events, promotion],
    regression: {
      expectedBehavior: input.expectedBehavior,
      testPath: input.testPath,
      ...(input.fixturePath ? { fixturePath: input.fixturePath } : {}),
    },
  });
  writeJson(casePath, next);
  const promotedPath = path.join(path.resolve(input.projectDir), "feedback-cases", `${safeCaseId(next.caseId)}.json`);
  writeJson(promotedPath, next);
  return { feedbackCase: next, promotedPath };
}
