import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contractSchema, presentationArchetypes } from "../../src/schema";
import { resolvePresentationStyle, styleContext } from "../../src/style";

const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/contract.json"), "utf8"));

describe("P3 presentation style resolution", () => {
  it("defaults Auto to corporate for existing technical contracts", () => {
    const style = resolvePresentationStyle(contractSchema.parse(fixture), { projectDir: process.cwd() });
    expect(style.themeId).toBe("corporate");
    expect(style.data).toHaveLength(6);
    expect(style.palette.gridline).not.toBe(style.data[0]);
  });

  it("uses an embedded V1 theme only as the backward-compatible Auto fallback", () => {
    const contract = contractSchema.parse(fixture);
    const legacyTheme = {
      name: "legacy",
      palette: { background: "FFFFFF", surface: "FFFFFF", text: "111111", primary: "123456", accent: "654321", muted: "666666", border: "DDDDDD" },
      fonts: { heading: "Arial", body: "Arial", locked: false },
      footer: { showPageNumber: true, text: "" },
    };
    const migrated = resolvePresentationStyle(contract, { projectDir: process.cwd(), legacyTheme });
    expect(migrated.palette.primary).toBe(legacyTheme.palette.primary);
    const explicit = resolvePresentationStyle(contractSchema.parse({ ...fixture, presentationStyle: "stage" }), { projectDir: process.cwd(), legacyTheme });
    expect(explicit.palette.primary).toBe("91C84A");
  });

  it("loads each production archetype without deriving colors from structural tokens", () => {
    for (const themeId of presentationArchetypes) {
      const style = resolvePresentationStyle(contractSchema.parse({ ...fixture, presentationStyle: themeId }), { projectDir: process.cwd() });
      expect(style.themeId).toBe(themeId);
      expect(style.data).toHaveLength(6);
      expect(style.data).not.toContain(style.palette.border);
      expect(style.data).not.toContain(style.palette.gridline);
    }
  });

  it("gives each archetype a distinct grammar signature once palette is removed", () => {
    const signatures = presentationArchetypes.map((themeId) =>
      JSON.stringify(resolvePresentationStyle(contractSchema.parse({ ...fixture, presentationStyle: themeId }), { projectDir: process.cwd() }).grammar));
    expect(new Set(signatures).size).toBe(presentationArchetypes.length);
  });

  it("keeps style-context.json inside the P3 authoring budget for every archetype", () => {
    for (const themeId of presentationArchetypes) {
      const style = resolvePresentationStyle(contractSchema.parse({ ...fixture, presentationStyle: themeId }), { projectDir: process.cwd() });
      const context = JSON.stringify(styleContext(style));
      expect(context.length).toBeLessThan(4000);
      expect(Math.ceil(context.length / 4)).toBeLessThan(1000);
    }
  });

  it("maps new presentation purposes deterministically in Auto mode", () => {
    expect(resolvePresentationStyle(contractSchema.parse({ ...fixture, purpose: "research" }), { projectDir: process.cwd() }).themeId).toBe("analytical");
    expect(resolvePresentationStyle(contractSchema.parse({ ...fixture, purpose: "vision" }), { projectDir: process.cwd() }).themeId).toBe("editorial");
    expect(resolvePresentationStyle(contractSchema.parse({ ...fixture, purpose: "product" }), { projectDir: process.cwd() }).themeId).toBe("product");
    expect(resolvePresentationStyle(contractSchema.parse({ ...fixture, purpose: "conference" }), { projectDir: process.cwd() }).themeId).toBe("stage");
  });

  it("requires real P3 grammar metadata for reference-first", () => {
    const contract = contractSchema.parse({ ...fixture, presentationStyle: "reference-first", referenceIds: ["style-1"] });
    expect(() => resolvePresentationStyle(contract, { projectDir: process.cwd(), referenceSelection: [{ id: "style-1" }] })).toThrow(/REFERENCE_GRAMMAR_NOT_FOUND/);
  });

  it("applies primary reference grammar without exposing palette tokens to the model context", () => {
    const contract = contractSchema.parse({ ...fixture, presentationStyle: "reference-first", referenceIds: ["style-1"] });
    const style = resolvePresentationStyle(contract, {
      projectDir: process.cwd(),
      referenceSelection: [{ id: "style-1", style: { density: "sparse", visualWeight: "heavy" }, layout: { whitespace: "generous", headline: "assertion" }, traits: ["direct-labels"] }],
    });
    expect(style.reference?.id).toBe("style-1");
    expect(style.grammar.chartTreatment).toBe("data-first");
    const context = JSON.stringify(styleContext(style));
    expect(context.length).toBeLessThan(4000);
    expect(context).not.toContain(style.palette.primary);
  });

  it("gives an organization pack identity precedence while retaining archetype grammar", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-style-org-"));
    fs.writeFileSync(path.join(root, "template.pptx"), "placeholder");
    fs.writeFileSync(path.join(root, "brand.yaml"), [
      "name: Locked Org",
      "palette:",
      '  background: "FFFFFF"',
      '  surface: "FFFFFF"',
      '  text: "111111"',
      '  primary: "123456"',
      '  accent: "654321"',
      '  muted: "666666"',
      '  border: "DDDDDD"',
      "fonts:",
      '  heading: "Arial"',
      '  body: "Arial"',
      "  locked: true",
      "footer:",
      "  showPageNumber: true",
      "  text: Org",
    ].join("\n"));
    fs.writeFileSync(path.join(root, "template-map.json"), JSON.stringify({
      version: 1,
      chromeOwnership: { background: "template", logo: "template", footer: "template", pageNumber: "template" },
      defaultLayout: { nativeLayout: "1", canvasColor: "FFFFFF", contentRegion: { x: 0.72, y: 1.42, w: 11.85, h: 5.2 }, reservedRegions: [] },
      layouts: {},
      requiredElements: [],
    }));
    const contract = contractSchema.parse({ ...fixture, presentationStyle: "analytical", organization: { kind: "directory", path: root } });
    const style = resolvePresentationStyle(contract, { projectDir: process.cwd() });
    expect(style.themeId).toBe("analytical");
    expect(style.palette.primary).toBe("123456");
    expect(style.data[0]).toBe("123456");
    expect(style.locks.palette).toContain("primary");
    expect(style.grammar.chartTreatment).toBe("data-first");
  });

  it("hard-fails a locked organization font conflict", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-style-font-"));
    fs.writeFileSync(path.join(root, "template.pptx"), "placeholder");
    fs.writeFileSync(path.join(root, "brand.yaml"), [
      "name: Font Org",
      "palette:",
      '  background: "FFFFFF"',
      '  surface: "FFFFFF"',
      '  text: "111111"',
      '  primary: "123456"',
      '  accent: "654321"',
      '  muted: "666666"',
      '  border: "DDDDDD"',
      "fonts:",
      '  heading: "Calibri"',
      '  body: "Calibri"',
      "  locked: true",
    ].join("\n"));
    fs.writeFileSync(path.join(root, "template-map.json"), JSON.stringify({
      version: 1,
      chromeOwnership: { background: "template", logo: "template", footer: "template", pageNumber: "template" },
      defaultLayout: { nativeLayout: "1", canvasColor: "FFFFFF", contentRegion: { x: 0.72, y: 1.42, w: 11.85, h: 5.2 }, reservedRegions: [] },
      layouts: {},
      requiredElements: [],
    }));
    const contract = contractSchema.parse({ ...fixture, organization: { kind: "directory", path: root } });
    expect(() => resolvePresentationStyle(contract, { projectDir: process.cwd() })).toThrow(/Locked brand fonts/i);
  });

  it("hard-fails locked identity colors that cannot meet projector-safe contrast", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-style-contrast-"));
    fs.writeFileSync(path.join(root, "template.pptx"), "placeholder");
    fs.writeFileSync(path.join(root, "brand.yaml"), [
      "name: Contrast Org",
      "palette:",
      '  background: "777777"',
      '  surface: "777777"',
      '  text: "777777"',
      '  primary: "123456"',
      '  accent: "654321"',
      '  muted: "777777"',
      '  border: "777777"',
    ].join("\n"));
    fs.writeFileSync(path.join(root, "template-map.json"), JSON.stringify({
      version: 1,
      chromeOwnership: { background: "template", logo: "template", footer: "template", pageNumber: "template" },
      defaultLayout: { nativeLayout: "1", canvasColor: "777777", contentRegion: { x: 0.72, y: 1.42, w: 11.85, h: 5.2 }, reservedRegions: [] },
      layouts: {},
      requiredElements: [],
    }));
    const contract = contractSchema.parse({ ...fixture, organization: { kind: "directory", path: root } });
    expect(() => resolvePresentationStyle(contract, { projectDir: process.cwd() })).toThrow(/BRAND_CONTRAST_VIOLATION/i);
  });
});
