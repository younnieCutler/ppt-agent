export type Rect = { id: string; x: number; y: number; w: number; h: number; allowOverlap?: boolean };
export type GeometryIssue = { code: "OFF_CANVAS" | "COLLISION"; ids: string[]; message: string };

export const CANVAS_DIMENSIONS = {
  "16:9": { w: 13.333, h: 7.5, pptxLayout: "LAYOUT_WIDE" },
  "4:3": { w: 10, h: 7.5, pptxLayout: "LAYOUT_4x3" },
} as const;

const EPSILON = 0.01;

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w - EPSILON && a.x + a.w > b.x + EPSILON && a.y < b.y + b.h - EPSILON && a.y + a.h > b.y + EPSILON;
}

export function validateGeometry(rects: Rect[], slideW = 13.333, slideH = 7.5): GeometryIssue[] {
  const issues: GeometryIssue[] = [];
  for (const rect of rects) {
    if (rect.x < -EPSILON || rect.y < -EPSILON || rect.w <= 0 || rect.h <= 0 || rect.x + rect.w > slideW + EPSILON || rect.y + rect.h > slideH + EPSILON) {
      issues.push({ code: "OFF_CANVAS", ids: [rect.id], message: `${rect.id} is outside the ${slideW}x${slideH}in slide canvas.` });
    }
  }
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      if (!a.allowOverlap && !b.allowOverlap && overlaps(a, b)) {
        issues.push({ code: "COLLISION", ids: [a.id, b.id], message: `${a.id} collides with ${b.id}.` });
      }
    }
  }
  return issues;
}
