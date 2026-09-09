import { z } from "zod";
import { sha256 } from "./provenance";
import type { TemplateDesignSystemArtifact } from "./template-design-system";

export const DESIGN_RULE_COMPILER_VERSION = "1";

const rectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).strict();
const numericVocabularySchema = z.object({
  values: z.array(z.number()),
  min: z.number().optional(),
  max: z.number().optional(),
}).strict();

const typographyRoleRuleSchema = z.object({
  families: z.array(z.string()).optional(),
  sizesPt: numericVocabularySchema.optional(),
  weights: z.array(z.number()).optional(),
  lineHeightRatios: numericVocabularySchema.optional(),
  alignments: z.array(z.enum(["left", "center", "right"])).optional(),
}).strict();

export const designRulesSchema = z.object({
  version: z.literal(1),
  compilerVersion: z.string().min(1),
  sourceDigest: z.string().min(1),
  designSystemDigest: z.string().min(1),
  canvas: z.object({ w: z.number().positive(), h: z.number().positive() }).strict(),
  tolerances: z.object({
    geometryInches: z.number().nonnegative(),
    typographyPt: z.number().nonnegative(),
    ratio: z.number().nonnegative(),
  }).strict(),
  typography: z.object({
    roles: z.record(typographyRoleRuleSchema),
    typeScale: numericVocabularySchema,
  }).strict(),
  colors: z.object({ allowed: z.array(z.string()).min(1) }).strict(),
  geometry: z.object({
    contentFrame: rectSchema.optional(),
    outerMargins: rectSchema.optional(),
    gutters: z.array(z.number()),
  }).strict(),
  spacing: z.object({ rhythm: z.array(z.number()) }).strict(),
  dividers: z.object({
    orientations: z.array(z.enum(["horizontal", "vertical", "unknown"])),
    thicknesses: z.array(z.number()),
    lengths: z.array(z.number()),
    strokeWidthsPt: z.array(z.number()),
    colors: z.array(z.string()),
  }).strict(),
  surfaces: z.object({
    fills: z.array(z.string()),
    borders: z.array(z.string()),
    borderWidthsPt: z.array(z.number()),
  }).strict(),
  alignmentAnchors: z.object({ x: z.array(z.number()), y: z.array(z.number()) }).strict(),
}).strict();

export type DesignRulesArtifact = z.infer<typeof designRulesSchema>;
export type DesignRuleCompilerOptions = {
  geometryToleranceInches?: number;
  typographyTolerancePt?: number;
  ratioTolerance?: number;
};

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.toUpperCase()))].sort();
}

/**
 * Compiles observed template measurements into a versioned, reusable rule artifact. The compiler
 * does not invent aesthetic policy: every vocabulary comes from template-design-system.json, while
 * tolerances are explicit runtime policy and default to the 0.02in geometry tolerance used by the
 * reference workflow.
 */
export function compileDesignRules(
  designSystem: TemplateDesignSystemArtifact,
  options: DesignRuleCompilerOptions = {},
): DesignRulesArtifact {
  const allowedColors = uniqueStrings([
    ...designSystem.colors.text,
    ...designSystem.colors.fill,
    ...designSystem.colors.stroke,
    ...designSystem.colors.background,
  ]);
  const artifact: DesignRulesArtifact = {
    version: 1,
    compilerVersion: DESIGN_RULE_COMPILER_VERSION,
    sourceDigest: designSystem.sourceDigest,
    designSystemDigest: sha256(JSON.stringify(designSystem)),
    canvas: designSystem.canvas,
    tolerances: {
      geometryInches: options.geometryToleranceInches ?? 0.02,
      typographyPt: options.typographyTolerancePt ?? 0.5,
      ratio: options.ratioTolerance ?? 0.02,
    },
    typography: {
      roles: designSystem.typography.roles,
      typeScale: designSystem.typography.typeScale,
    },
    colors: { allowed: allowedColors.length > 0 ? allowedColors : ["000000"] },
    geometry: {
      contentFrame: designSystem.geometry.contentFrame,
      outerMargins: designSystem.geometry.outerMargins,
      gutters: designSystem.geometry.gutters,
    },
    spacing: { rhythm: designSystem.spacing.rhythm },
    dividers: designSystem.dividers,
    surfaces: designSystem.surfaces,
    alignmentAnchors: designSystem.alignmentAnchors,
  };
  return designRulesSchema.parse(artifact);
}
