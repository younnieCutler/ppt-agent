import { describe, expect, it } from "vitest";
import type { TemplateConstraintProfile } from "../../src/brand-constraints";
import { buildGenerativeAuthoringRequest, parseGenerativeAuthoringResponse } from "../../src/generative-authoring";
import type { GenerativeSceneIntent } from "../../src/generative-scene";
import type { SlideSpec } from "../../src/schema";
import type { TemplateComponentsArtifact, TemplateComponent } from "../../src/template-components";
import type { TemplateSemanticsProfile } from "../../src/template-semantics";

const sourceDigest = "a".repeat(64);
const elementsDigest = "b".repeat(64);

function brand(): TemplateConstraintProfile {
  return {
    version: 1,
    compilerVersion: "1",
    sourceDigest,
    elementsDigest,
    canvas: { w: 13.333, h: 7.5 },
    immutableRegions: [{
      id: "logo",
      sourceElementId: "raw-logo-id",
      sourceSlideId: "master-1",
      role: "logo",
      bounds: { x: 11.8, y: 0.25, w: 0.8, h: 0.3 },
      reserveSpace: true,
      confidence: 0.99,
      evidence: ["master_or_layout_owned", "stable_geometry"],
    }],
    contentRegions: [{ id: "content-main", bounds: { x: 0.8, y: 0.5, w: 11.8, h: 6.3 } }],
    styleVocabulary: {
      fonts: ["Noto Sans JP"],
      textColors: ["111111"],
      fillColors: ["F5F1E8", "113A5C"],
      strokeColors: ["113A5C"],
      backgroundColors: ["F5F1E8"],
      textRoles: ["title", "body", "label", "metric", "divider", "surface"],
    },
    policies: { chrome: "immutable", colors: "template_only", fonts: "template_only" },
  };
}

function component(input: Partial<TemplateComponent> & Pick<TemplateComponent, "id" | "kind" | "sourceSlideId">): TemplateComponent {
  return {
    sourceSlidePart: input.sourceSlideId === "S01" ? "ppt/slides/slide1.xml" : "ppt/slides/slide2.xml",
    elementIds: [`raw-${input.id}`],
    shapeNames: [`shape-${input.id}`],
    sourceBounds: { x: 1, y: 1, w: 9.9, h: 1 },
    semanticRoles: input.kind === "metric" ? ["metric"] : input.kind === "title_block" ? ["title"] : [],
    styleRefs: ["SECRET_STYLE_REFERENCE"],
    assetProvenance: { kind: "none", sourceSlidePart: "ppt/slides/slide1.xml", sourceElementId: `raw-${input.id}` },
    repeatability: { signal: "single", count: 1 },
    resizeFeasibility: { horizontal: "safe", vertical: "safe" },
    observedSiblings: [],
    groupPattern: "single",
    confidence: 0.95,
    ...input,
  };
}

function components(): TemplateComponentsArtifact {
  return {
    version: 1,
    compilerVersion: "2",
    sourceDigest,
    elementsDigest,
    sourceGeometryDigest: "c".repeat(64),
    canvas: { w: 13.333, h: 7.5 },
    components: [
      component({ id: "component-secret-title", kind: "title_block", sourceSlideId: "S01" }),
      component({ id: "component-secret-body", kind: "body_block", sourceSlideId: "S01" }),
      component({ id: "component-secret-card", kind: "card", sourceSlideId: "S01" }),
      component({ id: "component-secret-metric", kind: "metric", sourceSlideId: "S02" }),
      component({ id: "component-secret-label", kind: "label", sourceSlideId: "S02" }),
    ],
    repeatGroups: [{ id: "repeat-secret", sourceSlideId: "S02", kind: "metric", componentIds: ["component-secret-metric"], pattern: "horizontal_row", confidence: 0.95 }],
  };
}

function semantics(): TemplateSemanticsProfile {
  return {
    version: 1,
    compilerVersion: "1",
    sourceDigest,
    elementsDigest,
    slides: [
      { slideId: "S01", nativeLayoutIndex: 7, nativeLayoutName: "Blank", usage: "reference_only", placeholderCount: 0, contentElementCount: 24, evidence: ["example_body_geometry", "blank_or_nonstructural_layout"] },
      { slideId: "S02", nativeLayoutIndex: 2, nativeLayoutName: "Title and Content", usage: "structural_template", placeholderCount: 2, contentElementCount: 2, evidence: ["slide_body_placeholder", "layout_placeholder", "placeholder_dominant_body"] },
    ],
    policies: {
      masterLayoutGeometry: "structural",
      sourceSlideGeometry: "reference_only_by_default",
      sourceSlideStyles: "reference_library",
      compositionAuthority: "model_authored_unless_placeholder_structural",
    },
  };
}

function quantitativeSlide(): SlideSpec {
  return {
    id: "S10",
    role: "body",
    storyBeat: "evidence",
    headline: "Agent work is becoming measurable",
    headlineAlignment: "left",
    claims: [{ text: "Agent work is becoming measurable", kind: "fact", status: "verified" }],
    composition: "metric_story",
    sourceRefs: [{ sourceId: "source", excerptId: "excerpt" }],
    layout: "quantitative",
    content: {
      kind: "kpi",
      metrics: [
        { label: "Direct", value: 45, unit: "%", period: "Now" },
        { label: "Agent", value: 40, unit: "%", period: "Now" },
        { label: "Human", value: 15, unit: "%", period: "Now" },
      ],
    },
  };
}

function exactTitleSlide(): SlideSpec {
  return {
    id: "S09",
    role: "cover",
    storyBeat: "opening",
    headline: "Exact cover",
    headlineAlignment: "left",
    claims: [{ text: "Exact cover", kind: "fact", status: "verified" }],
    composition: "cover",
    sourceRefs: [{ sourceId: "source", excerptId: "excerpt" }],
    layout: "title",
    content: { subtitle: "Structural template path" },
  };
}

function validResponse(request: ReturnType<typeof buildGenerativeAuthoringRequest>) {
  const target = request.slides[0];
  const nodes = target.contentAtoms.map((content, index) => ({
    id: `node-${index + 1}`,
    role: content.roleHint,
    text: content.text,
    frame: { x: index % 2 === 0 ? 0.02 : 0.53, y: Math.floor(index / 2) * 0.12, w: 0.43, h: 0.08 },
    emphasis: content.importance === "primary" ? 0.9 : 0.5,
  }));
  const scene: GenerativeSceneIntent = {
    version: 2,
    slideId: target.id,
    semanticIntent: target.semanticIntent,
    headline: target.headline,
    contentRegionId: "content-main",
    layout: { strategy: "model_authored", nodes },
    constraints: { chrome: "immutable", colors: "template_only", fonts: "template_only" },
  };
  return {
    version: 1 as const,
    requestDigest: request.requestDigest,
    sourceDigest: request.sourceDigest,
    scenes: [{ scene, bindings: target.contentAtoms.map((content, index) => ({ nodeId: `node-${index + 1}`, contentRef: content.id })) }],
  };
}

describe("generative authoring contract", () => {
  it("builds a host-neutral grounded request while keeping source example geometry and raw component ids non-authoritative", () => {
    const request = buildGenerativeAuthoringRequest({
      slides: [exactTitleSlide(), quantitativeSlide()],
      exactSlideIds: ["S09"],
      brandProfile: brand(),
      semantics: semantics(),
      components: components(),
    });

    expect(request.slides.map((slide) => slide.id)).toEqual(["S10"]);
    expect(request.instructions).toMatchObject({ compositionAuthority: "model_authored", sourceSlideGeometry: "reference_only", preserveAllContentAtoms: true });
    expect(request.references.find((slide) => slide.slideId === "S01")).toMatchObject({ usage: "reference_only", componentKinds: { title_block: 1, body_block: 1, card: 1 } });
    expect(request.references.find((slide) => slide.slideId === "S02")).toMatchObject({ usage: "structural_template", componentKinds: { metric: 1, label: 1 }, repeatPatterns: ["horizontal_row"] });
    expect(request.brand.allowedComponentKinds).toEqual(expect.arrayContaining(["title_block", "body_block", "card", "metric", "label"]));
    expect(request.slides[0].contentAtoms.map((content) => content.id)).toEqual(expect.arrayContaining(["S10.headline", "S10.metric.1.value", "S10.metric.2.label", "S10.metric.3.period"]));

    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain("component-secret");
    expect(serialized).not.toContain("SECRET_STYLE_REFERENCE");
    expect(serialized).not.toContain("sourceBounds");
    expect(serialized).not.toContain("raw-logo-id");
  });

  it("accepts asymmetric model-authored geometry only when every text node is grounded to exact planned content", () => {
    const request = buildGenerativeAuthoringRequest({ slides: [quantitativeSlide()], brandProfile: brand(), semantics: semantics(), components: components() });
    const response = validResponse(request);
    const scenes = parseGenerativeAuthoringResponse(request, response);

    expect(scenes.get("S10")?.layout.strategy).toBe("model_authored");
    expect(scenes.get("S10")?.layout.nodes).toHaveLength(request.slides[0].contentAtoms.length);
    expect(scenes.get("S10")?.layout.nodes[1].frame.x).not.toBe(scenes.get("S10")?.layout.nodes[2].frame.x);
  });

  it("rejects stale host output, invented text, and dropped content instead of silently repairing it", () => {
    const request = buildGenerativeAuthoringRequest({ slides: [quantitativeSlide()], brandProfile: brand(), semantics: semantics(), components: components() });
    const stale = validResponse(request);
    stale.requestDigest = "f".repeat(64);
    expect(() => parseGenerativeAuthoringResponse(request, stale)).toThrow(/RESPONSE_STALE/);

    const drift = validResponse(request);
    drift.scenes[0].scene.layout.nodes[1].text = "invented by model";
    expect(() => parseGenerativeAuthoringResponse(request, drift)).toThrow(/TEXT_DRIFT/);

    const dropped = validResponse(request);
    dropped.scenes[0].bindings.pop();
    dropped.scenes[0].scene.layout.nodes.pop();
    expect(() => parseGenerativeAuthoringResponse(request, dropped)).toThrow(/CONTENT_DROPPED/);
  });

  it("fails explicitly for media/chart authoring until the Generative Scene contract exposes native primitives", () => {
    const chart = { ...quantitativeSlide(), id: "S11", layout: "chart" as const, content: { chartType: "bar" as const, dataRef: "dataset" } } as SlideSpec;
    expect(() => buildGenerativeAuthoringRequest({ slides: [chart], brandProfile: brand(), semantics: semantics(), components: components() })).toThrow(/CHART_UNSUPPORTED/);

    const evidence = {
      id: "S12", role: "body", storyBeat: "evidence", headline: "Evidence", headlineAlignment: "left", claims: [{ text: "Evidence", kind: "fact", status: "verified" }], composition: "evidence_panel", sourceRefs: [{ sourceId: "source", excerptId: "excerpt" }], layout: "evidence", content: { assetPath: "private.png", bullets: ["Proof"] },
    } as SlideSpec;
    expect(() => buildGenerativeAuthoringRequest({ slides: [evidence], brandProfile: brand(), semantics: semantics(), components: components() })).toThrow(/MEDIA_UNSUPPORTED/);
  });
});
