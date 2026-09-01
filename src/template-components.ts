import { assertCanonicalTemplateElements, elementsDigest, elementsGeometryDigest, TEMPLATE_ANALYZER_VERSION, type SemanticRole, type TemplateCoordinateSpace, type TemplateElement, type TemplateElementsArtifact } from "./template-analysis";

export const TEMPLATE_COMPONENTS_COMPILER_VERSION = "2";
export const componentKinds = ["title_block", "subtitle_block", "body_block", "label", "metric", "surface", "card", "divider", "key_message", "list_item", "footer", "logo", "media_frame", "unknown"] as const;
export type ComponentKind = (typeof componentKinds)[number];
export type ResizeFeasibility = "safe" | "unsafe" | "unknown";
export type RepeatPattern = "single" | "horizontal_row" | "vertical_stack" | "grid";
type Rect = { x: number; y: number; w: number; h: number };

export type TemplateComponent = {
  id: string;
  kind: ComponentKind;
  sourceSlideId: string;
  sourceSlidePart: string;
  /** Internal provenance: raw element identity is never a host-authored input. */
  elementIds: string[];
  shapeNames: string[];
  sourceBounds: Rect;
  semanticRoles: SemanticRole[];
  styleRefs: string[];
  assetProvenance: { kind: "none" | "image" | "chart" | "table"; sourceSlidePart: string; sourceElementId: string; ref?: string };
  offCanvasHelper?: boolean;
  grouped?: boolean;
  repeatability: { signal: "single" | "repeatable"; count: number; groupId?: string; index?: number };
  resizeFeasibility: { horizontal: ResizeFeasibility; vertical: ResizeFeasibility };
  observedSiblings: string[];
  groupPattern: RepeatPattern;
  confidence: number;
};

export type TemplateRepeatGroup = {
  id: string;
  sourceSlideId: string;
  kind: ComponentKind;
  componentIds: string[];
  pattern: Exclude<RepeatPattern, "single">;
  confidence: number;
};

export type TemplateComponentsArtifact = {
  version: 1;
  compilerVersion: string;
  sourceDigest: string;
  elementsDigest: string;
  sourceGeometryDigest: string;
  canvas: { w: number; h: number };
  coordinateSpace?: TemplateCoordinateSpace;
  components: TemplateComponent[];
  repeatGroups: TemplateRepeatGroup[];
};

const kindByRole: Partial<Record<SemanticRole, ComponentKind>> = {
  title: "title_block",
  subtitle: "subtitle_block",
  body: "body_block",
  label: "label",
  caption: "label",
  eyebrow: "label",
  metric: "metric",
  metric_label: "label",
  key_message: "key_message",
  step: "list_item",
  source: "label",
  footer: "footer",
  logo: "logo",
  divider: "divider",
};

function kindFor(element: TemplateElement, canvas: { w: number; h: number }): ComponentKind {
  if (element.type === "image") return "media_frame";
  if (element.role === "surface") return element.bounds.w >= canvas.w * 0.9 && element.bounds.h >= canvas.h * 0.9 ? "surface" : "card";
  return kindByRole[element.role as SemanticRole] ?? "unknown";
}

function resizeFor(element: TemplateElement): { horizontal: ResizeFeasibility; vertical: ResizeFeasibility } {
  if (element.type === "text") return { horizontal: "safe", vertical: "safe" };
  if (element.type === "line") return element.bounds.w >= element.bounds.h ? { horizontal: "safe", vertical: "unsafe" } : { horizontal: "unsafe", vertical: "safe" };
  return { horizontal: "unknown", vertical: "unknown" };
}

function confidenceFor(element: TemplateElement, kind: ComponentKind): number {
  if (kind === "unknown") return 0;
  if (element.role !== "unknown") return element.confidence;
  return element.type === "image" ? 0.8 : 0;
}

function componentFor(element: TemplateElement, slidePart: string, canvas: { w: number; h: number }): TemplateComponent {
  const kind = kindFor(element, canvas);
  const assetKind = element.type === "image" || element.type === "chart" || element.type === "table" ? element.type : "none";
  return {
    id: `component-${element.id}`,
    kind,
    sourceSlideId: element.slideId,
    sourceSlidePart: slidePart,
    elementIds: [element.id],
    shapeNames: element.name ? [element.name] : [],
    sourceBounds: element.bounds,
    semanticRoles: element.role === "unknown" ? [] : [element.role],
    styleRefs: element.styleRef ? [element.styleRef] : [],
    assetProvenance: { kind: assetKind, sourceSlidePart: slidePart, sourceElementId: element.id, ...(element.assetRef ? { ref: element.assetRef } : {}) },
    ...(element.offCanvasHelper ? { offCanvasHelper: true } : {}),
    ...(element.grouped ? { grouped: true } : {}),
    repeatability: { signal: "single", count: 1 },
    resizeFeasibility: resizeFor(element),
    observedSiblings: [],
    groupPattern: "single",
    confidence: confidenceFor(element, kind),
  };
}

function similarSize(left: Rect, right: Rect): boolean {
  const tolerance = 0.05;
  return Math.abs(left.w - right.w) <= Math.max(left.w, right.w, 1) * tolerance && Math.abs(left.h - right.h) <= Math.max(left.h, right.h, 1) * tolerance;
}

function regular(values: number[]): boolean {
  if (values.length < 1 || values.some((value) => value <= 0)) return false;
  const first = values[0];
  return Math.max(...values) - Math.min(...values) <= Math.max(Math.abs(first), 1) * 0.05;
}

function groupPattern(components: TemplateComponent[]): RepeatPattern {
  const horizontal = [...components].sort((left, right) => left.sourceBounds.x - right.sourceBounds.x);
  const vertical = [...components].sort((left, right) => left.sourceBounds.y - right.sourceBounds.y);
  const centersX = components.map((component) => component.sourceBounds.x + component.sourceBounds.w / 2);
  const centersY = components.map((component) => component.sourceBounds.y + component.sourceBounds.h / 2);
  const horizontalGaps = horizontal.slice(1).map((component, index) => component.sourceBounds.x - (horizontal[index].sourceBounds.x + horizontal[index].sourceBounds.w));
  const verticalGaps = vertical.slice(1).map((component, index) => component.sourceBounds.y - (vertical[index].sourceBounds.y + vertical[index].sourceBounds.h));
  const sameRow = Math.max(...centersY) - Math.min(...centersY) <= 0.05;
  const sameColumn = Math.max(...centersX) - Math.min(...centersX) <= 0.05;
  if (sameRow && regular(horizontalGaps)) return "horizontal_row";
  if (sameColumn && regular(verticalGaps)) return "vertical_stack";
  if (regular(horizontalGaps) && regular(verticalGaps)) return "grid";
  return "single";
}

function repeatGroupsForSlide(slideComponents: TemplateComponent[]): Array<{ components: TemplateComponent[]; pattern: Exclude<RepeatPattern, "single"> }> {
  // ponytail: O(n²) grouping keeps the detector deterministic and dependency-free; use a spatial
  // index only if real templates show catalog analysis becoming a measured bottleneck.
  const groups: Array<{ components: TemplateComponent[]; pattern: Exclude<RepeatPattern, "single"> }> = [];
  const seen = new Set<string>();
  for (const candidate of slideComponents) {
    if (seen.has(candidate.id) || candidate.offCanvasHelper || candidate.kind === "unknown" || candidate.styleRefs.length === 0) continue;
    const members = slideComponents.filter((other) => !seen.has(other.id)
      && !other.offCanvasHelper
      && other.kind === candidate.kind
      && other.styleRefs.join("|") === candidate.styleRefs.join("|")
      && similarSize(other.sourceBounds, candidate.sourceBounds));
    const pattern = groupPattern(members);
    if (members.length < 2 || pattern === "single") continue;
    members.forEach((member) => seen.add(member.id));
    groups.push({ components: members, pattern });
  }
  return groups;
}

export function compileTemplateComponents(artifact: TemplateElementsArtifact): TemplateComponentsArtifact {
  if (artifact.coordinateSpace || artifact.analysisInputs?.analyzerVersion === TEMPLATE_ANALYZER_VERSION) assertCanonicalTemplateElements(artifact);
  if (artifact.coordinateSpace?.mode === "scaled" && artifact.slides.some((slide) => slide.elements.some((element) => element.grouped && !element.offCanvasHelper))) throw new Error("ADAPTIVE_COMPONENT_UNSUPPORTED: grouped components cannot be canonicalized losslessly in a scaled source coordinate space.");
  if (artifact.coordinateSpace?.mode === "scaled" && artifact.slides.some((slide) => {
    return slide.elements.some((element) => !element.offCanvasHelper && element.name && slide.elements.filter((candidate) => candidate.name === element.name).length > 1);
  })) throw new Error("TEMPLATE_COORDINATE_SPACE_UNSUPPORTED: duplicate non-helper shape names cannot be canonicalized losslessly in a scaled source coordinate space.");
  const components = artifact.slides.flatMap((slide) => slide.elements.map((element) => componentFor(element, slide.sourceSlidePart, artifact.source.slideSize)));
  const repeatGroups: TemplateRepeatGroup[] = [];
  for (const slide of artifact.slides) {
    const slideComponents = components.filter((component) => component.sourceSlideId === slide.id);
    for (const [index, group] of repeatGroupsForSlide(slideComponents).entries()) {
      const id = `repeat-${slide.id}-${String(index + 1).padStart(2, "0")}`;
      const componentIds = group.components.map((component) => component.id);
      const confidence = group.components.every((component) => component.styleRefs.length > 0 && component.sourceBounds.w > 0 && component.sourceBounds.h > 0) ? 0.95 : 0.7;
      repeatGroups.push({ id, sourceSlideId: slide.id, kind: group.components[0].kind, componentIds, pattern: group.pattern, confidence });
      group.components.forEach((component, componentIndex) => {
        component.repeatability = { signal: "repeatable", count: group.components.length, groupId: id, index: componentIndex };
        component.observedSiblings = componentIds.filter((componentId) => componentId !== component.id);
        component.groupPattern = group.pattern;
      });
    }
  }
  return {
    version: 1,
    compilerVersion: TEMPLATE_COMPONENTS_COMPILER_VERSION,
    sourceDigest: artifact.source.sha256,
    elementsDigest: elementsDigest(artifact),
    sourceGeometryDigest: elementsGeometryDigest(artifact),
    canvas: artifact.source.slideSize,
    coordinateSpace: artifact.coordinateSpace,
    components,
    repeatGroups,
  };
}
