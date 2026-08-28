import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import pptxgen from "pptxgenjs";
import { defaultContentRegion, renderDeck } from "../../src/renderer";
import { deckSchema } from "../../src/schema";
import { readPptxOoxml } from "../../src/ooxml";

const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/deck.json"), "utf8"));

describe("organization template adapter", () => {
  it("fills a native template while preserving semantic slide count and editability", async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-template-test-"));
    const scratch = path.join(runDir, "scratch.pptx");
    await renderDeck(fixture, scratch, process.cwd());

    const organizationDir = path.join(runDir, "organization");
    fs.mkdirSync(organizationDir, { recursive: true });
    fs.copyFileSync(scratch, path.join(organizationDir, "template.pptx"));
    fs.writeFileSync(path.join(organizationDir, "brand.yaml"), [
      "name: Adapter Test",
      "palette:",
      '  background: "FFFFFF"',
      '  surface: "FFFFFF"',
      '  text: "111111"',
      '  primary: "123456"',
      '  accent: "654321"',
      '  muted: "666666"',
      '  border: "DDDDDD"',
      "footer:",
      "  showPageNumber: true",
      "  text: Adapter",
    ].join("\n"));
    fs.writeFileSync(path.join(organizationDir, "template-map.json"), JSON.stringify({
      version: 1,
      chromeOwnership: { background: "template", logo: "template", footer: "template", pageNumber: "template" },
      defaultLayout: { nativeLayout: "DEFAULT", canvasColor: "FFFFFF", contentRegion: { x: 0.72, y: 0.48, w: 11.85, h: 6.14 }, reservedRegions: [] },
      layouts: {},
      requiredElements: [],
    }));

    const deck = deckSchema.parse({ ...fixture, contract: { ...fixture.contract, organization: { kind: "directory", path: organizationDir } } });
    const output = path.join(runDir, "filled.pptx");
    await renderDeck(deck, output, process.cwd());
    const facts = await readPptxOoxml(output);
    expect(facts.parseOk).toBe(true);
    expect(facts.slideCount).toBe(deck.slides.length);
    expect(facts.slides.some((slide) => slide.nativeObjects.text > 0)).toBe(true);
  }, 30000);

  it("places semantic content inside a layout's declared contentRegion instead of the default canvas margins", async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-template-region-"));
    const scratch = path.join(runDir, "scratch.pptx");
    const baseline = await renderDeck(fixture, scratch, process.cwd());
    const baselineRects = baseline.slideRects.S02.filter((rect) => !rect.id.startsWith("footer-") && !rect.id.startsWith("page-"));
    // Sanity: the un-transformed baseline is not already inside the region under test, so a
    // passing assertion below proves the transform did something rather than nothing.
    const region = { x: 1.5, y: 2.0, w: 6.0, h: 3.0 };
    expect(baselineRects.some((rect) => rect.x + rect.w > region.x + region.w + 0.05 || rect.y + rect.h > region.y + region.h + 0.05)).toBe(true);

    const organizationDir = path.join(runDir, "organization");
    fs.mkdirSync(organizationDir, { recursive: true });
    fs.copyFileSync(scratch, path.join(organizationDir, "template.pptx"));
    fs.writeFileSync(path.join(organizationDir, "brand.yaml"), [
      "name: Region Test",
      "palette:",
      '  background: "FFFFFF"',
      '  surface: "FFFFFF"',
      '  text: "111111"',
      '  primary: "123456"',
      '  accent: "654321"',
      '  muted: "666666"',
      '  border: "DDDDDD"',
    ].join("\n"));
    fs.writeFileSync(path.join(organizationDir, "template-map.json"), JSON.stringify({
      version: 1,
      chromeOwnership: { background: "renderer", logo: "renderer", footer: "renderer", pageNumber: "renderer" },
      defaultLayout: { nativeLayout: "DEFAULT", canvasColor: "FFFFFF", contentRegion: { x: 0.72, y: 0.48, w: 11.85, h: 6.14 }, reservedRegions: [] },
      layouts: { comparison: { nativeLayout: "DEFAULT", canvasColor: "FFFFFF", contentRegion: region, reservedRegions: [] } },
      requiredElements: [],
    }));

    const deck = deckSchema.parse({ ...fixture, contract: { ...fixture.contract, organization: { kind: "directory", path: organizationDir } } });
    const output = path.join(runDir, "filled.pptx");
    const result = await renderDeck(deck, output, process.cwd());
    const epsilon = 0.05;
    const comparisonRects = result.slideRects.S02.filter((rect) => !rect.id.startsWith("footer-") && !rect.id.startsWith("page-"));
    expect(comparisonRects.length).toBeGreaterThan(0);
    comparisonRects.forEach((rect) => {
      expect(rect.x).toBeGreaterThanOrEqual(region.x - epsilon);
      expect(rect.y).toBeGreaterThanOrEqual(region.y - epsilon);
      expect(rect.x + rect.w).toBeLessThanOrEqual(region.x + region.w + epsilon);
      expect(rect.y + rect.h).toBeLessThanOrEqual(region.y + region.h + epsilon);
    });
  }, 30000);

  it("reproduces the renderer's own default geometry exactly when a template declares defaultContentRegion", async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-template-identity-"));
    const scratch = path.join(runDir, "scratch.pptx");
    const baseline = await renderDeck(fixture, scratch, process.cwd());

    const organizationDir = path.join(runDir, "organization");
    fs.mkdirSync(organizationDir, { recursive: true });
    fs.copyFileSync(scratch, path.join(organizationDir, "template.pptx"));
    fs.writeFileSync(path.join(organizationDir, "brand.yaml"), [
      "name: Identity Test",
      "palette:",
      '  background: "FFFFFF"',
      '  surface: "FFFFFF"',
      '  text: "111111"',
      '  primary: "123456"',
      '  accent: "654321"',
      '  muted: "666666"',
      '  border: "DDDDDD"',
    ].join("\n"));
    fs.writeFileSync(path.join(organizationDir, "template-map.json"), JSON.stringify({
      version: 1,
      chromeOwnership: { background: "renderer", logo: "renderer", footer: "renderer", pageNumber: "renderer" },
      defaultLayout: { nativeLayout: "DEFAULT", canvasColor: "FFFFFF", contentRegion: defaultContentRegion, reservedRegions: [] },
      layouts: {},
      requiredElements: [],
    }));

    const deck = deckSchema.parse({ ...fixture, contract: { ...fixture.contract, organization: { kind: "directory", path: organizationDir } } });
    const output = path.join(runDir, "filled.pptx");
    const result = await renderDeck(deck, output, process.cwd());
    for (const slideId of Object.keys(baseline.slideRects)) {
      expect(result.slideRects[slideId]).toEqual(baseline.slideRects[slideId]);
    }
  }, 30000);

  it("renders onto a 4:3 organization template, placing content inside its declared region and the true 10x7.5 canvas", async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-template-43-"));

    // renderDeck can't itself produce a 4:3 scratch deck without an organization pack already
    // attached (chicken/egg), so build a genuine 4:3 template.pptx directly with pptxgenjs —
    // the same library the renderer itself uses for the scratch deck.
    const templatePptx = new (pptxgen as any)();
    templatePptx.layout = "LAYOUT_4x3";
    templatePptx.addSlide();
    const templatePath = path.join(runDir, "template-source.pptx");
    await templatePptx.writeFile({ fileName: templatePath });

    const organizationDir = path.join(runDir, "organization");
    fs.mkdirSync(organizationDir, { recursive: true });
    fs.copyFileSync(templatePath, path.join(organizationDir, "template.pptx"));
    fs.writeFileSync(path.join(organizationDir, "brand.yaml"), [
      "name: 4:3 Test",
      "palette:",
      '  background: "FFFFFF"',
      '  surface: "FFFFFF"',
      '  text: "111111"',
      '  primary: "123456"',
      '  accent: "654321"',
      '  muted: "666666"',
      '  border: "DDDDDD"',
    ].join("\n"));
    const region = { x: 0.5, y: 0.5, w: 9, h: 6.3 };
    fs.writeFileSync(path.join(organizationDir, "template-map.json"), JSON.stringify({
      version: 1,
      aspectRatio: "4:3",
      chromeOwnership: { background: "renderer", logo: "renderer", footer: "renderer", pageNumber: "renderer" },
      defaultLayout: { nativeLayout: "DEFAULT", canvasColor: "FFFFFF", contentRegion: region, reservedRegions: [] },
      layouts: {},
      requiredElements: [],
    }));

    const deck = deckSchema.parse({ ...fixture, contract: { ...fixture.contract, aspectRatio: "4:3", organization: { kind: "directory", path: organizationDir } } });
    const output = path.join(runDir, "filled.pptx");
    const result = await renderDeck(deck, output, process.cwd());
    const facts = await readPptxOoxml(output);
    expect(facts.parseOk).toBe(true);
    expect(facts.slideCount).toBe(deck.slides.length);

    const epsilon = 0.05;
    for (const rects of Object.values(result.slideRects)) {
      rects.forEach((rect) => {
        // Every rect (including renderer-owned chrome) must fit the true 10x7.5 canvas, not the
        // 13.333-wide 16:9 canvas — this is what catches canvas width not reaching chrome/geometry QA.
        expect(rect.x + rect.w).toBeLessThanOrEqual(10 + epsilon);
        expect(rect.y + rect.h).toBeLessThanOrEqual(7.5 + epsilon);
      });
      const bodyRects = rects.filter((rect) => !rect.id.startsWith("footer-") && !rect.id.startsWith("page-"));
      bodyRects.forEach((rect) => {
        expect(rect.x).toBeGreaterThanOrEqual(region.x - epsilon);
        expect(rect.y).toBeGreaterThanOrEqual(region.y - epsilon);
        expect(rect.x + rect.w).toBeLessThanOrEqual(region.x + region.w + epsilon);
        expect(rect.y + rect.h).toBeLessThanOrEqual(region.y + region.h + epsilon);
      });
    }
  }, 30000);
});
