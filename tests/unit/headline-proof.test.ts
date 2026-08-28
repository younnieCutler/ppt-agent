import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { structuralQa } from "../../src/qa";

// This is the actual Japan Career Agent regression: S07's headline claims "18 skills" over a
// visual that only shows 5 stage cards. Two detection paths exist:
//   - a generic heuristic (headline number vs. the layout's natural countable collection) —
//     weak evidence, so a mismatch is `risk`;
//   - an explicit `visualProof` contract naming exactly which collection proves exactly which
//     number — unambiguous once authored, so a violation is `hard`.
const deck = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/japan-career-agent/deck.json"), "utf8"));
const contentModel = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/japan-career-agent/content-model.json"), "utf8"));

function withS07(patch: (slide: Record<string, unknown>) => Record<string, unknown>) {
  return {
    ...deck,
    slides: deck.slides.map((slide: Record<string, unknown>) => (slide.id === "S07" ? patch(slide) : slide)),
  };
}

function withS07Steps(steps: unknown[]) {
  return withS07((slide) => ({ ...slide, content: { steps } }));
}

const membersByStage = [4, 4, 4, 3, 3]; // sums to 18, matching the "18 skills" headline

function stepsWithMembers(): Array<Record<string, unknown>> {
  const original = deck.slides.find((slide: { id: string }) => slide.id === "S07").content.steps as Array<{ id: string; label: string }>;
  return original.map((step, index) => ({
    ...step,
    members: Array.from({ length: membersByStage[index] }, (_, memberIndex) => `Skill ${index + 1}.${memberIndex + 1}`),
  }));
}

describe("headline-visual proof (VISUAL_DOES_NOT_PROVE_HEADLINE)", () => {
  it("flags S07 as authored via the heuristic only — risk, not hard, since no visualProof is declared", () => {
    const report = structuralQa(deck, process.cwd(), contentModel);
    const finding = report.findings.find((candidate) => candidate.code === "VISUAL_DOES_NOT_PROVE_HEADLINE" && candidate.slideId === "S07");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("risk");
  });

  it("clears the heuristic once the stages carry named members that sum to the claimed count", () => {
    const report = structuralQa(withS07Steps(stepsWithMembers()), process.cwd(), contentModel);
    expect(report.findings.some((finding) => finding.code === "VISUAL_DOES_NOT_PROVE_HEADLINE")).toBe(false);
  });

  it("never fires the heuristic when the headline's number does not exceed what the visual shows", () => {
    const report = structuralQa(
      withS07((slide) => ({ ...slide, headline: "5 stages, one job each", claims: [{ ...(slide.claims as Array<{ text: string }>)[0], text: "5 stages, one job each" }] })),
      process.cwd(),
      contentModel,
    );
    expect(report.findings.some((finding) => finding.code === "VISUAL_DOES_NOT_PROVE_HEADLINE")).toBe(false);
  });

  it("hard-fails when an explicit visualProof contract is violated", () => {
    // Declares 18 via process.members, but the stages carry no members at all (0 total) —
    // an explicit, unambiguous contract violation.
    const report = structuralQa(
      withS07((slide) => ({ ...slide, visualProof: { kind: "count", value: 18, collection: "process.members" } })),
      process.cwd(),
      contentModel,
    );
    const finding = report.findings.find((candidate) => candidate.code === "VISUAL_DOES_NOT_PROVE_HEADLINE" && candidate.slideId === "S07");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("hard");
  });

  it("passes when the explicit visualProof contract is satisfied", () => {
    const report = structuralQa(
      withS07((slide) => ({
        ...slide,
        content: { steps: stepsWithMembers() },
        visualProof: { kind: "count", value: 18, collection: "process.members" },
      })),
      process.cwd(),
      contentModel,
    );
    expect(report.findings.some((finding) => finding.code === "VISUAL_DOES_NOT_PROVE_HEADLINE")).toBe(false);
  });

  it("hard-fails when the declared collection does not apply to the slide's layout", () => {
    const report = structuralQa(
      withS07((slide) => ({ ...slide, visualProof: { kind: "count", value: 18, collection: "architecture.nodes" } })),
      process.cwd(),
      contentModel,
    );
    const finding = report.findings.find((candidate) => candidate.code === "VISUAL_DOES_NOT_PROVE_HEADLINE" && candidate.slideId === "S07");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("hard");
    expect(finding?.message).toMatch(/does not apply to layout/);
  });
});
