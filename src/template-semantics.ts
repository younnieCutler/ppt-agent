import { elementsDigest, type TemplateElement, type TemplateElementsArtifact } from "./template-analysis";

export const TEMPLATE_SEMANTICS_COMPILER_VERSION = "1";

export type SourceSlideUsage = "structural_template" | "reference_only";
export type TemplateSemanticsEvidence =
  | "slide_body_placeholder"
  | "layout_placeholder"
  | "placeholder_dominant_body"
  | "example_body_geometry"
  | "blank_or_nonstructural_layout";

export type SourceSlideSemantics = {
  slideId: string;
  nativeLayoutIndex: number;
  nativeLayoutName: string;
  usage: SourceSlideUsage;
  placeholderCount: number;
  contentElementCount: number;
  evidence: TemplateSemanticsEvidence[];
};

export type TemplateSemanticsProfile = {
  version: 1;
  compilerVersion: string;
  sourceDigest: string;
  elementsDigest: string;
  slides: SourceSlideSemantics[];
  policies: {
    masterLayoutGeometry: "structural";
    sourceSlideGeometry: "reference_only_by_default";
    sourceSlideStyles: "reference_library";
    compositionAuthority: "model_authored_unless_placeholder_structural";
  };
};

const NON_CONTENT_ROLES = new Set<TemplateElement["role"]>(["logo", "footer", "surface", "divider"]);

function isPlaceholder(element: TemplateElement): boolean {
  return Boolean(element.features.placeholderType || element.features.placeholderToken);
}

function contentElements(elements: TemplateElement[]): TemplateElement[] {
  return elements.filter((element) => !element.offCanvasHelper && !NON_CONTENT_ROLES.has(element.role));
}

function layoutHasPlaceholder(artifact: TemplateElementsArtifact, layoutIndex: number): boolean {
  const layout = artifact.layouts.find((candidate) => candidate.index === layoutIndex);
  return Boolean(layout?.elements.some((element) => !element.offCanvasHelper && isPlaceholder(element)));
}

function classifySlide(artifact: TemplateElementsArtifact, slide: TemplateElementsArtifact["slides"][number]): SourceSlideSemantics {
  const content = contentElements(slide.elements);
  const placeholders = content.filter(isPlaceholder);
  const layoutPlaceholder = layoutHasPlaceholder(artifact, slide.nativeLayout.index);
  const placeholderDominant = placeholders.length > 0 && placeholders.length >= Math.max(1, Math.ceil(content.length * 0.6));
  const structural = placeholderDominant;
  const evidence: TemplateSemanticsEvidence[] = [];

  if (placeholders.length > 0) evidence.push("slide_body_placeholder");
  if (layoutPlaceholder) evidence.push("layout_placeholder");
  if (placeholderDominant) evidence.push("placeholder_dominant_body");
  if (!structural && content.length > 0) evidence.push("example_body_geometry");
  if (!layoutPlaceholder) evidence.push("blank_or_nonstructural_layout");

  return {
    slideId: slide.id,
    nativeLayoutIndex: slide.nativeLayout.index,
    nativeLayoutName: slide.nativeLayout.name,
    usage: structural ? "structural_template" : "reference_only",
    placeholderCount: placeholders.length,
    contentElementCount: content.length,
    evidence,
  };
}

export function compileTemplateSemantics(artifact: TemplateElementsArtifact): TemplateSemanticsProfile {
  return {
    version: 1,
    compilerVersion: TEMPLATE_SEMANTICS_COMPILER_VERSION,
    sourceDigest: artifact.source.sha256,
    elementsDigest: elementsDigest(artifact),
    slides: artifact.slides.map((slide) => classifySlide(artifact, slide)),
    policies: {
      masterLayoutGeometry: "structural",
      sourceSlideGeometry: "reference_only_by_default",
      sourceSlideStyles: "reference_library",
      compositionAuthority: "model_authored_unless_placeholder_structural",
    },
  };
}

export function sourceSlideUsage(profile: TemplateSemanticsProfile, slideId: string): SourceSlideUsage {
  const slide = profile.slides.find((candidate) => candidate.slideId === slideId);
  if (!slide) throw new Error(`TEMPLATE_SEMANTICS_SOURCE_SLIDE_MISSING: '${slideId}' is absent from the semantics profile.`);
  return slide.usage;
}
