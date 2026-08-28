import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { verifyRenderProvenance } from "../../src/visual";
import { deckSchema } from "../../src/schema";

// Regression: the Japan Career Agent deliverable PDF was produced five minutes *after* Visual QA
// judged the montage, by a different converter with different font substitution than the render
// that was actually judged. Visual QA must always evaluate the artifacts it produced, not
// whatever a later, unrelated re-render happens to be — these tests cover that guarantee.
const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/deck.json"), "utf8"));
const deck = deckSchema.parse(fixture);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-provenance-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function sha256(input: Buffer | string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function makeRun(name: string): { runDir: string; pptxPath: string } {
  const runDir = path.join(root, name);
  fs.mkdirSync(path.join(runDir, "visual"), { recursive: true });
  const pptxPath = path.join(runDir, "draft.pptx");
  fs.writeFileSync(pptxPath, "pretend-pptx-bytes");
  return { runDir, pptxPath };
}

function writeProvenance(runDir: string, overrides: Partial<{ pptxSha256: string; specSha256: string }> = {}, pptxPath?: string): void {
  fs.writeFileSync(
    path.join(runDir, "visual", "render-provenance.json"),
    JSON.stringify({
      pptxSha256: overrides.pptxSha256 ?? (pptxPath ? sha256(fs.readFileSync(pptxPath)) : sha256("unused")),
      specSha256: overrides.specSha256 ?? sha256(JSON.stringify(deck)),
      renderedAt: new Date().toISOString(),
      slideIds: deck.slides.map((slide) => slide.id),
    }),
  );
}

describe("visual render provenance (stale-render guard)", () => {
  it("passes when the current pptx and deck match what `visual` last rendered", () => {
    const { runDir, pptxPath } = makeRun("match");
    writeProvenance(runDir, {}, pptxPath);
    expect(verifyRenderProvenance(runDir, pptxPath, deck)).toEqual([]);
  });

  it("fails hard when the pptx was re-rendered after the judged provenance was recorded", () => {
    const { runDir, pptxPath } = makeRun("stale-pptx");
    writeProvenance(runDir, { pptxSha256: sha256("a completely different pptx") });
    const findings = verifyRenderProvenance(runDir, pptxPath, deck);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "hard", code: "VISUAL_QA_STALE_RENDER" });
  });

  it("fails hard when the DeckSpec changed since the judged render", () => {
    const { runDir, pptxPath } = makeRun("stale-spec");
    writeProvenance(runDir, { specSha256: sha256(JSON.stringify({ ...deck, title: "a different deck" })) }, pptxPath);
    const findings = verifyRenderProvenance(runDir, pptxPath, deck);
    expect(findings.some((finding) => finding.code === "VISUAL_QA_STALE_RENDER" && finding.severity === "hard")).toBe(true);
  });

  it("degrades to a non-blocking risk when no provenance file exists (runs made before this existed)", () => {
    const { runDir, pptxPath } = makeRun("no-provenance");
    const findings = verifyRenderProvenance(runDir, pptxPath, deck);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "risk", code: "VISUAL_RENDER_PROVENANCE_UNKNOWN" });
  });
});
