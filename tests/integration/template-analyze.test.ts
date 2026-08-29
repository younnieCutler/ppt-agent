import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { renderDeck } from "../../src/renderer";
import { loadOrganizationPack } from "../../src/organization";

const repoRoot = path.resolve(__dirname, "../..");
const deckFixture = JSON.parse(fs.readFileSync(path.join(repoRoot, "tests/fixtures/deck.json"), "utf8"));

// The real CLI boundary, invoked the way every platform can: this node, and the tsx CLI resolved
// from the repository's own node_modules. `npx` is a shell-resolved shim that does not exist as an
// executable on Windows runners (spawnSync npx ENOENT).
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


  it("keeps the pack loadable only while its artifacts match the current overrides", async () => {
    const pack = await packWithTemplate();
    const mapPath = path.join(pack, "template-map.json");
    const map = {
      version: 2,
      aspectRatio: "16:9",
      chromeOwnership: { background: "template", logo: "template", footer: "template", pageNumber: "template" },
      defaultLayout: { nativeLayout: "DEFAULT", canvasColor: "FFFFFF", contentRegion: { x: 0.72, y: 0.48, w: 11.85, h: 6.14 }, reservedRegions: [] },
      layouts: {},
      requiredElements: [],
      elementRoleOverrides: {} as Record<string, string>,
    };
    fs.writeFileSync(mapPath, JSON.stringify(map));
    fs.writeFileSync(path.join(pack, "brand.yaml"), ["name: Analyze Test", "palette:", '  background: "FFFFFF"', '  surface: "FFFFFF"', '  text: "111111"', '  primary: "123456"', '  accent: "654321"', '  muted: "666666"', '  border: "DDDDDD"'].join("\n"));
    cli(["template-analyze", "--input", path.join(pack, "template.pptx"), "--out", pack]);
    expect(() => loadOrganizationPack(pack)).not.toThrow();

    // template.pptx is untouched; only an analysis input in the map moved.
    const elements = JSON.parse(fs.readFileSync(path.join(pack, "template-elements.json"), "utf8")) as { slides: Array<{ elements: Array<{ id: string }> }> };
    const targetId = elements.slides.flatMap((slide) => slide.elements)[0].id;
    fs.writeFileSync(mapPath, JSON.stringify({ ...map, elementRoleOverrides: { [targetId]: "annotation" } }));
    expect(() => loadOrganizationPack(pack)).toThrow(/elementRoleOverrides/);

    cli(["template-analyze", "--input", path.join(pack, "template.pptx"), "--out", pack]);
    expect(() => loadOrganizationPack(pack)).not.toThrow();
  }, 120000);
});

describe("run recovery when root inputs change", () => {
  function writeRun(contractValue: unknown): { runDir: string; contractPath: string; planPath: string; contentModelPath: string } {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-recovery-"));
    const contractPath = path.join(runDir, "contract.json");
    fs.writeFileSync(contractPath, JSON.stringify(contractValue, null, 2));
    const contentModelPath = path.join(runDir, "source-content-model.json");
    fs.writeFileSync(contentModelPath, JSON.stringify(contentModel, null, 2));
    const planPath = path.join(runDir, "plan-input.json");
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    return { runDir, contractPath, planPath, contentModelPath };
  }

  function resolveArgsFor(runDir: string): string[] {
    return ["composition-resolve", "--plan", path.join(runDir, "deck-plan.json"), "--style-context", path.join(runDir, "style-context.json"), "--run-dir", runDir];
  }

  it("recovers when a deck with references becomes a deck without them", () => {
    const withReferences = { ...contract, referenceIds: ["presentation_core"] };
    const { runDir, contractPath, planPath, contentModelPath } = writeRun(withReferences);
    cli(["plan-validate", "--plan", planPath, "--content-model", contentModelPath, "--run-dir", runDir]);
    cli(["reference", "--contract", contractPath, "--reference-root", path.join(repoRoot, "tests/fixtures/reference-root"), "--run-dir", runDir]);
    cli(["style", "--contract", contractPath, "--run-dir", runDir]);
    expect(fs.existsSync(path.join(runDir, "reference-selection.json"))).toBe(true);

    // The contract no longer has references at all, so the selection is not merely stale — it is
    // an artifact this run does not produce. No manual deletion.
    fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2));
    cli(["plan-validate", "--plan", planPath, "--content-model", contentModelPath, "--run-dir", runDir]);
    expect(fs.existsSync(path.join(runDir, "reference-selection.json"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(runDir, "artifact-provenance.json"), "utf8")).referenceSelectionDigest).toBeUndefined();

    cli(["style", "--contract", contractPath, "--run-dir", runDir]);
    expect(cli(resolveArgsFor(runDir))).toContain("composition-plan.json");
  }, 180000);

  it("recovers when an organization deck becomes a plain one", async () => {
    const pack = await packWithTemplate();
    fs.writeFileSync(path.join(pack, "brand.yaml"), ["name: Recovery Test", "palette:", '  background: "FFFFFF"', '  surface: "FFFFFF"', '  text: "111111"', '  primary: "123456"', '  accent: "654321"', '  muted: "666666"', '  border: "DDDDDD"'].join("\n"));
    fs.writeFileSync(path.join(pack, "template-map.json"), JSON.stringify({
      version: 2,
      aspectRatio: "16:9",
      chromeOwnership: { background: "template", logo: "template", footer: "template", pageNumber: "template" },
      defaultLayout: { nativeLayout: "DEFAULT", canvasColor: "FFFFFF", contentRegion: { x: 0.72, y: 0.48, w: 11.85, h: 6.14 }, reservedRegions: [] },
      layouts: {},
      requiredElements: [],
      elementRoleOverrides: {},
    }));
    cli(["template-analyze", "--input", path.join(pack, "template.pptx"), "--out", pack]);

    const { runDir, contractPath, planPath, contentModelPath } = writeRun({ ...contract, organization: { kind: "directory", path: pack } });
    cli(["plan-validate", "--plan", planPath, "--content-model", contentModelPath, "--run-dir", runDir]);
    cli(["style", "--contract", contractPath, "--run-dir", runDir]);
    expect(fs.existsSync(path.join(runDir, "template-grammar.json"))).toBe(true);

    fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2));
    cli(["plan-validate", "--plan", planPath, "--content-model", contentModelPath, "--run-dir", runDir]);
    expect(fs.existsSync(path.join(runDir, "template-grammar.json"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(runDir, "artifact-provenance.json"), "utf8")).templateGrammarDigest).toBeUndefined();

    cli(["style", "--contract", contractPath, "--run-dir", runDir]);
    expect(cli(resolveArgsFor(runDir))).toContain("composition-plan.json");
  }, 180000);

  it("keeps a stale reference selection from reaching style resolution", () => {
    const withReferences = { ...contract, referenceIds: ["presentation_core"] };
    const { runDir, contractPath, planPath, contentModelPath } = writeRun(withReferences);
    cli(["plan-validate", "--plan", planPath, "--content-model", contentModelPath, "--run-dir", runDir]);
    cli(["reference", "--contract", contractPath, "--reference-root", path.join(repoRoot, "tests/fixtures/reference-root"), "--run-dir", runDir]);
    fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2));
    cli(["plan-validate", "--plan", planPath, "--content-model", contentModelPath, "--run-dir", runDir]);
    cli(["style", "--contract", contractPath, "--run-dir", runDir]);
    const style = JSON.parse(fs.readFileSync(path.join(runDir, "resolved-style.json"), "utf8"));
    expect(style.reference).toBeUndefined();
  }, 180000);
});

describe("composition-resolve provenance chain", () => {
  function plannedRun(): { runDir: string; resolveArgs: string[] } {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-provenance-"));
    const contractPath = path.join(runDir, "contract.json");
    fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2));
    const contentModelPath = path.join(runDir, "source-content-model.json");
    fs.writeFileSync(contentModelPath, JSON.stringify(contentModel, null, 2));
    const planPath = path.join(runDir, "plan-input.json");
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    cli(["plan-validate", "--plan", planPath, "--content-model", contentModelPath, "--run-dir", runDir]);
    cli(["style", "--contract", contractPath, "--run-dir", runDir]);
    return { runDir, resolveArgs: ["composition-resolve", "--plan", path.join(runDir, "deck-plan.json"), "--style-context", path.join(runDir, "style-context.json"), "--run-dir", runDir] };
  }

  it("resolves once every recorded input still matches", () => {
    const { resolveArgs } = plannedRun();
    expect(cli(resolveArgs)).toContain("composition-plan.json");
  }, 120000);

  it("blocks when the contract changed after planning", () => {
    const { runDir, resolveArgs } = plannedRun();
    fs.writeFileSync(path.join(runDir, "contract.json"), JSON.stringify({ ...contract, audience: "Board" }, null, 2));
    expect(cli(resolveArgs, { expectFailure: true })).toMatch(/contract\.json changed after it was recorded/);
  }, 120000);

  it("blocks when a recorded input went missing", () => {
    const { runDir, resolveArgs } = plannedRun();
    fs.rmSync(path.join(runDir, "content-model.json"));
    expect(cli(resolveArgs, { expectFailure: true })).toMatch(/content-model\.json is recorded/);
  }, 120000);

  it("blocks when the resolved style changed after style resolution", () => {
    const { runDir, resolveArgs } = plannedRun();
    const stylePath = path.join(runDir, "style-context.json");
    fs.writeFileSync(stylePath, JSON.stringify({ ...JSON.parse(fs.readFileSync(stylePath, "utf8")), tampered: true }, null, 2));
    expect(cli(resolveArgs, { expectFailure: true })).toMatch(/style-context\.json changed after style resolution/);
  }, 120000);

  it("blocks composition resolution while a planning risk is unresolved", () => {
    // The strict planning gate, exercised end to end: `review` is not a caveat, it is a stop.
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-planning-risk-"));
    const contractPath = path.join(runDir, "contract.json");
    fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2));
    const contentModelPath = path.join(runDir, "source-content-model.json");
    fs.writeFileSync(contentModelPath, JSON.stringify(contentModel, null, 2));
    const planPath = path.join(runDir, "plan-input.json");
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    const findingsPath = path.join(runDir, "plan-findings.json");
    fs.writeFileSync(findingsPath, JSON.stringify([{ code: "REPEATED_VISUAL_INTENT", message: "Three slides in a row read the same way." }]));
    cli(["plan-validate", "--plan", planPath, "--content-model", contentModelPath, "--run-dir", runDir, "--findings", findingsPath], { expectFailure: true });
    expect(JSON.parse(fs.readFileSync(path.join(runDir, "planning-qa.json"), "utf8")).status).toBe("review");
    cli(["style", "--contract", contractPath, "--run-dir", runDir]);
    const resolveArgs = ["composition-resolve", "--plan", path.join(runDir, "deck-plan.json"), "--style-context", path.join(runDir, "style-context.json"), "--run-dir", runDir];
    expect(cli(resolveArgs, { expectFailure: true })).toMatch(/status must be `pass`/);
  }, 120000);

  it("blocks a mixed run where style was derived from the previous contract", () => {
    // Every file matches its own digest here: only the causal edge is wrong.
    const { runDir, resolveArgs } = plannedRun();
    const contractPath = path.join(runDir, "contract.json");
    fs.writeFileSync(contractPath, JSON.stringify({ ...contract, audience: "Board" }, null, 2));
    cli(["plan-validate", "--plan", path.join(runDir, "plan-input.json"), "--content-model", path.join(runDir, "source-content-model.json"), "--run-dir", runDir]);
    // The style derived from contract A is not merely flagged, it is gone: plan-validate invalidates
    // what its changed root inputs made obsolete, so there is nothing left to resolve against.
    expect(fs.existsSync(path.join(runDir, "style-context.json"))).toBe(false);
    expect(cli(resolveArgs, { expectFailure: true })).toMatch(/requires style provenance/);

    // Re-running the dependent phase in order clears it.
    cli(["style", "--contract", contractPath, "--run-dir", runDir]);
    expect(cli(resolveArgs)).toContain("composition-plan.json");
  }, 120000);

  it("blocks a style resolved before the reference selection it should have read", () => {
    // Phase order matters: style reads the reference selection, so resolving references afterwards
    // leaves a style that never saw them. Every file is fresh; only the causal edge is wrong.
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-order-"));
    const contractPath = path.join(runDir, "contract.json");
    fs.writeFileSync(contractPath, JSON.stringify({ ...contract, referenceIds: ["presentation_core"] }, null, 2));
    const contentModelPath = path.join(runDir, "source-content-model.json");
    fs.writeFileSync(contentModelPath, JSON.stringify(contentModel, null, 2));
    const planPath = path.join(runDir, "plan-input.json");
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    cli(["plan-validate", "--plan", planPath, "--content-model", contentModelPath, "--run-dir", runDir]);
    cli(["style", "--contract", contractPath, "--run-dir", runDir]);
    cli(["reference", "--contract", contractPath, "--reference-root", path.join(repoRoot, "tests/fixtures/reference-root"), "--run-dir", runDir]);
    const resolveArgs = ["composition-resolve", "--plan", path.join(runDir, "deck-plan.json"), "--style-context", path.join(runDir, "style-context.json"), "--run-dir", runDir];
    expect(cli(resolveArgs, { expectFailure: true })).toMatch(/derived from a different reference selection/);

    cli(["style", "--contract", contractPath, "--run-dir", runDir]);
    expect(cli(resolveArgs)).toContain("composition-plan.json");
  }, 180000);

  it("refuses to derive style or references from a contract that is not the run's", () => {
    const { runDir } = plannedRun();
    const otherContract = path.join(runDir, "contract-b.json");
    fs.writeFileSync(otherContract, JSON.stringify({ ...contract, audience: "Board" }, null, 2));
    expect(cli(["style", "--contract", otherContract, "--run-dir", runDir], { expectFailure: true })).toMatch(/--contract does not match/);
    expect(cli(["reference", "--contract", otherContract, "--reference-root", path.join(repoRoot, "tests/fixtures/reference-root"), "--run-dir", runDir], { expectFailure: true })).toMatch(/--contract does not match/);
  }, 120000);

  it("blocks an input that appeared after the digests were recorded", () => {
    // A reference selection dropped in after planning was never part of what produced these digests.
    const { runDir, resolveArgs } = plannedRun();
    fs.writeFileSync(path.join(runDir, "reference-selection.json"), JSON.stringify([{ id: "R01" }], null, 2));
    expect(cli(resolveArgs, { expectFailure: true })).toMatch(/reference-selection\.json exists but is not recorded/);
  }, 120000);
});
