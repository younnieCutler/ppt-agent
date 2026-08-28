import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { loadBrandFile } from "./brand";
import { loadOrganizationPack, type OrganizationPack, type TemplateMap } from "./organization";
import {
  themeV2Schema,
  type GenerationContract,
  type PresentationArchetype,
  type ThemePalette,
  type ThemeTokens,
  type ThemeTokensV2,
} from "./schema";

export type SurfaceUsage = "none" | "sparse" | "bands" | "semantic";
export type ChartTreatment = "restrained" | "decision" | "data-first" | "editorial" | "product" | "stage";

export type ResolvedGrammar = {
  spacingScale: number;
  headlineScale: number;
  bodyScale: number;
  kpiScale: number;
  focalVisualScale: number;
  copyBudget: number;
  surfaceUsage: SurfaceUsage;
  decorationBudget: 0 | 1;
  chartTreatment: ChartTreatment;
  compositionPreferences: string[];
};

export type ReferenceGrammar = {
  id: string;
  density?: "sparse" | "balanced" | "dense";
  visualWeight?: "light" | "balanced" | "heavy";
  whitespace?: "compact" | "balanced" | "generous";
  headline?: "assertion" | "descriptive" | "minimal";
  traits: string[];
};

export type ResolvedPresentationStyle = {
  schemaVersion: 2;
  themeId: PresentationArchetype;
  designDirection: GenerationContract["designDirection"];
  palette: ThemePalette;
  data: ThemeTokensV2["data"];
  fonts: { heading: string; body: string; locked: boolean };
  logoPath?: string;
  footer: { showPageNumber: boolean; text: string };
  organization?: {
    id: string;
    root: string;
    templatePath: string;
    map: TemplateMap;
  };
  grammar: ResolvedGrammar;
  reference?: ReferenceGrammar;
  locks: { palette: string[]; fonts: boolean };
  provenance: { requestedStyle: GenerationContract["presentationStyle"]; resolvedBy: "explicit" | "auto" | "reference-first" };
};

export type ReferenceSelectionEntry = {
  id: string;
  style?: { density?: string; visualWeight?: string };
  layout?: { whitespace?: string; headline?: string };
  traits?: string[];
};

const archetypeGrammar: Record<PresentationArchetype, ResolvedGrammar> = {
  corporate: { spacingScale: 1, headlineScale: 1, bodyScale: 1, kpiScale: 1, focalVisualScale: 1, copyBudget: 1, surfaceUsage: "bands", decorationBudget: 1, chartTreatment: "restrained", compositionPreferences: ["comparison", "process", "architecture"] },
  executive: { spacingScale: 1.08, headlineScale: 1.08, bodyScale: 0.98, kpiScale: 1.25, focalVisualScale: 1.08, copyBudget: 0.85, surfaceUsage: "sparse", decorationBudget: 1, chartTreatment: "decision", compositionPreferences: ["quantitative", "comparison", "evidence"] },
  analytical: { spacingScale: 0.86, headlineScale: 0.96, bodyScale: 0.92, kpiScale: 1.05, focalVisualScale: 1.05, copyBudget: 1.2, surfaceUsage: "bands", decorationBudget: 0, chartTreatment: "data-first", compositionPreferences: ["chart", "evidence", "comparison"] },
  editorial: { spacingScale: 1.35, headlineScale: 1.28, bodyScale: 1.02, kpiScale: 1.15, focalVisualScale: 1.3, copyBudget: 0.6, surfaceUsage: "none", decorationBudget: 0, chartTreatment: "editorial", compositionPreferences: ["statement", "title", "evidence"] },
  product: { spacingScale: 1.05, headlineScale: 1.1, bodyScale: 1, kpiScale: 1.2, focalVisualScale: 1.15, copyBudget: 0.85, surfaceUsage: "semantic", decorationBudget: 1, chartTreatment: "product", compositionPreferences: ["quantitative", "process", "comparison"] },
  stage: { spacingScale: 1.3, headlineScale: 1.45, bodyScale: 1.12, kpiScale: 1.35, focalVisualScale: 1.4, copyBudget: 0.45, surfaceUsage: "sparse", decorationBudget: 1, chartTreatment: "stage", compositionPreferences: ["title", "statement", "architecture"] },
};

const directionMultipliers: Record<Exclude<GenerationContract["designDirection"], "reference">, Pick<ResolvedGrammar, "spacingScale" | "headlineScale" | "bodyScale" | "kpiScale" | "focalVisualScale" | "copyBudget">> = {
  auto: { spacingScale: 1, headlineScale: 1, bodyScale: 1, kpiScale: 1, focalVisualScale: 1, copyBudget: 1 },
  balanced: { spacingScale: 1, headlineScale: 1, bodyScale: 1, kpiScale: 1, focalVisualScale: 1, copyBudget: 1 },
  dense: { spacingScale: 0.85, headlineScale: 0.95, bodyScale: 0.92, kpiScale: 0.95, focalVisualScale: 0.88, copyBudget: 1.25 },
  visual: { spacingScale: 1.08, headlineScale: 1.08, bodyScale: 1, kpiScale: 1.1, focalVisualScale: 1.2, copyBudget: 0.72 },
  minimal: { spacingScale: 1.25, headlineScale: 1.12, bodyScale: 1.02, kpiScale: 1.1, focalVisualScale: 1.1, copyBudget: 0.55 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function channelLuminance(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

/** WCAG-style contrast ratio used by Visual QA; presentation tokens are RGB hex. */
export function contrastRatio(foreground: string, background: string): number {
  const luminance = (value: string): number => {
    const clean = hexColor(value);
    const rgb = [0, 2, 4].map((offset) => channelLuminance(parseInt(clean.slice(offset, offset + 2), 16)));
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  };
  const first = luminance(foreground);
  const second = luminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

function hexColor(value: string): string {
  return value.replace(/^#/, "").toUpperCase();
}

function loadTheme(archetype: PresentationArchetype): ThemeTokensV2 {
  const themePath = path.resolve(__dirname, "..", "themes", archetype, "theme.yaml");
  if (!fs.existsSync(themePath)) throw new Error(`Theme file not found: ${themePath}`);
  return themeV2Schema.parse(parse(fs.readFileSync(themePath, "utf8")));
}

function autoArchetype(contract: GenerationContract): PresentationArchetype {
  if (contract.purpose === "executive") return "executive";
  if (["research", "strategy", "evidence"].includes(contract.purpose)) return "analytical";
  if (["vision", "narrative"].includes(contract.purpose)) return "editorial";
  if (["product", "startup", "saas"].includes(contract.purpose)) return "product";
  if (["keynote", "conference"].includes(contract.purpose)) return "stage";
  return "corporate";
}

function normalizeReference(entry: ReferenceSelectionEntry | undefined): ReferenceGrammar | undefined {
  if (!entry) return undefined;
  const density = entry.style?.density;
  const visualWeight = entry.style?.visualWeight;
  const whitespace = entry.layout?.whitespace;
  const headline = entry.layout?.headline;
  if (![density, visualWeight, whitespace, headline, ...(entry.traits ?? [])].some(Boolean)) return undefined;
  return {
    id: entry.id,
    density: density === "sparse" || density === "balanced" || density === "dense" ? density : undefined,
    visualWeight: visualWeight === "light" || visualWeight === "balanced" || visualWeight === "heavy" ? visualWeight : undefined,
    whitespace: whitespace === "compact" || whitespace === "balanced" || whitespace === "generous" ? whitespace : undefined,
    headline: headline === "assertion" || headline === "descriptive" || headline === "minimal" ? headline : undefined,
    traits: entry.traits ?? [],
  };
}

function referencePatch(grammar: ResolvedGrammar, reference: ReferenceGrammar): ResolvedGrammar {
  const patched = { ...grammar, compositionPreferences: [...grammar.compositionPreferences] };
  if (reference.density === "dense") {
    patched.spacingScale *= 0.9;
    patched.copyBudget *= 1.12;
  }
  if (reference.density === "sparse") {
    patched.spacingScale *= 1.12;
    patched.copyBudget *= 0.78;
  }
  if (reference.visualWeight === "heavy") patched.focalVisualScale *= 1.12;
  if (reference.visualWeight === "light") patched.focalVisualScale *= 0.9;
  if (reference.whitespace === "compact") patched.spacingScale *= 0.9;
  if (reference.whitespace === "generous") patched.spacingScale *= 1.12;
  if (reference.headline === "assertion") patched.compositionPreferences.unshift("chart", "evidence");
  if (reference.traits.includes("direct-labels")) patched.chartTreatment = "data-first";
  return patched;
}

function resolveGrammar(contract: GenerationContract, archetype: PresentationArchetype, reference: ReferenceGrammar | undefined): ResolvedGrammar {
  const base = archetypeGrammar[archetype];
  const directionName = contract.designDirection ?? "auto";
  const direction = directionName === "reference" ? directionMultipliers.balanced : directionMultipliers[directionName];
  let resolved: ResolvedGrammar = {
    ...base,
    spacingScale: base.spacingScale * direction.spacingScale,
    headlineScale: base.headlineScale * direction.headlineScale,
    bodyScale: base.bodyScale * direction.bodyScale,
    kpiScale: base.kpiScale * direction.kpiScale,
    focalVisualScale: base.focalVisualScale * direction.focalVisualScale,
    copyBudget: base.copyBudget * direction.copyBudget,
    compositionPreferences: [...base.compositionPreferences],
  };
  if (reference) {
    resolved = referencePatch(resolved, reference);
  }
  if (directionName === "minimal") resolved = { ...resolved, surfaceUsage: "none", decorationBudget: 0 };
  return {
    ...resolved,
    spacingScale: clamp(resolved.spacingScale, 0.72, 1.55),
    headlineScale: clamp(resolved.headlineScale, 0.85, 1.6),
    bodyScale: clamp(resolved.bodyScale, 0.82, 1.18),
    kpiScale: clamp(resolved.kpiScale, 0.9, 1.6),
    focalVisualScale: clamp(resolved.focalVisualScale, 0.75, 1.6),
    copyBudget: clamp(resolved.copyBudget, 0.4, 1.4),
  };
}

function blend(from: string, to: string, amount: number): string {
  const channels = [0, 2, 4].map((offset) => Math.round(parseInt(from.slice(offset, offset + 2), 16) * (1 - amount) + parseInt(to.slice(offset, offset + 2), 16) * amount));
  return channels.map((channel) => channel.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function migrateEmbeddedTheme(base: ThemeTokensV2, legacy: ThemeTokens): Pick<ResolvedPresentationStyle, "palette" | "data" | "fonts" | "logoPath" | "footer" | "locks"> {
  if ("schemaVersion" in legacy) {
    return {
      palette: { ...base.palette, ...legacy.palette },
      data: legacy.data,
      fonts: { heading: "", body: "", locked: false },
      logoPath: undefined,
      footer: { showPageNumber: true, text: "" },
      locks: { palette: [], fonts: false },
    };
  }
  const palette: ThemePalette = {
    ...base.palette,
    ...legacy.palette,
    surfaceAlt: blend(legacy.palette.surface, legacy.palette.background, 0.6),
    textSecondary: blend(legacy.palette.text, legacy.palette.muted, 0.45),
    divider: blend(legacy.palette.border, legacy.palette.background, 0.5),
    gridline: blend(legacy.palette.border, legacy.palette.background, 0.72),
    mutedFill: blend(legacy.palette.surface, legacy.palette.background, 0.7),
    highlightedRegion: blend(legacy.palette.accent, legacy.palette.background, 0.86),
  };
  return {
    palette,
    data: [legacy.palette.primary, legacy.palette.accent, base.data[2], base.data[3], base.data[4], base.data[5]],
    fonts: { heading: legacy.fonts.heading, body: legacy.fonts.body, locked: legacy.fonts.locked },
    logoPath: legacy.logoPath,
    footer: legacy.footer,
    locks: { palette: [], fonts: legacy.fonts.locked },
  };
}

function applyLegacyBrand(
  theme: ThemeTokensV2,
  contract: GenerationContract,
  projectDir: string,
  organization?: OrganizationPack,
  embeddedTheme?: ThemeTokens,
): Pick<ResolvedPresentationStyle, "palette" | "data" | "fonts" | "logoPath" | "footer" | "locks"> {
  const brand = organization?.brand ?? (contract.brand?.kind === "file" ? loadBrandFile(path.resolve(projectDir, contract.brand.path)) : undefined);
  // A legacy embedded theme is a migration fallback only.  An explicit P3
  // archetype/reference request must win so users can restyle an old deck.
  if (!brand && embeddedTheme && (!contract.presentationStyle || contract.presentationStyle === "auto")) {
    const migrated = migrateEmbeddedTheme(theme, embeddedTheme);
    const fonts = { heading: contract.fonts.heading, body: contract.fonts.body, locked: migrated.fonts.locked };
    if (migrated.fonts.locked && (migrated.fonts.heading !== contract.fonts.heading || migrated.fonts.body !== contract.fonts.body)) {
      throw new Error("Locked embedded theme fonts must be confirmed exactly in the GenerationContract.");
    }
    const logoPath = migrated.logoPath ? path.resolve(projectDir, migrated.logoPath) : undefined;
    if (logoPath && !fs.existsSync(logoPath)) throw new Error(`Embedded theme logo not found: ${logoPath}`);
    return { ...migrated, fonts, logoPath };
  }
  if (!brand) return { palette: theme.palette, data: theme.data, fonts: { heading: contract.fonts.heading, body: contract.fonts.body, locked: false }, footer: { showPageNumber: true, text: "" }, locks: { palette: [], fonts: false } };
  const brandPath = organization?.root ? path.join(organization.root, "brand.yaml") : path.resolve(projectDir, contract.brand?.kind === "file" ? contract.brand.path : "brand.yaml");
  const logoPath = brand.logo ? path.resolve(path.dirname(brandPath), brand.logo.path) : undefined;
  if (logoPath && !fs.existsSync(logoPath)) throw new Error(`Brand logo not found: ${logoPath}`);
  const fontsLocked = Boolean(brand.fonts?.locked || brand.locks?.fonts);
  if (brand.locks?.fonts && !brand.fonts) {
    throw new Error("Locked brand fonts require explicit heading and body font names in brand.yaml.");
  }
  if (fontsLocked && (brand.fonts?.heading !== contract.fonts.heading || brand.fonts?.body !== contract.fonts.body)) {
    throw new Error("Locked brand fonts must be confirmed exactly in the GenerationContract.");
  }
  const palette: ThemePalette = {
    ...theme.palette,
    ...brand.palette,
    surfaceAlt: blend(brand.palette.surface, brand.palette.background, 0.6),
    textSecondary: blend(brand.palette.text, brand.palette.muted, 0.45),
    inverseText: theme.palette.inverseText,
    accentSecondary: theme.palette.accentSecondary,
    divider: blend(brand.palette.border, brand.palette.background, 0.5),
    gridline: blend(brand.palette.border, brand.palette.background, 0.72),
    mutedFill: blend(brand.palette.surface, brand.palette.background, 0.7),
    highlightedRegion: blend(brand.palette.accent, brand.palette.background, 0.86),
  };
  const declaredPaletteLocks = brand.locks?.palette ?? brand.lockedPalette;
  const paletteLocks = declaredPaletteLocks.length > 0
    ? declaredPaletteLocks
    : organization || brand.paletteLocked
      ? ["background", "text", "primary", "accent", "muted", "border"]
      : [];
  return {
    palette,
    data: [brand.palette.primary, brand.palette.accent, theme.data[2], theme.data[3], theme.data[4], theme.data[5]],
    fonts: { heading: contract.fonts.heading, body: contract.fonts.body, locked: fontsLocked },
    logoPath,
    footer: brand.footer,
    locks: { palette: paletteLocks, fonts: fontsLocked },
  };
}

export function resolvePresentationStyle(
  contract: GenerationContract,
  options: { projectDir?: string; referenceSelection?: ReferenceSelectionEntry[]; legacyTheme?: ThemeTokens } = {},
): ResolvedPresentationStyle {
  const projectDir = options.projectDir ?? process.cwd();
  const organizationSpec = contract.organization ?? { kind: "none" as const };
  const organization = organizationSpec.kind === "directory"
    ? loadOrganizationPack(path.resolve(projectDir, organizationSpec.path))
    : undefined;
  if (organization && contract.aspectRatio !== "16:9") {
    throw new Error("Organization template packs currently require a 16:9 GenerationContract aspectRatio.");
  }
  const explicit = contract.presentationStyle ?? "auto";
  const themeId: PresentationArchetype = explicit === "auto" || explicit === "reference-first" ? autoArchetype(contract) : explicit;
  const requestedReference = contract.referenceIds?.[0];
  const reference = normalizeReference(options.referenceSelection?.find((entry) => entry.id === requestedReference));
  if ((explicit === "reference-first" || contract.designDirection === "reference") && !reference) {
    throw new Error(`REFERENCE_GRAMMAR_NOT_FOUND: primary reference '${requestedReference ?? "(missing)"}' does not contain P3 grammar metadata.`);
  }
  const theme = loadTheme(themeId);
  const brand = applyLegacyBrand(theme, contract, projectDir, organization, options.legacyTheme);
  const resolved: ResolvedPresentationStyle = {
    schemaVersion: 2,
    themeId,
    designDirection: contract.designDirection ?? "auto",
    palette: brand.palette,
    data: brand.data,
    fonts: brand.fonts,
    logoPath: brand.logoPath,
    footer: brand.footer,
    organization: organization ? { id: organization.id, root: organization.root, templatePath: organization.templatePath, map: organization.map } : undefined,
    grammar: resolveGrammar(contract, themeId, reference),
    reference,
    locks: brand.locks,
    provenance: { requestedStyle: explicit, resolvedBy: explicit === "reference-first" ? "reference-first" : explicit === "auto" ? "auto" : "explicit" },
  };
  if (resolved.locks.palette.includes("text") && resolved.locks.palette.includes("background") && contrastRatio(resolved.palette.text, resolved.palette.background) < 4.5) {
    throw new Error("BRAND_CONTRAST_VIOLATION: locked brand text/background colors do not meet the 4.5:1 practical contrast floor.");
  }
  if (resolved.locks.palette.includes("muted") && resolved.locks.palette.includes("background") && contrastRatio(resolved.palette.textSecondary, resolved.palette.background) < 4.5) {
    throw new Error("BRAND_CONTRAST_VIOLATION: locked brand secondary text/background colors do not meet the 4.5:1 practical contrast floor.");
  }
  return resolved;
}

export function styleContext(style: ResolvedPresentationStyle): Record<string, unknown> {
  return {
    themeId: style.themeId,
    designDirection: style.designDirection,
    organization: style.organization ? { id: style.organization.id, templatePath: style.organization.templatePath } : undefined,
    provenance: style.provenance,
    grammar: {
      density: style.grammar.copyBudget > 1.05 ? "dense" : style.grammar.copyBudget < 0.75 ? "sparse" : "balanced",
      surfaceUsage: style.grammar.surfaceUsage,
      chartTreatment: style.grammar.chartTreatment,
      spacingScale: style.grammar.spacingScale,
      headlineScale: style.grammar.headlineScale,
      focalVisualScale: style.grammar.focalVisualScale,
      copyBudget: style.grammar.copyBudget,
      compositionPreferences: style.grammar.compositionPreferences.slice(0, 3),
    },
    locked: style.locks,
    reference: style.reference ? {
      id: style.reference.id,
      density: style.reference.density,
      visualWeight: style.reference.visualWeight,
      whitespace: style.reference.whitespace,
      headline: style.reference.headline,
      traits: style.reference.traits,
    } : undefined,
  };
}
