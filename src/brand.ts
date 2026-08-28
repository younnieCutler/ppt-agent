import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { brandFileSchema, type BrandFile, type GenerationContract, type LegacyThemeTokens } from "./schema";

export function defaultBrandPath(): string {
  return path.resolve(__dirname, "..", "themes", "default", "brand.yaml");
}

export function loadBrandFile(filePath: string): BrandFile {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw new Error(`Brand file not found: ${absolute}`);
  const parsed = parse(fs.readFileSync(absolute, "utf8"));
  return brandFileSchema.parse(parsed);
}

export function resolveTheme(contract: GenerationContract, projectDir: string): LegacyThemeTokens {
  const brandPath = contract.brand.kind === "file" ? path.resolve(projectDir, contract.brand.path) : defaultBrandPath();
  const brand = loadBrandFile(brandPath);
  const brandDir = path.dirname(brandPath);
  const logoPath = brand.logo ? path.resolve(brandDir, brand.logo.path) : undefined;

  if (logoPath && !fs.existsSync(logoPath)) throw new Error(`Brand logo not found: ${logoPath}`);
  const fontsLocked = Boolean(brand.fonts?.locked || brand.locks?.fonts);
  if (brand.locks?.fonts && !brand.fonts) throw new Error("Locked brand fonts require explicit heading and body font names in brand.yaml.");
  if (fontsLocked && (contract.fonts.heading !== brand.fonts?.heading || contract.fonts.body !== brand.fonts?.body)) {
    throw new Error("Locked brand fonts must be confirmed exactly in the GenerationContract.");
  }

  return {
    name: brand.name,
    palette: brand.palette,
    fonts: {
      heading: contract.fonts.heading,
      body: contract.fonts.body,
      locked: fontsLocked,
    },
    logoPath,
    footer: brand.footer,
  };
}
