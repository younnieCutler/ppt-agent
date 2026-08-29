import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { renderDeck } from "../../src/renderer";
import { applyPatternSkeleton } from "../../src/template";
import { extractTemplateElements, compileTemplateGrammar } from "../../src/template-analysis";
import { compileTemplatePatterns, type TemplatePattern } from "../../src/template-patterns";
import { buildPatternFixture, FIXTURE_STRINGS } from "../fixtures/pattern-template";

const repoRoot = path.resolve(__dirname, "../..");
const deckFixture = JSON.parse(fs.readFileSync(path.join(repoRoot, "tests/fixtures/deck.json"), "utf8"));

function deckSlide(overrides: Record<string, unknown> & { layout: string; id: string; headline: string }): unknown {
  return {
    role: "body",
    composition: overrides.layout === "title" ? "cover" : "hero_evidence",
    sourceRefs: [{ sourceId: "prompt", excerptId: "R001" }],
    storyBeat: "opening",
    claims: [{ text: overrides.headline, kind: "interpretation", status: "verified" }],
    ...overrides,
  };
}

// DeckSpec requires >= 3 slides and slideCount === slides.length; a filler third slide keeps every
// test deck valid without adding a fourth pattern to reason about.
function filler(id: string): unknown {
  return deckSlide({ id, layout: "statement", headline: `Filler headline ${id}`, content: { body: "Filler body.", proofs: [] } });
}

function deckWithSlides(slides: unknown[]): Record<string, unknown> {
  const allSlides = slides.length >= 3 ? slides : [...slides, ...Array.from({ length: 3 - slides.length }, (_, i) => filler(`S9${i}`))];
  return { ...deckFixture, contract: { ...deckFixture.contract, slideCount: allSlides.length }, slides: allSlides };
}

async function zipText(pptxPath: string): Promise<string> {
  const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
  const parts = await Promise.all(Object.keys(zip.files).filter((name) => name.endsWith(".xml")).map((name) => zip.file(name)!.async("string")));
  return parts.join("\n");
}

describe("applyPatternSkeleton: skeleton clone + slot injection", () => {
  it(
    "clones the real source slides, replaces slot content, preserves structural shapes, and leaks no example text",
    async () => {
      const templatePath = await buildPatternFixture();
      const elements = await extractTemplateElements(templatePath);
      const grammar = compileTemplateGrammar(elements);
      const patternsArtifact = compileTemplatePatterns(elements, grammar);
      const coverPattern = patternsArtifact.patterns[0]; // S01, dark cover
      const bodyPattern = patternsArtifact.patterns[1]; // S02, editorial body

      const deck = deckWithSlides([
        deckSlide({ id: "S01", layout: "title", headline: "GENERATED HEADLINE ONE", content: { subtitle: "Generated subtitle" } }),
        deckSlide({ id: "S02", layout: "statement", headline: "GENERATED HEADLINE TWO", content: { body: "Generated grounded statement body.", proofs: [] } }),
      ]);

      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-pattern-skeleton-"));
      try {
        const scratchPath = path.join(workDir, "scratch.pptx");
        await renderDeck(deck, scratchPath, repoRoot);

        const outputPath = path.join(workDir, "final.pptx");
        const resolvedPatterns = new Map<string, TemplatePattern>([
          ["S01", coverPattern],
          ["S02", bodyPattern],
        ]);
        const manifest = await applyPatternSkeleton(templatePath, scratchPath, outputPath, deck.slides as never, resolvedPatterns);

        expect(manifest[0]).toEqual({ slideId: "S01", mode: `pattern:${coverPattern.id}` });
        expect(manifest[1]).toEqual({ slideId: "S02", mode: `pattern:${bodyPattern.id}` });
        expect(fs.existsSync(outputPath)).toBe(true);

        const xml = await zipText(outputPath);
        // Injected content is present...
        expect(xml).toContain("GENERATED HEADLINE ONE");
        expect(xml).toContain("GENERATED HEADLINE TWO");
        expect(xml).toContain("Generated grounded statement body.");
        // ...and every one of the template's own example strings is gone.
        for (const text of Object.values(FIXTURE_STRINGS)) expect(xml).not.toContain(text);

        // The output package is still a valid, openable PPTX with the right slide count.
        const outputZip = await JSZip.loadAsync(fs.readFileSync(outputPath));
        const slideParts = Object.keys(outputZip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
        expect(slideParts).toHaveLength(3);
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
        fs.rmSync(path.dirname(templatePath), { recursive: true, force: true });
      }
    },
    60000,
  );

  it("falls through to the generic scratch slide when a slide has no resolved pattern", async () => {
    const templatePath = await buildPatternFixture();
    const elements = await extractTemplateElements(templatePath);
    const grammar = compileTemplateGrammar(elements);
    const patternsArtifact = compileTemplatePatterns(elements, grammar);

    const deck = deckWithSlides([deckSlide({ id: "S01", layout: "title", headline: "NO PATTERN HEADLINE", content: { subtitle: "x" } })]);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-pattern-fallback-"));
    try {
      const scratchPath = path.join(workDir, "scratch.pptx");
      await renderDeck(deck, scratchPath, repoRoot);
      const outputPath = path.join(workDir, "final.pptx");
      const manifest = await applyPatternSkeleton(templatePath, scratchPath, outputPath, deck.slides as never, new Map());
      expect(manifest[0]).toEqual({ slideId: "S01", mode: "renderer" });
      const xml = await zipText(outputPath);
      expect(xml).toContain("NO PATTERN HEADLINE");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(path.dirname(templatePath), { recursive: true, force: true });
    }
    void patternsArtifact;
  }, 60000);

  it("throws rather than silently rendering when a required slot has no matching content", async () => {
    const templatePath = await buildPatternFixture();
    const elements = await extractTemplateElements(templatePath);
    const grammar = compileTemplateGrammar(elements);
    const patternsArtifact = compileTemplatePatterns(elements, grammar);
    const coverPattern = patternsArtifact.patterns[0];

    // A "chart" layout slide has no `headline`-bindable field path collision — but headline is a
    // base field every SlideSpec carries, so force the failure a different real way: a required
    // slot whose binding never resolves for this slide's actual layout.
    const requiredNonHeadlineSlot: TemplatePattern = {
      ...coverPattern,
      skeleton: { ...coverPattern.skeleton, replaceableSlots: [{ id: "e1", role: "subtitle", binding: "subhead", shapeId: "Cover Subtitle", bounds: { x: 0, y: 0, w: 1, h: 1 }, required: true }] },
    };
    const deck = deckWithSlides([deckSlide({ id: "S01", layout: "statement", headline: "H", content: { body: "b", proofs: [] } })]);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-pattern-required-"));
    try {
      const scratchPath = path.join(workDir, "scratch.pptx");
      await renderDeck(deck, scratchPath, repoRoot);
      const outputPath = path.join(workDir, "final.pptx");
      await expect(applyPatternSkeleton(templatePath, scratchPath, outputPath, deck.slides as never, new Map([["S01", requiredNonHeadlineSlot]]))).rejects.toThrow(/required slot/);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(path.dirname(templatePath), { recursive: true, force: true });
    }
  }, 60000);
});

describe("ooxmlQa: template-native exemptions for pattern-rendered slides", () => {
  async function compiledPatterns() {
    const templatePath = await buildPatternFixture();
    const elements = await extractTemplateElements(templatePath);
    const grammar = compileTemplateGrammar(elements);
    const artifact = compileTemplatePatterns(elements, grammar);
    return { templatePath, coverPattern: artifact.patterns[0], bodyPattern: artifact.patterns[1] };
  }

  it(
    "REQUIRED_NATIVE_OBJECT_MISSING fires normally, but is exempted for a slide recorded as pattern-rendered",
    async () => {
      const { templatePath, coverPattern, bodyPattern } = await compiledPatterns();
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-ooxml-exempt-"));
      try {
        // A `process`/`sequence` slide needs a native connector when generically rendered; the
        // synthetic body pattern draws none (a divider line, not a connector), the same shape as
        // the real GAO E2E's S06 finding this exemption exists for.
        const deck = deckWithSlides([
          deckSlide({ id: "S01", layout: "title", headline: "Cover", content: { subtitle: "x" } }),
          { ...deckSlide({ id: "S02", layout: "process", headline: "Process headline" }), composition: "sequence", content: { steps: [{ id: "a", label: "Step A" }, { id: "b", label: "Step B" }] } },
        ]);
        const scratchPath = path.join(workDir, "scratch.pptx");
        await renderDeck(deck, scratchPath, repoRoot);
        const outputPath = path.join(workDir, "final.pptx");
        const resolvedPatterns = new Map<string, TemplatePattern>([["S01", coverPattern], ["S02", bodyPattern]]);
        await applyPatternSkeleton(templatePath, scratchPath, outputPath, deck.slides as never, resolvedPatterns);

        const { ooxmlQa } = await import("../../src/qa");
        const { deckSchema } = await import("../../src/schema");
        const parsedDeck = deckSchema.parse(deck);

        const withoutExemption = await ooxmlQa(outputPath, parsedDeck);
        expect(withoutExemption.some((finding) => finding.code === "REQUIRED_NATIVE_OBJECT_MISSING" && finding.slideId === "S02")).toBe(true);

        const withExemption = await ooxmlQa(outputPath, parsedDeck, undefined, undefined, new Set(["S02"]));
        expect(withExemption.some((finding) => finding.code === "REQUIRED_NATIVE_OBJECT_MISSING" && finding.slideId === "S02")).toBe(false);
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
        fs.rmSync(path.dirname(templatePath), { recursive: true, force: true });
      }
    },
    30000,
  );

  it(
    "a font declared only by the template's own grammar is allowed, not reported as FONT_SUBSTITUTION",
    async () => {
      const { templatePath, coverPattern } = await compiledPatterns();
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-ooxml-font-"));
      try {
        const deck = deckWithSlides([deckSlide({ id: "S01", layout: "title", headline: "Cover", content: { subtitle: "x" } })]);
        const scratchPath = path.join(workDir, "scratch.pptx");
        await renderDeck(deck, scratchPath, repoRoot);
        const outputPath = path.join(workDir, "final.pptx");
        await applyPatternSkeleton(templatePath, scratchPath, outputPath, deck.slides as never, new Map([["S01", coverPattern]]));

        const { ooxmlQa } = await import("../../src/qa");
        const { deckSchema } = await import("../../src/schema");
        const { readPptxOoxml } = await import("../../src/ooxml");
        const parsedDeck = deckSchema.parse({ ...deck, contract: { ...deck.contract, fonts: { heading: "Arial", body: "Arial" } } });

        const facts = await readPptxOoxml(outputPath);
        const clonedSlideTypeface = facts.slides[0].typefaces.find((typeface) => typeface !== "Arial");
        expect(clonedSlideTypeface).toBe("Georgia"); // the cover title's own declared font, preserved by the clone

        const withoutTemplateFonts = await ooxmlQa(outputPath, parsedDeck);
        expect(withoutTemplateFonts.some((f) => f.code === "FONT_SUBSTITUTION" && f.slideId === "S01")).toBe(true);

        const styleWithGrammar = { schemaVersion: 2, templateGrammar: { typography: { families: [clonedSlideTypeface] } } } as never;
        const withTemplateFontsAllowed = await ooxmlQa(outputPath, parsedDeck, undefined, styleWithGrammar);
        expect(withTemplateFontsAllowed.some((f) => f.code === "FONT_SUBSTITUTION" && f.slideId === "S01")).toBe(false);
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
        fs.rmSync(path.dirname(templatePath), { recursive: true, force: true });
      }
    },
    30000,
  );

  it(
    "EAST_ASIAN_FONT_MISSING fires normally, but is exempted for a slide recorded as pattern-rendered",
    async () => {
      const { templatePath, coverPattern } = await compiledPatterns();
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-ooxml-ea-"));
      try {
        // Real templates (GAO's included) often declare CJK text with only a run-level <a:latin>
        // override, relying on the theme's <a:ea> for East Asian glyph rendering — authentic,
        // correctly-rendering authoring that a pattern clone preserves verbatim.
        const deck = deckWithSlides([deckSlide({ id: "S01", layout: "title", headline: "日本語のタイトル", content: { subtitle: "x" } })]);
        const scratchPath = path.join(workDir, "scratch.pptx");
        await renderDeck(deck, scratchPath, repoRoot);
        const outputPath = path.join(workDir, "final.pptx");
        await applyPatternSkeleton(templatePath, scratchPath, outputPath, deck.slides as never, new Map([["S01", coverPattern]]));

        const { ooxmlQa } = await import("../../src/qa");
        const { deckSchema } = await import("../../src/schema");
        const parsedDeck = deckSchema.parse(deck);

        // pptxgenjs always mirrors fontFace into an explicit run-level <a:ea>, so the synthetic
        // fixture can't reproduce the gap by itself. Strip it the way a real template author
        // (GAO's own slides do exactly this) can legitimately leave it unset, relying on the
        // theme's <a:ea> instead.
        const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
        const slidePart = Object.keys(zip.files).find((name) => /ppt\/slides\/slide\d+\.xml$/.test(name))!;
        const originalXml = await zip.file(slidePart)!.async("string");
        zip.file(slidePart, originalXml.replace(/<a:ea[^/]*\/>/g, ""));
        fs.writeFileSync(outputPath, await zip.generateAsync({ type: "nodebuffer" }));

        const withoutExemption = await ooxmlQa(outputPath, parsedDeck);
        expect(withoutExemption.some((finding) => finding.code === "EAST_ASIAN_FONT_MISSING" && finding.slideId === "S01")).toBe(true);

        const withExemption = await ooxmlQa(outputPath, parsedDeck, undefined, undefined, new Set(["S01"]));
        expect(withExemption.some((finding) => finding.code === "EAST_ASIAN_FONT_MISSING" && finding.slideId === "S01")).toBe(false);
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
        fs.rmSync(path.dirname(templatePath), { recursive: true, force: true });
      }
    },
    30000,
  );
});
