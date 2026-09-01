import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Automizer from "pptx-automizer";
import { diagnoseAdaptiveMode, type AdaptiveSelectionCandidate } from "./adaptive-selection";
import type { GenerativeNativeAssetRegistry } from "./generative-native-primitives";
import { generativeSceneIntentSchema, isGenerativeTextNode, type GenerativeSceneIntent } from "./generative-scene";
import { renderGenerativeSceneRuntime } from "./generative-scene-runtime";
import { readPptxOoxml, pruneUnreachablePptxParts } from "./ooxml";
import { assertPptxPackageIntegrity, type PackageIntegrityReport } from "./package-integrity";
import { slideSchema, type SlideSpec } from "./schema";
import { applyPatternSkeleton } from "./template";
import { assertCanonicalTemplateElements, elementsDigest, type TemplateElementsArtifact } from "./template-analysis";
import { TEMPLATE_COMPONENTS_COMPILER_VERSION, type TemplateComponentsArtifact } from "./template-components";
import { TEMPLATE_DESIGN_SYSTEM_COMPILER_VERSION, type TemplateDesignSystemArtifact } from "./template-design-system";
import type { TemplatePattern } from "./template-patterns";
import { compileTemplateSemantics, sourceSlideUsage, type TemplateSemanticsProfile } from "./template-semantics";

export type GenerativeDeckRuntimeInput = {
  templatePath: string;
  outputPath: string;
  slides: SlideSpec[];
  candidatesBySlide: Map<string, AdaptiveSelectionCandidate[]>;
  scenesBySlide: Map<string, GenerativeSceneIntent>;
  elements: TemplateElementsArtifact;
  designSystem: TemplateDesignSystemArtifact;
  components: TemplateComponentsArtifact;
  nativeAssets?: GenerativeNativeAssetRegistry;
};

export type GenerativeDeckDecision =
  | { slideId: string; mode: "exact_clone"; patternId: string; sourceSlideId: string; sourceSlideNumber: number }
  | { slideId: string; mode: "generative_scene"; baseSlideId: string; baseSlideNumber: number };

export type GenerativeDeckRuntimeResult = {
  outputPath: string;
  decisions: GenerativeDeckDecision[];
  manifest: Array<{ slideId: string; mode: "exact_clone" | "generative_scene" }>;
  packageIntegrity: PackageIntegrityReport;
};

type PlannedSlide =
  | { slide: SlideSpec; mode: "exact_clone"; pattern: TemplatePattern }
  | { slide: SlideSpec; mode: "generative_scene"; scene: GenerativeSceneIntent };
type PreparedSlide = { slideId: string; path: string; mode: "exact_clone" | "generative_scene" };

const semanticIntentByLayout: Record<SlideSpec["layout"], GenerativeSceneIntent["semanticIntent"]> = {
  title: "cover", statement: "statement", comparison: "comparison", process: "process", pipeline: "architecture",
  architecture: "architecture", quantitative: "quantitative", timeline: "timeline", evidence: "evidence", chart: "quantitative",
};

function sha256File(filePath: string): string { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }
function sameCoordinateSpace(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function normalizeText(value: string): string { return value.replace(/\s+/g, " ").trim(); }

function verifyArtifacts(input: GenerativeDeckRuntimeInput): void {
  if (!fs.existsSync(path.resolve(input.templatePath))) throw new Error(`GENERATIVE_DECK_TEMPLATE_MISSING: template not found: ${input.templatePath}`);
  if (input.slides.length === 0) throw new Error("GENERATIVE_DECK_EMPTY: at least one slide is required.");
  assertCanonicalTemplateElements(input.elements);
  const templateDigest = sha256File(path.resolve(input.templatePath));
  const digest = elementsDigest(input.elements);
  if (templateDigest !== input.elements.source.sha256 || input.components.sourceDigest !== templateDigest || input.designSystem.sourceDigest !== templateDigest
    || input.components.elementsDigest !== digest || input.designSystem.elementsDigest !== digest
    || input.components.compilerVersion !== TEMPLATE_COMPONENTS_COMPILER_VERSION || input.designSystem.compilerVersion !== TEMPLATE_DESIGN_SYSTEM_COMPILER_VERSION) {
    throw new Error("GENERATIVE_DECK_PROVENANCE_MISMATCH: template artifacts do not describe the current raw PPTX extraction.");
  }
  if (!input.elements.coordinateSpace || !input.components.coordinateSpace || !input.designSystem.coordinateSpace
    || !sameCoordinateSpace(input.elements.coordinateSpace, input.components.coordinateSpace)
    || !sameCoordinateSpace(input.elements.coordinateSpace, input.designSystem.coordinateSpace)) {
    throw new Error("GENERATIVE_DECK_PROVENANCE_MISMATCH: deck runtime artifacts disagree on canonical coordinate space.");
  }
}

function assertMapKeysBelongToDeck(name: string, map: Map<string, unknown>, slideIds: Set<string>): void {
  const unknown = [...map.keys()].filter((id) => !slideIds.has(id));
  if (unknown.length > 0) throw new Error(`GENERATIVE_DECK_UNKNOWN_${name.toUpperCase()}_SLIDE: ${unknown.join(", ")}`);
}

function exactPatternForSlide(input: GenerativeDeckRuntimeInput, slide: SlideSpec, semantics: TemplateSemanticsProfile): TemplatePattern | undefined {
  const candidates = [...(input.candidatesBySlide.get(slide.id) ?? [])].sort((left, right) => left.rank - right.rank || left.pattern.id.localeCompare(right.pattern.id));
  for (const candidate of candidates) {
    if (sourceSlideUsage(semantics, candidate.pattern.sourceSlideId) !== "structural_template") continue;
    const decision = diagnoseAdaptiveMode({ templateDigest: input.components.sourceDigest, slide, candidates: [candidate], designSystem: input.designSystem, components: input.components });
    if (decision.mode === "exact_clone") return candidate.pattern;
  }
  return undefined;
}

function validateSceneForSlide(slide: SlideSpec, scene: GenerativeSceneIntent): GenerativeSceneIntent {
  const parsed = generativeSceneIntentSchema.parse(scene);
  if (parsed.slideId !== slide.id) throw new Error(`GENERATIVE_DECK_SCENE_ID_MISMATCH: slide '${slide.id}' received Scene '${parsed.slideId}'.`);
  const expected = semanticIntentByLayout[slide.layout];
  if (parsed.semanticIntent !== expected) throw new Error(`GENERATIVE_DECK_SEMANTIC_MISMATCH: slide '${slide.id}' layout '${slide.layout}' requires semanticIntent '${expected}', received '${parsed.semanticIntent}'.`);
  if (normalizeText(parsed.headline) !== normalizeText(slide.headline)) throw new Error(`GENERATIVE_DECK_HEADLINE_MISMATCH: Scene '${slide.id}' headline must preserve the SlideSpec headline.`);
  const headlineNodes = parsed.layout.nodes.filter(isGenerativeTextNode).filter((node) => node.role === "headline");
  if (headlineNodes.length !== 1 || normalizeText(headlineNodes[0].text) !== normalizeText(slide.headline)) throw new Error(`GENERATIVE_DECK_HEADLINE_NODE_REQUIRED: Scene '${slide.id}' must render exactly one headline node matching the SlideSpec headline.`);
  return parsed;
}

function planSlides(input: GenerativeDeckRuntimeInput): PlannedSlide[] {
  const slides = input.slides.map((slide) => slideSchema.parse(slide) as SlideSpec);
  const ids = slides.map((slide) => slide.id);
  if (new Set(ids).size !== ids.length) throw new Error("GENERATIVE_DECK_DUPLICATE_SLIDE_ID: slide ids must be unique.");
  const slideIds = new Set(ids);
  assertMapKeysBelongToDeck("scene", input.scenesBySlide as Map<string, unknown>, slideIds);
  assertMapKeysBelongToDeck("candidate", input.candidatesBySlide as Map<string, unknown>, slideIds);
  const semantics = compileTemplateSemantics(input.elements);
  return slides.map((slide) => {
    const pattern = exactPatternForSlide(input, slide, semantics);
    if (pattern) return { slide, mode: "exact_clone" as const, pattern };
    const scene = input.scenesBySlide.get(slide.id);
    if (!scene) throw new Error(`GENERATIVE_DECK_SCENE_MISSING: slide '${slide.id}' has no structural exact template fit and therefore requires a Generative Scene.`);
    return { slide, mode: "generative_scene" as const, scene: validateSceneForSlide(slide, scene) };
  });
}

function sourceSlideNumber(elements: TemplateElementsArtifact, slideId: string): number {
  const index = elements.slides.findIndex((slide) => slide.id === slideId);
  if (index < 0) throw new Error(`GENERATIVE_DECK_PATTERN_PROVENANCE_MISSING: source slide '${slideId}' is absent from the current extraction.`);
  return index + 1;
}

function nativeAssetsForSlide(input: GenerativeDeckRuntimeInput, slide: SlideSpec): GenerativeNativeAssetRegistry {
  const images = { ...(input.nativeAssets?.images ?? {}) };
  if (slide.layout === "title" && slide.content.imagePath) images[`${slide.id}.image`] = slide.content.imagePath;
  if (slide.layout === "evidence" && slide.content.assetPath) images[`${slide.id}.image`] = slide.content.assetPath;
  return { ...(input.nativeAssets?.datasets ? { datasets: input.nativeAssets.datasets } : {}), ...(Object.keys(images).length > 0 ? { images } : {}) };
}

async function renderExactSlide(input: GenerativeDeckRuntimeInput, planned: Extract<PlannedSlide, { mode: "exact_clone" }>, outputPath: string): Promise<GenerativeDeckDecision> {
  const manifest = await applyPatternSkeleton(input.templatePath, input.templatePath, outputPath, [planned.slide], new Map([[planned.slide.id, planned.pattern]]), { strategy: input.elements.strategy });
  if (manifest.length !== 1 || !manifest[0].mode.startsWith("pattern:")) throw new Error(`GENERATIVE_DECK_EXACT_CLONE_FAILED: slide '${planned.slide.id}' did not stay on the template-native exact path.`);
  const facts = await readPptxOoxml(outputPath);
  if (!facts.parseOk || facts.slideCount !== 1) throw new Error(`GENERATIVE_DECK_EXACT_CLONE_FAILED: slide '${planned.slide.id}' did not produce one parseable PPTX slide.`);
  return { slideId: planned.slide.id, mode: "exact_clone", patternId: planned.pattern.id, sourceSlideId: planned.pattern.sourceSlideId, sourceSlideNumber: sourceSlideNumber(input.elements, planned.pattern.sourceSlideId) };
}

async function assemblePreparedSlides(templatePath: string, outputPath: string, prepared: PreparedSlide[]): Promise<void> {
  const outputDir = path.dirname(path.resolve(outputPath));
  fs.mkdirSync(outputDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(outputDir, `.ppt-agent-generative-deck-assembly-${process.pid}-`));
  const rootName = "raw-template.pptx";
  try {
    fs.copyFileSync(path.resolve(templatePath), path.join(staging, rootName));
    const automizer = new Automizer({ templateDir: staging, outputDir, removeExistingSlides: true });
    let presentation = automizer.loadRoot(rootName);
    const aliases: string[] = [];
    for (const [index, entry] of prepared.entries()) {
      const fileName = `prepared-${String(index + 1).padStart(3, "0")}.pptx`;
      const alias = `prepared-${index + 1}`;
      fs.copyFileSync(entry.path, path.join(staging, fileName));
      presentation = presentation.load(fileName, alias);
      aliases.push(alias);
    }
    const info = await presentation.getInfo();
    for (const alias of aliases) {
      const visible = info.slidesByTemplate(alias);
      if (visible.length !== 1) throw new Error(`GENERATIVE_DECK_ASSEMBLY_FAILED: prepared source '${alias}' must contain exactly one visible slide; found ${visible.length}.`);
      presentation.addSlide(alias, visible[0].number);
    }
    await presentation.write(path.basename(path.resolve(outputPath)));
    if (!fs.existsSync(path.resolve(outputPath))) throw new Error(`GENERATIVE_DECK_ASSEMBLY_FAILED: staged deck was not produced at ${outputPath}.`);
    await pruneUnreachablePptxParts(path.resolve(outputPath));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export async function renderGenerativeDeckRuntime(input: GenerativeDeckRuntimeInput): Promise<GenerativeDeckRuntimeResult> {
  verifyArtifacts(input);
  const planned = planSlides(input);
  const resolvedOutput = path.resolve(input.outputPath);
  const outputDir = path.dirname(resolvedOutput);
  fs.mkdirSync(outputDir, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(outputDir, `.ppt-agent-generative-deck-runtime-${process.pid}-`));
  const prepared: PreparedSlide[] = [];
  const decisions: GenerativeDeckDecision[] = [];
  let success = false;
  try {
    for (const [index, plan] of planned.entries()) {
      const preparedPath = path.join(workspace, `slide-${String(index + 1).padStart(3, "0")}.pptx`);
      if (plan.mode === "exact_clone") {
        decisions.push(await renderExactSlide(input, plan, preparedPath));
        prepared.push({ slideId: plan.slide.id, path: preparedPath, mode: "exact_clone" });
        continue;
      }
      const rendered = await renderGenerativeSceneRuntime({ templatePath: input.templatePath, outputPath: preparedPath, intent: plan.scene, elements: input.elements, designSystem: input.designSystem, components: input.components, nativeAssets: nativeAssetsForSlide(input, plan.slide) });
      decisions.push({ slideId: plan.slide.id, mode: "generative_scene", baseSlideId: rendered.baseSlideId, baseSlideNumber: rendered.baseSlideNumber });
      prepared.push({ slideId: plan.slide.id, path: preparedPath, mode: "generative_scene" });
    }

    const assembled = path.join(workspace, "assembled-deck.pptx");
    await assemblePreparedSlides(input.templatePath, assembled, prepared);
    const facts = await readPptxOoxml(assembled);
    if (!facts.parseOk || facts.slideCount !== planned.length) throw new Error(`GENERATIVE_DECK_INTEGRITY_FAILED: expected ${planned.length} parseable slides, received ${facts.slideCount}. Workspace preserved at ${workspace}`);
    const packageIntegrity = await assertPptxPackageIntegrity(assembled, input.templatePath);

    const temporary = `${resolvedOutput}.${process.pid}.tmp`;
    try {
      fs.copyFileSync(assembled, temporary);
      if (sha256File(assembled) !== sha256File(temporary)) throw new Error("GENERATIVE_DECK_PUBLISH_INTEGRITY_FAILED: staged deck digest changed during publication.");
      fs.renameSync(temporary, resolvedOutput);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    success = true;
    return { outputPath: resolvedOutput, decisions, manifest: prepared.map(({ slideId, mode }) => ({ slideId, mode })), packageIntegrity };
  } finally {
    if (success) fs.rmSync(workspace, { recursive: true, force: true });
  }
}
