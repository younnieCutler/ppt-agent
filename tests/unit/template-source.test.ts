import { describe, expect, it } from "vitest";
import { contractSchema } from "../../src/schema";
import { resolveTemplateSourceSpec } from "../../src/template-source";

const base = {
  sources: [{ kind: "prompt" as const, id: "prompt", text: "text" }],
  purpose: "technical" as const,
  audience: "engineering leaders",
  language: "en",
  slideCount: 3,
  brand: { kind: "default" as const },
  fonts: { heading: "Arial", body: "Arial" },
  fontDelivery: "managed_device" as const,
  aspectRatio: "16:9" as const,
  storyline: ["opening", "problem", "design"],
};

describe("contract.template", () => {
  it("accepts contract.template: {kind:'pptx', path} with no organization pack at all", () => {
    const parsed = contractSchema.parse({ ...base, template: { kind: "pptx", path: "/tmp/some-template.pptx" } });
    expect(parsed.template).toEqual({ kind: "pptx", path: "/tmp/some-template.pptx" });
    expect(parsed.organization).toEqual({ kind: "none" });
  });

  it("still parses a contract using only the existing organization field (zero breakage)", () => {
    const parsed = contractSchema.parse({ ...base, organization: { kind: "directory", path: "organizations/acme" } });
    expect(parsed.template).toBeUndefined();
    expect(parsed.organization).toEqual({ kind: "directory", path: "organizations/acme" });
  });

  it("rejects template.pptx combined with brand.file (a raw pptx has no brand.yaml of its own)", () => {
    expect(() => contractSchema.parse({ ...base, brand: { kind: "file", path: "brand.yaml" }, template: { kind: "pptx", path: "t.pptx" } })).toThrow(/raw pptx template has no brand/);
  });

  it("rejects contract.template and contract.organization naming the same kind of pack at different paths", () => {
    expect(() => contractSchema.parse({
      ...base,
      organization: { kind: "directory", path: "organizations/acme" },
      template: { kind: "organization", path: "organizations/other" },
    })).toThrow(/disagree on its path/);
  });

  it("accepts contract.template and contract.organization agreeing on the same organization path", () => {
    const parsed = contractSchema.parse({
      ...base,
      organization: { kind: "directory", path: "organizations/acme" },
      template: { kind: "organization", path: "organizations/acme" },
    });
    expect(parsed.template).toEqual({ kind: "organization", path: "organizations/acme" });
  });
});

describe("resolveTemplateSourceSpec", () => {
  it("prefers contract.template when both are present", () => {
    const spec = resolveTemplateSourceSpec({ template: { kind: "pptx", path: "t.pptx" }, organization: { kind: "none" } });
    expect(spec).toEqual({ kind: "pptx", path: "t.pptx" });
  });

  it("treats organization: {kind:'directory'} as sugar for template: {kind:'organization', ...} when template is absent", () => {
    const spec = resolveTemplateSourceSpec({ organization: { kind: "directory", path: "organizations/acme" } });
    expect(spec).toEqual({ kind: "organization", path: "organizations/acme" });
  });

  it("returns undefined when neither field names a template (the plain no-organization renderer path)", () => {
    expect(resolveTemplateSourceSpec({ organization: { kind: "none" } })).toBeUndefined();
    expect(resolveTemplateSourceSpec({})).toBeUndefined();
  });
});
