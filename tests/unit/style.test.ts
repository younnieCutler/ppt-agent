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
      defaultLayout: { nativeLayout: "1", canvasColor: "FFFFFF", contentRegion: { x: 0.72, y: 0.48, w: 11.85, h: 6.14 }, reservedRegions: [] },
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

  it("hard-fails when contract.aspectRatio does not match the organization pack's declared aspectRatio", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-style-org-ratio-mismatch-"));
    fs.writeFileSync(path.join(root, "template.pptx"), "placeholder");
    fs.writeFileSync(path.join(root, "brand.yaml"), [
      "name: Ratio Org",
      "palette:",
      '  background: "FFFFFF"',
      '  surface: "FFFFFF"',
      '  text: "111111"',
      '  primary: "123456"',
      '  accent: "654321"',
      '  muted: "666666"',
      '  border: "DDDDDD"',
    ].join("\n"));
    fs.writeFileSync(path.join(root, "template-map.json"), JSON.stringify({
      version: 1,
      chromeOwnership: { background: "template", logo: "template", footer: "template", pageNumber: "template" },
      defaultLayout: { nativeLayout: "1", canvasColor: "FFFFFF", contentRegion: { x: 0.72, y: 0.48, w: 11.85, h: 6.14 }, reservedRegions: [] },
      layouts: {},
      requiredElements: [],
    }));
    const contract = contractSchema.parse({ ...fixture, aspectRatio: "4:3", organization: { kind: "directory", path: root } });
    expect(() => resolvePresentationStyle(contract, { projectDir: process.cwd() })).toThrow(/ORGANIZATION_TEMPLATE_ASPECT_RATIO_MISMATCH/);
  });

  it("resolves a 4:3 organization pack whose declared aspectRatio matches the contract", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-style-org-43-"));
    fs.writeFileSync(path.join(root, "template.pptx"), "placeholder");
    fs.writeFileSync(path.join(root, "brand.yaml"), [
      "name: 4:3 Org",
      "palette:",
      '  background: "FFFFFF"',
      '  surface: "FFFFFF"',
      '  text: "111111"',
      '  primary: "123456"',
      '  accent: "654321"',
      '  muted: "666666"',
      '  border: "DDDDDD"',
    ].join("\n"));
    fs.writeFileSync(path.join(root, "template-map.json"), JSON.stringify({
      version: 1,
      aspectRatio: "4:3",
      chromeOwnership: { background: "template", logo: "template", footer: "template", pageNumber: "template" },
      defaultLayout: { nativeLayout: "1", canvasColor: "FFFFFF", contentRegion: { x: 0.5, y: 0.5, w: 9, h: 6.3 }, reservedRegions: [] },
      layouts: {},
      requiredElements: [],
    }));
    const contract = contractSchema.parse({ ...fixture, aspectRatio: "4:3", organization: { kind: "directory", path: root } });
    const style = resolvePresentationStyle(contract, { projectDir: process.cwd() });
    expect(style.organization?.map.aspectRatio).toBe("4:3");
  });

  it("lets an organization brand declare its own chart data palette instead of borrowing the archetype's", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-style-org-data-"));
    fs.writeFileSync(path.join(root, "template.pptx"), "placeholder");
    fs.writeFileSync(path.join(root, "brand.yaml"), [
      "name: Data Org",
      "palette:",
      '  background: "FFFFFF"',
      '  surface: "FFFFFF"',
      '  text: "111111"',
      '  primary: "CC0000"',
      '  accent: "000000"',
      '  muted: "666666"',
      '  border: "DDDDDD"',
      "data:",
      '  - "CC0000"',
      '  - "000000"',
      '  - "990000"',
      '  - "333333"',
      '  - "666666"',
      '  - "AA3333"',
    ].join("\n"));
    fs.writeFileSync(path.join(root, "template-map.json"), JSON.stringify({
      version: 1,
      chromeOwnership: { background: "template", logo: "template", footer: "template", pageNumber: "template" },
      defaultLayout: { nativeLayout: "1", canvasColor: "FFFFFF", contentRegion: { x: 0.72, y: 0.48, w: 11.85, h: 6.14 }, reservedRegions: [] },
      layouts: {},
      requiredElements: [],
    }));
    const contract = contractSchema.parse({ ...fixture, presentationStyle: "analytical", organization: { kind: "directory", path: root } });
    const style = resolvePresentationStyle(contract, { projectDir: process.cwd() });
    expect(style.data).toEqual(["CC0000", "000000", "990000", "333333", "666666", "AA3333"]);
  });

  it("falls back to archetype data colors 3-6 when an organization brand declares no data palette", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-style-org-nodata-"));
    fs.writeFileSync(path.join(root, "template.pptx"), "placeholder");
    fs.writeFileSync(path.join(root, "brand.yaml"), [
      "name: No Data Org",
      "palette:",
      '  background: "FFFFFF"',
      '  surface: "FFFFFF"',
      '  text: "111111"',
      '  primary: "CC0000"',
      '  accent: "000000"',
      '  muted: "666666"',
      '  border: "DDDDDD"',
    ].join("\n"));
    fs.writeFileSync(path.join(root, "template-map.json"), JSON.stringify({
      version: 1,
      chromeOwnership: { background: "template", logo: "template", footer: "template", pageNumber: "template" },
      defaultLayout: { nativeLayout: "1", canvasColor: "FFFFFF", contentRegion: { x: 0.72, y: 0.48, w: 11.85, h: 6.14 }, reservedRegions: [] },
      layouts: {},
      requiredElements: [],
    }));
    const contract = contractSchema.parse({ ...fixture, presentationStyle: "analytical", organization: { kind: "directory", path: root } });
    const style = resolvePresentationStyle(contract, { projectDir: process.cwd() });
    const analyticalTheme = resolvePresentationStyle(contractSchema.parse({ ...fixture, presentationStyle: "analytical" }), { projectDir: process.cwd() });
    expect(style.data.slice(0, 2)).toEqual(["CC0000", "000000"]);
    expect(style.data.slice(2)).toEqual(analyticalTheme.data.slice(2));
  });

  it("checks the locked muted color itself for contrast, not the derived secondary text token", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-style-muted-contrast-"));
    fs.writeFileSync(path.join(root, "template.pptx"), "placeholder");
    fs.writeFileSync(path.join(root, "brand.yaml"), [
      "name: Muted Org",
      "palette:",
      '  background: "FFFFFF"',
      '  surface: "FFFFFF"',
      '  text: "111111"',
      '  primary: "123456"',
      '  accent: "654321"',
      '  muted: "F2F2F2"', // near-white on white background: fails 4.5:1 against background
      '  border: "DDDDDD"',
    ].join("\n"));
    fs.writeFileSync(path.join(root, "template-map.json"), JSON.stringify({
      version: 1,
      chromeOwnership: { background: "template", logo: "template", footer: "template", pageNumber: "template" },
      defaultLayout: { nativeLayout: "1", canvasColor: "FFFFFF", contentRegion: { x: 0.72, y: 0.48, w: 11.85, h: 6.14 }, reservedRegions: [] },
      layouts: {},
      requiredElements: [],
    }));
    const contract = contractSchema.parse({ ...fixture, organization: { kind: "directory", path: root } });
    expect(() => resolvePresentationStyle(contract, { projectDir: process.cwd() })).toThrow(/BRAND_CONTRAST_VIOLATION/i);
  });

  it("keeps a V2 organization brand's own semantic tokens instead of re-deriving them from archetype/legacy blends", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-style-org-v2-"));
    fs.writeFileSync(path.join(root, "template.pptx"), "placeholder");
    fs.writeFileSync(path.join(root, "brand.yaml"), [
      "name: V2 Org",
      "palette:",
      '  background: "FFFFFF"',
      '  surface: "F5F5F5"',
      '  surfaceAlt: "E8E8E8"',
      '  text: "111111"',
      '  textSecondary: "444444"',
      '  muted: "666666"',
      '  inverseText: "FFFFFF"',
      '  primary: "CC0000"',
      '  accent: "000000"',
      '  accentSecondary: "222222"',
      '  border: "DDDDDD"',
      '  divider: "EEEEEE"',
      '  gridline: "F0F0F0"',
      '  mutedFill: "FAFAFA"',
      '  highlightedRegion: "FFE0E0"',
      '  positive: "008000"',
      '  warning: "B8860B"',
      '  negative: "B22222"',
      '  neutral: "808080"',
    ].join("\n"));
    fs.writeFileSync(path.join(root, "template-map.json"), JSON.stringify({
      version: 1,
      chromeOwnership: { background: "template", logo: "template", footer: "template", pageNumber: "template" },
      defaultLayout: { nativeLayout: "1", canvasColor: "FFFFFF", contentRegion: { x: 0.72, y: 0.48, w: 11.85, h: 6.14 }, reservedRegions: [] },
      layouts: {},
      requiredElements: [],
    }));
    const contract = contractSchema.parse({ ...fixture, presentationStyle: "analytical", organization: { kind: "directory", path: root } });
    const style = resolvePresentationStyle(contract, { projectDir: process.cwd() });
    expect(style.palette.surfaceAlt).toBe("E8E8E8");
    expect(style.palette.textSecondary).toBe("444444");
    expect(style.palette.divider).toBe("EEEEEE");
    expect(style.palette.gridline).toBe("F0F0F0");
    expect(style.palette.mutedFill).toBe("FAFAFA");
    expect(style.palette.highlightedRegion).toBe("FFE0E0");
    expect(style.palette.inverseText).toBe("FFFFFF");
    expect(style.palette.accentSecondary).toBe("222222");
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
      defaultLayout: { nativeLayout: "1", canvasColor: "FFFFFF", contentRegion: { x: 0.72, y: 0.48, w: 11.85, h: 6.14 }, reservedRegions: [] },
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
      defaultLayout: { nativeLayout: "1", canvasColor: "777777", contentRegion: { x: 0.72, y: 0.48, w: 11.85, h: 6.14 }, reservedRegions: [] },
      layouts: {},
      requiredElements: [],
    }));
    const contract = contractSchema.parse({ ...fixture, organization: { kind: "directory", path: root } });
    expect(() => resolvePresentationStyle(contract, { projectDir: process.cwd() })).toThrow(/BRAND_CONTRAST_VIOLATION/i);
  });
});
