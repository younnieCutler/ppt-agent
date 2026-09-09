import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fullDeckAssemble, fullSlideApply } from "../../src/full-deck-run-cli";
import { deckPlanDigest } from "../../src/planning";
import { buildPilotDeckEnvelope, pilotSpecArtifactSchema, pilotEnvelopeDigest, pilotSpecDigest } from "../../src/pilot-authoring";
import { sha256File, writeArtifactProvenance, type ArtifactProvenance } from "../../src/provenance";
import { storylineBlueprintDigest } from "../../src/storyline";

const tempDirs: string[] = [];
afterEach(() => tempDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-full-deck-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

const ref = { sourceId: "brief", excerptId: "E01" };
const beats = ["opening", "evidence", "evidence", "insight", "closing"] as const;

const contract = {
  sources: [{ kind: "prompt", id: "brief", text: "Brief" }],
  purpose: "internal",
  audience: "Team",
  storyline: ["opening", "evidence", "insight", "closing"],
  language: "en",
  slideCount: 5,
  brand: { kind: "default" },
  fonts: { heading: "Arial", body: "Arial" },
  aspectRatio: "16:9",
};

const plan = {
  version: 1,
  title: "Full deck",
  narrativeThesis: "One decision narrative",
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
  slides: plan.slides.map((slide) => ({ id: slide.id, candidates: [{ layout: "statement", composition: "hero_evidence", rank: 1 }] })),
};

const storyline = {
  version: 1,
  title: "Full deck",
  narrativeThesis: "One decision narrative",
  audienceDecision: "Understand the decision",
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

function setupRun(): string {
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
  return runDir;
}

describe("full deck run gate", () => {
  it("keeps deck.json locked until every non-pilot slide is validated, then assembles without reauthoring pilot slides", () => {
    const runDir = setupRun();
    const missing = fullDeckAssemble(runDir);
    expect(missing.status).toBe("fail");
    expect(fs.existsSync(path.join(runDir, "deck.json"))).toBe(false);

    const input4 = path.join(runDir, "input-S04.json");
    const input5 = path.join(runDir, "input-S05.json");
    writeJson(input4, { version: 1, slide: slide(4) });
    writeJson(input5, { version: 1, slide: slide(5) });
    expect(fullSlideApply(runDir, "S04", input4).status).toBe("pass");
    expect(fullSlideApply(runDir, "S05", input5).status).toBe("pass");

    const assembled = fullDeckAssemble(runDir);
    expect(assembled.status).toBe("pass");
    expect(assembled.pilotSlidesReused).toEqual(["S01", "S02", "S03"]);
    expect(assembled.authoredSlides).toEqual(["S04", "S05"]);
    const deck = JSON.parse(fs.readFileSync(path.join(runDir, "deck.json"), "utf8"));
    expect(deck.slides.map((item: { id: string }) => item.id)).toEqual(["S01", "S02", "S03", "S04", "S05"]);
    expect(deck.slides.slice(0, 3).map((item: { headline: string }) => item.headline)).toEqual(["Thesis 1", "Thesis 2", "Thesis 3"]);
    const qa = JSON.parse(fs.readFileSync(path.join(runDir, "full-deck-assembly-qa.json"), "utf8"));
    expect(qa.tokenPolicy).toEqual({ pilotReauthorCount: 0, assemblyModelCalls: 0 });
  });

  it("blocks attempts to submit a second authored version of a pilot slide", () => {
    const runDir = setupRun();
    const input = path.join(runDir, "input-S01.json");
    writeJson(input, { version: 1, slide: slide(1) });
    const result = fullSlideApply(runDir, "S01", input);
    expect(result.status).toBe("fail");
    expect((result.findings as Array<{ code: string }>).map((finding) => finding.code)).toContain("FULL_SLIDE_IS_APPROVED_PILOT");
  });

  it("rejects stale planning roots before accepting another slide artifact", () => {
    const runDir = setupRun();
    writeJson(path.join(runDir, "composition-plan.json"), { ...compositionPlan, changed: true });
    const input = path.join(runDir, "input-S04.json");
    writeJson(input, { version: 1, slide: slide(4) });
    expect(() => fullSlideApply(runDir, "S04", input)).toThrow(/composition-plan\.json is stale/);
  });
});
