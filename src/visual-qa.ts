import { z } from "zod";
import { rollUp, type QaFinding, type QaReport } from "./qa";
import type { DeckSpec } from "./schema";
import { contrastRatio, type ResolvedPresentationStyle } from "./style";

// Closed set: only codes that produce distinct repair behavior. LLM findings that use any other
// code are rejected outright by visualFindingSchema, so the judgment layer can never invent one.
export const visualFindingCodes = [
  // measured layer — mapped from PowerPoint COM findings (scripts/qa.ps1), never guessed visually
  "TEXT_VISUALLY_OVERFLOWING",
  "CRITICAL_VISUAL_COLLISION",
  "OFF_CANVAS",
  "MISSING_RENDERED_OBJECT",
  // judgment layer — hard
  "SEMANTIC_VISUAL_MISMATCH",
  "CHART_UNREADABLE",
  "BRAND_COLOR_VIOLATION",
  "BRAND_FONT_VIOLATION",
  "THEME_DATA_COLOR_VIOLATION",
  // judgment layer — risk
  "WEAK_SEMANTIC_VISUALIZATION",
  "WEAK_VISUAL_HIERARCHY",
  "EXCESSIVE_INFORMATION_DENSITY",
  "LOW_INFORMATION_DENSITY",
  "UNBALANCED_COMPOSITION",
  "EXCESSIVE_CARDIFICATION",
  "MEANINGLESS_DECORATION",
  "LOW_VISUAL_CONTRAST",
  "LOW_CONTRAST_SECONDARY_TEXT",
  "ARCHETYPE_DENSITY_MISMATCH",
  "ARCHETYPE_HIERARCHY_MISMATCH",
  "ARCHETYPE_VISUAL_WEIGHT_MISMATCH",
  "UNNECESSARY_GRADIENT",
  "GENERIC_DASHBOARD_LAYOUT",
  "REPEATED_THREE_COLUMN_PATTERN",
  "ARBITRARY_ICON_USAGE",
  // deck-level — risk
  "LAYOUT_REPETITION",
  "INCONSISTENT_SECTION_RHYTHM",
  "REFERENCE_VISUAL_DRIFT",
  // template fidelity — risk. No calibrated gold set exists yet to justify a hard gate here (see
  // plan/2026-08-29-template-native-runtime.md); these are judgment calls from a template-vs-
  // generated montage comparison, distinct from the deterministic hard checks in
  // src/template-fidelity.ts (leakage, structure drift, slot overflow — those need no judgment).
  "TEMPLATE_STYLE_DRIFT",
  "TEMPLATE_HIERARCHY_DRIFT",
  "TEMPLATE_COMPOSITION_DRIFT",
  // provenance layer — computed from render-provenance.json/backend.json, never guessed visually
  "VISUAL_QA_STALE_RENDER",
  "VISUAL_RENDER_PROVENANCE_UNKNOWN",
  "RENDER_FONT_SUBSTITUTION",
  "ORGANIZATION_GRAMMAR_NOT_APPLIED",
] as const;

// Severity is derived from code, never accepted as judgment-layer input — otherwise an LLM could
// author { code: "CHART_UNREADABLE", severity: "warning" } and quietly downgrade a hard failure
// past the release gate. The code is the only thing the judgment layer gets to choose.
export const findingSeverityByCode: Record<(typeof visualFindingCodes)[number], "hard" | "risk" | "warning"> = {
  TEXT_VISUALLY_OVERFLOWING: "hard",
  CRITICAL_VISUAL_COLLISION: "hard",
  OFF_CANVAS: "hard",
  MISSING_RENDERED_OBJECT: "hard",
  SEMANTIC_VISUAL_MISMATCH: "hard",
  CHART_UNREADABLE: "hard",
  BRAND_COLOR_VIOLATION: "hard",
  BRAND_FONT_VIOLATION: "hard",
  THEME_DATA_COLOR_VIOLATION: "hard",
  // Distinct from SEMANTIC_VISUAL_MISMATCH (hard): the representation is not *wrong* for the
  // message, it just contains the information instead of explaining it.
  WEAK_SEMANTIC_VISUALIZATION: "risk",
  WEAK_VISUAL_HIERARCHY: "risk",
  EXCESSIVE_INFORMATION_DENSITY: "risk",
  LOW_INFORMATION_DENSITY: "risk",
  UNBALANCED_COMPOSITION: "risk",
  EXCESSIVE_CARDIFICATION: "risk",
  MEANINGLESS_DECORATION: "risk",
  LOW_VISUAL_CONTRAST: "risk",
  LOW_CONTRAST_SECONDARY_TEXT: "risk",
  ARCHETYPE_DENSITY_MISMATCH: "risk",
  ARCHETYPE_HIERARCHY_MISMATCH: "risk",
  ARCHETYPE_VISUAL_WEIGHT_MISMATCH: "risk",
  UNNECESSARY_GRADIENT: "risk",
  GENERIC_DASHBOARD_LAYOUT: "risk",
  REPEATED_THREE_COLUMN_PATTERN: "risk",
  ARBITRARY_ICON_USAGE: "risk",
  LAYOUT_REPETITION: "risk",
  INCONSISTENT_SECTION_RHYTHM: "risk",
  REFERENCE_VISUAL_DRIFT: "risk",
  TEMPLATE_STYLE_DRIFT: "risk",
  TEMPLATE_HIERARCHY_DRIFT: "risk",
  TEMPLATE_COMPOSITION_DRIFT: "risk",
  VISUAL_QA_STALE_RENDER: "hard",
  VISUAL_RENDER_PROVENANCE_UNKNOWN: "risk",
  RENDER_FONT_SUBSTITUTION: "risk",
  ORGANIZATION_GRAMMAR_NOT_APPLIED: "hard",
};

export const visualFindingInputSchema = z
  .object({
    slideId: z.string().optional(),
    code: z.enum(visualFindingCodes),
    message: z.string().min(1),
    repairable: z.boolean().optional(),
  })
  .strict();

export type VisualFindingInput = z.infer<typeof visualFindingInputSchema>;

const level3CodeMap: Record<string, (typeof visualFindingCodes)[number]> = {
  TEXT_OVERFLOW: "TEXT_VISUALLY_OVERFLOWING",
  TEXT_IMAGE_COLLISION: "CRITICAL_VISUAL_COLLISION",
  OFF_CANVAS: "OFF_CANVAS",
};

function mapLevel3Findings(level3: Record<string, unknown>): QaFinding[] {
  const findings = Array.isArray(level3.findings) ? (level3.findings as QaFinding[]) : [];
  return findings
    .filter((finding) => finding.code in level3CodeMap)
    .map((finding) => {
      const code = level3CodeMap[finding.code];
      return { ...finding, code, severity: findingSeverityByCode[code] };
    });
}

const visualCompositions = new Set(["sequence", "stage_gate", "pipeline_lanes", "architecture_zones", "native_chart", "gauge_row", "sparkline_row", "central_hub", "layered_stack", "verdict_contrast"]);

function addArchetypeFitFindings(deck: DeckSpec, style: ResolvedPresentationStyle | undefined, collected: QaFinding[]): void {
  if (!style) return;
  const bodyContrast = contrastRatio(style.palette.text, style.palette.background);
  const secondaryContrast = contrastRatio(style.palette.textSecondary, style.palette.background);
  if (bodyContrast < 4.5) {
    collected.push({ severity: "risk", code: "LOW_VISUAL_CONTRAST", message: `Resolved ${style.themeId} body text contrast is ${bodyContrast.toFixed(2)}:1, below the 4.5:1 practical floor.` });
  }
  if (secondaryContrast < 4.5) {
    collected.push({ severity: "risk", code: "LOW_CONTRAST_SECONDARY_TEXT", message: `Resolved ${style.themeId} secondary text contrast is ${secondaryContrast.toFixed(2)}:1, below the 4.5:1 practical floor.` });
  }
  const bodySlides = deck.slides.filter((slide) => slide.layout !== "title");
  if (bodySlides.length < 3) return;
  const preferred = new Set(style.grammar.compositionPreferences);
  const preferredShare = bodySlides.filter((slide) => preferred.has(slide.layout) || preferred.has(slide.composition)).length / bodySlides.length;
  if (preferredShare < 0.25) {
    collected.push({ severity: "risk", code: "ARCHETYPE_HIERARCHY_MISMATCH", message: `${style.themeId} archetype preferences appear on only ${Math.round(preferredShare * 100)}% of body slides.` });
  }
  if (style.themeId === "analytical" && bodySlides.filter((slide) => slide.layout === "chart" || slide.layout === "quantitative" || slide.layout === "evidence").length / bodySlides.length < 0.34) {
    collected.push({ severity: "risk", code: "ARCHETYPE_DENSITY_MISMATCH", message: "Analytical archetype expects chart/evidence-led hierarchy on at least one third of body slides." });
  }
  if (style.themeId === "stage" && bodySlides.filter((slide) => visualCompositions.has(slide.composition)).length / bodySlides.length < 0.5) {
    collected.push({ severity: "risk", code: "ARCHETYPE_VISUAL_WEIGHT_MISMATCH", message: "Stage archetype expects large visual or diagram-led compositions on at least half of body slides." });
  }
}

export type ProvenanceFinding = { slideId?: string; code: (typeof visualFindingCodes)[number]; message: string };

export function visualQa(deck: DeckSpec, findings: unknown, level3?: Record<string, unknown>, style?: ResolvedPresentationStyle, provenance?: ProvenanceFinding[]): QaReport {
  const slideIds = new Set(deck.slides.map((slide) => slide.id));
  const parsed = z.array(visualFindingInputSchema).safeParse(findings);
  const collected: QaFinding[] = [];
  if (!parsed.success) {
    collected.push({ severity: "hard", code: "VISUAL_FINDING_INVALID", message: `visual-findings.json failed schema validation: ${parsed.error.message}` });
  } else {
    parsed.data.forEach((finding) => {
      if (finding.slideId && !slideIds.has(finding.slideId)) {
        collected.push({ severity: "hard", code: "VISUAL_FINDING_INVALID", message: `Visual finding references unknown slideId '${finding.slideId}'.` });
        return;
      }
      collected.push({ severity: findingSeverityByCode[finding.code], code: finding.code, slideId: finding.slideId, message: finding.message });
    });
  }
  if (level3) collected.push(...mapLevel3Findings(level3));
  // Render-provenance and font-substitution findings are computed deterministically from
  // render-provenance.json/backend.json, not authored by the judgment layer, but severity still
  // routes through the same closed-code lookup so it cannot silently diverge from the codes above.
  (provenance ?? []).forEach((finding) => collected.push({ severity: findingSeverityByCode[finding.code], code: finding.code, slideId: finding.slideId, message: finding.message }));
  addArchetypeFitFindings(deck, style, collected);
  return { ...rollUp(collected), reference: "not_applicable", attempts: 0, findings: collected, ...(style ? { presentationStyle: style.themeId } : {}) };
}
