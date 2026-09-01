import { elementsDigest as computeElementsDigest, type SemanticRole, type TemplateElement, type TemplateElementsArtifact } from "./template-analysis";
import type { TemplateDesignSystemArtifact } from "./template-design-system";

export const BRAND_CONSTRAINT_COMPILER_VERSION = "1";

export type Rect = { x: number; y: number; w: number; h: number };
export type BrandLockRole = "logo" | "header_chrome" | "footer_chrome" | "page_number" | "legal" | "persistent_decoration";
export type BrandConstraintEvidence = "master_or_layout_owned" | "cross_slide_repeat" | "stable_geometry" | "stable_style" | "stable_asset" | "edge_anchored";

export type ImmutableBrandRegion = {
  id: string;
  sourceElementId: string;
  sourceSlideId: string;
  role: BrandLockRole;
  bounds: Rect;
  reserveSpace: boolean;
  confidence: number;
  evidence: BrandConstraintEvidence[];
};

export type TemplateConstraintProfile = {
  version: 1;
  compilerVersion: string;
  sourceDigest: string;
  elementsDigest: string;
  canvas: { w: number; h: number };
  immutableRegions: ImmutableBrandRegion[];
  contentRegions: Array<{ id: string; bounds: Rect }>;
  styleVocabulary: {
    fonts: string[];
    textColors: string[];
    fillColors: string[];
    strokeColors: string[];
    backgroundColors: string[];
    textRoles: SemanticRole[];
  };
  policies: {
    chrome: "immutable";
    colors: "template_only";
    fonts: "template_only";
  };
};

const STRUCTURAL_ROLES = new Set<TemplateElement["role"]>(["logo", "footer", "surface", "divider"]);
const round = (value: number): number => Math.round(value * 1000) / 1000;
const normalize = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");
const uniqueStrings = (values: Array<string | undefined>): string[] => [...new Set(values.filter((value): value is string => Boolean(value)).map((value) => value.toUpperCase()))].sort();

function nearTop(bounds: Rect, canvas: { w: number; h: number }): boolean {
  return bounds.y <= canvas.h * 0.12;
}

function nearBottom(bounds: Rect, canvas: { w: number; h: number }): boolean {
  return bounds.y + bounds.h >= canvas.h * 0.88;
}

function edgeAnchored(bounds: Rect, canvas: { w: number; h: number }): boolean {
  return nearTop(bounds, canvas) || nearBottom(bounds, canvas) || bounds.x <= canvas.w * 0.04 || bounds.x + bounds.w >= canvas.w * 0.96;
}

function isFullCanvasSurface(element: TemplateElement, canvas: { w: number; h: number }): boolean {
  return element.role === "surface" && element.bounds.w >= canvas.w * 0.9 && element.bounds.h >= canvas.h * 0.9;
}

function lockRole(element: TemplateElement, canvas: { w: number; h: number }): BrandLockRole {
  if (element.role === "logo") return "logo";
  if (element.role === "footer") return element.features.numericOnly ? "page_number" : "footer_chrome";
  if ((element.role === "divider" || element.role === "surface") && nearTop(element.bounds, canvas) && element.bounds.h <= canvas.h * 0.3) return "header_chrome";
  if ((element.role === "divider" || element.role === "surface") && nearBottom(element.bounds, canvas) && element.bounds.h <= canvas.h * 0.3) return "footer_chrome";
  return "persistent_decoration";
}

function reserveSpace(element: TemplateElement, role: BrandLockRole, canvas: { w: number; h: number }): boolean {
  if (isFullCanvasSurface(element, canvas)) return false;
  return role === "logo" || role === "header_chrome" || role === "footer_chrome" || role === "page_number" || role === "legal";
}

function geometryKey(element: TemplateElement): string {
  const { x, y, w, h } = element.bounds;
  return [element.role, round(x), round(y), round(w), round(h), element.styleRef ?? "", element.assetRef ?? ""].join("|");
}

function stableRepeatedSlideBody(artifact: TemplateElementsArtifact): TemplateElement[] {
  const buckets = new Map<string, { elements: TemplateElement[]; slideIds: Set<string> }>();
  for (const slide of artifact.slides) {
    for (const element of slide.elements) {
      if (element.offCanvasHelper || element.ownership !== "slide-body-owned" || !STRUCTURAL_ROLES.has(element.role)) continue;
      if (!edgeAnchored(element.bounds, artifact.source.slideSize) && element.role !== "logo") continue;
      const key = geometryKey(element);
      const bucket = buckets.get(key) ?? { elements: [], slideIds: new Set<string>() };
      bucket.elements.push(element);
      bucket.slideIds.add(slide.id);
      buckets.set(key, bucket);
    }
  }
  const required = Math.max(2, Math.ceil(artifact.slides.length * 0.6));
  return [...buckets.values()].filter((bucket) => bucket.slideIds.size >= required).map((bucket) => bucket.elements[0]);
}

function inheritedStructural(artifact: TemplateElementsArtifact): TemplateElement[] {
  return [...artifact.layouts.flatMap((layout) => layout.elements), ...artifact.masters.flatMap((master) => master.elements)]
    .filter((element) => !element.offCanvasHelper && STRUCTURAL_ROLES.has(element.role));
}

function immutableFromInherited(element: TemplateElement, canvas: { w: number; h: number }): ImmutableBrandRegion {
  const role = lockRole(element, canvas);
  return {
    id: `immutable:${element.ownership}:${element.id}`,
    sourceElementId: element.id,
    sourceSlideId: element.slideId,
    role,
    bounds: { ...element.bounds },
    reserveSpace: reserveSpace(element, role, canvas),
    confidence: 0.99,
    evidence: ["master_or_layout_owned", "stable_geometry", ...(element.styleRef ? ["stable_style" as const] : []), ...(element.assetRef ? ["stable_asset" as const] : []), ...(edgeAnchored(element.bounds, canvas) ? ["edge_anchored" as const] : [])],
  };
}

function immutableFromRepeated(element: TemplateElement, canvas: { w: number; h: number }): ImmutableBrandRegion {
  const role = lockRole(element, canvas);
  return {
    id: `immutable:repeat:${normalize(geometryKey(element))}`,
    sourceElementId: element.id,
    sourceSlideId: element.slideId,
    role,
    bounds: { ...element.bounds },
    reserveSpace: reserveSpace(element, role, canvas),
    confidence: element.role === "logo" ? 0.98 : 0.94,
    evidence: ["cross_slide_repeat", "stable_geometry", ...(element.styleRef ? ["stable_style" as const] : []), ...(element.assetRef ? ["stable_asset" as const] : []), "edge_anchored"],
  };
}

function dedupeRegions(regions: ImmutableBrandRegion[]): ImmutableBrandRegion[] {
  const seen = new Set<string>();
  return regions.filter((region) => {
    const key = `${region.role}|${round(region.bounds.x)}|${round(region.bounds.y)}|${round(region.bounds.w)}|${round(region.bounds.h)}|${region.sourceElementId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x || a.id.localeCompare(b.id));
}

function typographyFamilies(designSystem: TemplateDesignSystemArtifact): string[] {
  const families = Object.values(designSystem.typography.roles).flatMap((role) => role?.families ?? []);
  return [...new Set(families)].sort();
}

export function compileTemplateConstraintProfile(artifact: TemplateElementsArtifact, designSystem: TemplateDesignSystemArtifact): TemplateConstraintProfile {
  if (artifact.source.sha256 !== designSystem.sourceDigest || computeElementsDigest(artifact) !== designSystem.elementsDigest) {
    throw new Error("BRAND_CONSTRAINT_PROVENANCE_MISMATCH: Design System and template elements describe different analyzed inputs.");
  }
  const canvas = artifact.source.slideSize;
  const inherited = inheritedStructural(artifact).map((element) => immutableFromInherited(element, canvas));
  const repeated = stableRepeatedSlideBody(artifact).map((element) => immutableFromRepeated(element, canvas));
  const frame = designSystem.geometry.contentFrame ?? { x: 0, y: 0, w: canvas.w, h: canvas.h };
  if (![frame.x, frame.y, frame.w, frame.h].every(Number.isFinite) || frame.w <= 0 || frame.h <= 0 || frame.x < 0 || frame.y < 0 || frame.x + frame.w > canvas.w + 1e-6 || frame.y + frame.h > canvas.h + 1e-6) {
    throw new Error("BRAND_CONSTRAINT_CONTENT_FRAME_INVALID: template Design System content frame is not usable.");
  }
  return {
    version: 1,
    compilerVersion: BRAND_CONSTRAINT_COMPILER_VERSION,
    sourceDigest: artifact.source.sha256,
    elementsDigest: designSystem.elementsDigest,
    canvas,
    immutableRegions: dedupeRegions([...inherited, ...repeated]),
    contentRegions: [{ id: "content-main", bounds: { ...frame } }],
    styleVocabulary: {
      fonts: typographyFamilies(designSystem),
      textColors: uniqueStrings(designSystem.colors.text),
      fillColors: uniqueStrings(designSystem.colors.fill),
      strokeColors: uniqueStrings(designSystem.colors.stroke),
      backgroundColors: uniqueStrings(designSystem.colors.background),
      textRoles: ["title", "subtitle", "heading", "body", "caption", "eyebrow", "label", "key_message", "metric", "metric_label", "annotation", "step", "route", "source", "logo", "footer", "surface", "divider"],
    },
    policies: { chrome: "immutable", colors: "template_only", fonts: "template_only" },
  };
}
