import { z } from "zod";
import type { Rect, TemplateConstraintProfile } from "./brand-constraints";
import { slideFunctionSchema } from "./schema";
import { semanticRoles } from "./template-analysis";
import { componentKinds, type ComponentKind } from "./template-components";

export const GENERATIVE_SCENE_VERSION = 2 as const;

export const generativeNodeRoles = [
  "headline",
  "body",
  "label",
  "metric",
  "item",
  "step",
  "evidence",
  "action",
  "surface",
  "divider",
] as const;

const TEXT_ROLES = new Set<(typeof generativeNodeRoles)[number]>(["headline", "body", "label", "metric", "item", "step", "evidence", "action"]);
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

const generativeSceneNodeSchema = z.object({
  id: z.string().min(1),
  role: z.enum(generativeNodeRoles),
  text: z.string().min(1).optional(),
  frame: normalizedRectSchema,
  emphasis: z.number().min(0).max(1).default(0.5),
  group: z.string().min(1).optional(),
  styleRole: z.enum(semanticRoles).optional(),
  componentPreference: z.enum(componentKinds).optional(),
}).strict().superRefine((node, context) => {
  const isText = TEXT_ROLES.has(node.role);
  if (isText && !node.text) context.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: `Generative Scene ${node.role} nodes require text.` });
  if (!isText && node.text) context.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: `Structural Scene node '${node.role}' cannot carry text.` });
  if (!isText && node.styleRole) context.addIssue({ code: z.ZodIssueCode.custom, path: ["styleRole"], message: `Structural Scene node '${node.role}' cannot request a text style role.` });
  if (node.role === "surface" && node.componentPreference && !new Set<ComponentKind>(["surface", "card"]).has(node.componentPreference)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["componentPreference"], message: "Surface nodes may prefer only template surface/card components." });
  }
  if (node.role === "divider" && node.componentPreference && node.componentPreference !== "divider") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["componentPreference"], message: "Divider nodes may prefer only template divider components." });
  }
  if (isText && node.componentPreference && STRUCTURAL_COMPONENTS.has(node.componentPreference)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["componentPreference"], message: "Text Scene nodes cannot request structural template components." });
  }
});

export const generativeSceneIntentSchema = z.object({
  version: z.literal(GENERATIVE_SCENE_VERSION),
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
});

export type GenerativeSceneIntent = z.infer<typeof generativeSceneIntentSchema>;
export type GenerativeSceneNode = GenerativeSceneIntent["layout"]["nodes"][number];
export type ResolvedGenerativeNode = GenerativeSceneNode & { bounds: Rect };
export type ResolvedGenerativeScene = {
  version: 2;
  slideId: string;
  semanticIntent: GenerativeSceneIntent["semanticIntent"];
  headline: string;
  contentRegionId: string;
  contentRegion: Rect;
  nodes: ResolvedGenerativeNode[];
  brandConstraintDigestInput: { sourceDigest: string; elementsDigest: string; compilerVersion: string };
};

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
    if (node.styleRole && !profile.styleVocabulary.textRoles.includes(node.styleRole)) {
      throw new Error(`GENERATIVE_SCENE_STYLE_ROLE_UNSUPPORTED: '${node.styleRole}' is not present in the template style vocabulary.`);
    }
    return { ...node, bounds };
  });

  return {
    version: GENERATIVE_SCENE_VERSION,
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
