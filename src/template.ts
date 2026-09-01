import fs from "node:fs";
import path from "node:path";
import Automizer, { ModifyShapeHelper, ModifyTextHelper } from "pptx-automizer";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { pruneUnreachablePptxParts } from "./ooxml";
import { extractTemplateElements } from "./template-analysis";
import { assertTemplatePattern, resolveSlotAssignments, type TemplatePattern } from "./template-patterns";
import type { TemplateStrategy } from "./template-analysis";

const EMU_PER_INCH = 914400;
const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
import type { SlideSpec } from "./schema";
export type RenderManifestEntry = { slideId: string; mode: string };

function positionInEmu(bounds: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
  return { x: Math.round(bounds.x * EMU_PER_INCH), y: Math.round(bounds.y * EMU_PER_INCH), w: Math.round(bounds.w * EMU_PER_INCH), h: Math.round(bounds.h * EMU_PER_INCH) };
}

async function templateCanvas(templatePath: string): Promise<{ w: number; h: number }> {
  const zip = await JSZip.loadAsync(fs.readFileSync(templatePath));
  const xml = await zip.file("ppt/presentation.xml")?.async("string");
  const document = xml ? new DOMParser().parseFromString(xml, "text/xml") as unknown as Document : undefined;
  const size = document ? Array.from(document.getElementsByTagNameNS(P_NS, "sldSz"))[0] as Element | undefined : undefined;
  const w = Number(size?.getAttribute("cx") ?? 0) / EMU_PER_INCH;
  const h = Number(size?.getAttribute("cy") ?? 0) / EMU_PER_INCH;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error(`TEMPLATE_COORDINATE_SPACE_INVALID: template has no usable p:sldSz canvas: ${templatePath}`);
  return { w, h };
}

function sameBounds(left: { x: number; y: number; w: number; h: number }, right: { x: number; y: number; w: number; h: number }): boolean {
  return [left.x, left.y, left.w, left.h].every((value, index) => Math.abs(value - [right.x, right.y, right.w, right.h][index]) <= 2 / EMU_PER_INCH);
}

function sameCoordinateSpace(left: NonNullable<TemplatePattern["coordinateSpace"]>, right: NonNullable<TemplatePattern["coordinateSpace"]>): boolean {
  return left.mode === right.mode && [left.canvas.w, left.canvas.h, left.sourceFrame.x, left.sourceFrame.y, left.sourceFrame.w, left.sourceFrame.h, left.scale.x, left.scale.y]
    .every((value, index) => Math.abs(value - [right.canvas.w, right.canvas.h, right.sourceFrame.x, right.sourceFrame.y, right.sourceFrame.w, right.sourceFrame.h, right.scale.x, right.scale.y][index]) <= 2 / EMU_PER_INCH);
}

async function assertPatternsMatchTemplate(templatePath: string, patterns: TemplatePattern[], canvas: { w: number; h: number }): Promise<void> {
  const actual = await extractTemplateElements(templatePath);
  for (const pattern of patterns) {
    assertTemplatePattern(pattern, canvas);
    const actualSlide = actual.slides.find((slide) => slide.id === pattern.sourceSlideId);
    if (!actualSlide || actualSlide.sourceSlidePart !== pattern.skeleton.sourceSlidePart || !sameCoordinateSpace(pattern.coordinateSpace!, actual.coordinateSpace!)) throw new Error(`TEMPLATE_PATTERN_STALE: pattern '${pattern.id}' does not match the current template coordinate extraction. Re-run template-analyze.`);
    for (const shapeId of pattern.skeleton.offCanvasHelperIds ?? []) {
      const matches = actualSlide.elements.filter((element) => element.name === shapeId);
      if (matches.length !== 1 || !matches[0].offCanvasHelper) throw new Error(`TEMPLATE_PATTERN_STALE: pattern '${pattern.id}' has an unverified off-canvas helper '${shapeId}'. Re-run template-analyze.`);
    }
    for (const [shapeId, bounds] of Object.entries(pattern.skeleton.canonicalBoundsByShape ?? {})) {
      const matches = actualSlide.elements.filter((element) => element.name === shapeId && !element.grouped);
      if (matches.length !== 1 || !sameBounds(bounds, matches[0].bounds)) throw new Error(`TEMPLATE_PATTERN_STALE: pattern '${pattern.id}' has stale canonical bounds for '${shapeId}'. Re-run template-analyze.`);
    }
  }
}

/**
 * For source_slide_pattern / hybrid strategies: clones each pattern-bound slide directly out of
 * the template's own package (never the renderer's scratch deck), removes its example content,
 * and injects real DeckSpec content into its slots.
 *
 * A slide with no resolved pattern falls through to the generically-rendered scratch slide at the
 * same position by default — legitimate for `hybrid` (a template that genuinely mixes native-layout
 * and source-slide-pattern slides) and for the low-level "no strategy declared" case tests exercise
 * directly. Pass `options.strategy: "source_slide_pattern"` to turn that fallback into an immediate
 * hard failure instead: a pure source_slide_pattern template committing to full skeleton reuse
 * should never silently redraw a slide from scratch and wait for QA to notice after the fact — see
 * TEMPLATE_FIDELITY_UNPROVEN's own comment for why that gap existed and how it was closed
 * post-hoc; this is the same guarantee enforced up front, at the point the decision is actually
 * made, not after a whole deck was already rendered around it.
 *
 * This is the only template assembly path: it copies native source-slide bodies and never asks the
 * generic renderer to redraw a raw-template slide.
 */
export async function applyPatternSkeleton(
  templatePath: string,
  scratchPath: string,
  outputPath: string,
  slides: SlideSpec[],
  resolvedPatterns: Map<string, TemplatePattern>,
  options: { strategy?: TemplateStrategy; adaptiveSourceSlides?: Map<string, { sourceSlideNumber: number; family: string }>; patternValidationTemplatePath?: string } = {},
): Promise<RenderManifestEntry[]> {
  if (!fs.existsSync(templatePath)) throw new Error(`Template not found: ${templatePath}`);
  const resolvedOutput = path.resolve(outputPath);
  const outputDir = path.dirname(resolvedOutput);
  fs.mkdirSync(outputDir, { recursive: true });
  const canvas = await templateCanvas(templatePath);
  await assertPatternsMatchTemplate(options.patternValidationTemplatePath ?? templatePath, [...resolvedPatterns.values()], canvas);
  const staging = fs.mkdtempSync(path.join(outputDir, `.ppt-agent-pattern-${process.pid}-`));
  const rootName = "org-source.pptx";
  const generatedName = "semantic-render.pptx";
  const manifest: RenderManifestEntry[] = [];
  try {
    fs.copyFileSync(templatePath, path.join(staging, rootName));
    fs.copyFileSync(path.resolve(scratchPath), path.join(staging, generatedName));
    const automizer = new Automizer({ templateDir: staging, outputDir, removeExistingSlides: true });
    const presentation = automizer
      .loadRoot(rootName)
      .load(rootName, "org-source")
      .load(generatedName, "semantic-render");

    slides.forEach((slideSpec, index) => {
      const pattern = resolvedPatterns.get(slideSpec.id);
      if (!pattern) {
        const adaptive = options.adaptiveSourceSlides?.get(slideSpec.id);
        if (adaptive) {
          presentation.addSlide("org-source", adaptive.sourceSlideNumber);
          manifest.push({ slideId: slideSpec.id, mode: `adaptive:${adaptive.family}` });
          return;
        }
        if (options.strategy === "source_slide_pattern") {
          throw new Error(`No pattern fits slide '${slideSpec.id}' on a source_slide_pattern template — refusing to silently redraw it with the generic renderer. Its design lives entirely in the template's own example slide bodies; choose or label a different source slide, or split this deck across a hybrid-strategy template if a generic slide is genuinely acceptable here.`);
        }
        presentation.addSlide("semantic-render", index + 1);
        manifest.push({ slideId: slideSpec.id, mode: "renderer" });
        return;
      }
      presentation.addSlide("org-source", pattern.sourceSlideNumber, (slide) => {
        // resolveSlotAssignments groups slots by binding and maps item i onto sibling slot i — a
        // pattern with K shapes bound to the same field (a real GAO shape) gets K different pieces
        // of content, not the same fully-joined string duplicated into all K of them.
        const assignments = resolveSlotAssignments(pattern, slideSpec);
        const removals = new Set([
          ...pattern.skeleton.removableContentIds,
          ...assignments.filter((assignment): assignment is Extract<typeof assignment, { remove: true }> => "remove" in assignment).map((assignment) => assignment.slot.shapeId),
        ]);
        removals.forEach((name) => slide.removeElement(name));
        if (pattern.coordinateSpace?.mode === "scaled") {
          for (const [shapeId, bounds] of Object.entries(pattern.skeleton.canonicalBoundsByShape ?? {})) if (!removals.has(shapeId)) slide.modifyElement(shapeId, [ModifyShapeHelper.setPosition(positionInEmu(bounds))]);
        }
        for (const assignment of assignments) {
          if (!("remove" in assignment)) slide.modifyElement(assignment.slot.shapeId, [ModifyTextHelper.setText(assignment.text)]);
        }
      });
      manifest.push({ slideId: slideSpec.id, mode: `pattern:${pattern.id}` });
    });

    await presentation.write(path.basename(resolvedOutput));
    if (!fs.existsSync(resolvedOutput)) throw new Error(`Pattern skeleton renderer did not produce ${resolvedOutput}`);
    await pruneUnreachablePptxParts(resolvedOutput);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return manifest;
}
