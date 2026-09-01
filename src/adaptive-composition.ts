import { z } from "zod";
import { displayWidth } from "./typography";
import { assertTemplateCoordinateSpace } from "./template-analysis";
import { componentKinds, TEMPLATE_COMPONENTS_COMPILER_VERSION, type ComponentKind, type TemplateComponent, type TemplateComponentsArtifact } from "./template-components";
import { TEMPLATE_DESIGN_SYSTEM_COMPILER_VERSION, type TemplateDesignSystemArtifact } from "./template-design-system";

export const adaptiveCompositionFamilies = ["stack", "two_column", "metric_row", "repeated_cards"] as const;
export type AdaptiveCompositionFamily = (typeof adaptiveCompositionFamilies)[number];

const adaptiveBlockRoles = ["headline", "body", "support", "item", "metric"] as const;
const adaptiveEmphasis = ["primary", "secondary", "supporting"] as const;

const adaptiveBlockSchema = z.object({
  id: z.string().min(1),
  role: z.enum(adaptiveBlockRoles),
  text: z.string().min(1),
  priority: z.number().int().min(0).max(100).default(50),
  group: z.string().min(1).optional(),
  emphasis: z.enum(adaptiveEmphasis).default("supporting"),
}).strict();

export const adaptiveSlideIntentSchema = z.object({
  slideId: z.string().regex(/^S\d{2,}$/),
  family: z.enum(adaptiveCompositionFamilies),
  blocks: z.array(adaptiveBlockSchema).min(1).max(100),
  preferredComponentKind: z.enum(componentKinds).optional(),
}).strict().superRefine((intent, context) => {
  const ids = intent.blocks.map((block) => block.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["blocks"], message: "Adaptive content block ids must be unique." });
  if (intent.family === "metric_row" && !intent.blocks.some((block) => block.role === "metric")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["blocks"], message: "metric_row requires at least one metric block." });
  if (intent.family === "two_column" && intent.blocks.length < 2) context.addIssue({ code: z.ZodIssueCode.custom, path: ["blocks"], message: "two_column requires at least two content blocks." });
});

export type AdaptiveSlideIntent = z.infer<typeof adaptiveSlideIntentSchema>;
type Rect = { x: number; y: number; w: number; h: number };

export type AdaptivePlacement = Rect & { blockId: string; componentId: string; componentKind: ComponentKind; priority: number; emphasis: (typeof adaptiveEmphasis)[number]; order: number; resize: { horizontal: boolean; vertical: boolean } };
export type AdaptiveTextAllocation = { blockId: string; componentId: string; text: string; charCount: number; maxChars?: number; maxLines?: number; fits: "yes" | "no" | "unknown" };
export type AdaptiveSlidePlan = {
  version: 1;
  templateDigest: string;
  slideId: string;
  family: AdaptiveCompositionFamily;
  contentFrame: Rect;
  spacing: { gap: number; source: "spacing.rhythm" | "geometry.gutters" | "none" };
  rows: number;
  columns: number;
  placements: AdaptivePlacement[];
  textAllocation: AdaptiveTextAllocation[];
};

type PlanningInput = {
  templateDigest: string;
  intent: AdaptiveSlideIntent;
  designSystem: TemplateDesignSystemArtifact;
  components: TemplateComponentsArtifact;
};

const planningInputSchema = z.object({
  templateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  intent: adaptiveSlideIntentSchema,
  designSystem: z.unknown(),
  components: z.unknown(),
}).strict();

const familyKinds: Record<AdaptiveCompositionFamily, ComponentKind[]> = {
  stack: ["body_block", "key_message", "list_item", "label", "title_block"],
  two_column: ["card", "surface", "body_block", "key_message"],
  metric_row: ["metric"],
  repeated_cards: ["card", "surface", "list_item", "body_block"],
};

const roleKinds: Record<AdaptiveSlideIntent["blocks"][number]["role"], ComponentKind[]> = {
  headline: ["title_block", "key_message", "body_block"],
  body: ["body_block", "key_message", "label"],
  support: ["label", "body_block", "list_item"],
  item: ["card", "list_item", "body_block", "label"],
  metric: ["metric"],
};

function finiteRect(rect: Rect | undefined, canvas: { w: number; h: number }): Rect {
  if (!rect || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) || rect.x < 0 || rect.y < 0 || rect.w <= 0 || rect.h <= 0 || rect.x + rect.w > canvas.w || rect.y + rect.h > canvas.h) throw new Error("ADAPTIVE_COMPOSITION_INVALID: Design System contentFrame must be a positive rectangle inside the template canvas.");
  return rect;
}

function observedGap(designSystem: TemplateDesignSystemArtifact): AdaptiveSlidePlan["spacing"] {
  const rhythm = designSystem.spacing.rhythm.find((value) => Number.isFinite(value) && value > 0);
  if (rhythm !== undefined) return { gap: rhythm, source: "spacing.rhythm" };
  const gutter = designSystem.geometry.gutters.find((value) => Number.isFinite(value) && value > 0);
  if (gutter !== undefined) return { gap: gutter, source: "geometry.gutters" };
  return { gap: 0, source: "none" };
}

function usableComponents(components: TemplateComponentsArtifact): TemplateComponent[] {
  return components.components.filter((component) => !component.offCanvasHelper && !component.grouped && component.kind !== "unknown" && component.sourceBounds.w > 0 && component.sourceBounds.h > 0);
}

function rankedCandidates(block: AdaptiveSlideIntent["blocks"][number], family: AdaptiveCompositionFamily, preferred: ComponentKind | undefined, components: TemplateComponent[]): TemplateComponent[] {
  const familySet = new Set(familyKinds[family]);
  const kinds = preferred ? [preferred, ...roleKinds[block.role], ...familyKinds[family]] : [...roleKinds[block.role], ...familyKinds[family]];
  return components.filter((component) => kinds.includes(component.kind) && familySet.has(component.kind)).sort((left, right) => {
    const leftRank = kinds.indexOf(left.kind);
    const rightRank = kinds.indexOf(right.kind);
    return leftRank - rightRank || right.confidence - left.confidence || left.sourceBounds.y - right.sourceBounds.y || left.sourceBounds.x - right.sourceBounds.x || left.id.localeCompare(right.id);
  });
}

function chooseComponents(intent: AdaptiveSlideIntent, components: TemplateComponent[]): Map<string, TemplateComponent> {
  const chosen = new Map<string, TemplateComponent>();
  const usage = new Map<string, number>();
  for (const block of intent.blocks) {
    const candidates = rankedCandidates(block, intent.family, intent.preferredComponentKind, components);
    const component = candidates.find((candidate) => !usage.has(candidate.id)) ?? candidates.find((candidate) => candidate.repeatability.signal === "repeatable");
    if (!component) throw new Error(`ADAPTIVE_COMPOSITION_UNSUPPORTED: no template-native component capability for '${block.role}' in family '${intent.family}'.`);
    const count = usage.get(component.id) ?? 0;
    usage.set(component.id, count + 1);
    chosen.set(block.id, component);
  }
  return chosen;
}

function splitTwoColumns(blocks: AdaptiveSlideIntent["blocks"]): [AdaptiveSlideIntent["blocks"], AdaptiveSlideIntent["blocks"]] {
  const groups = new Map<string, AdaptiveSlideIntent["blocks"]>();
  blocks.forEach((block) => {
    if (!block.group) return;
    const members = groups.get(block.group) ?? [];
    members.push(block);
    groups.set(block.group, members);
  });
  if (groups.size === 0) return [blocks.slice(0, Math.ceil(blocks.length / 2)), blocks.slice(Math.ceil(blocks.length / 2))];
  const named = [...groups.values()];
  const left = [...(named.shift() ?? [])];
  const right = [...(named.shift() ?? [])];
  const weight = (items: AdaptiveSlideIntent["blocks"]) => items.reduce((sum, block) => sum + displayWidth(block.text) * (1 + block.priority / 100), 0);
  named.forEach((members) => (weight(left) <= weight(right) ? left : right).push(...members));
  const remaining = blocks.filter((block) => !block.group);
  while (remaining.length > 0) (left.length <= right.length ? left : right).push(remaining.shift()!);
  if (left.length === 0 || right.length === 0) throw new Error("ADAPTIVE_COMPOSITION_UNSUPPORTED: two_column requires content in both semantic groups.");
  return [left, right];
}

function cell(frame: Rect, gap: number, column: number, row: number, columns: number, rows: number, columnWidths?: number[]): Rect {
  const totalGapX = gap * Math.max(0, columns - 1);
  const totalGapY = gap * Math.max(0, rows - 1);
  const widths = columnWidths ?? Array.from({ length: columns }, () => (frame.w - totalGapX) / columns);
  const width = widths[column];
  const height = (frame.h - totalGapY) / rows;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("ADAPTIVE_COMPOSITION_UNSUPPORTED: observed spacing leaves no positive placement cell inside the content frame.");
  const x = frame.x + widths.slice(0, column).reduce((sum, value) => sum + value, 0) + gap * column;
  return { x, y: frame.y + (height + gap) * row, w: width, h: height };
}

function layoutOrder(blocks: AdaptiveSlideIntent["blocks"]): AdaptiveSlideIntent["blocks"] {
  const emphasisRank: Record<(typeof adaptiveEmphasis)[number], number> = { primary: 0, secondary: 1, supporting: 2 };
  return blocks.map((block, index) => ({ block, index })).sort((left, right) => emphasisRank[left.block.emphasis] - emphasisRank[right.block.emphasis] || right.block.priority - left.block.priority || left.index - right.index).map(({ block }) => block);
}

function placementsFor(intent: AdaptiveSlideIntent, frame: Rect, gap: number): { rows: number; columns: number; bounds: Map<string, Rect> } {
  const bounds = new Map<string, Rect>();
  if (intent.family === "stack") {
    const ordered = layoutOrder(intent.blocks);
    const rows = ordered.length;
    ordered.forEach((block, index) => bounds.set(block.id, cell(frame, gap, 0, index, 1, rows)));
    return { rows, columns: 1, bounds };
  }
  if (intent.family === "two_column") {
    const [left, right] = splitTwoColumns(intent.blocks);
    const weight = (items: AdaptiveSlideIntent["blocks"]) => items.reduce((sum, block) => sum + displayWidth(block.text) * (1 + block.priority / 100), 0);
    const total = weight(left) + weight(right);
    const available = frame.w - gap;
    const leftWidth = total > 0 ? available * weight(left) / total : available / 2;
    layoutOrder(left).forEach((block, index) => bounds.set(block.id, cell(frame, gap, 0, index, 1, left.length, [leftWidth])));
    layoutOrder(right).forEach((block, index) => bounds.set(block.id, cell({ ...frame, x: frame.x + leftWidth + gap, w: frame.w - leftWidth - gap }, gap, 0, index, 1, right.length)));
    return { rows: Math.max(left.length, right.length), columns: 2, bounds };
  }
  if (intent.family === "metric_row") {
    const columns = intent.blocks.length;
    intent.blocks.forEach((block, index) => bounds.set(block.id, cell(frame, gap, index, 0, columns, 1)));
    return { rows: 1, columns, bounds };
  }
  const ordered = layoutOrder(intent.blocks);
  const columns = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
  const rows = Math.ceil(ordered.length / columns);
  ordered.forEach((block, index) => bounds.set(block.id, cell(frame, gap, index % columns, Math.floor(index / columns), columns, rows)));
  return { rows, columns, bounds };
}

function textAllocation(block: AdaptiveSlideIntent["blocks"][number], placement: Rect, component: TemplateComponent, designSystem: TemplateDesignSystemArtifact): AdaptiveTextAllocation {
  const role = component.semanticRoles[0];
  const size = role ? designSystem.typography.roles[role]?.sizesPt?.values[0] : designSystem.typography.typeScale.values[0];
  const charCount = displayWidth(block.text);
  if (!size) return { blockId: block.id, componentId: component.id, text: block.text, charCount, fits: "unknown" };
  const columnsPerLine = Math.max(1, Math.floor(placement.w / ((size / 72) * 0.55)));
  const lineHeightRatio = role ? designSystem.typography.roles[role]?.lineHeightRatios?.values[0] : undefined;
  const maxLines = Math.max(1, Math.floor(placement.h / ((size / 72) * (lineHeightRatio ?? 1.2))));
  const maxChars = columnsPerLine * maxLines;
  return { blockId: block.id, componentId: component.id, text: block.text, charCount, maxChars, maxLines, fits: charCount <= maxChars ? "yes" : "no" };
}

export function planAdaptiveSlide(input: PlanningInput): AdaptiveSlidePlan {
  const parsed = planningInputSchema.parse(input);
  const { templateDigest, intent, designSystem, components } = parsed as unknown as PlanningInput;
  if (designSystem.sourceDigest !== templateDigest || components.sourceDigest !== templateDigest) throw new Error("ADAPTIVE_COMPOSITION_PROVENANCE_MISMATCH: Design System and component catalog must describe the requested template digest.");
  if (designSystem.compilerVersion !== TEMPLATE_DESIGN_SYSTEM_COMPILER_VERSION || components.compilerVersion !== TEMPLATE_COMPONENTS_COMPILER_VERSION || designSystem.elementsDigest !== components.elementsDigest || !/^[a-f0-9]{64}$/.test(components.sourceGeometryDigest)) throw new Error("ADAPTIVE_COMPOSITION_PROVENANCE_MISMATCH: Design System and component catalog artifacts are stale or compiled by different versions.");
  if (!designSystem.coordinateSpace || !components.coordinateSpace) throw new Error("ADAPTIVE_COMPOSITION_PROVENANCE_MISMATCH: canonical coordinate-space metadata is required for adaptive planning.");
  assertTemplateCoordinateSpace(designSystem.coordinateSpace, designSystem.canvas);
  assertTemplateCoordinateSpace(components.coordinateSpace, components.canvas);
  if (Math.abs(designSystem.canvas.w - components.canvas.w) > 2 / 914400 || Math.abs(designSystem.canvas.h - components.canvas.h) > 2 / 914400) throw new Error("ADAPTIVE_COMPOSITION_PROVENANCE_MISMATCH: Design System and component catalog canvases differ.");
  if (JSON.stringify(designSystem.coordinateSpace) !== JSON.stringify(components.coordinateSpace)) throw new Error("ADAPTIVE_COMPOSITION_PROVENANCE_MISMATCH: Design System and component catalog coordinate spaces differ.");
  const contentFrame = finiteRect(designSystem.geometry.contentFrame, designSystem.canvas);
  const spacing = observedGap(designSystem);
  const selected = chooseComponents(intent, usableComponents(components));
  const grid = placementsFor(intent, contentFrame, spacing.gap);
  const placements = intent.blocks.map((block, order) => {
    const component = selected.get(block.id)!;
    const bounds = grid.bounds.get(block.id)!;
    return { ...bounds, blockId: block.id, componentId: component.id, componentKind: component.kind, priority: block.priority, emphasis: block.emphasis, order, resize: { horizontal: component.resizeFeasibility.horizontal === "safe", vertical: component.resizeFeasibility.vertical === "safe" } };
  });
  if (placements.some((placement) => placement.x < contentFrame.x || placement.y < contentFrame.y || placement.x + placement.w > contentFrame.x + contentFrame.w || placement.y + placement.h > contentFrame.y + contentFrame.h)) throw new Error("ADAPTIVE_COMPOSITION_INVALID: calculated placement escaped the Design System contentFrame.");
  placements.forEach((placement) => {
    const component = selected.get(placement.blockId)!;
    const needsHorizontalResize = Math.abs(placement.w - component.sourceBounds.w) > 2 / 914400;
    const needsVerticalResize = Math.abs(placement.h - component.sourceBounds.h) > 2 / 914400;
    if ((needsHorizontalResize && component.resizeFeasibility.horizontal !== "safe") || (needsVerticalResize && component.resizeFeasibility.vertical !== "safe")) throw new Error(`ADAPTIVE_COMPOSITION_UNSUPPORTED: component '${component.id}' lacks a safe resize capability for its calculated placement.`);
  });
  return {
    version: 1,
    templateDigest,
    slideId: intent.slideId,
    family: intent.family,
    contentFrame,
    spacing,
    rows: grid.rows,
    columns: grid.columns,
    placements,
    textAllocation: intent.blocks.map((block) => textAllocation(block, grid.bounds.get(block.id)!, selected.get(block.id)!, designSystem)),
  };
}
