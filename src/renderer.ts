import fs from "node:fs";
import path from "node:path";
import pptxgen from "pptxgenjs";
import { validateGeometry, type Rect } from "./geometry";
import { assertFontsInstalled } from "./fonts";
import { deckSchema, type ContentModel, type DeckSpec, type SlideSpec } from "./schema";
import { drawGauge, drawSparkline } from "./visuals";
import { resolvePresentationStyle, type ReferenceSelectionEntry, type ResolvedPresentationStyle } from "./style";
import { applyOrganizationTemplate } from "./template";
import { bindingForLayout, semanticLayouts, CANVAS_DIMENSIONS } from "./organization";

const SLIDE_W = 13.333;
const SLIDE_H = 7.5;
const MARGIN_X = 0.72;
const CONTENT_Y = 1.42;
const CONTENT_H = 5.2;

// Chrome (logo, page number) sits directly against the real canvas edge, not the canonical
// content box, so it's positioned as a fixed margin from the true right edge. Expressed as a
// margin rather than an absolute x so it generalizes to a narrower 4:3 canvas.
const CHROME_LOGO_RIGHT_MARGIN = SLIDE_W - 12.05;
const CHROME_PAGE_NUM_RIGHT_MARGIN = SLIDE_W - 12.1;

// The coordinate space every layout function below is authored against. When an organization
// template binds a semantic layout to a different `contentRegion`, ctx.transform maps this
// canonical box onto that region so content actually lands inside the template's declared
// safe area — not just alongside it. Top is 0.48 (the headline row), not CONTENT_Y, because the
// headline is part of the content a template's contentRegion is meant to contain.
const CANON_X = MARGIN_X;
const CANON_TOP = 0.48;
const CANON_W = 11.85;
const CANON_H = CONTENT_Y + CONTENT_H - CANON_TOP;

// The contentRegion an organization template can declare to reproduce the renderer's own default
// geometry exactly (an identity transform). Declaring the old body-only box here — {x:0.72,
// y:1.42, w:11.85, h:5.2} — would silently push the headline down and compress body content,
// since that box excludes the headline row this canonical space now includes.
export const defaultContentRegion = { x: CANON_X, y: CANON_TOP, w: CANON_W, h: CANON_H };

type Pptx = any;
type Slide = any;
type Decoration = "filled" | "flat" | "outline";
type StyleScale = {
  fontScale: number;
  headlineScale: number;
  kpiScale: number;
  spacingScale: number;
  decoration: Decoration;
  visualScale: number;
  copyBudget: number;
};
type RenderDeck = Omit<DeckSpec, "theme"> & { theme: ResolvedPresentationStyle };

export type RenderContext = {
  style: StyleScale;
  /** Maps a rect authored in canonical content-space into this slide's actual geometry. Identity when no organization template binds this layout. */
  transform: (rect: { x: number; y: number; w: number; h: number }) => { x: number; y: number; w: number; h: number };
};

function styleScaleFor(theme: ResolvedPresentationStyle): StyleScale {
  return {
    fontScale: theme.grammar.bodyScale,
    headlineScale: theme.grammar.headlineScale,
    kpiScale: theme.grammar.kpiScale,
    spacingScale: theme.grammar.spacingScale,
    visualScale: theme.grammar.focalVisualScale,
    copyBudget: theme.grammar.copyBudget,
    decoration: theme.grammar.surfaceUsage === "none" ? "outline" : theme.grammar.surfaceUsage === "bands" ? "flat" : "filled",
  };
}

// Independent per-axis scaling: a rectangle-to-rectangle mapping is the correct generalization
// for arbitrary content regions. A circle (gauge arc) can end up a slight ellipse when a
// template's region aspect ratio diverges sharply from canonical — acceptable given no
// organization fixture requires exact circularity; revisit if one ever does.
function contextFor(theme: ResolvedPresentationStyle, layout: (typeof semanticLayouts)[number]): RenderContext {
  const style = styleScaleFor(theme);
  const organization = theme.organization;
  if (!organization) return { style, transform: (rect) => rect };
  const region = bindingForLayout(organization.map, layout).contentRegion;
  // Bypass the arithmetic entirely for the declared-identity case: floating-point round-trip
  // through a mathematically-1.0 scale and mathematically-0 offset can still perturb the last bit,
  // and a template that explicitly asked for the renderer's own geometry should get it exactly.
  if (region.x === CANON_X && region.y === CANON_TOP && region.w === CANON_W && region.h === CANON_H) {
    return { style, transform: (rect) => rect };
  }
  const scaleX = region.w / CANON_W;
  const scaleY = region.h / CANON_H;
  return {
    style,
    transform: ({ x, y, w, h }) => ({
      x: region.x + (x - CANON_X) * scaleX,
      y: region.y + (y - CANON_TOP) * scaleY,
      w: w * scaleX,
      h: h * scaleY,
    }),
  };
}

const identityContext = (style: StyleScale): RenderContext => ({ style, transform: (rect) => rect });

// Only applied to plain list/card row backgrounds (action rows, matrix rows, comparison panels,
// evidence panels) — not to shapes whose fill carries meaning (an "active" stage, an ownership
// side, a pipeline lane band), where losing the fill would delete signal rather than decoration.
function panelFill(ctx: RenderContext, tone: string): Record<string, unknown> | undefined {
  return ctx.style.decoration === "filled" ? { color: hex(tone) } : undefined;
}

export function hex(value: string): string {
  return value.replace(/^#/, "").toUpperCase();
}

export function addText(slide: Slide, text: string, opts: Record<string, unknown>, rects: Rect[], id: string, fontFace: string, color: string, ctx: RenderContext): void {
  const { x, y, w, h } = ctx.transform({ x: Number(opts.x), y: Number(opts.y), w: Number(opts.w), h: Number(opts.h) });
  rects.push({ id, x, y, w, h, allowOverlap: Boolean(opts.allowOverlap) });
  slide.addText(text, {
    x,
    y,
    w,
    h,
    fontFace,
    color: hex(String(opts.color ?? color)),
    fontSize: Number(opts.fontSize ?? 16) * ctx.style.fontScale,
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

export function addShape(slide: Slide, pptx: Pptx, shapeType: unknown, opts: Record<string, unknown>, rects: Rect[], id: string, ctx: RenderContext): void {
  const { x, y, w, h } = ctx.transform({ x: Number(opts.x), y: Number(opts.y), w: Number(opts.w), h: Number(opts.h) });
  rects.push({ id, x, y, w, h, allowOverlap: Boolean(opts.allowOverlap) });
  const { allowOverlap: _allowOverlap, x: _x, y: _y, w: _w, h: _h, ...rest } = opts;
  slide.addShape(shapeType, { ...rest, x, y, w, h });
}

export function addLine(slide: Slide, pptx: Pptx, x: number, y: number, w: number, h: number, color: string, rects: Rect[], id: string, ctx: RenderContext, arrow = false): void {
  const flipH = w < 0;
  const flipV = h < 0;
  const transformed = ctx.transform({ x: Math.min(x, x + w), y: Math.min(y, y + h), w: Math.max(Math.abs(w), 0.02), h: Math.max(Math.abs(h), 0.02) });
  slide.addShape(pptx.ShapeType.line, {
    x: transformed.x,
    y: transformed.y,
    w: transformed.w,
    h: transformed.h,
    flipH,
    flipV,
    line: {
      color: hex(color),
      width: 1.2,
      endArrowType: arrow ? "triangle" : undefined,
    },
  });
  // Lines are allowed to cross nodes and other lines; only their endpoints are checked by the layout grammar.
  rects.push({ id, x: transformed.x, y: transformed.y, w: transformed.w, h: transformed.h, allowOverlap: true });
}

function addChrome(slide: Slide, pptx: Pptx, deck: RenderDeck, page: number, rects: Rect[], ctx: RenderContext, canvas: { w: number; h: number }): void {
  const theme = deck.theme;
  const ownership = theme.organization?.map.chromeOwnership;
  // Chrome sits at fixed slide-edge coordinates regardless of any layout's contentRegion — an
  // organization template owns or doesn't own it via chromeOwnership, it never gets stretched.
  const chromeCtx = identityContext(ctx.style);
  if (theme.logoPath && (!ownership || ownership.logo === "renderer")) {
    slide.addImage({ path: theme.logoPath, x: canvas.w - CHROME_LOGO_RIGHT_MARGIN, y: 0.22, w: 0.58, h: 0.34, altText: "ppt-agent-logo" });
  }
  if (theme.footer.text && (!ownership || ownership.footer === "renderer")) {
    addText(slide, theme.footer.text, { x: MARGIN_X, y: 7.12, w: 8.8, h: 0.18, fontSize: 8, valign: "mid" }, rects, `footer-${page}`, theme.fonts.body, theme.palette.muted, chromeCtx);
  }
  if (theme.footer.showPageNumber && (!ownership || ownership.pageNumber === "renderer")) {
    addText(slide, String(page), { x: canvas.w - CHROME_PAGE_NUM_RIGHT_MARGIN, y: 7.08, w: 0.48, h: 0.22, fontSize: 9, align: "right", name: "ppt-agent-page-number" }, rects, `page-${page}`, theme.fonts.body, theme.palette.muted, chromeCtx);
  }
}

function addHeadline(slide: Slide, deck: RenderDeck, slideSpec: SlideSpec, rects: Rect[], ctx: RenderContext): void {
  addText(slide, slideSpec.headline, { x: MARGIN_X, y: 0.48, w: 10.9, h: 0.62, fontSize: 26 * deck.theme.grammar.headlineScale / deck.theme.grammar.bodyScale, bold: true, valign: "mid", align: slideSpec.headlineAlignment }, rects, `headline-${slideSpec.id}`, deck.theme.fonts.heading, deck.theme.palette.text, ctx);
}

function renderTitle(slide: Slide, pptx: Pptx, deck: RenderDeck, projectDir: string, spec: Extract<SlideSpec, { layout: "title" }>, rects: Rect[], ctx: RenderContext): void {
  const content = spec.content;
  if (content.kicker) addText(slide, content.kicker.toUpperCase(), { x: MARGIN_X, y: 1.62, w: 5, h: 0.28, fontSize: 11, bold: true }, rects, `${spec.id}-kicker`, deck.theme.fonts.body, deck.theme.palette.accent, ctx);
  addText(slide, spec.headline, { x: MARGIN_X, y: 2.05, w: 10.5, h: 1.4, fontSize: 34 * ctx.style.headlineScale / ctx.style.fontScale, bold: true, valign: "mid", align: spec.headlineAlignment }, rects, `${spec.id}-title`, deck.theme.fonts.heading, deck.theme.palette.text, ctx);
  if (content.subtitle) addText(slide, content.subtitle, { x: MARGIN_X, y: 3.72, w: 8.7, h: 0.62, fontSize: 17 }, rects, `${spec.id}-subtitle`, deck.theme.fonts.body, deck.theme.palette.muted, ctx);
  if (content.imagePath) {
    const imagePath = path.resolve(projectDir, content.imagePath);
    if (!fs.existsSync(imagePath)) throw new Error(`Slide image not found: ${imagePath}`);
    const image = ctx.transform({ x: 9.9, y: 2.0, w: 2.4, h: 2.8 });
    slide.addImage({ path: imagePath, ...image });
    rects.push({ id: `${spec.id}-image`, ...image });
  }
}

function renderStatement(slide: Slide, pptx: Pptx, deck: RenderDeck, spec: Extract<SlideSpec, { layout: "statement" }>, rects: Rect[], ctx: RenderContext): void {
  if (spec.composition === "claim_actions") {
    addText(slide, spec.content.body, { x: MARGIN_X, y: CONTENT_Y + 0.28, w: 4.3, h: 3.95, fontSize: 24 * ctx.style.headlineScale / ctx.style.fontScale, bold: true, valign: "top" }, rects, `${spec.id}-body`, deck.theme.fonts.heading, deck.theme.palette.primary, ctx);
    addText(slide, "ACTIONS / EVIDENCE", { x: 5.5, y: CONTENT_Y + 0.28, w: 5.8, h: 0.28, fontSize: 10, bold: true }, rects, `${spec.id}-actions-label`, deck.theme.fonts.body, deck.theme.palette.accent, ctx);
    spec.content.proofs.forEach((proof, index) => {
      const y = CONTENT_Y + 0.78 + index * 0.78;
      addShape(slide, pptx, pptx.ShapeType.rect, { x: 5.5, y, w: 6.1, h: 0.54, fill: panelFill(ctx, index === 0 ? deck.theme.palette.surface : deck.theme.palette.background), line: { color: hex(deck.theme.palette.border), width: 0.5 }, allowOverlap: true }, rects, `${spec.id}-action-row-${index}`, ctx);
      addShape(slide, pptx, pptx.ShapeType.rect, { x: 5.5, y, w: 0.12, h: 0.54, fill: { color: hex(index === 0 ? deck.theme.palette.accent : deck.theme.palette.border) }, line: { color: hex(index === 0 ? deck.theme.palette.accent : deck.theme.palette.border) }, allowOverlap: true }, rects, `${spec.id}-action-accent-${index}`, ctx);
      addText(slide, proof, { x: 5.78, y: y + 0.12, w: 5.5, h: 0.25, fontSize: 14, bold: index === 0, valign: "mid" }, rects, `${spec.id}-proof-${index}`, deck.theme.fonts.body, deck.theme.palette.text, ctx);
    });
    return;
  }
  addShape(slide, pptx, pptx.ShapeType.rect, { x: MARGIN_X, y: CONTENT_Y + 0.32, w: 0.1, h: 2.02, fill: { color: hex(deck.theme.palette.accent) }, line: { color: hex(deck.theme.palette.accent) } }, rects, `${spec.id}-statement-accent`, ctx);
  addText(slide, spec.content.body, { x: MARGIN_X + 0.24, y: CONTENT_Y + 0.35, w: 6.96, h: 2.0, fontSize: 25 * ctx.style.headlineScale / ctx.style.fontScale, bold: true, valign: "top" }, rects, `${spec.id}-body`, deck.theme.fonts.heading, deck.theme.palette.primary, ctx);
  const proofs = spec.content.proofs;
  if (proofs.length > 0) {
    addText(slide, "EVIDENCE", { x: 8.45, y: CONTENT_Y + 0.35, w: 3.5, h: 0.25, fontSize: 10, bold: true }, rects, `${spec.id}-evidence-label`, deck.theme.fonts.body, deck.theme.palette.accent, ctx);
    proofs.forEach((proof, index) => addText(slide, `• ${proof}`, { x: 8.45, y: CONTENT_Y + 0.78 + index * 0.72, w: 3.7, h: 0.52, fontSize: 15, valign: "top" }, rects, `${spec.id}-proof-${index}`, deck.theme.fonts.body, deck.theme.palette.text, ctx));
  }
}

function renderComparison(slide: Slide, pptx: Pptx, deck: RenderDeck, spec: Extract<SlideSpec, { layout: "comparison" }>, rects: Rect[], ctx: RenderContext): void {
  if (spec.composition === "diagnosis_matrix") {
    const left = spec.content.left;
    const right = spec.content.right;
    addText(slide, left.label, { x: MARGIN_X, y: CONTENT_Y + 0.28, w: 3.65, h: 0.42, fontSize: 22, bold: true }, rects, `${spec.id}-left-label`, deck.theme.fonts.heading, deck.theme.palette.primary, ctx);
    left.items.forEach((item, index) => addText(slide, `• ${item}`, { x: MARGIN_X, y: CONTENT_Y + 0.92 + index * 0.56, w: 3.72, h: 0.34, fontSize: 14, valign: "top" }, rects, `${spec.id}-left-item-${index}`, deck.theme.fonts.body, deck.theme.palette.text, ctx));
    addText(slide, right.label, { x: 4.75, y: CONTENT_Y + 0.28, w: 6.65, h: 0.3, fontSize: 11, bold: true }, rects, `${spec.id}-right-label`, deck.theme.fonts.body, deck.theme.palette.accent, ctx);
    const rows = Math.max(right.items.length, 1);
    right.items.forEach((item, index) => {
      const y = CONTENT_Y + 0.78 + index * (3.1 / rows);
      addShape(slide, pptx, pptx.ShapeType.rect, { x: 4.75, y, w: 6.65, h: 0.48, fill: panelFill(ctx, index === 0 ? deck.theme.palette.surface : deck.theme.palette.background), line: { color: hex(deck.theme.palette.border), width: 0.5 }, allowOverlap: true }, rects, `${spec.id}-matrix-row-${index}`, ctx);
      addText(slide, item, { x: 5.0, y: y + 0.11, w: 6.05, h: 0.24, fontSize: 13, bold: index === 0 }, rects, `${spec.id}-right-item-${index}`, deck.theme.fonts.body, deck.theme.palette.text, ctx);
    });
    if (spec.content.delta) addText(slide, spec.content.delta, { x: 4.75, y: 5.75, w: 6.65, h: 0.38, fontSize: 15, bold: true, align: "right" }, rects, `${spec.id}-delta`, deck.theme.fonts.body, deck.theme.palette.accent, ctx);
    return;
  }
  if (spec.composition === "ownership_split") {
    const sides = [spec.content.left, spec.content.right];
    sides.forEach((side, index) => {
      const x = MARGIN_X + index * 5.95;
      addShape(slide, pptx, pptx.ShapeType.rect, { x, y: CONTENT_Y + 0.2, w: 5.55, h: 4.68, fill: { color: hex(index === 0 ? deck.theme.palette.surface : deck.theme.palette.background) }, line: { color: hex(index === 0 ? deck.theme.palette.primary : deck.theme.palette.accent), width: 1.2 }, allowOverlap: true }, rects, `${spec.id}-ownership-${index}`, ctx);
      addText(slide, side.label, { x: x + 0.3, y: CONTENT_Y + 0.48, w: 4.9, h: 0.42, fontSize: 20, bold: true }, rects, `${spec.id}-label-${index}`, deck.theme.fonts.heading, index === 0 ? deck.theme.palette.primary : deck.theme.palette.accent, ctx);
      side.items.forEach((item, itemIndex) => addText(slide, item, { x: x + 0.3, y: CONTENT_Y + 1.22 + itemIndex * 0.58, w: 4.85, h: 0.33, fontSize: 14, valign: "top" }, rects, `${spec.id}-item-${index}-${itemIndex}`, deck.theme.fonts.body, deck.theme.palette.text, ctx));
    });
    if (spec.content.delta) addText(slide, spec.content.delta, { x: 2.1, y: 6.12, w: 9.0, h: 0.36, fontSize: 15, bold: true, align: "center" }, rects, `${spec.id}-delta`, deck.theme.fonts.body, deck.theme.palette.accent, ctx);
    return;
  }
  const x = MARGIN_X;
  const gap = 0.42;
  const panelW = 5.55;
  const y = CONTENT_Y + 0.18;
  const h = 4.55;
  for (const [index, side] of [spec.content.left, spec.content.right].entries()) {
    const panelX = x + index * (panelW + gap);
    addShape(slide, pptx, pptx.ShapeType.rect, { x: panelX, y, w: panelW, h, fill: panelFill(ctx, deck.theme.palette.surface), line: { color: hex(deck.theme.palette.border), width: 1 }, allowOverlap: true }, rects, `${spec.id}-panel-${index}`, ctx);
    addText(slide, side.label, { x: panelX + 0.28, y: y + 0.25, w: panelW - 0.56, h: 0.35, fontSize: 17, bold: true }, rects, `${spec.id}-label-${index}`, deck.theme.fonts.heading, deck.theme.palette.primary, ctx);
    side.items.forEach((item, itemIndex) => addText(slide, `• ${item}`, { x: panelX + 0.28, y: y + 0.9 + itemIndex * 0.48, w: panelW - 0.56, h: 0.32, fontSize: 14, valign: "top" }, rects, `${spec.id}-item-${index}-${itemIndex}`, deck.theme.fonts.body, deck.theme.palette.text, ctx));
  }
  if (spec.content.delta) addText(slide, spec.content.delta, { x: 4.2, y: 6.12, w: 4.9, h: 0.42, fontSize: 15, bold: true, align: "center" }, rects, `${spec.id}-delta`, deck.theme.fonts.body, deck.theme.palette.accent, ctx);
}

function renderProcess(slide: Slide, pptx: Pptx, deck: RenderDeck, spec: Extract<SlideSpec, { layout: "process" }>, rects: Rect[], ctx: RenderContext): void {
  const steps = spec.content.steps;
  if (spec.composition === "stage_gate") {
    const gap = 0.18;
    const stageW = (11.85 - gap * (steps.length - 1)) / steps.length;
    steps.forEach((step, index) => {
      const x = MARGIN_X + index * (stageW + gap);
      const active = index === 0;
      addShape(slide, pptx, pptx.ShapeType.roundRect, { x, y: CONTENT_Y + 1.05, w: stageW, h: 1.15, rectRadius: 0.04, fill: { color: hex(active ? deck.theme.palette.accent : deck.theme.palette.surface) }, line: { color: hex(active ? deck.theme.palette.accent : deck.theme.palette.border), width: 1 }, allowOverlap: true }, rects, `${spec.id}-stage-${index}`, ctx);
      addText(slide, `Stage ${index + 1}`, { x: x + 0.16, y: CONTENT_Y + 1.26, w: stageW - 0.32, h: 0.2, fontSize: 10, bold: true, align: "center", color: active ? "FFFFFF" : deck.theme.palette.muted }, rects, `${spec.id}-stage-number-${index}`, deck.theme.fonts.body, active ? "FFFFFF" : deck.theme.palette.muted, ctx);
      addText(slide, step.label, { x: x + 0.16, y: CONTENT_Y + 1.48, w: stageW - 0.32, h: 0.58, fontSize: 13, bold: true, align: "center", color: active ? "FFFFFF" : deck.theme.palette.text }, rects, `${spec.id}-stage-label-${index}`, deck.theme.fonts.heading, active ? "FFFFFF" : deck.theme.palette.text, ctx);
      if (step.detail) addText(slide, step.detail, { x: x + 0.08, y: CONTENT_Y + 2.55, w: stageW - 0.16, h: 0.78, fontSize: 11, align: "center", valign: "top" }, rects, `${spec.id}-stage-detail-${index}`, deck.theme.fonts.body, deck.theme.palette.muted, ctx);
    });
    return;
  }
  const startX = MARGIN_X + 0.1;
  const gap = 0.28;
  const stepW = (11.75 - gap * (steps.length - 1)) / steps.length;
  const y = CONTENT_Y + 1.1;
  steps.forEach((step, index) => {
    const x = startX + index * (stepW + gap);
    if (index < steps.length - 1) addLine(slide, pptx, x + stepW - 0.02, y + 0.27, gap + 0.04, 0, deck.theme.palette.accent, rects, `${spec.id}-link-${index}`, ctx, true);
    addShape(slide, pptx, pptx.ShapeType.ellipse, { x, y, w: 0.55, h: 0.55, fill: { color: hex(deck.theme.palette.accent) }, line: { color: hex(deck.theme.palette.accent) }, allowOverlap: true }, rects, `${spec.id}-number-${index}`, ctx);
    addText(slide, String(index + 1), { x, y: y + 0.04, w: 0.55, h: 0.42, fontSize: 13, bold: true, align: "center", color: "FFFFFF" }, rects, `${spec.id}-number-text-${index}`, deck.theme.fonts.body, "FFFFFF", ctx);
    addText(slide, step.label, { x, y: y + 0.82, w: stepW, h: 0.48, fontSize: 16, bold: true, valign: "top" }, rects, `${spec.id}-step-${index}`, deck.theme.fonts.heading, deck.theme.palette.text, ctx);
    if (step.detail) addText(slide, step.detail, { x, y: y + 1.42, w: stepW, h: 0.95, fontSize: 12, valign: "top" }, rects, `${spec.id}-detail-${index}`, deck.theme.fonts.body, deck.theme.palette.muted, ctx);
  });
}

function renderPipeline(slide: Slide, pptx: Pptx, deck: RenderDeck, spec: Extract<SlideSpec, { layout: "pipeline" }>, rects: Rect[], ctx: RenderContext): void {
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
    addShape(slide, pptx, pptx.ShapeType.rect, { x: MARGIN_X, y, w: 11.85, h: laneH - 0.06, fill: { color: index % 2 === 0 ? deck.theme.palette.background : deck.theme.palette.surface }, line: { color: hex(deck.theme.palette.border), width: 0.5 }, allowOverlap: true }, rects, `${spec.id}-lane-${lane.id}`, ctx);
    if (lane.label) addText(slide, lane.label, { x: MARGIN_X + 0.18, y: y + 0.12, w: 1.35, h: 0.26, fontSize: 9, bold: true }, rects, `${spec.id}-lane-label-${lane.id}`, deck.theme.fonts.body, deck.theme.palette.muted, ctx);
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
    addShape(slide, pptx, pptx.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.04, fill: { color: hex(deck.theme.palette.surface) }, line: { color: hex(deck.theme.palette.accent), width: 1.2 }, allowOverlap: true }, rects, `${spec.id}-node-${node.id}`, ctx);
    addText(slide, node.label, { x: x + 0.08, y: y + 0.08, w: w - 0.16, h: h - 0.16, fontSize: 12, bold: true, align: "center" }, rects, `${spec.id}-node-text-${node.id}`, deck.theme.fonts.body, deck.theme.palette.text, ctx);
  });
  edges.forEach((edge, index) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) throw new Error(`Pipeline edge references unknown node: ${edge.from} -> ${edge.to}`);
    addLine(slide, pptx, from.x + from.w, from.y + from.h / 2, to.x - (from.x + from.w), to.y + to.h / 2 - (from.y + from.h / 2), deck.theme.palette.accent, rects, `${spec.id}-edge-${index}`, ctx, true);
    if (edge.label) addText(slide, edge.label, { x: (from.x + from.w + to.x) / 2 - 0.55, y: Math.min(from.y, to.y) - 0.18, w: 1.1, h: 0.18, fontSize: 8, align: "center" }, rects, `${spec.id}-edge-label-${index}`, deck.theme.fonts.body, deck.theme.palette.muted, ctx);
  });
}

function renderArchitecture(slide: Slide, pptx: Pptx, deck: RenderDeck, spec: Extract<SlideSpec, { layout: "architecture" }>, rects: Rect[], ctx: RenderContext): void {
  const zones = spec.content.zones;
  const gap = 0.2;
  const zoneW = (11.85 - gap * (zones.length - 1)) / zones.length;
  const positions = new Map<string, { x: number; y: number; w: number; h: number }>();
  zones.forEach((zone, zoneIndex) => {
    const x = MARGIN_X + zoneIndex * (zoneW + gap);
    const y = CONTENT_Y + 0.1;
    const h = 4.95;
    addShape(slide, pptx, pptx.ShapeType.rect, { x, y, w: zoneW, h, fill: { color: zoneIndex % 2 === 0 ? deck.theme.palette.surface : deck.theme.palette.background }, line: { color: hex(deck.theme.palette.border), width: 1 }, allowOverlap: true }, rects, `${spec.id}-zone-${zone.id}`, ctx);
    addText(slide, zone.label, { x: x + 0.18, y: y + 0.18, w: zoneW - 0.36, h: 0.32, fontSize: 15, bold: true }, rects, `${spec.id}-zone-label-${zone.id}`, deck.theme.fonts.heading, deck.theme.palette.primary, ctx);
    if (zone.description) addText(slide, zone.description, { x: x + 0.18, y: y + 0.58, w: zoneW - 0.36, h: 0.42, fontSize: 10, valign: "top" }, rects, `${spec.id}-zone-desc-${zone.id}`, deck.theme.fonts.body, deck.theme.palette.muted, ctx);
    zone.nodes.forEach((node, nodeIndex) => {
      const nodeY = y + 1.22 + nodeIndex * 0.62;
      const nodeH = 0.42;
      addShape(slide, pptx, pptx.ShapeType.roundRect, { x: x + 0.2, y: nodeY, w: zoneW - 0.4, h: nodeH, fill: { color: hex(deck.theme.palette.background) }, line: { color: hex(deck.theme.palette.border), width: 0.7 }, allowOverlap: true }, rects, `${spec.id}-node-${zone.id}-${nodeIndex}`, ctx);
      addText(slide, node, { x: x + 0.3, y: nodeY + 0.05, w: zoneW - 0.6, h: 0.28, fontSize: 11, align: "center" }, rects, `${spec.id}-node-text-${zone.id}-${nodeIndex}`, deck.theme.fonts.body, deck.theme.palette.text, ctx);
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
    addLine(slide, pptx, startX, startY, endX - startX, endY - startY, deck.theme.palette.accent, rects, `${spec.id}-edge-${index}`, ctx, true);
    if (edge.label) {
      const labelW = 1.8;
      const midX = Math.min(Math.max((startX + endX) / 2 - labelW / 2, MARGIN_X), 13.333 - MARGIN_X - labelW);
      const midY = Math.min(Math.max((startY + endY) / 2 - 0.14, CONTENT_Y + 0.1), 7.5 - 0.3);
      addText(slide, edge.label, { x: midX, y: midY, w: labelW, h: 0.28, fontSize: 9, align: "center", allowOverlap: true }, rects, `${spec.id}-edge-label-${index}`, deck.theme.fonts.body, deck.theme.palette.muted, ctx);
    }
  });
}

function renderQuantitative(slide: Slide, pptx: Pptx, deck: RenderDeck, spec: Extract<SlideSpec, { layout: "quantitative" }>, rects: Rect[], ctx: RenderContext): void {
  const metrics = spec.content.metrics;
  if (spec.composition === "metric_story") {
    const [primary, ...supporting] = metrics;
    addText(slide, primary.label, { x: MARGIN_X, y: CONTENT_Y + 0.48, w: 4.2, h: 0.4, fontSize: 17, bold: true }, rects, `${spec.id}-primary-label`, deck.theme.fonts.body, deck.theme.palette.muted, ctx);
    addText(slide, `${primary.value}${primary.unit ?? ""}`, { x: MARGIN_X, y: CONTENT_Y + 1.02, w: 4.2, h: 1.15, fontSize: 47 * ctx.style.kpiScale / ctx.style.fontScale, bold: true }, rects, `${spec.id}-primary-value`, deck.theme.fonts.heading, deck.theme.palette.primary, ctx);
    if (primary.note) addText(slide, primary.note, { x: MARGIN_X, y: CONTENT_Y + 2.38, w: 4.2, h: 0.68, fontSize: 12, valign: "top" }, rects, `${spec.id}-primary-note`, deck.theme.fonts.body, deck.theme.palette.muted, ctx);
    const supportPitch = 3.95 / Math.max(supporting.length, 1);
    const supportHeight = Math.min(0.58, Math.max(0.4, supportPitch - 0.08));
    supporting.forEach((metric, index) => {
      const y = CONTENT_Y + 0.56 + index * supportPitch;
      addShape(slide, pptx, pptx.ShapeType.rect, { x: 5.2, y, w: 6.15, h: supportHeight, fill: panelFill(ctx, index === 0 ? deck.theme.palette.surface : deck.theme.palette.background), line: { color: hex(deck.theme.palette.border), width: 0.5 }, allowOverlap: true }, rects, `${spec.id}-support-row-${index}`, ctx);
      addText(slide, metric.label, { x: 5.45, y: y + (supportHeight - 0.24) / 2, w: 3.95, h: 0.24, fontSize: 13, bold: index === 0 }, rects, `${spec.id}-support-label-${index}`, deck.theme.fonts.body, deck.theme.palette.text, ctx);
      addText(slide, `${metric.value}${metric.unit ?? ""}`, { x: 9.6, y: y + (supportHeight - 0.24) / 2, w: 1.4, h: 0.24, fontSize: 13, bold: true, align: "right" }, rects, `${spec.id}-support-value-${index}`, deck.theme.fonts.body, deck.theme.palette.accent, ctx);
    });
    return;
  }
  if (spec.composition === "kpi_row") {
    const gap = 0.25 * ctx.style.spacingScale;
    const w = (11.85 - gap * (metrics.length - 1)) / metrics.length;
    metrics.forEach((metric, index) => {
      const x = MARGIN_X + index * (w + gap);
      addText(slide, metric.label, { x, y: CONTENT_Y + 0.5, w, h: 0.42, fontSize: 13, bold: true }, rects, `${spec.id}-label-${index}`, deck.theme.fonts.body, deck.theme.palette.muted, ctx);
      addText(slide, `${metric.value}${metric.unit ?? ""}`, { x, y: CONTENT_Y + 1.18, w, h: 0.9, fontSize: 29 * ctx.style.kpiScale / ctx.style.fontScale, bold: true }, rects, `${spec.id}-value-${index}`, deck.theme.fonts.heading, deck.theme.palette.primary, ctx);
      if (metric.note) addText(slide, metric.note, { x, y: CONTENT_Y + 2.28, w, h: 0.52, fontSize: 11, valign: "top" }, rects, `${spec.id}-note-${index}`, deck.theme.fonts.body, deck.theme.palette.muted, ctx);
      if (index < metrics.length - 1) addLine(slide, pptx, x + w + gap / 2, CONTENT_Y + 0.42, 0, 2.3, deck.theme.palette.border, rects, `${spec.id}-separator-${index}`, ctx);
    });
    return;
  }
  if (spec.composition === "gauge_row") {
    const gap = 0.4 * ctx.style.spacingScale;
    const cellW = (11.85 - gap * (metrics.length - 1)) / metrics.length;
    const size = Math.min(cellW, 2.6 * ctx.style.visualScale, CONTENT_H - 0.6);
    metrics.forEach((metric, index) => {
      const cellX = MARGIN_X + index * (cellW + gap);
      const gaugeX = cellX + (cellW - size) / 2;
      drawGauge(
        slide, pptx, rects, `${spec.id}-gauge-${index}`,
        gaugeX, CONTENT_Y + 0.2, size, metric.value, 100, metric.label,
        { track: deck.theme.palette.border, value: deck.theme.palette.accent, text: deck.theme.palette.text, muted: deck.theme.palette.muted },
        { heading: deck.theme.fonts.heading, body: deck.theme.fonts.body },
        ctx,
      );
    });
    return;
  }
  if (spec.composition === "sparkline_row") {
    const x = MARGIN_X;
    const y = CONTENT_Y + 1.3;
    const w = 11.85;
    const h = Math.min(2.1 * ctx.style.visualScale, CONTENT_H - 1.8);
    drawSparkline(slide, pptx, rects, `${spec.id}-sparkline`, x, y, w, h, metrics.map((metric) => metric.value), deck.theme.palette.accent, ctx);
    metrics.forEach((metric, index) => {
      const labelW = 1.6;
      const center = x + (metrics.length > 1 ? (index / (metrics.length - 1)) * w : w / 2);
      const px = Math.min(Math.max(center - labelW / 2, MARGIN_X), SLIDE_W - MARGIN_X - labelW);
      addText(slide, `${metric.label} ${metric.value}${metric.unit ?? ""}`, { x: px, y: y + h + 0.1, w: labelW, h: 0.3, fontSize: 10, align: "center", allowOverlap: true }, rects, `${spec.id}-sparkline-label-${index}`, deck.theme.fonts.body, deck.theme.palette.muted, ctx);
    });
    return;
  }
  const max = Math.max(...metrics.map((metric) => Math.abs(metric.value)), 1);
  metrics.forEach((metric, index) => {
    const y = CONTENT_Y + 0.38 + index * 0.62;
    addText(slide, metric.label, { x: MARGIN_X, y, w: 2.4, h: 0.28, fontSize: 12 }, rects, `${spec.id}-label-${index}`, deck.theme.fonts.body, deck.theme.palette.text, ctx);
    const barW = 7.7 * Math.abs(metric.value) / max;
    addShape(slide, pptx, pptx.ShapeType.rect, { x: 3.15, y: y + 0.02, w: Math.max(barW, 0.04), h: 0.24, fill: { color: hex(deck.theme.palette.accent) }, line: { color: hex(deck.theme.palette.accent) }, allowOverlap: true }, rects, `${spec.id}-bar-${index}`, ctx);
    addText(slide, `${metric.value}${metric.unit ?? ""}`, { x: 11.15, y, w: 1.2, h: 0.28, fontSize: 12, bold: true, align: "right" }, rects, `${spec.id}-value-${index}`, deck.theme.fonts.body, deck.theme.palette.primary, ctx);
  });
}

function renderTimeline(slide: Slide, pptx: Pptx, deck: RenderDeck, spec: Extract<SlideSpec, { layout: "timeline" }>, rects: Rect[], ctx: RenderContext): void {
  const milestones = spec.content.milestones;
  if (spec.composition === "now_next_later") {
    const groupCount = Math.min(3, milestones.length);
    const gap = 0.24;
    const w = (11.85 - gap * (groupCount - 1)) / groupCount;
    milestones.slice(0, groupCount).forEach((milestone, index) => {
      const x = MARGIN_X + index * (w + gap);
      const active = index === 0;
      addShape(slide, pptx, pptx.ShapeType.rect, { x, y: CONTENT_Y + 1.22, w, h: 2.15, fill: { color: hex(active ? deck.theme.palette.surface : deck.theme.palette.background) }, line: { color: hex(active ? deck.theme.palette.accent : deck.theme.palette.border), width: active ? 1.5 : 0.8 }, allowOverlap: true }, rects, `${spec.id}-period-${index}`, ctx);
      addText(slide, milestone.date, { x: x + 0.24, y: CONTENT_Y + 1.52, w: w - 0.48, h: 0.26, fontSize: 11, bold: true, color: active ? deck.theme.palette.accent : deck.theme.palette.muted }, rects, `${spec.id}-date-${index}`, deck.theme.fonts.body, active ? deck.theme.palette.accent : deck.theme.palette.muted, ctx);
      addText(slide, milestone.label, { x: x + 0.24, y: CONTENT_Y + 1.97, w: w - 0.48, h: 0.45, fontSize: 20, bold: true }, rects, `${spec.id}-label-${index}`, deck.theme.fonts.heading, deck.theme.palette.text, ctx);
      if (milestone.detail) addText(slide, milestone.detail, { x: x + 0.24, y: CONTENT_Y + 2.65, w: w - 0.48, h: 0.42, fontSize: 12, valign: "top" }, rects, `${spec.id}-detail-${index}`, deck.theme.fonts.body, deck.theme.palette.muted, ctx);
    });
    return;
  }
  const startX = MARGIN_X + 0.3;
  const lineW = 11.2;
  const y = CONTENT_Y + 2.05;
  addLine(slide, pptx, startX, y, lineW, 0, deck.theme.palette.accent, rects, `${spec.id}-timeline-line`, ctx);
  milestones.forEach((milestone, index) => {
    const x = startX + (lineW * index) / (milestones.length - 1);
    addShape(slide, pptx, pptx.ShapeType.ellipse, { x: x - 0.12, y: y - 0.12, w: 0.24, h: 0.24, fill: { color: hex(deck.theme.palette.accent) }, line: { color: hex(deck.theme.palette.accent) }, allowOverlap: true }, rects, `${spec.id}-dot-${index}`, ctx);
    addText(slide, milestone.date, { x: x - 0.55, y: y - 0.82, w: 1.1, h: 0.26, fontSize: 10, bold: true, align: "center" }, rects, `${spec.id}-date-${index}`, deck.theme.fonts.body, deck.theme.palette.accent, ctx);
    addText(slide, milestone.label, { x: x - 0.85, y: y + 0.34, w: 1.7, h: 0.5, fontSize: 13, bold: true, align: "center", valign: "top" }, rects, `${spec.id}-label-${index}`, deck.theme.fonts.heading, deck.theme.palette.text, ctx);
    if (milestone.detail) addText(slide, milestone.detail, { x: x - 0.9, y: y + 1.02, w: 1.8, h: 0.6, fontSize: 10, align: "center", valign: "top" }, rects, `${spec.id}-detail-${index}`, deck.theme.fonts.body, deck.theme.palette.muted, ctx);
  });
}

function renderEvidence(slide: Slide, pptx: Pptx, deck: RenderDeck, projectDir: string, spec: Extract<SlideSpec, { layout: "evidence" }>, rects: Rect[], ctx: RenderContext): void {
  if (spec.composition === "evidence_panel" && !spec.content.assetPath) {
    addShape(slide, pptx, pptx.ShapeType.rect, { x: MARGIN_X, y: CONTENT_Y + 0.3, w: 3.75, h: 3.92, fill: panelFill(ctx, deck.theme.palette.surface), line: { color: hex(deck.theme.palette.border), width: 0.7 }, allowOverlap: true }, rects, `${spec.id}-evidence-panel`, ctx);
    if (spec.content.caption) addText(slide, spec.content.caption, { x: MARGIN_X + 0.32, y: CONTENT_Y + 0.7, w: 3.1, h: 1.45, fontSize: 24, bold: true, valign: "top" }, rects, `${spec.id}-caption`, deck.theme.fonts.heading, deck.theme.palette.primary, ctx);
    addText(slide, "SOURCE-BACKED", { x: MARGIN_X + 0.32, y: CONTENT_Y + 3.45, w: 2.8, h: 0.22, fontSize: 10, bold: true }, rects, `${spec.id}-source-label`, deck.theme.fonts.body, deck.theme.palette.accent, ctx);
    spec.content.bullets.forEach((bullet, index) => {
      const y = CONTENT_Y + 0.52 + index * 0.8;
      addShape(slide, pptx, pptx.ShapeType.rect, { x: 4.92, y, w: 6.35, h: 0.58, fill: panelFill(ctx, index === 0 ? deck.theme.palette.surface : deck.theme.palette.background), line: { color: hex(deck.theme.palette.border), width: 0.5 }, allowOverlap: true }, rects, `${spec.id}-evidence-row-${index}`, ctx);
      addText(slide, bullet, { x: 5.18, y: y + 0.14, w: 5.8, h: 0.25, fontSize: 14, bold: index === 0 }, rects, `${spec.id}-bullet-${index}`, deck.theme.fonts.body, deck.theme.palette.text, ctx);
    });
    return;
  }
  if (spec.content.assetPath) {
    const imagePath = path.resolve(projectDir, spec.content.assetPath);
    if (!fs.existsSync(imagePath)) throw new Error(`Evidence image not found: ${imagePath}`);
    const image = ctx.transform({ x: MARGIN_X, y: CONTENT_Y + 0.18, w: 6.55, h: 4.65 });
    slide.addImage({ path: imagePath, ...image });
    rects.push({ id: `${spec.id}-image`, ...image });
    if (spec.content.caption) addText(slide, spec.content.caption, { x: MARGIN_X, y: CONTENT_Y + 4.98, w: 6.55, h: 0.26, fontSize: 9, valign: "top" }, rects, `${spec.id}-caption`, deck.theme.fonts.body, deck.theme.palette.muted, ctx);
  }
  const startX = spec.content.assetPath ? 7.75 : MARGIN_X;
  spec.content.bullets.forEach((bullet, index) => addText(slide, `• ${bullet}`, { x: startX, y: CONTENT_Y + 0.5 + index * 0.72, w: 4.1, h: 0.5, fontSize: 16, valign: "top" }, rects, `${spec.id}-bullet-${index}`, deck.theme.fonts.body, deck.theme.palette.text, ctx));
}

const chartTypeMap: Record<string, { type: string; opts: Record<string, unknown> }> = {
  bar: { type: "bar", opts: {} },
  horizontal_bar: { type: "bar", opts: { barDir: "bar" } },
  stacked_bar: { type: "bar", opts: { barGrouping: "stacked" } },
  line: { type: "line", opts: {} },
  pie: { type: "pie", opts: {} },
  donut: { type: "doughnut", opts: {} },
};

function renderChart(slide: Slide, pptx: Pptx, deck: RenderDeck, spec: Extract<SlideSpec, { layout: "chart" }>, rects: Rect[], contentModel: ContentModel | undefined, ctx: RenderContext): void {
  const dataset = contentModel?.datasets?.find((candidate) => candidate.id === spec.content.dataRef);
  if (!dataset) throw new Error(`Chart dataRef '${spec.content.dataRef}' on slide ${spec.id} is absent from content-model.json datasets. Pass --run-dir with a content-model.json that defines it.`);
  const chartData = dataset.series.map((series) => ({ name: series.name, labels: dataset.categories, values: series.values }));
  const maxH = spec.content.caption ? CONTENT_H - 0.55 : CONTENT_H - 0.15;
  const { x, y, w, h } = ctx.transform({ x: MARGIN_X, y: CONTENT_Y + 0.1 * ctx.style.spacingScale, w: 11.85, h: Math.min(maxH * ctx.style.visualScale, maxH) });
  const mapped = chartTypeMap[spec.content.chartType];
  const crowdedLine = spec.content.chartType === "line" && dataset.series.length >= 4;
  const labelledPie = (spec.content.chartType === "pie" || spec.content.chartType === "donut") && dataset.categories.length >= 5;
  slide.addChart(pptx.ChartType[mapped.type], chartData, {
    x, y, w, h,
    chartColors: deck.theme.data.map(hex),
    chartArea: { fill: { color: hex(deck.theme.palette.background) }, border: { color: hex(deck.theme.palette.divider), pt: 0.5 }, roundedCorners: false },
    plotArea: { fill: { color: hex(deck.theme.palette.surface) }, border: { color: hex(deck.theme.palette.divider), pt: 0.5 } },
    showLegend: dataset.series.length > 1 && !labelledPie,
    legendPos: "b",
    legendFontFace: deck.theme.fonts.body,
    catAxisLabelColor: hex(deck.theme.palette.muted),
    catAxisLabelFontFace: deck.theme.fonts.body,
    valAxisLabelColor: hex(deck.theme.palette.muted),
    valAxisLabelFontFace: deck.theme.fonts.body,
    catGridLine: { color: hex(deck.theme.palette.gridline), style: "solid", size: 0.5 },
    valGridLine: { color: hex(deck.theme.palette.gridline), style: "solid", size: 0.5 },
    dataLabelColor: hex(deck.theme.palette.text),
    dataLabelFontFace: deck.theme.fonts.body,
    showValue: deck.theme.grammar.chartTreatment === "data-first" || deck.theme.grammar.chartTreatment === "decision" || deck.theme.grammar.chartTreatment === "product" || labelledPie,
    showLabel: labelledPie,
    showLeaderLines: labelledPie,
    lineDataSymbol: crowdedLine ? "circle" : "none",
    lineDash: crowdedLine ? "dash" : "solid",
    ...mapped.opts,
  });
  rects.push({ id: `${spec.id}-chart`, x, y, w, h });
  if (spec.content.caption) {
    addText(slide, spec.content.caption, { x, y: y + h + 0.08, w, h: 0.3, fontSize: 11, valign: "top" }, rects, `${spec.id}-caption`, deck.theme.fonts.body, deck.theme.palette.muted, identityContext(ctx.style));
  }
}

function renderSlide(pptx: Pptx, deck: RenderDeck, projectDir: string, spec: SlideSpec, page: number, contentModel: ContentModel | undefined, canvas: { w: number; h: number }): { rects: Rect[] } {
  const slide = pptx.addSlide();
  const ctx = contextFor(deck.theme, spec.layout);
  if (!deck.theme.organization || deck.theme.organization.map.chromeOwnership.background === "renderer") {
    slide.background = { color: hex(deck.theme.palette.background) };
  }
  const rects: Rect[] = [];
  if (spec.layout === "title") {
    renderTitle(slide, pptx, deck, projectDir, spec, rects, ctx);
  } else {
    addHeadline(slide, deck, spec, rects, ctx);
    if (spec.layout === "statement") renderStatement(slide, pptx, deck, spec, rects, ctx);
    if (spec.layout === "comparison") renderComparison(slide, pptx, deck, spec, rects, ctx);
    if (spec.layout === "process") renderProcess(slide, pptx, deck, spec, rects, ctx);
    if (spec.layout === "pipeline") renderPipeline(slide, pptx, deck, spec, rects, ctx);
    if (spec.layout === "architecture") renderArchitecture(slide, pptx, deck, spec, rects, ctx);
    if (spec.layout === "quantitative") renderQuantitative(slide, pptx, deck, spec, rects, ctx);
    if (spec.layout === "timeline") renderTimeline(slide, pptx, deck, spec, rects, ctx);
    if (spec.layout === "evidence") renderEvidence(slide, pptx, deck, projectDir, spec, rects, ctx);
    if (spec.layout === "chart") renderChart(slide, pptx, deck, spec, rects, contentModel, ctx);
  }
  addChrome(slide, pptx, deck, page, rects, ctx, canvas);
  const geometryIssues = validateGeometry(rects, canvas.w, canvas.h);
  if (geometryIssues.length > 0) {
    throw new Error(`Geometry QA failed on ${spec.id}: ${geometryIssues.map((issue) => issue.message).join(" ")}`);
  }
  return { rects };
}

export type RenderResult = { outputPath: string; slideRects: Record<string, Rect[]> };

export async function renderDeck(input: unknown, outputPath: string, projectDir = process.cwd(), options: { pageLimit?: number; contentModel?: ContentModel; referenceSelection?: ReferenceSelectionEntry[] } = {}): Promise<RenderResult> {
  const parsedDeck = deckSchema.parse(input);
  const deck: RenderDeck = { ...parsedDeck, theme: resolvePresentationStyle(parsedDeck.contract, { projectDir, referenceSelection: options.referenceSelection, legacyTheme: parsedDeck.theme }) };
  if (!deck.theme.organization && deck.contract.aspectRatio !== "16:9") {
    throw new Error("The deterministic renderer only supports 16:9. A 4:3 Company Template Pack must use the native-template-fill workflow.");
  }
  if (!options.pageLimit && deck.contract.slideCount !== deck.slides.length) throw new Error(`Contract slideCount ${deck.contract.slideCount} does not match ${deck.slides.length} slides.`);
  assertFontsInstalled(deck.theme.fonts);

  const canvas = CANVAS_DIMENSIONS[deck.contract.aspectRatio];
  const pptx: Pptx = new (pptxgen as any)();
  pptx.layout = canvas.pptxLayout;
  pptx.author = "Claude Code /ppt";
  pptx.subject = deck.contract.purpose;
  pptx.title = deck.title;
  pptx.company = "";
  pptx.lang = deck.contract.language;
  pptx.theme = { headFontFace: deck.theme.fonts.heading, bodyFontFace: deck.theme.fonts.body, lang: deck.contract.language };

  const slideRects: Record<string, Rect[]> = {};
  deck.slides.slice(0, options.pageLimit).forEach((spec, index) => {
    slideRects[spec.id] = renderSlide(pptx, deck, projectDir, spec, index + 1, options.contentModel, canvas).rects;
  });
  const resolvedOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  const scratchPath = deck.theme.organization
    ? path.join(path.dirname(resolvedOutput), `.ppt-agent-semantic-${process.pid}-${Date.now()}.pptx`)
    : resolvedOutput;
  await pptx.writeFile({ fileName: scratchPath });
  if (deck.theme.organization) {
    try {
      await applyOrganizationTemplate(scratchPath, resolvedOutput, deck.theme, deck.slides.slice(0, options.pageLimit));
    } finally {
      if (fs.existsSync(scratchPath)) fs.rmSync(scratchPath, { force: true });
    }
  }
  return { outputPath: resolvedOutput, slideRects };
}
