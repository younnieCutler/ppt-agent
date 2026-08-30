import fs from "node:fs";
import path from "node:path";
import Automizer, { ModifyShapeHelper, ModifyTextHelper } from "pptx-automizer";
import JSZip from "jszip";
import { bindingForLayout, CANVAS_DIMENSIONS, type TemplateMap } from "./organization";
import { pruneUnreachablePptxParts } from "./ooxml";
import { extractTemplateElements } from "./template-analysis";
import { assertTemplatePattern, resolveSlotAssignments, type TemplatePattern } from "./template-patterns";
import type { TemplateStrategy } from "./template-analysis";

const EMU_PER_INCH = 914400;
const CANVAS_SIZE_TOLERANCE_IN = 0.05;
import type { ResolvedPresentationStyle } from "./style";
import type { SlideSpec } from "./schema";

/**
 * Applies an organisation's native PowerPoint template after the semantic
 * renderer has produced an editable scratch deck.  Keeping this as a small
 * adapter means semantic layouts never need an organisation-specific fork.
 */
export async function applyOrganizationTemplate(
  scratchPath: string,
  outputPath: string,
  style: ResolvedPresentationStyle,
  slides: SlideSpec[],
): Promise<void> {
  const organization = style.organization;
  if (!organization) {
    fs.copyFileSync(path.resolve(scratchPath), path.resolve(outputPath));
    return;
  }
  if (!fs.existsSync(organization.templatePath)) {
    throw new Error(`Organization template not found: ${organization.templatePath}`);
  }
  const { nameToIndex } = await validateTemplateContract(organization.templatePath, organization.map, slides);

  const resolvedOutput = path.resolve(outputPath);
  const outputDir = path.dirname(resolvedOutput);
  fs.mkdirSync(outputDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(outputDir, `.ppt-agent-template-${process.pid}-`));
  const rootName = "organization-template.pptx";
  const generatedName = "semantic-render.pptx";
  try {
    fs.copyFileSync(organization.templatePath, path.join(staging, rootName));
    fs.copyFileSync(path.resolve(scratchPath), path.join(staging, generatedName));

    const automizer = new Automizer({
      templateDir: staging,
      outputDir,
      removeExistingSlides: true,
    });
    const presentation = automizer.loadRoot(rootName).load(generatedName, "semantic-render");
    slides.forEach((slideSpec, index) => {
      const binding = bindingForLayout(organization.map, slideSpec.layout);
      // pptx-automizer's by-name useSlideLayout() only resolves against layouts that were
      // explicitly imported/tracked as "mapped content" from a secondary template — it does not
      // look up a layout that's already native to the root document (loadRoot never registers its
      // own layouts that way), so it silently fails to find any name and fabricates a new layout
      // instead of binding to the real one. Resolving the name to its 1-based index ourselves and
      // always calling useSlideLayout() with a number sidesteps that path entirely: a plain number
      // is used verbatim against the root's own layouts, which is exactly what already works today
      // for numeric-index bindings.
      const nativeLayout = /^\d+$/.test(binding.nativeLayout) ? Number(binding.nativeLayout) : nameToIndex.get(binding.nativeLayout)!;
      presentation.addSlide("semantic-render", index + 1, (slide) => {
        slide.useSlideLayout(nativeLayout);
      });
    });
    await presentation.write(path.basename(resolvedOutput));
    if (!fs.existsSync(resolvedOutput)) throw new Error(`Organization template adapter did not produce ${resolvedOutput}`);
    // pptx-automizer keeps the root template's own example slides and their media in the package
    // even after removeExistingSlides drops them from the presentation, so the delivered deck
    // would still ship the organization's private example content inside the file.
    await pruneUnreachablePptxParts(resolvedOutput);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function validateTemplateContract(templatePath: string, map: TemplateMap, slides: SlideSpec[]): Promise<{ nameToIndex: Map<string, number> }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(templatePath));
  } catch (error) {
    throw new Error(`Organization template is not a readable PPTX: ${templatePath} (${error instanceof Error ? error.message : String(error)})`);
  }
  const presentationXml = await zip.file("ppt/presentation.xml")?.async("string");
  if (!presentationXml) throw new Error(`Organization template is missing ppt/presentation.xml: ${templatePath}`);
  const sizeTag = presentationXml.match(/<p:sldSz\b[^>]*>/)?.[0];
  const cx = Number(sizeTag?.match(/\bcx="(\d+)"/)?.[1] ?? 0);
  const cy = Number(sizeTag?.match(/\bcy="(\d+)"/)?.[1] ?? 0);
  const expected = CANVAS_DIMENSIONS[map.aspectRatio];
  const actualW = cx / EMU_PER_INCH;
  const actualH = cy / EMU_PER_INCH;
  // A ratio-only check (e.g. 4/3) would pass an 8x6in template just as readily as the true
  // 10x7.5in canvas the renderer, geometry QA, and every contentRegion bound assume — an 8x6
  // template would then have 10x7.5-authored content copied straight onto it, clipping the
  // right/bottom edge. Physical size is the actual contract, not just the aspect ratio.
  if (!cx || !cy || Math.abs(actualW - expected.w) > CANVAS_SIZE_TOLERANCE_IN || Math.abs(actualH - expected.h) > CANVAS_SIZE_TOLERANCE_IN) {
    throw new Error(`ORGANIZATION_TEMPLATE_ASPECT_RATIO_UNSUPPORTED: Organization template must be exactly ${expected.w}in x ${expected.h}in (${map.aspectRatio}); template.pptx is ${actualW.toFixed(3)}in x ${actualH.toFixed(3)}in.`);
  }

  const layoutFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name))
    .sort((left, right) => Number(left.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(right.match(/(\d+)\.xml$/)?.[1] ?? 0));
  // A real PowerPoint template can legitimately have two layouts sharing a display name (they
  // come from different masters/themes). Tracking every index per name — not just the last one
  // seen — lets ambiguous name bindings be rejected explicitly instead of silently resolving to
  // whichever layout happened to be parsed last.
  const layoutNamesByOccurrence = new Map<string, number[]>();
  const layoutXmlByIndex = new Map<number, string>();
  for (const [index, fileName] of layoutFiles.entries()) {
    const xml = await zip.file(fileName)?.async("string");
    if (xml) layoutXmlByIndex.set(index + 1, xml);
    const name = xml?.match(/<p:cSld\b[^>]*\bname="([^"]+)"/)?.[1] ?? xml?.match(/<p:sldLayout\b[^>]*\bname="([^"]+)"/)?.[1];
    if (name) layoutNamesByOccurrence.set(name, [...(layoutNamesByOccurrence.get(name) ?? []), index + 1]);
  }
  const nameToIndex = new Map<string, number>();
  const bindings = new Map<string, string>();
  slides.forEach((slide) => {
    const binding = bindingForLayout(map, slide.layout);
    bindings.set(binding.nativeLayout, slide.layout);
  });
  bindings.forEach((layout, nativeLayout) => {
    if (/^\d+$/.test(nativeLayout)) {
      const index = Number(nativeLayout);
      if (index < 1 || index > layoutFiles.length) throw new Error(`Template map layout '${nativeLayout}' for semantic layout '${layout}' does not exist in template.pptx.`);
      return;
    }
    const indexes = layoutNamesByOccurrence.get(nativeLayout);
    if (!indexes) throw new Error(`Template map layout '${nativeLayout}' for semantic layout '${layout}' does not exist in template.pptx.`);
    if (indexes.length > 1) {
      throw new Error(`Template map layout '${nativeLayout}' for semantic layout '${layout}' is ambiguous: ${indexes.length} layouts in template.pptx share this name (indexes ${indexes.join(", ")}). Use the 1-based layout index instead.`);
    }
    nameToIndex.set(nativeLayout, indexes[0]);
  });

  const layoutNames = new Map(nameToIndex);
  const templateXml = (await Promise.all(Object.keys(zip.files)
    .filter((name) => /^ppt\/(?:slides|slideLayouts|slideMasters)\/.*\.xml$/.test(name))
    .map(async (name) => (await zip.file(name)?.async("string")) ?? ""))).join("\n");
  map.requiredElements.forEach((required) => {
    const found = required.layouts.includes("*")
      ? templateXml.includes(`name="${required.name}"`)
      : required.layouts.some((semanticLayout) => {
        const binding = bindingForLayout(map, semanticLayout as SlideSpec["layout"]);
        const layoutIndex = /^\d+$/.test(binding.nativeLayout) ? Number(binding.nativeLayout) : layoutNames.get(binding.nativeLayout);
        return layoutIndex ? (layoutXmlByIndex.get(layoutIndex)?.includes(`name="${required.name}"`) ?? false) : false;
      });
    if (!found) throw new Error(`Template map requires element '${required.name}', but it was not found in template.pptx.`);
  });

  return { nameToIndex };
}


export type RenderManifestEntry = { slideId: string; mode: string };

function positionInEmu(bounds: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
  return { x: Math.round(bounds.x * EMU_PER_INCH), y: Math.round(bounds.y * EMU_PER_INCH), w: Math.round(bounds.w * EMU_PER_INCH), h: Math.round(bounds.h * EMU_PER_INCH) };
}

async function templateCanvas(templatePath: string): Promise<{ w: number; h: number }> {
  const zip = await JSZip.loadAsync(fs.readFileSync(templatePath));
  const xml = await zip.file("ppt/presentation.xml")?.async("string");
  const tag = xml?.match(/<p:sldSz\b[^>]*>/)?.[0];
  const w = Number(tag?.match(/\bcx="(\d+)"/)?.[1] ?? 0) / EMU_PER_INCH;
  const h = Number(tag?.match(/\bcy="(\d+)"/)?.[1] ?? 0) / EMU_PER_INCH;
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
 * Distinct from `applyOrganizationTemplate` above on purpose: that function's `useSlideLayout`
 * binding-by-semantic-layout-name logic is untouched by this, and this function touches nothing
 * that function's own tests already cover.
 */
export async function applyPatternSkeleton(
  templatePath: string,
  scratchPath: string,
  outputPath: string,
  slides: SlideSpec[],
  resolvedPatterns: Map<string, TemplatePattern>,
  options: { strategy?: TemplateStrategy } = {},
): Promise<RenderManifestEntry[]> {
  if (!fs.existsSync(templatePath)) throw new Error(`Template not found: ${templatePath}`);
  const resolvedOutput = path.resolve(outputPath);
  const outputDir = path.dirname(resolvedOutput);
  fs.mkdirSync(outputDir, { recursive: true });
  const canvas = await templateCanvas(templatePath);
  await assertPatternsMatchTemplate(templatePath, [...resolvedPatterns.values()], canvas);
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
        if (options.strategy === "source_slide_pattern") {
          throw new Error(`No pattern fits slide '${slideSpec.id}' on a source_slide_pattern template — refusing to silently redraw it with the generic renderer. Its design lives entirely in the template's own example slide bodies; choose or label a different source slide, or split this deck across a hybrid-strategy template if a generic slide is genuinely acceptable here.`);
        }
        presentation.addSlide("semantic-render", index + 1);
        manifest.push({ slideId: slideSpec.id, mode: "renderer" });
        return;
      }
      presentation.addSlide("org-source", pattern.sourceSlideNumber, (slide) => {
        if (pattern.coordinateSpace?.mode === "scaled") {
          for (const [shapeId, bounds] of Object.entries(pattern.skeleton.canonicalBoundsByShape ?? {})) slide.modifyElement(shapeId, [ModifyShapeHelper.setPosition(positionInEmu(bounds))]);
        }
        for (const name of pattern.skeleton.removableContentIds) slide.removeElement(name);
        // resolveSlotAssignments groups slots by binding and maps item i onto sibling slot i — a
        // pattern with K shapes bound to the same field (a real GAO shape) gets K different pieces
        // of content, not the same fully-joined string duplicated into all K of them.
        for (const assignment of resolveSlotAssignments(pattern, slideSpec)) {
          if ("remove" in assignment) slide.removeElement(assignment.slot.shapeId);
          else slide.modifyElement(assignment.slot.shapeId, [ModifyTextHelper.setText(assignment.text)]);
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
