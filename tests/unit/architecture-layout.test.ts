import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderDeck } from "../../src/renderer";

const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/deck.json"), "utf8"));
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-architecture-"));

afterAll(() => fs.rmSync(runDir, { recursive: true, force: true }));

describe("architecture layout", () => {
  it("renders a label for every edge", async () => {
    const architecture = {
      ...fixture.slides[2], layout: "architecture", composition: "architecture_zones",
      executionLock: { layoutId: "architecture_zones", typeScale: "body_one_column", primaryVisual: "architecture", requiredNativeObjects: ["text", "shapes", "connectors"] },
      content: { zones: [{ id: "left", label: "Left zone", nodes: ["A"] }, { id: "right", label: "Right zone", nodes: ["B"] }], edges: [{ from: "left:A", to: "right:B", label: "forward" }, { from: "right:B", to: "left:A", label: "backward" }] },
    };
    const deck = { ...fixture, slides: [fixture.slides[0], fixture.slides[1], architecture] };
    const result = await renderDeck(deck, path.join(runDir, "architecture.pptx"), process.cwd());
    const rects = result.slideRects.S03;
    expect(rects.filter((rect) => rect.id.startsWith("S03-edge-label-"))).toHaveLength(2);
    expect(rects.filter((rect) => rect.id.startsWith("S03-edge-") && !rect.id.includes("label"))).toHaveLength(2);
  });
});
