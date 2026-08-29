import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { release } from "../../src/cli";
import { createRunWorkspace } from "../../src/workspace";
import { buildPatternFixture } from "../fixtures/pattern-template";

// Full raw-.pptx-only pipeline, end to end: no Organization Pack, no brand.yaml, no
// template-map.json anywhere in this test — a template.pptx and a goal are the only inputs, the
// ChatGPT-shaped UX this whole feature exists for. Proves, against a real run:
//   1. every slide reaches a real cloned source-slide pattern (zero generic-renderer fallback —
//      the hard-fail path this branch added would have thrown well before this point otherwise),
//   2. qa.json passes clean,
//   3. release deletes the whole run workspace on success and leaves exactly the deliverable
//      behind, the same "hidden workspace, final .pptx only" contract raw-pptx-fidelity-gate.test.ts
//      and organization-pack-fidelity-gate.test.ts each prove one slice of, assembled here into one
//      run from contract to release.

const repoRoot = path.resolve(__dirname, "../..");
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

const contract = {
  sources: [{ kind: "prompt", id: "prompt", text: "Grounded fact." }],
  purpose: "technical", audience: "engineering leaders", language: "en", slideCount: 3,
  brand: { kind: "default" }, fonts: { heading: "Arial", body: "Arial" }, fontDelivery: "managed_device",
  aspectRatio: "16:9", storyline: ["opening", "problem", "design"],
};

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-raw-pptx-e2e-"));
afterAll(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

describe("raw .pptx E2E: template.pptx + goal, no Organization Pack anywhere", () => {
  it(
    "clones every slide from the template's own patterns, passes qa clean, and release leaves exactly the deliverable behind",
    async () => {
      const templatePath = await buildPatternFixture();
      const { runDir } = createRunWorkspace(projectRoot, "raw-pptx-e2e");
      try {
        // contract.template names the raw .pptx directly — contract.organization is never set.
        fs.writeFileSync(path.join(runDir, "contract.json"), JSON.stringify({ ...contract, template: { kind: "pptx", path: templatePath } }, null, 2));

        const contentModel = { version: 1, sources: [{ sourceId: "prompt", excerpts: [{ id: "R001", locator: "1", text: "Grounded fact." }] }] };
        const contentModelPath = path.join(runDir, "source-content-model.json");
        fs.writeFileSync(contentModelPath, JSON.stringify(contentModel, null, 2));

        const plan = {
          version: 1, title: "Raw pptx E2E deck", narrativeThesis: "One story, traceable end to end.",
          slides: [
            { id: "S01", storyBeat: "opening", thesis: "Clear Boundaries", function: "cover", primaryEvidence: [{ sourceId: "prompt", excerptId: "R001" }], secondaryEvidence: [], visualIntent: "single_focal", density: "medium", takeaway: "x" },
            { id: "S02", storyBeat: "problem", thesis: "Batch vs streaming: different needs", function: "evidence", primaryEvidence: [{ sourceId: "prompt", excerptId: "R001" }], secondaryEvidence: [], visualIntent: "hierarchy", density: "medium", takeaway: "x" },
            { id: "S03", storyBeat: "design", thesis: "Events flow through clear stages", function: "evidence", primaryEvidence: [{ sourceId: "prompt", excerptId: "R001" }], secondaryEvidence: [], visualIntent: "hierarchy", density: "medium", takeaway: "x" },
          ],
        };
        const planPath = path.join(runDir, "plan-input.json");
        fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

        cli(["plan-validate", "--plan", planPath, "--content-model", contentModelPath, "--run-dir", runDir]);
        cli(["style", "--contract", path.join(runDir, "contract.json"), "--run-dir", runDir]);
        cli(["composition-resolve", "--plan", path.join(runDir, "deck-plan.json"), "--style-context", path.join(runDir, "style-context.json"), "--run-dir", runDir]);
        // The raw-pptx entry point: analyze the file directly, no organization pack anywhere.
        const analyzeOutput = JSON.parse(cli(["template-analyze", "--input", templatePath, "--out", path.join(runDir, "template")]));
        expect(analyzeOutput.strategy).toBe("source_slide_pattern");
        cli(["pattern-resolve", "--plan", path.join(runDir, "deck-plan.json"), "--run-dir", runDir]);

        const { deckPlanDigest } = await import("../../src/planning");
        const deck = {
          version: 2,
          planDigest: deckPlanDigest(JSON.parse(fs.readFileSync(path.join(runDir, "deck-plan.json"), "utf8"))),
          contract: { ...contract, template: { kind: "pptx", path: templatePath } },
          title: "Raw pptx E2E deck",
          slides: [
            deckSlide({ id: "S01", layout: "title", storyBeat: "opening", composition: "cover", headline: "Clear Boundaries", content: {} }),
            deckSlide({ id: "S02", layout: "evidence", storyBeat: "problem", composition: "evidence_list", headline: "Batch vs streaming: different needs", content: { bullets: ["Different latency guarantees", "Different failure modes"] } }),
            deckSlide({ id: "S03", layout: "evidence", storyBeat: "design", composition: "evidence_list", headline: "Events flow through clear stages", content: { bullets: ["Ingest", "Transform", "Publish"] } }),
          ],
        };
        const specPath = path.join(runDir, "deck.json");
        fs.writeFileSync(specPath, JSON.stringify(deck, null, 2));
        cli(["validate", "--spec", specPath, "--run-dir", runDir]);

        const scratchPath = path.join(runDir, "scratch.pptx");
        cli(["render", "--spec", specPath, "--out", scratchPath, "--run-dir", runDir]);
        const finalPath = path.join(runDir, "final.pptx");
        cli(["render-pattern-skeleton", "--spec", specPath, "--scratch", scratchPath, "--template", templatePath, "--out", finalPath, "--run-dir", runDir]);

        const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "render-manifest.json"), "utf8"));
        expect(manifest).toHaveLength(3);
        expect(manifest.every((entry: { mode: string }) => entry.mode.startsWith("pattern:"))).toBe(true);

        // The CLI diets its stdout for a passing run (findings become counts, not the array) —
        // read qa.json itself, the artifact every later step actually re-checks.
        cli(["qa", "--spec", specPath, "--pptx", finalPath, "--run-dir", runDir]);
        const qaReport = JSON.parse(fs.readFileSync(path.join(runDir, "qa.json"), "utf8"));
        expect(qaReport.status).toBe("pass");
        expect(qaReport.findings).toHaveLength(0);

        fs.writeFileSync(path.join(runDir, "judgment.md"), "Outcome: good\nRelease decision: pass\n");
        fs.writeFileSync(path.join(runDir, "repair-state.json"), JSON.stringify({ attempts: 0 }));
        const outPath = path.join(projectRoot, "outputs", "raw-pptx-e2e", "raw-pptx-e2e.pptx");
        await release(["--qa", path.join(runDir, "qa.json"), "--judgment", path.join(runDir, "judgment.md"), "--repair-state", path.join(runDir, "repair-state.json"), "--pptx", finalPath, "--out", outPath, "--run-dir", runDir]);

        // The hidden workspace is gone entirely — no template-elements.json, no pattern-plan.json,
        // no scratch.pptx, nothing analysis-related survives a successful release.
        expect(fs.existsSync(runDir)).toBe(false);
        // Exactly the one deliverable exists — no PDF was requested, no leftover artifacts.
        expect(fs.readdirSync(path.dirname(outPath))).toEqual(["raw-pptx-e2e.pptx"]);
        // The template itself, and organizations/ (this test never touches it), are untouched.
        expect(fs.readdirSync(path.dirname(templatePath))).toEqual(["template.pptx"]);
      } finally {
        fs.rmSync(runDir, { recursive: true, force: true });
        fs.rmSync(path.dirname(templatePath), { recursive: true, force: true });
      }
    },
    120000,
  );
});
