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

describe("raw template source", () => {
  it("accepts contract.template: {kind:'pptx', path} with no sidecar pack", () => {
    const parsed = contractSchema.parse({ ...base, template: { kind: "pptx", path: "/tmp/some-template.pptx" } });
    expect(parsed.template).toEqual({ kind: "pptx", path: "/tmp/some-template.pptx" });
  });

  it("rejects the removed Organization Pack contract path", () => {
    expect(() => contractSchema.parse({ ...base, organization: { kind: "directory", path: "organizations/acme" } })).toThrow(/unrecognized key/i);
  });

  it("rejects a removed brand-file sidecar", () => {
    expect(() => contractSchema.parse({ ...base, brand: { kind: "file", path: "brand.yaml" } })).toThrow(/invalid discriminator|invalid literal|unrecognized key/i);
  });
});

describe("resolveTemplateSourceSpec", () => {
  it("returns the raw PPTX source", () => {
    expect(resolveTemplateSourceSpec({ template: { kind: "pptx", path: "t.pptx" } })).toEqual({ kind: "pptx", path: "t.pptx" });
  });

  it("returns undefined when no template is named", () => {
    expect(resolveTemplateSourceSpec({})).toBeUndefined();
  });
});
