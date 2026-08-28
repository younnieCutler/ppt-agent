import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import type { DeckSpec } from "./schema";

export type RenderedSlide = { slideId: string; index: number; path: string };

export type VisualRenderBackend = {
  name: "powerpoint" | "libreoffice";
  available(): boolean;
  render(pptxPath: string, outputDir: string, slideIds: string[]): Promise<RenderedSlide[]>;
};

function findOnPath(binary: string): boolean {
  try {
    execSync(process.platform === "win32" ? `where ${binary}` : `command -v ${binary}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const powerpointBackend: VisualRenderBackend = {
  name: "powerpoint",
  available: () => process.platform === "win32",
  async render(pptxPath, outputDir, slideIds) {
    const scriptPath = path.resolve(__dirname, "..", "scripts", "render-slides.ps1");
    const resolvedOutputDir = path.resolve(outputDir);
    fs.mkdirSync(path.join(resolvedOutputDir, "visual"), { recursive: true });
    let raw = "";
    try {
      raw = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          "-PptxPath",
          path.resolve(pptxPath),
          "-OutputDir",
          resolvedOutputDir,
          "-SlideId",
          slideIds.join(","),
        ],
        { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      );
    } catch (error) {
      raw = error instanceof Error ? error.message : String(error);
    }
    const indexPath = path.join(resolvedOutputDir, "visual", "index.json");
    if (!fs.existsSync(indexPath)) throw new Error(`Visual render did not produce ${indexPath}. Output: ${raw}`);
    return JSON.parse(fs.readFileSync(indexPath, "utf8")) as RenderedSlide[];
  },
};

// ponytail: detection only. `soffice --convert-to png` exports just the first slide of a
// multi-slide deck; a real implementation needs a PDF intermediate plus pdftoppm/poppler.
// Honest stub beats a fake one — implement the PDF path (or install PowerPoint) when needed.
const libreOfficeBackend: VisualRenderBackend = {
  name: "libreoffice",
  available: () => findOnPath("soffice"),
  async render() {
    throw new Error(
      "LibreOffice backend is detected but not implemented: `soffice --convert-to png` exports " +
        "only the first slide. A PDF intermediate + pdftoppm/poppler step is required. Install " +
        "PowerPoint, or implement the PDF path.",
    );
  },
};

export function selectBackend(): VisualRenderBackend {
  if (powerpointBackend.available()) return powerpointBackend;
  if (libreOfficeBackend.available()) return libreOfficeBackend;
  throw new Error("No visual render backend available: install Microsoft PowerPoint (Windows) or LibreOffice.");
}

export async function renderVisual(deck: DeckSpec, pptxPath: string, runDir: string, slideIds?: string[]): Promise<RenderedSlide[]> {
  const ids = slideIds ?? deck.slides.map((slide) => slide.id);
  const backend = selectBackend();
  return backend.render(pptxPath, runDir, ids);
}

// Deliberately thin: only the fields a judgment-layer rubric needs to weigh visual findings
// against designDirection (PRD §26, ~2-5k text token budget) — never the raw source.
export function buildDeckContext(deck: DeckSpec, renderedIds: Iterable<string>) {
  const ids = new Set(renderedIds);
  return {
    designDirection: deck.contract.designDirection,
    purpose: deck.contract.purpose,
    referenceIds: deck.contract.referenceIds,
    slides: deck.slides
      .filter((slide) => ids.has(slide.id))
      .map((slide) => ({ id: slide.id, layout: slide.layout, composition: slide.composition, storyBeat: slide.storyBeat, headline: slide.headline })),
  };
}
