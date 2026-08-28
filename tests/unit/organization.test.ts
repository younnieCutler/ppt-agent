import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bindingForLayout, loadOrganizationPack } from "../../src/organization";

function createPack(map: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-org-"));
  fs.writeFileSync(path.join(root, "template.pptx"), "placeholder");
  fs.writeFileSync(path.join(root, "brand.yaml"), [
    "name: Test Org",
    "palette:",
    '  background: "FFFFFF"',
    '  surface: "FFFFFF"',
    '  text: "111111"',
    '  primary: "123456"',
    '  accent: "654321"',
    '  muted: "666666"',
    '  border: "DDDDDD"',
    "footer:",
    "  showPageNumber: true",
    "  text: Test",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "template-map.json"), JSON.stringify(map));
  return root;
}

const validMap = {
  version: 1,
  chromeOwnership: { background: "template", logo: "template", footer: "template", pageNumber: "template" },
  defaultLayout: { nativeLayout: "1", canvasColor: "FFFFFF", contentRegion: { x: 0.72, y: 0.48, w: 11.85, h: 6.14 }, reservedRegions: [] },
  layouts: {},
  requiredElements: [],
};

describe("organization template contract", () => {
  it("loads the required pack files and resolves semantic layouts to the default binding", () => {
    const root = createPack(validMap);
    const pack = loadOrganizationPack(root);
    expect(pack.id).toBe(path.basename(root));
    expect(pack.brand.name).toBe("Test Org");
    expect(bindingForLayout(pack.map, "chart").nativeLayout).toBe("1");
  });

  it("rejects content regions that escape the supported 16:9 canvas", () => {
    const root = createPack({
      ...validMap,
      defaultLayout: { ...validMap.defaultLayout, contentRegion: { x: 1, y: 1, w: 13, h: 7 } },
    });
    expect(() => loadOrganizationPack(root)).toThrow(/16:9 canvas/i);
  });

  it("validates contentRegion against the narrower 10in-wide 4:3 canvas when declared, not the 16:9 default", () => {
    // This region fits a 13.333in-wide 16:9 canvas (x+w=10.5 &lt; 13.333) but overflows a 10in-wide
    // 4:3 canvas — proves aspectRatio actually changes the bounds check, not just accepted syntax.
    const root = createPack({
      ...validMap,
      aspectRatio: "4:3",
      defaultLayout: { ...validMap.defaultLayout, contentRegion: { x: 5, y: 1, w: 5.5, h: 2 } },
    });
    expect(() => loadOrganizationPack(root)).toThrow(/4:3 canvas/i);
  });

  it("accepts a 4:3 pack whose contentRegion fits the narrower canvas", () => {
    const root = createPack({
      ...validMap,
      aspectRatio: "4:3",
      defaultLayout: { ...validMap.defaultLayout, contentRegion: { x: 0.5, y: 0.5, w: 9, h: 6.3 } },
    });
    const pack = loadOrganizationPack(root);
    expect(pack.map.aspectRatio).toBe("4:3");
  });
});
