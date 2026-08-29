import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contractSchema } from "../../src/schema";
import { resolvePresentationStyle } from "../../src/style";
import { elementsDigest, roleOverridesDigest, TEMPLATE_ANALYZER_VERSION, TEMPLATE_GRAMMAR_COMPILER_VERSION, type TemplateElementsArtifact } from "../../src/template-analysis";

const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/contract.json"), "utf8"));

type PackOptions = { template?: string; overrides?: Record<string, string>; analyzedOverrides?: Record<string, string>; pairGrammarWith?: TemplateElementsArtifact; compilerVersion?: string };

/** Writes a v2 pack the way `template-analyze` would, so staleness is the only thing under test. */
function writePack(options: PackOptions = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-grammar-style-"));
  const template = Buffer.from(options.template ?? "template");
  const templateDigest = crypto.createHash("sha256").update(template).digest("hex");
  const overrides = options.overrides ?? {};
  const analyzedOverrides = options.analyzedOverrides ?? overrides;
  fs.writeFileSync(path.join(root, "template.pptx"), template);
  fs.writeFileSync(path.join(root, "brand.yaml"), 'name: Org\npalette:\n  background: "FFFFFF"\n  surface: "FFFFFF"\n  text: "111111"\n  primary: "123456"\n  accent: "654321"\n  muted: "666666"\n  border: "DDDDDD"\n');
  fs.writeFileSync(path.join(root, "template-map.json"), JSON.stringify({ version: 2, chromeOwnership: { background: "template", logo: "template", footer: "template", pageNumber: "template" }, defaultLayout: { nativeLayout: "1", canvasColor: "FFFFFF", contentRegion: { x: 0.72, y: 0.48, w: 11.85, h: 6.14 }, reservedRegions: [] }, layouts: {}, requiredElements: [], elementRoleOverrides: overrides }));
  const elements = {
    version: 1,
    source: { sha256: templateDigest, slideSize: { w: 13.333, h: 7.5 } },
    analysisInputs: { templateDigest, roleOverridesDigest: roleOverridesDigest(analyzedOverrides as Record<string, never>), analyzerVersion: TEMPLATE_ANALYZER_VERSION },
    slides: [],
    styles: {},
  } as unknown as TemplateElementsArtifact;
  fs.writeFileSync(path.join(root, "template-elements.json"), JSON.stringify(elements));
  fs.writeFileSync(path.join(root, "template-grammar.json"), JSON.stringify({
    sourceDigest: templateDigest,
    compilerVersion: options.compilerVersion ?? TEMPLATE_GRAMMAR_COMPILER_VERSION,
    elementsDigest: elementsDigest(options.pairGrammarWith ?? elements),
    typography: { titleBodyRatio: 3 },
    geometry: { contentFrame: { x: 1, y: 1, w: 10, h: 5 }, spacingScale: 1.2 },
    surface: { usage: "none" },
    compositionPatterns: [],
  }));
  return root;
}

function resolve(root: string) {
  return resolvePresentationStyle(contractSchema.parse({ ...fixture, organization: { kind: "directory", path: root } }), { projectDir: process.cwd() });
}

describe("Organization Pack v2 grammar resolution", () => {
  it("loads a fresh grammar and applies it to the resolved style", () => {
    const style = resolve(writePack());
    expect(style.templateGrammar?.sourceDigest).toBeTruthy();
    expect(style.grammar.spacingScale).toBeGreaterThan(1);
    expect(style.grammar.surfaceUsage).toBe("none");
  });

  it("rejects artifacts generated from a different template.pptx", () => {
    const root = writePack();
    fs.writeFileSync(path.join(root, "template.pptx"), "template edited");
    expect(() => resolve(root)).toThrow(/stale for template\.pptx/);
  });

  it("rejects artifacts generated from different elementRoleOverrides", () => {
    // template.pptx is byte-identical here; only the analysis input the map carries has moved.
    const root = writePack({ overrides: { "S01-Title-1": "title" }, analyzedOverrides: {} });
    expect(() => resolve(root)).toThrow(/elementRoleOverrides/);
  });

  it("accepts artifacts regenerated for the current overrides", () => {
    const overrides = { "S01-Title-1": "title" };
    expect(resolve(writePack({ overrides, analyzedOverrides: overrides })).templateGrammar).toBeTruthy();
  });

  it("rejects a grammar compiled from a different elements artifact", () => {
    const otherElements = { version: 1, source: { sha256: "b".repeat(64), slideSize: { w: 13.333, h: 7.5 } }, analysisInputs: { templateDigest: "b".repeat(64), roleOverridesDigest: roleOverridesDigest({}), analyzerVersion: TEMPLATE_ANALYZER_VERSION }, slides: [], styles: {} } as unknown as TemplateElementsArtifact;
    expect(() => resolve(writePack({ pairGrammarWith: otherElements }))).toThrow(/not compiled from this template-elements\.json/);
  });

  it("rejects a grammar compiled by a different grammar compiler version", () => {
    // Only the compiler moved: elements are current, the template is untouched.
    expect(() => resolve(writePack({ compilerVersion: "0" }))).toThrow(/grammar compiler version/);
  });

  it("rejects an elements artifact whose recorded template digest disagrees with template.pptx", () => {
    const root = writePack();
    const elementsPath = path.join(root, "template-elements.json");
    const elements = JSON.parse(fs.readFileSync(elementsPath, "utf8"));
    elements.analysisInputs.templateDigest = "c".repeat(64);
    fs.writeFileSync(elementsPath, JSON.stringify(elements));
    expect(() => resolve(root)).toThrow(/records a different template digest/);
  });

  it("rejects artifacts produced by a different analyzer version", () => {
    const root = writePack();
    const elementsPath = path.join(root, "template-elements.json");
    const elements = JSON.parse(fs.readFileSync(elementsPath, "utf8"));
    elements.analysisInputs.analyzerVersion = "0";
    fs.writeFileSync(elementsPath, JSON.stringify(elements));
    expect(() => resolve(root)).toThrow(/analyzer version/);
  });
});
