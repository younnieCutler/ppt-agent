import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderDeck } from "../../src/renderer";
import { ooxmlQa } from "../../src/qa";
import { contentModelSchema, deckSchema } from "../../src/schema";

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
});
