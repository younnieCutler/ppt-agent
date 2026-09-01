import { z } from "zod";
import type { Rect, TemplateConstraintProfile } from "./brand-constraints";
import { slideFunctionSchema } from "./schema";
import { semanticRoles } from "./template-analysis";
import { componentKinds, type ComponentKind } from "./template-components";

export const GENERATIVE_SCENE_VERSION = 3 as const;
export const GENERATIVE_SCENE_LEGACY_VERSION = 2 as const;

export const generativeTextNodeRoles = [
  "headline",
  "body",
  "label",
  "metric",
  "item",
  "step",
  "evidence",
  "action",
] as const;

export const generativeNativePrimitiveRoles = ["connector", "chart", "image", "icon"] as const;

export const generativeNodeRoles = [
  ...generativeTextNodeRoles,
  "surface",
  "divider",
  ...generativeNativePrimitiveRoles,
] as const;

const TEXT_ROLES = new Set<string>(generativeTextNodeRoles);
const NATIVE_PRIMITIVE_ROLES = new Set<string>(generativeNativePrimitiveRoles);
const STRUCTURAL_COMPONENTS = new Set<ComponentKind>(["surface", "card", "divider"]);

const normalizedRectSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
}).strict().superRefine((frame, context) => {
  if (frame.x + frame.w > 1 + 1e-9) context.addIssue({ code: z.ZodIssueCode.custom, path: ["w"], message: "Normalized frame exceeds the content region width." });
  if (frame.y + frame.h > 1 + 1e-9) context.addIssue({ code: z.ZodIssueCode.custom, path: ["h"], message: "Normalized frame exceeds the content region height." });
});

const sharedNodeFields = {
  id: z.string().min(1),
  frame: normalizedRectSchema,
  emphasis: z.number().min(0).max(1).default(0.5),
  group: z.string().min(1).optional(),
};

const textNodeSchema = z.object({
  ...sharedNodeFields,
  role: z.enum(generativeTextNodeRoles),
  text: z.string().min(1),
  styleRole: z.enum(semanticRoles).optional(),
  componentPreference: z.enum(componentKinds).optional(),
}).strict().superRefine((node, context) => {
  if (node.componentPreference && STRUCTURAL_COMPONENTS.has(node.componentPreference)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["componentPreference"], message: "Text Scene nodes cannot request structural template components." });
  }
});

const surfaceNodeSchema = z.object({
  ...sharedNodeFields,
  role: z.literal("surface"),
  componentPreference: z.enum(["surface", "card"]).optional(),
}).strict();

const dividerNodeSchema = z.object({
  ...sharedNodeFields,
  role: z.literal("divider"),
  componentPreference: z.literal("divider").optional(),
}).strict();

const connectorNodeSchema = z.object({
  ...sharedNodeFields,
  role: z.literal("connector"),
  orientation: z.enum(["horizontal", "vertical", "diagonal_down", "diagonal_up"]).default("horizontal"),
  arrow: z.enum(["none", "end"]).default("end"),
  weight: z.enum(["light", "regular", "strong"]).default("regular"),
}).strict();

const chartNodeSchema = z.object({
  ...sharedNodeFields,
  role: z.literal("chart"),
  datasetRef: z.string().min(1),
  chartType: z.enum(["bar", "horizontal_bar", "stacked_bar", "line", "pie", "donut"]),
}).strict();

const imageNodeSchema = z.object({
  ...sharedNodeFields,
  role: z.literal("image"),
  assetRef: z.string().min(1),
  fit: z.enum(["contain", "cover"]).default("contain"),
}).strict();

const iconNodeSchema = z.object({
  ...sharedNodeFields,
  role: z.literal("icon"),
  assetRef: z.string().min(1),
  fit: z.literal("contain").default("contain"),
}).strict();

export const generativeSceneNodeSchema = z.union([
  textNodeSchema,
  surfaceNodeSchema,
  dividerNodeSchema,
  connectorNodeSchema,
  chartNodeSchema,
  imageNodeSchema,
  iconNodeSchema,
]);

export const generativeSceneIntentSchema = z.object({
  version: z.union([z.literal(GENERATIVE_SCENE_LEGACY_VERSION), z.literal(GENERATIVE_SCENE_VERSION)]),
  slideId: z.string().regex(/^S\d{2,}$/),
  semanticIntent: slideFunctionSchema,
  headline: z.string().min(1),
  contentRegionId: z.string().min(1).default("content-main"),
  layout: z.object({
    strategy: z.literal("model_authored"),
    nodes: z.array(generativeSceneNodeSchema).min(1).max(100),
  }).strict(),
  constraints: z.object({
    chrome: z.literal("immutable").default("immutable"),
    colors: z.literal("template_only").default("template_only"),
    fonts: z.literal("template_only").default("template_only"),
  }).strict().default({ chrome: "immutable", colors: "template_only", fonts: "template_only" }),
}).strict().superRefine((scene, context) => {
  const ids = scene.layout.nodes.map((node) => node.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["layout", "nodes"], message: "Generative Scene node ids must be unique." });
  const headlines = scene.layout.nodes.filter((node) => node.role === "headline");
  if (headlines.length !== 1) context.addIssue({ code: z.ZodIssueCode.custom, path: ["layout", "nodes"], message: "Generative corporate slides require exactly one headline node." });
  if (scene.version === GENERATIVE_SCENE_LEGACY_VERSION && scene.layout.nodes.some((node) => NATIVE_PRIMITIVE_ROLES.has(node.role))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["version"], message: "Native visual primitives require Generative Scene version 3." });
  }
});

export type GenerativeSceneIntent = z.infer<typeof generativeSceneIntentSchema>;
export type GenerativeSceneNode = GenerativeSceneIntent["layout"]["nodes"][number];
export type GenerativeTextNode = Extract<GenerativeSceneNode, { role: (typeof generativeTextNodeRoles)[number] }>;
export type GenerativeNativePrimitiveNode = Extract<GenerativeSceneNode, { role: (typeof generativeNativePrimitiveRoles)[number] }>;
export type ResolvedGenerativeNode = GenerativeSceneNode & { bounds: Rect };
export type ResolvedGenerativeScene = {
  version: 2 | 3;
  slideId: string;
  semanticIntent: GenerativeSceneIntent["semanticIntent"];
  headline: string;
  contentRegionId: string;
  contentRegion: Rect;
  nodes: ResolvedGenerativeNode[];
  brandConstraintDigestInput: { sourceDigest: string; elementsDigest: string; compilerVersion: string };
};

export function isGenerativeTextNode(node: GenerativeSceneNode): node is GenerativeTextNode {
  return TEXT_ROLES.has(node.role);
}

export function isGenerativeNativePrimitiveNode(node: GenerativeSceneNode): node is GenerativeNativePrimitiveNode {
  return NATIVE_PRIMITIVE_ROLES.has(node.role);
}

export function isGenerativeComponentNode(node: GenerativeSceneNode): boolean {
  return !isGenerativeNativePrimitiveNode(node);
}

export function nativePrimitiveObjectName(nodeId: string): string {
  return `generative.native.${nodeId}`;
}

const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

function intersects(left: Rect, right: Rect): boolean {
  const epsilon = 1e-6;
  return Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x) > epsilon
    && Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y) > epsilon;
}

function contains(outer: Rect, inner: Rect): boolean {
  const epsilon = 1e-6;
  return inner.x >= outer.x - epsilon
    && inner.y >= outer.y - epsilon
    && inner.x + inner.w <= outer.x + outer.w + epsilon
    && inner.y + inner.h <= outer.y + outer.h + epsilon;
}

function physicalFrame(normalized: z.infer<typeof normalizedRectSchema>, region: Rect): Rect {
  return {
    x: round(region.x + normalized.x * region.w),
    y: round(region.y + normalized.y * region.h),
    w: round(normalized.w * region.w),
    h: round(normalized.h * region.h),
  };
}

function validateProfile(profile: TemplateConstraintProfile): void {
  if (profile.version !== 1 || profile.compilerVersion.length === 0 || profile.sourceDigest.length === 0 || profile.elementsDigest.length === 0) {
    throw new Error("GENERATIVE_SCENE_BRAND_PROFILE_INVALID: template constraint provenance is incomplete.");
  }
  if (profile.policies.chrome !== "immutable" || profile.policies.colors !== "template_only" || profile.policies.fonts !== "template_only") {
    throw new Error("GENERATIVE_SCENE_BRAND_POLICY_UNSUPPORTED: corporate Scene runtime requires immutable chrome and template-only colors/fonts.");
  }
}

export function resolveGenerativeScene(intent: GenerativeSceneIntent, profile: TemplateConstraintProfile): ResolvedGenerativeScene {
  validateProfile(profile);
  const parsed = generativeSceneIntentSchema.parse(intent);
  const region = profile.contentRegions.find((candidate) => candidate.id === parsed.contentRegionId);
  if (!region) throw new Error(`GENERATIVE_SCENE_CONTENT_REGION_MISSING: '${parsed.contentRegionId}' does not exist in the template constraint profile.`);

  const reserved = profile.immutableRegions.filter((candidate) => candidate.reserveSpace);
  const nodes = parsed.layout.nodes.map((node) => {
    const bounds = physicalFrame(node.frame, region.bounds);
    if (!contains(region.bounds, bounds)) throw new Error(`GENERATIVE_SCENE_GEOMETRY_OVERFLOW: node '${node.id}' exceeds content region '${region.id}'.`);
    const collision = reserved.find((candidate) => intersects(bounds, candidate.bounds));
    if (collision) throw new Error(`GENERATIVE_SCENE_IMMUTABLE_COLLISION: node '${node.id}' overlaps ${collision.role} '${collision.id}'.`);
    if (isGenerativeTextNode(node) && node.styleRole && !profile.styleVocabulary.textRoles.includes(node.styleRole)) {
      throw new Error(`GENERATIVE_SCENE_STYLE_ROLE_UNSUPPORTED: '${node.styleRole}' is not present in the template style vocabulary.`);
    }
    return { ...node, bounds };
  });

  return {
    version: parsed.version,
    slideId: parsed.slideId,
    semanticIntent: parsed.semanticIntent,
    headline: parsed.headline,
    contentRegionId: parsed.contentRegionId,
    contentRegion: { ...region.bounds },
    nodes,
    brandConstraintDigestInput: {
      sourceDigest: profile.sourceDigest,
      elementsDigest: profile.elementsDigest,
      compilerVersion: profile.compilerVersion,
    },
  };
}
