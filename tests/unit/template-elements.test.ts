import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pptxgen from "pptxgenjs";
import { describe, expect, it } from "vitest";
import { extractTemplateElements } from "../../src/template-analysis";

async function fixture(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-template-elements-"));
  const output = path.join(dir, "template.pptx");
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  const slide = pptx.addSlide();
  slide.addText("Confidential example sentence", { x: 0.85, y: 0.7, w: 6, h: 0.5, fontFace: "Noto Sans JP", fontSize: 24, bold: true, color: "123456", name: "Title" });
  slide.addShape(pptx.ShapeType.rect, { x: 0.85, y: 1.5, w: 2, h: 1, fill: { color: "EEEEEE" }, name: "Metric" });
  slide.addShape(pptx.ShapeType.line, { x: 0.85, y: 2.7, w: 4, h: 0, line: { color: "123456" } });
  slide.addImage({ data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+QyaA5AAAAABJRU5ErkJggg==", x: 5, y: 1.5, w: 1, h: 1 });
  slide.addTable([[{ text: "A" }, { text: "B" }]], { x: 0.85, y: 3, w: 3, h: 0.5 });
  slide.addChart(pptx.ChartType.bar, [{ name: "Series", labels: ["A"], values: [1] }], { x: 5, y: 3, w: 3, h: 2 });
  await pptx.writeFile({ fileName: output });
  return output;
}

describe("template element extraction", () => {
  it("extracts copy-free native body elements and a deduplicated style registry", async () => {
    const result = await extractTemplateElements(await fixture());
    expect(result.version).toBe(1);
    expect(result.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.slides).toHaveLength(1);
    expect(new Set(result.slides.flatMap((slide) => slide.elements.map((element) => element.type)))).toEqual(new Set(["text", "shape", "line", "image", "chart", "table"]));
    expect(Object.keys(result.styles)).not.toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("Confidential example sentence");
  });
});
