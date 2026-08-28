import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deckSchema } from "../../src/schema";
import { structuralQa } from "../../src/qa";

const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/deck.json"), "utf8"));
const quantitativeVisuals = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/quantitative-visuals.json"), "utf8"));

describe("DeckSpec schema", () => {
  it("accepts a semantic deck with a confirmed heading/body font pair", () => {
    const deck = deckSchema.parse(fixture);
    expect(deck.contract.fonts).toEqual({ heading: "Arial", body: "Arial" });
    expect(deck.slides[2].layout).toBe("pipeline");
    expect(deck.slides[0].headlineAlignment).toBe("left");
  });

  it("rejects a slide count mismatch before rendering", () => {
    expect(() => deckSchema.parse({ ...fixture, contract: { ...fixture.contract, slideCount: 4 } })).toThrow(/slideCount/);
  });

  it("rejects a composition that is incompatible with its semantic layout", () => {
    const invalid = {
      ...fixture,
      slides: [{ ...fixture.slides[0], composition: "ranked_bars" }, fixture.slides[1], fixture.slides[2]],
    };
    expect(() => deckSchema.parse(invalid)).toThrow(/Composition/);
  });

  it("rejects arbitrary geometry fields", () => {
    const malformed = { ...fixture, slides: [{ ...fixture.slides[0], x: 1 }] };
    expect(() => deckSchema.parse(malformed)).toThrow(/coordinate|geometry|x/i);
  });

  it("requires the headline to be the primary classified claim", () => {
    const malformed = {
      ...fixture,
      slides: [{ ...fixture.slides[0], claims: [{ text: "A different message", kind: "interpretation", status: "verified" }] }, fixture.slides[1], fixture.slides[2]],
    };
    expect(() => deckSchema.parse(malformed)).toThrow(/first claim|primary message/i);
  });

  it("requires an explicit formula for calculated claims", () => {
    const malformed = {
      ...fixture,
      slides: [{ ...fixture.slides[0], claims: [{ text: fixture.slides[0].headline, kind: "calculation", status: "verified" }] }, fixture.slides[1], fixture.slides[2]],
    };
    expect(() => deckSchema.parse(malformed)).toThrow(/formula/i);
  });

  it("accepts an explicitly centered title when the approved layout requires it", () => {
    const centered = { ...fixture, slides: [{ ...fixture.slides[0], headlineAlignment: "center" }, fixture.slides[1], fixture.slides[2]] };
    expect(deckSchema.parse(centered).slides[0].headlineAlignment).toBe("center");
  });

  it("rejects an architecture edge that cannot be rendered to explicit zone:node endpoints", () => {
    const architecture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/all-layouts.json"), "utf8")).slides[5];
    const malformed = { ...fixture, slides: [fixture.slides[0], fixture.slides[1], { ...architecture, id: "S03", content: { ...architecture.content, edges: [{ from: "missing:node", to: "data:Warehouse" }] } }] };
    expect(() => deckSchema.parse(malformed)).toThrow(/Architecture edge/i);
  });

  it("rejects pipeline cycles before the renderer can create an ambiguous topology", () => {
    const malformed = { ...fixture, slides: [fixture.slides[0], fixture.slides[1], { ...fixture.slides[2], content: { ...fixture.slides[2].content, edges: [{ from: "source", to: "transform" }, { from: "transform", to: "source" }] } }] };
    expect(() => deckSchema.parse(malformed)).toThrow(/acyclic/i);
  });

  it("rejects a gauge_row metric that is not a percentage, since the gauge always scales against 0-100", () => {
    const gaugeSlide = quantitativeVisuals.slides.find((slide: { composition: string }) => slide.composition === "gauge_row");
    const malformed = {
      ...quantitativeVisuals,
      slides: quantitativeVisuals.slides.map((slide: { id: string }) => (slide.id === gaugeSlide.id
        ? { ...gaugeSlide, content: { ...gaugeSlide.content, metrics: [{ ...gaugeSlide.content.metrics[0], unit: "ms" }, ...gaugeSlide.content.metrics.slice(1)] } }
        : slide)),
    };
    expect(() => deckSchema.parse(malformed)).toThrow(/gauge_row/i);
  });

  it("rejects a sparkline_row with fewer than 2 metrics, since a single point cannot draw a connecting line", () => {
    const sparklineSlide = quantitativeVisuals.slides.find((slide: { composition: string }) => slide.composition === "sparkline_row");
    const malformed = {
      ...quantitativeVisuals,
      slides: quantitativeVisuals.slides.map((slide: { id: string }) => (slide.id === sparklineSlide.id
        ? { ...sparklineSlide, content: { ...sparklineSlide.content, metrics: sparklineSlide.content.metrics.slice(0, 1) } }
        : slide)),
    };
    expect(() => deckSchema.parse(malformed)).toThrow(/sparkline_row/i);
  });

  it("holds a deck for review when an element exceeds its wrapping budget", () => {
    const excessive = {
      ...fixture,
      slides: [{ ...fixture.slides[0], content: { ...fixture.slides[0].content, subtitle: "가".repeat(101) } }, fixture.slides[1], fixture.slides[2]],
    };
    expect(structuralQa(excessive).findings.some((finding) => finding.code === "TEXT_WRAP_RISK")).toBe(true);
  });
});
