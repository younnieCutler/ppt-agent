import { describe, expect, it } from "vitest";
import { buildGenerativeAuthoringRequest } from "../../src/generative-authoring";
import type { TemplateConstraintProfile } from "../../src/brand-constraints";
import type { SlideSpec } from "../../src/schema";
import type { TemplateComponentsArtifact } from "../../src/template-components";
import type { TemplateSemanticsProfile } from "../../src/template-semantics";

const digest = "a".repeat(64);
const elements = "b".repeat(64);

const slide: SlideSpec = {
  id: "S10", role: "body", storyBeat: "problem", headline: "Grounded statement", headlineAlignment: "left",
  claims: [{ text: "Grounded statement", kind: "fact", status: "verified" }], composition: "hero_evidence",
  sourceRefs: [{ sourceId: "source", excerptId: "excerpt" }], layout: "statement", content: { body: "Planned body", proofs: [] },
};

const brand: TemplateConstraintProfile = {
  version: 1, compilerVersion: "1", sourceDigest: digest, elementsDigest: elements, canvas: { w: 13.333, h: 7.5 }, immutableRegions: [],
  contentRegions: [{ id: "content-main", bounds: { x: 0.8, y: 0.7, w: 11.7, h: 6 } }],
  styleVocabulary: { fonts: ["Arial"], textColors: ["111111"], fillColors: [], strokeColors: [], backgroundColors: [], textRoles: ["title", "body"] },
  policies: { chrome: "immutable", colors: "template_only", fonts: "template_only" },
};

const semantics: TemplateSemanticsProfile = {
  version: 1, compilerVersion: "1", sourceDigest: digest, elementsDigest: elements, slides: [],
  policies: { masterLayoutGeometry: "structural", sourceSlideGeometry: "reference_only_by_default", sourceSlideStyles: "reference_library", compositionAuthority: "model_authored_unless_placeholder_structural" },
};

const components: TemplateComponentsArtifact = {
  version: 1, compilerVersion: "2", sourceDigest: digest, elementsDigest: elements, sourceGeometryDigest: "c".repeat(64), canvas: { w: 13.333, h: 7.5 }, components: [], repeatGroups: [],
};

describe("generative authoring provenance", () => {
  it("rejects artifacts from different raw template analyses before building a model request", () => {
    expect(() => buildGenerativeAuthoringRequest({ slides: [slide], brandProfile: brand, semantics: { ...semantics, sourceDigest: "f".repeat(64) }, components })).toThrow(/PROVENANCE_MISMATCH/);
    expect(() => buildGenerativeAuthoringRequest({ slides: [slide], brandProfile: brand, semantics, components: { ...components, elementsDigest: "e".repeat(64) } })).toThrow(/PROVENANCE_MISMATCH/);
  });
});
