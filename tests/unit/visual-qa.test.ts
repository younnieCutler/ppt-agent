import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deckSchema } from "../../src/schema";
import { visualQa } from "../../src/visual-qa";

const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/deck.json"), "utf8"));
const deck = deckSchema.parse(fixture);

describe("visualQa", () => {
  it("passes when findings are empty", () => {
    const report = visualQa(deck, []);
    expect(report.status).toBe("pass");
  });

  it("accepts a well-formed finding referencing an existing closed code and slide", () => {
    const report = visualQa(deck, [{ slideId: "S02", code: "WEAK_VISUAL_HIERARCHY", message: "Three groups compete." }]);
    expect(report.status).toBe("review");
    expect(report.findings.some((finding) => finding.code === "WEAK_VISUAL_HIERARCHY" && finding.severity === "risk")).toBe(true);
  });

  it("fails hard on an invented finding code (LLM cannot invent codes)", () => {
    const report = visualQa(deck, [{ slideId: "S02", code: "MADE_UP_CODE", message: "not real" }]);
    expect(report.status).toBe("fail");
    expect(report.findings.some((finding) => finding.code === "VISUAL_FINDING_INVALID")).toBe(true);
  });

  it("fails hard when a finding references a slideId absent from the deck", () => {
    const report = visualQa(deck, [{ slideId: "S99", code: "WEAK_VISUAL_HIERARCHY", message: "unknown slide" }]);
    expect(report.status).toBe("fail");
    expect(report.findings.some((finding) => finding.code === "VISUAL_FINDING_INVALID")).toBe(true);
  });

  it("derives hard severity for a hard-tier code with no severity field required from the caller", () => {
    const report = visualQa(deck, [{ slideId: "S01", code: "SEMANTIC_VISUAL_MISMATCH", message: "unreadable" }]);
    expect(report.status).toBe("fail");
    expect(report.findings.find((finding) => finding.code === "SEMANTIC_VISUAL_MISMATCH")?.severity).toBe("hard");
  });

  it("rejects a finding that tries to supply its own severity (LLM cannot downgrade a hard code; schema is strict)", () => {
    const report = visualQa(deck, [{ slideId: "S01", severity: "warning", code: "SEMANTIC_VISUAL_MISMATCH", message: "x" }]);
    expect(report.status).toBe("fail");
    expect(report.findings.some((finding) => finding.code === "VISUAL_FINDING_INVALID")).toBe(true);
  });

  it("maps Level 3 PowerPoint findings into the closed visual code set with a derived hard severity", () => {
    const level3 = { findings: [{ severity: "hard", code: "TEXT_OVERFLOW", slideId: "S01", message: "overflow" }] };
    const report = visualQa(deck, [], level3);
    expect(report.status).toBe("fail");
    expect(report.findings.find((finding) => finding.code === "TEXT_VISUALLY_OVERFLOWING")?.severity).toBe("hard");
  });

  it("drops unmapped Level 3 finding codes instead of leaking them through", () => {
    const level3 = { findings: [{ severity: "hard", code: "SOME_OTHER_LEVEL3_CODE", message: "n/a" }] };
    const report = visualQa(deck, [], level3);
    expect(report.status).toBe("pass");
  });
});

describe("visualQa: template drift codes", () => {
  it("accepts TEMPLATE_STYLE_DRIFT/TEMPLATE_HIERARCHY_DRIFT/TEMPLATE_COMPOSITION_DRIFT as risk, not hard", () => {
    const report = visualQa(deck, [
      { slideId: "S01", code: "TEMPLATE_STYLE_DRIFT", message: "cover treatment drifted from the source template" },
      { slideId: "S02", code: "TEMPLATE_HIERARCHY_DRIFT", message: "type hierarchy drifted" },
      { slideId: "S02", code: "TEMPLATE_COMPOSITION_DRIFT", message: "composition rhythm drifted" },
    ]);
    expect(report.status).toBe("review");
    for (const code of ["TEMPLATE_STYLE_DRIFT", "TEMPLATE_HIERARCHY_DRIFT", "TEMPLATE_COMPOSITION_DRIFT"]) {
      expect(report.findings.find((finding) => finding.code === code)?.severity).toBe("risk");
    }
  });
});
