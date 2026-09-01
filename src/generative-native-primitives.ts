import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import Automizer from "pptx-automizer";
import type { TemplateConstraintProfile, Rect } from "./brand-constraints";
import { isGenerativeNativePrimitiveNode, nativePrimitiveObjectName, type GenerativeNativePrimitiveNode, type ResolvedGenerativeScene } from "./generative-scene";
import { pruneUnreachablePptxParts } from "./ooxml";

export type GenerativeNativeDataset = {
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
  unit?: string;
};

export type GenerativeNativeAssetRegistry = {
  datasets?: Record<string, GenerativeNativeDataset>;
  images?: Record<string, string>;
};

export type GenerativeNativePrimitiveRenderResult = {
  outputPath: string;
  renderedNodeIds: string[];
};

function normalizedColor(value: string | undefined): string | undefined {
  const color = value?.replace(/^#/, "").trim().toUpperCase();
  return color && /^[0-9A-F]{6}$/.test(color) ? color : undefined;
}

function templatePalette(profile: TemplateConstraintProfile): string[] {
  return [...new Set([
    ...profile.styleVocabulary.fillColors,
    ...profile.styleVocabulary.strokeColors,
    ...profile.styleVocabulary.textColors,
  ].map(normalizedColor).filter((color): color is string => Boolean(color)))];
}

function requireTemplateColor(profile: TemplateConstraintProfile): string {
  const color = templatePalette(profile)[0];
  if (!color) throw new Error("GENERATIVE_NATIVE_STYLE_UNAVAILABLE: template exposes no usable native primitive color.");
  return color;
}

function requireDataset(node: Extract<GenerativeNativePrimitiveNode, { role: "chart" }>, assets: GenerativeNativeAssetRegistry): GenerativeNativeDataset {
  const dataset = assets.datasets?.[node.datasetRef];
  if (!dataset) throw new Error(`GENERATIVE_NATIVE_DATASET_MISSING: chart '${node.id}' references '${node.datasetRef}'.`);
  if (dataset.categories.length === 0 || dataset.series.length === 0) throw new Error(`GENERATIVE_NATIVE_DATASET_INVALID: '${node.datasetRef}' must contain categories and series.`);
  for (const series of dataset.series) {
    if (!series.name.trim() || series.values.length !== dataset.categories.length || series.values.some((value) => !Number.isFinite(value))) {
      throw new Error(`GENERATIVE_NATIVE_DATASET_INVALID: '${node.datasetRef}' series must align one finite value to every category.`);
    }
  }
  return dataset;
}

function requireImage(node: Extract<GenerativeNativePrimitiveNode, { role: "image" | "icon" }>, assets: GenerativeNativeAssetRegistry): string {
  const assetPath = assets.images?.[node.assetRef];
  if (!assetPath) throw new Error(`GENERATIVE_NATIVE_ASSET_MISSING: ${node.role} '${node.id}' references '${node.assetRef}'.`);
  const resolved = path.resolve(assetPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`GENERATIVE_NATIVE_ASSET_MISSING: '${node.assetRef}' does not resolve to a readable file.`);
  return resolved;
}

function chartType(node: Extract<GenerativeNativePrimitiveNode, { role: "chart" }>, pptx: any): any {
  switch (node.chartType) {
    case "bar": return pptx.ChartType.column;
    case "horizontal_bar": return pptx.ChartType.bar;
    case "stacked_bar": return pptx.ChartType.bar;
    case "line": return pptx.ChartType.line;
    case "pie": return pptx.ChartType.pie;
    case "donut": return pptx.ChartType.doughnut;
  }
}

function connectorGeometry(node: Extract<GenerativeNativePrimitiveNode, { role: "connector" }>, bounds: Rect): Record<string, unknown> {
  switch (node.orientation) {
    case "horizontal": return { x: bounds.x, y: bounds.y + bounds.h / 2, w: bounds.w, h: 0 };
    case "vertical": return { x: bounds.x + bounds.w / 2, y: bounds.y, w: 0, h: bounds.h };
    case "diagonal_down": return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
    case "diagonal_up": return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h, flipV: true };
  }
}

function drawPrimitive(
  slide: any,
  pptx: any,
  node: GenerativeNativePrimitiveNode & { bounds: Rect },
  profile: TemplateConstraintProfile,
  assets: GenerativeNativeAssetRegistry,
): void {
  const color = requireTemplateColor(profile);
  const palette = templatePalette(profile);
  const bounds = node.bounds;

  if (node.role === "connector") {
    const width = node.weight === "light" ? 1 : node.weight === "strong" ? 2.5 : 1.5;
    slide.addShape(pptx.ShapeType.line, {
      ...connectorGeometry(node, bounds),
      line: {
        color,
        width,
        ...(node.arrow === "end" ? { endArrowType: "triangle" } : {}),
      },
    });
    return;
  }

  if (node.role === "chart") {
    const dataset = requireDataset(node, assets);
    const data = dataset.series.map((series) => ({ name: series.name, labels: [...dataset.categories], values: [...series.values] }));
    slide.addChart(chartType(node, pptx), data, {
      x: bounds.x,
      y: bounds.y,
      w: bounds.w,
      h: bounds.h,
      chartColors: palette,
      showLegend: dataset.series.length > 1,
      showTitle: false,
      showValue: false,
      showCatName: false,
      ...(node.chartType === "stacked_bar" ? { catAxisLabelRotate: 0, showLegend: true } : {}),
      ...(node.chartType === "donut" ? { holeSize: 55 } : {}),
    });
    return;
  }

  const assetPath = requireImage(node, assets);
  slide.addImage({ path: assetPath, x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h });
}

function cNvPrTags(xml: string): string[] {
  return xml.match(/<p:cNvPr\b[^>]*>/g) ?? [];
}

function tagId(tag: string): number | undefined {
  const match = tag.match(/\bid="(\d+)"/);
  const value = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function tagName(tag: string): string {
  return tag.match(/\bname="([^"]*)"/)?.[1] ?? "";
}

function generatedNativeTag(tag: string): boolean {
  return tagName(tag).startsWith("generative.native.");
}

async function normalizeGeneratedDrawingIds(pptxPath: string): Promise<void> {
  const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
  let changed = false;
  const slideParts = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));

  for (const part of slideParts) {
    const original = await zip.file(part)?.async("string");
    if (!original) continue;
    const tags = cNvPrTags(original);
    const numericIds = tags.map(tagId).filter((id): id is number => id !== undefined);
    const used = new Set(tags.filter((tag) => !generatedNativeTag(tag)).map(tagId).filter((id): id is number => id !== undefined));
    let nextId = Math.max(1, ...numericIds) + 1;

    const normalized = original.replace(/<p:cNvPr\b[^>]*>/g, (tag) => {
      if (!generatedNativeTag(tag)) return tag;
      const id = tagId(tag);
      if (id === undefined) return tag;
      if (!used.has(id)) {
        used.add(id);
        return tag;
      }
      while (used.has(nextId)) nextId += 1;
      const replacement = nextId;
      used.add(replacement);
      nextId += 1;
      changed = true;
      return tag.replace(/\bid="\d+"/, `id="${replacement}"`);
    });
    if (normalized !== original) zip.file(part, normalized);
  }

  if (changed) fs.writeFileSync(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));
}

export async function renderGenerativeNativePrimitives(
  inputPath: string,
  outputPath: string,
  scene: ResolvedGenerativeScene,
  profile: TemplateConstraintProfile,
  assets: GenerativeNativeAssetRegistry = {},
): Promise<GenerativeNativePrimitiveRenderResult> {
  const nodes = scene.nodes.filter(isGenerativeNativePrimitiveNode) as Array<GenerativeNativePrimitiveNode & { bounds: Rect }>;
  const resolvedInput = path.resolve(inputPath);
  const resolvedOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  if (nodes.length === 0) {
    fs.copyFileSync(resolvedInput, resolvedOutput);
    return { outputPath: resolvedOutput, renderedNodeIds: [] };
  }

  const staging = fs.mkdtempSync(path.join(path.dirname(resolvedOutput), `.ppt-agent-native-primitives-${process.pid}-`));
  const sourceName = "scene-source.pptx";
  try {
    fs.copyFileSync(resolvedInput, path.join(staging, sourceName));
    const automizer = new Automizer({ templateDir: staging, outputDir: path.dirname(resolvedOutput), removeExistingSlides: true });
    const presentation = automizer.loadRoot(sourceName).load(sourceName, "scene-source");
    const info = await presentation.getInfo();
    const visible = info.slidesByTemplate("scene-source");
    if (visible.length !== 1) throw new Error(`GENERATIVE_NATIVE_INPUT_INVALID: expected one visible slide, found ${visible.length}.`);
    presentation.addSlide("scene-source", visible[0].number, (target: any) => {
      // One generate element per semantic node keeps Automizer's generated object name tied to the
      // Scene node id. Automizer appends a UUID, so the stable prefix remains machine-verifiable.
      for (const node of nodes) {
        target.generate((slide: any, pptx: any) => drawPrimitive(slide, pptx, node, profile, assets), nativePrimitiveObjectName(node.id));
      }
    });
    await presentation.write(path.basename(resolvedOutput));
    if (!fs.existsSync(resolvedOutput)) throw new Error(`GENERATIVE_NATIVE_RENDER_FAILED: output was not produced at ${resolvedOutput}.`);

    // pptx-automizer 0.9.3 imports PptxGenJS objects with their temporary-slide cNvPr ids. The
    // first generated id can collide with an id already present on the template slide. Preserve all
    // template ids and reassign only generated native objects before package validation.
    await normalizeGeneratedDrawingIds(resolvedOutput);
    await pruneUnreachablePptxParts(resolvedOutput);
    return { outputPath: resolvedOutput, renderedNodeIds: nodes.map((node) => node.id) };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
