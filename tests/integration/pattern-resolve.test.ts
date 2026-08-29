import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { buildPatternFixture } from "../fixtures/pattern-template";

const repoRoot = path.resolve(__dirname, "../..");
const deckFixture = JSON.parse(fs.readFileSync(path.join(repoRoot, "tests/fixtures/deck.json"), "utf8"));
const tsxPackage = createRequire(__filename).resolve("tsx/package.json");
const tsxCli = path.join(path.dirname(tsxPackage), JSON.parse(fs.readFileSync(tsxPackage, "utf8")).bin as string);

function cli(args: string[], options: { expectFailure?: boolean } = {}): string {
  try {
    return execFileSync(process.execPath, [tsxCli, path.join(repoRoot, "src/cli.ts"), ...args], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (!options.expectFailure) throw error;
    const failure = error as { stderr?: string; stdout?: string };
    return `${failure.stderr ?? ""}${failure.stdout ?? ""}`;
  }
}

const contract = deckFixture.contract;
const ref = deckFixture.slides[0].sourceRefs[0];
const contentModel = { version: 1, sources: [{ sourceId: ref.sourceId, excerpts: [{ id: ref.excerptId, locator: "1", text: "Grounded fact" }] }] };
const plan = {
  version: 1,
  title: deckFixture.title,
  narrativeThesis: "One story, traceable end to end.",
  slides: deckFixture.slides.map((slide: { id: string; storyBeat: string; headline: string }, index: number) => ({
    id: slide.id,
    storyBeat: slide.storyBeat,
    thesis: slide.headline,
    function: index === 0 ? "cover" : "evidence",
    primaryEvidence: [ref],
    secondaryEvidence: [],
    visualIntent: index === 0 ? "single_focal" : "hierarchy",
    density: "medium",
    takeaway: slide.headline,
  })),
};

describe("pattern-resolve provenance chain", () => {
  async function resolvedThroughComposition(): Promise<{ runDir: string; planPath: string }> {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-pattern-resolve-"));
    fs.writeFileSync(path.join(runDir, "contract.json"), JSON.stringify(contract, null, 2));
    const contentModelPath = path.join(runDir, "source-content-model.json");
    fs.writeFileSync(contentModelPath, JSON.stringify(contentModel, null, 2));
    const planPath = path.join(runDir, "plan-input.json");
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    cli(["plan-validate", "--plan", planPath, "--content-model", contentModelPath, "--run-dir", runDir]);
    cli(["style", "--contract", path.join(runDir, "contract.json"), "--run-dir", runDir]);
    cli(["composition-resolve", "--plan", path.join(runDir, "deck-plan.json"), "--style-context", path.join(runDir, "style-context.json"), "--run-dir", runDir]);
    return { runDir, planPath: path.join(runDir, "deck-plan.json") };
  }

  it(
    "resolves a pattern-plan.json once composition-plan.json and template-patterns.json both exist",
    async () => {
      const { runDir, planPath } = await resolvedThroughComposition();
      const templatePath = await buildPatternFixture();
      cli(["template-analyze", "--input", templatePath, "--out", path.join(runDir, "template")]);
      const output = JSON.parse(cli(["pattern-resolve", "--plan", planPath, "--run-dir", runDir]));
      expect(output.status).toBe("pass");
      expect(fs.existsSync(path.join(runDir, "pattern-plan.json"))).toBe(true);
      const provenance = JSON.parse(fs.readFileSync(path.join(runDir, "artifact-provenance.json"), "utf8"));
      expect(provenance.patternPlanDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(provenance.templatePatternsDigest).toMatch(/^[a-f0-9]{64}$/);
      fs.rmSync(path.dirname(templatePath), { recursive: true, force: true });
    },
    120000,
  );

  it("errors clearly when no template-patterns.json exists (e.g. a native_layout template with no source-slide patterns)", async () => {
    const { runDir, planPath } = await resolvedThroughComposition();
    expect(cli(["pattern-resolve", "--plan", planPath, "--run-dir", runDir], { expectFailure: true })).toMatch(/Pattern resolution requires .*template-patterns\.json/);
  }, 120000);

  it("blocks when composition-plan.json changed after composition resolution", async () => {
    const { runDir, planPath } = await resolvedThroughComposition();
    const templatePath = await buildPatternFixture();
    cli(["template-analyze", "--input", templatePath, "--out", path.join(runDir, "template")]);
    const compositionPlanPath = path.join(runDir, "composition-plan.json");
    fs.writeFileSync(compositionPlanPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(compositionPlanPath, "utf8")), tampered: true }, null, 2));
    expect(cli(["pattern-resolve", "--plan", planPath, "--run-dir", runDir], { expectFailure: true })).toMatch(/composition-plan\.json changed after composition resolution/);
    fs.rmSync(path.dirname(templatePath), { recursive: true, force: true });
  }, 120000);
}, 120000);
