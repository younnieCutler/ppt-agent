import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { renderDeck } from "../../src/renderer";
import { mergeQa, runPowerPointQa, structuralQa } from "../../src/qa";
import { contentModelSchema, deckSchema } from "../../src/schema";

const fixturePath = path.resolve(__dirname, "../fixtures/all-layouts.json");
const fixture = deckSchema.parse(JSON.parse(fs.readFileSync(fixturePath, "utf8")));
const contentModel = contentModelSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/content-model-all-layouts.json"), "utf8")));
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-integration-"));

afterAll(() => {
  fs.rmSync(runDir, { recursive: true, force: true });
});

// These two tests drive PowerPoint COM, which needs Microsoft PowerPoint *installed* — not merely
// Windows. Gating on the platform alone made them fail on a clean Windows CI runner, which reads as
// a product regression when it is only a missing application.
function powerPointAvailable(): boolean {
  if (process.platform !== "win32") return false;
  try {
    const probe = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "try { $a = New-Object -ComObject PowerPoint.Application; $a.Quit(); 'yes' } catch { 'no' }"],
      { encoding: "utf8", timeout: 30000, windowsHide: true });
    return probe.trim() === "yes";
  } catch {
    return false;
  }
}

describe("editable PPTX integration", () => {
  const noPowerPoint = !powerPointAvailable();

  it.skipIf(noPowerPoint)("renders every MVP semantic layout and passes PowerPoint QA", async () => {
    const pptxPath = path.join(runDir, "all-layouts.pptx");
    await renderDeck(fixture, pptxPath, process.cwd(), { contentModel });
    expect(fs.statSync(pptxPath).size).toBeGreaterThan(10000);
    const structural = structuralQa(fixture, process.cwd(), contentModel);
    expect(structural.status).toBe("pass");
    const powerpoint = runPowerPointQa(pptxPath, fixture, runDir);
    const report = mergeQa(structural, powerpoint);
    expect(report.status).toBe("pass");
    expect(report.findings).toEqual([]);
  }, 120000);

  it.skipIf(noPowerPoint)("fails portable delivery when no font embedding exists", async () => {
    const pptxPath = path.join(runDir, "portable-fonts.pptx");
    const portable = deckSchema.parse({ ...fixture, contract: { ...fixture.contract, fontDelivery: "portable" } });
    await renderDeck(portable, pptxPath, process.cwd(), { contentModel });
    const powerpoint = runPowerPointQa(pptxPath, portable, runDir);
    expect(powerpoint.status).toBe("fail");
    expect((powerpoint.findings as Array<{ code: string }>).some((finding) => finding.code === "FONT_EMBEDDING_REQUIRED")).toBe(true);
  }, 120000);

  it("refuses to resize a 4:3 deck through the 16:9 renderer", async () => {
    const templateDeck = deckSchema.parse({ ...fixture, contract: { ...fixture.contract, aspectRatio: "4:3" } });
    await expect(renderDeck(templateDeck, path.join(runDir, "must-not-render.pptx"), process.cwd())).rejects.toThrow(/native-template-fill/i);
  });
});
