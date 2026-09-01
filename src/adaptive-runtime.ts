import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Automizer from "pptx-automizer";
import { applyPatternSkeleton } from "./template";
import { transformTemplateComponents } from "./template-transform";
import { adaptiveOperationsForPlan } from "./adaptive-statement";
import { diagnoseAdaptiveMode, type AdaptiveSelectionCandidate, type AdaptiveSelectionResult } from "./adaptive-selection";
import { assertCanonicalTemplateElements, elementsDigest, type TemplateElementsArtifact } from "./template-analysis";
import { TEMPLATE_COMPONENTS_COMPILER_VERSION, type TemplateComponentsArtifact } from "./template-components";
import { TEMPLATE_DESIGN_SYSTEM_COMPILER_VERSION, type TemplateDesignSystemArtifact } from "./template-design-system";
import { pruneUnreachablePptxParts } from "./ooxml";
import type { TemplatePattern } from "./template-patterns";
import type { SlideSpec } from "./schema";

export type AdaptiveRuntimeInput = {
  templatePath: string;
  scratchPath: string;
  outputPath: string;
  slides: SlideSpec[];
  candidatesBySlide: Map<string, AdaptiveSelectionCandidate[]>;
  elements: TemplateElementsArtifact;
  designSystem: TemplateDesignSystemArtifact;
  components: TemplateComponentsArtifact;
};

export type AdaptiveRuntimeDecision = AdaptiveSelectionResult & { sourceSlideId: string; sourceSlideNumber: number };
export type AdaptiveRuntimeResult = { outputPath: string; decisions: AdaptiveRuntimeDecision[]; manifest: Array<{ slideId: string; mode: string }> };

type PreparedSlide = { slideId: string; path: string; mode: string; sourceSlideId: string; sourceSlideNumber: number };

function componentsForSlide(artifact: TemplateComponentsArtifact, slideId: string): TemplateComponentsArtifact {
  const components = artifact.components.filter((component) => component.sourceSlideId === slideId);
  const componentIds = new Set(components.map((component) => component.id));
  return { ...artifact, components, repeatGroups: artifact.repeatGroups.filter((group) => group.sourceSlideId === slideId && group.componentIds.every((id) => componentIds.has(id))) };
}

function sourceSlideNumber(elements: TemplateElementsArtifact, slideId: string): number {
  const index = elements.slides.findIndex((slide) => slide.id === slideId);
  if (index < 0) throw new Error(`ADAPTIVE_RUNTIME_PROVENANCE_MISSING: template source slide '${slideId}' is absent from the current extraction.`);
  return index + 1;
}

function transformCost(decision: AdaptiveSelectionResult, components: TemplateComponentsArtifact): number {
  if (!decision.adaptivePlan) return Number.POSITIVE_INFINITY;
  const byId = new Map(components.components.map((component) => [component.id, component]));
  return decision.adaptivePlan.placements.reduce((sum, placement) => {
    const source = byId.get(placement.componentId)?.sourceBounds;
    if (!source) return Number.POSITIVE_INFINITY;
    return sum + Math.abs(placement.x - source.x) + Math.abs(placement.y - source.y) + Math.abs(placement.w - source.w) + Math.abs(placement.h - source.h);
  }, 0);
}

function selectAdaptiveSource(input: AdaptiveRuntimeInput, slide: SlideSpec): { decision: AdaptiveSelectionResult; components: TemplateComponentsArtifact; sourceSlideId: string; sourceSlideNumber: number } {
  const choices = input.elements.slides.flatMap((sourceSlide) => {
    const hostComponents = componentsForSlide(input.components, sourceSlide.id);
    if (hostComponents.components.length === 0) return [];
    const decision = diagnoseAdaptiveMode({ templateDigest: input.components.sourceDigest, slide, candidates: [], designSystem: input.designSystem, components: hostComponents });
    if (decision.mode !== "adaptive_compose" || !decision.adaptivePlan) return [];
    return [{ decision, components: hostComponents, sourceSlideId: sourceSlide.id, sourceSlideNumber: sourceSlideNumber(input.elements, sourceSlide.id), cost: transformCost(decision, hostComponents) }];
  }).sort((left, right) => left.cost - right.cost || left.sourceSlideNumber - right.sourceSlideNumber || left.sourceSlideId.localeCompare(right.sourceSlideId));
  const selected = choices[0];
  if (!selected) throw new Error(`No pattern fits slide '${slide.id}'; TEMPLATE_COMPOSITION_UNSUPPORTED: slide '${slide.id}' supports neither exact_clone nor adaptive_compose on any template source slide.`);
  return selected;
}

async function assemblePreparedSlides(templatePath: string, outputPath: string, prepared: PreparedSlide[]): Promise<void> {
  const resolvedOutput = path.resolve(outputPath);
  const outputDir = path.dirname(resolvedOutput);
  fs.mkdirSync(outputDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(outputDir, `.ppt-agent-adaptive-assembly-${process.pid}-`));
  const rootName = "raw-template.pptx";
  try {
    fs.copyFileSync(path.resolve(templatePath), path.join(staging, rootName));
    const automizer = new Automizer({ templateDir: staging, outputDir, removeExistingSlides: true });
    let presentation = automizer.loadRoot(rootName);
    const aliases: string[] = [];
    prepared.forEach((entry, index) => {
      const fileName = `prepared-${index + 1}.pptx`;
      const alias = `prepared-${index + 1}`;
      fs.copyFileSync(entry.path, path.join(staging, fileName));
      presentation = presentation.load(fileName, alias);
      aliases.push(alias);
    });
    aliases.forEach((alias) => presentation.addSlide(alias, 1));
    await presentation.write(path.basename(resolvedOutput));
    if (!fs.existsSync(resolvedOutput)) throw new Error(`ADAPTIVE_RUNTIME_ASSEMBLY_FAILED: final deck was not produced at ${resolvedOutput}.`);
    await pruneUnreachablePptxParts(resolvedOutput);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export async function renderAdaptiveRuntime(input: AdaptiveRuntimeInput): Promise<AdaptiveRuntimeResult> {
  if (!fs.existsSync(path.resolve(input.templatePath))) throw new Error(`ADAPTIVE_RUNTIME_TEMPLATE_MISSING: template not found: ${input.templatePath}`);
  if (!fs.existsSync(path.resolve(input.scratchPath))) throw new Error(`ADAPTIVE_RUNTIME_SCRATCH_MISSING: scratch source not found: ${input.scratchPath}`);
  if (input.slides.length === 0) throw new Error("ADAPTIVE_RUNTIME_UNSUPPORTED: at least one slide is required.");
  assertCanonicalTemplateElements(input.elements);
  const templateDigest = crypto.createHash("sha256").update(fs.readFileSync(path.resolve(input.templatePath))).digest("hex");
  if (templateDigest !== input.elements.source.sha256 || input.components.sourceDigest !== input.elements.source.sha256 || input.designSystem.sourceDigest !== input.elements.source.sha256 || input.components.elementsDigest !== elementsDigest(input.elements) || input.designSystem.elementsDigest !== elementsDigest(input.elements) || input.components.compilerVersion !== TEMPLATE_COMPONENTS_COMPILER_VERSION || input.designSystem.compilerVersion !== TEMPLATE_DESIGN_SYSTEM_COMPILER_VERSION) throw new Error("ADAPTIVE_RUNTIME_PROVENANCE_MISMATCH: template artifacts do not describe the current raw template extraction.");

  const resolvedOutput = path.resolve(input.outputPath);
  const outputDir = path.dirname(resolvedOutput);
  fs.mkdirSync(outputDir, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(outputDir, `.ppt-agent-adaptive-runtime-${process.pid}-`));
  const decisions: AdaptiveRuntimeDecision[] = [];
  const prepared: PreparedSlide[] = [];
  try {
    for (const [index, slide] of input.slides.entries()) {
      const candidates = [...(input.candidatesBySlide.get(slide.id) ?? [])].sort((left, right) => left.rank - right.rank || left.pattern.id.localeCompare(right.pattern.id));
      const exact = candidates.find((candidate) => diagnoseAdaptiveMode({ templateDigest: input.components.sourceDigest, slide, candidates: [candidate], designSystem: input.designSystem, components: input.components }).mode === "exact_clone");
      const preparedPath = path.join(workspace, `slide-${String(index + 1).padStart(3, "0")}.pptx`);
      if (exact) {
        const decision = diagnoseAdaptiveMode({ templateDigest: input.components.sourceDigest, slide, candidates: [exact], designSystem: input.designSystem, components: input.components });
        if (decision.mode !== "exact_clone") throw new Error(`ADAPTIVE_RUNTIME_PROVENANCE_MISSING: selected pattern '${exact.pattern.id}' no longer satisfies the exact-clone contract for '${slide.id}'.`);
        const sourceId = exact.pattern.sourceSlideId;
        const sourceNumber = sourceSlideNumber(input.elements, sourceId);
        const resolvedPatterns = new Map<string, TemplatePattern>([[slide.id, exact.pattern]]);
        const manifest = await applyPatternSkeleton(input.templatePath, input.scratchPath, preparedPath, [slide], resolvedPatterns, { strategy: input.elements.strategy });
        decisions.push({ ...decision, sourceSlideId: sourceId, sourceSlideNumber: sourceNumber });
        prepared.push({ slideId: slide.id, path: preparedPath, mode: manifest[0]?.mode ?? `pattern:${exact.pattern.id}`, sourceSlideId: sourceId, sourceSlideNumber: sourceNumber });
        continue;
      }

      const selected = selectAdaptiveSource(input, slide);
      const plan = selected.decision.adaptivePlan;
      if (!plan) throw new Error(`ADAPTIVE_RUNTIME_PROVENANCE_MISSING: slide '${slide.id}' has no adaptive plan.`);
      const transformedTemplate = path.join(workspace, `adaptive-source-${String(index + 1).padStart(3, "0")}.pptx`);
      const sourceScopedPlan = { ...plan, slideId: selected.sourceSlideId };
      const operations = adaptiveOperationsForPlan(sourceScopedPlan, selected.components);
      await transformTemplateComponents(input.templatePath, transformedTemplate, input.components, operations);
      const adaptiveSourceSlides = new Map([[slide.id, { sourceSlideNumber: selected.sourceSlideNumber, family: plan.family }]]);
      const manifest = await applyPatternSkeleton(transformedTemplate, input.scratchPath, preparedPath, [slide], new Map(), { strategy: input.elements.strategy, adaptiveSourceSlides });
      decisions.push({ ...selected.decision, sourceSlideId: selected.sourceSlideId, sourceSlideNumber: selected.sourceSlideNumber });
      prepared.push({ slideId: slide.id, path: preparedPath, mode: manifest[0]?.mode ?? `adaptive:${plan.family}`, sourceSlideId: selected.sourceSlideId, sourceSlideNumber: selected.sourceSlideNumber });
    }

    await assemblePreparedSlides(input.templatePath, resolvedOutput, prepared);
    const manifest = prepared.map(({ slideId, mode }) => ({ slideId, mode }));
    if (manifest.some((entry) => entry.mode === "renderer")) throw new Error("TEMPLATE_FIDELITY_UNPROVEN: raw adaptive runtime produced a generic renderer slide.");
    return { outputPath: resolvedOutput, decisions, manifest };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}
