import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { renderDeck } from "../../src/renderer";
import { buildPatternFixture } from "../fixtures/pattern-template";

const repoRoot = path.resolve(__dirname, "../..");
const deckFixtureContract = JSON.parse(fs.readFileSync(path.join(repoRoot, "tests/fixtures/deck.json"), "utf8")).contract;
const tsxPackage = createRequire(__filename).resolve("tsx/package.json");
const tsxCli = path.join(path.dirname(tsxPackage), JSON.parse(fs.readFileSync(tsxPackage, "utf8")).bin as string);

function cli(args: string[]): string {
  return execFileSync(process.execPath, [tsxCli, path.join(repoRoot, "src/cli.ts"), ...args], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function deckSlide(overrides: Record<string, unknown> & { layout: string; id: string; headline: string; storyBeat: string; composition: string }): unknown {
  return {
    role: "body", sourceRefs: [{ sourceId: "prompt", excerptId: "R001" }],
    claims: [{ text: overrides.headline, kind: "interpretation", status: "verified" }],
    ...overrides,
  };
}

// Every slide's layout here (title/statement/evidence) resolves through content.body — the one
// binding a synthetic 3-slide fixture's patterns all carry — so this deck should get full
// source_slide_pattern coverage with zero fallback to the generic renderer, unlike a deck that
// uses an architecture/pipeline/chart layout (no binding exists for those; see
// applyPatternSkeleton's hard-fail comment for why that case is a genuine, expected failure and
// not something this test exercises).
const deck = {
  contract: deckFixtureContract,
  title: "Wiring test deck",
  slides: [
    deckSlide({ id: "S01", layout: "title", storyBeat: "opening", composition: "cover", headline: "Clear Boundaries", content: {} }),
    deckSlide({ id: "S02", layout: "statement", storyBeat: "problem", composition: "hero_evidence", headline: "Batch vs streaming: different needs", content: { body: "The two need different guarantees.", proofs: [] } }),
    deckSlide({ id: "S03", layout: "evidence", storyBeat: "design", composition: "evidence_list", headline: "Events flow through clear stages", content: { bullets: ["Ingest", "Transform", "Publish"] } }),
  ],
};

// End-to-end CLI wiring: template-analyze -> pattern-resolve -> render-pattern-skeleton, proving
// the ranked-candidate fallback and render-manifest.json — not re-proving applyPatternSkeleton's
// own clone/sanitize/inject logic, which tests/integration/pattern-skeleton.test.ts already covers.
describe("render-pattern-skeleton CLI", () => {
  it(
    "resolves every slide to a fitting pattern candidate — a full source_slide_pattern template gets zero generic-renderer fallback",
    async () => {
      const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-render-pattern-cli-"));
      const templatePath = await buildPatternFixture();
      try {
        fs.writeFileSync(path.join(runDir, "contract.json"), JSON.stringify(deck.contract, null, 2));
        const ref = { sourceId: "prompt", excerptId: "R001" };
        const contentModel = { version: 1, sources: [{ sourceId: ref.sourceId, excerpts: [{ id: ref.excerptId, locator: "1", text: "Grounded fact" }] }] };
        const contentModelPath = path.join(runDir, "source-content-model.json");
        fs.writeFileSync(contentModelPath, JSON.stringify(contentModel, null, 2));
        const plan = {
          version: 1, title: deck.title, narrativeThesis: "One story, traceable end to end.",
          slides: deck.slides.map((slide, index) => ({
            id: (slide as { id: string }).id, storyBeat: (slide as { storyBeat: string }).storyBeat, thesis: (slide as { headline: string }).headline,
            function: index === 0 ? "cover" : "evidence",
            primaryEvidence: [ref], secondaryEvidence: [],
            visualIntent: index === 0 ? "single_focal" : "hierarchy", density: "medium", takeaway: (slide as { headline: string }).headline,
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
        await renderDeck(deck, scratchPath, repoRoot);
        const outPath = path.join(runDir, "final.pptx");
        const specPath = path.join(runDir, "deck.json");
        fs.writeFileSync(specPath, JSON.stringify(deck, null, 2));
        const output = JSON.parse(cli(["render-pattern-skeleton", "--spec", specPath, "--scratch", scratchPath, "--template", templatePath, "--out", outPath, "--run-dir", runDir]));

        expect(output.status).toBe("pass");
        expect(fs.existsSync(outPath)).toBe(true);
        const manifestPath = path.join(runDir, "render-manifest.json");
        expect(fs.existsSync(manifestPath)).toBe(true);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        expect(manifest).toHaveLength(deck.slides.length);
        expect(manifest.every((entry: { mode: string }) => entry.mode.startsWith("pattern:"))).toBe(true);
      } finally {
        fs.rmSync(runDir, { recursive: true, force: true });
        fs.rmSync(path.dirname(templatePath), { recursive: true, force: true });
      }
    },
    120000,
  );

  it(
    "hard-fails instead of silently falling back to the generic renderer when a slide's layout has no possible pattern binding (architecture/pipeline/chart)",
    async () => {
      const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-render-pattern-cli-hardfail-"));
      const templatePath = await buildPatternFixture();
      try {
        const unsupportedDeck = {
          contract: deck.contract,
          title: "Unsupported layout deck",
          slides: [
            deckSlide({ id: "S01", layout: "title", storyBeat: "opening", composition: "cover", headline: "Cover", content: {} }),
            deckSlide({ id: "S02", layout: "statement", storyBeat: "problem", composition: "hero_evidence", headline: "Body", content: { body: "x", proofs: [] } }),
            {
              ...deckSlide({ id: "S03", layout: "pipeline", storyBeat: "design", composition: "pipeline_lanes", headline: "Pipeline" }),
              content: { lanes: [], nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }] },
            },
          ],
        };
        fs.writeFileSync(path.join(runDir, "contract.json"), JSON.stringify(unsupportedDeck.contract, null, 2));
        const ref = { sourceId: "prompt", excerptId: "R001" };
        const contentModel = { version: 1, sources: [{ sourceId: ref.sourceId, excerpts: [{ id: ref.excerptId, locator: "1", text: "Grounded fact" }] }] };
        const contentModelPath = path.join(runDir, "source-content-model.json");
        fs.writeFileSync(contentModelPath, JSON.stringify(contentModel, null, 2));
        const plan = {
          version: 1, title: unsupportedDeck.title, narrativeThesis: "One story, traceable end to end.",
          slides: unsupportedDeck.slides.map((slide, index) => ({
            id: (slide as { id: string }).id, storyBeat: (slide as { storyBeat: string }).storyBeat, thesis: (slide as { headline: string }).headline,
            function: index === 0 ? "cover" : "evidence",
            primaryEvidence: [ref], secondaryEvidence: [],
            visualIntent: index === 0 ? "single_focal" : "hierarchy", density: "medium", takeaway: (slide as { headline: string }).headline,
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
        await renderDeck(unsupportedDeck, scratchPath, repoRoot);
        const outPath = path.join(runDir, "final.pptx");
        const specPath = path.join(runDir, "deck.json");
        fs.writeFileSync(specPath, JSON.stringify(unsupportedDeck, null, 2));

        expect(() => cli(["render-pattern-skeleton", "--spec", specPath, "--scratch", scratchPath, "--template", templatePath, "--out", outPath, "--run-dir", runDir])).toThrow(/No pattern fits slide 'S03'/);
      } finally {
        fs.rmSync(runDir, { recursive: true, force: true });
        fs.rmSync(path.dirname(templatePath), { recursive: true, force: true });
      }
    },
    120000,
  );
});
