import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deckPlanDigest } from "../../src/planning";
import { pilotSelect, slideContext, storylinePlanValidate, storylineValidate } from "../../src/planning-run-cli";
import { writeArtifactProvenance, type ArtifactProvenance } from "../../src/provenance";

const contract = {
  sources: [{ kind: "prompt", id: "brief", text: "Rollout brief" }],
  purpose: "executive",
  audience: "Executive committee",
  objective: "Decide whether to fund the rollout",
  audienceDecision: "Approve the rollout",
  designDirection: "balanced",
  presentationStyle: "executive",
  storyline: ["opening", "evidence", "insight", "closing"],
  language: "en-US",
  slideCount: 4,
  brand: { kind: "default" },
  fonts: { heading: "Arial", body: "Arial" },
  fontDelivery: "managed_device",
  editability: "native_editable",
  aspectRatio: "16:9",
};

const contentModel = {
  version: 1,
  sources: [{
    sourceId: "brief",
    excerpts: [
      { id: "e1", locator: "p1", text: "Enterprise revenue grew 18%." },
      { id: "e2", locator: "p2", text: "Pilot conversion increased from 11% to 16%." },
      { id: "e3", locator: "p3", text: "Retention stayed above the target threshold." },
      { id: "e4", locator: "p4", text: "The rollout requires one additional approval gate." },
    ],
  }],
};

const storyline = {
  version: 1,
  title: "Rollout decision",
  narrativeThesis: "The pilot supports a controlled rollout.",
  audienceDecision: "Approve the rollout",
  slides: [
    { id: "S01", storyBeat: "opening", assertion: "The pilot supports a controlled rollout", evidenceRefs: [{ sourceId: "brief", excerptId: "e1" }], implication: "Growth warrants a decision.", decisionImpact: "Frames the approval question.", visualStrategy: "statement", speakerNotes: "Opening note" },
    { id: "S02", storyBeat: "evidence", assertion: "Conversion improved by five points in the pilot", evidenceRefs: [{ sourceId: "brief", excerptId: "e2" }, { sourceId: "brief", excerptId: "e1" }], implication: "Demand quality improved.", decisionImpact: "Reduces demand-side uncertainty.", visualStrategy: "before_after", speakerNotes: "Evidence note" },
    { id: "S03", storyBeat: "insight", assertion: "Retention remained above the target threshold", evidenceRefs: [{ sourceId: "brief", excerptId: "e3" }], implication: "The conversion gain did not immediately trade off retention.", decisionImpact: "Reduces quality uncertainty.", visualStrategy: "chart", speakerNotes: "Insight note" },
    { id: "S04", storyBeat: "closing", assertion: "A controlled rollout should retain one approval gate", evidenceRefs: [{ sourceId: "brief", excerptId: "e4" }], implication: "Expansion can proceed without removing governance.", decisionImpact: "Approve rollout with the gate retained.", visualStrategy: "roadmap", speakerNotes: "Closing note" },
  ],
};

const plan = {
  version: 1,
  title: "Rollout decision",
  narrativeThesis: "The pilot supports a controlled rollout.",
  slides: [
    { id: "S01", storyBeat: "opening", thesis: "The pilot supports a controlled rollout", function: "cover", primaryEvidence: [{ sourceId: "brief", excerptId: "e1" }], secondaryEvidence: [], visualIntent: "single_focal", density: "low", takeaway: "Decision frame" },
    { id: "S02", storyBeat: "evidence", thesis: "Conversion improved by five points in the pilot", function: "quantitative", primaryEvidence: [{ sourceId: "brief", excerptId: "e2" }], secondaryEvidence: [{ sourceId: "brief", excerptId: "e1" }], visualIntent: "trend", density: "high", takeaway: "Pilot improved" },
    { id: "S03", storyBeat: "insight", thesis: "Retention remained above the target threshold", function: "comparison", primaryEvidence: [{ sourceId: "brief", excerptId: "e3" }], secondaryEvidence: [], visualIntent: "contrast", density: "medium", takeaway: "Quality held" },
    { id: "S04", storyBeat: "closing", thesis: "A controlled rollout should retain one approval gate", function: "action", primaryEvidence: [{ sourceId: "brief", excerptId: "e4" }], secondaryEvidence: [], visualIntent: "timeline", density: "low", takeaway: "Retain governance" },
  ],
};

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

describe("planning run gates", () => {
  it("binds storyline -> validated plan -> compact pilot context and rejects stale storyline reuse", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-planning-"));
    const runDir = path.join(root, "run");
    fs.mkdirSync(runDir, { recursive: true });
    const contractPath = path.join(runDir, "contract.json");
    const contentModelPath = path.join(root, "content-model.json");
    const storylinePath = path.join(root, "storyline.json");
    writeJson(contractPath, contract);
    writeJson(contentModelPath, contentModel);
    writeJson(storylinePath, storyline);

    const storylineResult = storylineValidate({ runDir, storylinePath, contentModelPath });
    expect(storylineResult.status).toBe("pass");
    expect(storylineResult.contextBytes).toBeGreaterThan(0);

    const runPlanPath = path.join(runDir, "deck-plan.json");
    writeJson(runPlanPath, plan);
    writeJson(path.join(runDir, "planning-qa.json"), { status: "pass", findings: [], plan });
    const provenancePath = path.join(runDir, "artifact-provenance.json");
    const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8")) as ArtifactProvenance;
    writeArtifactProvenance(runDir, { ...provenance, deckPlanDigest: deckPlanDigest(plan) });

    expect(storylinePlanValidate({ runDir })).toMatchObject({ status: "pass", findings: 0 });
    const pilot = pilotSelect({ runDir });
    expect(pilot.slideIds).toEqual(["S01", "S02", "S03"]);
    expect(pilot.contextByteProxy.pilot).toBeLessThan(pilot.contextByteProxy.fullDeck);
    expect(pilot.contextByteProxy.reductionPercent).toBeGreaterThan(0);

    const local = slideContext({ runDir, slideId: "S02" });
    expect(local.context.slides.map((slide) => slide.id)).toEqual(["S02"]);
    expect(local.contextBytes).toBeLessThan(pilot.contextByteProxy.pilot);

    const mutated = structuredClone(storyline);
    mutated.slides[1].assertion = "A changed assertion after validation";
    writeJson(path.join(runDir, "storyline.json"), mutated);
    expect(() => pilotSelect({ runDir })).toThrow(/storyline\.json changed after storyline validation/i);
  });
});
