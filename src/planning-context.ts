import { contentModelSchema, type ContentModel, type SourceRef } from "./schema";
import { storylineBlueprintSchema, type StorylineBlueprint } from "./storyline";

export type CompactEvidence = {
  key: string;
  sourceId: string;
  excerptId: string;
  locator: string;
  text: string;
};

export type StorylinePlanningContext = {
  version: 1;
  title: string;
  narrativeThesis: string;
  audienceDecision: string;
  evidence: CompactEvidence[];
  slides: Array<{
    id: string;
    storyBeat: StorylineBlueprint["slides"][number]["storyBeat"];
    assertion: string;
    implication: string;
    decisionImpact: string;
    visualStrategy: StorylineBlueprint["slides"][number]["visualStrategy"];
    evidenceKeys: string[];
  }>;
};

function refKey(ref: SourceRef): string {
  return `${ref.sourceId}:${ref.excerptId}`;
}

function evidenceIndex(contentModel: ContentModel): Map<string, CompactEvidence> {
  const index = new Map<string, CompactEvidence>();
  for (const source of contentModel.sources) {
    for (const excerpt of source.excerpts) {
      const key = `${source.sourceId}:${excerpt.id}`;
      index.set(key, {
        key,
        sourceId: source.sourceId,
        excerptId: excerpt.id,
        locator: excerpt.locator,
        text: excerpt.text,
      });
    }
  }
  return index;
}

/**
 * Builds the host-facing planning context without replaying the full ContentModel.
 *
 * Evidence text is emitted once, keyed by source/excerpt, even when several slides reuse it.
 * Speaker notes are deliberately omitted: they are presentation-time content and should not be
 * paid for again while authoring DeckPlan structure. Callers can request a slide-local context for
 * authoring instead of sending the entire storyline to every worker.
 */
export function buildStorylinePlanningContext(
  storylineInput: unknown,
  contentModelInput: unknown,
  slideIds?: string[],
): StorylinePlanningContext {
  const storyline = storylineBlueprintSchema.parse(storylineInput);
  const contentModel = contentModelSchema.parse(contentModelInput);
  const wanted = slideIds ? new Set(slideIds) : undefined;
  if (wanted) {
    const known = new Set(storyline.slides.map((slide) => slide.id));
    const unknown = [...wanted].filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`Unknown storyline slide id(s): ${unknown.join(", ")}.`);
  }

  const slides = storyline.slides.filter((slide) => !wanted || wanted.has(slide.id));
  const index = evidenceIndex(contentModel);
  const evidence = new Map<string, CompactEvidence>();
  for (const slide of slides) {
    for (const ref of slide.evidenceRefs) {
      const key = refKey(ref);
      const resolved = index.get(key);
      if (!resolved) throw new Error(`Storyline evidence '${key}' is absent from the ContentModel.`);
      if (!evidence.has(key)) evidence.set(key, resolved);
    }
  }

  return {
    version: 1,
    title: storyline.title,
    narrativeThesis: storyline.narrativeThesis,
    audienceDecision: storyline.audienceDecision,
    evidence: [...evidence.values()],
    slides: slides.map((slide) => ({
      id: slide.id,
      storyBeat: slide.storyBeat,
      assertion: slide.assertion,
      implication: slide.implication,
      decisionImpact: slide.decisionImpact,
      visualStrategy: slide.visualStrategy,
      evidenceKeys: slide.evidenceRefs.map(refKey),
    })),
  };
}

export function buildSlideAuthoringContext(
  storylineInput: unknown,
  contentModelInput: unknown,
  slideId: string,
): StorylinePlanningContext {
  return buildStorylinePlanningContext(storylineInput, contentModelInput, [slideId]);
}

export function planningContextBytes(context: StorylinePlanningContext): number {
  return Buffer.byteLength(JSON.stringify(context), "utf8");
}
