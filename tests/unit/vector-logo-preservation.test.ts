import { describe, expect, it } from "vitest";
import { compileTemplateConstraintProfile } from "../../src/brand-constraints";
import { compileGenerativeSceneComponentPlan } from "../../src/generative-scene-components";
import { resolveGenerativeScene, type GenerativeSceneIntent } from "../../src/generative-scene";
import { classifyTemplateElement, elementsDigest, type TemplateElement, type TemplateElementsArtifact } from "../../src/template-analysis";
import { compileTemplateComponents } from "../../src/template-components";
import type { TemplateDesignSystemArtifact } from "../../src/template-design-system";

const canvas = { w: 13.333, h: 7.5 };
const digest = "b".repeat(64);

function element(input: Partial<TemplateElement> & Pick<TemplateElement, "id" | "name" | "slideId" | "type" | "role" | "bounds" | "ownership">): TemplateElement {
  return { confidence: 0.9, zIndex: 0, features: {}, ...input };
}

function sourceArtifact(): TemplateElementsArtifact {
  const scaleX = canvas.w / 16.666;
  return {
    version: 1,
    source: { sha256: digest, slideSize: canvas },
    coordinateSpace: {
      mode: "scaled",
      canvas,
      sourceFrame: { x: 0, y: 0, w: 16.666, h: 7.5 },
      scale: { x: scaleX, y: 1 },
    },
    analysisInputs: { templateDigest: digest, analyzerVersion: "7" },
    slides: [{
      id: "S01",
      sourceSlidePart: "ppt/slides/slide1.xml",
      nativeLayout: { index: 1, name: "Blank", masterIndex: 1 },
      elements: [
        element({
          id: "vector-logo",
          name: "Freeform 7",
          slideId: "S01",
          type: "shape",
          role: "logo",
          confidence: 0.88,
          bounds: { x: 0.55, y: 0.22, w: 0.9, h: 0.34 },
          ownership: "slide-body-owned",
          grouped: true,
          styleRef: "logo-style",
          features: { ancestorLabel: "Corporate Logo" },
        }),
        element({
          id: "title",
          name: "Title",
          slideId: "S01",
          type: "text",
          role: "title",
          confidence: 0.9,
          bounds: { x: 1.2, y: 1.1, w: 7, h: 0.6 },
          ownership: "slide-body-owned",
          styleRef: "title-style",
          features: { charCount: 14, lineCount: 1 },
        }),
      ],
    }],
    layouts: [],
    masters: [],
    styles: {
      "logo-style": { fill: "2F6FD0" },
      "title-style": { family: "Noto Sans JP", sizePt: 28, color: "14181C" },
    },
    strategy: "source_slide_pattern",
  };
}

function designSystem(source: TemplateElementsArtifact): TemplateDesignSystemArtifact {
  return {
    version: 1,
    compilerVersion: "2",
    sourceDigest: source.source.sha256,
    elementsDigest: elementsDigest(source),
    canvas,
    typography: {
      roles: {
        title: { families: ["Noto Sans JP"], sizesPt: { values: [28], min: 28, max: 28 } },
      },
      typeScale: { values: [28], min: 28, max: 28 },
    },
    colors: { text: ["14181C"], fill: ["2F6FD0"], stroke: [], background: ["FFFFFF"] },
    geometry: { contentFrame: { x: 1.2, y: 1.0, w: 10.8, h: 5.7 }, outerMargins: { x: 1.2, y: 1.0, w: 1.333, h: 0.8 }, gutters: [0.24] },
    spacing: { rhythm: [0.24] },
    dividers: { orientations: [], thicknesses: [], lengths: [], strokeWidthsPt: [], colors: [] },
    surfaces: { fills: ["FFFFFF"], borders: [], borderWidthsPt: [] },
    alignmentAnchors: { x: [1.2, 12], y: [1, 6.7] },
  };
}

describe("vector logo preservation", () => {
  it("recognizes logo semantics inherited from a PowerPoint group label", () => {
    const classified = classifyTemplateElement({
      id: "S01-Freeform-1",
      type: "shape",
      bounds: { x: 0.55, y: 0.22, w: 0.9, h: 0.34 },
      features: { ancestorLabel: "GAO Corporate Logo" },
    }, canvas);
    expect(classified).toEqual({ role: "logo", confidence: 0.88 });

    const unrelated = classifyTemplateElement({
      id: "S01-Freeform-2",
      type: "shape",
      bounds: { x: 2, y: 2, w: 1, h: 1 },
      features: { ancestorLabel: "Architecture Diagram" },
    }, canvas);
    expect(unrelated.role).not.toBe("logo");
  });

  it("keeps an explicit grouped vector logo in the scaled component catalog and immutable profile", () => {
    const source = sourceArtifact();
    const components = compileTemplateComponents(source);
    const logo = components.components.find((component) => component.elementIds.includes("vector-logo"));
    expect(logo).toMatchObject({ kind: "logo", grouped: true });

    const profile = compileTemplateConstraintProfile(source, designSystem(source));
    const lock = profile.immutableRegions.find((region) => region.sourceElementId === "vector-logo");
    expect(lock).toMatchObject({ role: "logo", reserveSpace: true });
    expect(lock?.evidence).toContain("explicit_logo_role");
  });

  it("never schedules the grouped logo for removal during Generative Scene sanitization", () => {
    const source = sourceArtifact();
    const components = compileTemplateComponents(source);
    const profile = compileTemplateConstraintProfile(source, designSystem(source));
    const intent: GenerativeSceneIntent = {
      version: 2,
      slideId: "S01",
      semanticIntent: "statement",
      headline: "New grounded headline",
      contentRegionId: "content-main",
      layout: {
        strategy: "model_authored",
        nodes: [{
          id: "headline",
          role: "headline",
          text: "New grounded headline",
          frame: { x: 0.05, y: 0.12, w: 0.62, h: 0.14 },
          emphasis: 0.9,
          styleRole: "title",
        }],
      },
      constraints: { chrome: "immutable", colors: "template_only", fonts: "template_only" },
    };
    const scene = resolveGenerativeScene(intent, profile);
    const plan = compileGenerativeSceneComponentPlan(scene, "S01", components, profile);
    const logoComponent = components.components.find((component) => component.elementIds.includes("vector-logo"))!;

    expect(plan.preservedImmutableComponentIds).toContain(logoComponent.id);
    expect(plan.operations).not.toContainEqual({ operation: "remove", componentId: logoComponent.id });
  });
});
