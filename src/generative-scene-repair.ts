import { z } from "zod";
import type { TemplateConstraintProfile } from "./brand-constraints";
import { generativeSceneIntentSchema, resolveGenerativeScene, type GenerativeSceneIntent } from "./generative-scene";
import type { GenerativeVisualCriticRequest, GenerativeVisualCriticResponse } from "./generative-visual-critic";
import { sha256 } from "./provenance";
import { componentKinds } from "./template-components";
import { semanticRoles } from "./template-analysis";

export const GENERATIVE_SCENE_REPAIR_VERSION = 1 as const;
export const MAX_GENERATIVE_REPAIR_ROUNDS = 2 as const;

const normalizedFrameSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
}).strict().superRefine((frame, context) => {
  if (frame.x + frame.w > 1 + 1e-9) context.addIssue({ code: z.ZodIssueCode.custom, path: ["w"], message: "Repair frame exceeds normalized width." });
  if (frame.y + frame.h > 1 + 1e-9) context.addIssue({ code: z.ZodIssueCode.custom, path: ["h"], message: "Repair frame exceeds normalized height." });
});

const setFrameSchema = z.object({ op: z.literal("set_frame"), nodeId: z.string().min(1), frame: normalizedFrameSchema }).strict();
const setEmphasisSchema = z.object({ op: z.literal("set_emphasis"), nodeId: z.string().min(1), emphasis: z.number().min(0).max(1) }).strict();
const setGroupSchema = z.object({ op: z.literal("set_group"), nodeId: z.string().min(1), group: z.string().min(1).nullable() }).strict();
const setStyleRoleSchema = z.object({ op: z.literal("set_style_role"), nodeId: z.string().min(1), styleRole: z.enum(semanticRoles) }).strict();
const setComponentPreferenceSchema = z.object({ op: z.literal("set_component_preference"), nodeId: z.string().min(1), componentPreference: z.enum(componentKinds).nullable() }).strict();
const addStructureSchema = z.object({
  op: z.literal("add_structure"),
  node: z.object({
    id: z.string().min(1),
    role: z.enum(["surface", "divider"]),
    frame: normalizedFrameSchema,
    emphasis: z.number().min(0).max(1).default(0.5),
    group: z.string().min(1).optional(),
    componentPreference: z.enum(componentKinds).optional(),
  }).strict(),
}).strict();
const removeStructureSchema = z.object({ op: z.literal("remove_structure"), nodeId: z.string().min(1) }).strict();

export const generativeSceneRepairOperationSchema = z.discriminatedUnion("op", [
  setFrameSchema,
  setEmphasisSchema,
  setGroupSchema,
  setStyleRoleSchema,
  setComponentPreferenceSchema,
  addStructureSchema,
  removeStructureSchema,
]);

export type GenerativeSceneRepairOperation = z.infer<typeof generativeSceneRepairOperationSchema>;

export type GenerativeSceneRepairRequest = {
  version: 1;
  requestDigest: string;
  sourceDigest: string;
  criticRequestDigest: string;
  round: 1 | 2;
  slideId: string;
  constraints: {
    preserveAllText: true;
    preserveTextNodeIds: true;
    preserveSemanticIntent: true;
    preserveHeadline: true;
    chrome: "immutable";
    colors: "template_only";
    fonts: "template_only";
    allowedOperations: readonly GenerativeSceneRepairOperation["op"][];
  };
  findings: Array<{ code: string; message: string; nodeIds: string[] }>;
  deckFindings: Array<{
    code: "LAYOUT_REPETITION" | "INCONSISTENT_SECTION_RHYTHM";
    message: string;
    slideIds: string[];
  }>;
  scores: Record<string, number>;
  scene: GenerativeSceneIntent;
};

function requestDigest(payload: Omit<GenerativeSceneRepairRequest, "requestDigest">): string {
  return sha256(JSON.stringify(payload));
}

export function buildGenerativeSceneRepairRequest(
  criticRequest: GenerativeVisualCriticRequest,
  criticResponse: GenerativeVisualCriticResponse,
  slideId: string,
): GenerativeSceneRepairRequest {
  if (criticRequest.round >= MAX_GENERATIVE_REPAIR_ROUNDS) throw new Error(`GENERATIVE_REPAIR_BUDGET_EXHAUSTED: round ${criticRequest.round} cannot request another repair.`);
  const requestSlide = criticRequest.slides.find((slide) => slide.slideId === slideId);
  const judgment = criticResponse.slides.find((slide) => slide.slideId === slideId);
  if (!requestSlide || !judgment) throw new Error(`GENERATIVE_REPAIR_SLIDE_MISSING: '${slideId}' is absent from the critic request/response pair.`);
  if (criticResponse.requestDigest !== criticRequest.requestDigest || criticResponse.renderDigest !== criticRequest.renderDigest) {
    throw new Error("GENERATIVE_REPAIR_CRITIC_STALE: critic response does not belong to the supplied critic request.");
  }
  const payload: Omit<GenerativeSceneRepairRequest, "requestDigest"> = {
    version: GENERATIVE_SCENE_REPAIR_VERSION,
    sourceDigest: criticRequest.sourceDigest,
    criticRequestDigest: criticRequest.requestDigest,
    round: (criticRequest.round + 1) as 1 | 2,
    slideId,
    constraints: {
      preserveAllText: true,
      preserveTextNodeIds: true,
      preserveSemanticIntent: true,
      preserveHeadline: true,
      chrome: "immutable",
      colors: "template_only",
      fonts: "template_only",
      allowedOperations: ["set_frame", "set_emphasis", "set_group", "set_style_role", "set_component_preference", "add_structure", "remove_structure"],
    },
    findings: judgment.findings.filter((finding) => finding.repairable).map((finding) => ({ code: finding.code, message: finding.message, nodeIds: [...finding.nodeIds] })),
    deckFindings: criticResponse.deckFindings
      .filter((finding) => finding.slideIds.includes(slideId))
      .map((finding) => ({ code: finding.code, message: finding.message, slideIds: [...finding.slideIds] })),
    scores: { ...judgment.scores },
    scene: requestSlide.scene,
  };
  return { ...payload, requestDigest: requestDigest(payload) };
}

const responseSchema = z.object({
  version: z.literal(GENERATIVE_SCENE_REPAIR_VERSION),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  slideId: z.string().regex(/^S\d{2,}$/),
  operations: z.array(generativeSceneRepairOperationSchema).min(1).max(32),
  rationale: z.string().min(1),
}).strict();

export type GenerativeSceneRepairResponse = z.infer<typeof responseSchema>;

function normalizedText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function textSignature(scene: GenerativeSceneIntent): string {
  return JSON.stringify(scene.layout.nodes
    .filter((node) => node.role !== "surface" && node.role !== "divider")
    .map((node) => ({ id: node.id, role: node.role, text: normalizedText(node.text) }))
    .sort((a, b) => a.id.localeCompare(b.id)));
}

function applyOperation(scene: GenerativeSceneIntent, operation: GenerativeSceneRepairOperation): GenerativeSceneIntent {
  const nodes = scene.layout.nodes.map((node) => ({ ...node, frame: { ...node.frame } }));
  const index = "nodeId" in operation ? nodes.findIndex((node) => node.id === operation.nodeId) : -1;
  if ("nodeId" in operation && index < 0) throw new Error(`GENERATIVE_REPAIR_NODE_MISSING: '${operation.nodeId}'.`);

  switch (operation.op) {
    case "set_frame":
      nodes[index] = { ...nodes[index], frame: { ...operation.frame } };
      break;
    case "set_emphasis":
      nodes[index] = { ...nodes[index], emphasis: operation.emphasis };
      break;
    case "set_group": {
      const next = { ...nodes[index] } as Record<string, unknown>;
      if (operation.group === null) delete next.group;
      else next.group = operation.group;
      nodes[index] = next as (typeof nodes)[number];
      break;
    }
    case "set_style_role":
      if (nodes[index].role === "surface" || nodes[index].role === "divider") throw new Error(`GENERATIVE_REPAIR_TEXT_ONLY_OPERATION: '${operation.nodeId}' is structural.`);
      nodes[index] = { ...nodes[index], styleRole: operation.styleRole };
      break;
    case "set_component_preference": {
      const next = { ...nodes[index] } as Record<string, unknown>;
      if (operation.componentPreference === null) delete next.componentPreference;
      else next.componentPreference = operation.componentPreference;
      nodes[index] = next as (typeof nodes)[number];
      break;
    }
    case "add_structure":
      if (nodes.some((node) => node.id === operation.node.id)) throw new Error(`GENERATIVE_REPAIR_NODE_DUPLICATE: '${operation.node.id}'.`);
      nodes.push({ ...operation.node } as (typeof nodes)[number]);
      break;
    case "remove_structure":
      if (nodes[index].role !== "surface" && nodes[index].role !== "divider") throw new Error(`GENERATIVE_REPAIR_TEXT_NODE_REMOVAL_FORBIDDEN: '${operation.nodeId}'.`);
      nodes.splice(index, 1);
      break;
  }

  return generativeSceneIntentSchema.parse({ ...scene, layout: { ...scene.layout, nodes } });
}

export function applyGenerativeSceneRepair(
  request: GenerativeSceneRepairRequest,
  responseInput: unknown,
  brandProfile: TemplateConstraintProfile,
): GenerativeSceneIntent {
  const response = responseSchema.parse(responseInput);
  if (response.requestDigest !== request.requestDigest || response.sourceDigest !== request.sourceDigest || response.slideId !== request.slideId) {
    throw new Error("GENERATIVE_REPAIR_RESPONSE_STALE: patch does not belong to the current repair request/template/slide.");
  }
  if (request.round < 1 || request.round > MAX_GENERATIVE_REPAIR_ROUNDS) throw new Error("GENERATIVE_REPAIR_ROUND_INVALID: repair round must be 1 or 2.");

  const original = generativeSceneIntentSchema.parse(request.scene);
  const signature = textSignature(original);
  let repaired = original;
  for (const operation of response.operations) repaired = applyOperation(repaired, operation);

  if (repaired.slideId !== original.slideId || repaired.semanticIntent !== original.semanticIntent || normalizedText(repaired.headline) !== normalizedText(original.headline)) {
    throw new Error("GENERATIVE_REPAIR_SEMANTIC_DRIFT: patch changed slide identity, semantic intent or headline.");
  }
  if (textSignature(repaired) !== signature) throw new Error("GENERATIVE_REPAIR_CONTENT_DRIFT: patch changed, removed or added a text node.");
  if (repaired.constraints.chrome !== "immutable" || repaired.constraints.colors !== "template_only" || repaired.constraints.fonts !== "template_only") {
    throw new Error("GENERATIVE_REPAIR_CONSTRAINT_DRIFT: patch weakened corporate template constraints.");
  }

  // Re-run the deterministic brand/geometry gate after every patch. A critic may suggest a visually
  // plausible move, but only the runtime decides whether it is legal inside the real content canvas.
  resolveGenerativeScene(repaired, brandProfile);
  return repaired;
}

export type GenerativeSceneRepairState = {
  rounds: Record<string, number>;
  resolved: string[];
};

export function recordGenerativeSceneRepairRound(state: GenerativeSceneRepairState, slideId: string): GenerativeSceneRepairState {
  const current = state.rounds[slideId] ?? 0;
  if (current >= MAX_GENERATIVE_REPAIR_ROUNDS) throw new Error(`GENERATIVE_REPAIR_BUDGET_EXHAUSTED: slide '${slideId}' already used ${MAX_GENERATIVE_REPAIR_ROUNDS} repairs.`);
  return { ...state, rounds: { ...state.rounds, [slideId]: current + 1 } };
}
