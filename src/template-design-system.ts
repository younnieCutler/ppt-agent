import { compileTemplateGrammar, elementsDigest, type SemanticRole, type TemplateElement, type TemplateElementsArtifact, type TemplateGrammar, type TemplateTextStyle } from "./template-analysis";

export const TEMPLATE_DESIGN_SYSTEM_COMPILER_VERSION = "1";

type Rect = { x: number; y: number; w: number; h: number };
type NumericVocabulary = { values: number[]; min?: number; max?: number };
type TypographyRole = {
  families?: string[];
  sizesPt?: NumericVocabulary;
  weights?: number[];
  lineHeightRatios?: NumericVocabulary;
  alignments?: Array<"left" | "center" | "right">;
};

export type TemplateDesignSystemArtifact = {
  version: 1;
  compilerVersion: string;
  sourceDigest: string;
  elementsDigest: string;
  canvas: { w: number; h: number };
  typography: {
    roles: Partial<Record<SemanticRole, TypographyRole>>;
    typeScale: NumericVocabulary;
  };
  colors: { text: string[]; fill: string[]; stroke: string[]; background: string[] };
  geometry: { contentFrame?: Rect; outerMargins?: Rect; gutters: number[] };
  spacing: { rhythm: number[] };
  dividers: { orientations: Array<"horizontal" | "vertical" | "unknown">; thicknesses: number[]; lengths: number[]; strokeWidthsPt: number[]; colors: string[] };
  surfaces: { fills: string[]; borders: string[]; borderWidthsPt: number[] };
  alignmentAnchors: { x: number[]; y: number[] };
};

const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.filter(Number.isFinite).map(round))].sort((a, b) => a - b);
}

function numericVocabulary(values: number[]): NumericVocabulary {
  const sorted = uniqueSorted(values);
  return sorted.length === 0 ? { values: [] } : { values: sorted, min: sorted[0], max: sorted[sorted.length - 1] };
}

function strings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)).map((value) => value.toUpperCase()))].sort();
}

function elementsOf(artifact: TemplateElementsArtifact): TemplateElement[] {
  return [
    ...artifact.slides.flatMap((slide) => slide.elements),
    ...artifact.layouts.flatMap((layout) => layout.elements),
    ...artifact.masters.flatMap((master) => master.elements),
  ];
}

function styleOf(element: TemplateElement, artifact: TemplateElementsArtifact): TemplateTextStyle | undefined {
  return element.styleRef ? artifact.styles[element.styleRef] : undefined;
}

function overlaps(start: number, end: number, otherStart: number, otherEnd: number): boolean {
  return Math.min(end, otherEnd) > Math.max(start, otherStart);
}

function gaps(elements: TemplateElement[]): number[] {
  // ponytail: O(n²) pair scan keeps the extractor dependency-free; replace with a sweep-line index
  // only if templates with thousands of observed elements make analysis measurably slow.
  const observed: number[] = [];
  for (let index = 0; index < elements.length; index += 1) {
    const left = elements[index];
    for (let otherIndex = index + 1; otherIndex < elements.length; otherIndex += 1) {
      const right = elements[otherIndex];
      if (overlaps(left.bounds.y, left.bounds.y + left.bounds.h, right.bounds.y, right.bounds.y + right.bounds.h)) {
        if (left.bounds.x + left.bounds.w <= right.bounds.x) observed.push(right.bounds.x - (left.bounds.x + left.bounds.w));
        if (right.bounds.x + right.bounds.w <= left.bounds.x) observed.push(left.bounds.x - (right.bounds.x + right.bounds.w));
      }
      if (overlaps(left.bounds.x, left.bounds.x + left.bounds.w, right.bounds.x, right.bounds.x + right.bounds.w)) {
        if (left.bounds.y + left.bounds.h <= right.bounds.y) observed.push(right.bounds.y - (left.bounds.y + left.bounds.h));
        if (right.bounds.y + right.bounds.h <= left.bounds.y) observed.push(left.bounds.y - (right.bounds.y + right.bounds.h));
      }
    }
  }
  return uniqueSorted(observed.filter((value) => value > 0));
}

function alignmentAnchors(elements: TemplateElement[]): { x: number[]; y: number[] } {
  return {
    x: uniqueSorted(elements.flatMap((element) => [element.bounds.x, element.bounds.x + element.bounds.w / 2, element.bounds.x + element.bounds.w])),
    y: uniqueSorted(elements.flatMap((element) => [element.bounds.y, element.bounds.y + element.bounds.h / 2, element.bounds.y + element.bounds.h])),
  };
}

function contentFrame(grammar: TemplateGrammar): { contentFrame?: Rect; outerMargins?: Rect } {
  const frame = grammar.geometry.contentFrame;
  if (frame.w <= 0 || frame.h <= 0) return {};
  return { contentFrame: frame, outerMargins: grammar.geometry.outerMargins };
}

function typography(elements: TemplateElement[], artifact: TemplateElementsArtifact): TemplateDesignSystemArtifact["typography"] {
  const roles: Partial<Record<SemanticRole, TypographyRole>> = {};
  const textElements = elements.filter((element) => element.type === "text");
  for (const element of textElements) {
    if (element.role === "unknown") continue;
    const style = styleOf(element, artifact);
    if (!style) continue;
    const role = roles[element.role] ?? {};
    const sizes = [...(role.sizesPt?.values ?? []), ...(style.sizePt === undefined ? [] : [style.sizePt])];
    role.families = [...new Set([...(role.families ?? []), ...(style.family ? [style.family] : [])])].sort();
    role.sizesPt = numericVocabulary(sizes);
    role.weights = [...new Set([...(role.weights ?? []), ...(style.weight === undefined ? [] : [style.weight])])].sort((a, b) => a - b);
    role.lineHeightRatios = numericVocabulary([...(role.lineHeightRatios?.values ?? []), ...(style.lineHeightRatio === undefined ? [] : [style.lineHeightRatio])]);
    role.alignments = [...new Set([...(role.alignments ?? []), ...(style.alignment ? [style.alignment] : [])])].sort() as Array<"left" | "center" | "right">;
    if (role.families.length === 0) delete role.families;
    if (role.weights.length === 0) delete role.weights;
    if (role.lineHeightRatios.values.length === 0) delete role.lineHeightRatios;
    if (role.alignments.length === 0) delete role.alignments;
    roles[element.role] = role;
  }
  return { roles, typeScale: numericVocabulary(textElements.flatMap((element) => { const size = styleOf(element, artifact)?.sizePt; return size === undefined ? [] : [size]; })) };
}

export function compileTemplateDesignSystem(artifact: TemplateElementsArtifact, grammar: TemplateGrammar = compileTemplateGrammar(artifact)): TemplateDesignSystemArtifact {
  const elements = elementsOf(artifact);
  const textElements = elements.filter((element) => element.type === "text");
  const styleValues = elements.map((element) => styleOf(element, artifact));
  const dividerElements = elements.filter((element) => element.role === "divider");
  const surfaceElements = elements.filter((element) => element.type === "shape" || element.type === "image");
  const frames = contentFrame(grammar);
  const backgrounds = [
    ...artifact.slides.map((slide) => slide.background),
    ...artifact.layouts.map((layout) => layout.background),
    ...artifact.masters.map((master) => master.background),
  ];
  const anchors = alignmentAnchors(elements);
  return {
    version: 1,
    compilerVersion: TEMPLATE_DESIGN_SYSTEM_COMPILER_VERSION,
    sourceDigest: artifact.source.sha256,
    elementsDigest: elementsDigest(artifact),
    canvas: artifact.source.slideSize,
    typography: typography(elements, artifact),
    colors: {
      text: strings(textElements.map((element) => styleOf(element, artifact)?.color)),
      fill: strings(styleValues.map((style) => style?.fill)),
      stroke: strings(styleValues.map((style) => style?.stroke)),
      background: strings(backgrounds),
    },
    geometry: { ...frames, gutters: gaps(elements) },
    spacing: { rhythm: gaps(elements) },
    dividers: {
      orientations: dividerElements.map((element) => element.bounds.w === 0 && element.bounds.h === 0 ? "unknown" : element.bounds.w >= element.bounds.h ? "horizontal" : "vertical"),
      thicknesses: uniqueSorted(dividerElements.map((element) => Math.min(element.bounds.w, element.bounds.h)).filter((value) => value > 0)),
      lengths: uniqueSorted(dividerElements.map((element) => Math.max(element.bounds.w, element.bounds.h)).filter((value) => value > 0)),
      strokeWidthsPt: uniqueSorted(dividerElements.map((element) => styleOf(element, artifact)?.strokeWidthPt).filter((value): value is number => value !== undefined)),
      colors: strings(dividerElements.flatMap((element) => { const style = styleOf(element, artifact); return [style?.stroke, style?.fill, style?.color]; })),
    },
    surfaces: {
      fills: strings(surfaceElements.map((element) => styleOf(element, artifact)?.fill)),
      borders: strings(surfaceElements.map((element) => styleOf(element, artifact)?.stroke)),
      borderWidthsPt: uniqueSorted(surfaceElements.map((element) => styleOf(element, artifact)?.strokeWidthPt).filter((value): value is number => value !== undefined)),
    },
    alignmentAnchors: anchors,
  };
}
