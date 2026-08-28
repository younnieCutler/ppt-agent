import { describe, expect, it } from "vitest";
import { selectBackend, type VisualRenderBackend } from "../../src/visual";

function backend(name: VisualRenderBackend["name"], available: boolean, detail: string): VisualRenderBackend {
  return {
    name,
    probe: () => ({ available, detail }),
    async render() {
      return [];
    },
  };
}

describe("visual backend selection", () => {
  it("prefers a working PowerPoint COM backend", () => {
    expect(selectBackend([
      backend("powerpoint", true, "PowerPoint COM activated successfully."),
      backend("libreoffice", true, "LibreOffice and Poppler are available."),
    ]).name).toBe("powerpoint");
  });

  it("falls through from unavailable PowerPoint to a complete LibreOffice backend", () => {
    expect(selectBackend([
      backend("powerpoint", false, "PowerPoint COM probe failed."),
      backend("libreoffice", true, "LibreOffice and Poppler are available."),
    ]).name).toBe("libreoffice");
  });

  it("selects LibreOffice on non-Windows-style capability sets", () => {
    expect(selectBackend([
      backend("powerpoint", false, "PowerPoint COM is only available on Windows."),
      backend("libreoffice", true, "LibreOffice and Poppler are available."),
    ]).name).toBe("libreoffice");
  });

  it("reports each failed capability when no backend can render", () => {
    expect(() => selectBackend([
      backend("powerpoint", false, "PowerPoint COM probe failed."),
      backend("libreoffice", false, "Missing required LibreOffice renderer tool(s): pdftoppm."),
    ])).toThrow(/PowerPoint COM probe failed.*pdftoppm/i);
  });
});
