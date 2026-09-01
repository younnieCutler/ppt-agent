import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import pptxgen from "pptxgenjs";
import { describe, expect, it } from "vitest";
import { validatePptxPackage } from "../../src/package-integrity";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4xQAAAAASUVORK5CYII=", "base64");

async function writeDeck(filePath: string, texts: string[], imagePath?: string): Promise<void> {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  const slide = pptx.addSlide();
  slide.background = { color: "FFFFFF" };
  texts.forEach((text, index) => slide.addText(text, { x: 1, y: 1 + index * 0.6, w: 6, h: 0.4, fontFace: "Arial", fontSize: 18 }));
  if (imagePath) slide.addImage({ path: imagePath, x: 9, y: 1, w: 1, h: 1 });
  await pptx.writeFile({ fileName: filePath });
}

describe("baseline-aware package integrity", () => {
  it("exempts placeholder-like content inherited from the original template but rejects newly introduced placeholders", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-package-placeholder-"));
    try {
      const original = path.join(dir, "template.pptx");
      const generated = path.join(dir, "generated.pptx");
      await writeDeck(original, ["Recipient"]);
      await writeDeck(generated, ["Recipient", "TODO: replace this"]);

      const report = await validatePptxPackage(generated, { originalPath: original });
      expect(report.status).toBe("fail");
      expect(report.findings.some((finding) => finding.code === "PLACEHOLDER_CONTENT_LEAK" && finding.inherited)).toBe(true);
      expect(report.newFindings.filter((finding) => finding.code === "PLACEHOLDER_CONTENT_LEAK")).toHaveLength(1);
      expect(report.newFindings[0].message).toContain("TODO");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects a relationship target removed by the generator as a new package regression", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-package-rel-"));
    try {
      const original = path.join(dir, "template.pptx");
      const generated = path.join(dir, "generated.pptx");
      const image = path.join(dir, "pixel.png");
      fs.writeFileSync(image, PNG_1X1);
      await writeDeck(original, ["Valid package"], image);

      const zip = await JSZip.loadAsync(fs.readFileSync(original));
      const mediaPart = Object.keys(zip.files).find((name) => /^ppt\/media\//.test(name) && !zip.files[name].dir);
      expect(mediaPart).toBeTruthy();
      zip.remove(mediaPart!);
      fs.writeFileSync(generated, await zip.generateAsync({ type: "nodebuffer" }));

      const report = await validatePptxPackage(generated, { originalPath: original });
      expect(report.status).toBe("fail");
      expect(report.newFindings.some((finding) => finding.code === "PACKAGE_RELATIONSHIP_TARGET_MISSING")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
