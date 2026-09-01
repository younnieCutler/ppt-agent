import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import pptxgen from "pptxgenjs";
import { describe, expect, it } from "vitest";
import type { TemplateConstraintProfile } from "../../src/brand-constraints";
import { renderGenerativeNativePrimitives } from "../../src/generative-native-primitives";
import type { ResolvedGenerativeScene } from "../../src/generative-scene";
import { validatePptxPackage } from "../../src/package-integrity";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4xQAAAAASUVORK5CYII=", "base64");

async function sourceDeck(filePath: string): Promise<void> {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  const slide = pptx.addSlide();
  slide.background = { color: "FFFFFF" };
  slide.addText("Template source", { x: 0.8, y: 0.5, w: 4, h: 0.4, fontFace: "Arial", fontSize: 20, color: "17324D" });
  await pptx.writeFile({ fileName: filePath });
}

function profile(): TemplateConstraintProfile {
  return {
    version: 1,
    compilerVersion: "1",
    sourceDigest: "a".repeat(64),
    elementsDigest: "b".repeat(64),
    canvas: { w: 13.333, h: 7.5 },
    immutableRegions: [],
    contentRegions: [{ id: "content-main", bounds: { x: 0.8, y: 0.7, w: 11.7, h: 6 } }],
    styleVocabulary: {
      fonts: ["Arial"],
      textColors: ["17324D"],
      fillColors: ["FFFFFF", "E9EEF2"],
      strokeColors: ["17324D"],
      backgroundColors: ["FFFFFF"],
      textRoles: ["title", "body", "label"],
    },
    policies: { chrome: "immutable", colors: "template_only", fonts: "template_only" },
  };
}

function scene(): ResolvedGenerativeScene {
  return {
    version: 3,
    slideId: "S02",
    semanticIntent: "architecture",
    headline: "Native primitives",
    contentRegionId: "content-main",
    contentRegion: { x: 0.8, y: 0.7, w: 11.7, h: 6 },
    nodes: [
      {
        id: "flow",
        role: "connector",
        frame: { x: 0.08, y: 0.2, w: 0.34, h: 0.1 },
        bounds: { x: 1.736, y: 1.9, w: 3.978, h: 0.6 },
        emphasis: 0.6,
        orientation: "horizontal",
        arrow: "end",
        weight: "regular",
      },
      {
        id: "chart",
        role: "chart",
        frame: { x: 0.48, y: 0.12, w: 0.42, h: 0.48 },
        bounds: { x: 6.416, y: 1.42, w: 4.914, h: 2.88 },
        emphasis: 0.9,
        datasetRef: "sales",
        chartType: "bar",
      },
      {
        id: "photo",
        role: "image",
        frame: { x: 0.08, y: 0.42, w: 0.16, h: 0.28 },
        bounds: { x: 1.736, y: 3.22, w: 1.872, h: 1.68 },
        emphasis: 0.5,
        assetRef: "pixel",
        fit: "cover",
      },
      {
        id: "icon",
        role: "icon",
        frame: { x: 0.28, y: 0.42, w: 0.1, h: 0.18 },
        bounds: { x: 4.076, y: 3.22, w: 1.17, h: 1.08 },
        emphasis: 0.5,
        assetRef: "pixel",
        fit: "contain",
      },
    ],
    brandConstraintDigestInput: { sourceDigest: "a".repeat(64), elementsDigest: "b".repeat(64), compilerVersion: "1" },
  };
}

describe("Generative Scene v3 native primitives", () => {
  it("renders connector, chart, image and icon as editable native PPTX objects without package regression", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-native-primitives-"));
    try {
      const source = path.join(dir, "source.pptx");
      const output = path.join(dir, "output.pptx");
      const image = path.join(dir, "pixel.png");
      fs.writeFileSync(image, PNG_1X1);
      await sourceDeck(source);

      const result = await renderGenerativeNativePrimitives(source, output, scene(), profile(), {
        datasets: { sales: { categories: ["A", "B", "C"], series: [{ name: "Revenue", values: [12, 18, 27] }] } },
        images: { pixel: image },
      });
      expect(result.renderedNodeIds.sort()).toEqual(["chart", "flow", "icon", "photo"]);
      expect(fs.existsSync(output)).toBe(true);

      const zip = await JSZip.loadAsync(fs.readFileSync(output));
      const slideXml = (await Promise.all(Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map((name) => zip.file(name)!.async("string")))).join("\n");
      expect(slideXml).toContain("generative.native.flow");
      expect(slideXml).toContain("generative.native.chart");
      expect(slideXml).toContain("generative.native.photo");
      expect(slideXml).toContain("generative.native.icon");
      expect(Object.keys(zip.files).some((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name))).toBe(true);
      expect(Object.keys(zip.files).some((name) => /^ppt\/media\//.test(name))).toBe(true);

      const integrity = await validatePptxPackage(output, { originalPath: source });
      expect(integrity.newFindings).toEqual([]);
      expect(integrity.status).toBe("pass");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
