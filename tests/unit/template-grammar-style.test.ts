import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contractSchema } from "../../src/schema";
import { resolvePresentationStyle } from "../../src/style";

const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/contract.json"), "utf8"));

describe("Organization Pack v2 grammar resolution", () => {
  it("loads a fresh grammar and applies it to the resolved style", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-grammar-style-"));
    const template = Buffer.from("template");
    const digest = crypto.createHash("sha256").update(template).digest("hex");
    fs.writeFileSync(path.join(root, "template.pptx"), template);
    fs.writeFileSync(path.join(root, "brand.yaml"), 'name: Org\npalette:\n  background: "FFFFFF"\n  surface: "FFFFFF"\n  text: "111111"\n  primary: "123456"\n  accent: "654321"\n  muted: "666666"\n  border: "DDDDDD"\n');
    fs.writeFileSync(path.join(root, "template-map.json"), JSON.stringify({ version: 2, chromeOwnership: { background: "template", logo: "template", footer: "template", pageNumber: "template" }, defaultLayout: { nativeLayout: "1", canvasColor: "FFFFFF", contentRegion: { x: 0.72, y: 0.48, w: 11.85, h: 6.14 }, reservedRegions: [] }, layouts: {}, requiredElements: [] }));
    fs.writeFileSync(path.join(root, "template-elements.json"), JSON.stringify({ source: { sha256: digest } }));
    fs.writeFileSync(path.join(root, "template-grammar.json"), JSON.stringify({ sourceDigest: digest, typography: { titleBodyRatio: 3 }, geometry: { contentFrame: { x: 1, y: 1, w: 10, h: 5 }, spacingScale: 1.2 }, surface: { usage: "none" }, compositionPatterns: [] }));
    const style = resolvePresentationStyle(contractSchema.parse({ ...fixture, organization: { kind: "directory", path: root } }), { projectDir: process.cwd() });
    expect(style.templateGrammar?.sourceDigest).toBe(digest);
    expect(style.grammar.spacingScale).toBeGreaterThan(1);
    expect(style.grammar.surfaceUsage).toBe("none");
  });
});
