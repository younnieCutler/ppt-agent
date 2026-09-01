import { assertCanonicalTemplateElements, elementsDigest, elementsGeometryDigest, TEMPLATE_ANALYZER_VERSION, type SemanticRole, type TemplateCoordinateSpace, type TemplateElement, type TemplateElementsArtifact } from "./template-analysis";

export const TEMPLATE_COMPONENTS_COMPILER_VERSION = "2";
export const componentKinds = ["title_block", "subtitle_block", "body_block", "label", "metric", "surface", "card", "divider", "key_message", "list_item", "footer", "logo", "media_frame", "unknown"] as const;
export type ComponentKind = (typeof componentKinds)[number];
export type ResizeFeasibility = "safe" | "unsafe" | "unknown";
export type RepeatPattern = "single" | "horizontal_row" | "vertical_stack" | "grid";
type Rect = { x: number; y: number; w: number; h: number };
type AxisCluster = { center: number; members: TemplateComponent[] };

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
  if (element.role === "logo") return "logo";
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

function axisCenter(component: TemplateComponent, axis: "x" | "y"): number {
  return axis === "x" ? component.sourceBounds.x + component.sourceBounds.w / 2 : component.sourceBounds.y + component.sourceBounds.h / 2;
}

function clusterByCenter(components: TemplateComponent[], axis: "x" | "y"): AxisCluster[] {
  const tolerance = 0.05;
  const sorted = [...components].sort((left, right) => axisCenter(left, axis) - axisCenter(right, axis) || left.id.localeCompare(right.id));
  const clusters: AxisCluster[] = [];
  for (const component of sorted) {
    const center = axisCenter(component, axis);
    const current = clusters[clusters.length - 1];
    if (!current || Math.abs(center - current.center) > tolerance) {
      clusters.push({ center, members: [component] });
      continue;
    }
    current.members.push(component);
    current.center = current.members.reduce((sum, member) => sum + axisCenter(member, axis), 0) / current.members.length;
  }
  return clusters;
}

function clusterGaps(clusters: AxisCluster[], axis: "x" | "y"): number[] {
  return clusters.slice(1).map((cluster, index) => {
    const previous = clusters[index];
    if (axis === "x") {
      const previousEnd = Math.max(...previous.members.map((member) => member.sourceBounds.x + member.sourceBounds.w));
      const nextStart = Math.min(...cluster.members.map((member) => member.sourceBounds.x));
      return nextStart - previousEnd;
    }
    const previousEnd = Math.max(...previous.members.map((member) => member.sourceBounds.y + member.sourceBounds.h));
    const nextStart = Math.min(...cluster.members.map((member) => member.sourceBounds.y));
    return nextStart - previousEnd;
  });
}

function occupiesEveryCell(rows: AxisCluster[], columns: AxisCluster[], components: TemplateComponent[]): boolean {
  if (rows.length * columns.length !== components.length) return false;
  const tolerance = 0.05;
  for (const row of rows) {
    for (const column of columns) {
      const count = components.filter((component) => Math.abs(axisCenter(component, "y") - row.center) <= tolerance && Math.abs(axisCenter(component, "x") - column.center) <= tolerance).length;
      if (count !== 1) return false;
    }
  }
  return true;
}

function groupPattern(components: TemplateComponent[]): RepeatPattern {
  if (components.length < 2) return "single";
  const rows = clusterByCenter(components, "y");
  const columns = clusterByCenter(components, "x");
  const horizontalGaps = clusterGaps(columns, "x");
  const verticalGaps = clusterGaps(rows, "y");
  if (rows.length === 1 && columns.length === components.length && regular(horizontalGaps)) return "horizontal_row";
  if (columns.length === 1 && rows.length === components.length && regular(verticalGaps)) return "vertical_stack";
  if (rows.length >= 2 && columns.length >= 2 && occupiesEveryCell(rows, columns, components) && regular(horizontalGaps) && regular(verticalGaps)) return "grid";
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
  // Grouped components may safely remain in the catalog when their already-rendered geometry is
  // canonical. They are still non-transformable: the Generative Scene compiler excludes grouped
  // prototypes and the transform engine hard-fails any direct grouped operation. Keeping them in
  // the catalog is required for immutable vector logos/chrome to survive base-slide sanitization.
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
