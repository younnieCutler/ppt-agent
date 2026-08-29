import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { buildPatternFixture } from "../fixtures/pattern-template";
import { visualRenderBackendAvailable } from "../../src/visual";

const repoRoot = path.resolve(__dirname, "../..");
const tsxPackage = createRequire(__filename).resolve("tsx/package.json");
const tsxCli = path.join(path.dirname(tsxPackage), JSON.parse(fs.readFileSync(tsxPackage, "utf8")).bin as string);

function cli(args: string[]): string {
  return execFileSync(process.execPath, [tsxCli, path.join(repoRoot, "src/cli.ts"), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// A clean Windows CI runner has neither PowerPoint nor LibreOffice installed — `template-preview`
// needs one of them to rasterize slides, so this test needs a real backend, not merely Windows.
const noVisualBackend = !visualRenderBackendAvailable();

describe("template-preview + pattern-label", () => {
  it.skipIf(noVisualBackend)(
    "renders a raw template's own slides to a montage, and pattern-label merges host-authored functions into template-patterns.json",
    async () => {
      const templatePath = await buildPatternFixture();
      const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-template-preview-"));
      try {
        const analyzeOutput = JSON.parse(cli(["template-analyze", "--input", templatePath, "--out", path.join(runDir, "template")]));
        expect(analyzeOutput.patterns).toBe(3);
        expect(analyzeOutput.strategy).toBe("source_slide_pattern");

        const previewOutput = JSON.parse(cli(["template-preview", "--input", templatePath, "--run-dir", runDir]));
        expect(previewOutput.status).toBe("pass");
        expect(previewOutput.slides).toBe(3);
        expect(fs.existsSync(previewOutput.montagePath)).toBe(true);
        expect(path.basename(previewOutput.montagePath)).toBe("montage.png");

        const labelsPath = path.join(runDir, "pattern-labels.json");
        fs.writeFileSync(labelsPath, JSON.stringify([
          { sourceSlideId: "S01", functions: ["cover"] },
          { sourceSlideId: "S03", functions: ["statement"] },
        ]));
        const labelOutput = JSON.parse(cli(["pattern-label", "--run-dir", runDir, "--labels", labelsPath]));
        expect(labelOutput.status).toBe("pass");
        expect(labelOutput.labeled).toBe(2);

        const patterns = JSON.parse(fs.readFileSync(path.join(runDir, "template", "template-patterns.json"), "utf8"));
        expect(patterns.patterns.find((p: { sourceSlideId: string }) => p.sourceSlideId === "S01").suitableFor.functions).toEqual(["cover"]);
        expect(patterns.patterns.find((p: { sourceSlideId: string }) => p.sourceSlideId === "S02").suitableFor.functions).toEqual([]);
      } finally {
        fs.rmSync(runDir, { recursive: true, force: true });
        fs.rmSync(path.dirname(templatePath), { recursive: true, force: true });
      }
    },
    30000,
  );

  it("pattern-label rejects an invented SlideFunction before it ever reaches template-patterns.json", async () => {
    const templatePath = await buildPatternFixture();
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-pattern-label-reject-"));
    try {
      cli(["template-analyze", "--input", templatePath, "--out", path.join(runDir, "template")]);
      const labelsPath = path.join(runDir, "bad-labels.json");
      fs.writeFileSync(labelsPath, JSON.stringify([{ sourceSlideId: "S01", functions: ["not-a-real-function"] }]));
      expect(() => cli(["pattern-label", "--run-dir", runDir, "--labels", labelsPath])).toThrow();
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
      fs.rmSync(path.dirname(templatePath), { recursive: true, force: true });
    }
  });
});
