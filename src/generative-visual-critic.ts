import { z } from "zod";
import type { GenerativeAuthoringRequest } from "./generative-authoring";
import { generativeSceneIntentSchema, type GenerativeSceneIntent } from "./generative-scene";
import { sha256 } from "./provenance";

export const GENERATIVE_VISUAL_CRITIC_VERSION = 1 as const;

export const generativeCriticDimensions = [
  "visualHierarchy",
  "compositionBalance",
  "purposeFit",
  "readability",
  "professionalism",
  "templateFit",
] as const;

export type GenerativeCriticDimension = (typeof generativeCriticDimensions)[number];

export const generativeCriticFindingCodes = [
  "WEAK_VISUAL_HIERARCHY",
  "UNBALANCED_COMPOSITION",
  "WEAK_PURPOSE_FIT",
  "WEAK_READABILITY",
  "WEAK_PROFESSIONALISM",
  "TEMPLATE_STYLE_DRIFT",
  "TEMPLATE_HIERARCHY_DRIFT",
  "TEMPLATE_COMPOSITION_DRIFT",
  "EXCESSIVE_INFORMATION_DENSITY",
  "LOW_INFORMATION_DENSITY",
  "LAYOUT_REPETITION",
  "INCONSISTENT_SECTION_RHYTHM",
] as const;

export type GenerativeCriticFindingCode = (typeof generativeCriticFindingCodes)[number];

export const GENERATIVE_CRITIC_THRESHOLDS: Record<GenerativeCriticDimension, number> = {
  visualHierarchy: 7.5,
  compositionBalance: 7.5,
  purposeFit: 7,
  readability: 7.5,
  professionalism: 7.5,
  templateFit: 8,
};

type RenderedSceneInput = {
  slideId: string;
  imagePath: string;
  imageSha256: string;
  scene: GenerativeSceneIntent;
};

export type GenerativeVisualCriticRequest = {
  version: 1;
  requestDigest: string;
  sourceDigest: string;
  authoringRequestDigest: string;
  renderDigest: string;
  round: 0 | 1 | 2;
  rubric: {
    dimensions: readonly GenerativeCriticDimension[];
    thresholds: Record<GenerativeCriticDimension, number>;
    instruction: string;
  };
  slides: Array<{
    slideId: string;
    imagePath: string;
    imageSha256: string;
    semanticIntent: GenerativeSceneIntent["semanticIntent"];
    headline: string;
    compositionHint: string;
    scene: GenerativeSceneIntent;
  }>;
};

export type GenerativeVisualCriticInput = {
  authoringRequest: GenerativeAuthoringRequest;
  renderedScenes: RenderedSceneInput[];
  renderDigest: string;
  round: 0 | 1 | 2;
};

function digestPayload(request: Omit<GenerativeVisualCriticRequest, "requestDigest">): string {
  return sha256(JSON.stringify(request));
}

export function buildGenerativeVisualCriticRequest(input: GenerativeVisualCriticInput): GenerativeVisualCriticRequest {
  if (!/^[a-f0-9]{64}$/.test(input.renderDigest)) throw new Error("GENERATIVE_CRITIC_RENDER_DIGEST_INVALID: renderDigest must be a sha256 hex digest.");
  const authored = new Map(input.authoringRequest.slides.map((slide) => [slide.id, slide]));
  const received = input.renderedScenes.map((entry) => entry.slideId);
  if (new Set(received).size !== received.length) throw new Error("GENERATIVE_CRITIC_DUPLICATE_SLIDE: rendered slide ids must be unique.");
  const unexpected = received.filter((id) => !authored.has(id));
  const missing = [...authored.keys()].filter((id) => !received.includes(id));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(`GENERATIVE_CRITIC_SCENE_SET_MISMATCH: unexpected=[${unexpected.join(",")}] missing=[${missing.join(",")}].`);
  }

  const slides = input.renderedScenes.map((entry) => {
    if (!entry.imagePath.trim() || !/^[a-f0-9]{64}$/.test(entry.imageSha256)) {
      throw new Error(`GENERATIVE_CRITIC_RENDER_PROVENANCE_INVALID: slide '${entry.slideId}' requires a path and sha256 image digest.`);
    }
    const scene = generativeSceneIntentSchema.parse(entry.scene);
    const planned = authored.get(entry.slideId)!;
    if (scene.slideId !== entry.slideId || scene.semanticIntent !== planned.semanticIntent || scene.headline.replace(/\s+/g, " ").trim() !== planned.headline) {
      throw new Error(`GENERATIVE_CRITIC_SCENE_DRIFT: rendered Scene '${entry.slideId}' no longer matches its grounded authoring request.`);
    }
    return {
      slideId: entry.slideId,
      imagePath: entry.imagePath,
      imageSha256: entry.imageSha256,
      semanticIntent: scene.semanticIntent,
      headline: scene.headline,
      compositionHint: planned.compositionHint,
      scene,
    };
  });

  const payload: Omit<GenerativeVisualCriticRequest, "requestDigest"> = {
    version: GENERATIVE_VISUAL_CRITIC_VERSION,
    sourceDigest: input.authoringRequest.sourceDigest,
    authoringRequestDigest: input.authoringRequest.requestDigest,
    renderDigest: input.renderDigest,
    round: input.round,
    rubric: {
      dimensions: generativeCriticDimensions,
      thresholds: { ...GENERATIVE_CRITIC_THRESHOLDS },
      instruction: "Judge only the rendered visual result. Use reference/template cues as design language, not as geometry to copy. Prefer targeted Scene repair over full regeneration.",
    },
    slides,
  };
  return { ...payload, requestDigest: digestPayload(payload) };
}

const scoreSchema = z.object(Object.fromEntries(generativeCriticDimensions.map((dimension) => [dimension, z.number().min(0).max(10)])) as Record<GenerativeCriticDimension, z.ZodNumber>).strict();

const findingSchema = z.object({
  code: z.enum(generativeCriticFindingCodes),
  message: z.string().min(1),
  nodeIds: z.array(z.string().min(1)).max(12).default([]),
  repairable: z.boolean().default(true),
}).strict();

const slideJudgmentSchema = z.object({
  slideId: z.string().regex(/^S\d{2,}$/),
  scores: scoreSchema,
  findings: z.array(findingSchema).max(12).default([]),
  summary: z.string().min(1),
}).strict();

const responseSchema = z.object({
  version: z.literal(GENERATIVE_VISUAL_CRITIC_VERSION),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  renderDigest: z.string().regex(/^[a-f0-9]{64}$/),
  slides: z.array(slideJudgmentSchema),
  deckFindings: z.array(z.object({
    code: z.enum(["LAYOUT_REPETITION", "INCONSISTENT_SECTION_RHYTHM"]),
    message: z.string().min(1),
    slideIds: z.array(z.string().regex(/^S\d{2,}$/)).min(2),
  }).strict()).max(8).default([]),
}).strict();

export type GenerativeVisualCriticResponse = z.infer<typeof responseSchema>;

export type ParsedGenerativeCritic = {
  response: GenerativeVisualCriticResponse;
  repairSlideIds: string[];
  passedSlideIds: string[];
};

export function parseGenerativeVisualCriticResponse(request: GenerativeVisualCriticRequest, input: unknown): ParsedGenerativeCritic {
  const response = responseSchema.parse(input);
  if (response.requestDigest !== request.requestDigest || response.sourceDigest !== request.sourceDigest || response.renderDigest !== request.renderDigest) {
    throw new Error("GENERATIVE_CRITIC_RESPONSE_STALE: judgment does not belong to the current render/request/template.");
  }
  const expected = new Map(request.slides.map((slide) => [slide.slideId, slide]));
  const ids = response.slides.map((slide) => slide.slideId);
  if (new Set(ids).size !== ids.length) throw new Error("GENERATIVE_CRITIC_DUPLICATE_JUDGMENT: every slide must be judged once.");
  const unexpected = ids.filter((id) => !expected.has(id));
  const missing = [...expected.keys()].filter((id) => !ids.includes(id));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(`GENERATIVE_CRITIC_JUDGMENT_SET_MISMATCH: unexpected=[${unexpected.join(",")}] missing=[${missing.join(",")}].`);
  }

  const repair = new Set<string>();
  for (const judgment of response.slides) {
    const scene = expected.get(judgment.slideId)!.scene;
    const nodeIds = new Set(scene.layout.nodes.map((node) => node.id));
    for (const finding of judgment.findings) {
      const unknownNodes = finding.nodeIds.filter((id) => !nodeIds.has(id));
      if (unknownNodes.length > 0) throw new Error(`GENERATIVE_CRITIC_UNKNOWN_NODE: slide '${judgment.slideId}' finding references ${unknownNodes.join(", ")}.`);
      if (finding.repairable) repair.add(judgment.slideId);
    }
    for (const dimension of generativeCriticDimensions) {
      if (judgment.scores[dimension] < request.rubric.thresholds[dimension]) repair.add(judgment.slideId);
    }
  }
  response.deckFindings.forEach((finding) => finding.slideIds.forEach((slideId) => {
    if (!expected.has(slideId)) throw new Error(`GENERATIVE_CRITIC_UNKNOWN_DECK_SLIDE: '${slideId}'.`);
    repair.add(slideId);
  }));

  return {
    response,
    repairSlideIds: [...repair],
    passedSlideIds: [...expected.keys()].filter((id) => !repair.has(id)),
  };
}
