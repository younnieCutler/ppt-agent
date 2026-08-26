import fs from "node:fs";
import path from "node:path";
import pptxgen from "pptxgenjs";
import { resolveTheme } from "./brand";
import { validateGeometry, type Rect } from "./geometry";
import { assertFontsInstalled } from "./fonts";
import { deckSchema, type DeckSpec, type SlideSpec, type ThemeTokens } from "./schema";

const SLIDE_W = 13.333;
const SLIDE_H = 7.5;
const MARGIN_X = 0.72;
const CONTENT_Y = 1.42;
const CONTENT_H = 5.2;

type Pptx = any;
type Slide = any;

function hex(value: string): string {
  return value.replace(/^#/, "").toUpperCase();
}

function addText(slide: Slide, text: string, opts: Record<string, unknown>, rects: Rect[], id: string, fontFace: string, color: string): void {
  const x = Number(opts.x);
  const y = Number(opts.y);
  const w = Number(opts.w);
  const h = Number(opts.h);
  rects.push({ id, x, y, w, h, allowOverlap: Boolean(opts.allowOverlap) });
  slide.addText(text, {
    x,
    y,
    w,
    h,
    fontFace,
    color: hex(String(opts.color ?? color)),
    fontSize: Number(opts.fontSize ?? 16),
    bold: Boolean(opts.bold),
    italic: Boolean(opts.italic),
    margin: Number(opts.margin ?? 0),
    valign: String(opts.valign ?? "mid"),
    fit: "shrink",
    align: String(opts.align ?? "left"),
    paraSpaceAfterPt: 5,
    name: String(opts.name ?? id),
  });
}

function addShape(slide: Slide, pptx: Pptx, shapeType: unknown, opts: Record<string, unknown>, rects: Rect[], id: string): void {
  const x = Number(opts.x);
  const y = Number(opts.y);
  const w = Number(opts.w);
  const h = Number(opts.h);
  rects.push({ id, x, y, w, h, allowOverlap: Boolean(opts.allowOverlap) });
  const { allowOverlap: _allowOverlap, ...shapeOpts } = opts;
  slide.addShape(shapeType, shapeOpts);
}

function addLine(slide: Slide, pptx: Pptx, x: number, y: number, w: number, h: number, color: string, rects: Rect[], id: string, arrow = false): void {
  const endX = x + w;
  const endY = y + h;
  const normalizedX = Math.min(x, endX);
  const normalizedY = Math.min(y, endY);
  const normalizedW = Math.max(Math.abs(w), 0.02);
  const normalizedH = Math.max(Math.abs(h), 0.02);
  slide.addShape(pptx.ShapeType.line, {
    x: normalizedX,
    y: normalizedY,
    w: normalizedW,
    h: normalizedH,
    flipH: w < 0,
    flipV: h < 0,
    line: {
      color: hex(color),
      width: 1.2,
      endArrowType: arrow ? "triangle" : undefined,
    },
  });
  // Lines are allowed to cross nodes and other lines; only their endpoints are checked by the layout grammar.
  rects.push({ id, x: normalizedX, y: normalizedY, w: normalizedW, h: normalizedH, allowOverlap: true });
}

function addChrome(slide: Slide, pptx: Pptx, deck: DeckSpec, page: number, rects: Rect[]): void {
  const theme = deck.theme;
  if (theme.logoPath) {
    slide.addImage({ path: theme.logoPath, x: 12.05, y: 0.22, w: 0.58, h: 0.34, altText: "ppt-agent-logo" });
  }
  if (theme.footer.text) {
    addText(slide, theme.footer.text, { x: MARGIN_X, y: 7.12, w: 8.8, h: 0.18, fontSize: 8, valign: "mid" }, rects, `footer-${page}`, theme.fonts.body, theme.palette.muted);
  }
  if (theme.footer.showPageNumber) {
    addText(slide, String(page), { x: 12.1, y: 7.08, w: 0.48, h: 0.22, fontSize: 9, align: "right", name: "ppt-agent-page-number" }, rects, `page-${page}`, theme.fonts.body, theme.palette.muted);
  }
}

function addHeadline(slide: Slide, deck: DeckSpec, slideSpec: SlideSpec, rects: Rect[]): void {
  addText(slide, slideSpec.headline, { x: MARGIN_X, y: 0.48, w: 10.9, h: 0.62, fontSize: 26, bold: true, valign: "mid", align: slideSpec.headlineAlignment }, rects, `headline-${slideSpec.id}`, deck.theme.fonts.heading, deck.theme.palette.text);
}

function renderTitle(slide: Slide, pptx: Pptx, deck: DeckSpec, projectDir: string, spec: Extract<SlideSpec, { layout: "title" }>, rects: Rect[]): void {
  const content = spec.content;
  if (content.kicker) addText(slide, content.kicker.toUpperCase(), { x: MARGIN_X, y: 1.62, w: 5, h: 0.28, fontSize: 11, bold: true }, rects, `${spec.id}-kicker`, deck.theme.fonts.body, deck.theme.palette.accent);
  addText(slide, spec.headline, { x: MARGIN_X, y: 2.05, w: 10.5, h: 1.4, fontSize: 34, bold: true, valign: "mid", align: spec.headlineAlignment }, rects, `${spec.id}-title`, deck.theme.fonts.heading, deck.theme.palette.text);
  if (content.subtitle) addText(slide, content.subtitle, { x: MARGIN_X, y: 3.72, w: 8.7, h: 0.62, fontSize: 17 }, rects, `${spec.id}-subtitle`, deck.theme.fonts.body, deck.theme.palette.muted);
  if (content.imagePath) {
    const imagePath = path.resolve(projectDir, content.imagePath);
    if (!fs.existsSync(imagePath)) throw new Error(`Slide image not found: ${imagePath}`);
    slide.addImage({ path: imagePath, x: 9.9, y: 2.0, w: 2.4, h: 2.8 });
  }
}

function renderStatement(slide: Slide, pptx: Pptx, deck: DeckSpec, spec: Extract<SlideSpec, { layout: "statement" }>, rects: Rect[]): void {
  if (spec.composition === "claim_actions") {
    addText(slide, spec.content.body, { x: MARGIN_X, y: CONTENT_Y + 0.28, w: 4.3, h: 3.95, fontSize: 24, bold: true, valign: "top" }, rects, `${spec.id}-body`, deck.theme.fonts.heading, deck.theme.palette.primary);
    addText(slide, "ACTIONS / EVIDENCE", { x: 5.5, y: CONTENT_Y + 0.28, w: 5.8, h: 0.28, fontSize: 10, bold: true }, rects, `${spec.id}-actions-label`, deck.theme.fonts.body, deck.theme.palette.accent);
    spec.content.proofs.forEach((proof, index) => {
      const y = CONTENT_Y + 0.78 + index * 0.78;
      addShape(slide, pptx, pptx.ShapeType.rect, { x: 5.5, y, w: 6.1, h: 0.54, fill: { color: hex(index === 0 ? deck.theme.palette.surface : deck.theme.palette.background) }, line: { color: hex(deck.theme.palette.border), width: 0.5 }, allowOverlap: true }, rects, `${spec.id}-action-row-${index}`);
      addShape(slide, pptx, pptx.ShapeType.rect, { x: 5.5, y, w: 0.12, h: 0.54, fill: { color: hex(index === 0 ? deck.theme.palette.accent : deck.theme.palette.border) }, line: { color: hex(index === 0 ? deck.theme.palette.accent : deck.theme.palette.border) }, allowOverlap: true }, rects, `${spec.id}-action-accent-${index}`);
      addText(slide, proof, { x: 5.78, y: y + 0.12, w: 5.5, h: 0.25, fontSize: 14, bold: index === 0, valign: "mid" }, rects, `${spec.id}-proof-${index}`, deck.theme.fonts.body, deck.theme.palette.text);
    });
    return;
  }
  addShape(slide, pptx, pptx.ShapeType.rect, { x: MARGIN_X, y: CONTENT_Y + 0.32, w: 0.1, h: 2.02, fill: { color: hex(deck.theme.palette.accent) }, line: { color: hex(deck.theme.palette.accent) } }, rects, `${spec.id}-statement-accent`);
  addText(slide, spec.content.body, { x: MARGIN_X + 0.24, y: CONTENT_Y + 0.35, w: 6.96, h: 2.0, fontSize: 25, bold: true, valign: "top" }, rects, `${spec.id}-body`, deck.theme.fonts.heading, deck.theme.palette.primary);
  const proofs = spec.content.proofs;
  if (proofs.length > 0) {
    addText(slide, "EVIDENCE", { x: 8.45, y: CONTENT_Y + 0.35, w: 3.5, h: 0.25, fontSize: 10, bold: true }, rects, `${spec.id}-evidence-label`, deck.theme.fonts.body, deck.theme.palette.accent);
    proofs.forEach((proof, index) => addText(slide, `• ${proof}`, { x: 8.45, y: CONTENT_Y + 0.78 + index * 0.72, w: 3.7, h: 0.52, fontSize: 15, valign: "top" }, rects, `${spec.id}-proof-${index}`, deck.theme.fonts.body, deck.theme.palette.text));
  }
}

function renderComparison(slide: Slide, pptx: Pptx, deck: DeckSpec, spec: Extract<SlideSpec, { layout: "comparison" }>, rects: Rect[]): void {
  if (spec.composition === "diagnosis_matrix") {
    const left = spec.content.left;
    const right = spec.content.right;
    addText(slide, left.label, { x: MARGIN_X, y: CONTENT_Y + 0.28, w: 3.65, h: 0.42, fontSize: 22, bold: true }, rects, `${spec.id}-left-label`, deck.theme.fonts.heading, deck.theme.palette.primary);
    left.items.forEach((item, index) => addText(slide, `• ${item}`, { x: MARGIN_X, y: CONTENT_Y + 0.92 + index * 0.56, w: 3.72, h: 0.34, fontSize: 14, valign: "top" }, rects, `${spec.id}-left-item-${index}`, deck.theme.fonts.body, deck.theme.palette.text));
    addText(slide, right.label, { x: 4.75, y: CONTENT_Y + 0.28, w: 6.65, h: 0.3, fontSize: 11, bold: true }, rects, `${spec.id}-right-label`, deck.theme.fonts.body, deck.theme.palette.accent);
    const rows = Math.max(right.items.length, 1);
    right.items.forEach((item, index) => {
      const y = CONTENT_Y + 0.78 + index * (3.1 / rows);
      addShape(slide, pptx, pptx.ShapeType.rect, { x: 4.75, y, w: 6.65, h: 0.48, fill: { color: hex(index === 0 ? deck.theme.palette.surface : deck.theme.palette.background) }, line: { color: hex(deck.theme.palette.border), width: 0.5 }, allowOverlap: true }, rects, `${spec.id}-matrix-row-${index}`);
      addText(slide, item, { x: 5.0, y: y + 0.11, w: 6.05, h: 0.24, fontSize: 13, bold: index === 0 }, rects, `${spec.id}-right-item-${index}`, deck.theme.fonts.body, deck.theme.palette.text);
    });
    if (spec.content.delta) addText(slide, spec.content.delta, { x: 4.75, y: 5.75, w: 6.65, h: 0.38, fontSize: 15, bold: true, align: "right" }, rects, `${spec.id}-delta`, deck.theme.fonts.body, deck.theme.palette.accent);
    return;
  }
  if (spec.composition === "ownership_split") {
    const sides = [spec.content.left, spec.content.right];
    sides.forEach((side, index) => {
      const x = MARGIN_X + index * 5.95;
      addShape(slide, pptx, pptx.ShapeType.rect, { x, y: CONTENT_Y + 0.2, w: 5.55, h: 4.68, fill: { color: hex(index === 0 ? deck.theme.palette.surface : deck.theme.palette.background) }, line: { color: hex(index === 0 ? deck.theme.palette.primary : deck.theme.palette.accent), width: 1.2 }, allowOverlap: true }, rects, `${spec.id}-ownership-${index}`);
      addText(slide, side.label, { x: x + 0.3, y: CONTENT_Y + 0.48, w: 4.9, h: 0.42, fontSize: 20, bold: true }, rects, `${spec.id}-label-${index}`, deck.theme.fonts.heading, index === 0 ? deck.theme.palette.primary : deck.theme.palette.accent);
      side.items.forEach((item, itemIndex) => addText(slide, item, { x: x + 0.3, y: CONTENT_Y + 1.22 + itemIndex * 0.58, w: 4.85, h: 0.33, fontSize: 14, valign: "top" }, rects, `${spec.id}-item-${index}-${itemIndex}`, deck.theme.fonts.body, deck.theme.palette.text));
    });
    if (spec.content.delta) addText(slide, spec.content.delta, { x: 2.1, y: 6.12, w: 9.0, h: 0.36, fontSize: 15, bold: true, align: "center" }, rects, `${spec.id}-delta`, deck.theme.fonts.body, deck.theme.palette.accent);
    return;
  }
  const x = MARGIN_X;
  const gap = 0.42;
  const panelW = 5.55;
  const y = CONTENT_Y + 0.18;
  const h = 4.55;
  for (const [index, side] of [spec.content.left, spec.content.right].entries()) {
    const panelX = x + index * (panelW + gap);
    addShape(slide, pptx, pptx.ShapeType.rect, { x: panelX, y, w: panelW, h, fill: { color: hex(deck.theme.palette.surface) }, line: { color: hex(deck.theme.palette.border), width: 1 }, allowOverlap: true }, rects, `${spec.id}-panel-${index}`);
    addText(slide, side.label, { x: panelX + 0.28, y: y + 0.25, w: panelW - 0.56, h: 0.35, fontSize: 17, bold: true }, rects, `${spec.id}-label-${index}`, deck.theme.fonts.heading, deck.theme.palette.primary);
    side.items.forEach((item, itemIndex) => addText(slide, `• ${item}`, { x: panelX + 0.28, y: y + 0.9 + itemIndex * 0.48, w: panelW - 0.56, h: 0.32, fontSize: 14, valign: "top" }, rects, `${spec.id}-item-${index}-${itemIndex}`, deck.theme.fonts.body, deck.theme.palette.text));
  }
  if (spec.content.delta) addText(slide, spec.content.delta, { x: 4.2, y: 6.12, w: 4.9, h: 0.42, fontSize: 15, bold: true, align: "center" }, rects, `${spec.id}-delta`, deck.theme.fonts.body, deck.theme.palette.accent);
}

function renderProcess(slide: Slide, pptx: Pptx, deck: DeckSpec, spec: Extract<SlideSpec, { layout: "process" }>, rects: Rect[]): void {
  const steps = spec.content.steps;
  if (spec.composition === "stage_gate") {
    const gap = 0.18;
    const stageW = (11.85 - gap * (steps.length - 1)) / steps.length;
    steps.forEach((step, index) => {
      const x = MARGIN_X + index * (stageW + gap);
      const active = index === 0;
      addShape(slide, pptx, pptx.ShapeType.roundRect, { x, y: CONTENT_Y + 1.05, w: stageW, h: 1.15, rectRadius: 0.04, fill: { color: hex(active ? deck.theme.palette.accent : deck.theme.palette.surface) }, line: { color: hex(active ? deck.theme.palette.accent : deck.theme.palette.border), width: 1 }, allowOverlap: true }, rects, `${spec.id}-stage-${index}`);
      addText(slide, `Stage ${index + 1}`, { x: x + 0.16, y: CONTENT_Y + 1.26, w: stageW - 0.32, h: 0.2, fontSize: 10, bold: true, align: "center", color: active ? "FFFFFF" : deck.theme.palette.muted }, rects, `${spec.id}-stage-number-${index}`, deck.theme.fonts.body, active ? "FFFFFF" : deck.theme.palette.muted);
      addText(slide, step.label, { x: x + 0.16, y: CONTENT_Y + 1.48, w: stageW - 0.32, h: 0.58, fontSize: 13, bold: true, align: "center", color: active ? "FFFFFF" : deck.theme.palette.text }, rects, `${spec.id}-stage-label-${index}`, deck.theme.fonts.heading, active ? "FFFFFF" : deck.theme.palette.text);
      if (step.detail) addText(slide, step.detail, { x: x + 0.08, y: CONTENT_Y + 2.55, w: stageW - 0.16, h: 0.78, fontSize: 11, align: "center", valign: "top" }, rects, `${spec.id}-stage-detail-${index}`, deck.theme.fonts.body, deck.theme.palette.muted);
    });
    return;
  }
  const startX = MARGIN_X + 0.1;
  const gap = 0.28;
  const stepW = (11.75 - gap * (steps.length - 1)) / steps.length;
  const y = CONTENT_Y + 1.1;
  steps.forEach((step, index) => {
    const x = startX + index * (stepW + gap);
    if (index < steps.length - 1) addLine(slide, pptx, x + stepW - 0.02, y + 0.27, gap + 0.04, 0, deck.theme.palette.accent, rects, `${spec.id}-link-${index}`, true);
    slide.addShape(pptx.ShapeType.ellipse, { x, y, w: 0.55, h: 0.55, fill: { color: hex(deck.theme.palette.accent) }, line: { color: hex(deck.theme.palette.accent) } });
    rects.push({ id: `${spec.id}-number-${index}`, x, y, w: 0.55, h: 0.55, allowOverlap: true });
    addText(slide, String(index + 1), { x, y: y + 0.04, w: 0.55, h: 0.42, fontSize: 13, bold: true, align: "center", color: "FFFFFF" }, rects, `${spec.id}-number-text-${index}`, deck.theme.fonts.body, "FFFFFF");
    addText(slide, step.label, { x, y: y + 0.82, w: stepW, h: 0.48, fontSize: 16, bold: true, valign: "top" }, rects, `${spec.id}-step-${index}`, deck.theme.fonts.heading, deck.theme.palette.text);
    if (step.detail) addText(slide, step.detail, { x, y: y + 1.42, w: stepW, h: 0.95, fontSize: 12, valign: "top" }, rects, `${spec.id}-detail-${index}`, deck.theme.fonts.body, deck.theme.palette.muted);
  });
}

function renderPipeline(slide: Slide, pptx: Pptx, deck: DeckSpec, spec: Extract<SlideSpec, { layout: "pipeline" }>, rects: Rect[]): void {
  const { lanes, nodes, edges } = spec.content;
  const effectiveLanes = lanes.length > 0 ? lanes : [{ id: "__default__", label: "" }];
  const laneCount = effectiveLanes.length;
  const laneH = 4.65 / laneCount;
  const laneById = new Map(effectiveLanes.map((lane, index) => [lane.id, index]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  edges.forEach((edge) => {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) throw new Error(`Pipeline edge references unknown node: ${edge.from} -> ${edge.to}`);
    outgoing.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  });
  const ranks = new Map(nodes.map((node) => [node.id, 0]));
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited += 1;
    for (const next of outgoing.get(id) ?? []) {
      ranks.set(next, Math.max(ranks.get(next) ?? 0, (ranks.get(id) ?? 0) + 1));
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (visited !== nodes.length) throw new Error("Pipeline must be acyclic so its flow can be rendered deterministically.");
  const rankCount = Math.max(...ranks.values()) + 1;
  const labelW = lanes.length > 0 ? 1.62 : 0;
  const availableW = 11.85 - labelW;
  const horizontalGap = rankCount > 1 ? Math.min(0.24, availableW * 0.04) : 0;
  const nodeW = Math.max(0.72, (availableW - horizontalGap * (rankCount - 1)) / rankCount);
  const positions = new Map<string, { x: number; y: number; w: number; h: number }>();
  effectiveLanes.forEach((lane, index) => {
    const y = CONTENT_Y + index * laneH;
    addShape(slide, pptx, pptx.ShapeType.rect, { x: MARGIN_X, y, w: 11.85, h: laneH - 0.06, fill: { color: index % 2 === 0 ? deck.theme.palette.background : deck.theme.palette.surface }, line: { color: hex(deck.theme.palette.border), width: 0.5 }, allowOverlap: true }, rects, `${spec.id}-lane-${lane.id}`);
    if (lane.label) addText(slide, lane.label, { x: MARGIN_X + 0.18, y: y + 0.12, w: 1.35, h: 0.26, fontSize: 9, bold: true }, rects, `${spec.id}-lane-label-${lane.id}`, deck.theme.fonts.body, deck.theme.palette.muted);
  });
  const cells = new Map<string, typeof nodes>();
  nodes.forEach((node) => {
    const laneId = node.laneId ?? "__default__";
    if (!laneById.has(laneId)) throw new Error(`Pipeline node '${node.id}' references unknown lane '${laneId}'.`);
    const key = `${laneId}:${ranks.get(node.id)}`;
    cells.set(key, [...(cells.get(key) ?? []), node]);
  });
  nodes.forEach((node) => {
    const laneId = node.laneId ?? "__default__";
    const laneIndex = laneById.get(laneId)!;
    const rank = ranks.get(node.id)!;
    const cell = cells.get(`${laneId}:${rank}`)!;
    const rowIndex = cell.findIndex((candidate) => candidate.id === node.id);
    const verticalGap = 0.08;
    const h = Math.min(0.78, Math.max(0.34, (laneH - 0.62 - verticalGap * (cell.length - 1)) / cell.length));
    const x = MARGIN_X + labelW + rank * (nodeW + horizontalGap);
    const y = CONTENT_Y + laneIndex * laneH + 0.44 + rowIndex * (h + verticalGap);
    const w = nodeW;
    positions.set(node.id, { x, y, w, h });
    addShape(slide, pptx, pptx.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.04, fill: { color: hex(deck.theme.palette.surface) }, line: { color: hex(deck.theme.palette.accent), width: 1.2 }, allowOverlap: true }, rects, `${spec.id}-node-${node.id}`);
    addText(slide, node.label, { x: x + 0.08, y: y + 0.08, w: w - 0.16, h: h - 0.16, fontSize: 12, bold: true, align: "center" }, rects, `${spec.id}-node-text-${node.id}`, deck.theme.fonts.body, deck.theme.palette.text);
  });
  edges.forEach((edge, index) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) throw new Error(`Pipeline edge references unknown node: ${edge.from} -> ${edge.to}`);
    addLine(slide, pptx, from.x + from.w, from.y + from.h / 2, to.x - (from.x + from.w), to.y + to.h / 2 - (from.y + from.h / 2), deck.theme.palette.accent, rects, `${spec.id}-edge-${index}`, true);
    if (edge.label) addText(slide, edge.label, { x: (from.x + from.w + to.x) / 2 - 0.55, y: Math.min(from.y, to.y) - 0.18, w: 1.1, h: 0.18, fontSize: 8, align: "center" }, rects, `${spec.id}-edge-label-${index}`, deck.theme.fonts.body, deck.theme.palette.muted);
  });
}

function renderArchitecture(slide: Slide, pptx: Pptx, deck: DeckSpec, spec: Extract<SlideSpec, { layout: "architecture" }>, rects: Rect[]): void {
  const zones = spec.content.zones;
  const gap = 0.2;
  const zoneW = (11.85 - gap * (zones.length - 1)) / zones.length;
  const positions = new Map<string, { x: number; y: number; w: number; h: number }>();
  zones.forEach((zone, zoneIndex) => {
    const x = MARGIN_X + zoneIndex * (zoneW + gap);
    const y = CONTENT_Y + 0.1;
    const h = 4.95;
    addShape(slide, pptx, pptx.ShapeType.rect, { x, y, w: zoneW, h, fill: { color: zoneIndex % 2 === 0 ? deck.theme.palette.surface : deck.theme.palette.background }, line: { color: hex(deck.theme.palette.border), width: 1 }, allowOverlap: true }, rects, `${spec.id}-zone-${zone.id}`);
    addText(slide, zone.label, { x: x + 0.18, y: y + 0.18, w: zoneW - 0.36, h: 0.32, fontSize: 15, bold: true }, rects, `${spec.id}-zone-label-${zone.id}`, deck.theme.fonts.heading, deck.theme.palette.primary);
    if (zone.description) addText(slide, zone.description, { x: x + 0.18, y: y + 0.58, w: zoneW - 0.36, h: 0.42, fontSize: 10, valign: "top" }, rects, `${spec.id}-zone-desc-${zone.id}`, deck.theme.fonts.body, deck.theme.palette.muted);
    zone.nodes.forEach((node, nodeIndex) => {
      const nodeY = y + 1.22 + nodeIndex * 0.62;
      const nodeH = 0.42;
      addShape(slide, pptx, pptx.ShapeType.roundRect, { x: x + 0.2, y: nodeY, w: zoneW - 0.4, h: nodeH, fill: { color: hex(deck.theme.palette.background) }, line: { color: hex(deck.theme.palette.border), width: 0.7 }, allowOverlap: true }, rects, `${spec.id}-node-${zone.id}-${nodeIndex}`);
      addText(slide, node, { x: x + 0.3, y: nodeY + 0.05, w: zoneW - 0.6, h: 0.28, fontSize: 11, align: "center" }, rects, `${spec.id}-node-text-${zone.id}-${nodeIndex}`, deck.theme.fonts.body, deck.theme.palette.text);
      positions.set(`${zone.id}:${node}`, { x: x + 0.2, y: nodeY, w: zoneW - 0.4, h: nodeH });
    });
  });
  spec.content.edges.forEach((edge, index) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) throw new Error(`Architecture edge references unknown endpoint: ${edge.from} -> ${edge.to}`);
    const forward = to.x >= from.x;
    const startX = forward ? from.x + from.w : from.x;
    const endX = forward ? to.x : to.x + to.w;
    const startY = from.y + from.h / 2;
    const endY = to.y + to.h / 2;
    addLine(slide, pptx, startX, startY, endX - startX, endY - startY, deck.theme.palette.accent, rects, `${spec.id}-edge-${index}`, true);
    if (edge.label) {
      const labelW = 1.8;
      const midX = Math.min(Math.max((startX + endX) / 2 - labelW / 2, MARGIN_X), 13.333 - MARGIN_X - labelW);
      const midY = Math.min(Math.max((startY + endY) / 2 - 0.14, CONTENT_Y + 0.1), 7.5 - 0.3);
      addText(slide, edge.label, { x: midX, y: midY, w: labelW, h: 0.28, fontSize: 9, align: "center", allowOverlap: true }, rects, `${spec.id}-edge-label-${index}`, deck.theme.fonts.body, deck.theme.palette.muted);
    }
  });
}

function renderQuantitative(slide: Slide, pptx: Pptx, deck: DeckSpec, spec: Extract<SlideSpec, { layout: "quantitative" }>, rects: Rect[]): void {
  const metrics = spec.content.metrics;
  if (spec.composition === "metric_story") {
    const [primary, ...supporting] = metrics;
    addText(slide, primary.label, { x: MARGIN_X, y: CONTENT_Y + 0.48, w: 4.2, h: 0.4, fontSize: 17, bold: true }, rects, `${spec.id}-primary-label`, deck.theme.fonts.body, deck.theme.palette.muted);
    addText(slide, `${primary.value}${primary.unit ?? ""}`, { x: MARGIN_X, y: CONTENT_Y + 1.02, w: 4.2, h: 1.15, fontSize: 47, bold: true }, rects, `${spec.id}-primary-value`, deck.theme.fonts.heading, deck.theme.palette.primary);
    if (primary.note) addText(slide, primary.note, { x: MARGIN_X, y: CONTENT_Y + 2.38, w: 4.2, h: 0.68, fontSize: 12, valign: "top" }, rects, `${spec.id}-primary-note`, deck.theme.fonts.body, deck.theme.palette.muted);
    const supportPitch = 3.95 / Math.max(supporting.length, 1);
    const supportHeight = Math.min(0.58, Math.max(0.4, supportPitch - 0.08));
    supporting.forEach((metric, index) => {
      const y = CONTENT_Y + 0.56 + index * supportPitch;
      addShape(slide, pptx, pptx.ShapeType.rect, { x: 5.2, y, w: 6.15, h: supportHeight, fill: { color: hex(index === 0 ? deck.theme.palette.surface : deck.theme.palette.background) }, line: { color: hex(deck.theme.palette.border), width: 0.5 }, allowOverlap: true }, rects, `${spec.id}-support-row-${index}`);
      addText(slide, metric.label, { x: 5.45, y: y + (supportHeight - 0.24) / 2, w: 3.95, h: 0.24, fontSize: 13, bold: index === 0 }, rects, `${spec.id}-support-label-${index}`, deck.theme.fonts.body, deck.theme.palette.text);
      addText(slide, `${metric.value}${metric.unit ?? ""}`, { x: 9.6, y: y + (supportHeight - 0.24) / 2, w: 1.4, h: 0.24, fontSize: 13, bold: true, align: "right" }, rects, `${spec.id}-support-value-${index}`, deck.theme.fonts.body, deck.theme.palette.accent);
    });
    return;
  }
  if (spec.composition === "kpi_row") {
    const gap = 0.25;
    const w = (11.85 - gap * (metrics.length - 1)) / metrics.length;
    metrics.forEach((metric, index) => {
      const x = MARGIN_X + index * (w + gap);
      addText(slide, metric.label, { x, y: CONTENT_Y + 0.5, w, h: 0.42, fontSize: 13, bold: true }, rects, `${spec.id}-label-${index}`, deck.theme.fonts.body, deck.theme.palette.muted);
      addText(slide, `${metric.value}${metric.unit ?? ""}`, { x, y: CONTENT_Y + 1.18, w, h: 0.9, fontSize: 29, bold: true }, rects, `${spec.id}-value-${index}`, deck.theme.fonts.heading, deck.theme.palette.primary);
      if (metric.note) addText(slide, metric.note, { x, y: CONTENT_Y + 2.28, w, h: 0.52, fontSize: 11, valign: "top" }, rects, `${spec.id}-note-${index}`, deck.theme.fonts.body, deck.theme.palette.muted);
      if (index < metrics.length - 1) addLine(slide, pptx, x + w + gap / 2, CONTENT_Y + 0.42, 0, 2.3, deck.theme.palette.border, rects, `${spec.id}-separator-${index}`);
    });
    return;
  }
  const max = Math.max(...metrics.map((metric) => Math.abs(metric.value)), 1);
  metrics.forEach((metric, index) => {
    const y = CONTENT_Y + 0.38 + index * 0.62;
    addText(slide, metric.label, { x: MARGIN_X, y, w: 2.4, h: 0.28, fontSize: 12 }, rects, `${spec.id}-label-${index}`, deck.theme.fonts.body, deck.theme.palette.text);
    const barW = 7.7 * Math.abs(metric.value) / max;
    addShape(slide, pptx, pptx.ShapeType.rect, { x: 3.15, y: y + 0.02, w: Math.max(barW, 0.04), h: 0.24, fill: { color: hex(deck.theme.palette.accent) }, line: { color: hex(deck.theme.palette.accent) }, allowOverlap: true }, rects, `${spec.id}-bar-${index}`);
    addText(slide, `${metric.value}${metric.unit ?? ""}`, { x: 11.15, y, w: 1.2, h: 0.28, fontSize: 12, bold: true, align: "right" }, rects, `${spec.id}-value-${index}`, deck.theme.fonts.body, deck.theme.palette.primary);
  });
}

function renderTimeline(slide: Slide, pptx: Pptx, deck: DeckSpec, spec: Extract<SlideSpec, { layout: "timeline" }>, rects: Rect[]): void {
  const milestones = spec.content.milestones;
  if (spec.composition === "now_next_later") {
    const groupCount = Math.min(3, milestones.length);
    const gap = 0.24;
    const w = (11.85 - gap * (groupCount - 1)) / groupCount;
    milestones.slice(0, groupCount).forEach((milestone, index) => {
      const x = MARGIN_X + index * (w + gap);
      const active = index === 0;
      addShape(slide, pptx, pptx.ShapeType.rect, { x, y: CONTENT_Y + 1.22, w, h: 2.15, fill: { color: hex(active ? deck.theme.palette.surface : deck.theme.palette.background) }, line: { color: hex(active ? deck.theme.palette.accent : deck.theme.palette.border), width: active ? 1.5 : 0.8 }, allowOverlap: true }, rects, `${spec.id}-period-${index}`);
      addText(slide, milestone.date, { x: x + 0.24, y: CONTENT_Y + 1.52, w: w - 0.48, h: 0.26, fontSize: 11, bold: true, color: active ? deck.theme.palette.accent : deck.theme.palette.muted }, rects, `${spec.id}-date-${index}`, deck.theme.fonts.body, active ? deck.theme.palette.accent : deck.theme.palette.muted);
      addText(slide, milestone.label, { x: x + 0.24, y: CONTENT_Y + 1.97, w: w - 0.48, h: 0.45, fontSize: 20, bold: true }, rects, `${spec.id}-label-${index}`, deck.theme.fonts.heading, deck.theme.palette.text);
      if (milestone.detail) addText(slide, milestone.detail, { x: x + 0.24, y: CONTENT_Y + 2.65, w: w - 0.48, h: 0.42, fontSize: 12, valign: "top" }, rects, `${spec.id}-detail-${index}`, deck.theme.fonts.body, deck.theme.palette.muted);
    });
    return;
  }
  const startX = MARGIN_X + 0.3;
  const lineW = 11.2;
  const y = CONTENT_Y + 2.05;
  addLine(slide, pptx, startX, y, lineW, 0, deck.theme.palette.accent, rects, `${spec.id}-timeline-line`);
  milestones.forEach((milestone, index) => {
    const x = startX + (lineW * index) / (milestones.length - 1);
    slide.addShape(pptx.ShapeType.ellipse, { x: x - 0.12, y: y - 0.12, w: 0.24, h: 0.24, fill: { color: hex(deck.theme.palette.accent) }, line: { color: hex(deck.theme.palette.accent) } });
    rects.push({ id: `${spec.id}-dot-${index}`, x: x - 0.12, y: y - 0.12, w: 0.24, h: 0.24, allowOverlap: true });
    addText(slide, milestone.date, { x: x - 0.55, y: y - 0.82, w: 1.1, h: 0.26, fontSize: 10, bold: true, align: "center" }, rects, `${spec.id}-date-${index}`, deck.theme.fonts.body, deck.theme.palette.accent);
    addText(slide, milestone.label, { x: x - 0.85, y: y + 0.34, w: 1.7, h: 0.5, fontSize: 13, bold: true, align: "center", valign: "top" }, rects, `${spec.id}-label-${index}`, deck.theme.fonts.heading, deck.theme.palette.text);
    if (milestone.detail) addText(slide, milestone.detail, { x: x - 0.9, y: y + 1.02, w: 1.8, h: 0.6, fontSize: 10, align: "center", valign: "top" }, rects, `${spec.id}-detail-${index}`, deck.theme.fonts.body, deck.theme.palette.muted);
  });
}

function renderEvidence(slide: Slide, pptx: Pptx, deck: DeckSpec, projectDir: string, spec: Extract<SlideSpec, { layout: "evidence" }>, rects: Rect[]): void {
  if (spec.composition === "evidence_panel" && !spec.content.assetPath) {
    addShape(slide, pptx, pptx.ShapeType.rect, { x: MARGIN_X, y: CONTENT_Y + 0.3, w: 3.75, h: 3.92, fill: { color: hex(deck.theme.palette.surface) }, line: { color: hex(deck.theme.palette.border), width: 0.7 }, allowOverlap: true }, rects, `${spec.id}-evidence-panel`);
    if (spec.content.caption) addText(slide, spec.content.caption, { x: MARGIN_X + 0.32, y: CONTENT_Y + 0.7, w: 3.1, h: 1.45, fontSize: 24, bold: true, valign: "top" }, rects, `${spec.id}-caption`, deck.theme.fonts.heading, deck.theme.palette.primary);
    addText(slide, "SOURCE-BACKED", { x: MARGIN_X + 0.32, y: CONTENT_Y + 3.45, w: 2.8, h: 0.22, fontSize: 10, bold: true }, rects, `${spec.id}-source-label`, deck.theme.fonts.body, deck.theme.palette.accent);
    spec.content.bullets.forEach((bullet, index) => {
      const y = CONTENT_Y + 0.52 + index * 0.8;
      addShape(slide, pptx, pptx.ShapeType.rect, { x: 4.92, y, w: 6.35, h: 0.58, fill: { color: hex(index === 0 ? deck.theme.palette.surface : deck.theme.palette.background) }, line: { color: hex(deck.theme.palette.border), width: 0.5 }, allowOverlap: true }, rects, `${spec.id}-evidence-row-${index}`);
      addText(slide, bullet, { x: 5.18, y: y + 0.14, w: 5.8, h: 0.25, fontSize: 14, bold: index === 0 }, rects, `${spec.id}-bullet-${index}`, deck.theme.fonts.body, deck.theme.palette.text);
    });
    return;
  }
  if (spec.content.assetPath) {
    const imagePath = path.resolve(projectDir, spec.content.assetPath);
    if (!fs.existsSync(imagePath)) throw new Error(`Evidence image not found: ${imagePath}`);
    slide.addImage({ path: imagePath, x: MARGIN_X, y: CONTENT_Y + 0.18, w: 6.55, h: 4.65 });
    if (spec.content.caption) addText(slide, spec.content.caption, { x: MARGIN_X, y: CONTENT_Y + 4.98, w: 6.55, h: 0.26, fontSize: 9, valign: "top" }, rects, `${spec.id}-caption`, deck.theme.fonts.body, deck.theme.palette.muted);
  }
  const startX = spec.content.assetPath ? 7.75 : MARGIN_X;
  spec.content.bullets.forEach((bullet, index) => addText(slide, `• ${bullet}`, { x: startX, y: CONTENT_Y + 0.5 + index * 0.72, w: 4.1, h: 0.5, fontSize: 16, valign: "top" }, rects, `${spec.id}-bullet-${index}`, deck.theme.fonts.body, deck.theme.palette.text));
}

function renderSlide(pptx: Pptx, deck: DeckSpec, projectDir: string, spec: SlideSpec, page: number): { rects: Rect[] } {
  const slide = pptx.addSlide();
  slide.background = { color: hex(deck.theme.palette.background) };
  const rects: Rect[] = [];
  if (spec.layout === "title") {
    renderTitle(slide, pptx, deck, projectDir, spec, rects);
  } else {
    addHeadline(slide, deck, spec, rects);
    if (spec.layout === "statement") renderStatement(slide, pptx, deck, spec, rects);
    if (spec.layout === "comparison") renderComparison(slide, pptx, deck, spec, rects);
    if (spec.layout === "process") renderProcess(slide, pptx, deck, spec, rects);
    if (spec.layout === "pipeline") renderPipeline(slide, pptx, deck, spec, rects);
    if (spec.layout === "architecture") renderArchitecture(slide, pptx, deck, spec, rects);
    if (spec.layout === "quantitative") renderQuantitative(slide, pptx, deck, spec, rects);
    if (spec.layout === "timeline") renderTimeline(slide, pptx, deck, spec, rects);
    if (spec.layout === "evidence") renderEvidence(slide, pptx, deck, projectDir, spec, rects);
  }
  addChrome(slide, pptx, deck, page, rects);
  const geometryIssues = validateGeometry(rects);
  if (geometryIssues.length > 0) {
    throw new Error(`Geometry QA failed on ${spec.id}: ${geometryIssues.map((issue) => issue.message).join(" ")}`);
  }
  return { rects };
}

export type RenderResult = { outputPath: string; slideRects: Record<string, Rect[]> };

export async function renderDeck(input: unknown, outputPath: string, projectDir = process.cwd(), options: { pageLimit?: number } = {}): Promise<RenderResult> {
  const parsedDeck = deckSchema.parse(input);
  if (parsedDeck.contract.aspectRatio !== "16:9") {
    throw new Error("The deterministic renderer only supports 16:9. A 4:3 Company Template Pack must use the native-template-fill workflow.");
  }
  const deck: DeckSpec = { ...parsedDeck, theme: resolveTheme(parsedDeck.contract, projectDir) };
  if (!options.pageLimit && deck.contract.slideCount !== deck.slides.length) throw new Error(`Contract slideCount ${deck.contract.slideCount} does not match ${deck.slides.length} slides.`);
  assertFontsInstalled(deck.contract.fonts);

  const pptx: Pptx = new (pptxgen as any)();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Claude Code /ppt";
  pptx.subject = deck.contract.purpose;
  pptx.title = deck.title;
  pptx.company = "";
  pptx.lang = deck.contract.language;
  pptx.theme = { headFontFace: deck.contract.fonts.heading, bodyFontFace: deck.contract.fonts.body, lang: deck.contract.language };

  const slideRects: Record<string, Rect[]> = {};
  deck.slides.slice(0, options.pageLimit).forEach((spec, index) => {
    slideRects[spec.id] = renderSlide(pptx, deck, projectDir, spec, index + 1).rects;
  });
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  await pptx.writeFile({ fileName: path.resolve(outputPath) });
  return { outputPath: path.resolve(outputPath), slideRects };
}
