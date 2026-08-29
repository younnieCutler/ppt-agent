import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import type { QaFinding } from "./qa";
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
      // Kept as the deck's one judged PDF (`visual/deck.pdf`) instead of discarded with tempDir.
      // A separate downstream conversion of the same PPTX — a different tool, a different render
      // pass, minutes later — is a second artifact nobody QA'd; whatever it renders is not what
      // Visual QA looked at. Pinning this copy as the delivered PDF removes that class of drift.
      fs.copyFileSync(pdfPath, path.join(renderDir, "deck.pdf"));
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

/** For tests that need to `it.skipIf` a rendered-image assertion on a CI runner with neither
 * PowerPoint nor LibreOffice installed — mirrors the PowerPoint-COM availability check already
 * used by tests/integration/render.test.ts, generalized to either backend. */
export function visualRenderBackendAvailable(): boolean {
  try {
    selectBackend();
    return true;
  } catch {
    return false;
  }
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

// pdffonts' column layout has no delimiter of its own — font names can contain spaces, so the
// only reliable anchor is one of these fixed type tokens, which a real font name will not
// collide with. Everything to its left on the line is the font name.
const pdfFontTypeTokens = ["CID Type 0C", "CID TrueType", "CID Type 0", "Type 1C", "TrueType", "Type1", "Type3", "Type 3"];

function parsePdfFontsOutput(raw: string): string[] {
  const names = new Set<string>();
  for (const line of raw.split(/\r?\n/).slice(2)) {
    if (!line.trim()) continue;
    const hit = pdfFontTypeTokens.map((token) => ({ token, index: line.indexOf(token) })).filter((candidate) => candidate.index >= 0).sort((a, b) => a.index - b.index)[0];
    if (!hit) continue;
    const name = line.slice(0, hit.index).trim();
    if (name) names.add(name);
  }
  return [...names];
}

// A PDF subsetting a font prefixes it with a random 6-letter tag ("ABCDEF+Helvetica Neue"), and
// style suffixes ("-Bold", "-Italic") make the family name diverge further from the contract's
// plain family name. Both are stripped before comparison so an honestly-embedded contracted font
// is not misreported as a substitution.
function normalizeFontFamily(name: string): string {
  return name
    .replace(/^[A-Z]{6}\+/, "")
    .replace(/[-,]?\s*(Bold|Italic|Oblique|Regular|MT|PS)\b/gi, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

/**
 * Fonts actually embedded in the rendered PDF that fall outside the contracted heading/body
 * fonts — the defect that produced two visibly different typefaces between the montage and the
 * delivered PDF in the Japan Career Agent run. `undefined` when there is no PDF to probe (the
 * PowerPoint COM backend never produces one) or `pdffonts` is unavailable; callers must not treat
 * that as "no substitution", only as "unmeasured".
 */
function probeRenderedFontSubstitution(renderDir: string, fonts: { heading: string; body: string }): string[] | undefined {
  const pdfPath = path.join(renderDir, "deck.pdf");
  if (!fs.existsSync(pdfPath)) return undefined;
  let raw: string;
  try {
    raw = execFileSync("pdffonts", [pdfPath], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, windowsHide: true });
  } catch {
    return undefined;
  }
  const allowed = new Set([fonts.heading, fonts.body].map(normalizeFontFamily));
  return parsePdfFontsOutput(raw).filter((name) => {
    const normalized = normalizeFontFamily(name);
    return normalized !== "" && !allowed.has(normalized);
  });
}

async function writeVisualArtifacts(outputDir: string, backend: VisualRenderBackend, probe: BackendProbe, rendered: RenderedSlide[], fonts: { heading: string; body: string }): Promise<void> {
  const renderDir = renderDirFor(outputDir);
  fs.writeFileSync(path.join(renderDir, "index.json"), JSON.stringify(rendered, null, 2));
  const substitutedFonts = probeRenderedFontSubstitution(renderDir, fonts);
  fs.writeFileSync(path.join(renderDir, "backend.json"), JSON.stringify({ backend: backend.name, backendVersion: probe.version, detail: probe.detail, slideCount: rendered.length, substitutedFonts: substitutedFonts ?? "unknown" }, null, 2));
  await writeMontage(renderDir, rendered);
}

export type RenderProvenance = { pptxSha256: string; specSha256: string; renderedAt: string; slideIds: string[]; templateGrammarDigest?: string };

function sha256OfFile(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sha256OfDeck(deck: DeckSpec): string {
  return crypto.createHash("sha256").update(JSON.stringify(deck)).digest("hex");
}

function writeRenderProvenance(runDir: string, pptxPath: string, deck: DeckSpec, slideIds: string[], style?: ResolvedPresentationStyle): void {
  const provenance: RenderProvenance = {
    pptxSha256: sha256OfFile(pptxPath),
    specSha256: sha256OfDeck(deck),
    renderedAt: new Date().toISOString(),
    slideIds,
    ...(style?.templateGrammarDigest ? { templateGrammarDigest: style.templateGrammarDigest } : {}),
  };
  fs.writeFileSync(path.join(renderDirFor(runDir), "render-provenance.json"), JSON.stringify(provenance, null, 2));
}

/**
 * Visual QA must judge the artifacts it actually looked at, not whatever the PPTX/DeckSpec
 * happen to be at the moment `visual-qa` runs. Without this, a slide fixed after `visual` last
 * ran keeps failing on a stale screenshot, or — the Japan Career Agent case — a render made
 * *after* judgment is mistaken for the judged one. Absence of provenance (runs made before this
 * existed) degrades to a non-blocking risk rather than a hard failure.
 */
export function verifyRenderProvenance(runDir: string, pptxPath: string, deck: DeckSpec, style?: ResolvedPresentationStyle): QaFinding[] {
  const provenancePath = path.join(renderDirFor(runDir), "render-provenance.json");
  if (!fs.existsSync(provenancePath)) {
    return [{ severity: "risk", code: "VISUAL_RENDER_PROVENANCE_UNKNOWN", message: "No render-provenance.json found in visual/. Cannot confirm the rendered artifacts match the current PPTX and DeckSpec — re-run `visual` to produce one." }];
  }
  const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8")) as RenderProvenance;
  const pptxMatches = fs.existsSync(pptxPath) && provenance.pptxSha256 === sha256OfFile(pptxPath);
  const specMatches = provenance.specSha256 === sha256OfDeck(deck);
  if (!pptxMatches || !specMatches) {
    return [{ severity: "hard", code: "VISUAL_QA_STALE_RENDER", message: `Rendered artifacts in ${path.join(runDir, "visual")} were produced at ${provenance.renderedAt} from a different PPTX or DeckSpec than the one being judged now. Re-run \`visual\` before \`visual-qa\`.` }];
  }
  if (style?.templateGrammarDigest && provenance.templateGrammarDigest !== style.templateGrammarDigest) {
    return [{ severity: "hard", code: "ORGANIZATION_GRAMMAR_NOT_APPLIED", message: "Rendered artifacts were not produced with the current Organization Template Grammar. Re-render before visual QA." }];
  }
  return [];
}

/**
 * Rasterizes a raw template.pptx's own slides — no DeckSpec, no render provenance, because a
 * template preview is not a judged deliverable render. Reuses the exact backend selection, PDF
 * pinning, and montage compositor renderVisual uses below, just without the DeckSpec-shaped
 * bookkeeping that has nothing to inspect here.
 */
export async function renderTemplatePreview(pptxPath: string, outputDir: string, slideCount: number): Promise<{ rendered: RenderedSlide[]; montagePath: string }> {
  const slideMap: SlideMapEntry[] = Array.from({ length: slideCount }, (_, index) => ({ slideId: `S${String(index + 1).padStart(2, "0")}`, index: index + 1 }));
  const backend = selectBackend();
  const rendered = await backend.render(pptxPath, outputDir, slideMap);
  const renderDir = renderDirFor(outputDir);
  await writeMontage(renderDir, rendered);
  return { rendered, montagePath: path.join(renderDir, "montage.png") };
}

export async function renderVisual(deck: DeckSpec, pptxPath: string, runDir: string, slideIds?: string[], style?: ResolvedPresentationStyle): Promise<RenderedSlide[]> {
  const ids = slideIds ?? deck.slides.map((slide) => slide.id);
  const slideMap: SlideMapEntry[] = ids.map((slideId) => {
    const deckIndex = deck.slides.findIndex((slide) => slide.id === slideId);
    if (deckIndex < 0) throw new Error(`Slide '${slideId}' does not exist in this DeckSpec.`);
    return { slideId, index: deckIndex + 1 };
  });
  const backend = selectBackend();
  const probe = backend.probe();
  const rendered = await backend.render(pptxPath, runDir, slideMap);
  await writeVisualArtifacts(runDir, backend, probe, rendered, deck.contract.fonts);
  writeRenderProvenance(runDir, pptxPath, deck, ids, style);
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
