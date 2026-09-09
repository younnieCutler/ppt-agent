import { z } from "zod";
import { elementsDigest, semanticRoles, type SemanticRole, type TemplateElement, type TemplateElementsArtifact } from "./template-analysis";

export const referenceBusinessRoles = [
  "unclassified",
  "cover",
  "agenda",
  "executive_summary",
  "financial_table",
  "business_highlight",
  "before_after",
  "outlook",
  "strategy",
  "architecture",
  "portfolio",
  "investment_roadmap",
  "timeline",
  "guidance",
  "decision",
  "appendix",
] as const;

export const referenceBusinessRoleSchema = z.enum(referenceBusinessRoles);
export type ReferenceBusinessRole = z.infer<typeof referenceBusinessRoleSchema>;

const rectSchema = z.object({ x: z.number(), y: z.number(), w: z.number().nonnegative(), h: z.number().nonnegative() }).strict();
const templateElementTypeSchema = z.enum(["text", "shape", "line", "image", "chart", "table"]);
const semanticRoleSchema = z.union([z.enum(semanticRoles), z.literal("unknown")]);

export const referenceSlideProfileSchema = z.object({
  slideId: z.string().min(1),
  businessRole: referenceBusinessRoleSchema,
  informationBlocks: z.number().int().nonnegative(),
  dominantElement: z.object({
    id: z.string().min(1),
    type: templateElementTypeSchema,
    role: semanticRoleSchema,
    bounds: rectSchema,
  }).strict().optional(),
  nativeObjects: z.object({
    text: z.number().int().nonnegative(),
    shapes: z.number().int().nonnegative(),
    lines: z.number().int().nonnegative(),
    images: z.number().int().nonnegative(),
    charts: z.number().int().nonnegative(),
    tables: z.number().int().nonnegative(),
  }).strict(),
  geometry: z.object({
    titleRegion: rectSchema.optional(),
    bodyStart: z.number().optional(),
    footerRegion: rectSchema.optional(),
    alignmentAnchors: z.object({ x: z.array(z.number()), y: z.array(z.number()) }).strict(),
    rowRhythm: z.array(z.number().positive()),
  }).strict(),
}).strict();

export const referenceSlideProfilesArtifactSchema = z.object({
  version: z.literal(1),
  sourceDigest: z.string().min(1),
  elementsDigest: z.string().min(1),
  canvas: z.object({ w: z.number().positive(), h: z.number().positive() }).strict(),
  slides: z.array(referenceSlideProfileSchema),
}).strict().superRefine((artifact, ctx) => {
  const ids = artifact.slides.map((slide) => slide.slideId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["slides"], message: "Reference slide profiles must contain unique slideId values." });
  }
});

export type ReferenceSlideProfile = z.infer<typeof referenceSlideProfileSchema>;
export type ReferenceSlideProfilesArtifact = z.infer<typeof referenceSlideProfilesArtifactSchema>;
type Rect = z.infer<typeof rectSchema>;

const roleLabelSchema = z.object({
  slideId: z.string().min(1),
  businessRole: referenceBusinessRoleSchema.refine((role) => role !== "unclassified", "Role labels must assign a concrete business role."),
}).strict();

export const referenceSlideRoleLabelsSchema = z.array(roleLabelSchema).superRefine((labels, ctx) => {
  const ids = labels.map((label) => label.slideId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Reference slide role labels must contain each slideId at most once." });
  }
});

const structuralRoles = new Set<SemanticRole | "unknown">(["footer", "logo", "surface", "divider"]);
const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.filter(Number.isFinite).map(round))].sort((a, b) => a - b);
}

function unionBounds(elements: TemplateElement[]): Rect | undefined {
  if (elements.length === 0) return undefined;
  const left = Math.min(...elements.map((element) => element.bounds.x));
  const top = Math.min(...elements.map((element) => element.bounds.y));
  const right = Math.max(...elements.map((element) => element.bounds.x + element.bounds.w));
  const bottom = Math.max(...elements.map((element) => element.bounds.y + element.bounds.h));
  return { x: round(left), y: round(top), w: round(right - left), h: round(bottom - top) };
}

function contentElements(elements: TemplateElement[]): TemplateElement[] {
  return elements.filter((element) => !element.offCanvasHelper && !structuralRoles.has(element.role));
}

function dominantElement(elements: TemplateElement[]): ReferenceSlideProfile["dominantElement"] {
  const candidate = [...elements].sort((left, right) => right.bounds.w * right.bounds.h - left.bounds.w * left.bounds.h || left.zIndex - right.zIndex)[0];
  if (!candidate) return undefined;
  return { id: candidate.id, type: candidate.type, role: candidate.role, bounds: candidate.bounds };
}

function alignmentAnchors(elements: TemplateElement[]): { x: number[]; y: number[] } {
  return {
    x: uniqueSorted(elements.flatMap((element) => [element.bounds.x, element.bounds.x + element.bounds.w / 2, element.bounds.x + element.bounds.w])),
    y: uniqueSorted(elements.flatMap((element) => [element.bounds.y, element.bounds.y + element.bounds.h / 2, element.bounds.y + element.bounds.h])),
  };
}

function rowRhythm(elements: TemplateElement[]): number[] {
  const starts = uniqueSorted(elements.map((element) => element.bounds.y));
  return uniqueSorted(starts.slice(1).map((value, index) => value - starts[index]).filter((value) => value > 0));
}

function nativeObjectCounts(elements: TemplateElement[]): ReferenceSlideProfile["nativeObjects"] {
  return {
    text: elements.filter((element) => element.type === "text").length,
    shapes: elements.filter((element) => element.type === "shape").length,
    lines: elements.filter((element) => element.type === "line").length,
    images: elements.filter((element) => element.type === "image").length,
    charts: elements.filter((element) => element.type === "chart").length,
    tables: elements.filter((element) => element.type === "table").length,
  };
}

function profileSlide(slide: TemplateElementsArtifact["slides"][number]): ReferenceSlideProfile {
  const visible = slide.elements.filter((element) => !element.offCanvasHelper);
  const content = contentElements(visible);
  const titleElements = visible.filter((element) => element.role === "title");
  const footerElements = visible.filter((element) => element.role === "footer");
  const bodyCandidates = content.filter((element) => element.role !== "title" && element.role !== "subtitle" && element.role !== "eyebrow");
  return referenceSlideProfileSchema.parse({
    slideId: slide.id,
    businessRole: "unclassified",
    informationBlocks: content.length,
    dominantElement: dominantElement(content),
    nativeObjects: nativeObjectCounts(visible),
    geometry: {
      titleRegion: unionBounds(titleElements),
      bodyStart: bodyCandidates.length > 0 ? round(Math.min(...bodyCandidates.map((element) => element.bounds.y))) : undefined,
      footerRegion: unionBounds(footerElements),
      alignmentAnchors: alignmentAnchors(content),
      rowRhythm: rowRhythm(content),
    },
  });
}

export function compileReferenceSlideProfiles(artifact: TemplateElementsArtifact): ReferenceSlideProfilesArtifact {
  return referenceSlideProfilesArtifactSchema.parse({
    version: 1,
    sourceDigest: artifact.source.sha256,
    elementsDigest: elementsDigest(artifact),
    canvas: artifact.source.slideSize,
    slides: artifact.slides.map(profileSlide),
  });
}

export function applyReferenceSlideRoleLabels(
  artifactInput: ReferenceSlideProfilesArtifact,
  labelsInput: unknown,
): ReferenceSlideProfilesArtifact {
  const artifact = referenceSlideProfilesArtifactSchema.parse(artifactInput);
  const labels = referenceSlideRoleLabelsSchema.parse(labelsInput);
  const slideIds = new Set(artifact.slides.map((slide) => slide.slideId));
  const unknown = labels.filter((label) => !slideIds.has(label.slideId));
  if (unknown.length > 0) throw new Error(`Reference role label(s) target unknown slide(s): ${unknown.map((label) => label.slideId).join(", ")}.`);
  const byId = new Map(labels.map((label) => [label.slideId, label.businessRole]));
  return referenceSlideProfilesArtifactSchema.parse({
    ...artifact,
    slides: artifact.slides.map((slide) => ({ ...slide, businessRole: byId.get(slide.slideId) ?? slide.businessRole })),
  });
}
