import { describe, expect, it } from "vitest";
import type { GenerativeAuthoringRequest } from "../../src/generative-authoring";
import type { GenerativeSceneIntent } from "../../src/generative-scene";
import { buildGenerativeSceneRepairRequest } from "../../src/generative-scene-repair";
import { buildGenerativeVisualCriticRequest, parseGenerativeVisualCriticResponse } from "../../src/generative-visual-critic";

const sourceDigest = "a".repeat(64);

function scene(slideId: string, headline: string): GenerativeSceneIntent {
  return {
    version: 2,
    slideId,
    semanticIntent: "statement",
    headline,
    contentRegionId: "content-main",
    layout: {
      strategy: "model_authored",
      nodes: [
        { id: `${slideId}-headline`, role: "headline", text: headline, frame: { x: 0.05, y: 0.05, w: 0.8, h: 0.15 }, emphasis: 1, styleRole: "title" },
      ],
    },
    constraints: { chrome: "immutable", colors: "template_only", fonts: "template_only" },
  };
}

function authoringRequest(): GenerativeAuthoringRequest {
  return {
    version: 1,
    requestDigest: "b".repeat(64),
    sourceDigest,
    elementsDigest: "c".repeat(64),
    instructions: {
      compositionAuthority: "model_authored",
      coordinateSpace: "normalized_content_region_0_1",
      sourceSlideGeometry: "reference_only",
      preserveAllContentAtoms: true,
      forbidInventedText: true,
      chrome: "immutable",
      colors: "template_only",
      fonts: "template_only",
    },
    brand: {
      contentRegionId: "content-main",
      allowedFonts: ["Aptos"],
      allowedColors: ["111111"],
      allowedTextStyleRoles: ["title"],
      allowedComponentKinds: ["title_block"],
      blockedRegions: [],
    },
    references: [],
    slides: ["S10", "S11"].map((id, index) => ({
      id,
      semanticIntent: "statement" as const,
      storyBeat: "evidence" as const,
      layout: "statement" as const,
      headline: `Headline ${index + 1}`,
      headlineAlignment: "left" as const,
      compositionHint: "statement",
      contentAtoms: [{ id: `${id}.headline`, text: `Headline ${index + 1}`, roleHint: "headline" as const, importance: "primary" as const, group: "headline" }],
      relationships: [],
    })),
  };
}

const passingScores = {
  visualHierarchy: 9,
  compositionBalance: 9,
  purposeFit: 9,
  readability: 9,
  professionalism: 9,
  templateFit: 9,
};

describe("Generative Scene repair deck findings", () => {
  it("keeps deck-level repair context when every individual slide score already passes", () => {
    const request = buildGenerativeVisualCriticRequest({
      authoringRequest: authoringRequest(),
      renderedScenes: [
        { slideId: "S10", imagePath: "visual/s10.png", imageSha256: "d".repeat(64), scene: scene("S10", "Headline 1") },
        { slideId: "S11", imagePath: "visual/s11.png", imageSha256: "e".repeat(64), scene: scene("S11", "Headline 2") },
      ],
      renderDigest: "f".repeat(64),
      round: 0,
    });
    const response = {
      version: 1 as const,
      requestDigest: request.requestDigest,
      sourceDigest: request.sourceDigest,
      renderDigest: request.renderDigest,
      slides: ["S10", "S11"].map((slideId) => ({
        slideId,
        scores: { ...passingScores },
        findings: [],
        summary: "Individually strong",
      })),
      deckFindings: [{
        code: "LAYOUT_REPETITION" as const,
        message: "The two slides repeat the same composition and need deck-level variation.",
        slideIds: ["S10", "S11"],
      }],
    };

    const parsed = parseGenerativeVisualCriticResponse(request, response);
    expect(parsed.repairSlideIds).toEqual(["S10", "S11"]);
    expect(parsed.passedSlideIds).toEqual([]);

    const repair = buildGenerativeSceneRepairRequest(request, parsed.response, "S10");
    expect(repair.findings).toEqual([]);
    expect(repair.scores).toEqual(passingScores);
    expect(repair.deckFindings).toEqual([{
      code: "LAYOUT_REPETITION",
      message: "The two slides repeat the same composition and need deck-level variation.",
      slideIds: ["S10", "S11"],
    }]);
  });
});
