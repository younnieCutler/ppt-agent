import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Automizer from "pptx-automizer";
import { compileTemplateConstraintProfile, type TemplateConstraintProfile } from "./brand-constraints";
import { compileGenerativeSceneComponentPlan, type GenerativeSceneComponentPlan } from "./generative-scene-components";
import { runGenerativeSceneQa, type GenerativeSceneQaReport } from "./generative-scene-qa";
import { generativeSceneIntentSchema, resolveGenerativeScene, type GenerativeSceneIntent, type ResolvedGenerativeScene } from "./generative-scene";
import { transformTemplateComponents } from "./template-transform";
import { TEMPLATE_COMPONENTS_COMPILER_VERSION, type TemplateComponentsArtifact } from "./template-components";
import { TEMPLATE_DESIGN_SYSTEM_COMPILER_VERSION, type TemplateDesignSystemArtifact } from "./template-design-system";
import { assertCanonicalTemplateElements, elementsDigest, type TemplateElementsArtifact } from "./template-analysis";
import { pruneUnreachablePptxParts } from "./ooxml";

export type GenerativeSceneRuntimeInput = {
  templatePath: string;
  outputPath: string;
  intent: GenerativeSceneIntent;
  elements: TemplateElementsArtifact;
  designSystem: TemplateDesignSystemArtifact;
  components: TemplateComponentsArtifact;
  baseSlideId?: string;
};

export type GenerativeSceneRuntimeResult = {
  outputPath: string;
  baseSlideId: string;
  baseSlideNumber: number;
  brandProfile: TemplateConstraintProfile;
  scene: ResolvedGenerativeScene;
  componentPlan: GenerativeSceneComponentPlan;
  qa: GenerativeSceneQaReport;
};

type BaseCandidate = {
  slideId: string;
  slideNumber: number;
  plan: GenerativeSceneComponentPlan;
  score: [number, number, number, number];
};

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sameCoordinateSpace(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function verifyArtifacts(input: GenerativeSceneRuntimeInput): void {
  if (!fs.existsSync(path.resolve(input.templatePath))) throw new Error(`GENERATIVE_RUNTIME_TEMPLATE_MISSING: template not found: ${input.templatePath}`);
  assertCanonicalTemplateElements(input.elements);
  const templateDigest = sha256File(path.resolve(input.templatePath));
  const digest = elementsDigest(input.elements);
  if (templateDigest !== input.elements.source.sha256
    || input.components.sourceDigest !== templateDigest
    || input.designSystem.sourceDigest !== templateDigest
    || input.components.elementsDigest !== digest
    || input.designSystem.elementsDigest !== digest
    || input.components.compilerVersion !== TEMPLATE_COMPONENTS_COMPILER_VERSION
    || input.designSystem.compilerVersion !== TEMPLATE_DESIGN_SYSTEM_COMPILER_VERSION) {
    throw new Error("GENERATIVE_RUNTIME_PROVENANCE_MISMATCH: template artifacts do not describe the current raw PPTX extraction.");
  }
  if (!input.elements.coordinateSpace || !input.components.coordinateSpace || !input.designSystem.coordinateSpace
    || !sameCoordinateSpace(input.elements.coordinateSpace, input.components.coordinateSpace)
    || !sameCoordinateSpace(input.elements.coordinateSpace, input.designSystem.coordinateSpace)) {
    throw new Error("GENERATIVE_RUNTIME_PROVENANCE_MISMATCH: runtime artifacts disagree on canonical coordinate space.");
  }
}

function dominantBackground(elements: TemplateElementsArtifact): string | undefined {
  const counts = new Map<string, number>();
  for (const slide of elements.slides) {
    if (!slide.background) continue;
    counts.set(slide.background, (counts.get(slide.background) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
}

function baseScore(input: GenerativeSceneRuntimeInput, slideId: string, slideNumber: number, plan: GenerativeSceneComponentPlan): [number, number, number, number] {
  const slide = input.elements.slides[slideNumber - 1];
  const mode = dominantBackground(input.elements);
  const bodyScene = input.intent.semanticIntent !== "cover";
  const backgroundFit = bodyScene ? Number(Boolean(mode) && slide?.background === mode) : Number(Boolean(mode) && slide?.background !== mode);
  const removedCount = plan.operations.filter((operation) => operation.operation === "remove").length;
  return [backgroundFit, plan.preservedImmutableComponentIds.length, -removedCount, -slideNumber];
}

function compareScore(left: BaseCandidate, right: BaseCandidate): number {
  for (let index = 0; index < left.score.length; index += 1) {
    if (left.score[index] !== right.score[index]) return right.score[index] - left.score[index];
  }
  return left.slideId.localeCompare(right.slideId);
}

function selectBase(input: GenerativeSceneRuntimeInput, scene: ResolvedGenerativeScene, brandProfile: TemplateConstraintProfile): BaseCandidate {
  const candidates: BaseCandidate[] = [];
  for (const [index, slide] of input.elements.slides.entries()) {
    if (input.baseSlideId && slide.id !== input.baseSlideId) continue;
    try {
      const plan = compileGenerativeSceneComponentPlan(scene, slide.id, input.components, brandProfile);
      candidates.push({ slideId: slide.id, slideNumber: index + 1, plan, score: baseScore(input, slide.id, index + 1, plan) });
    } catch (error) {
      if (input.baseSlideId) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/^GENERATIVE_BASE_(?:UNSUPPORTED|UNSANITIZABLE)/.test(message)) throw error;
    }
  }
  candidates.sort(compareScore);
  const selected = candidates[0];
  if (!selected) throw new Error(`GENERATIVE_RUNTIME_BASE_UNSUPPORTED: no template source slide can serve as a sanitizable generative base${input.baseSlideId ? ` '${input.baseSlideId}'` : ""}.`);
  return selected;
}

async function extractSingleSlide(templatePath: string, outputPath: string, sourceSlideNumber: number): Promise<void> {
  const resolvedOutput = path.resolve(outputPath);
  const outputDir = path.dirname(resolvedOutput);
  fs.mkdirSync(outputDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(outputDir, `.ppt-agent-generative-extract-${process.pid}-`));
  const rootName = "generative-transformed.pptx";
  try {
    fs.copyFileSync(path.resolve(templatePath), path.join(staging, rootName));
    const automizer = new Automizer({ templateDir: staging, outputDir, removeExistingSlides: true });
    const presentation = automizer.loadRoot(rootName).load(rootName, "generative-source");
    presentation.addSlide("generative-source", sourceSlideNumber);
    await presentation.write(path.basename(resolvedOutput));
    if (!fs.existsSync(resolvedOutput)) throw new Error(`GENERATIVE_RUNTIME_ASSEMBLY_FAILED: single-slide output was not produced at ${resolvedOutput}.`);
    await pruneUnreachablePptxParts(resolvedOutput);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export async function renderGenerativeSceneRuntime(input: GenerativeSceneRuntimeInput): Promise<GenerativeSceneRuntimeResult> {
  const parsedIntent = generativeSceneIntentSchema.parse(input.intent);
  const normalized: GenerativeSceneRuntimeInput = { ...input, intent: parsedIntent };
  verifyArtifacts(normalized);
  const brandProfile = compileTemplateConstraintProfile(normalized.elements, normalized.designSystem);
  const scene = resolveGenerativeScene(parsedIntent, brandProfile);
  const selected = selectBase(normalized, scene, brandProfile);
  const resolvedOutput = path.resolve(normalized.outputPath);
  const outputDir = path.dirname(resolvedOutput);
  fs.mkdirSync(outputDir, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(outputDir, `.ppt-agent-generative-runtime-${process.pid}-`));
  let success = false;
  try {
    const transformed = path.join(workspace, "transformed-template.pptx");
    const prepared = path.join(workspace, "prepared-generative-scene.pptx");
    await transformTemplateComponents(normalized.templatePath, transformed, normalized.components, selected.plan.operations);
    await extractSingleSlide(transformed, prepared, selected.slideNumber);
    const qa = await runGenerativeSceneQa({
      templatePath: normalized.templatePath,
      outputPath: prepared,
      scene,
      componentPlan: selected.plan,
      components: normalized.components,
      elements: normalized.elements,
      brandProfile,
    });
    if (qa.status !== "pass") throw new Error(`GENERATIVE_RUNTIME_QA_FAILED: ${qa.findings.map((finding) => finding.code).join(", ")}; workspace preserved at ${workspace}`);

    const temporary = `${resolvedOutput}.${process.pid}.tmp`;
    try {
      fs.copyFileSync(prepared, temporary);
      if (sha256File(prepared) !== sha256File(temporary)) throw new Error("GENERATIVE_RUNTIME_PUBLISH_INTEGRITY_FAILED: staged final PPTX digest differs from prepared output.");
      fs.renameSync(temporary, resolvedOutput);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    success = true;
    return { outputPath: resolvedOutput, baseSlideId: selected.slideId, baseSlideNumber: selected.slideNumber, brandProfile, scene, componentPlan: selected.plan, qa };
  } finally {
    if (success) fs.rmSync(workspace, { recursive: true, force: true });
  }
}
