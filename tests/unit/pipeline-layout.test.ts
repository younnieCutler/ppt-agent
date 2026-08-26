import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderDeck } from "../../src/renderer";

const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/deck.json"), "utf8"));
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-pipeline-"));

afterAll(() => fs.rmSync(runDir, { recursive: true, force: true }));

describe("pipeline layout", () => {
  it("packs a 10-node linear pipeline inside the canvas by topology rank", async () => {
    const nodes = Array.from({ length: 10 }, (_, index) => ({ id: `n${index + 1}`, label: `N${index + 1}`, laneId: "raw" }));
    const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }));
    const pipeline = { ...fixture.slides[2], content: { lanes: [{ id: "raw", label: "Raw" }], nodes, edges } };
    const deck = { ...fixture, slides: [fixture.slides[0], fixture.slides[1], pipeline] };
    const result = await renderDeck(deck, path.join(runDir, "ten-nodes.pptx"), process.cwd());
    const nodeRects = result.slideRects.S03.filter((rect) => rect.id.startsWith("S03-node-n"));
    expect(nodeRects).toHaveLength(10);
    expect(Math.max(...nodeRects.map((rect) => rect.x + rect.w))).toBeLessThanOrEqual(12.571);
  });
});
