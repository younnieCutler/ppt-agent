import { z } from "zod";
import type { TemplateConstraintProfile } from "./brand-constraints";
import { generativeSceneIntentSchema, type GenerativeSceneIntent } from "./generative-scene";
import { sha256 } from "./provenance";
import { slideSchema, type SlideSpec } from "./schema";
import type { ComponentKind, TemplateComponentsArtifact } from "./template-components";
import type { TemplateSemanticsProfile } from "./template-semantics";

export const GENERATIVE_AUTHORING_VERSION = 1 as const;

type TextNodeRole = "headline" | "body" | "label" | "metric" | "item" | "step" | "evidence" | "action";
type ContentAtom = {
  id: string;
  text: string;
  roleHint: TextNodeRole;
  importance: "primary" | "supporting";
  group?: string;
};
type AuthoringRelationship = { kind: "sequence" | "edge"; fromGroup: string; toGroup: string; labelRef?: string };
type ReferenceSlideSummary = {
  slideId: string;
  usage: "structural_template" | "reference_only";
  semanticRoles: string[];
  componentKinds: Partial<Record<ComponentKind, number>>;
  repeatPatterns: string[];
};

type AuthoringSlide = {
  id: string;
  semanticIntent: GenerativeSceneIntent["semanticIntent"];
  storyBeat: SlideSpec["storyBeat"];
  layout: SlideSpec["layout"];
  headline: string;
  headlineAlignment: SlideSpec["headlineAlignment"];
  compositionHint: string;
  contentAtoms: ContentAtom[];
  relationships: AuthoringRelationship[];
};

export type GenerativeAuthoringRequest = {
  version: 1;
  requestDigest: string;
  sourceDigest: string;
  elementsDigest: string;
  instructions: {
    compositionAuthority: "model_authored";
    coordinateSpace: "normalized_content_region_0_1";
    sourceSlideGeometry: "reference_only";
    preserveAllContentAtoms: true;
    forbidInventedText: true;
    chrome: "immutable";
    colors: "template_only";
    fonts: "template_only";
  };
  brand: {
    contentRegionId: string;
    allowedFonts: string[];
    allowedColors: string[];
    allowedTextStyleRoles: string[];
    allowedComponentKinds: ComponentKind[];
    blockedRegions: Array<{ role: string; frame: { x: number; y: number; w: number; h: number } }>;
  };
  references: ReferenceSlideSummary[];
  slides: AuthoringSlide[];
};

export type GenerativeAuthoringInput = {
  slides: SlideSpec[];
  exactSlideIds?: Iterable<string>;
  brandProfile: TemplateConstraintProfile;
  semantics: TemplateSemanticsProfile;
  components: TemplateComponentsArtifact;
};

const semanticIntentByLayout: Record<SlideSpec["layout"], GenerativeSceneIntent["semanticIntent"]> = {
  title: "cover",
  statement: "statement",
  comparison: "comparison",
  process: "process",
  pipeline: "architecture",
  architecture: "architecture",
  quantitative: "quantitative",
  timeline: "timeline",
  evidence: "evidence",
  chart: "quantitative",
};

const reusableComponentKinds = new Set<ComponentKind>([
  "title_block", "subtitle_block", "body_block", "label", "metric", "surface", "card", "divider", "key_message", "list_item",
]);

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function atom(id: string, text: string, roleHint: TextNodeRole, importance: ContentAtom["importance"], group?: string): ContentAtom {
  const normalized = normalizedText(text);
  if (!normalized) throw new Error(`GENERATIVE_AUTHORING_CONTENT_EMPTY: '${id}' has no renderable text.`);
  return { id, text: normalized, roleHint, importance, ...(group ? { group } : {}) };
}

function slideAtoms(slide: SlideSpec): { atoms: ContentAtom[]; relationships: AuthoringRelationship[] } {
  if (slide.layout === "chart") throw new Error(`GENERATIVE_AUTHORING_CHART_UNSUPPORTED: slide '${slide.id}' requires a native chart primitive that Generative Scene v2 does not expose.`);
  if (slide.layout === "title" && slide.content.imagePath) throw new Error(`GENERATIVE_AUTHORING_MEDIA_UNSUPPORTED: title slide '${slide.id}' contains imagePath but Generative Scene v2 has no media node.`);
  if (slide.layout === "evidence" && slide.content.assetPath) throw new Error(`GENERATIVE_AUTHORING_MEDIA_UNSUPPORTED: evidence slide '${slide.id}' contains assetPath but Generative Scene v2 has no media node.`);

  const atoms: ContentAtom[] = [atom(`${slide.id}.headline`, slide.headline, "headline", "primary", "headline")];
  const relationships: AuthoringRelationship[] = [];
  const add = (suffix: string, text: string | undefined, role: TextNodeRole, importance: ContentAtom["importance"] = "supporting", group?: string): string | undefined => {
    if (!text || !normalizedText(text)) return undefined;
    const id = `${slide.id}.${suffix}`;
    atoms.push(atom(id, text, role, importance, group));
    return id;
  };

  switch (slide.layout) {
    case "title":
      add("kicker", slide.content.kicker, "label", "supporting", "title");
      add("subtitle", slide.content.subtitle, "body", "supporting", "title");
      break;
    case "statement":
      add("body", slide.content.body, "body", "primary", "statement");
      slide.content.proofs.forEach((proof, index) => add(`proof.${index + 1}`, proof, "evidence", "supporting", "proofs"));
      break;
    case "comparison": {
      add("left.label", slide.content.left.label, "label", "primary", "comparison.left");
      slide.content.left.items.forEach((item, index) => add(`left.item.${index + 1}`, item, "item", "supporting", "comparison.left"));
      add("right.label", slide.content.right.label, "label", "primary", "comparison.right");
      slide.content.right.items.forEach((item, index) => add(`right.item.${index + 1}`, item, "item", "supporting", "comparison.right"));
      add("delta", slide.content.delta, "evidence", "supporting", "comparison.delta");
      break;
    }
    case "process":
      slide.content.steps.forEach((step, index) => {
        const group = `process.${step.id}`;
        add(`step.${step.id}.label`, step.label, "step", "primary", group);
        add(`step.${step.id}.detail`, step.detail, "body", "supporting", group);
        step.members?.forEach((member, memberIndex) => add(`step.${step.id}.member.${memberIndex + 1}`, member, "item", "supporting", group));
        if (index > 0) relationships.push({ kind: "sequence", fromGroup: `process.${slide.content.steps[index - 1].id}`, toGroup: group });
      });
      break;
    case "pipeline":
      slide.content.lanes.forEach((lane) => add(`lane.${lane.id}`, lane.label, "label", "supporting", `lane.${lane.id}`));
      slide.content.nodes.forEach((node) => {
        const group = `node.${node.id}`;
        add(`node.${node.id}.label`, node.label, "step", "primary", group);
        add(`node.${node.id}.detail`, node.detail, "body", "supporting", group);
      });
      slide.content.edges.forEach((edge, index) => {
        const labelRef = add(`edge.${index + 1}.label`, edge.label, "label", "supporting", `edge.${edge.from}.${edge.to}`);
        relationships.push({ kind: "edge", fromGroup: `node.${edge.from}`, toGroup: `node.${edge.to}`, ...(labelRef ? { labelRef } : {}) });
      });
      break;
    case "architecture":
      slide.content.zones.forEach((zone) => {
        const group = `zone.${zone.id}`;
        add(`zone.${zone.id}.label`, zone.label, "label", "primary", group);
        add(`zone.${zone.id}.description`, zone.description, "body", "supporting", group);
        zone.nodes.forEach((node, index) => add(`zone.${zone.id}.node.${index + 1}`, node, "item", "supporting", group));
      });
      slide.content.edges.forEach((edge, index) => {
        const labelRef = add(`edge.${index + 1}.label`, edge.label, "label", "supporting", `edge.${edge.from}.${edge.to}`);
        const fromZone = edge.from.split(":")[0];
        const toZone = edge.to.split(":")[0];
        relationships.push({ kind: "edge", fromGroup: `zone.${fromZone}`, toGroup: `zone.${toZone}`, ...(labelRef ? { labelRef } : {}) });
      });
      break;
    case "quantitative":
      slide.content.metrics.forEach((metric, index) => {
        const group = `metric.${index + 1}`;
        add(`metric.${index + 1}.value`, String(metric.value), "metric", "primary", group);
        add(`metric.${index + 1}.unit`, metric.unit, "label", "supporting", group);
        add(`metric.${index + 1}.label`, metric.label, "label", "primary", group);
        add(`metric.${index + 1}.period`, metric.period, "label", "supporting", group);
        add(`metric.${index + 1}.comparison`, metric.comparisonBasis, "evidence", "supporting", group);
        add(`metric.${index + 1}.note`, metric.note, "body", "supporting", group);
      });
      break;
    case "timeline":
      slide.content.milestones.forEach((milestone, index) => {
        const group = `milestone.${index + 1}`;
        add(`milestone.${index + 1}.date`, milestone.date, "label", "primary", group);
        add(`milestone.${index + 1}.label`, milestone.label, "step", "primary", group);
        add(`milestone.${index + 1}.detail`, milestone.detail, "body", "supporting", group);
        if (index > 0) relationships.push({ kind: "sequence", fromGroup: `milestone.${index}`, toGroup: group });
      });
      break;
    case "evidence":
      add("caption", slide.content.caption, "body", "supporting", "evidence");
      slide.content.bullets.forEach((bullet, index) => add(`bullet.${index + 1}`, bullet, "evidence", "primary", "evidence"));
      break;
  }
  return { atoms, relationships };
}

function normalizedBlockedRegions(profile: TemplateConstraintProfile): GenerativeAuthoringRequest["brand"]["blockedRegions"] {
  const region = profile.contentRegions.find((candidate) => candidate.id === "content-main");
  if (!region) throw new Error("GENERATIVE_AUTHORING_CONTENT_REGION_MISSING: brand profile requires 'content-main'.");
  const frame = region.bounds;
  const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
  return profile.immutableRegions.filter((item) => item.reserveSpace).flatMap((item) => {
    const x1 = Math.max(frame.x, item.bounds.x);
    const y1 = Math.max(frame.y, item.bounds.y);
    const x2 = Math.min(frame.x + frame.w, item.bounds.x + item.bounds.w);
    const y2 = Math.min(frame.y + frame.h, item.bounds.y + item.bounds.h);
    if (x2 <= x1 || y2 <= y1) return [];
    return [{
      role: item.role,
      frame: { x: round((x1 - frame.x) / frame.w), y: round((y1 - frame.y) / frame.h), w: round((x2 - x1) / frame.w), h: round((y2 - y1) / frame.h) },
    }];
  });
}

function referenceSummaries(semantics: TemplateSemanticsProfile, components: TemplateComponentsArtifact): ReferenceSlideSummary[] {
  return semantics.slides.map((slide) => {
    const usable = components.components.filter((component) => component.sourceSlideId === slide.slideId && !component.offCanvasHelper && !component.grouped && reusableComponentKinds.has(component.kind));
    const componentKinds: Partial<Record<ComponentKind, number>> = {};
    const semanticRoles = new Set<string>();
    usable.forEach((component) => {
      componentKinds[component.kind] = (componentKinds[component.kind] ?? 0) + 1;
      component.semanticRoles.forEach((role) => semanticRoles.add(role));
    });
    const repeatPatterns = [...new Set(components.repeatGroups.filter((group) => group.sourceSlideId === slide.slideId).map((group) => group.pattern))].sort();
    return { slideId: slide.slideId, usage: slide.usage, semanticRoles: [...semanticRoles].sort(), componentKinds, repeatPatterns };
  });
}

function verifyProvenance(input: GenerativeAuthoringInput): void {
  const { brandProfile, semantics, components } = input;
  if (brandProfile.sourceDigest !== semantics.sourceDigest || brandProfile.sourceDigest !== components.sourceDigest
    || brandProfile.elementsDigest !== semantics.elementsDigest || brandProfile.elementsDigest !== components.elementsDigest) {
    throw new Error("GENERATIVE_AUTHORING_PROVENANCE_MISMATCH: brand, semantics and component artifacts must describe the same raw template extraction.");
  }
}

function digestPayload(request: Omit<GenerativeAuthoringRequest, "requestDigest">): string {
  return sha256(JSON.stringify(request));
}

export function buildGenerativeAuthoringRequest(input: GenerativeAuthoringInput): GenerativeAuthoringRequest {
  verifyProvenance(input);
  const slides = input.slides.map((slide) => slideSchema.parse(slide) as SlideSpec);
  const slideIds = new Set(slides.map((slide) => slide.id));
  if (slideIds.size !== slides.length) throw new Error("GENERATIVE_AUTHORING_DUPLICATE_SLIDE_ID: slide ids must be unique.");
  const exactIds = new Set(input.exactSlideIds ?? []);
  const unknownExact = [...exactIds].filter((id) => !slideIds.has(id));
  if (unknownExact.length > 0) throw new Error(`GENERATIVE_AUTHORING_UNKNOWN_EXACT_SLIDE: ${unknownExact.join(", ")}`);
  const targetSlides = slides.filter((slide) => !exactIds.has(slide.id)).map((slide): AuthoringSlide => {
    const { atoms, relationships } = slideAtoms(slide);
    return {
      id: slide.id,
      semanticIntent: semanticIntentByLayout[slide.layout],
      storyBeat: slide.storyBeat,
      layout: slide.layout,
      headline: normalizedText(slide.headline),
      headlineAlignment: slide.headlineAlignment,
      compositionHint: slide.composition,
      contentAtoms: atoms,
      relationships,
    };
  });
  if (targetSlides.length === 0) throw new Error("GENERATIVE_AUTHORING_NO_TARGETS: every slide is exact; no Generative Scene authoring is required.");

  const allowedKinds = [...new Set(input.components.components
    .filter((component) => !component.offCanvasHelper && !component.grouped && reusableComponentKinds.has(component.kind))
    .map((component) => component.kind))].sort() as ComponentKind[];
  const allowedColors = [...new Set([
    ...input.brandProfile.styleVocabulary.textColors,
    ...input.brandProfile.styleVocabulary.fillColors,
    ...input.brandProfile.styleVocabulary.strokeColors,
    ...input.brandProfile.styleVocabulary.backgroundColors,
  ])].sort();

  const payload: Omit<GenerativeAuthoringRequest, "requestDigest"> = {
    version: GENERATIVE_AUTHORING_VERSION,
    sourceDigest: input.brandProfile.sourceDigest,
    elementsDigest: input.brandProfile.elementsDigest,
    instructions: {
      compositionAuthority: "model_authored",
      coordinateSpace: "normalized_content_region_0_1",
      sourceSlideGeometry: "reference_only",
      preserveAllContentAtoms: true,
      forbidInventedText: true,
      chrome: "immutable",
      colors: "template_only",
      fonts: "template_only",
    },
    brand: {
      contentRegionId: "content-main",
      allowedFonts: [...input.brandProfile.styleVocabulary.fonts].sort(),
      allowedColors,
      allowedTextStyleRoles: [...input.brandProfile.styleVocabulary.textRoles].sort(),
      allowedComponentKinds: allowedKinds,
      blockedRegions: normalizedBlockedRegions(input.brandProfile),
    },
    references: referenceSummaries(input.semantics, input.components),
    slides: targetSlides,
  };
  return { ...payload, requestDigest: digestPayload(payload) };
}

const bindingSchema = z.object({ nodeId: z.string().min(1), contentRef: z.string().min(1) }).strict();
const authoredSceneSchema = z.object({ scene: generativeSceneIntentSchema, bindings: z.array(bindingSchema) }).strict();
const responseSchema = z.object({
  version: z.literal(GENERATIVE_AUTHORING_VERSION),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  scenes: z.array(authoredSceneSchema),
}).strict();

export type GenerativeAuthoringResponse = z.infer<typeof responseSchema>;

export function parseGenerativeAuthoringResponse(request: GenerativeAuthoringRequest, responseInput: unknown): Map<string, GenerativeSceneIntent> {
  const response = responseSchema.parse(responseInput);
  if (response.requestDigest !== request.requestDigest || response.sourceDigest !== request.sourceDigest) {
    throw new Error("GENERATIVE_AUTHORING_RESPONSE_STALE: response does not belong to the current authoring request/template.");
  }
  const expected = new Map(request.slides.map((slide) => [slide.id, slide]));
  const receivedIds = response.scenes.map((entry) => entry.scene.slideId);
  if (new Set(receivedIds).size !== receivedIds.length) throw new Error("GENERATIVE_AUTHORING_DUPLICATE_SCENE: each target slide must be authored exactly once.");
  const unexpected = receivedIds.filter((id) => !expected.has(id));
  const missing = [...expected.keys()].filter((id) => !receivedIds.includes(id));
  if (unexpected.length > 0 || missing.length > 0) throw new Error(`GENERATIVE_AUTHORING_SCENE_SET_MISMATCH: unexpected=[${unexpected.join(",")}] missing=[${missing.join(",")}].`);

  const result = new Map<string, GenerativeSceneIntent>();
  for (const entry of response.scenes) {
    const scene = generativeSceneIntentSchema.parse(entry.scene);
    const slide = expected.get(scene.slideId)!;
    if (scene.semanticIntent !== slide.semanticIntent || normalizedText(scene.headline) !== slide.headline) {
      throw new Error(`GENERATIVE_AUTHORING_SCENE_DRIFT: Scene '${scene.slideId}' changed semantic intent or headline.`);
    }
    if (scene.contentRegionId !== request.brand.contentRegionId || scene.constraints.chrome !== "immutable" || scene.constraints.colors !== "template_only" || scene.constraints.fonts !== "template_only") {
      throw new Error(`GENERATIVE_AUTHORING_CONSTRAINT_DRIFT: Scene '${scene.slideId}' weakened the corporate template constraints.`);
    }
    const atoms = new Map(slide.contentAtoms.map((item) => [item.id, item]));
    const textNodes = scene.layout.nodes.filter((node) => node.role !== "surface" && node.role !== "divider");
    const textNodeIds = new Set(textNodes.map((node) => node.id));
    if (entry.bindings.some((binding) => !textNodeIds.has(binding.nodeId))) throw new Error(`GENERATIVE_AUTHORING_BINDING_INVALID: Scene '${scene.slideId}' binds an unknown or structural node.`);
    if (new Set(entry.bindings.map((binding) => binding.nodeId)).size !== entry.bindings.length) throw new Error(`GENERATIVE_AUTHORING_NODE_BOUND_TWICE: Scene '${scene.slideId}' has duplicate node bindings.`);
    if (new Set(entry.bindings.map((binding) => binding.contentRef)).size !== entry.bindings.length) throw new Error(`GENERATIVE_AUTHORING_CONTENT_REUSED: Scene '${scene.slideId}' reuses a content atom.`);
    if (entry.bindings.length !== textNodes.length) throw new Error(`GENERATIVE_AUTHORING_UNGROUNDED_TEXT: every text node in Scene '${scene.slideId}' must bind exactly one content atom.`);
    const bindingByNode = new Map(entry.bindings.map((binding) => [binding.nodeId, binding.contentRef]));
    const delivered = new Set<string>();
    for (const node of textNodes) {
      const contentRef = bindingByNode.get(node.id);
      const content = contentRef ? atoms.get(contentRef) : undefined;
      if (!content) throw new Error(`GENERATIVE_AUTHORING_CONTENT_REF_UNKNOWN: Scene '${scene.slideId}' node '${node.id}' references unplanned content.`);
      if (normalizedText(node.text ?? "") !== content.text) throw new Error(`GENERATIVE_AUTHORING_TEXT_DRIFT: Scene '${scene.slideId}' node '${node.id}' changed content '${content.id}'.`);
      delivered.add(content.id);
    }
    const dropped = [...atoms.keys()].filter((id) => !delivered.has(id));
    if (dropped.length > 0) throw new Error(`GENERATIVE_AUTHORING_CONTENT_DROPPED: Scene '${scene.slideId}' omitted ${dropped.join(", ")}.`);
    result.set(scene.slideId, scene);
  }
  return result;
}
