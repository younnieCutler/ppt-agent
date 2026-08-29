import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pptxgen from "pptxgenjs";

/**
 * A public, synthetic, source-slide-driven template: 3 slides sharing pptxgenjs's one default
 * (near-empty) layout, each with a genuinely different rich body — the same shape GAO's real
 * template has (design lives in the slide bodies, not the master/layout), without any
 * company-specific or GAO string. No .pptx is committed; this builds a fresh one at test time,
 * matching the convention in tests/unit/template-elements.test.ts.
 */
export const FIXTURE_STRINGS = {
  coverTitle: "FIXTURE_EXAMPLE_HEADLINE dark cover",
  coverSubtitle: "FIXTURE_EXAMPLE_SUBTITLE",
  editorialHeading: "FIXTURE_EXAMPLE_EDITORIAL_HEADING",
  editorialBody: "FIXTURE_EXAMPLE_BODY_PARAGRAPH with several sentences of placeholder editorial copy.",
  editorialCaption: "FIXTURE_EXAMPLE_CAPTION",
  keyMessage: "FIXTURE_EXAMPLE_KEY_MESSAGE the one thing that matters",
} as const;

export async function buildPatternFixture(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-pattern-fixture-"));
  const output = path.join(dir, "template.pptx");
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";

  // S01 — dark cover.
  const cover = pptx.addSlide();
  cover.background = { color: "111111" };
  cover.addText(FIXTURE_STRINGS.coverTitle, { x: 0.85, y: 2.6, w: 10, h: 1.4, fontSize: 44, bold: true, color: "FFFFFF", fontFace: "Georgia", name: "Cover Title" });
  cover.addText(FIXTURE_STRINGS.coverSubtitle, { x: 0.85, y: 4.0, w: 8, h: 0.6, fontSize: 20, color: "CCCCCC", name: "Cover Subtitle" });
  cover.addShape(pptx.ShapeType.rect, { x: 0.85, y: 0.5, w: 1.5, h: 0.08, fill: { color: "E4572E" }, name: "Cover Accent Bar" });

  // S02 — light editorial body.
  const body = pptx.addSlide();
  body.background = { color: "F5F1E8" };
  body.addText(FIXTURE_STRINGS.editorialHeading, { x: 0.85, y: 0.6, w: 8, h: 0.7, fontSize: 28, bold: true, color: "1A1A1A", name: "Body Heading" });
  body.addShape(pptx.ShapeType.line, { x: 0.85, y: 1.5, w: 5, h: 0, line: { color: "1A1A1A", width: 1 }, name: "Body Divider" });
  body.addText(FIXTURE_STRINGS.editorialBody, { x: 0.85, y: 1.8, w: 7, h: 2, fontSize: 16, color: "333333", name: "Body Paragraph" });
  body.addText(FIXTURE_STRINGS.editorialCaption, { x: 0.85, y: 6.6, w: 5, h: 0.4, fontSize: 11, italic: true, color: "666666", name: "Body Caption" });

  // S03 — black key-message band.
  const keyMessage = pptx.addSlide();
  keyMessage.background = { color: "FFFFFF" };
  keyMessage.addShape(pptx.ShapeType.rect, { x: 0, y: 2.6, w: 13.33, h: 2.3, fill: { color: "111111" }, name: "Key Message Band" });
  keyMessage.addText(FIXTURE_STRINGS.keyMessage, { x: 1.2, y: 3.2, w: 10.9, h: 1.1, fontSize: 30, bold: true, color: "FFFFFF", name: "Key Message Text" });
  keyMessage.addText("03", { x: 0.4, y: 0.4, w: 1, h: 0.6, fontSize: 18, bold: true, color: "2A6FB0", name: "Section Number" });

  await pptx.writeFile({ fileName: output });
  return output;
}
