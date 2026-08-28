import { z } from "zod";
import { rollUp, type QaFinding, type QaReport } from "./qa";
import type { DeckSpec } from "./schema";

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
  // judgment layer — risk
  "WEAK_VISUAL_HIERARCHY",
  "EXCESSIVE_INFORMATION_DENSITY",
  "LOW_INFORMATION_DENSITY",
  "UNBALANCED_COMPOSITION",
  "EXCESSIVE_CARDIFICATION",
  "MEANINGLESS_DECORATION",
  "LOW_VISUAL_CONTRAST",
  // deck-level — risk
  "LAYOUT_REPETITION",
  "INCONSISTENT_SECTION_RHYTHM",
  "REFERENCE_VISUAL_DRIFT",
] as const;

export const visualFindingSchema = z.object({
  slideId: z.string().optional(),
  severity: z.enum(["hard", "risk", "warning"]),
  code: z.enum(visualFindingCodes),
  message: z.string().min(1),
  repairable: z.boolean().optional(),
});

export type VisualFinding = z.infer<typeof visualFindingSchema>;

const level3CodeMap: Record<string, (typeof visualFindingCodes)[number]> = {
  TEXT_OVERFLOW: "TEXT_VISUALLY_OVERFLOWING",
  TEXT_IMAGE_COLLISION: "CRITICAL_VISUAL_COLLISION",
  OFF_CANVAS: "OFF_CANVAS",
};

function mapLevel3Findings(level3: Record<string, unknown>): QaFinding[] {
  const findings = Array.isArray(level3.findings) ? (level3.findings as QaFinding[]) : [];
  return findings
    .filter((finding) => finding.code in level3CodeMap)
    .map((finding) => ({ ...finding, code: level3CodeMap[finding.code] }));
}

export function visualQa(deck: DeckSpec, findings: unknown, level3?: Record<string, unknown>): QaReport {
  const slideIds = new Set(deck.slides.map((slide) => slide.id));
  const parsed = z.array(visualFindingSchema).safeParse(findings);
  const collected: QaFinding[] = [];
  if (!parsed.success) {
    collected.push({ severity: "hard", code: "VISUAL_FINDING_INVALID", message: `visual-findings.json failed schema validation: ${parsed.error.message}` });
  } else {
    parsed.data.forEach((finding) => {
      if (finding.slideId && !slideIds.has(finding.slideId)) {
        collected.push({ severity: "hard", code: "VISUAL_FINDING_INVALID", message: `Visual finding references unknown slideId '${finding.slideId}'.` });
        return;
      }
      collected.push({ severity: finding.severity, code: finding.code, slideId: finding.slideId, message: finding.message });
    });
  }
  if (level3) collected.push(...mapLevel3Findings(level3));
  return { ...rollUp(collected), reference: "not_applicable", attempts: 0, findings: collected };
}
