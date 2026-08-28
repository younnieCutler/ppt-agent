import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { architectureHubZone, compositionFamily, contentModelSchema, deckSchema, requiredNativeObjectsFor, type CompositionFamily, type ContentModel, type DeckSpec, type SlideSpec, type SourceRef } from "./schema";
import { readPptxOoxml, type NativeObjectCounts } from "./ooxml";
import { displayWidth, headlineWrapProblem, kinsokuProblems } from "./typography";
import type { ResolvedPresentationStyle } from "./style";

export type QaFinding = {
  severity: "hard" | "risk" | "warning";
  code: string;
  slideId?: string;
  message: string;
};

export type QaReport = {
  status: "pass" | "review" | "fail";
  integrity: "pass" | "fail";
  reference: "pass" | "warn" | "fail" | "not_applicable";
  slop: "pass" | "warn" | "fail";
  attempts: number;
  findings: QaFinding[];
  presentationStyle?: string;
  powerpoint?: Record<string, unknown>;
};

export function rollUp(findings: QaFinding[]): Pick<QaReport, "status" | "integrity" | "slop"> {
  const hard = findings.some((finding) => finding.severity === "hard");
  const risk = findings.some((finding) => finding.severity === "risk");
  return {
    status: hard ? "fail" : risk ? "review" : "pass",
    integrity: hard ? "fail" : "pass",
    slop: hard ? "fail" : risk ? "warn" : "pass",
  };
}

function flattenVisibleText(slide: SlideSpec): string {
  return `${slide.headline} ${JSON.stringify(slide.content)}`;
}

function numericTokens(text: string): string[] {
  // Keep 1-digit metrics (e.g. 7%, 3x, 4 cases) and compare complete tokens,
  // never substrings such as `12` inside `120`.
  return [...text.matchAll(/(?<![\p{N}\p{Script=Latin}])([-+]?\d+(?:[.,]\d+)?)(?:\s?(?:%|x|X|×|[가-힣]{1,4}))?(?![\p{N}\p{Script=Latin}])/gu)]
    .map((match) => match[1].trim());
}

function excerptTokenSet(excerpts: string[]): Set<string> {
  return new Set(excerpts.flatMap((excerpt) => numericTokens(excerpt)));
}

function addClaimFindings(slide: SlideSpec, excerptTokens: Set<string>, findings: QaFinding[]): Set<string> {
  const allowedCalculatedTokens = new Set<string>();
  slide.claims.forEach((claim) => {
    if (claim.status === "needs_confirmation") {
      findings.push({ severity: "risk", code: "CLAIM_NEEDS_CONFIRMATION", slideId: slide.id, message: `Claim requires confirmation before release: ${claim.text}` });
    }
    if (claim.kind !== "calculation" || !claim.formula) return;
    const inputExpression = claim.formula.split("=")[0];
    const missingInputs = numericTokens(inputExpression).filter((token) => !excerptTokens.has(token));
    if (missingInputs.length > 0) {
      findings.push({ severity: "hard", code: "CALCULATION_INPUT_GROUNDING", slideId: slide.id, message: `Calculated claim formula contains source inputs absent from cited excerpts: ${missingInputs.join(", ")}.` });
      return;
    }
    numericTokens(`${claim.text} ${claim.formula}`).forEach((token) => allowedCalculatedTokens.add(token));
  });
  return allowedCalculatedTokens;
}

function addSemanticFindings(slide: SlideSpec, findings: QaFinding[]): void {
  const content = slide.content as any;
  if (slide.layout === "comparison" && (!content.left?.items?.length || !content.right?.items?.length)) {
    findings.push({ severity: "hard", code: "SEMANTIC_LAYOUT_MISMATCH", slideId: slide.id, message: "Comparison slide must contain two non-empty sides." });
  }
  if (slide.layout === "process" && content.steps.length < 2) {
    findings.push({ severity: "hard", code: "SEMANTIC_LAYOUT_MISMATCH", slideId: slide.id, message: "Process slide must contain ordered steps." });
  }
  if (slide.layout === "pipeline" && (content.nodes.length < 2 || content.edges.length < 1)) {
    findings.push({ severity: "hard", code: "SEMANTIC_LAYOUT_MISMATCH", slideId: slide.id, message: "Pipeline slide must contain nodes and data-flow edges." });
  }
  if (slide.layout === "architecture" && (content.zones.length < 2 || content.zones.some((zone: any) => zone.nodes.length < 1))) {
    findings.push({ severity: "hard", code: "SEMANTIC_LAYOUT_MISMATCH", slideId: slide.id, message: "Architecture slide must contain zones with nodes." });
  }
  if (slide.layout === "quantitative" && content.metrics.length < 1) {
    findings.push({ severity: "hard", code: "SEMANTIC_LAYOUT_MISMATCH", slideId: slide.id, message: "Quantitative slide must contain metrics." });
  }
  if (slide.layout === "timeline" && content.milestones.length < 2) {
    findings.push({ severity: "hard", code: "SEMANTIC_LAYOUT_MISMATCH", slideId: slide.id, message: "Timeline slide must contain milestones." });
  }
}

// Compositions that plot every metric against one shared axis. `kpi_row` and `metric_story` are
// deliberately absent: they present each figure on its own terms, so mixed units are legitimate
// there. That asymmetry is the repair path — a flagged slide is fixed by changing composition,
// never by dropping the data.
const sharedAxisCompositions = new Set(["ranked_bars", "sparkline_row", "gauge_row"]);

// A slide can be source-grounded, geometrically valid, and free of overflow while still encoding a
// lie. 200 humanoids, 300,000 learning hours, and 100 planned deployments drawn as one bar row
// invites a comparison that the units do not support.
function addQuantitativeEncodingFindings(slide: SlideSpec, findings: QaFinding[]): void {
  if (slide.layout !== "quantitative" || !sharedAxisCompositions.has(slide.composition)) return;
  const metrics = slide.content.metrics;
  const units = [...new Set(metrics.map((metric) => metric.unit))];
  if (units.length > 1) {
    findings.push({
      severity: "hard",
      code: "MISLEADING_QUANTITATIVE_ENCODING",
      slideId: slide.id,
      message: `Composition '${slide.composition}' plots every metric on one shared axis, but the metrics carry ${units.length} different units (${units.join(", ")}). Use 'kpi_row' or 'metric_story', which present each figure separately.`,
    });
    return;
  }
  const magnitudes = metrics.map((metric) => Math.abs(metric.value)).filter((value) => value > 0);
  if (magnitudes.length < 2) return;
  const ratio = Math.max(...magnitudes) / Math.min(...magnitudes);
  if (ratio > 100) {
    findings.push({
      severity: "hard",
      code: "INCOMPARABLE_METRIC_SCALE",
      slideId: slide.id,
      message: `Largest metric is ${Math.round(ratio)}x the smallest, so the smaller bars carry no readable length on a shared axis. Split the slide, use a log-scaled native chart, or present the figures as 'kpi_row'.`,
    });
  }
}

// Budgets are expressed in display columns, not codepoints: a Japanese glyph occupies two of them,
// so `text.length` used to let a 40-character Japanese headline through a budget that a 65-character
// Latin one failed. `element` is also break-checked against the same budget, because a string can
// fit its region and still wrap badly.
function addTextBudget(
  slide: SlideSpec,
  findings: QaFinding[],
  element: string,
  text: string | undefined,
  maximum: number,
  language: string,
): void {
  if (!text) return;
  const width = displayWidth(text);
  if (width > maximum) {
    findings.push({
      severity: "risk",
      code: "TEXT_WRAP_RISK",
      slideId: slide.id,
      message: `${element} occupies ${width} display columns (maximum ${maximum}). Split, shorten, or select a layout with a larger text region before release.`,
    });
  }
  if (/^ja\b/i.test(language)) {
    for (const problem of kinsokuProblems(text, maximum)) {
      findings.push({ severity: "risk", code: problem.issue, slideId: slide.id, message: `${element}: ${problem.detail}. Rephrase or shorten so the break falls at a natural boundary.` });
    }
  }
}

function addTextBudgetFindings(slide: SlideSpec, findings: QaFinding[], language: string): void {
  // Shadows the module helper so every budget call below inherits the deck language without
  // repeating it at ~25 call sites.
  const addTextBudgetFinding = (target: SlideSpec, collected: QaFinding[], element: string, text: string | undefined, maximum: number): void =>
    addTextBudget(target, collected, element, text, maximum, language);

  const headlineProblem = headlineWrapProblem(slide.headline, 64);
  if (headlineProblem) {
    findings.push({ severity: "risk", code: headlineProblem.issue, slideId: slide.id, message: `Headline: ${headlineProblem.detail}. Compose the break or shorten the headline.` });
  }
  addTextBudgetFinding(slide, findings, "Headline", slide.headline, 64);
  switch (slide.layout) {
    case "title":
      addTextBudgetFinding(slide, findings, "Subtitle", slide.content.subtitle, 100);
      return;
    case "statement":
      addTextBudgetFinding(slide, findings, "Statement body", slide.content.body, 90);
      slide.content.proofs.forEach((value, index) => addTextBudgetFinding(slide, findings, `Evidence ${index + 1}`, value, 64));
      return;
    case "comparison":
      [slide.content.left, slide.content.right].forEach((side, sideIndex) => {
        addTextBudgetFinding(slide, findings, `Comparison label ${sideIndex + 1}`, side.label, 44);
        side.items.forEach((value, index) => addTextBudgetFinding(slide, findings, `Comparison item ${sideIndex + 1}.${index + 1}`, value, 60));
      });
      return;
    case "process":
      slide.content.steps.forEach((step, index) => {
        addTextBudgetFinding(slide, findings, `Process label ${index + 1}`, step.label, 38);
        addTextBudgetFinding(slide, findings, `Process detail ${index + 1}`, step.detail, 58);
        step.members?.forEach((member, memberIndex) => addTextBudgetFinding(slide, findings, `Process member ${index + 1}.${memberIndex + 1}`, member, 22));
      });
      return;
    case "pipeline":
      slide.content.nodes.forEach((node, index) => {
        addTextBudgetFinding(slide, findings, `Pipeline node ${index + 1}`, node.label, 32);
        addTextBudgetFinding(slide, findings, `Pipeline detail ${index + 1}`, node.detail, 44);
      });
      return;
    case "architecture":
      slide.content.zones.forEach((zone, index) => {
        addTextBudgetFinding(slide, findings, `Architecture zone ${index + 1}`, zone.label, 36);
        addTextBudgetFinding(slide, findings, `Architecture description ${index + 1}`, zone.description, 54);
        zone.nodes.forEach((node, nodeIndex) => addTextBudgetFinding(slide, findings, `Architecture node ${index + 1}.${nodeIndex + 1}`, node, 38));
      });
      return;
    case "quantitative":
      slide.content.metrics.forEach((metric, index) => {
        addTextBudgetFinding(slide, findings, `Metric label ${index + 1}`, metric.label, 36);
        addTextBudgetFinding(slide, findings, `Metric note ${index + 1}`, metric.note, 54);
      });
      return;
    case "timeline":
      slide.content.milestones.forEach((milestone, index) => {
        addTextBudgetFinding(slide, findings, `Timeline label ${index + 1}`, milestone.label, 36);
        addTextBudgetFinding(slide, findings, `Timeline detail ${index + 1}`, milestone.detail, 54);
      });
      return;
    case "evidence":
      addTextBudgetFinding(slide, findings, "Evidence caption", slide.content.caption, 90);
      slide.content.bullets.forEach((value, index) => addTextBudgetFinding(slide, findings, `Evidence item ${index + 1}`, value, 72));
      return;
    case "chart":
      addTextBudgetFinding(slide, findings, "Chart caption", slide.content.caption, 90);
  }
}

// Deterministic classification of what each composition actually shows, used to check that
// designDirection is reflected in the compositions the outline actually picked — not just in
// renderer decoration. DeckSpec's layout+composition are authored upstream (interview/outline);
// this only reviews that choice at the QA gate, it never rewrites it.
const compositionProfile: Record<string, { visualArea: "low" | "medium" | "high"; textDensity: "low" | "medium" | "high" }> = {
  cover: { visualArea: "low", textDensity: "low" },
  hero_evidence: { visualArea: "medium", textDensity: "medium" },
  claim_actions: { visualArea: "medium", textDensity: "medium" },
  two_column: { visualArea: "low", textDensity: "high" },
  diagnosis_matrix: { visualArea: "low", textDensity: "high" },
  ownership_split: { visualArea: "high", textDensity: "medium" },
  sequence: { visualArea: "high", textDensity: "low" },
  stage_gate: { visualArea: "high", textDensity: "low" },
  pipeline_lanes: { visualArea: "high", textDensity: "low" },
  architecture_zones: { visualArea: "high", textDensity: "low" },
  kpi_row: { visualArea: "medium", textDensity: "low" },
  ranked_bars: { visualArea: "medium", textDensity: "low" },
  metric_story: { visualArea: "medium", textDensity: "medium" },
  gauge_row: { visualArea: "high", textDensity: "low" },
  sparkline_row: { visualArea: "high", textDensity: "low" },
  linear_roadmap: { visualArea: "medium", textDensity: "low" },
  now_next_later: { visualArea: "medium", textDensity: "medium" },
  evidence_list: { visualArea: "low", textDensity: "high" },
  evidence_panel: { visualArea: "medium", textDensity: "medium" },
  native_chart: { visualArea: "high", textDensity: "low" },
  central_hub: { visualArea: "high", textDensity: "low" },
  layered_stack: { visualArea: "high", textDensity: "low" },
  verdict_contrast: { visualArea: "medium", textDensity: "medium" },
};

function addCompositionDirectionFitFindings(deck: DeckSpec, findings: QaFinding[]): void {
  const bodySlides = deck.slides.filter((slide) => slide.layout !== "title");
  if (bodySlides.length < 8) return;
  const direction = deck.contract.designDirection;
  if (direction !== "visual" && direction !== "dense") return;

  const profiles = bodySlides.map((slide) => compositionProfile[slide.composition]).filter((profile): profile is { visualArea: "low" | "medium" | "high"; textDensity: "low" | "medium" | "high" } => Boolean(profile));
  if (direction === "visual") {
    const share = profiles.filter((profile) => profile.visualArea === "high").length / bodySlides.length;
    if (share < 0.4) {
      findings.push({ severity: "risk", code: "LOW_VISUAL_COMPOSITION_SHARE", message: `visual deck uses high-visual-area compositions on ${Math.round(share * 100)}% of body slides; expected at least 40%.` });
    }
  } else {
    const share = profiles.filter((profile) => profile.textDensity === "high").length / bodySlides.length;
    if (share < 0.3) {
      findings.push({ severity: "risk", code: "LOW_DENSE_COMPOSITION_SHARE", message: `dense deck uses high-text-density compositions on ${Math.round(share * 100)}% of body slides; expected at least 30%.` });
    }
  }
}

function addCompositionFindings(slides: SlideSpec[], findings: QaFinding[]): void {
  const bodySlides = slides.filter((slide) => slide.layout !== "title");
  const compositions = bodySlides.map((slide) => `${slide.layout}:${slide.composition}`);
  let run = "";
  let runLength = 0;
  compositions.forEach((composition) => {
    runLength = composition === run ? runLength + 1 : 1;
    run = composition;
    if (runLength >= 3) {
      findings.push({ severity: "hard", code: "REPEATED_COMPOSITION_RUN", message: `Composition ${composition} is repeated three or more times consecutively.` });
    }
  });
  if (bodySlides.length < 5) return;
  const counts = new Map<string, number>();
  compositions.forEach((composition) => counts.set(composition, (counts.get(composition) ?? 0) + 1));
  const minimumVariety = bodySlides.length >= 12 ? 5 : bodySlides.length >= 8 ? 4 : 3;
  if (counts.size < minimumVariety) {
    findings.push({ severity: "risk", code: "LOW_COMPOSITION_VARIETY", message: `Deck uses ${counts.size} composition variants; at least ${minimumVariety} are expected for ${bodySlides.length} body slides.` });
  }
  counts.forEach((count, composition) => {
    if (count / bodySlides.length > 0.35) {
      findings.push({ severity: "risk", code: "DOMINANT_COMPOSITION", message: `${composition} occupies more than 35% of body slides.` });
    }
  });
}

// Counting composition *names* is not enough: `architecture_zones`, `pipeline_lanes`, and
// `sequence` are three different composition names that all draw the same primitive (equal-width
// columns/rows in an even grid). A deck can clear every check above — enough distinct names, no
// one name dominant — while still reading as three slides repeated, because the names differ but
// the shape never does. This checks variety and dominance at the family level instead.
function addCompositionFamilyFindings(slides: SlideSpec[], findings: QaFinding[]): void {
  const bodySlides = slides.filter((slide) => slide.layout !== "title");
  const families = bodySlides.map((slide) => compositionFamily[slide.composition]).filter((family): family is CompositionFamily => Boolean(family));
  let run: CompositionFamily | undefined;
  let runLength = 0;
  families.forEach((family) => {
    runLength = family === run ? runLength + 1 : 1;
    run = family;
    if (runLength >= 3) {
      findings.push({ severity: "risk", code: "REPEATED_COMPOSITION_FAMILY_RUN", message: `Composition family '${family}' is repeated three or more times consecutively, even where the individual composition names differ.` });
    }
  });
  if (bodySlides.length < 5) return;
  const counts = new Map<CompositionFamily, number>();
  families.forEach((family) => counts.set(family, (counts.get(family) ?? 0) + 1));
  const minimumVariety = bodySlides.length >= 12 ? 4 : bodySlides.length >= 8 ? 3 : 2;
  if (counts.size < minimumVariety) {
    findings.push({ severity: "risk", code: "LOW_COMPOSITION_FAMILY_VARIETY", message: `Deck uses ${counts.size} composition families; at least ${minimumVariety} are expected for ${bodySlides.length} body slides.` });
  }
  counts.forEach((count, family) => {
    if (count / bodySlides.length > 0.4) {
      findings.push({ severity: "risk", code: "DOMINANT_COMPOSITION_FAMILY", message: `Composition family '${family}' occupies more than 40% of body slides.` });
    }
  });
}

type Skeleton = { axis: "x" | "y" | "radial" | "none"; equalCells: boolean };

// What a composition actually lays on the canvas, independent of its family label. A row of
// equal-width architecture zones and a row of equal-width numbered process steps are different
// families (`column_zones` vs `horizontal_sequence`) but the identical primitive to a viewer's
// eye: equal cells, same axis. Family-variety counting alone cannot catch that — this can.
const skeletonByComposition: Record<string, Skeleton> = {
  cover: { axis: "none", equalCells: false },
  hero_evidence: { axis: "none", equalCells: false },
  claim_actions: { axis: "none", equalCells: false },
  two_column: { axis: "x", equalCells: true },
  diagnosis_matrix: { axis: "x", equalCells: false },
  ownership_split: { axis: "x", equalCells: true },
  verdict_contrast: { axis: "x", equalCells: false },
  sequence: { axis: "x", equalCells: true },
  stage_gate: { axis: "x", equalCells: true },
  pipeline_lanes: { axis: "y", equalCells: true },
  architecture_zones: { axis: "x", equalCells: true }, // overridden below when edges converge on one hub zone
  central_hub: { axis: "radial", equalCells: false },
  layered_stack: { axis: "y", equalCells: false },
  kpi_row: { axis: "x", equalCells: true },
  ranked_bars: { axis: "none", equalCells: false },
  metric_story: { axis: "none", equalCells: false },
  gauge_row: { axis: "x", equalCells: true },
  sparkline_row: { axis: "none", equalCells: false },
  linear_roadmap: { axis: "x", equalCells: true },
  now_next_later: { axis: "x", equalCells: true },
  evidence_list: { axis: "none", equalCells: false },
  evidence_panel: { axis: "none", equalCells: false },
  native_chart: { axis: "none", equalCells: false },
};

function structuralSkeleton(slide: SlideSpec): Skeleton {
  const base = skeletonByComposition[slide.composition] ?? { axis: "none", equalCells: false };
  // Mirrors the renderer's own asymmetry rule (schema.ts `architectureHubZone`): a hub slide's
  // zones are no longer equal width, so it should not count toward this check either. Widening a
  // zone to prove a headline's focal object also, as a side effect, breaks up rhythm repetition.
  if (slide.layout === "architecture" && slide.composition === "architecture_zones" && architectureHubZone(slide.content.edges)) {
    return { axis: "x", equalCells: false };
  }
  return base;
}

function addUniformCellRhythmFindings(slides: SlideSpec[], findings: QaFinding[]): void {
  const bodySlides = slides.filter((slide) => slide.layout !== "title");
  if (bodySlides.length < 5) return;
  const equalAxisCounts = new Map<string, number>();
  bodySlides.forEach((slide) => {
    const skeleton = structuralSkeleton(slide);
    if (skeleton.equalCells && skeleton.axis !== "none") {
      equalAxisCounts.set(skeleton.axis, (equalAxisCounts.get(skeleton.axis) ?? 0) + 1);
    }
  });
  const dominant = [...equalAxisCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!dominant) return;
  const [axis, count] = dominant;
  const share = count / bodySlides.length;
  if (share >= 0.6) {
    findings.push({
      severity: "risk",
      code: "UNIFORM_CELL_RHYTHM",
      message: `${Math.round(share * 100)}% of body slides lay equal-width cells on the same ${axis === "x" ? "horizontal" : "vertical"} axis. Composition names differ (architecture zones, numbered sequences, equal comparison panels) but the shape a viewer sees does not. Vary the cell geometry itself — an asymmetric hub, a weighted stack, or a radial layout — not just the composition name.`,
    });
  }
}

// Every layout's countable collection, used to check a headline's numeric claim against what the
// slide actually shows. `architecture` reports the larger of zone count and total node count so
// either a claim about layers or a claim about components can be satisfied. Layouts with no
// natural countable collection (title, comparison's own delta, chart) are omitted deliberately —
// there is nothing here for a headline number to be checked against.
function countableElements(slide: SlideSpec): number | undefined {
  switch (slide.layout) {
    case "process": {
      const totalMembers = slide.content.steps.reduce((sum, step) => sum + (step.members?.length ?? 0), 0);
      return totalMembers > 0 ? totalMembers : slide.content.steps.length;
    }
    case "architecture": {
      const totalNodes = slide.content.zones.reduce((sum, zone) => sum + zone.nodes.length, 0);
      return Math.max(slide.content.zones.length, totalNodes);
    }
    case "pipeline":
      return slide.content.nodes.length;
    case "comparison":
      return slide.content.left.items.length + slide.content.right.items.length;
    case "quantitative":
      return slide.content.metrics.length;
    case "timeline":
      return slide.content.milestones.length;
    case "statement":
      return slide.content.proofs.length;
    case "evidence":
      return slide.content.bullets.length;
    default:
      return undefined;
  }
}

// S07's actual regression: "18 skills, one job each" over a visual that shows 5 stage cards. The
// headline asserted a quantity the visual never represented. This is fully deterministic — no
// visual judgment needed, just a count — so it belongs in Core QA, not Visual QA.
function addHeadlineProofFindings(slide: SlideSpec, findings: QaFinding[]): void {
  const count = countableElements(slide);
  if (count === undefined) return;
  const matches = [...slide.headline.matchAll(/\b(\d+)\s+[A-Za-z]+s\b/g)];
  for (const match of matches) {
    const claimed = Number(match[1]);
    if (claimed <= count) continue;
    // The number may still be grounded in plain sight — e.g. a metric or a node label that
    // spells out the same figure the headline claims. Only flag when it appears nowhere else.
    const contentText = JSON.stringify((slide as { content: unknown }).content);
    if (new RegExp(`(?<![\\d.])${claimed}(?![\\d.])`).test(contentText)) continue;
    findings.push({
      severity: "hard",
      code: "VISUAL_DOES_NOT_PROVE_HEADLINE",
      slideId: slide.id,
      message: `Headline claims "${match[0]}" but the slide's visual (${slide.layout}/${slide.composition}) shows only ${count} countable element(s). Either the visual must represent ${claimed}, or the headline must not claim more than the slide shows.`,
    });
  }
}

// Explicit non-"auto" design directions get their own density band, floor and ceiling both.
// "auto" keeps the original purpose-gated, floor-only behavior byte-for-byte so a run that never
// touches designDirection sees no change in judgment.
const densityBandsByDirection: Record<"dense" | "balanced" | "visual" | "minimal", { floor: number; ceiling?: number }> = {
  dense: { floor: 480 },
  balanced: { floor: 360, ceiling: 900 },
  visual: { floor: 220, ceiling: 480 },
  minimal: { floor: 200, ceiling: 420 },
};

function averageVisibleChars(slides: SlideSpec[]): number {
  return slides.reduce((total, slide) => total + flattenVisibleText(slide).length, 0) / slides.length;
}

function addPurposeDensityFindings(deck: DeckSpec, findings: QaFinding[]): void {
  const bodySlides = deck.slides.filter((slide) => slide.layout !== "title");
  const direction = deck.contract.designDirection;

  if (direction === "auto") {
    if (!["proposal", "executive", "internal"].includes(deck.contract.purpose)) return;
    if (bodySlides.length < 8) return;
    const average = averageVisibleChars(bodySlides);
    if (average < 360) {
      findings.push({
        severity: "risk",
        code: "LOW_INFORMATION_DENSITY",
        message: `${deck.contract.purpose} deck averages ${Math.round(average)} visible characters per body slide. Combine diagnosis, evidence, and action where the source supports it instead of spreading sparse content across extra slides.`,
      });
    }
    return;
  }

  if (direction === "reference" || bodySlides.length < 8) return;
  const band = densityBandsByDirection[direction];
  const average = averageVisibleChars(bodySlides);
  if (average < band.floor) {
    findings.push({
      severity: "risk",
      code: "LOW_INFORMATION_DENSITY",
      message: `${direction} deck averages ${Math.round(average)} visible characters per body slide, below its ${band.floor}-character floor.`,
    });
  } else if (band.ceiling && average > band.ceiling) {
    findings.push({
      severity: "risk",
      code: "EXCESSIVE_INFORMATION_DENSITY",
      message: `${direction} deck averages ${Math.round(average)} visible characters per body slide, above its ${band.ceiling}-character ceiling.`,
    });
  }
}

function addNarrativeFindings(deck: DeckSpec, findings: QaFinding[]): void {
  const indexes = new Map(deck.contract.storyline.map((beat, index) => [beat, index]));
  let previous = -1;
  deck.slides.forEach((slide) => {
    const current = indexes.get(slide.storyBeat) ?? -1;
    if (current < previous) {
      findings.push({ severity: "risk", code: "NARRATIVE_ORDER_DRIFT", slideId: slide.id, message: `${slide.storyBeat} appears after a later storyline beat. Reorder the slide or revise the approved storyline.` });
    }
    previous = Math.max(previous, current);
  });
  if (["proposal", "executive"].includes(deck.contract.purpose)) {
    const required = ["problem", "evidence", "design", "roadmap"] as const;
    const missing = required.filter((beat) => !indexes.has(beat));
    if (missing.length > 0) {
      findings.push({ severity: "risk", code: "NARRATIVE_COVERAGE_GAP", message: `${deck.contract.purpose} storyline is missing: ${missing.join(", ")}.` });
    }
  }
}

function loadContentModel(contentModel: string | ContentModel | undefined): ContentModel | undefined {
  if (!contentModel) return undefined;
  if (typeof contentModel !== "string") return contentModelSchema.parse(contentModel);
  if (!fs.existsSync(contentModel)) return undefined;
  return contentModelSchema.parse(JSON.parse(fs.readFileSync(contentModel, "utf8")));
}

function loadReferenceSelectionIds(referenceSelectionPath: string | undefined): Set<string> | undefined {
  if (!referenceSelectionPath || !fs.existsSync(referenceSelectionPath)) return undefined;
  const raw = JSON.parse(fs.readFileSync(referenceSelectionPath, "utf8")) as Array<{ id: string }>;
  return new Set(raw.map((entry) => entry.id));
}

function addReferenceSelectionFindings(deck: DeckSpec, findings: QaFinding[], referenceSelectionPath: string | undefined): void {
  const referenceIds = deck.contract.referenceIds;
  if (!referenceIds || referenceIds.length === 0) return;
  const known = loadReferenceSelectionIds(referenceSelectionPath);
  if (!known) {
    findings.push({ severity: "hard", code: "REFERENCE_SELECTION_NOT_FOUND", message: "contract.referenceIds is set but reference-selection.json was not found; run `reference --run-dir` before validating." });
    return;
  }
  referenceIds.forEach((id) => {
    if (!known.has(id)) findings.push({ severity: "hard", code: "REFERENCE_SELECTION_NOT_FOUND", message: `referenceIds entry '${id}' is absent from reference-selection.json.` });
  });
}

function sourceTextForRef(deck: DeckSpec, sourceId: string, projectDir: string): string | undefined {
  const source = deck.contract.sources.find((candidate) => candidate.id === sourceId);
  if (!source) return undefined;
  if (source.kind === "prompt") return source.text;
  if (!["md", "txt"].includes(source.type)) return undefined;
  return fs.readFileSync(path.resolve(projectDir, source.path), "utf8");
}

export function resolveExcerpt(contentModel: ContentModel, ref: SourceRef): { locator: string; text: string } | undefined {
  const modelSource = contentModel.sources.find((source) => source.sourceId === ref.sourceId);
  return modelSource?.excerpts.find((excerpt) => excerpt.id === ref.excerptId);
}

function addSourceExcerptFindings(deck: DeckSpec, slide: SlideSpec, findings: QaFinding[], projectDir: string, contentModel: ContentModel): void {
  slide.sourceRefs.forEach((ref) => {
    const resolved = resolveExcerpt(contentModel, ref);
    if (!resolved) {
      findings.push({ severity: "hard", code: "SOURCE_EXCERPT_NOT_IN_CONTENT_MODEL", slideId: slide.id, message: `Source reference ${ref.sourceId}:${ref.excerptId} is absent from content-model.json.` });
      return;
    }
    const sourceText = sourceTextForRef(deck, ref.sourceId, projectDir);
    if (sourceText !== undefined && !sourceText.includes(resolved.text)) {
      findings.push({ severity: "hard", code: "SOURCE_EXCERPT_MISMATCH", slideId: slide.id, message: `Source reference ${ref.sourceId}:${ref.excerptId} (${resolved.locator}) is not present in its original source.` });
    }
  });
}

function resolveExcerptTexts(slide: SlideSpec, contentModel: ContentModel | undefined): string[] {
  if (!contentModel) return [];
  return slide.sourceRefs.map((ref) => resolveExcerpt(contentModel, ref)?.text).filter((text): text is string => Boolean(text));
}

function bareNumericValue(token: string): string {
  return (token.match(/^[-+]?\d+(?:[.,]\d+)?/)?.[0] ?? token).replace(",", ".");
}

function addChartDataFindings(slide: SlideSpec, findings: QaFinding[], model: ContentModel | undefined): void {
  if (slide.layout !== "chart") return;
  const dataset = model?.datasets?.find((candidate) => candidate.id === slide.content.dataRef);
  if (!dataset) {
    findings.push({ severity: "hard", code: "CHART_DATA_NOT_IN_CONTENT_MODEL", slideId: slide.id, message: `Chart dataRef '${slide.content.dataRef}' is absent from content-model.json datasets.` });
    return;
  }
  const resolved = model ? resolveExcerpt(model, { sourceId: dataset.sourceId, excerptId: dataset.excerptId }) : undefined;
  if (!resolved) {
    findings.push({ severity: "hard", code: "CHART_DATA_NOT_IN_CONTENT_MODEL", slideId: slide.id, message: `Dataset '${dataset.id}' references excerpt ${dataset.sourceId}:${dataset.excerptId}, which is absent from content-model.json.` });
    return;
  }
  const bareValues = new Set(numericTokens(resolved.text).map(bareNumericValue));
  dataset.series.forEach((series) => {
    series.values.forEach((value) => {
      if (!bareValues.has(String(value))) {
        findings.push({ severity: "hard", code: "CHART_DATA_GROUNDING", slideId: slide.id, message: `Chart dataset '${dataset.id}' series '${series.name}' contains value ${value}, absent from cited excerpt ${dataset.sourceId}:${dataset.excerptId}.` });
      }
    });
  });
}

export function verifySourceRefs(input: unknown, projectDir = process.cwd(), contentModel?: string | ContentModel): QaFinding[] {
  const deck = deckSchema.parse(input);
  const model = loadContentModel(contentModel);
  if (!model) {
    return [{ severity: "hard", code: "CONTENT_MODEL_REQUIRED", message: "content-model.json is required so every sourceRef.excerptId can be verified." }];
  }
  const findings: QaFinding[] = [];
  deck.slides.forEach((slide) => addSourceExcerptFindings(deck, slide, findings, projectDir, model));
  return findings;
}

export function structuralQa(input: unknown, projectDir = process.cwd(), contentModel?: string | ContentModel, referenceSelectionPath?: string): QaReport {
  const deck = deckSchema.parse(input);
  const model = loadContentModel(contentModel);
  const findings: QaFinding[] = [];
  if (!model) {
    findings.push({ severity: "hard", code: "CONTENT_MODEL_REQUIRED", message: "content-model.json is required so every sourceRef.excerptId can be verified." });
  }
  addReferenceSelectionFindings(deck, findings, referenceSelectionPath);
  deck.contract.sources.forEach((source) => {
    if (source.kind === "file" && !fs.existsSync(path.resolve(projectDir, source.path))) {
      findings.push({ severity: "hard", code: "SOURCE_NOT_FOUND", message: `Source file does not exist: ${source.path}` });
    }
  });
  if (deck.contract.slideCount !== deck.slides.length) {
    findings.push({ severity: "hard", code: "SLIDE_COUNT_MISMATCH", message: "Contract slide count does not match DeckSpec." });
  }
  const legacyTheme = deck.theme && "fonts" in deck.theme ? deck.theme : undefined;
  if (legacyTheme && (legacyTheme.fonts.heading !== deck.contract.fonts.heading || legacyTheme.fonts.body !== deck.contract.fonts.body)) {
    findings.push({ severity: "hard", code: "FONT_CONTRACT_DRIFT", message: "Resolved theme fonts do not match the confirmed GenerationContract." });
  }
  if (legacyTheme?.logoPath && !fs.existsSync(legacyTheme.logoPath)) {
    findings.push({ severity: "hard", code: "LOGO_NOT_FOUND", message: `Required brand logo does not exist: ${legacyTheme.logoPath}` });
  }

  const bodyLayouts = deck.slides.filter((slide) => slide.layout !== "title").map((slide) => slide.layout);
  let runLayout: string | undefined;
  let runLength = 0;
  bodyLayouts.forEach((layout) => {
    if (layout === runLayout) runLength += 1;
    else {
      runLayout = layout;
      runLength = 1;
    }
    if (runLength >= 3) {
      findings.push({ severity: "risk", code: "REPEATED_LAYOUT_RUN", message: `Layout ${layout} is repeated three or more times consecutively. Confirm that its composition variants create a meaningful section rhythm.` });
    }
  });
  if (bodyLayouts.length >= 7) {
    const counts = new Map<string, number>();
    bodyLayouts.forEach((layout) => counts.set(layout, (counts.get(layout) ?? 0) + 1));
    counts.forEach((count, layout) => {
      if (count / bodyLayouts.length > 0.4) findings.push({ severity: "risk", code: "DOMINANT_LAYOUT", message: `${layout} occupies more than 40% of body slides.` });
    });
  }
  addCompositionFindings(deck.slides, findings);
  addCompositionFamilyFindings(deck.slides, findings);
  addUniformCellRhythmFindings(deck.slides, findings);
  addCompositionDirectionFitFindings(deck, findings);
  addPurposeDensityFindings(deck, findings);
  addNarrativeFindings(deck, findings);

  deck.slides.forEach((slide) => {
    addSemanticFindings(slide, findings);
    addTextBudgetFindings(slide, findings, deck.contract.language);
    addQuantitativeEncodingFindings(slide, findings);
    addHeadlineProofFindings(slide, findings);
    if (slide.sourceRefs.length === 0) findings.push({ severity: "hard", code: "SOURCE_OMISSION", slideId: slide.id, message: "Every slide requires at least one source reference." });
    if (model) addSourceExcerptFindings(deck, slide, findings, projectDir, model);
    const excerptTokens = excerptTokenSet(resolveExcerptTexts(slide, model));
    const allowedCalculatedTokens = addClaimFindings(slide, excerptTokens, findings);
    numericTokens(flattenVisibleText(slide)).forEach((token) => {
      if (!excerptTokens.has(token) && !allowedCalculatedTokens.has(token)) findings.push({ severity: "hard", code: "NUMERIC_GROUNDING", slideId: slide.id, message: `Numeric token ${token} is absent from cited source excerpts or a grounded calculation.` });
    });
    if (slide.layout === "pipeline") {
      const nodeIds = new Set(slide.content.nodes.map((node) => node.id));
      slide.content.edges.forEach((edge) => {
        if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) findings.push({ severity: "hard", code: "UNKNOWN_PIPELINE_NODE", slideId: slide.id, message: `Pipeline edge references an unknown node: ${edge.from} -> ${edge.to}.` });
      });
    }
    addChartDataFindings(slide, findings, model);
  });

  return { ...rollUp(findings), reference: "not_applicable", attempts: 0, findings };
}

export async function ooxmlQa(
  pptxPath: string,
  deck: DeckSpec,
  slideIdsOrStyle: string[] | ResolvedPresentationStyle = deck.slides.map((slide) => slide.id),
  style?: ResolvedPresentationStyle,
): Promise<QaFinding[]> {
  const slideIds = Array.isArray(slideIdsOrStyle) ? slideIdsOrStyle : deck.slides.map((slide) => slide.id);
  const resolvedStyle = Array.isArray(slideIdsOrStyle) ? style : slideIdsOrStyle;
  const facts = await readPptxOoxml(pptxPath);
  const findings: QaFinding[] = [];
  if (!facts.parseOk) {
    findings.push({ severity: "hard", code: "OOXML_INVALID", message: `Rendered PPTX could not be parsed: ${pptxPath}` });
    return findings;
  }
  const renderedSlides = deck.slides.filter((slide) => slideIds.includes(slide.id));
  if (facts.slideCount !== renderedSlides.length && facts.slideCount !== deck.slides.length) {
    findings.push({ severity: "hard", code: "OOXML_INVALID", message: `Rendered slide count ${facts.slideCount} does not match the expected scoped count ${renderedSlides.length} or full deck count ${deck.slides.length}.` });
    return findings;
  }
  const allowedFonts = new Set([deck.contract.fonts.heading, deck.contract.fonts.body]);
  renderedSlides.forEach((slide) => {
    const deckIndex = deck.slides.findIndex((candidate) => candidate.id === slide.id);
    const slideFacts = facts.slides[deckIndex];
    if (!slideFacts) {
      findings.push({ severity: "hard", code: "OOXML_INVALID", slideId: slide.id, message: `Rendered PPTX does not contain the expected slide '${slide.id}'.` });
      return;
    }
    const badFonts = slideFacts.typefaces.filter((typeface) => !allowedFonts.has(typeface));
    if (badFonts.length > 0) {
      findings.push({ severity: "hard", code: "FONT_SUBSTITUTION", slideId: slide.id, message: `Slide uses unapproved font(s): ${badFonts.join(", ")}.` });
    }
    const missing = requiredNativeObjectsFor(slide).filter((kind) => slideFacts.nativeObjects[kind as keyof NativeObjectCounts] === 0);
    if (missing.length > 0) {
      findings.push({ severity: "hard", code: "REQUIRED_NATIVE_OBJECT_MISSING", slideId: slide.id, message: `Composition '${slide.composition}' requires native objects: ${missing.join(", ")}.` });
    }
    if (slideFacts.fullSlideImage) {
      findings.push({ severity: "hard", code: "FULL_SLIDE_RASTERIZATION", slideId: slide.id, message: "Slide is a full-bleed image with no editable text; a PPTX page must not be a rasterized image." });
    }
    if (slideFacts.hasEastAsianText && !slideFacts.hasEastAsianTypeface) {
      findings.push({ severity: "hard", code: "EAST_ASIAN_FONT_MISSING", slideId: slide.id, message: "Slide contains East Asian text but no East Asian typeface is declared on any run." });
    }
    if (slideFacts.gradientFills > 0) {
      findings.push({ severity: "hard", code: "GRADIENT_FILL_FORBIDDEN", slideId: slide.id, message: `Slide carries ${slideFacts.gradientFills} gradient fill(s) on renderer-authored shapes or a native chart. Presentation archetypes use flat semantic fills; template master chrome and source images are exempt.` });
    }
    if (resolvedStyle && slideFacts.chartColors.length > 0) {
      const allowedDataColors = new Set(resolvedStyle.data.map((color) => color.toUpperCase()));
      const invalid = [...new Set(slideFacts.chartColors.flat().filter((color) => !allowedDataColors.has(color.toUpperCase())))];
      if (invalid.length > 0) {
        findings.push({ severity: "hard", code: "THEME_DATA_COLOR_VIOLATION", slideId: slide.id, message: `Chart uses categorical color(s) outside resolved theme.data: ${invalid.join(", ")}. Structural tokens must not be used as data colors.` });
      }
    }
  });
  if (deck.contract.fontDelivery === "portable" && !facts.embeddedFonts) {
    findings.push({ severity: "hard", code: "FONT_EMBEDDING_REQUIRED", message: "Portable delivery requires embedded font parts; none were found in the rendered PPTX." });
  }
  return findings;
}

export function mergeFindings(structural: QaReport, additional: QaFinding[]): QaReport {
  const findings = [...structural.findings, ...additional];
  return { ...structural, ...rollUp(findings), findings };
}

export function runPowerPointQa(pptxPath: string, deck: DeckSpec, runDir: string, slideIds = deck.slides.map((slide) => slide.id)): Record<string, unknown> {
  if (process.platform !== "win32") throw new Error("PowerPoint QA requires Windows with Microsoft PowerPoint installed.");
  const scriptPath = path.resolve(__dirname, "..", "scripts", "qa.ps1");
  const outputDir = path.resolve(runDir);
  fs.mkdirSync(outputDir, { recursive: true });
  let raw = "";
  const extraArgs = [
    ...(deck.theme && "footer" in deck.theme && deck.theme.footer.showPageNumber ? ["-RequirePageNumber"] : []),
    ...(deck.theme && "logoPath" in deck.theme && deck.theme.logoPath ? ["-RequireLogo"] : []),
    "-FontDelivery", deck.contract.fontDelivery,
    "-RequiredNativeObject",
    deck.slides
      .filter((slide) => slideIds.includes(slide.id))
      .flatMap((slide) => requiredNativeObjectsFor(slide).map((objectType) => `${slide.id},${objectType}`))
      .join(";"),
  ];
  try {
    raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-PptxPath", path.resolve(pptxPath), "-OutputDir", outputDir, "-HeadingFont", deck.contract.fonts.heading, "-BodyFont", deck.contract.fonts.body, ...extraArgs], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    raw = error instanceof Error ? error.message : String(error);
  }
  const resultPath = path.join(outputDir, "powerpoint-qa.json");
  if (!fs.existsSync(resultPath)) throw new Error(`PowerPoint QA did not produce ${resultPath}. Output: ${raw}`);
  return JSON.parse(fs.readFileSync(resultPath, "utf8")) as Record<string, unknown>;
}

export function mergeQa(structural: QaReport, powerpoint: Record<string, unknown>): QaReport {
  const powerFindings = Array.isArray(powerpoint.findings) ? powerpoint.findings as QaFinding[] : [];
  const findings = [...structural.findings, ...powerFindings];
  if (powerpoint.status === "fail" && powerFindings.length === 0) {
    findings.push({ severity: "hard", code: "POWERPOINT_QA_FAILED", message: "PowerPoint QA returned fail without a detailed finding." });
  }
  return { ...rollUp(findings), reference: structural.reference, attempts: structural.attempts, findings, powerpoint };
}
