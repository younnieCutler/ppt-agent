import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadBrandFile } from "./brand";
import type { BrandFile } from "./schema";

const rectSchema = z.object({ x: z.number().nonnegative(), y: z.number().nonnegative(), w: z.number().positive(), h: z.number().positive() });
export const semanticLayouts = ["title", "statement", "comparison", "process", "pipeline", "architecture", "quantitative", "timeline", "evidence", "chart"] as const;

export const layoutBindingSchema = z.object({
  nativeLayout: z.string().min(1),
  canvasColor: z.string().regex(/^[0-9A-Fa-f]{6}$/),
  contentRegion: rectSchema,
  reservedRegions: z.array(rectSchema).default([]),
});

export const templateMapSchema = z.object({
  version: z.literal(1),
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

export type TemplateMap = z.infer<typeof templateMapSchema>;
export type LayoutBinding = z.infer<typeof layoutBindingSchema>;
export type OrganizationPack = { id: string; root: string; templatePath: string; map: TemplateMap; brand: BrandFile };

export function loadOrganizationPack(directory: string): OrganizationPack {
  const root = path.resolve(directory);
  const templatePath = path.join(root, "template.pptx");
  const brandPath = path.join(root, "brand.yaml");
  const mapPath = path.join(root, "template-map.json");
  for (const required of [templatePath, brandPath, mapPath]) {
    if (!fs.existsSync(required)) throw new Error(`Organization pack is incomplete; required file is missing: ${required}`);
  }
  const map = templateMapSchema.parse(JSON.parse(fs.readFileSync(mapPath, "utf8")));
  const brand = loadBrandFile(brandPath);
  validateMapGeometry(map);
  return { id: path.basename(root), root, templatePath, map, brand };
}

function validateMapGeometry(map: TemplateMap): void {
  const bindings = [map.defaultLayout, ...Object.values(map.layouts)];
  bindings.forEach((binding) => {
    const region = binding.contentRegion;
    if (region.x + region.w > 13.333 || region.y + region.h > 7.5) throw new Error(`Template contentRegion for '${binding.nativeLayout}' exceeds the supported 16:9 canvas.`);
    binding.reservedRegions.forEach((reserved) => {
      if (reserved.x + reserved.w > 13.333 || reserved.y + reserved.h > 7.5) throw new Error(`Template reserved region for '${binding.nativeLayout}' exceeds the supported 16:9 canvas.`);
      const overlaps = region.x < reserved.x + reserved.w && region.x + region.w > reserved.x && region.y < reserved.y + reserved.h && region.y + region.h > reserved.y;
      if (overlaps) throw new Error(`Template contentRegion for '${binding.nativeLayout}' overlaps a reserved region.`);
    });
  });
}

export function bindingForLayout(map: TemplateMap, layout: (typeof semanticLayouts)[number]): LayoutBinding {
  return map.layouts[layout] ?? map.defaultLayout;
}
