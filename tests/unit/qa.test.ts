import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { structuralQa } from "../../src/qa";

const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/deck.json"), "utf8"));

describe("structural QA", () => {
  it("passes the semantic fixture", () => {
    const report = structuralQa(fixture);
    expect(report.status).toBe("pass");
    expect(report.findings.filter((finding) => finding.severity === "hard")).toHaveLength(0);
  });

  it("flags repeated layout slop", () => {
    const repeatedSlides = [1, 2, 3].map((index) => ({ ...fixture.slides[1], id: `S0${index + 1}` }));
    const repeated = {
      ...fixture,
      contract: { ...fixture.contract, slideCount: 4 },
      slides: [fixture.slides[0], ...repeatedSlides],
    };
    const report = structuralQa(repeated);
    expect(report.findings.some((finding) => finding.code === "REPEATED_LAYOUT_RUN")).toBe(true);
  });

  it("flags a dominant composition even when layouts alternate", () => {
    const comparison = fixture.slides[1];
    const pipeline = fixture.slides[2];
    const bodySlides = Array.from({ length: 8 }, (_, index) => {
      const source = index % 2 === 0 ? comparison : pipeline;
      return { ...source, id: `S${String(index + 2).padStart(2, "0")}` };
    });
    const report = structuralQa({
      ...fixture,
      contract: { ...fixture.contract, slideCount: 9 },
      slides: [fixture.slides[0], ...bodySlides],
    });
    expect(report.findings.some((finding) => finding.code === "DOMINANT_COMPOSITION")).toBe(true);
  });

  it("flags a number that is absent from source excerpts", () => {
    const numeric = {
      ...fixture,
      slides: [{ ...fixture.slides[0], headline: "A 97% improvement", claims: [{ text: "A 97% improvement", kind: "fact", status: "verified" }] }, fixture.slides[1], fixture.slides[2]],
    };
    const report = structuralQa(numeric);
    expect(report.findings.some((finding) => finding.code === "NUMERIC_GROUNDING")).toBe(true);
  });

  it("does not accept a numeric substring as evidence", () => {
    const numeric = {
      ...fixture,
      slides: [{ ...fixture.slides[0], headline: "A 12% improvement", claims: [{ text: "A 12% improvement", kind: "fact", status: "verified" }], sourceRefs: [{ sourceId: "prompt", locator: "prompt", excerpt: "A comparison and data flow deck 120%" }] }, fixture.slides[1], fixture.slides[2]],
    };
    const report = structuralQa(numeric);
    expect(report.findings.some((finding) => finding.code === "NUMERIC_GROUNDING")).toBe(true);
  });

  it("requires every source reference to match the normalized content model when one is supplied", () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-content-model-"));
    const modelPath = path.join(runDir, "content-model.json");
    fs.writeFileSync(modelPath, JSON.stringify({ version: 1, sources: [{ sourceId: "prompt", excerpts: [{ locator: "prompt", text: "different excerpt" }] }] }));
    const report = structuralQa(fixture, process.cwd(), modelPath);
    expect(report.status).toBe("fail");
    expect(report.findings.some((finding) => finding.code === "SOURCE_EXCERPT_NOT_IN_CONTENT_MODEL")).toBe(true);
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it("allows a derived number only when its formula inputs are grounded", () => {
    const calculatedHeadline = "Costs fell by 30%";
    const calculated = {
      ...fixture,
      contract: {
        ...fixture.contract,
        sources: [{ kind: "prompt", id: "prompt", text: "Monthly cost fell from 1000 to 700." }],
      },
      slides: [
        {
          ...fixture.slides[0],
          headline: calculatedHeadline,
          claims: [{ text: calculatedHeadline, kind: "calculation", status: "verified", formula: "(1000 - 700) / 1000 = 30%" }],
          sourceRefs: [{ sourceId: "prompt", locator: "prompt", excerpt: "Monthly cost fell from 1000 to 700." }],
        },
        fixture.slides[1],
        fixture.slides[2],
      ],
    };
    const report = structuralQa(calculated);
    expect(report.findings.some((finding) => finding.code === "NUMERIC_GROUNDING")).toBe(false);
    expect(report.findings.some((finding) => finding.code === "CALCULATION_INPUT_GROUNDING")).toBe(false);
  });

  it("requires review when a claim is marked as needing confirmation", () => {
    const uncertain = {
      ...fixture,
      slides: [
        {
          ...fixture.slides[0],
          claims: [{ text: fixture.slides[0].headline, kind: "interpretation", status: "needs_confirmation" }],
        },
        fixture.slides[1],
        fixture.slides[2],
      ],
    };
    const report = structuralQa(uncertain);
    expect(report.status).toBe("review");
    expect(report.findings.some((finding) => finding.code === "CLAIM_NEEDS_CONFIRMATION")).toBe(true);
  });

  it("requires review for a sparse proposal deck", () => {
    const sparseSlides = Array.from({ length: 8 }, (_, index) => index % 2 === 0
      ? {
          ...fixture.slides[1],
          id: `S${String(index + 2).padStart(2, "0")}`,
          composition: "two_column",
          content: { left: { label: "A", items: ["A"] }, right: { label: "B", items: ["B"] } },
        }
      : {
          ...fixture.slides[2],
          id: `S${String(index + 2).padStart(2, "0")}`,
          composition: "pipeline_lanes",
          content: { lanes: [], nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }] },
        });
    const report = structuralQa({
      ...fixture,
      contract: { ...fixture.contract, purpose: "proposal", slideCount: 9 },
      slides: [fixture.slides[0], ...sparseSlides],
    });
    expect(report.status).toBe("review");
    expect(report.findings.some((finding) => finding.code === "LOW_INFORMATION_DENSITY")).toBe(true);
  });

  it("requires review when a slide breaks the approved storyline order", () => {
    const drifted = {
      ...fixture,
      contract: { ...fixture.contract, storyline: ["opening", "problem", "design"] },
      slides: [fixture.slides[0], fixture.slides[2], fixture.slides[1]],
    };
    const report = structuralQa(drifted);
    expect(report.status).toBe("review");
    expect(report.findings.some((finding) => finding.code === "NARRATIVE_ORDER_DRIFT")).toBe(true);
  });
});
