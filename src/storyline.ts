import { z } from "zod";
import { contentModelSchema, contractSchema, sourceRefSchema, storyBeatSchema, type ContentModel, type SourceRef } from "./schema";
import type { QaFinding } from "./qa";
import { sha256 } from "./provenance";

export const storylineVisualStrategies = [
  "statement",
  "table",
  "chart",
  "before_after",
  "architecture",
  "roadmap",
  "timeline",
  "evidence",
] as const;

export const storylineSlideSchema = z.object({
  id: z.string().regex(/^S\d{2,}$/),
  storyBeat: storyBeatSchema,
  assertion: z.string().min(1),
  evidenceRefs: z.array(sourceRefSchema).min(1),
  implication: z.string().min(1),
  decisionImpact: z.string().min(1),
  visualStrategy: z.enum(storylineVisualStrategies),
  speakerNotes: z.string().default(""),
}).strict().superRefine((slide, ctx) => {
  const keys = slide.evidenceRefs.map((ref) => `${ref.sourceId}:${ref.excerptId}`);
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evidenceRefs"], message: "Storyline slide evidenceRefs must not contain duplicates." });
  }
});

export const storylineBlueprintSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1),
  narrativeThesis: z.string().min(1),
  audienceDecision: z.string().min(1),
  slides: z.array(storylineSlideSchema).min(3).max(30),
}).strict().superRefine((storyline, ctx) => {
  const ids = storyline.slides.map((slide) => slide.id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["slides"], message: "Storyline slide ids must be unique." });
  }
});

export type StorylineBlueprint = z.infer<typeof storylineBlueprintSchema>;
export type StorylineSlide = z.infer<typeof storylineSlideSchema>;

export const storylineFindingSeverity = {
  STORYLINE_SLIDE_COUNT_MISMATCH: "hard",
  STORYLINE_STORY_BEAT_DRIFT: "hard",
  STORYLINE_EVIDENCE_NOT_IN_CONTENT_MODEL: "hard",
  AUDIENCE_DECISION_DRIFT: "hard",
  THESIS_NOT_SUPPORTED: "hard",
  CONTRADICTORY_EVIDENCE: "hard",
  EVIDENCE_WITHOUT_IMPLICATION: "hard",
  DUPLICATE_ASSERTION: "risk",
  THESIS_NOT_ANSWER_FIRST: "risk",
  FACT_ONLY_SLIDE: "risk",
  ARGUMENT_GAP: "risk",
  WEAK_SO_WHAT: "risk",
  NARRATIVE_DEAD_END: "risk",
} as const;

type StorylineFindingCode = keyof typeof storylineFindingSeverity;
type StorylineJudgment = { slideId?: string; code: StorylineFindingCode; message: string };
export type StorylineQaReport = { status: "pass" | "review" | "fail"; findings: QaFinding[]; storyline: StorylineBlueprint };

function refKey(ref: SourceRef): string {
  return `${ref.sourceId}:${ref.excerptId}`;
}

function knownRefs(contentModel: ContentModel): Set<string> {
  return new Set(contentModel.sources.flatMap((source) => source.excerpts.map((excerpt) => `${source.sourceId}:${excerpt.id}`)));
}

function normalizedText(value: string): string {
  return value.toLocaleLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function finding(code: StorylineFindingCode, message: string, slideId?: string): QaFinding {
  return { code, message, slideId, severity: storylineFindingSeverity[code] };
}

export function storylineBlueprintDigest(input: unknown): string {
  return sha256(JSON.stringify(storylineBlueprintSchema.parse(input)));
}

export function validateStorylineBlueprint(
  storylineInput: unknown,
  contractInput: unknown,
  contentModelInput: unknown,
  judgmentInput: unknown = [],
): StorylineQaReport {
  const storyline = storylineBlueprintSchema.parse(storylineInput);
  const contract = contractSchema.parse(contractInput);
  const contentModel = contentModelSchema.parse(contentModelInput);
  const refs = knownRefs(contentModel);
  const findings: QaFinding[] = [];

  if (storyline.slides.length !== contract.slideCount) {
    findings.push(finding("STORYLINE_SLIDE_COUNT_MISMATCH", "Storyline slide count must equal contract.slideCount."));
  }
  if (contract.audienceDecision && normalizedText(storyline.audienceDecision) !== normalizedText(contract.audienceDecision)) {
    findings.push(finding("AUDIENCE_DECISION_DRIFT", "Storyline audienceDecision must preserve the GenerationContract audienceDecision."));
  }

  const assertionOwners = new Map<string, string>();
  for (const slide of storyline.slides) {
    if (!contract.storyline.includes(slide.storyBeat)) {
      findings.push(finding("STORYLINE_STORY_BEAT_DRIFT", `Story beat '${slide.storyBeat}' is absent from the contract storyline.`, slide.id));
    }
    for (const ref of slide.evidenceRefs) {
      if (!refs.has(refKey(ref))) {
        findings.push(finding("STORYLINE_EVIDENCE_NOT_IN_CONTENT_MODEL", `Evidence '${refKey(ref)}' is absent from the ContentModel.`, slide.id));
      }
    }
    const assertionKey = normalizedText(slide.assertion);
    const owner = assertionOwners.get(assertionKey);
    if (owner) {
      findings.push(finding("DUPLICATE_ASSERTION", `Assertion duplicates slide '${owner}'. Each slide should advance the argument.`, slide.id));
    } else {
      assertionOwners.set(assertionKey, slide.id);
    }
  }

  if (Array.isArray(judgmentInput)) {
    for (const value of judgmentInput) {
      if (!value || typeof value !== "object") continue;
      const judgment = value as Partial<StorylineJudgment>;
      if (typeof judgment.code === "string" && judgment.code in storylineFindingSeverity && typeof judgment.message === "string") {
        findings.push(finding(judgment.code as StorylineFindingCode, judgment.message, judgment.slideId));
      }
    }
  }

  return {
    storyline,
    findings,
    status: findings.some((item) => item.severity === "hard") ? "fail" : findings.some((item) => item.severity === "risk") ? "review" : "pass",
  };
}
