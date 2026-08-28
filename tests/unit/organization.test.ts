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
});
