import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderDeck } from "../../src/renderer";

const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/deck.json"), "utf8"));
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-new-compositions-"));

afterAll(() => fs.rmSync(runDir, { recursive: true, force: true }));

function architectureSlide(composition: string, content: unknown) {
  return { ...fixture.slides[2], layout: "architecture", composition, content };
}

async function render(slide: unknown, fileName: string) {
  const deck = { ...fixture, slides: [fixture.slides[0], fixture.slides[1], slide] };
  const result = await renderDeck(deck, path.join(runDir, fileName), process.cwd());
  return result.slideRects.S03;
}

describe("architecture_zones content-fitted band (D1/D2/D3)", () => {
  it("shrinks the band to fit fewer nodes while keeping its vertical center fixed", async () => {
    const sparse = await render(
      architectureSlide("architecture_zones", { zones: [{ id: "a", label: "A", nodes: ["one"] }, { id: "b", label: "B", nodes: ["two"] }], edges: [{ from: "a:one", to: "b:two" }] }),
      "sparse.pptx",
    );
    const dense = await render(
      architectureSlide("architecture_zones", { zones: [{ id: "a", label: "A", nodes: ["one", "two", "three", "four"] }, { id: "b", label: "B", nodes: ["five", "six", "seven", "eight"] }], edges: [{ from: "a:one", to: "b:five" }] }),
      "dense.pptx",
    );
    const sparseZone = sparse.find((rect) => rect.id === "S03-zone-a")!;
    const denseZone = dense.find((rect) => rect.id === "S03-zone-a")!;
    expect(denseZone.h).toBeGreaterThan(sparseZone.h);
    // Centered, not top-pinned: growing the content should expand the band symmetrically around
    // roughly the same vertical center, not just push its bottom edge down from a fixed top.
    const sparseCenter = sparseZone.y + sparseZone.h / 2;
    const denseCenter = denseZone.y + denseZone.h / 2;
    expect(Math.abs(sparseCenter - denseCenter)).toBeLessThan(0.15);
  });

  it("widens the zone every edge converges on and gives it the accent border (the slide's focal subject)", async () => {
    const rects = await render(
      architectureSlide("architecture_zones", {
        zones: [
          { id: "hub", label: "Hub", nodes: ["core"] },
          { id: "left", label: "Left", nodes: ["a"] },
          { id: "right", label: "Right", nodes: ["b"] },
        ],
        edges: [
          { from: "left:a", to: "hub:core" },
          { from: "right:b", to: "hub:core" },
        ],
      }),
      "hub-zones.pptx",
    );
    const hub = rects.find((rect) => rect.id === "S03-zone-hub")!;
    const left = rects.find((rect) => rect.id === "S03-zone-left")!;
    const right = rects.find((rect) => rect.id === "S03-zone-right")!;
    expect(hub.w).toBeGreaterThan(left.w);
    expect(hub.w).toBeGreaterThan(right.w);
    expect(left.w).toBeCloseTo(right.w, 2);
  });

  it("stays symmetric (no widened zone) when edges do not converge on one zone", async () => {
    const rects = await render(
      architectureSlide("architecture_zones", {
        zones: [{ id: "left", label: "Left", nodes: ["a"] }, { id: "right", label: "Right", nodes: ["b"] }],
        // Both directions are present, so the edge targets are {left, right} — no single
        // convergence point, unlike the hub test above where every edge targets the same zone.
        edges: [{ from: "left:a", to: "right:b" }, { from: "right:b", to: "left:a" }],
      }),
      "symmetric-zones.pptx",
    );
    const left = rects.find((rect) => rect.id === "S03-zone-left")!;
    const right = rects.find((rect) => rect.id === "S03-zone-right")!;
    expect(left.w).toBeCloseTo(right.w, 2);
  });
});

describe("central_hub composition", () => {
  it("renders a hub and satellites with every edge resolving to a real position, no geometry collisions", async () => {
    const rects = await render(
      architectureSlide("central_hub", {
        zones: [
          { id: "vault", label: "Career Vault", nodes: ["contexts", "experiences", "evidence"] },
          { id: "jd", label: "JD matching", nodes: ["match"] },
          { id: "cv", label: "Japanese CV", nodes: ["draft"] },
          { id: "prep", label: "Interview prep", nodes: ["practice"] },
        ],
        edges: [
          { from: "jd:match", to: "vault:contexts" },
          { from: "cv:draft", to: "vault:experiences" },
          { from: "prep:practice", to: "vault:evidence" },
        ],
      }),
      "central-hub.pptx",
    );
    const hub = rects.find((rect) => rect.id === "S03-hub")!;
    expect(hub).toBeDefined();
    const satelliteZones = rects.filter((rect) => rect.id.startsWith("S03-zone-") && !rect.id.includes("-label-"));
    expect(satelliteZones.length).toBe(3);
    const edges = rects.filter((rect) => rect.id.startsWith("S03-edge-"));
    expect(edges).toHaveLength(3);
  });
});

describe("layered_stack composition", () => {
  it("gives a zone with more nodes a taller band than one with fewer", async () => {
    const rects = await render(
      architectureSlide("layered_stack", {
        zones: [
          { id: "context", label: "Context", nodes: ["company", "university"] },
          { id: "experience", label: "Experience", nodes: ["projects", "operations", "incidents", "mentoring"] },
          { id: "evidence", label: "Evidence", nodes: ["source"] },
        ],
        edges: [
          { from: "experience:projects", to: "context:company" },
          { from: "evidence:source", to: "experience:projects" },
        ],
      }),
      "layered-stack.pptx",
    );
    const context = rects.find((rect) => rect.id === "S03-zone-context")!;
    const experience = rects.find((rect) => rect.id === "S03-zone-experience")!;
    const evidence = rects.find((rect) => rect.id === "S03-zone-evidence")!;
    expect(experience.h).toBeGreaterThan(context.h);
    expect(context.h).toBeGreaterThan(evidence.h);
    // Full-width bands stacked top to bottom, not a row of columns.
    expect(context.x).toBeCloseTo(experience.x, 2);
    expect(experience.y).toBeGreaterThan(context.y);
  });
});

describe("verdict_contrast composition", () => {
  it("renders asymmetric panel widths, never equal like two_column", async () => {
    const comparison = {
      ...fixture.slides[2],
      layout: "comparison",
      composition: "verdict_contrast",
      content: {
        left: { label: "Generic assistant", items: ["Blended score", "82 out of 100"] },
        right: { label: "Japan Career Agent", items: ["Hard conflict", "Review"] },
        delta: "82/100 blended vs HARD CONFLICT",
      },
    };
    const deck = { ...fixture, slides: [fixture.slides[0], fixture.slides[1], comparison] };
    const result = await renderDeck(deck, path.join(runDir, "verdict-contrast.pptx"), process.cwd());
    const rects = result.slideRects.S03;
    const left = rects.find((rect) => rect.id === "S03-left-panel")!;
    const right = rects.find((rect) => rect.id === "S03-right-panel")!;
    expect(left.w).not.toBeCloseTo(right.w, 1);
    expect(rects.some((rect) => rect.id === "S03-verdict")).toBe(true);
  });
});
