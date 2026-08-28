import type { Rect } from "./geometry";
import { addLine, addShape, addText, hex } from "./renderer";

type Slide = any;
type Pptx = any;

// ponytail: SVG icon primitives were dropped from P1 after a compatibility gate check —
// pptxgenjs's SVG embedding writes the raw SVG bytes into the PNG fallback slot instead of
// rasterizing it, so PowerPoint renders a blank shape. Revisit if pptxgenjs adds real SVG
// rasterization, or if a raster pre-conversion step is added upstream.

export function drawGauge(
  slide: Slide,
  pptx: Pptx,
  rects: Rect[],
  id: string,
  x: number,
  y: number,
  size: number,
  value: number,
  max: number,
  label: string,
  colors: { track: string; value: string; text: string; muted: string },
  fonts: { heading: string; body: string },
): void {
  const pct = Math.max(0, Math.min(1, value / max));
  const valueAngleEnd = 180 - pct * 180;
  addShape(slide, pptx, pptx.ShapeType.blockArc, { x, y, w: size, h: size, angleRange: [180, 0], arcThicknessRatio: 0.28, fill: { color: hex(colors.track) }, line: { color: hex(colors.track) }, allowOverlap: true }, rects, `${id}-track`);
  if (pct > 0) {
    addShape(slide, pptx, pptx.ShapeType.blockArc, { x, y, w: size, h: size, angleRange: [180, valueAngleEnd], arcThicknessRatio: 0.28, fill: { color: hex(colors.value) }, line: { color: hex(colors.value) }, allowOverlap: true }, rects, `${id}-value`);
  }
  addText(slide, `${Math.round(pct * 100)}%`, { x, y: y + size * 0.32, w: size, h: size * 0.32, fontSize: Math.max(14, size * 9), bold: true, align: "center", valign: "mid", allowOverlap: true }, rects, `${id}-value-text`, fonts.heading, colors.text);
  addText(slide, label, { x, y: y + size * 0.62, w: size, h: 0.3, fontSize: 11, align: "center", allowOverlap: true }, rects, `${id}-label`, fonts.body, colors.muted);
}

export function drawSparkline(slide: Slide, pptx: Pptx, rects: Rect[], id: string, x: number, y: number, w: number, h: number, values: number[], color: string): void {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1e-6);
  const points = values.map((value, index) => ({
    x: x + (values.length > 1 ? (index / (values.length - 1)) * w : w / 2),
    y: y + h - ((value - min) / span) * h,
  }));
  for (let index = 0; index < points.length - 1; index += 1) {
    addLine(slide, pptx, points[index].x, points[index].y, points[index + 1].x - points[index].x, points[index + 1].y - points[index].y, color, rects, `${id}-segment-${index}`);
  }
}
