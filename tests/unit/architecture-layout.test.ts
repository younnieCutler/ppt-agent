import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderDeck } from "../../src/renderer";

const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/deck.json"), "utf8"));
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-architecture-"));

afterAll(() => fs.rmSync(runDir, { recursive: true, force: true }));

describe("architecture layout", () => {
  it("renders a label for every edge and routes backward edges from the correct side", async () => {
    const architecture = {
      ...fixture.slides[2],
      layout: "architecture",
      composition: "architecture_zones",
      content: {
        zones: [
          { id: "left", label: "Left zone", nodes: ["A"] },
          { id: "right", label: "Right zone", nodes: ["B"] },
        ],
        edges: [
          { from: "left:A", to: "right:B", label: "forward" },
          { from: "right:B", to: "left:A", label: "backward" },
        ],
      },
    };
    const deck = {
      ...fixture,
      slides: [fixture.slides[0], fixture.slides[1], architecture],
    };
    const result = await renderDeck(deck, path.join(runDir, "architecture.pptx"), process.cwd());
    const rects = result.slideRects.S03;

    const labelRects = rects.filter((rect) => rect.id.startsWith("S03-edge-label-"));
    expect(labelRects).toHaveLength(2);

    const nodeA = rects.find((rect) => rect.id === "S03-node-left-0")!;
    const nodeB = rects.find((rect) => rect.id === "S03-node-right-0")!;
    const forwardEdge = rects.find((rect) => rect.id === "S03-edge-0")!;
    const backwardEdge = rects.find((rect) => rect.id === "S03-edge-1")!;

    // The forward edge (A -> B) must start at A's right edge and stay within [A.right, B.left].
    expect(forwardEdge.x).toBeCloseTo(nodeA.x + nodeA.w, 2);
    expect(forwardEdge.x + forwardEdge.w).toBeLessThanOrEqual(nodeB.x + 0.02);

    // The backward edge (B -> A) must start at B's left edge, not sweep across the whole canvas from B's right edge.
    expect(backwardEdge.x).toBeCloseTo(nodeA.x + nodeA.w, 2);
    expect(backwardEdge.x + backwardEdge.w).toBeLessThanOrEqual(nodeB.x + 0.02);
  });
});
