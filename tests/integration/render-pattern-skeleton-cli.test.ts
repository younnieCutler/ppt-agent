import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { renderDeck } from "../../src/renderer";
import { buildPatternFixture } from "../fixtures/pattern-template";

const repoRoot = path.resolve(__dirname, "../..");
const deckFixture = JSON.parse(fs.readFileSync(path.join(repoRoot, "tests/fixtures/deck.json"), "utf8"));
const tsxPackage = createRequire(__filename).resolve("tsx/package.json");
const tsxCli = path.join(path.dirname(tsxPackage), JSON.parse(fs.readFileSync(tsxPackage, "utf8")).bin as string);

function cli(args: string[]): string {
  return execFileSync(process.execPath, [tsxCli, path.join(repoRoot, "src/cli.ts"), ...args], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// End-to-end CLI wiring: template-analyze -> pattern-resolve -> render-pattern-skeleton, proving
// the rank-1-candidate default and render-manifest.json — not re-proving applyPatternSkeleton's
// own clone/sanitize/inject logic, which tests/integration/pattern-skeleton.test.ts already covers.
describe("render-pattern-skeleton CLI", () => {
  it(
    "picks each slide's rank-1 pattern candidate and writes render-manifest.json",
    async () => {
      const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-render-pattern-cli-"));
      const templatePath = await buildPatternFixture();
      try {
        fs.writeFileSync(path.join(runDir, "contract.json"), JSON.stringify(deckFixture.contract, null, 2));
        const ref = deckFixture.slides[0].sourceRefs[0];
        const contentModel = { version: 1, sources: [{ sourceId: ref.sourceId, excerpts: [{ id: ref.excerptId, locator: "1", text: "Grounded fact" }] }] };
        const contentModelPath = path.join(runDir, "source-content-model.json");
        fs.writeFileSync(contentModelPath, JSON.stringify(contentModel, null, 2));
        const plan = {
          version: 1, title: deckFixture.title, narrativeThesis: "One story, traceable end to end.",
          slides: deckFixture.slides.map((slide: { id: string; storyBeat: string; headline: string }, index: number) => ({
            id: slide.id, storyBeat: slide.storyBeat, thesis: slide.headline,
            function: index === 0 ? "cover" : "evidence",
            primaryEvidence: [ref], secondaryEvidence: [],
            visualIntent: index === 0 ? "single_focal" : "hierarchy", density: "medium", takeaway: slide.headline,
          })),
        };
        const planPath = path.join(runDir, "plan-input.json");
        fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

        cli(["plan-validate", "--plan", planPath, "--content-model", contentModelPath, "--run-dir", runDir]);
        cli(["style", "--contract", path.join(runDir, "contract.json"), "--run-dir", runDir]);
        cli(["composition-resolve", "--plan", path.join(runDir, "deck-plan.json"), "--style-context", path.join(runDir, "style-context.json"), "--run-dir", runDir]);
        cli(["template-analyze", "--input", templatePath, "--out", path.join(runDir, "template")]);
        cli(["pattern-resolve", "--plan", path.join(runDir, "deck-plan.json"), "--run-dir", runDir]);

        const scratchPath = path.join(runDir, "scratch.pptx");
        await renderDeck(deckFixture, scratchPath, repoRoot);
        const outPath = path.join(runDir, "final.pptx");
        const output = JSON.parse(cli(["render-pattern-skeleton", "--spec", path.join(repoRoot, "tests/fixtures/deck.json"), "--scratch", scratchPath, "--template", templatePath, "--out", outPath, "--run-dir", runDir]));

        expect(output.status).toBe("pass");
        expect(fs.existsSync(outPath)).toBe(true);
        const manifestPath = path.join(runDir, "render-manifest.json");
        expect(fs.existsSync(manifestPath)).toBe(true);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        expect(manifest).toHaveLength(deckFixture.slides.length);
        expect(manifest.every((entry: { mode: string }) => entry.mode.startsWith("pattern:") || entry.mode === "renderer")).toBe(true);
      } finally {
        fs.rmSync(runDir, { recursive: true, force: true });
        fs.rmSync(path.dirname(templatePath), { recursive: true, force: true });
      }
    },
    120000,
  );
});
