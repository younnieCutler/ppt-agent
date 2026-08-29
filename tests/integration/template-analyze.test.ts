import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { renderDeck } from "../../src/renderer";

const repoRoot = path.resolve(__dirname, "../..");
const deckFixture = JSON.parse(fs.readFileSync(path.join(repoRoot, "tests/fixtures/deck.json"), "utf8"));

function cli(args: string[], options: { expectFailure?: boolean } = {}): string {
  try {
    return execFileSync("npx", ["tsx", path.join(repoRoot, "src/cli.ts"), ...args], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (!options.expectFailure) throw error;
    const failure = error as { stderr?: string; stdout?: string };
    return `${failure.stderr ?? ""}${failure.stdout ?? ""}`;
  }
}

const contract = {
  sources: [{ kind: "prompt", id: "brief", text: "Brief" }],
  purpose: "internal",
  audience: "Team",
  storyline: ["opening", "evidence", "closing"],
  language: "en",
  slideCount: 3,
  brand: { kind: "default" },
  fonts: { heading: "Arial", body: "Arial" },
  aspectRatio: "16:9",
};
const contentModel = { version: 1, sources: [{ sourceId: "brief", excerpts: [{ id: "E01", locator: "1", text: "Grounded fact" }] }] };
const plan = {
  version: 1,
  title: "Plan",
  narrativeThesis: "One story",
  slides: ["opening", "evidence", "closing"].map((storyBeat, index) => ({
    id: `S0${index + 1}`,
    storyBeat,
    thesis: `Thesis ${index + 1}`,
    function: index === 0 ? "cover" : "evidence",
    primaryEvidence: [{ sourceId: "brief", excerptId: "E01" }],
    secondaryEvidence: [],
    visualIntent: index === 0 ? "single_focal" : "hierarchy",
    density: "medium",
    takeaway: `Takeaway ${index + 1}`,
  })),
};

async function packWithTemplate(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-analyze-"));
  await renderDeck(deckFixture, path.join(dir, "template.pptx"), repoRoot);
  return dir;
}

describe("template-analyze CLI", () => {
  it("applies the pack's elementRoleOverrides to the analyzed elements", async () => {
    const pack = await packWithTemplate();
    cli(["template-analyze", "--input", path.join(pack, "template.pptx"), "--out", pack]);
    const baseline = JSON.parse(fs.readFileSync(path.join(pack, "template-elements.json"), "utf8")) as { slides: Array<{ elements: Array<{ id: string; role: string; confidence: number }> }> };
    const target = baseline.slides.flatMap((slide) => slide.elements).find((element) => element.role !== "annotation");
    expect(target).toBeDefined();

    fs.writeFileSync(path.join(pack, "template-map.json"), JSON.stringify({
      version: 2,
      aspectRatio: "16:9",
      chromeOwnership: { background: "template", logo: "template", footer: "template", pageNumber: "template" },
      defaultLayout: { nativeLayout: "DEFAULT", canvasColor: "FFFFFF", contentRegion: { x: 0.72, y: 0.48, w: 11.85, h: 6.14 }, reservedRegions: [] },
      layouts: {},
      requiredElements: [],
      elementRoleOverrides: { [target!.id]: "annotation" },
    }));
    const output = cli(["template-analyze", "--input", path.join(pack, "template.pptx"), "--out", pack]);
    expect(JSON.parse(output).roleOverrides).toBe(1);

    const overridden = JSON.parse(fs.readFileSync(path.join(pack, "template-elements.json"), "utf8")) as typeof baseline;
    const applied = overridden.slides.flatMap((slide) => slide.elements).find((element) => element.id === target!.id);
    expect(applied).toMatchObject({ role: "annotation", confidence: 1 });
  }, 120000);

  it("keeps the previous valid artifact pair when the second write fails", async () => {
    const pack = await packWithTemplate();
    cli(["template-analyze", "--input", path.join(pack, "template.pptx"), "--out", pack]);
    const elementsPath = path.join(pack, "template-elements.json");
    const grammarPath = path.join(pack, "template-grammar.json");
    const elementsBefore = fs.readFileSync(elementsPath, "utf8");
    const grammarBefore = fs.readFileSync(grammarPath, "utf8");

    // A directory where the grammar file belongs makes the second rename fail, which is the case
    // that used to leave fresh elements paired with a stale grammar.
    fs.rmSync(grammarPath);
    fs.mkdirSync(grammarPath);
    fs.writeFileSync(path.join(grammarPath, "blocker"), "");
    const failure = cli(["template-analyze", "--input", path.join(pack, "template.pptx"), "--out", pack], { expectFailure: true });
    expect(failure).not.toBe("");

    expect(fs.readFileSync(elementsPath, "utf8")).toBe(elementsBefore);
    fs.rmSync(grammarPath, { recursive: true });
    fs.writeFileSync(grammarPath, grammarBefore);
  }, 120000);
});

describe("composition-resolve provenance chain", () => {
  it("blocks when an input recorded at planning time changed afterwards", () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-provenance-"));
    fs.writeFileSync(path.join(runDir, "contract.json"), JSON.stringify(contract, null, 2));
    const contentModelPath = path.join(runDir, "source-content-model.json");
    fs.writeFileSync(contentModelPath, JSON.stringify(contentModel, null, 2));
    const planPath = path.join(runDir, "plan-input.json");
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    fs.writeFileSync(path.join(runDir, "style-context.json"), JSON.stringify({ archetype: "corporate" }, null, 2));
    cli(["plan-validate", "--plan", planPath, "--content-model", contentModelPath, "--run-dir", runDir]);

    const resolveArgs = ["composition-resolve", "--plan", path.join(runDir, "deck-plan.json"), "--style-context", path.join(runDir, "style-context.json"), "--run-dir", runDir];
    expect(cli(resolveArgs)).toContain("composition-plan.json");

    fs.writeFileSync(path.join(runDir, "contract.json"), JSON.stringify({ ...contract, audience: "Board" }, null, 2));
    expect(cli(resolveArgs, { expectFailure: true })).toMatch(/contract\.json changed after planning/);

    fs.writeFileSync(path.join(runDir, "contract.json"), JSON.stringify(contract, null, 2));
    fs.rmSync(path.join(runDir, "content-model.json"));
    expect(cli(resolveArgs, { expectFailure: true })).toMatch(/content-model\.json is recorded/);
  }, 120000);
});
