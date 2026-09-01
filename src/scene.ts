import { z } from "zod";
import type { TemplateDesignSystemArtifact } from "./template-design-system";

export const sceneKinds = [
  "hero",
  "statement",
  "split",
  "metric_strip",
  "card_grid",
  "sequence",
  "timeline",
  "evidence",
  "conclusion",
] as const;
export type SceneKind = (typeof sceneKinds)[number];

export const sceneNodeRoles = ["headline", "body", "label", "metric", "item", "step", "evidence", "action"] as const;
export type SceneNodeRole = (typeof sceneNodeRoles)[number];

const sceneEmphasis = ["primary", "secondary", "supporting"] as const;
const horizontalAlignments = ["start", "center", "end"] as const;
const verticalAlignments = ["start", "center", "end"] as const;

const sceneGridSchema = z.object({
  columns: z.literal(12).default(12),
  rows: z.literal(12).default(12),
}).strict();

const sceneZoneSchema = z.object({
  id: z.string().min(1),
  colStart: z.number().int().min(0).max(11),
  colSpan: z.number().int().min(1).max(12),
  rowStart: z.number().int().min(0).max(11),
  rowSpan: z.number().int().min(1).max(12),
  align: z.enum(horizontalAlignments).default("start"),
  valign: z.enum(verticalAlignments).default("start"),
}).strict();

const sceneNodeSchema = z.object({
  id: z.string().min(1),
  role: z.enum(sceneNodeRoles),
  text: z.string().min(1),
  zoneId: z.string().min(1),
  order: z.number().int().min(0),
  emphasis: z.enum(sceneEmphasis).default("supporting"),
  group: z.string().min(1).optional(),
}).strict();

export const sceneIntentSchema = z.object({
  version: z.literal(1),
  slideId: z.string().regex(/^S\d{2,}$/),
  kind: z.enum(sceneKinds),
  headline: z.string().min(1),
  grid: sceneGridSchema.default({ columns: 12, rows: 12 }),
  zones: z.array(sceneZoneSchema).min(1).max(24),
  nodes: z.array(sceneNodeSchema).min(1).max(100),
}).strict().superRefine((scene, context) => {
  const zoneIds = scene.zones.map((zone) => zone.id);
  const nodeIds = scene.nodes.map((node) => node.id);
  if (new Set(zoneIds).size !== zoneIds.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["zones"], message: "Scene zone ids must be unique." });
  if (new Set(nodeIds).size !== nodeIds.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes"], message: "Scene node ids must be unique." });

  const knownZones = new Set(zoneIds);
  scene.zones.forEach((zone, index) => {
    if (zone.colStart + zone.colSpan > scene.grid.columns) context.addIssue({ code: z.ZodIssueCode.custom, path: ["zones", index], message: "Scene zone exceeds the semantic column grid." });
    if (zone.rowStart + zone.rowSpan > scene.grid.rows) context.addIssue({ code: z.ZodIssueCode.custom, path: ["zones", index], message: "Scene zone exceeds the semantic row grid." });
  });
  scene.nodes.forEach((node, index) => {
    if (!knownZones.has(node.zoneId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes", index, "zoneId"], message: `Unknown scene zone '${node.zoneId}'.` });
  });

  const metricNodes = scene.nodes.filter((node) => node.role === "metric");
  if (scene.kind === "metric_strip" && metricNodes.length < 2) context.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes"], message: "metric_strip requires at least two metric nodes." });
  if ((scene.kind === "sequence" || scene.kind === "timeline") && scene.nodes.filter((node) => node.role === "step" || node.role === "item").length < 2) context.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes"], message: `${scene.kind} requires at least two ordered nodes.` });
});

export type SceneIntent = z.infer<typeof sceneIntentSchema>;
export type SceneRect = { x: number; y: number; w: number; h: number };
export type ResolvedSceneZone = SceneIntent["zones"][number] & { bounds: SceneRect };
export type ResolvedScene = {
  version: 1;
  slideId: string;
  kind: SceneKind;
  frame: SceneRect;
  gap: { value: number; source: "spacing.rhythm" | "geometry.gutters" | "none" };
  zones: ResolvedSceneZone[];
  nodes: SceneIntent["nodes"];
};

export type SceneBlock = {
  id: string;
  role: SceneNodeRole;
  text: string;
  emphasis?: (typeof sceneEmphasis)[number];
  group?: string;
};

const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

function validFrame(designSystem: TemplateDesignSystemArtifact): SceneRect {
  const frame = designSystem.geometry.contentFrame;
  if (!frame || ![frame.x, frame.y, frame.w, frame.h].every(Number.isFinite) || frame.x < 0 || frame.y < 0 || frame.w <= 0 || frame.h <= 0 || frame.x + frame.w > designSystem.canvas.w || frame.y + frame.h > designSystem.canvas.h) {
    throw new Error("SCENE_GEOMETRY_UNSUPPORTED: template Design System does not expose a valid content frame.");
  }
  return frame;
}

export function selectMeaningfulSceneGap(designSystem: TemplateDesignSystemArtifact): ResolvedScene["gap"] {
  const minimum = Math.min(designSystem.canvas.w, designSystem.canvas.h) * 0.01;
  const select = (values: number[]): number | undefined => {
    const candidates = [...new Set(values.filter((value) => Number.isFinite(value) && value >= minimum).map(round))].sort((a, b) => a - b);
    if (candidates.length === 0) return undefined;
    return candidates[Math.floor((candidates.length - 1) / 2)];
  };
  const rhythm = select(designSystem.spacing.rhythm);
  if (rhythm !== undefined) return { value: rhythm, source: "spacing.rhythm" };
  const gutter = select(designSystem.geometry.gutters);
  if (gutter !== undefined) return { value: gutter, source: "geometry.gutters" };
  return { value: 0, source: "none" };
}

function fitSceneGap(frame: SceneRect, gap: number, columns: number, rows: number): number {
  if (!Number.isFinite(gap) || gap <= 0) return 0;
  // The Design System spacing vocabulary describes observed gaps between real template objects,
  // while the 12x12 Scene grid is only a semantic addressing system. A sparse template can
  // therefore expose a perfectly legitimate object gap that is too large to repeat eleven times
  // across every virtual grid track. Keep the observed value whenever it fits; otherwise clamp it
  // to the largest value that still leaves each semantic cell at least as large as the gutter.
  // For n tracks: (frame - gap*(n-1))/n >= gap  =>  gap <= frame/(2n-1).
  const horizontalLimit = frame.w / Math.max(1, 2 * columns - 1);
  const verticalLimit = frame.h / Math.max(1, 2 * rows - 1);
  const fitted = Math.min(gap, horizontalLimit, verticalLimit);
  if (!Number.isFinite(fitted) || fitted < 0) throw new Error("SCENE_GEOMETRY_UNSUPPORTED: template spacing cannot be fitted to the semantic grid.");
  return round(fitted);
}

function gridRect(frame: SceneRect, gap: number, zone: SceneIntent["zones"][number], columns: number, rows: number): SceneRect {
  const cellW = (frame.w - gap * Math.max(0, columns - 1)) / columns;
  const cellH = (frame.h - gap * Math.max(0, rows - 1)) / rows;
  if (!Number.isFinite(cellW) || !Number.isFinite(cellH) || cellW <= 0 || cellH <= 0) throw new Error("SCENE_GEOMETRY_UNSUPPORTED: template spacing leaves no usable semantic grid cell.");
  return {
    x: round(frame.x + zone.colStart * (cellW + gap)),
    y: round(frame.y + zone.rowStart * (cellH + gap)),
    w: round(zone.colSpan * cellW + Math.max(0, zone.colSpan - 1) * gap),
    h: round(zone.rowSpan * cellH + Math.max(0, zone.rowSpan - 1) * gap),
  };
}

export function resolveSceneGeometry(intent: SceneIntent, designSystem: TemplateDesignSystemArtifact): ResolvedScene {
  const parsed = sceneIntentSchema.parse(intent);
  const frame = validFrame(designSystem);
  const observedGap = selectMeaningfulSceneGap(designSystem);
  const gap = { ...observedGap, value: fitSceneGap(frame, observedGap.value, parsed.grid.columns, parsed.grid.rows) };
  const zones = parsed.zones.map((zone) => ({ ...zone, bounds: gridRect(frame, gap.value, zone, parsed.grid.columns, parsed.grid.rows) }));
  for (const zone of zones) {
    if (zone.bounds.x < frame.x - 1e-6 || zone.bounds.y < frame.y - 1e-6 || zone.bounds.x + zone.bounds.w > frame.x + frame.w + 1e-6 || zone.bounds.y + zone.bounds.h > frame.y + frame.h + 1e-6) {
      throw new Error(`SCENE_GEOMETRY_OVERFLOW: zone '${zone.id}' exceeds the template content frame.`);
    }
  }
  return { version: 1, slideId: parsed.slideId, kind: parsed.kind, frame, gap, zones, nodes: parsed.nodes };
}

function zone(id: string, colStart: number, colSpan: number, rowStart: number, rowSpan: number): SceneIntent["zones"][number] {
  return { id, colStart, colSpan, rowStart, rowSpan, align: "start", valign: "start" };
}

function node(block: SceneBlock, zoneId: string, order: number): SceneIntent["nodes"][number] {
  return { id: block.id, role: block.role, text: block.text, zoneId, order, emphasis: block.emphasis ?? "supporting", ...(block.group ? { group: block.group } : {}) };
}

function evenColumns(count: number): Array<{ start: number; span: number }> {
  if (count < 1 || count > 6) throw new Error(`SCENE_COMPOSITION_UNSUPPORTED: cannot place ${count} peers on the 12-column semantic grid.`);
  const base = Math.floor(12 / count);
  const remainder = 12 - base * count;
  let cursor = 0;
  return Array.from({ length: count }, (_, index) => {
    const span = base + (index < remainder ? 1 : 0);
    const result = { start: cursor, span };
    cursor += span;
    return result;
  });
}

export function composeDefaultScene(input: { slideId: string; kind: SceneKind; headline: string; blocks: SceneBlock[] }): SceneIntent {
  if (input.blocks.length === 0) throw new Error("SCENE_COMPOSITION_UNSUPPORTED: a scene requires at least one content block.");
  const zones: SceneIntent["zones"] = [];
  const nodes: SceneIntent["nodes"] = [];
  const bodyRow = 2;
  const bodyRows = 10;

  if (input.kind === "split") {
    const groups = [...new Set(input.blocks.map((block) => block.group).filter((value): value is string => Boolean(value)))];
    if (groups.length !== 2) throw new Error("SCENE_COMPOSITION_UNSUPPORTED: split requires exactly two semantic groups.");
    groups.forEach((group, index) => {
      const id = `group-${index + 1}`;
      zones.push(zone(id, index * 6, 6, bodyRow, bodyRows));
      input.blocks.filter((block) => block.group === group).forEach((block, order) => nodes.push(node(block, id, order)));
    });
  } else if (input.kind === "metric_strip") {
    if (input.blocks.length < 2 || input.blocks.length > 4 || input.blocks.some((block) => block.role !== "metric")) throw new Error("SCENE_COMPOSITION_UNSUPPORTED: metric_strip supports 2-4 metric blocks only.");
    if (input.blocks.length === 4) {
      input.blocks.forEach((block, index) => {
        const id = `metric-${index + 1}`;
        zones.push(zone(id, (index % 2) * 6, 6, bodyRow + Math.floor(index / 2) * 5, 5));
        nodes.push(node(block, id, index));
      });
    } else {
      const columns = evenColumns(input.blocks.length);
      input.blocks.forEach((block, index) => {
        const id = `metric-${index + 1}`;
        zones.push(zone(id, columns[index].start, columns[index].span, bodyRow, bodyRows));
        nodes.push(node(block, id, index));
      });
    }
  } else if (input.kind === "sequence" || input.kind === "timeline") {
    if (input.blocks.length < 2 || input.blocks.length > 6) throw new Error(`SCENE_COMPOSITION_UNSUPPORTED: ${input.kind} supports 2-6 ordered blocks.`);
    const columns = evenColumns(input.blocks.length);
    input.blocks.forEach((block, index) => {
      const id = `${input.kind}-${index + 1}`;
      zones.push(zone(id, columns[index].start, columns[index].span, bodyRow + 2, 6));
      nodes.push(node(block, id, index));
    });
  } else if (input.kind === "card_grid") {
    if (input.blocks.length < 2 || input.blocks.length > 6) throw new Error("SCENE_COMPOSITION_UNSUPPORTED: card_grid supports 2-6 blocks.");
    const columns = input.blocks.length <= 3 ? input.blocks.length : 2;
    const rows = Math.ceil(input.blocks.length / columns);
    const colTracks = evenColumns(columns);
    const rowSpan = Math.floor(bodyRows / rows);
    input.blocks.forEach((block, index) => {
      const id = `card-${index + 1}`;
      const row = Math.floor(index / columns);
      const col = index % columns;
      zones.push(zone(id, colTracks[col].start, colTracks[col].span, bodyRow + row * rowSpan, row === rows - 1 ? bodyRows - row * rowSpan : rowSpan));
      nodes.push(node(block, id, index));
    });
  } else {
    const id = "main";
    const width = input.kind === "hero" || input.kind === "statement" || input.kind === "conclusion" ? 8 : 12;
    const start = width === 8 ? 2 : 0;
    zones.push(zone(id, start, width, bodyRow, bodyRows));
    input.blocks.forEach((block, index) => nodes.push(node(block, id, index)));
  }

  return sceneIntentSchema.parse({ version: 1, slideId: input.slideId, kind: input.kind, headline: input.headline, grid: { columns: 12, rows: 12 }, zones, nodes });
}
