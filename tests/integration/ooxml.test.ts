import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderDeck } from "../../src/renderer";
import { ooxmlQa } from "../../src/qa";
import { contentModelSchema, deckSchema } from "../../src/schema";
import { resolvePresentationStyle } from "../../src/style";
import JSZip from "jszip";

// Cross-platform equivalent of the PowerShell/PowerPoint-COM checks in tests/integration/render.test.ts.
// Runs on every OS (no PowerPoint dependency) so Core QA has real coverage on macOS/Linux CI.

const fixture = deckSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/all-layouts.json"), "utf8")));
const contentModel = contentModelSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/content-model-all-layouts.json"), "utf8")));
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-ooxml-"));

afterAll(() => fs.rmSync(runDir, { recursive: true, force: true }));

describe("OOXML-based Core QA", () => {
  it("finds no findings against a deck rendered with its own confirmed fonts and derived native objects", async () => {
    const pptxPath = path.join(runDir, "all-layouts.pptx");
    await renderDeck(fixture, pptxPath, process.cwd(), { contentModel });
    const findings = await ooxmlQa(pptxPath, fixture);
    expect(findings).toEqual([]);
  }, 30000);

  it("flags a font that was never confirmed in the contract", async () => {
    const pptxPath = path.join(runDir, "all-layouts.pptx");
    const substituted = deckSchema.parse({ ...fixture, contract: { ...fixture.contract, fonts: { heading: "Times New Roman", body: "Times New Roman" } } });
    const findings = await ooxmlQa(pptxPath, substituted);
    expect(findings.some((finding) => finding.code === "FONT_SUBSTITUTION")).toBe(true);
  });

  it("requires embedded font parts for portable delivery, which this renderer cannot produce yet", async () => {
    const pptxPath = path.join(runDir, "all-layouts.pptx");
    const portable = deckSchema.parse({ ...fixture, contract: { ...fixture.contract, fontDelivery: "portable" } });
    const findings = await ooxmlQa(pptxPath, portable);
    expect(findings.some((finding) => finding.code === "FONT_EMBEDDING_REQUIRED")).toBe(true);
  });

  it("reports OOXML_INVALID for a file that is not a valid PPTX", async () => {
    const badPath = path.join(runDir, "not-a-pptx.pptx");
    fs.writeFileSync(badPath, "not a zip file");
    const findings = await ooxmlQa(badPath, fixture);
    expect(findings).toEqual([{ severity: "hard", code: "OOXML_INVALID", message: expect.stringContaining(badPath) }]);
  });

  it("rejects categorical chart colors outside resolved theme.data", async () => {
    const sourcePath = path.join(runDir, "all-layouts.pptx");
    const outputPath = path.join(runDir, "bad-chart-palette.pptx");
    const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
    const chart = zip.file("ppt/charts/chart1.xml");
    expect(chart).toBeTruthy();
    const xml = (await chart!.async("string")).replace(/2457A6/g, "000000");
    zip.file("ppt/charts/chart1.xml", xml);
    fs.writeFileSync(outputPath, await zip.generateAsync({ type: "nodebuffer" }));
    const style = resolvePresentationStyle(fixture.contract, { projectDir: process.cwd() });
    const findings = await ooxmlQa(outputPath, fixture, undefined, style);
    expect(findings.some((finding) => finding.code === "THEME_DATA_COLOR_VIOLATION")).toBe(true);
  });

  async function rewriteSlide(outputName: string, rewrite: (xml: string) => string): Promise<string> {
    const outputPath = path.join(runDir, outputName);
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(runDir, "all-layouts.pptx")));
    zip.file("ppt/slides/slide1.xml", rewrite(await zip.file("ppt/slides/slide1.xml")!.async("string")));
    fs.writeFileSync(outputPath, await zip.generateAsync({ type: "nodebuffer" }));
    return outputPath;
  }

  it("reads an organization template's parts by namespace, not by the prefix it happens to bind", async () => {
    // An arbitrary template may bind presentationml to any prefix; a regex over `<p:sp>` would
    // silently see zero shapes and pass a slide it never actually inspected.
    const outputPath = await rewriteSlide("rebound-prefix.pptx", (xml) => xml.replace(/<(\/?)p:/g, "<$1pp:").replace(/xmlns:p=/g, "xmlns:pp="));
    expect(await ooxmlQa(outputPath, fixture)).toEqual([]);
  });

  it("hard-fails a gradient fill authored on a semantic renderer shape", async () => {
    const gradient = '<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="00FF00"/></a:gs></a:gsLst></a:gradFill>';
    const outputPath = await rewriteSlide("gradient.pptx", (xml) => xml.replace("<a:solidFill>", `${gradient}<a:solidFill>`));
    const findings = await ooxmlQa(outputPath, fixture);
    expect(findings.some((finding) => finding.code === "GRADIENT_FILL_FORBIDDEN")).toBe(true);
  });
});
