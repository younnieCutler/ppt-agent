import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadBrandFile } from "./brand";
import type { BrandFile } from "./schema";
import { elementsDigest, roleOverridesDigest, TEMPLATE_ANALYZER_VERSION, TEMPLATE_GRAMMAR_COMPILER_VERSION, type TemplateElementsArtifact, type TemplateGrammar } from "./template-analysis";

const rectSchema = z.object({ x: z.number().nonnegative(), y: z.number().nonnegative(), w: z.number().positive(), h: z.number().positive() });
export const semanticLayouts = ["title", "statement", "comparison", "process", "pipeline", "architecture", "quantitative", "timeline", "evidence", "chart"] as const;

// Single source of truth for physical canvas size per aspect ratio, shared by organization pack
// geometry validation (here) and the renderer's own pptxgenjs page setup / chrome placement.
// Height is 7.5in for both — pptxgenjs's LAYOUT_WIDE and LAYOUT_4x3 only differ in width.
export const CANVAS_DIMENSIONS = {
  "16:9": { w: 13.333, h: 7.5, pptxLayout: "LAYOUT_WIDE" },
  "4:3": { w: 10, h: 7.5, pptxLayout: "LAYOUT_4x3" },
} as const;

export const layoutBindingSchema = z.object({
  nativeLayout: z.string().min(1),
  canvasColor: z.string().regex(/^[0-9A-Fa-f]{6}$/),
  contentRegion: rectSchema,
  reservedRegions: z.array(rectSchema).default([]),
});

export const templateMapV1Schema = z.object({
  version: z.literal(1),
  aspectRatio: z.enum(["16:9", "4:3"]).default("16:9"),
  chromeOwnership: z.object({
    background: z.enum(["template", "renderer"]),
    logo: z.enum(["template", "renderer"]),
    footer: z.enum(["template", "renderer"]),
    pageNumber: z.enum(["template", "renderer"]),
  }),
  defaultLayout: layoutBindingSchema,
  layouts: z.record(z.enum(semanticLayouts), layoutBindingSchema).default({}),
  requiredElements: z.array(z.object({ name: z.string().min(1), layouts: z.array(z.union([z.literal("*"), z.enum(semanticLayouts)])).min(1) })).default([]),
});

export const templateMapV2Schema = templateMapV1Schema.extend({
  version: z.literal(2),
  elementRoleOverrides: z.record(z.enum(["title", "subtitle", "heading", "body", "caption", "eyebrow", "label", "key_message", "metric", "metric_label", "annotation", "step", "route", "source", "logo", "footer", "surface", "divider"])).default({}),
  elementsFile: z.literal("template-elements.json").default("template-elements.json"),
  grammarFile: z.literal("template-grammar.json").default("template-grammar.json"),
});

export const templateMapSchema = z.union([templateMapV1Schema, templateMapV2Schema]);

export type TemplateMap = z.infer<typeof templateMapSchema>;
export type LayoutBinding = z.infer<typeof layoutBindingSchema>;
export type OrganizationPack = { id: string; root: string; templatePath: string; map: TemplateMap; brand: BrandFile; templateGrammar?: TemplateGrammar; templateGrammarDigest?: string };

export function loadOrganizationPack(directory: string): OrganizationPack {
  const root = path.resolve(directory);
  const templatePath = path.join(root, "template.pptx");
  const brandPath = path.join(root, "brand.yaml");
  const mapPath = path.join(root, "template-map.json");
  for (const required of [templatePath, brandPath, mapPath]) {
    if (!fs.existsSync(required)) throw new Error(`Organization pack is incomplete; required file is missing: ${required}`);
  }
  const map = templateMapSchema.parse(JSON.parse(fs.readFileSync(mapPath, "utf8")));
  let templateGrammar: TemplateGrammar | undefined;
  let templateGrammarDigest: string | undefined;
  if (map.version === 2) {
    const elementsPath = path.join(root, map.elementsFile);
    const grammarPath = path.join(root, map.grammarFile);
    if (!fs.existsSync(elementsPath) || !fs.existsSync(grammarPath)) throw new Error("Organization Pack v2 requires template-elements.json and template-grammar.json.");
    const templateDigest = crypto.createHash("sha256").update(fs.readFileSync(templatePath)).digest("hex");
    const elements = JSON.parse(fs.readFileSync(elementsPath, "utf8")) as TemplateElementsArtifact;
    const grammar = JSON.parse(fs.readFileSync(grammarPath, "utf8")) as TemplateGrammar;
    if (elements.source?.sha256 !== templateDigest || grammar.sourceDigest !== templateDigest) throw new Error("Organization Pack v2 generated artifacts are stale for template.pptx.");
    // template.pptx is not the only analysis input: elementRoleOverrides change semantic roles and
    // therefore the compiled grammar while the PPTX stays byte-identical.
    const inputs = elements.analysisInputs;
    if (!inputs) throw new Error("Organization Pack v2 generated artifacts predate analysis provenance. Re-run `template-analyze`.");
    if (inputs.roleOverridesDigest !== roleOverridesDigest(map.elementRoleOverrides)) throw new Error("Organization Pack v2 generated artifacts are stale for template-map.json elementRoleOverrides. Re-run `template-analyze`.");
    // Recorded and checked, not decorative: this catches an elements artifact whose own two records
    // of its input disagree, which is what a hand-edited artifact looks like.
    if (inputs.templateDigest !== templateDigest) throw new Error("Organization Pack v2 template-elements.json records a different template digest than template.pptx. Re-run `template-analyze`.");
    if (inputs.analyzerVersion !== TEMPLATE_ANALYZER_VERSION) throw new Error(`Organization Pack v2 template-elements.json was produced by analyzer version ${inputs.analyzerVersion}; this build is ${TEMPLATE_ANALYZER_VERSION}. Re-run \`template-analyze\`.`);
    if (!elements.coordinateSpace || Math.abs(elements.coordinateSpace.canvas.w - elements.source.slideSize.w) > 0.001 || Math.abs(elements.coordinateSpace.canvas.h - elements.source.slideSize.h) > 0.001) throw new Error("Organization Pack v2 template-elements.json is missing canonical coordinate-space metadata. Re-run `template-analyze`.");
    if (grammar.compilerVersion !== TEMPLATE_GRAMMAR_COMPILER_VERSION) throw new Error(`Organization Pack v2 template-grammar.json was compiled by grammar compiler version ${grammar.compilerVersion}; this build is ${TEMPLATE_GRAMMAR_COMPILER_VERSION}. Re-run \`template-analyze\`.`);
    if (grammar.elementsDigest !== elementsDigest(elements)) throw new Error("Organization Pack v2 template-grammar.json was not compiled from this template-elements.json. Re-run `template-analyze`.");
    templateGrammar = grammar;
    templateGrammarDigest = crypto.createHash("sha256").update(fs.readFileSync(grammarPath)).digest("hex");
  }
  const brand = loadBrandFile(brandPath);
  validateMapGeometry(map);
  return { id: path.basename(root), root, templatePath, map, brand, templateGrammar, templateGrammarDigest };
}

function validateMapGeometry(map: TemplateMap): void {
  const { w: canvasW, h: canvasH } = CANVAS_DIMENSIONS[map.aspectRatio];
  const bindings = [map.defaultLayout, ...Object.values(map.layouts)];
  bindings.forEach((binding) => {
    const region = binding.contentRegion;
    if (region.x + region.w > canvasW || region.y + region.h > canvasH) throw new Error(`Template contentRegion for '${binding.nativeLayout}' exceeds the supported ${map.aspectRatio} canvas.`);
    binding.reservedRegions.forEach((reserved) => {
      if (reserved.x + reserved.w > canvasW || reserved.y + reserved.h > canvasH) throw new Error(`Template reserved region for '${binding.nativeLayout}' exceeds the supported ${map.aspectRatio} canvas.`);
      const overlaps = region.x < reserved.x + reserved.w && region.x + region.w > reserved.x && region.y < reserved.y + reserved.h && region.y + region.h > reserved.y;
      if (overlaps) throw new Error(`Template contentRegion for '${binding.nativeLayout}' overlaps a reserved region.`);
    });
  });
}

export function bindingForLayout(map: TemplateMap, layout: (typeof semanticLayouts)[number]): LayoutBinding {
  return map.layouts[layout] ?? map.defaultLayout;
}
