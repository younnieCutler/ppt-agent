import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderDeck } from "../../src/renderer";
import { structuralQa } from "../../src/qa";

const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/quantitative-visuals.json"), "utf8"));
const contentModel = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/content-model-quantitative-visuals.json"), "utf8"));
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-visuals-"));

afterAll(() => fs.rmSync(runDir, { recursive: true, force: true }));

describe("native gauge and sparkline primitives", () => {
  it("renders gauge_row and sparkline_row without geometry violations", async () => {
    const pptxPath = path.join(runDir, "quantitative-visuals.pptx");
    await expect(renderDeck(fixture, pptxPath, process.cwd())).resolves.toMatchObject({ outputPath: pptxPath });
  });

  it("passes structural QA with grounded gauge/sparkline values", () => {
    const report = structuralQa(fixture, process.cwd(), contentModel);
    expect(report.status).toBe("pass");
    expect(report.findings.filter((finding) => finding.severity === "hard")).toHaveLength(0);
  });
});
