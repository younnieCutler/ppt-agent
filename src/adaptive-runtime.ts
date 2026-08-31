import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyPatternSkeleton } from "./template";
import { transformTemplateComponents } from "./template-transform";
import { adaptiveOperationsForPlan } from "./adaptive-statement";
import { diagnoseAdaptiveMode, type AdaptiveSelectionCandidate, type AdaptiveSelectionResult } from "./adaptive-selection";
import { assertCanonicalTemplateElements, elementsDigest, type TemplateElementsArtifact } from "./template-analysis";
import { TEMPLATE_COMPONENTS_COMPILER_VERSION, type TemplateComponentsArtifact } from "./template-components";
import { TEMPLATE_DESIGN_SYSTEM_COMPILER_VERSION, type TemplateDesignSystemArtifact } from "./template-design-system";
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

export type AdaptiveRuntimeResult = { outputPath: string; decisions: AdaptiveSelectionResult[]; manifest: Array<{ slideId: string; mode: string }> };

function componentsForSlide(artifact: TemplateComponentsArtifact, slideId: string): TemplateComponentsArtifact {
  const components = artifact.components.filter((component) => component.sourceSlideId === slideId);
  const componentIds = new Set(components.map((component) => component.id));
  return { ...artifact, components, repeatGroups: artifact.repeatGroups.filter((group) => group.sourceSlideId === slideId && group.componentIds.every((id) => componentIds.has(id))) };
}

export async function renderAdaptiveRuntime(input: AdaptiveRuntimeInput): Promise<AdaptiveRuntimeResult> {
  if (!fs.existsSync(path.resolve(input.templatePath))) throw new Error(`ADAPTIVE_RUNTIME_TEMPLATE_MISSING: template not found: ${input.templatePath}`);
  if (!fs.existsSync(path.resolve(input.scratchPath))) throw new Error(`ADAPTIVE_RUNTIME_SCRATCH_MISSING: scratch source not found: ${input.scratchPath}`);
  if (input.slides.length === 0) throw new Error("ADAPTIVE_RUNTIME_UNSUPPORTED: at least one slide is required.");
  assertCanonicalTemplateElements(input.elements);
  const templateDigest = crypto.createHash("sha256").update(fs.readFileSync(path.resolve(input.templatePath))).digest("hex");
  if (templateDigest !== input.elements.source.sha256 || input.components.sourceDigest !== input.elements.source.sha256 || input.designSystem.sourceDigest !== input.elements.source.sha256 || input.components.elementsDigest !== elementsDigest(input.elements) || input.designSystem.elementsDigest !== elementsDigest(input.elements) || input.components.compilerVersion !== TEMPLATE_COMPONENTS_COMPILER_VERSION || input.designSystem.compilerVersion !== TEMPLATE_DESIGN_SYSTEM_COMPILER_VERSION) throw new Error("ADAPTIVE_RUNTIME_PROVENANCE_MISMATCH: template artifacts do not describe the current raw template extraction.");
  const resolvedPatterns = new Map<string, TemplatePattern>();
  const adaptiveSourceSlides = new Map<string, { sourceSlideNumber: number; family: string }>();
  const decisions: AdaptiveSelectionResult[] = [];
  const operations: Parameters<typeof transformTemplateComponents>[3] = [];
  const selectedSourceSlides = new Set<string>();
  const candidatesBySlide = new Map(input.slides.map((slide) => [slide.id, [...(input.candidatesBySlide.get(slide.id) ?? [])].sort((left, right) => left.rank - right.rank || left.pattern.id.localeCompare(right.pattern.id))]));
  const initial = new Map(input.slides.map((slide) => {
    const candidates = candidatesBySlide.get(slide.id) ?? [];
    return [slide.id, diagnoseAdaptiveMode({ templateDigest: input.components.sourceDigest, slide, candidates, designSystem: input.designSystem, components: input.components })] as const;
  }));
  const adaptiveTargets = new Set(input.slides.filter((slide) => initial.get(slide.id)?.mode === "adaptive_compose").map((slide) => slide.id));
  const exactPatterns = new Map<string, TemplatePattern>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const slide of input.slides) {
      if (adaptiveTargets.has(slide.id)) continue;
      const candidates = candidatesBySlide.get(slide.id) ?? [];
      const selected = candidates.find((candidate) => !adaptiveTargets.has(candidate.pattern.sourceSlideId) && diagnoseAdaptiveMode({ templateDigest: input.components.sourceDigest, slide, candidates: [candidate], designSystem: input.designSystem, components: input.components }).mode === "exact_clone");
      if (selected) {
        exactPatterns.set(slide.id, selected.pattern);
      } else {
        exactPatterns.delete(slide.id);
        adaptiveTargets.add(slide.id);
        changed = true;
      }
    }
  }
  for (const slide of input.slides) {
    const candidates = candidatesBySlide.get(slide.id) ?? [];
    if (adaptiveTargets.has(slide.id)) {
      const hostComponents = componentsForSlide(input.components, slide.id);
      const decision = diagnoseAdaptiveMode({ templateDigest: input.components.sourceDigest, slide, candidates: [], designSystem: input.designSystem, components: hostComponents });
      if (decision.mode === "unsupported") throw new Error(`No pattern fits slide '${slide.id}'; TEMPLATE_COMPOSITION_UNSUPPORTED: slide '${slide.id}' supports neither exact_clone nor adaptive_compose. ${decision.rejectionReasons.map((reason) => reason.message).join(" ")}`);
      decisions.push(decision);
      if (!decision.adaptivePlan) throw new Error(`ADAPTIVE_RUNTIME_PROVENANCE_MISSING: slide '${slide.id}' has no adaptive plan.`);
      const sourceSlide = input.elements.slides.find((candidate) => candidate.id === slide.id);
      if (!sourceSlide) throw new Error(`ADAPTIVE_RUNTIME_UNSUPPORTED: adaptive slide '${slide.id}' has no matching template source slide.`);
      if (selectedSourceSlides.has(sourceSlide.id)) throw new Error(`ADAPTIVE_RUNTIME_UNSUPPORTED: source slide '${sourceSlide.id}' cannot host more than one adaptive output slide in one run.`);
      selectedSourceSlides.add(sourceSlide.id);
      adaptiveSourceSlides.set(slide.id, { sourceSlideNumber: Number(sourceSlide.id.slice(1)), family: decision.adaptivePlan.family });
      operations.push(...adaptiveOperationsForPlan(decision.adaptivePlan, hostComponents));
      continue;
    }
    const pattern = exactPatterns.get(slide.id);
    if (!pattern) throw new Error(`No pattern fits slide '${slide.id}'; TEMPLATE_COMPOSITION_UNSUPPORTED: slide '${slide.id}' supports neither exact_clone nor adaptive_compose.`);
    const decision = diagnoseAdaptiveMode({ templateDigest: input.components.sourceDigest, slide, candidates: [{ rank: candidates.find((candidate) => candidate.pattern.id === pattern.id)?.rank ?? 1, pattern }], designSystem: input.designSystem, components: input.components });
    if (decision.mode !== "exact_clone") throw new Error(`ADAPTIVE_RUNTIME_PROVENANCE_MISSING: selected pattern '${pattern.id}' no longer satisfies the exact-clone contract for '${slide.id}'.`);
    decisions.push(decision);
    resolvedPatterns.set(slide.id, pattern);
  }

  const resolvedOutput = path.resolve(input.outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  const transformedTemplate = operations.length > 0 ? `${resolvedOutput}.${process.pid}.adaptive-source.tmp` : path.resolve(input.templatePath);
  try {
    if (operations.length > 0) await transformTemplateComponents(input.templatePath, transformedTemplate, input.components, operations);
    const manifest = await applyPatternSkeleton(transformedTemplate, input.scratchPath, resolvedOutput, input.slides, resolvedPatterns, { strategy: input.elements.strategy, adaptiveSourceSlides, ...(operations.length > 0 ? { patternValidationTemplatePath: input.templatePath } : {}) });
    return { outputPath: resolvedOutput, decisions, manifest };
  } finally {
    if (operations.length > 0) fs.rmSync(transformedTemplate, { force: true });
  }
}
