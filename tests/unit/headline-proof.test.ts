import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { structuralQa } from "../../src/qa";

// This is the actual Japan Career Agent regression: S07's headline claims "18 skills" over a
// visual that only shows 5 stage cards. The check is deterministic — it counts what the
// composition actually draws and compares it to the number in the headline — so it belongs in
// Core QA, not a judgment call left to Visual QA.
const deck = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/japan-career-agent/deck.json"), "utf8"));
const contentModel = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/japan-career-agent/content-model.json"), "utf8"));

function withS07Steps(steps: unknown[]) {
  return {
    ...deck,
    slides: deck.slides.map((slide: { id: string }) => (slide.id === "S07" ? { ...slide, content: { steps } } : slide)),
  };
}

describe("headline-visual proof (VISUAL_DOES_NOT_PROVE_HEADLINE)", () => {
  it("flags S07 as authored: '18 skills' over 5 stage cards with no members", () => {
    const report = structuralQa(deck, process.cwd(), contentModel);
    const finding = report.findings.find((candidate) => candidate.code === "VISUAL_DOES_NOT_PROVE_HEADLINE" && candidate.slideId === "S07");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("hard");
  });

  it("passes once the stages carry named members that sum to the claimed count", () => {
    const original = deck.slides.find((slide: { id: string }) => slide.id === "S07").content.steps as Array<{ id: string; label: string }>;
    const membersByStage = [4, 4, 4, 3, 3]; // sums to 18, matching the "18 skills" headline
    const steps = original.map((step, index) => ({
      ...step,
      members: Array.from({ length: membersByStage[index] }, (_, memberIndex) => `Skill ${index + 1}.${memberIndex + 1}`),
    }));
    const report = structuralQa(withS07Steps(steps), process.cwd(), contentModel);
    expect(report.findings.some((finding) => finding.code === "VISUAL_DOES_NOT_PROVE_HEADLINE")).toBe(false);
  });

  it("never fires when the headline's number does not exceed what the visual shows", () => {
    const original = deck.slides.find((slide: { id: string }) => slide.id === "S07").content.steps;
    const report = structuralQa(
      {
        ...deck,
        slides: deck.slides.map((slide: { id: string; headline: string; claims: unknown[] }) =>
          slide.id === "S07" ? { ...slide, headline: "5 stages, one job each", claims: [{ ...(slide.claims as Array<{ text: string }>)[0], text: "5 stages, one job each" }] } : slide,
        ),
      },
      process.cwd(),
      contentModel,
    );
    expect(report.findings.some((finding) => finding.code === "VISUAL_DOES_NOT_PROVE_HEADLINE")).toBe(false);
  });
});
