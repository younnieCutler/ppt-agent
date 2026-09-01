import type { TemplateConstraintProfile } from "./brand-constraints";
import type { GenerativeAuthoringRequest } from "./generative-authoring";
import type { GenerativeSceneIntent } from "./generative-scene";
import {
  buildGenerativeVisualCriticRequest,
  parseGenerativeVisualCriticResponse,
  type GenerativeVisualCriticRequest,
  type ParsedGenerativeCritic,
} from "./generative-visual-critic";
import {
  applyGenerativeSceneRepair,
  buildGenerativeSceneRepairRequest,
  MAX_GENERATIVE_REPAIR_ROUNDS,
  type GenerativeSceneRepairRequest,
} from "./generative-scene-repair";

export type GenerativeCriticRenderResult = {
  renderDigest: string;
  slides: Array<{ slideId: string; imagePath: string; imageSha256: string }>;
};

export type GenerativeCriticLoopCallbacks = {
  render: (scenes: Map<string, GenerativeSceneIntent>, round: 0 | 1 | 2) => Promise<GenerativeCriticRenderResult>;
  judge: (request: GenerativeVisualCriticRequest) => Promise<unknown>;
  repair: (request: GenerativeSceneRepairRequest) => Promise<unknown>;
};

export type GenerativeCriticLoopInput = {
  authoringRequest: GenerativeAuthoringRequest;
  initialScenes: Map<string, GenerativeSceneIntent>;
  brandProfile: TemplateConstraintProfile;
  callbacks: GenerativeCriticLoopCallbacks;
};

export type GenerativeCriticLoopResult = {
  status: "pass";
  scenes: Map<string, GenerativeSceneIntent>;
  rounds: number;
  history: Array<{
    round: 0 | 1 | 2;
    criticRequestDigest: string;
    renderDigest: string;
    repairSlideIds: string[];
    passedSlideIds: string[];
  }>;
};

function verifySceneSet(authoringRequest: GenerativeAuthoringRequest, scenes: Map<string, GenerativeSceneIntent>): void {
  const expected = authoringRequest.slides.map((slide) => slide.id);
  const unexpected = [...scenes.keys()].filter((id) => !expected.includes(id));
  const missing = expected.filter((id) => !scenes.has(id));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(`GENERATIVE_CRITIC_LOOP_SCENE_SET_MISMATCH: unexpected=[${unexpected.join(",")}] missing=[${missing.join(",")}].`);
  }
}

function renderedScenes(
  authoringRequest: GenerativeAuthoringRequest,
  scenes: Map<string, GenerativeSceneIntent>,
  render: GenerativeCriticRenderResult,
): Array<{ slideId: string; imagePath: string; imageSha256: string; scene: GenerativeSceneIntent }> {
  const images = new Map(render.slides.map((slide) => [slide.slideId, slide]));
  const duplicates = render.slides.map((slide) => slide.slideId);
  if (new Set(duplicates).size !== duplicates.length) throw new Error("GENERATIVE_CRITIC_LOOP_DUPLICATE_RENDER: each rendered slide id must be unique.");
  return authoringRequest.slides.map((planned) => {
    const scene = scenes.get(planned.id);
    const image = images.get(planned.id);
    if (!scene || !image) throw new Error(`GENERATIVE_CRITIC_LOOP_RENDER_MISSING: '${planned.id}' is missing a Scene or rendered image.`);
    return { ...image, scene };
  });
}

export async function runBoundedGenerativeCriticLoop(input: GenerativeCriticLoopInput): Promise<GenerativeCriticLoopResult> {
  verifySceneSet(input.authoringRequest, input.initialScenes);
  let scenes = new Map(input.initialScenes);
  const history: GenerativeCriticLoopResult["history"] = [];

  for (let round = 0 as 0 | 1 | 2; round <= MAX_GENERATIVE_REPAIR_ROUNDS; round = (round + 1) as 0 | 1 | 2) {
    const render = await input.callbacks.render(scenes, round);
    const criticRequest = buildGenerativeVisualCriticRequest({
      authoringRequest: input.authoringRequest,
      renderedScenes: renderedScenes(input.authoringRequest, scenes, render),
      renderDigest: render.renderDigest,
      round,
    });
    const judgmentInput = await input.callbacks.judge(criticRequest);
    const judgment: ParsedGenerativeCritic = parseGenerativeVisualCriticResponse(criticRequest, judgmentInput);
    history.push({
      round,
      criticRequestDigest: criticRequest.requestDigest,
      renderDigest: render.renderDigest,
      repairSlideIds: [...judgment.repairSlideIds],
      passedSlideIds: [...judgment.passedSlideIds],
    });

    if (judgment.repairSlideIds.length === 0) {
      return { status: "pass", scenes, rounds: round, history };
    }
    if (round >= MAX_GENERATIVE_REPAIR_ROUNDS) {
      throw new Error(`GENERATIVE_CRITIC_REPAIR_EXHAUSTED: visual quality remained below threshold after ${MAX_GENERATIVE_REPAIR_ROUNDS} repairs for ${judgment.repairSlideIds.join(", ")}.`);
    }

    const next = new Map(scenes);
    for (const slideId of judgment.repairSlideIds) {
      const repairRequest = buildGenerativeSceneRepairRequest(criticRequest, judgment.response, slideId);
      const patch = await input.callbacks.repair(repairRequest);
      next.set(slideId, applyGenerativeSceneRepair(repairRequest, patch, input.brandProfile));
    }
    scenes = next;
  }

  throw new Error("GENERATIVE_CRITIC_LOOP_UNREACHABLE: bounded critic loop exited unexpectedly.");
}
