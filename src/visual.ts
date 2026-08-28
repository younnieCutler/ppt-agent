import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import type { DeckSpec } from "./schema";
import type { ResolvedPresentationStyle } from "./style";

export type RenderedSlide = { slideId: string; index: number; path: string };
// The PPTX is written in deck.slides order (1-based), so this is the authoritative mapping from
// a DeckSpec slide id to its actual position in the rendered file — backends must render exactly
// these positions, never assume "first N slides" for a scoped subset.
export type SlideMapEntry = { slideId: string; index: number };

export type BackendProbe = {
  available: boolean;
  detail: string;
  version?: string;
};

export type VisualRenderBackend = {
  name: "powerpoint" | "libreoffice";
  probe(): BackendProbe;
  render(pptxPath: string, outputDir: string, slideMap: SlideMapEntry[]): Promise<RenderedSlide[]>;
};

function probePowerPoint(): BackendProbe {
  if (process.platform !== "win32") return { available: false, detail: "PowerPoint COM is only available on Windows." };
  const scriptPath = path.resolve(__dirname, "..", "scripts", "render-slides.ps1");
  if (!fs.existsSync(scriptPath)) return { available: false, detail: `PowerPoint renderer script is missing: ${scriptPath}` };
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$app = $null",
    "try {",
    "  $app = New-Object -ComObject PowerPoint.Application",
    "  [string]$app.Version",
    "} finally {",
    "  if ($app) { try { $app.Quit() } catch {} ; [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) }",
    "}",
  ].join("; ");
  try {
    const version = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { available: true, detail: "PowerPoint COM activated successfully.", version };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { available: false, detail: `PowerPoint COM probe failed: ${message}` };
  }
}

const powerpointBackend: VisualRenderBackend = {
  name: "powerpoint",
  probe: probePowerPoint,
  async render(pptxPath, outputDir, slideMap) {
    assertSlideMap(slideMap);
    const scriptPath = path.resolve(__dirname, "..", "scripts", "render-slides.ps1");
    const resolvedOutputDir = path.resolve(outputDir);
    fs.mkdirSync(path.join(resolvedOutputDir, "visual"), { recursive: true });
    const slideMapArg = slideMap.map((entry) => `${entry.index},${entry.slideId}`).join(";");
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
          "-SlideMap",
          slideMapArg,
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

function probeLibreOffice(): BackendProbe {
  const probes: Array<[string, string[]]> = [["soffice", ["--headless", "--version"]], ["pdftoppm", ["-v"]]];
  const failures: string[] = [];
  let version = "";
  probes.forEach(([binary, args]) => {
    try {
      const output = execFileSync(binary, args, { encoding: "utf8", timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      if (binary === "soffice") version = output.trim().split(/\r?\n/)[0] ?? "";
    } catch (error) {
      failures.push(`${binary}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  if (failures.length > 0) return { available: false, detail: `LibreOffice capability probe failed. ${failures.join(" ")}` };
  return { available: true, detail: "LibreOffice and Poppler pdftoppm capability probes succeeded.", version };
}

function renderDirFor(outputDir: string): string {
  const directory = path.join(path.resolve(outputDir), "visual");
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function assertSlideMap(slideMap: SlideMapEntry[]): void {
  if (slideMap.length === 0) throw new Error("Visual rendering requires at least one slide.");
  slideMap.forEach((entry) => {
    if (!Number.isInteger(entry.index) || entry.index < 1 || !entry.slideId) throw new Error("SlideMap entries must contain a positive PowerPoint index and slide id.");
  });
}

const libreOfficeBackend: VisualRenderBackend = {
  name: "libreoffice",
  probe: probeLibreOffice,
  async render(pptxPath, outputDir, slideMap): Promise<RenderedSlide[]> {
    assertSlideMap(slideMap);
    const source = path.resolve(pptxPath);
    if (!fs.existsSync(source)) throw new Error(`PPTX not found: ${source}`);
    const renderDir = renderDirFor(outputDir);
    const tempDir = path.join(renderDir, `.libreoffice-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    try {
      execFileSync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", tempDir, source], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
      const pdfPath = path.join(tempDir, `${path.basename(source, path.extname(source))}.pdf`);
      if (!fs.existsSync(pdfPath)) throw new Error(`LibreOffice did not produce expected PDF: ${pdfPath}`);
      return slideMap.map((entry, outputIndex) => {
        const prefix = path.join(renderDir, `slide-${String(outputIndex + 1).padStart(3, "0")}`);
        const pngPath = `${prefix}.png`;
        execFileSync("pdftoppm", ["-f", String(entry.index), "-l", String(entry.index), "-png", "-singlefile", "-scale-to-x", "1600", "-scale-to-y", "-1", pdfPath, prefix], {
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        });
        if (!fs.existsSync(pngPath)) throw new Error(`Poppler did not render slide ${entry.index} to ${pngPath}`);
        return { slideId: entry.slideId, index: entry.index, path: pngPath };
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
};

export function selectBackend(backends: VisualRenderBackend[] = [powerpointBackend, libreOfficeBackend]): VisualRenderBackend {
  const probes = backends.map((backend) => ({ backend, probe: backend.probe() }));
  const selected = probes.find(({ probe }) => probe.available);
  if (selected) return selected.backend;
  throw new Error(`No visual render backend available. ${probes.map(({ backend, probe }) => `${backend.name}: ${probe.detail}`).join(" ")}`);
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&apos;" })[character] ?? character);
}

async function writeMontage(renderDir: string, rendered: RenderedSlide[]): Promise<void> {
  const thumbWidth = 480;
  const thumbHeight = 270;
  const labelHeight = 24;
  const columns = Math.min(3, Math.max(1, rendered.length));
  const rows = Math.ceil(rendered.length / columns);
  const composites: sharp.OverlayOptions[] = [];
  for (const [position, entry] of rendered.entries()) {
    const left = (position % columns) * thumbWidth;
    const top = Math.floor(position / columns) * (thumbHeight + labelHeight);
    composites.push({ input: await sharp(entry.path).resize(thumbWidth, thumbHeight, { fit: "cover" }).png().toBuffer(), left, top });
    const label = `<svg width="${thumbWidth}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="4" y="16" font-family="Arial" font-size="12" fill="black">${escapeXml(entry.slideId)}</text></svg>`;
    composites.push({ input: Buffer.from(label), left, top: top + thumbHeight });
  }
  await sharp({ create: { width: columns * thumbWidth, height: rows * (thumbHeight + labelHeight), channels: 3, background: "white" } })
    .composite(composites)
    .png()
    .toFile(path.join(renderDir, "montage.png"));
}

async function writeVisualArtifacts(outputDir: string, backend: VisualRenderBackend, probe: BackendProbe, rendered: RenderedSlide[]): Promise<void> {
  const renderDir = renderDirFor(outputDir);
  fs.writeFileSync(path.join(renderDir, "index.json"), JSON.stringify(rendered, null, 2));
  fs.writeFileSync(path.join(renderDir, "backend.json"), JSON.stringify({ backend: backend.name, backendVersion: probe.version, detail: probe.detail, slideCount: rendered.length }, null, 2));
  await writeMontage(renderDir, rendered);
}

export async function renderVisual(deck: DeckSpec, pptxPath: string, runDir: string, slideIds?: string[]): Promise<RenderedSlide[]> {
  const ids = slideIds ?? deck.slides.map((slide) => slide.id);
  const slideMap: SlideMapEntry[] = ids.map((slideId) => {
    const deckIndex = deck.slides.findIndex((slide) => slide.id === slideId);
    if (deckIndex < 0) throw new Error(`Slide '${slideId}' does not exist in this DeckSpec.`);
    return { slideId, index: deckIndex + 1 };
  });
  const backend = selectBackend();
  const probe = backend.probe();
  const rendered = await backend.render(pptxPath, runDir, slideMap);
  await writeVisualArtifacts(runDir, backend, probe, rendered);
  return rendered;
}

// Deliberately thin: only the fields a judgment-layer rubric needs to weigh visual findings
// against designDirection (PRD §26, ~2-5k text token budget) — never the raw source.
export function buildDeckContext(deck: DeckSpec, renderedIds: Iterable<string>, style?: ResolvedPresentationStyle) {
  const ids = new Set(renderedIds);
  return {
    designDirection: deck.contract.designDirection,
    presentationStyle: deck.contract.presentationStyle,
    resolvedStyle: style ? {
      themeId: style.themeId,
      organization: style.organization ? {
        id: style.organization.id,
        chromeOwnership: style.organization.map.chromeOwnership,
      } : undefined,
      grammar: {
        surfaceUsage: style.grammar.surfaceUsage,
        chartTreatment: style.grammar.chartTreatment,
        spacingScale: style.grammar.spacingScale,
        headlineScale: style.grammar.headlineScale,
        focalVisualScale: style.grammar.focalVisualScale,
        copyBudget: style.grammar.copyBudget,
        compositionPreferences: style.grammar.compositionPreferences.slice(0, 3),
      },
      locked: style.locks,
    } : undefined,
    purpose: deck.contract.purpose,
    referenceIds: deck.contract.referenceIds,
    slides: deck.slides
      .filter((slide) => ids.has(slide.id))
      .map((slide) => ({ id: slide.id, layout: slide.layout, composition: slide.composition, storyBeat: slide.storyBeat, headline: slide.headline })),
  };
}
