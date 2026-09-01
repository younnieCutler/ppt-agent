import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pptxgen from "pptxgenjs";

export const SCENE_FIXTURE_STRINGS = {
  cover: "SCENE_FIXTURE_COVER",
  bodyTitle: "SCENE_FIXTURE_BODY_TITLE",
  body: "SCENE_FIXTURE_BODY_COPY",
  metricTitle: "SCENE_FIXTURE_METRIC_TITLE",
  metricExample: "99%",
} as const;

export async function buildSceneFixture(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-scene-fixture-"));
  const output = path.join(dir, "template.pptx");
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";

  const cover = pptx.addSlide();
  cover.background = { color: "111827" };
  cover.addText(SCENE_FIXTURE_STRINGS.cover, { x: 0.9, y: 2.7, w: 10.5, h: 1, fontFace: "Aptos Display", fontSize: 38, bold: true, color: "FFFFFF", name: "Cover Title" });

  const body = pptx.addSlide();
  body.background = { color: "F7F4ED" };
  body.addText(SCENE_FIXTURE_STRINGS.bodyTitle, { x: 0.9, y: 0.65, w: 9.5, h: 0.7, fontFace: "Aptos", fontSize: 28, bold: true, color: "172033", name: "Body Title" });
  body.addShape(pptx.ShapeType.line, { x: 0.9, y: 1.55, w: 4.8, h: 0, line: { color: "6B7280", width: 1 }, name: "Body Divider" });
  body.addText(SCENE_FIXTURE_STRINGS.body, { x: 0.9, y: 1.9, w: 8.5, h: 1.4, fontFace: "Aptos", fontSize: 17, color: "374151", name: "Body Copy" });

  const metric = pptx.addSlide();
  metric.background = { color: "F7F4ED" };
  metric.addText(SCENE_FIXTURE_STRINGS.metricTitle, { x: 0.9, y: 0.65, w: 9.5, h: 0.7, fontFace: "Aptos", fontSize: 28, bold: true, color: "172033", name: "Metric Title" });
  metric.addText(SCENE_FIXTURE_STRINGS.metricExample, { x: 0.9, y: 2.4, w: 11.2, h: 1.2, fontFace: "Aptos Display", fontSize: 46, bold: true, color: "2357B8", name: "KPI Metric" });

  await pptx.writeFile({ fileName: output });
  return output;
}
