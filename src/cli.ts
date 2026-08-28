import fs from "node:fs";
import path from "node:path";
import { assertFontsInstalled, listInstalledFonts } from "./fonts";
import { resolveTheme } from "./brand";
import { renderDeck } from "./renderer";
import { contentModelSchema, contractSchema, deckSchema, type ContentModel } from "./schema";
import { mergeFindings, mergeQa, ooxmlQa, runPowerPointQa, structuralQa, verifySourceRefs } from "./qa";
import { loadReferenceIndex, previewPathsFor, queryFromContract, retrieveReferences } from "./reference";
import { buildDeckContext, renderVisual } from "./visual";
import { visualQa } from "./visual-qa";
import { applyRepair, buildRepairContext, recordRepairAttempt } from "./repair";
import { resolvePresentationStyle, styleContext } from "./style";
import { writeP3Metrics } from "./metrics";

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing required option ${name}`);
  return args[index + 1];
}

function optionalOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function loadContentModelIfExists(filePath: string): ContentModel | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return contentModelSchema.parse(readJson(filePath));
}

function loadReferenceSelectionIfExists(filePath: string): Array<{ id: string; style?: { density?: string; visualWeight?: string }; layout?: { whitespace?: string; headline?: string }; traits?: string[] }> | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return readJson(filePath) as Array<{ id: string; style?: { density?: string; visualWeight?: string }; layout?: { whitespace?: string; headline?: string }; traits?: string[] }>;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command) {
    throw new Error("Usage: cli.js <fonts|style|theme|reference|validate|first-page|render|qa|visual|visual-qa|repair-context|repair-apply|metrics|release> ...");
  }

  if (command === "fonts") {
    print(listInstalledFonts());
    return;
  }

  if (command === "theme") {
    const contractPath = option(args, "--contract");
    const contract = contractSchema.parse(readJson(contractPath));
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const legacyTheme = resolveTheme(contract, projectDir);
    assertFontsInstalled(legacyTheme.fonts);
    print(legacyTheme);
    return;
  }

  if (command === "style") {
    const contractPath = option(args, "--contract");
    const runDir = optionalOption(args, "--run-dir");
    const contract = contractSchema.parse(readJson(contractPath));
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const references = runDir ? loadReferenceSelectionIfExists(path.join(path.resolve(runDir), "reference-selection.json")) : undefined;
    const style = resolvePresentationStyle(contract, { projectDir, referenceSelection: references });
    assertFontsInstalled(style.fonts);
    if (runDir) {
      fs.mkdirSync(path.resolve(runDir), { recursive: true });
      fs.writeFileSync(path.join(path.resolve(runDir), "resolved-style.json"), JSON.stringify(style, null, 2));
      fs.writeFileSync(path.join(path.resolve(runDir), "style-context.json"), JSON.stringify(styleContext(style), null, 2));
    }
    print(style);
    return;
  }

  if (command === "reference") {
    const contractPath = option(args, "--contract");
    const referenceRoot = path.resolve(option(args, "--reference-root"));
    const topKRaw = optionalOption(args, "--top-k");
    const runDir = optionalOption(args, "--run-dir");
    const contract = contractSchema.parse(readJson(contractPath));
    const index = loadReferenceIndex(referenceRoot);
    const selected = retrieveReferences(index, queryFromContract(contract), topKRaw ? Number(topKRaw) : 3)
      .map((entry) => ({ ...entry, previewPaths: previewPathsFor(referenceRoot, entry) }));
    if (runDir) {
      fs.mkdirSync(path.resolve(runDir), { recursive: true });
      fs.writeFileSync(path.join(path.resolve(runDir), "reference-selection.json"), JSON.stringify(selected, null, 2));
    }
    print(selected);
    return;
  }

  if (command === "visual") {
    const specPath = option(args, "--spec");
    const pptxPath = option(args, "--pptx");
    const runDir = option(args, "--run-dir");
    const slidesRaw = optionalOption(args, "--slides");
    const deck = deckSchema.parse(readJson(specPath));
    const slideIds = slidesRaw ? slidesRaw.split(",").map((id) => id.trim()) : undefined;
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const referenceSelection = loadReferenceSelectionIfExists(path.join(path.resolve(runDir), "reference-selection.json"));
    const style = resolvePresentationStyle(deck.contract, { projectDir, referenceSelection, legacyTheme: deck.theme });
    const index = await renderVisual(deck, pptxPath, runDir, slideIds);
    const deckContext = buildDeckContext(deck, index.map((entry) => entry.slideId), style);
    fs.writeFileSync(path.join(path.resolve(runDir), "visual", "deck-context.json"), JSON.stringify(deckContext, null, 2));
    print({ status: "pass", index });
    return;
  }

  if (command === "visual-qa") {
    const specPath = option(args, "--spec");
    const runDir = option(args, "--run-dir");
    const findingsPath = option(args, "--findings");
    const deck = deckSchema.parse(readJson(specPath));
    const findings = readJson(findingsPath);
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const references = loadReferenceSelectionIfExists(path.join(path.resolve(runDir), "reference-selection.json"));
    const style = resolvePresentationStyle(deck.contract, { projectDir, referenceSelection: references, legacyTheme: deck.theme });
    const report = visualQa(deck, findings, undefined, style);
    fs.writeFileSync(path.join(path.resolve(runDir), "visual-qa.json"), JSON.stringify(report, null, 2));
    print(report);
    if (report.status !== "pass") process.exitCode = 2;
    return;
  }

  if (command === "repair-context") {
    const specPath = option(args, "--spec");
    const runDir = option(args, "--run-dir");
    const slideId = option(args, "--slide");
    const deck = deckSchema.parse(readJson(specPath));
    const contentModelPath = path.join(path.resolve(runDir), "content-model.json");
    const contentModel = loadContentModelIfExists(contentModelPath);
    const visualQaPath = path.join(path.resolve(runDir), "visual-qa.json");
    const visualQaReport = fs.existsSync(visualQaPath) ? (readJson(visualQaPath) as { findings: Array<{ severity: string; code: string; slideId?: string; message: string }> }) : undefined;
    const referenceSelectionPath = path.join(path.resolve(runDir), "reference-selection.json");
    const referenceSelection = fs.existsSync(referenceSelectionPath) ? (readJson(referenceSelectionPath) as Array<Record<string, unknown>>) : undefined;
    const indexPath = path.join(path.resolve(runDir), "visual", "index.json");
    const index = fs.existsSync(indexPath) ? (readJson(indexPath) as Array<{ slideId: string; path: string }>) : [];
    const imagePath = index.find((entry) => entry.slideId === slideId)?.path ?? "";
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const style = resolvePresentationStyle(deck.contract, { projectDir, referenceSelection: referenceSelection as Array<{ id: string; style?: { density?: string; visualWeight?: string }; layout?: { whitespace?: string; headline?: string }; traits?: string[] }> | undefined, legacyTheme: deck.theme });
    const context = buildRepairContext(deck, slideId, contentModel, visualQaReport, referenceSelection, imagePath, style);
    const outDir = path.join(path.resolve(runDir), "repair", slideId);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "context.json"), JSON.stringify(context, null, 2));
    print(context);
    return;
  }

  if (command === "repair-apply") {
    const specPath = option(args, "--spec");
    const runDir = option(args, "--run-dir");
    const slideId = option(args, "--slide");
    const replacementPath = option(args, "--replacement");
    const outPath = option(args, "--out");
    const deck = deckSchema.parse(readJson(specPath));
    const contentModelPath = path.join(path.resolve(runDir), "content-model.json");
    const contentModel = loadContentModelIfExists(contentModelPath);
    const replacement = readJson(replacementPath);
    const { deck: repairedDeck, regressionScope } = applyRepair(deck, slideId, replacement, contentModel);
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outPath), JSON.stringify(repairedDeck, null, 2));
    const visualQaPath = path.join(path.resolve(runDir), "visual-qa.json");
    const priorFindings = fs.existsSync(visualQaPath) ? (readJson(visualQaPath) as { findings: Array<{ code: string; slideId?: string }> }).findings : [];
    const lastFindings = priorFindings.filter((finding) => !finding.slideId || finding.slideId === slideId).map((finding) => finding.code);
    const statePath = path.join(path.resolve(runDir), "repair-state.json");
    const state = recordRepairAttempt(statePath, slideId, lastFindings, "in_progress");
    print({ status: "pass", outputPath: path.resolve(outPath), regressionScope, repairState: state });
    return;
  }

  if (command === "release") {
    const qaPath = option(args, "--qa");
    const judgmentPath = option(args, "--judgment");
    const repairStatePath = option(args, "--repair-state");
    const pptxPath = option(args, "--pptx");
    const outPath = option(args, "--out");
    const visualQaPath = optionalOption(args, "--visual-qa");
    const acceptRisk = hasFlag(args, "--accept-risk");
    const qa = readJson(qaPath) as { status?: string; attempts?: number };
    const judgment = fs.readFileSync(path.resolve(judgmentPath), "utf8");
    const repairState = readJson(repairStatePath) as { attempts?: unknown };
    if (qa.status !== "pass") throw new Error("Release blocked: qa.json.status must be pass.");
    if (!/Outcome:\s*good\b/i.test(judgment) || !/Release decision:\s*pass\b/i.test(judgment)) {
      throw new Error("Release blocked: judgment.md must declare Outcome: good and Release decision: pass.");
    }
    if (!Number.isInteger(repairState.attempts) || (repairState.attempts as number) < 0 || (repairState.attempts as number) > 2) {
      throw new Error("Release blocked: repair-state.json must record integer attempts from 0 to 2.");
    }
    if (!fs.existsSync(path.resolve(pptxPath))) throw new Error(`Release blocked: PPTX does not exist: ${pptxPath}`);
    let releaseStatus: "pass" | "pass_with_warning" = "pass";
    if (visualQaPath) {
      const visualQaJson = readJson(path.resolve(visualQaPath)) as { status?: string; findings?: Array<{ severity: string }> };
      if (visualQaJson.status === "fail") throw new Error("Release blocked: visual-qa.json contains an unresolved hard finding.");
      const hasRisk = (visualQaJson.findings ?? []).some((finding) => finding.severity === "risk");
      if (hasRisk) {
        if (!acceptRisk) throw new Error("Release blocked: visual-qa.json contains unresolved risk findings. Pass --accept-risk to release with warnings.");
        releaseStatus = "pass_with_warning";
      }
    }
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.copyFileSync(path.resolve(pptxPath), path.resolve(outPath));
    print({ status: releaseStatus, outputPath: path.resolve(outPath), attempts: repairState.attempts });
    return;
  }

  const specPath = option(args, "--spec");
  const rawDeck = readJson(specPath);
  const deck = deckSchema.parse(rawDeck);

  if (command === "metrics") {
    const runDir = option(args, "--run-dir");
    print(writeP3Metrics(deck, runDir));
    return;
  }

  if (command === "validate") {
    assertFontsInstalled(deck.contract.fonts);
    const runDir = optionalOption(args, "--run-dir");
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const references = runDir ? loadReferenceSelectionIfExists(path.join(path.resolve(runDir), "reference-selection.json")) : undefined;
    const style = resolvePresentationStyle(deck.contract, { projectDir, referenceSelection: references, legacyTheme: deck.theme });
    assertFontsInstalled(style.fonts);
    const refFindings = runDir ? verifySourceRefs(deck, projectDir, path.join(path.resolve(runDir), "content-model.json")) : [];
    if (refFindings.length > 0) {
      print({ status: "fail", slides: deck.slides.length, fonts: deck.contract.fonts, presentationStyle: style.themeId, findings: refFindings });
      process.exitCode = 2;
      return;
    }
    print({ status: "pass", slides: deck.slides.length, fonts: deck.contract.fonts, presentationStyle: style.themeId });
    return;
  }

  if (command === "render") {
    const outPath = option(args, "--out");
    const runDir = optionalOption(args, "--run-dir");
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const contentModel = runDir ? loadContentModelIfExists(path.join(path.resolve(runDir), "content-model.json")) : undefined;
    const referenceSelection = runDir ? loadReferenceSelectionIfExists(path.join(path.resolve(runDir), "reference-selection.json")) : undefined;
    const style = resolvePresentationStyle(deck.contract, { projectDir, referenceSelection, legacyTheme: deck.theme });
    if (runDir) {
      fs.mkdirSync(path.resolve(runDir), { recursive: true });
      fs.writeFileSync(path.join(path.resolve(runDir), "resolved-style.json"), JSON.stringify(style, null, 2));
      fs.writeFileSync(path.join(path.resolve(runDir), "style-context.json"), JSON.stringify(styleContext(style), null, 2));
    }
    const result = await renderDeck(deck, outPath, projectDir, { contentModel, referenceSelection });
    fs.writeFileSync(`${path.resolve(outPath)}.geometry.json`, JSON.stringify(result.slideRects, null, 2));
    print({ status: "pass", outputPath: result.outputPath });
    return;
  }

  if (command === "first-page") {
    const outPath = option(args, "--out");
    const runDir = option(args, "--run-dir");
    const usePowerPoint = hasFlag(args, "--powerpoint");
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const contentModelPath = path.join(path.resolve(runDir), "content-model.json");
    const referenceSelectionPath = path.join(path.resolve(runDir), "reference-selection.json");
    const references = loadReferenceSelectionIfExists(referenceSelectionPath);
    const result = await renderDeck(deck, outPath, projectDir, { pageLimit: 1, contentModel: loadContentModelIfExists(contentModelPath), referenceSelection: references });
    const style = resolvePresentationStyle(deck.contract, { projectDir, referenceSelection: references, legacyTheme: deck.theme });
    const canonicalDeck = { ...deck, theme: style as any };
    const firstSlideId = canonicalDeck.slides[0].id;
    const structural = structuralQa(canonicalDeck, projectDir, contentModelPath, referenceSelectionPath);
    const ooxmlFindings = await ooxmlQa(outPath, canonicalDeck, [firstSlideId], style);
    let report = mergeFindings(structural, ooxmlFindings);
    if (usePowerPoint && process.platform === "win32") {
      const powerpoint = runPowerPointQa(outPath, canonicalDeck, path.join(path.resolve(runDir), "first-page"), [firstSlideId]);
      report = mergeQa(report, powerpoint);
    } else if (usePowerPoint) {
      report = { ...report, powerpoint: { status: "skipped", findings: [], reason: "PowerPoint COM QA requires Windows; run this command there for Level 3 verification." } };
    }
    fs.mkdirSync(path.resolve(runDir), { recursive: true });
    fs.writeFileSync(path.join(path.resolve(runDir), "first-page-qa.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(`${path.resolve(outPath)}.geometry.json`, JSON.stringify(result.slideRects, null, 2));
    print(report);
    if (report.status !== "pass") process.exitCode = 2;
    return;
  }

  if (command === "qa") {
    const pptxPath = option(args, "--pptx");
    const runDir = option(args, "--run-dir");
    const usePowerPoint = hasFlag(args, "--powerpoint");
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const contentModelPath = path.join(path.resolve(runDir), "content-model.json");
    const referenceSelectionPath = path.join(path.resolve(runDir), "reference-selection.json");
    const references = loadReferenceSelectionIfExists(referenceSelectionPath);
    const style = resolvePresentationStyle(deck.contract, { projectDir, referenceSelection: references, legacyTheme: deck.theme });
    const canonicalDeck = { ...deck, theme: style as any };
    const structural = structuralQa(canonicalDeck, projectDir, contentModelPath, referenceSelectionPath);
    const ooxmlFindings = fs.existsSync(path.resolve(pptxPath))
      ? await ooxmlQa(pptxPath, canonicalDeck, undefined, style)
      : [{ severity: "hard" as const, code: "OOXML_INVALID", message: `Rendered PPTX does not exist: ${pptxPath}` }];
    let report = mergeFindings(structural, ooxmlFindings);
    if (usePowerPoint && process.platform === "win32") {
      const powerpoint = runPowerPointQa(pptxPath, canonicalDeck, runDir);
      report = mergeQa(report, powerpoint);
    } else if (usePowerPoint) {
      report = { ...report, powerpoint: { status: "skipped", findings: [], reason: "PowerPoint COM QA requires Windows; run this command there for Level 3 verification." } };
    }
    fs.mkdirSync(path.resolve(runDir), { recursive: true });
    fs.writeFileSync(path.join(path.resolve(runDir), "qa.json"), JSON.stringify(report, null, 2));
    print(report);
    if (report.status !== "pass") process.exitCode = 2;
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
