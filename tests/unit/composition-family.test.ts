import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { structuralQa } from "../../src/qa";
import { compositionFamily } from "../../src/schema";

// The Japan Career Agent regression deck: 4 architecture_zones, 3 sequence, 1 diagnosis_matrix,
// 1 two_column, 3 hero_evidence, 1 stage_gate across 13 body slides. That already clears both
// composition-name-level thresholds (LOW_COMPOSITION_VARIETY needs 5, this deck has 6; no single
// composition exceeds 35%) and, as this test documents, the family-count thresholds too — proving
// why UNIFORM_CELL_RHYTHM had to be built as a separate, geometry-level check.
const deck = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/japan-career-agent/deck.json"), "utf8"));
const contentModel = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/japan-career-agent/content-model.json"), "utf8"));

describe("composition-family repetition", () => {
  it("documents that family-count thresholds alone do not catch the JCA regression", () => {
    const report = structuralQa(deck, process.cwd(), contentModel);
    expect(report.findings.some((finding) => finding.code === "LOW_COMPOSITION_FAMILY_VARIETY")).toBe(true);
    // ...but dominance alone still doesn't fire: no single family exceeds 40% on its own.
    expect(report.findings.some((finding) => finding.code === "DOMINANT_COMPOSITION_FAMILY")).toBe(false);
  });

  it("flags UNIFORM_CELL_RHYTHM: most body slides lay equal cells on the same axis regardless of family", () => {
    const report = structuralQa(deck, process.cwd(), contentModel);
    const finding = report.findings.find((candidate) => candidate.code === "UNIFORM_CELL_RHYTHM");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("risk");
  });

  it("stops firing once an architecture slide's edges converge on one hub zone", () => {
    // Simulates the renderer's own asymmetry rule (central_hub / a hub-converging
    // architecture_zones slide): the widened zone breaks equal-cell rhythm as a side effect of
    // proving the slide's focal subject, not as a separate repetition fix.
    const architectureSlides = deck.slides.filter((slide: { layout: string }) => slide.layout === "architecture");
    const patched = {
      ...deck,
      slides: deck.slides.map((slide: { id: string; layout: string; content: { zones: Array<{ id: string; nodes: string[] }>; edges: unknown[] } }) => {
        if (slide.layout !== "architecture") return slide;
        const zones = slide.content.zones;
        const edges = zones.slice(1).flatMap((zone) => zone.nodes.map((node) => ({ from: `${zone.id}:${node}`, to: `${zones[0].id}:${zones[0].nodes[0]}` })));
        return { ...slide, content: { ...slide.content, edges } };
      }),
    };
    expect(architectureSlides.length).toBeGreaterThan(0);
    const report = structuralQa(patched, process.cwd(), contentModel);
    expect(report.findings.some((finding) => finding.code === "UNIFORM_CELL_RHYTHM")).toBe(false);
  });

  it("maps every composition used in the fixture to a known family", () => {
    for (const slide of deck.slides as Array<{ composition: string }>) {
      expect(compositionFamily[slide.composition]).toBeDefined();
    }
  });
});
