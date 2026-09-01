import { describe, expect, it } from "vitest";
import type { SlideSpec } from "../../src/schema";
import type { TemplateComponentsArtifact } from "../../src/template-components";
import type { TemplateDesignSystemArtifact } from "../../src/template-design-system";
import { diagnoseAdaptiveMode } from "../../src/adaptive-selection";

describe("Goal 8 evidence selection boundary", () => {
  it("returns explicit unsupported for media-only evidence instead of leaking a schema error", () => {
    const result = diagnoseAdaptiveMode({
      templateDigest: "a".repeat(64),
      slide: {
        id: "S02",
        layout: "evidence",
        headline: "Evidence",
        composition: "evidence_panel",
        content: { assetPath: "/tmp/evidence.png", bullets: [] },
      } as unknown as SlideSpec,
      candidates: [],
      designSystem: {} as TemplateDesignSystemArtifact,
      components: { components: [] } as unknown as TemplateComponentsArtifact,
    });

    expect(result.mode).toBe("unsupported");
    expect(result.rejectionReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "adaptive_capability", message: expect.stringMatching(/media-only evidence is not supported/i) }),
    ]));
  });
});
