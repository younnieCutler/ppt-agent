import fs from "node:fs";
import path from "node:path";
import { resolveExcerpt } from "./qa";
import { deckSchema, requiredNativeObjectsFor, slideSchema, type ContentModel, type DeckSpec, type SlideSpec } from "./schema";
import type { ResolvedPresentationStyle } from "./style";

type RepairFinding = { severity: string; code: string; slideId?: string; message: string };
type Dataset = NonNullable<ContentModel["datasets"]>[number];

export type RepairContext = {
  slide: SlideSpec;
  excerpts: Array<{ sourceId: string; excerptId: string; locator: string; text: string }>;
  dataset?: Dataset;
  reference: Array<Record<string, unknown>>;
  findings: RepairFinding[];
  designDirection: DeckSpec["contract"]["designDirection"];
  presentationStyle: DeckSpec["contract"]["presentationStyle"];
  resolvedStyle?: Pick<ResolvedPresentationStyle, "themeId" | "designDirection" | "grammar" | "reference" | "locks" | "provenance">;
  theme: DeckSpec["theme"];
  imagePath: string;
};

export function buildRepairContext(
  deck: DeckSpec,
  slideId: string,
  contentModel: ContentModel | undefined,
  visualQaReport: { findings: RepairFinding[] } | undefined,
  referenceSelection: Array<Record<string, unknown>> | undefined,
  visualImagePath: string,
  resolvedStyle?: ResolvedPresentationStyle,
): RepairContext {
  const slide = deck.slides.find((candidate) => candidate.id === slideId);
  if (!slide) throw new Error(`Slide '${slideId}' does not exist in this DeckSpec.`);

  const excerpts = slide.sourceRefs
    .map((ref) => {
      const resolved = contentModel ? resolveExcerpt(contentModel, ref) : undefined;
      return resolved ? { sourceId: ref.sourceId, excerptId: ref.excerptId, ...resolved } : undefined;
    })
    .filter((entry): entry is { sourceId: string; excerptId: string; locator: string; text: string } => Boolean(entry));

  const dataset =
    slide.layout === "chart" ? contentModel?.datasets?.find((candidate) => candidate.id === slide.content.dataRef) : undefined;

  const referenceIds = new Set(deck.contract.referenceIds ?? []);
  const reference = (referenceSelection ?? []).filter((entry) => referenceIds.has(String(entry.id)));

  const findings = (visualQaReport?.findings ?? []).filter((finding) => !finding.slideId || finding.slideId === slideId);

  return {
    slide,
    excerpts,
    dataset,
    reference,
    findings,
    designDirection: deck.contract.designDirection,
    presentationStyle: deck.contract.presentationStyle,
    resolvedStyle: resolvedStyle ? {
      themeId: resolvedStyle.themeId,
      designDirection: resolvedStyle.designDirection,
      grammar: resolvedStyle.grammar,
      reference: resolvedStyle.reference,
      locks: resolvedStyle.locks,
      provenance: resolvedStyle.provenance,
    } : undefined,
    theme: deck.theme,
    imagePath: visualImagePath,
  };
}

export type RepairInvariantResult = { ok: true } | { ok: false; code: string; message: string };

function checkInvariants(original: SlideSpec, replacement: SlideSpec, contentModel: ContentModel | undefined): RepairInvariantResult {
  if (replacement.id !== original.id) {
    return { ok: false, code: "REPAIR_ID_DRIFT", message: `Replacement id '${replacement.id}' does not match original '${original.id}'.` };
  }
  if (replacement.storyBeat !== original.storyBeat) {
    return { ok: false, code: "REPAIR_NARRATIVE_ROLE_DRIFT", message: `Replacement storyBeat '${replacement.storyBeat}' does not match original '${original.storyBeat}'.` };
  }

  // Grounding must only grow, never shrink: every original citation stays, and any new citation
  // must already resolve in content-model.json (repair cannot invent grounding for a new claim).
  const refKey = (ref: { sourceId: string; excerptId: string }): string => `${ref.sourceId}:${ref.excerptId}`;
  const originalRefKeys = new Set(original.sourceRefs.map(refKey));
  const replacementRefKeys = new Set(replacement.sourceRefs.map(refKey));
  const droppedRefs = original.sourceRefs.filter((ref) => !replacementRefKeys.has(refKey(ref)));
  if (droppedRefs.length > 0) {
    return {
      ok: false,
      code: "REPAIR_GROUNDING_WEAKENED",
      message: `Replacement drops source reference(s) present on the original slide: ${droppedRefs.map(refKey).join(", ")}.`,
    };
  }
  const invalidNewRefs = replacement.sourceRefs.filter((ref) => !originalRefKeys.has(refKey(ref)) && (!contentModel || !resolveExcerpt(contentModel, ref)));
  if (invalidNewRefs.length > 0) {
    return {
      ok: false,
      code: "REPAIR_GROUNDING_WEAKENED",
      message: `Replacement introduces source references not present in the original slide or resolvable in content-model.json: ${invalidNewRefs.map(refKey).join(", ")}.`,
    };
  }

  // Claims must not be invented, dropped, or silently rewritten. The primary claim (claims[0]) may
  // track a revised headline (deckSchema already requires claims[0].text === headline), but its
  // kind/status carry the approved claim's intent and must not change. Every other claim is frozen.
  if (replacement.claims.length !== original.claims.length) {
    return {
      ok: false,
      code: "REPAIR_CLAIM_DRIFT",
      message: `Replacement changes the number of claims (${original.claims.length} -> ${replacement.claims.length}); repair must not invent or drop claims.`,
    };
  }
  if (replacement.claims[0].kind !== original.claims[0].kind || replacement.claims[0].status !== original.claims[0].status) {
    return { ok: false, code: "REPAIR_CLAIM_DRIFT", message: "Replacement changes the primary claim's kind or status." };
  }
  for (let claimIndex = 1; claimIndex < original.claims.length; claimIndex += 1) {
    if (JSON.stringify(replacement.claims[claimIndex]) !== JSON.stringify(original.claims[claimIndex])) {
      return {
        ok: false,
        code: "REPAIR_CLAIM_DRIFT",
        message: `Replacement modifies claim ${claimIndex}, which repair must leave untouched (only the primary claim may track a revised headline).`,
      };
    }
  }

  // Every native object the original composition required must still be present — not just chart.
  // A repair that swaps pipeline_lanes for a text-only composition would silently drop connectors.
  const originalNative = requiredNativeObjectsFor(original);
  const replacementNative = new Set(requiredNativeObjectsFor(replacement));
  const droppedNative = originalNative.filter((kind) => !replacementNative.has(kind));
  if (droppedNative.length > 0) {
    return {
      ok: false,
      code: "REPAIR_NATIVE_OBJECT_DROPPED",
      message: `Replacement drops required native object(s) present on the original slide: ${droppedNative.join(", ")}.`,
    };
  }
  return { ok: true };
}

export type RepairApplyResult = {
  deck: DeckSpec;
  regressionScope: "slide" | "deck";
};

export function applyRepair(deck: DeckSpec, slideId: string, replacement: unknown, contentModel: ContentModel | undefined): RepairApplyResult {
  const index = deck.slides.findIndex((slide) => slide.id === slideId);
  if (index < 0) throw new Error(`Slide '${slideId}' does not exist in this DeckSpec.`);
  const original = deck.slides[index];
  const parsedReplacement = slideSchema.parse(replacement);

  const invariant = checkInvariants(original, parsedReplacement, contentModel);
  if (!invariant.ok) throw Object.assign(new Error(invariant.message), { code: invariant.code });

  const newSlides = deck.slides.map((slide, slideIndex) => (slideIndex === index ? parsedReplacement : slide));
  const touchedOthers = newSlides.some((slide, slideIndex) => slideIndex !== index && JSON.stringify(slide) !== JSON.stringify(deck.slides[slideIndex]));
  if (touchedOthers) throw Object.assign(new Error("Replacement changed a slide other than the target."), { code: "REPAIR_TOUCHED_PASSING_SLIDE" });
  if (newSlides.length !== deck.slides.length) throw Object.assign(new Error("Replacement changed the deck's slide count."), { code: "REPAIR_DECK_ORDER_DRIFT" });

  const regressionScope: "slide" | "deck" = original.layout !== parsedReplacement.layout || original.composition !== parsedReplacement.composition ? "deck" : "slide";
  // Re-validate the whole merged deck, not just the replacement slide in isolation: deck-level
  // invariants (claims[0].text === headline, narrative order, slideCount) live in deckSchema's
  // superRefine and are otherwise never re-checked until the next render/qa call.
  const validatedDeck = deckSchema.parse({ ...deck, slides: newSlides });
  return { deck: validatedDeck, regressionScope };
}

export type RepairState = {
  attempts: number;
  slides: Record<string, { attempts: number; lastFindings: string[]; status: "in_progress" | "blocked" | "resolved" }>;
};

const MAX_ATTEMPTS_PER_SLIDE = 2;

export function loadRepairState(statePath: string): RepairState {
  if (!fs.existsSync(statePath)) return { attempts: 0, slides: {} };
  return JSON.parse(fs.readFileSync(statePath, "utf8")) as RepairState;
}

export function recordRepairAttempt(statePath: string, slideId: string, lastFindings: string[], status: "in_progress" | "blocked" | "resolved"): RepairState {
  const state = loadRepairState(statePath);
  const previous = state.slides[slideId]?.attempts ?? 0;
  if (previous >= MAX_ATTEMPTS_PER_SLIDE) {
    throw new Error(`Slide '${slideId}' has already exhausted its ${MAX_ATTEMPTS_PER_SLIDE} automatic repair attempts.`);
  }
  state.slides[slideId] = { attempts: previous + 1, lastFindings, status };
  state.attempts = Math.max(...Object.values(state.slides).map((entry) => entry.attempts), 0);
  fs.mkdirSync(path.dirname(path.resolve(statePath)), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return state;
}
