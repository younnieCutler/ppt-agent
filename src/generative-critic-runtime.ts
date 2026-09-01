import fs from "node:fs";
import path from "node:path";
import { compileTemplateConstraintProfile } from "./brand-constraints";
import type { GenerativeAuthoringRequest } from "./generative-authoring";
import { runBoundedGenerativeCriticLoop, type GenerativeCriticLoopCallbacks } from "./generative-critic-loop";
import { renderGenerativeDeckRuntime, type GenerativeDeckRuntimeInput, type GenerativeDeckRuntimeResult } from "./generative-deck-runtime";
import type { GenerativeSceneIntent } from "./generative-scene";
import type { GenerativeSceneRepairRequest } from "./generative-scene-repair";
import type { GenerativeVisualCriticRequest } from "./generative-visual-critic";
import { sha256File } from "./provenance";
import { selectBackend, type VisualRenderBackend } from "./visual";

export type GenerativeCriticRuntimeInput = GenerativeDeckRuntimeInput & {
  authoringRequest: GenerativeAuthoringRequest;
  judge: (request: GenerativeVisualCriticRequest) => Promise<unknown>;
  repair: (request: GenerativeSceneRepairRequest) => Promise<unknown>;
  visualBackend?: VisualRenderBackend;
};

export type GenerativeCriticRuntimeResult = GenerativeDeckRuntimeResult & {
  critic: {
    rounds: number;
    history: Array<{
      round: 0 | 1 | 2;
      criticRequestDigest: string;
      renderDigest: string;
      repairSlideIds: string[];
      passedSlideIds: string[];
    }>;
  };
  scenesBySlide: Map<string, GenerativeSceneIntent>;
};

function sameSet(left: Iterable<string>, right: Iterable<string>): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((value) => b.has(value));
}

function atomicPublish(sourcePath: string, outputPath: string): void {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.critic-pass.tmp`;
  try {
    fs.copyFileSync(sourcePath, temporary);
    if (sha256File(sourcePath) !== sha256File(temporary)) throw new Error("GENERATIVE_CRITIC_PUBLISH_INTEGRITY_FAILED: judged deck changed while staging publication.");
    fs.renameSync(temporary, resolved);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * Executes the full visual-quality gate for generative slides. The final file is not authored to
 * input.outputPath until a rendered deck has passed the critic. A failed/exhausted run deliberately
 * preserves its workspace beside the requested output so the exact judged PNG/PPTX artifacts remain
 * available for debugging.
 */
export async function renderGenerativeDeckWithVisualCritic(input: GenerativeCriticRuntimeInput): Promise<GenerativeCriticRuntimeResult> {
  const targetIds = input.authoringRequest.slides.map((slide) => slide.id);
  if (targetIds.length === 0) throw new Error("GENERATIVE_CRITIC_RUNTIME_NO_TARGETS: visual critic requires at least one generative slide.");
  if (input.authoringRequest.sourceDigest !== input.elements.source.sha256) throw new Error("GENERATIVE_CRITIC_RUNTIME_PROVENANCE_MISMATCH: authoring request and template extraction differ.");
  const initialScenes = new Map<string, GenerativeSceneIntent>();
  for (const slideId of targetIds) {
    const scene = input.scenesBySlide.get(slideId);
    if (!scene) throw new Error(`GENERATIVE_CRITIC_RUNTIME_SCENE_MISSING: '${slideId}' has no authored Scene.`);
    initialScenes.set(slideId, scene);
  }

  const outputDir = path.dirname(path.resolve(input.outputPath));
  fs.mkdirSync(outputDir, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(outputDir, `.ppt-agent-generative-critic-${process.pid}-`));
  const brandProfile = compileTemplateConstraintProfile(input.elements, input.designSystem);
  const backend = input.visualBackend ?? selectBackend();
  let lastJudgedDeckPath: string | undefined;
  let lastRuntime: GenerativeDeckRuntimeResult | undefined;
  let success = false;

  const render: GenerativeCriticLoopCallbacks["render"] = async (scenes, round) => {
    const roundDir = path.join(workspace, `round-${round}`);
    fs.mkdirSync(roundDir, { recursive: true });
    const deckPath = path.join(roundDir, "deck.pptx");
    const runtime = await renderGenerativeDeckRuntime({ ...input, outputPath: deckPath, scenesBySlide: scenes });
    const generatedIds = runtime.manifest.filter((entry) => entry.mode === "generative_scene").map((entry) => entry.slideId);
    if (!sameSet(generatedIds, targetIds)) {
      throw new Error(`GENERATIVE_CRITIC_RUNTIME_TARGET_DRIFT: rendered generative slides [${generatedIds.join(",")}] differ from authoring targets [${targetIds.join(",")}].`);
    }
    const slideMap = targetIds.map((slideId) => {
      const index = input.slides.findIndex((slide) => slide.id === slideId);
      if (index < 0) throw new Error(`GENERATIVE_CRITIC_RUNTIME_SLIDE_MISSING: '${slideId}' is absent from deck order.`);
      return { slideId, index: index + 1 };
    });
    const rendered = await backend.render(deckPath, roundDir, slideMap);
    const byId = new Map(rendered.map((entry) => [entry.slideId, entry]));
    const slides = targetIds.map((slideId) => {
      const image = byId.get(slideId);
      if (!image || !fs.existsSync(image.path)) throw new Error(`GENERATIVE_CRITIC_RUNTIME_RENDER_MISSING: no judged image for '${slideId}'.`);
      return { slideId, imagePath: image.path, imageSha256: sha256File(image.path) };
    });
    lastJudgedDeckPath = deckPath;
    lastRuntime = runtime;
    return { renderDigest: sha256File(deckPath), slides };
  };

  try {
    const critic = await runBoundedGenerativeCriticLoop({
      authoringRequest: input.authoringRequest,
      initialScenes,
      brandProfile,
      callbacks: { render, judge: input.judge, repair: input.repair },
    });
    if (!lastJudgedDeckPath || !lastRuntime) throw new Error("GENERATIVE_CRITIC_RUNTIME_NO_JUDGED_DECK: critic passed without a rendered deck.");
    // Critical invariant: publish the exact PPTX whose image digest was judged on the passing round.
    // Do not render again after judgment; that would produce a new, unjudged artifact.
    atomicPublish(lastJudgedDeckPath, input.outputPath);
    success = true;
    return {
      ...lastRuntime,
      outputPath: path.resolve(input.outputPath),
      critic: { rounds: critic.rounds, history: critic.history },
      scenesBySlide: critic.scenes,
    };
  } finally {
    if (success) fs.rmSync(workspace, { recursive: true, force: true });
  }
}
