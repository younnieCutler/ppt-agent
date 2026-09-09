import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildStorylinePlanningContext } from "../../src/planning-context";
import { deckPlanDigest } from "../../src/planning";
import { fullSlideContext, pilotApply, pilotAuthoringContext } from "../../src/pilot-run-cli";
import { sha256File, writeArtifactProvenance, type ArtifactProvenance } from "../../src/provenance";

const ref = { sourceId: "brief", excerptId: "e1" };
const contract = {
  sources: [{ kind: "prompt", id: "brief", text: "Evidence" }], purpose: "internal", audience: "Leadership", audienceDecision: "Approve",
  designDirection: "balanced", presentationStyle: "corporate", storyline: ["opening", "evidence", "insight", "closing"], language: "en-US", slideCount: 4,
  brand: { kind: "default" }, fonts: { heading: "Arial", body: "Arial" }, aspectRatio: "16:9",
};
const contentModel = { version: 1, sources: [{ sourceId: "brief", excerpts: [{ id: "e1", locator: "p1", text: "Evidence" }] }] };
const storyline = { version: 1, title: "Decision", narrativeThesis: "Proceed carefully", audienceDecision: "Approve", slides: [
  { id: "S01", storyBeat: "opening", assertion: "Proceed carefully", evidenceRefs: [ref], implication: "Frame", decisionImpact: "Frame", visualStrategy: "statement", speakerNotes: "" },
  { id: "S02", storyBeat: "evidence", assertion: "The pilot improved", evidenceRefs: [ref], implication: "Evidence", decisionImpact: "Reduce uncertainty", visualStrategy: "statement", speakerNotes: "" },
  { id: "S03", storyBeat: "insight", assertion: "Risk remains bounded", evidenceRefs: [ref], implication: "Risk", decisionImpact: "Bound risk", visualStrategy: "statement", speakerNotes: "" },
  { id: "S04", storyBeat: "closing", assertion: "Approve the rollout", evidenceRefs: [ref], implication: "Act", decisionImpact: "Approve", visualStrategy: "statement", speakerNotes: "" },
] };
const plan = { version: 1, title: "Decision", narrativeThesis: "Proceed carefully", slides: [
  { id: "S01", storyBeat: "opening", thesis: "Proceed carefully", function: "cover", primaryEvidence: [ref], secondaryEvidence: [], visualIntent: "single_focal", density: "low", takeaway: "Frame" },
  { id: "S02", storyBeat: "evidence", thesis: "The pilot improved", function: "statement", primaryEvidence: [ref], secondaryEvidence: [], visualIntent: "hierarchy", density: "medium", takeaway: "Evidence" },
  { id: "S03", storyBeat: "insight", thesis: "Risk remains bounded", function: "statement", primaryEvidence: [ref], secondaryEvidence: [], visualIntent: "hierarchy", density: "medium", takeaway: "Risk" },
  { id: "S04", storyBeat: "closing", thesis: "Approve the rollout", function: "action", primaryEvidence: [ref], secondaryEvidence: [], visualIntent: "flow", density: "low", takeaway: "Decision" },
] };
const compositionPlan = { version: 1, slides: [
  { id: "S01", candidates: [{ layout: "title", composition: "cover", rank: 1 }] },
  { id: "S02", candidates: [{ layout: "statement", composition: "hero_evidence", rank: 1 }] },
  { id: "S03", candidates: [{ layout: "statement", composition: "claim_actions", rank: 1 }] },
  { id: "S04", candidates: [{ layout: "statement", composition: "claim_actions", rank: 1 }] },
] };
const pilotSlides = { version: 1, slides: [
  { id: "S01", role: "cover", storyBeat: "opening", headline: "Proceed carefully", claims: [{ text: "Proceed carefully", kind: "interpretation", status: "verified" }], composition: "cover", sourceRefs: [ref], layout: "title", content: { subtitle: "Pilot" } },
  { id: "S02", role: "evidence", storyBeat: "evidence", headline: "The pilot improved", claims: [{ text: "The pilot improved", kind: "interpretation", status: "verified" }], composition: "hero_evidence", sourceRefs: [ref], layout: "statement", content: { body: "Evidence", proofs: ["Evidence"] } },
  { id: "S03", role: "insight", storyBeat: "insight", headline: "Risk remains bounded", claims: [{ text: "Risk remains bounded", kind: "interpretation", status: "verified" }], composition: "claim_actions", sourceRefs: [ref], layout: "statement", content: { body: "Risk", proofs: ["Control"] } },
] };

function writeJson(filePath: string, value: unknown): void { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, JSON.stringify(value, null, 2)); }

describe("pilot authoring approval gate", () => {
  it("blocks full authoring before approval and never reauthors approved pilot slides", () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-pilot-"));
    writeJson(path.join(runDir, "contract.json"), contract);
    writeJson(path.join(runDir, "content-model.json"), contentModel);
    writeJson(path.join(runDir, "storyline.json"), storyline);
    writeJson(path.join(runDir, "deck-plan.json"), plan);
    writeJson(path.join(runDir, "storyline-plan-qa.json"), { status: "pass", findings: [] });
    writeJson(path.join(runDir, "pilot-selection.json"), { version: 1, strategy: "representative_v1", slideIds: ["S01", "S02", "S03"], reasons: {} });
    writeJson(path.join(runDir, "pilot-context.json"), buildStorylinePlanningContext(storyline, contentModel, ["S01", "S02", "S03"]));
    writeJson(path.join(runDir, "style-context.json"), { themeId: "corporate", designDirection: "balanced", grammar: {}, locked: {} });
    writeJson(path.join(runDir, "composition-plan.json"), compositionPlan);
    const provenance: ArtifactProvenance = {
      contractDigest: sha256File(path.join(runDir, "contract.json")), contentModelDigest: sha256File(path.join(runDir, "content-model.json")), deckPlanDigest: deckPlanDigest(plan),
      storylineDigest: "1".repeat(64), storylinePlanQaDigest: sha256File(path.join(runDir, "storyline-plan-qa.json")),
      pilotSelectionDigest: sha256File(path.join(runDir, "pilot-selection.json")), pilotContextDigest: sha256File(path.join(runDir, "pilot-context.json")),
      resolvedStyleDigest: sha256File(path.join(runDir, "style-context.json")), compositionPlanDigest: sha256File(path.join(runDir, "composition-plan.json")),
    };
    writeArtifactProvenance(runDir, provenance);

    const context = pilotAuthoringContext(runDir);
    expect(context.slides).toEqual(["S01", "S02", "S03"]);
    const inputPath = path.join(runDir, "pilot-slides-input.json"); writeJson(inputPath, pilotSlides);
    expect(pilotApply(runDir, inputPath)).toMatchObject({ status: "pass", renderMode: "generic" });
    expect(() => fullSlideContext(runDir, "S04")).toThrow(/pilot-approval\.json/i);

    const current = JSON.parse(fs.readFileSync(path.join(runDir, "artifact-provenance.json"), "utf8")) as ArtifactProvenance;
    writeJson(path.join(runDir, "pilot-core-qa.json"), { status: "pass", findings: [] });
    writeJson(path.join(runDir, "pilot-visual-qa.json"), { status: "pass", findings: [] });
    const coreDigest = sha256File(path.join(runDir, "pilot-core-qa.json"));
    const visualDigest = sha256File(path.join(runDir, "pilot-visual-qa.json"));
    writeJson(path.join(runDir, "pilot-approval.json"), { status: "pass" });
    const approvalDigest = sha256File(path.join(runDir, "pilot-approval.json"));
    writeArtifactProvenance(runDir, { ...current, pilotCoreQaDigest: coreDigest, pilotVisualQaDigest: visualDigest, pilotApprovalDigest: approvalDigest, pilotApprovalSource: {
      pilotSpecDigest: current.pilotSpecDigest!, pilotDeckDigest: current.pilotDeckDigest!, pilotCoreQaDigest: coreDigest, pilotVisualQaDigest: visualDigest,
      pilotPptxDigest: "2".repeat(64), renderProvenanceDigest: "3".repeat(64),
    } });

    expect(() => fullSlideContext(runDir, "S01")).toThrow(/already approved in the pilot/i);
    const full = fullSlideContext(runDir, "S04");
    expect((full.context as { composition: Array<{ id: string }> }).composition).toEqual([expect.objectContaining({ id: "S04" })]);
  });
});
