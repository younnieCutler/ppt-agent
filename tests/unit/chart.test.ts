import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { structuralQa } from "../../src/qa";
import { contentModelSchema } from "../../src/schema";

const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/all-layouts.json"), "utf8"));
const contentModel = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/content-model-all-layouts.json"), "utf8"));

describe("native chart grounding", () => {
  it("passes a chart slide whose dataset values are all grounded in the cited excerpt", () => {
    const report = structuralQa(fixture, process.cwd(), contentModel);
    expect(report.status).toBe("pass");
    expect(report.findings.filter((finding) => finding.severity === "hard")).toHaveLength(0);
  });

  it("hard-fails when a chart's dataRef is absent from content-model datasets", () => {
    const chartSlide = fixture.slides.find((slide: { layout: string }) => slide.layout === "chart");
    const broken = { ...fixture, slides: fixture.slides.map((slide: { id: string }) => (slide.id === chartSlide.id ? { ...chartSlide, content: { ...chartSlide.content, dataRef: "D999" } } : slide)) };
    const report = structuralQa(broken, process.cwd(), contentModel);
    expect(report.status).toBe("fail");
    expect(report.findings.some((finding) => finding.code === "CHART_DATA_NOT_IN_CONTENT_MODEL")).toBe(true);
  });

  it("hard-fails when a dataset value is absent from its cited excerpt", () => {
    const taintedModel = {
      ...contentModel,
      datasets: contentModel.datasets.map((dataset: { id: string }) => (dataset.id === "D001"
        ? { ...dataset, series: [{ name: "fixture period", values: [12, 8, 97] }] }
        : dataset)),
    };
    const report = structuralQa(fixture, process.cwd(), taintedModel);
    expect(report.status).toBe("fail");
    expect(report.findings.some((finding) => finding.code === "CHART_DATA_GROUNDING")).toBe(true);
  });

  it("accepts six categorical series but rejects an accidental seventh palette cycle", () => {
    const base = contentModel.datasets[0];
    const six = { ...contentModel, datasets: [{ ...base, series: Array.from({ length: 6 }, (_, index) => ({ name: `series-${index}`, values: [12, 8, 4] })) }] };
    expect(contentModelSchema.parse(six).datasets?.[0].series).toHaveLength(6);
    const seven = { ...six, datasets: [{ ...six.datasets[0], series: [...six.datasets[0].series, { name: "series-6", values: [12, 8, 4] }] }] };
    expect(() => contentModelSchema.parse(seven)).toThrow(/at most 6|six/i);
  });
});
