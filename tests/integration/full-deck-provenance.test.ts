import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fullDeckAssemble, fullSlideApply } from "../../src/full-deck-run-cli";
import { buildPilotDeckEnvelope, pilotSpecArtifactSchema, pilotEnvelopeDigest, pilotSpecDigest } from "../../src/pilot-authoring";
import { deckPlanDigest, verifyDeckAgainstPlan } from "../../src/planning";
import { sha256File, writeArtifactProvenance, type ArtifactProvenance } from "../../src/provenance";
import { storylineBlueprintDigest } from "../../src/storyline";

const tempDirs: string[] = [];
afterEach(() => tempDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-assembly-prov-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

const ref = { sourceId: "brief", excerptId: "E01" };
const beats = ["opening", "evidence", "insight", "closing"] as const;
const contract = {
  sources: [{ kind: "prompt", id: "brief", text: "Brief" }],
  purpose: "internal",
  audience: "Team",
  storyline: [...beats],
  language: "en",
  slideCount: 4,
  brand: { kind: "default" },
  fonts: { heading: "Arial", body: "Arial" },
  aspectRatio: "16:9",
};
const plan = {
  version: 1,
  title: "Assembly provenance",
  narrativeThesis: "One chain",
  slides: beats.map((storyBeat, index) => ({
    id: `S0${index + 1}`,
    storyBeat,
    thesis: `Thesis ${index + 1}`,
    function: "statement" as const,
    primaryEvidence: [ref],
    secondaryEvidence: [],
    visualIntent: "hierarchy" as const,
    density: "medium" as const,
    takeaway: `Takeaway ${index + 1}`,
  })),
};
const compositionPlan = {
  version: 1,
  slides: plan.slides.map((slide) => ({ id: slide.id, candidates: [{ layout: "statement", composition: "hero_evidence", family: "split_panels", rank: 1, reasons: ["visual intent"] }] })),
};
const storyline = {
  version: 1,
  title: plan.title,
  narrativeThesis: plan.narrativeThesis,
  audienceDecision: "Understand",
  slides: plan.slides.map((slide, index) => ({
    id: slide.id,
    storyBeat: slide.storyBeat,
    assertion: slide.thesis,
    evidenceRefs: [ref],
    implication: `Implication ${index + 1}`,
    decisionImpact: `Decision ${index + 1}`,
    visualStrategy: "statement" as const,
    speakerNotes: "",
  })),
};

function slide(index: number) {
  return {
    id: `S0${index}`,
    role: "body",
    storyBeat: beats[index - 1],
    headline: `Thesis ${index}`,
    claims: [{ text: `Thesis ${index}`, kind: "fact" as const, status: "verified" as const }],
    composition: "hero_evidence",
    sourceRefs: [ref],
    layout: "statement" as const,
    content: { body: `Body ${index}`, proofs: [] },
  };
}

function setupAssembledRun(): { runDir: string; deck: unknown } {
  const runDir = tempDir();
  const planPath = path.join(runDir, "deck-plan.json");
  const compositionPath = path.join(runDir, "composition-plan.json");
  const storylinePath = path.join(runDir, "storyline.json");
  writeJson(path.join(runDir, "contract.json"), contract);
  writeJson(planPath, plan);
  writeJson(compositionPath, compositionPlan);
  writeJson(storylinePath, storyline);

  const pilot = pilotSpecArtifactSchema.parse({
    version: 1,
    selectionDigest: "e".repeat(64),
    deckPlanDigest: deckPlanDigest(plan),
    compositionPlanDigest: sha256File(compositionPath),
    slides: [slide(1), slide(2), slide(3)],
  });
  const pilotDeck = buildPilotDeckEnvelope(contract, plan.title, pilot);
  const pilotSpecPath = path.join(runDir, "pilot-spec.json");
  const pilotDeckPath = path.join(runDir, "pilot-deck.json");
  writeJson(pilotSpecPath, pilot);
  writeJson(pilotDeckPath, pilotDeck);

  const corePath = path.join(runDir, "pilot-core-qa.json");
  const visualPath = path.join(runDir, "pilot-visual-qa.json");
  const approvalPath = path.join(runDir, "pilot-approval.json");
  writeJson(corePath, { status: "pass", findings: [] });
  writeJson(visualPath, { status: "pass", findings: [] });
  writeJson(approvalPath, { version: 1, status: "pass" });

  const provenance: ArtifactProvenance = {
    contractDigest: "1".repeat(64),
    contentModelDigest: "2".repeat(64),
    deckPlanDigest: deckPlanDigest(plan),
    compositionPlanDigest: sha256File(compositionPath),
    storylineDigest: storylineBlueprintDigest(storyline),
    pilotSpecDigest: pilotSpecDigest(pilot),
    pilotDeckDigest: pilotEnvelopeDigest(pilotDeck),
    pilotApprovalDigest: sha256File(approvalPath),
    pilotApprovalSource: {
      pilotSpecDigest: pilotSpecDigest(pilot),
      pilotDeckDigest: pilotEnvelopeDigest(pilotDeck),
      pilotCoreQaDigest: sha256File(corePath),
      pilotVisualQaDigest: sha256File(visualPath),
      pilotPptxDigest: "3".repeat(64),
      renderProvenanceDigest: "4".repeat(64),
    },
  };
  writeArtifactProvenance(runDir, provenance);

  const inputPath = path.join(runDir, "S04-input.json");
  writeJson(inputPath, { version: 1, slide: slide(4) });
  expect(fullSlideApply(runDir, "S04", inputPath).status).toBe("pass");
  expect(fullDeckAssemble(runDir).status).toBe("pass");
  return { runDir, deck: JSON.parse(fs.readFileSync(path.join(runDir, "deck.json"), "utf8")) };
}

describe("canonical assembled-deck provenance", () => {
  it("passes a current assembled deck through the same verifier used by validate/render/qa", () => {
    const { runDir, deck } = setupAssembledRun();
    expect(verifyDeckAgainstPlan(deck, plan, compositionPlan, runDir)).toEqual([]);
  });

  it("blocks validate/render/qa verification when a validated non-pilot artifact changes after assembly", () => {
    const { runDir, deck } = setupAssembledRun();
    const artifactPath = path.join(runDir, "full-slides", "slide-S04.json");
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    artifact.slide.content.body = "Changed after assembly";
    writeJson(artifactPath, artifact);
    expect(() => verifyDeckAgainstPlan(deck, plan, compositionPlan, runDir)).toThrow(/validated slide artifact 'S04' changed after assembly/);
  });

  it("uses the CLI --run-dir automatically without changing existing cli.ts call sites", () => {
    const { runDir, deck } = setupAssembledRun();
    const originalArgv = process.argv;
    try {
      process.argv = ["node", "dist/cli.js", "validate", "--spec", path.join(runDir, "deck.json"), "--run-dir", runDir];
      expect(verifyDeckAgainstPlan(deck, plan, compositionPlan)).toEqual([]);
      writeJson(path.join(runDir, "pilot-approval.json"), { version: 1, status: "fail" });
      expect(() => verifyDeckAgainstPlan(deck, plan, compositionPlan)).toThrow(/pilot approval changed after assembly/);
    } finally {
      process.argv = originalArgv;
    }
  });

  it("keeps pre-assembly DeckSpec v2 runs backward compatible", () => {
    const runDir = tempDir();
    const deck = {
      version: 2,
      planDigest: deckPlanDigest(plan),
      contract,
      title: plan.title,
      slides: plan.slides.map((_, index) => slide(index + 1)),
    };
    expect(verifyDeckAgainstPlan(deck, plan, compositionPlan, runDir)).toEqual([]);
  });
});
