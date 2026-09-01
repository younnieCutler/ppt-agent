import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { assertFontsInstalled, listInstalledFonts } from "./fonts";
import { renderDeck } from "./renderer";
import { contentModelSchema, contractSchema, deckSchema, type ContentModel } from "./schema";
import { mergeFindings, mergeQa, ooxmlQa, runPowerPointQa, structuralQa, verifySourceRefs } from "./qa";
import { loadReferenceIndex, previewPathsFor, queryFromContract, retrieveReferences } from "./reference";
import { buildDeckContext, renderTemplatePreview, renderVisual, verifyRenderProvenance } from "./visual";
import { visualQa, type ProvenanceFinding } from "./visual-qa";
import { applyRepair, buildRepairContext, recordRepairAttempt } from "./repair";
import { resolvePresentationStyle, styleContext } from "./style";
import { writeP3Metrics } from "./metrics";
import { markPhase, measurementWindow, resolveTranscript, transcriptDirectory, writeTokenReport } from "./tokens";
import { recordRun, writeQualityReport } from "./score";
import { deckPlanDigest, resolveCompositionPlan, validateDeckPlan, verifyDeckAgainstPlan } from "./planning";
import { sha256, sha256File, writeArtifactProvenance, type ArtifactProvenance } from "./provenance";
import { writeArtifactPair } from "./artifacts";
import { assertCanonicalTemplateElements, compileTemplateGrammar, elementsDigest, extractTemplateElements, type TemplateElementsArtifact } from "./template-analysis";
import { compileTemplateDesignSystem } from "./template-design-system";
import { compileTemplateComponents } from "./template-components";
import { applyPatternLabels, assertTemplatePatternsArtifact, compileTemplatePatterns, patternLabelSchema, resolvePatternPlan, selectPatternsForSlides, type TemplatePattern, type TemplatePatternsArtifact } from "./template-patterns";
import { checkTemplateFidelityUnproven, checkTemplatePatternNotFound, checkTemplateSemanticContentDropped, checkTemplateSlotCapacity, templateFidelityQa } from "./template-fidelity";
import { applyPatternSkeleton } from "./template";
import { renderAdaptiveStatement } from "./adaptive-statement";
import { renderAdaptiveRuntime } from "./adaptive-runtime";
import { resolveTemplateSourceSpec } from "./template-source";
import { createRunWorkspace, removeRunWorkspace } from "./workspace";

/**
 * Everything downstream of the plan, and the provenance that describes it. Listed once so an added
 * phase cannot forget to clear its own output.
 */
const DERIVED_ARTIFACTS = ["reference-selection.json", "resolved-style.json", "style-context.json", "composition-plan.json", "pattern-plan.json"] as const;
const DERIVED_PROVENANCE = ["referenceSelectionDigest", "referenceSelectionSource", "resolvedStyleDigest", "resolvedStyleSource", "compositionPlanDigest", "patternPlanDigest"] as const;

/**
 * Root inputs changed, so everything derived from them is obsolete — including artifacts the new
 * contract no longer produces at all (for example, a deck that dropped its references).
 * Leaving those behind is what made a run unrecoverable without deleting files by hand: their
 * provenance is gone, but `assertFresh` still sees the file. Clearing both together is the recovery
 * path, and it is deterministic: after `plan-validate`, the run holds only what its inputs imply.
 */
function invalidateDerivedArtifacts(runDir: string, provenance: ArtifactProvenance): ArtifactProvenance {
  for (const name of DERIVED_ARTIFACTS) fs.rmSync(path.join(path.resolve(runDir), name), { force: true });
  const remaining = { ...provenance } as Record<string, unknown>;
  for (const field of DERIVED_PROVENANCE) delete remaining[field];
  return remaining as ArtifactProvenance;
}

/**
 * A run directory has exactly one contract. Deriving an artifact from a different file, then storing
 * it next to that contract, produces a run whose parts never belonged together.
 */
function assertRunContract(runDir: string, contractPath: string): string {
  const runContractPath = path.join(path.resolve(runDir), "contract.json");
  const suppliedDigest = sha256File(contractPath);
  if (!fs.existsSync(runContractPath)) throw new Error(`Missing run contract: ${runContractPath}. Copy the contract into the run directory first.`);
  if (sha256File(runContractPath) !== suppliedDigest) throw new Error(`--contract does not match ${runContractPath}. A run directory holds one contract; re-run the run's earlier phases if the contract changed.`);
  return suppliedDigest;
}

/** Merges into the run directory's artifact provenance, so each phase records only its own inputs. */
function recordProvenance(runDir: string, fields: Partial<ArtifactProvenance>): void {
  const provenancePath = path.join(path.resolve(runDir), "artifact-provenance.json");
  const existing = fs.existsSync(provenancePath) ? (readJson(provenancePath) as ArtifactProvenance) : ({} as ArtifactProvenance);
  writeArtifactProvenance(runDir, { ...existing, ...fields });
}

/**
 * Verifies the causal edges, not just per-file freshness. Every file can match its own recorded
 * digest while the reference selection and the resolved style were derived from a contract that has
 * since been replaced — the phases simply have to be re-run in order.
 */
function assertDerivedFrom(provenance: ArtifactProvenance): void {
  const styleSource = provenance.resolvedStyleSource;
  if (!styleSource) throw new Error("Composition resolution blocked: the resolved style records no inputs. Re-run `style --run-dir`.");
  if (styleSource.contractDigest !== provenance.contractDigest) throw new Error("Composition resolution blocked: the resolved style was derived from a different contract than the one recorded at planning. Re-run `style --run-dir`.");
  if ((styleSource.referenceSelectionDigest ?? undefined) !== (provenance.referenceSelectionDigest ?? undefined)) throw new Error("Composition resolution blocked: the resolved style was derived from a different reference selection. Re-run `style --run-dir`.");
  const referenceSource = provenance.referenceSelectionSource;
  if (provenance.referenceSelectionDigest) {
    if (!referenceSource) throw new Error("Composition resolution blocked: the reference selection records no inputs. Re-run `reference --run-dir`.");
    if (referenceSource.contractDigest !== provenance.contractDigest) throw new Error("Composition resolution blocked: the reference selection was derived from a different contract than the one recorded at planning. Re-run `reference --run-dir`.");
  }
}

function assertFresh(runDir: string, provenance: Record<string, string>, inputs: Array<[keyof ArtifactProvenance, string]>): void {
  for (const [field, fileName] of inputs) {
    const recorded = provenance[field];
    const filePath = path.join(path.resolve(runDir), fileName);
    if (!recorded) {
      // An input that appeared after the digests were recorded was never part of what produced them,
      // so resolving against it would silently mix two runs.
      if (fs.existsSync(filePath)) throw new Error(`Composition resolution blocked: ${fileName} exists but is not recorded in artifact-provenance.json. Re-run the phase that produces it.`);
      continue;
    }
    if (!fs.existsSync(filePath)) throw new Error(`Composition resolution blocked: ${fileName} is recorded in artifact-provenance.json but missing from the run directory.`);
    if (sha256File(filePath) !== recorded) throw new Error(`Composition resolution blocked: ${fileName} changed after it was recorded (artifact-provenance.json digest mismatch). Re-run the phase that produces it.`);
  }
}

// The CLI is host-neutral: any agent host (Claude Code, Codex, a plain shell) can point it at the
// project root. CLAUDE_PROJECT_DIR stays as a fallback so existing Claude Code installs keep working.
function projectDirectory(): string {
  return process.env.PPT_AGENT_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

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

function physicalPath(filePath: string): string {
  const absolute = path.resolve(filePath);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
  }
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

// Every command below already writes its artifact to the run directory, so printing the whole blob
// puts a second copy of it into the agent's conversation for no benefit. Default to a summary and
// let the agent read the file when it actually needs the contents; `--print` restores full output.
let fullOutput = false;

function emit(summary: unknown, full: unknown): void {
  print(fullOutput ? full : summary);
}

/** Findings are what a failing run has to act on, so they survive the diet; a passing run gets counts. */
function emitReport(report: { status: string; findings: Array<{ severity: string; code: string; slideId?: string; message: string }> }, outputPath: string): void {
  if (fullOutput) return print(report);
  const counts = report.findings.reduce<Record<string, number>>((tally, finding) => ({ ...tally, [finding.severity]: (tally[finding.severity] ?? 0) + 1 }), {});
  print(report.status === "pass"
    ? { status: report.status, outputPath, findings: counts }
    : { status: report.status, outputPath, findings: report.findings });
}

/**
 * Applies an authored replacement slide and closes the repair phase.
 *
 * The `markPhase` call is in a `finally` on purpose: `repair-context` already opened the repair
 * phase, and the turns spent authoring the replacement only fall inside the measurement window if
 * this closing boundary is recorded. If `applyRepair` (schema parse, invariant checks) or the
 * subsequent write / state update throws, skipping the mark would close the window back at
 * `repair-context` and drop the entire cost of the attempt from `tokens.json`. A failed repair
 * still cost tokens; the window has to span it.
 */
export async function repairApply(args: string[]): Promise<void> {
  const specPath = option(args, "--spec");
  const runDir = option(args, "--run-dir");
  const slideId = option(args, "--slide");
  const replacementPath = option(args, "--replacement");
  const outPath = option(args, "--out");
  try {
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
  } finally {
    markPhase(runDir, "repair");
  }
}

export async function release(args: string[]): Promise<void> {
  const qaPath = option(args, "--qa");
  const judgmentPath = option(args, "--judgment");
  const repairStatePath = option(args, "--repair-state");
  const pptxPath = option(args, "--pptx");
  const outPath = option(args, "--out");
  const visualQaPath = optionalOption(args, "--visual-qa");
  const runDir = optionalOption(args, "--run-dir");
  const acceptRisk = hasFlag(args, "--accept-risk");
  const publishPdf = hasFlag(args, "--pdf");
  const keepWorkspace = hasFlag(args, "--keep-workspace");
  if (publishPdf && !runDir) throw new Error("Release blocked: --pdf requires --run-dir (the PDF is published from <run-dir>/visual/deck.pdf).");
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
    // Judgment is only meaningful about the file it actually looked at. Without this, a deck
    // can be re-rendered after visual-qa passed and released without anyone re-judging it —
    // the exact gap that let a stale render reach the Japan Career Agent deliverable. Both the
    // run directory and its provenance record are required here, not best-effort: a release
    // that skips them is exactly a release nobody can prove was judged.
    if (!runDir) {
      throw new Error("Release blocked: --run-dir is required alongside --visual-qa so the release can be checked against visual/render-provenance.json.");
    }
    const provenancePath = path.join(path.resolve(runDir), "visual", "render-provenance.json");
    if (!fs.existsSync(provenancePath)) {
      throw new Error(`Release blocked: ${provenancePath} does not exist. Re-run \`visual\` before releasing.`);
    }
    const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8")) as { pptxSha256: string };
    const releasedSha = crypto.createHash("sha256").update(fs.readFileSync(path.resolve(pptxPath))).digest("hex");
    if (provenance.pptxSha256 !== releasedSha) {
      throw new Error("Release blocked: the PPTX being released does not match the PPTX visual-qa judged (visual/render-provenance.json digest mismatch). Re-run `visual` and `visual-qa` against the exact file being released.");
    }
  }
  // Publish before touching anything else: the deliverable's existence must never depend on
  // whether cleanup afterward succeeds.
  const resolvedOutPath = path.resolve(outPath);
  fs.mkdirSync(path.dirname(resolvedOutPath), { recursive: true });
  fs.copyFileSync(path.resolve(pptxPath), resolvedOutPath);
  const publishedSha256 = crypto.createHash("sha256").update(fs.readFileSync(resolvedOutPath)).digest("hex");
  const sourceSha256 = crypto.createHash("sha256").update(fs.readFileSync(path.resolve(pptxPath))).digest("hex");
  if (publishedSha256 !== sourceSha256) throw new Error("Release blocked: published PPTX does not match its source after copy (publish integrity check failed).");

  let pdfOutputPath: string | undefined;
  if (publishPdf) {
    // The PDF Visual QA actually judged, copied verbatim. Re-converting at release time is exactly
    // how a Japan Career Agent deliverable ended up with a phantom duplicated headline that neither
    // the DeckSpec nor the judged montage ever had — a different converter, run again, is a new
    // artifact nobody re-judged.
    const judgedPdfPath = path.join(path.resolve(runDir!), "visual", "deck.pdf");
    if (!fs.existsSync(judgedPdfPath)) throw new Error(`Release blocked: --pdf requires ${judgedPdfPath} to exist. Re-run \`visual\` before releasing.`);
    pdfOutputPath = `${resolvedOutPath}.pdf`.replace(/\.pptx\.pdf$/, ".pdf");
    fs.copyFileSync(judgedPdfPath, pdfOutputPath);
    const publishedPdfSha256 = crypto.createHash("sha256").update(fs.readFileSync(pdfOutputPath)).digest("hex");
    const sourcePdfSha256 = crypto.createHash("sha256").update(fs.readFileSync(judgedPdfPath)).digest("hex");
    if (publishedPdfSha256 !== sourcePdfSha256) throw new Error("Release blocked: published PDF does not match visual/deck.pdf after copy (publish integrity check failed).");
  }

  let workspaceRemoved = false;
  let cleanupWarning: string | undefined;
  if (runDir && !keepWorkspace) {
    // A cleanup failure must never retract or invalidate an already-published deliverable — it is
    // logged and reported, not thrown, so the caller's success status still reflects reality.
    try {
      removeRunWorkspace(runDir);
      workspaceRemoved = true;
    } catch (error) {
      cleanupWarning = `Workspace cleanup failed for ${path.resolve(runDir)}: ${error instanceof Error ? error.message : String(error)}`;
      process.stderr.write(`Warning: ${cleanupWarning}\n`);
    }
  }

  print({ status: releaseStatus, outputPath: resolvedOutPath, pdfOutputPath, attempts: repairState.attempts, workspaceRemoved, cleanupWarning });
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command) {
    throw new Error("Usage: cli.js <fonts|style|reference|template-analyze|template-preview|pattern-label|plan-validate|composition-resolve|pattern-resolve|render-pattern-skeleton|adaptive-statement|workspace-open|validate|first-page|render|qa|visual|visual-qa|repair-context|repair-apply|metrics|tokens|score|record|release> ...");
  }
  fullOutput = hasFlag(args, "--print");

  if (command === "fonts") {
    print(listInstalledFonts());
    return;
  }

  if (command === "workspace-open") {
    const name = option(args, "--name");
    const projectDir = optionalOption(args, "--project-dir") ?? projectDirectory();
    const workspace = createRunWorkspace(projectDir, name);
    print({ status: "pass", ...workspace });
    return;
  }

  if (command === "style") {
    const contractPath = option(args, "--contract");
    const runDir = optionalOption(args, "--run-dir");
    const contract = contractSchema.parse(readJson(contractPath));
    const projectDir = projectDirectory();
    const references = runDir ? loadReferenceSelectionIfExists(path.join(path.resolve(runDir), "reference-selection.json")) : undefined;
    const style = resolvePresentationStyle(contract, { projectDir, referenceSelection: references });
    assertFontsInstalled(style.fonts);
    if (runDir) {
      fs.mkdirSync(path.resolve(runDir), { recursive: true });
      const contractDigest = assertRunContract(runDir, contractPath);
      fs.writeFileSync(path.join(path.resolve(runDir), "resolved-style.json"), JSON.stringify(style, null, 2));
      fs.writeFileSync(path.join(path.resolve(runDir), "style-context.json"), JSON.stringify(styleContext(style), null, 2));
      const referencePath = path.join(path.resolve(runDir), "reference-selection.json");
      recordProvenance(runDir, {
        resolvedStyleDigest: sha256File(path.join(path.resolve(runDir), "style-context.json")),
        resolvedStyleSource: {
          contractDigest,
          referenceSelectionDigest: fs.existsSync(referencePath) ? sha256File(referencePath) : undefined,
        },
      });
      markPhase(runDir, "styleResolution");
    }
    emit({ status: "pass", themeId: style.themeId, designDirection: style.designDirection, resolvedBy: style.provenance.resolvedBy, outputPath: runDir ? path.join(path.resolve(runDir), "style-context.json") : undefined }, style);
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
      const contractDigest = assertRunContract(runDir, contractPath);
      fs.writeFileSync(path.join(path.resolve(runDir), "reference-selection.json"), JSON.stringify(selected, null, 2));
      recordProvenance(runDir, {
        referenceSelectionDigest: sha256File(path.join(path.resolve(runDir), "reference-selection.json")),
        referenceSelectionSource: { contractDigest },
      });
      markPhase(runDir, "referenceRetrieval");
    }
    emit({ status: "pass", selected: selected.map((entry) => entry.id), outputPath: runDir ? path.join(path.resolve(runDir), "reference-selection.json") : undefined }, selected);
    return;
  }

  if (command === "template-analyze") {
    const input = option(args, "--input");
    const out = path.resolve(option(args, "--out"));
    const elements = await extractTemplateElements(input);
    const grammar = compileTemplateGrammar(elements);
    const designSystem = compileTemplateDesignSystem(elements, grammar);
    const components = compileTemplateComponents(elements);
    const patterns = compileTemplatePatterns(elements, grammar);
    fs.mkdirSync(out, { recursive: true });
    const outputPath = path.join(out, "template-elements.json");
    const grammarPath = path.join(out, "template-grammar.json");
    const designSystemPath = path.join(out, "template-design-system.json");
    const componentsPath = path.join(out, "template-components.json");
    const patternsPath = path.join(out, "template-patterns.json");
    writeArtifactPair([
      { path: outputPath, contents: JSON.stringify(elements, null, 2) },
      { path: grammarPath, contents: JSON.stringify(grammar, null, 2) },
      { path: designSystemPath, contents: JSON.stringify(designSystem, null, 2) },
      { path: componentsPath, contents: JSON.stringify(components, null, 2) },
      { path: patternsPath, contents: JSON.stringify(patterns, null, 2) },
    ]);
    print({ status: "pass", outputPath, grammarPath, designSystemPath, componentsPath, patternsPath, slides: elements.slides.length, strategy: elements.strategy, patterns: patterns.patterns.length, components: components.components.length });
    return;
  }

  if (command === "template-preview") {
    const input = option(args, "--input");
    const runDir = option(args, "--run-dir");
    const templateDir = path.join(path.resolve(runDir), "template");
    const elementsPath = path.join(templateDir, "template-elements.json");
    // Reuses template-analyze's own output when it already ran (the documented order), but does
    // not require it — a montage is legitimately useful before deciding whether to analyze further.
    const slideCount = fs.existsSync(elementsPath) ? (readJson(elementsPath) as { slides: unknown[] }).slides.length : (await extractTemplateElements(input)).slides.length;
    const { rendered, montagePath } = await renderTemplatePreview(input, templateDir, slideCount);
    print({ status: "pass", montagePath, slides: rendered.length });
    return;
  }

  if (command === "pattern-label") {
    const runDir = path.resolve(option(args, "--run-dir"));
    const labelsPath = option(args, "--labels");
    const patternsPath = path.join(runDir, "template", "template-patterns.json");
    if (!fs.existsSync(patternsPath)) throw new Error(`pattern-label requires ${patternsPath}. Run \`template-analyze\` first.`);
    const labels = patternLabelSchema.parse(readJson(labelsPath));
    const patterns = readJson(patternsPath) as Parameters<typeof applyPatternLabels>[0];
    const labeled = applyPatternLabels(patterns, labels);
    fs.writeFileSync(patternsPath, JSON.stringify(labeled, null, 2));
    print({ status: "pass", outputPath: patternsPath, labeled: labels.length });
    return;
  }

  if (command === "plan-validate") {
    const planPath = option(args, "--plan");
    const contentModelPath = option(args, "--content-model");
    const runDir = path.resolve(option(args, "--run-dir"));
    const findingsPath = optionalOption(args, "--findings");
    const contractPath = path.join(runDir, "contract.json");
    if (!fs.existsSync(contractPath)) throw new Error(`Missing run contract: ${contractPath}`);
    const plan = readJson(planPath);
    const contentModel = readJson(contentModelPath);
    const report = validateDeckPlan(plan, readJson(contractPath), contentModel, findingsPath ? readJson(findingsPath) : []);
    fs.mkdirSync(runDir, { recursive: true });
    const normalizedPlanPath = path.join(runDir, "deck-plan.json");
    fs.writeFileSync(normalizedPlanPath, JSON.stringify(report.plan, null, 2));
    fs.writeFileSync(path.join(runDir, "content-qa.json"), JSON.stringify({ status: "pass", findings: [] }, null, 2));
    // The run directory holds the copy every later stage re-hashes; a ContentModel that only ever
    // existed at the caller's path cannot be checked for drift later.
    const runContentModelPath = path.join(runDir, "content-model.json");
    fs.writeFileSync(runContentModelPath, JSON.stringify(contentModel, null, 2));
    const reportPath = path.join(runDir, "planning-qa.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    const roots = {
      contractDigest: sha256File(contractPath),
      contentModelDigest: sha256File(runContentModelPath),
      deckPlanDigest: deckPlanDigest(report.plan),
    };
    const provenancePath = path.join(runDir, "artifact-provenance.json");
    const previous = fs.existsSync(provenancePath) ? (readJson(provenancePath) as ArtifactProvenance) : ({} as ArtifactProvenance);
    const rootsChanged = previous.contractDigest !== roots.contractDigest
      || previous.contentModelDigest !== roots.contentModelDigest
      || previous.deckPlanDigest !== roots.deckPlanDigest;
    writeArtifactProvenance(runDir, { ...(rootsChanged ? invalidateDerivedArtifacts(runDir, previous) : previous), ...roots });
    emitReport({ ...report, findings: report.findings }, reportPath);
    if (report.status !== "pass") process.exitCode = 2;
    return;
  }

  if (command === "composition-resolve") {
    const planPath = option(args, "--plan");
    const styleContextPath = option(args, "--style-context");
    const runDir = path.resolve(option(args, "--run-dir"));
    const planningQaPath = path.join(runDir, "planning-qa.json");
    const provenancePath = path.join(runDir, "artifact-provenance.json");
    // Strict planning gate: `review` (a risk finding) blocks too — see SKILL.md.
    if (!fs.existsSync(planningQaPath) || (readJson(planningQaPath) as { status?: string }).status !== "pass") throw new Error("Composition resolution requires a passing planning-qa.json (status must be `pass`; a `review` status means an unresolved risk finding).");
    if (!fs.existsSync(provenancePath)) throw new Error("Composition resolution requires artifact-provenance.json.");
    const provenance = readJson(provenancePath) as ArtifactProvenance & Record<string, string>;
    if (!provenance.contractDigest || !provenance.contentModelDigest) throw new Error("Composition resolution requires contract and ContentModel provenance.");
    // Recording a digest and never re-checking it is not a provenance chain. Every upstream input
    // is re-hashed here, so editing the contract, the ContentModel, or the reference selection after
    // planning blocks resolution instead of silently resolving against a plan nobody re-validated.
    assertFresh(runDir, provenance, [
      ["contractDigest", "contract.json"],
      ["contentModelDigest", "content-model.json"],
      ["referenceSelectionDigest", "reference-selection.json"],
    ]);
    // Style resolution is a prerequisite phase, and the style actually passed here is the one that
    // must match it — checking only the run directory's copy would miss a --style-context pointing
    // somewhere else entirely.
    if (!provenance.resolvedStyleDigest) throw new Error("Composition resolution requires style provenance. Run `style --run-dir` first.");
    if (sha256File(styleContextPath) !== provenance.resolvedStyleDigest) throw new Error("Composition resolution blocked: style-context.json changed after style resolution (artifact-provenance.json digest mismatch). Re-run `style`.");
    assertDerivedFrom(provenance);
    if (provenance.deckPlanDigest !== deckPlanDigest(readJson(planPath))) throw new Error("Composition resolution blocked: deck plan digest is stale.");
    const styleContext = readJson(styleContextPath);
    const compositionPlan = resolveCompositionPlan(readJson(planPath), styleContext as never, {} as never);
    const outputPath = path.join(runDir, "composition-plan.json");
    fs.writeFileSync(outputPath, JSON.stringify(compositionPlan, null, 2));
    // Hash the bytes actually on disk, not a re-serialization of the in-memory object: JSON.stringify
    // without the pretty-print arguments produces different bytes than what was just written, so a
    // digest computed either way never matches a later sha256File() freshness check against the file.
    recordProvenance(runDir, { compositionPlanDigest: sha256File(outputPath) });
    emit({ status: "pass", outputPath, slides: compositionPlan.slides.length }, compositionPlan);
    return;
  }

  if (command === "pattern-resolve") {
    const planPath = option(args, "--plan");
    const runDir = path.resolve(option(args, "--run-dir"));
    const provenancePath = path.join(runDir, "artifact-provenance.json");
    const compositionPlanPath = path.join(runDir, "composition-plan.json");
    if (!fs.existsSync(provenancePath)) throw new Error("Pattern resolution requires artifact-provenance.json.");
    const provenance = readJson(provenancePath) as ArtifactProvenance & Record<string, string>;
    if (!provenance.compositionPlanDigest) throw new Error("Pattern resolution requires composition-plan.json. Run `composition-resolve` first.");
    if (!fs.existsSync(compositionPlanPath) || sha256File(compositionPlanPath) !== provenance.compositionPlanDigest) {
      throw new Error("Pattern resolution blocked: composition-plan.json changed after composition resolution (artifact-provenance.json digest mismatch). Re-run `composition-resolve`.");
    }
    if (provenance.deckPlanDigest !== deckPlanDigest(readJson(planPath))) throw new Error("Pattern resolution blocked: deck plan digest is stale.");
    const patternsPath = optionalOption(args, "--patterns") ?? path.join(runDir, "template", "template-patterns.json");
    if (!fs.existsSync(patternsPath)) {
      throw new Error(`Pattern resolution requires ${patternsPath}. Run \`template-analyze\` first — or skip pattern-resolve entirely for a native_layout template, which has no source-slide patterns to rank.`);
    }
    const patterns = readJson(patternsPath) as TemplatePatternsArtifact;
    const elementsPath = path.join(runDir, "template", "template-elements.json");
    const elements = fs.existsSync(elementsPath) ? readJson(elementsPath) as TemplateElementsArtifact : undefined;
    if (elements) {
      assertCanonicalTemplateElements(elements);
      if (patterns.sourceDigest !== elements.source.sha256 || patterns.elementsDigest !== elementsDigest(elements)) throw new Error("Pattern resolution blocked: template-patterns.json is stale for template-elements.json. Re-run template-analyze.");
    }
    const canvas = elements?.source.slideSize ?? patterns.coordinateSpace?.canvas;
    if (!canvas) throw new Error("Pattern resolution requires canonical coordinate-space metadata.");
    assertTemplatePatternsArtifact(patterns, canvas);
    const compositionPlan = readJson(compositionPlanPath) as Parameters<typeof resolvePatternPlan>[1];
    const patternPlan = resolvePatternPlan(readJson(planPath) as never, compositionPlan, patterns);
    const outputPath = path.join(runDir, "pattern-plan.json");
    fs.writeFileSync(outputPath, JSON.stringify(patternPlan, null, 2));
    recordProvenance(runDir, { templatePatternsDigest: sha256File(patternsPath), patternPlanDigest: sha256File(outputPath) });
    const strategy = elements?.strategy ?? "native_layout";
    const adaptiveRuntime = strategy === "source_slide_pattern"
      && fs.existsSync(path.join(runDir, "template", "template-design-system.json"))
      && fs.existsSync(path.join(runDir, "template", "template-components.json"));
    const notFoundFindings = checkTemplatePatternNotFound(strategy, patternPlan, { adaptiveRuntime });
    if (notFoundFindings.length > 0) process.exitCode = 2;
    emit({ status: notFoundFindings.length > 0 ? "fail" : "pass", outputPath, slides: patternPlan.slides.length, findings: notFoundFindings }, { ...patternPlan, findings: notFoundFindings });
    return;
  }

  if (command === "render-pattern-skeleton") {
    const specPath = option(args, "--spec");
    const scratchPath = option(args, "--scratch");
    const templatePath = option(args, "--template");
    const outPath = option(args, "--out");
    const runDir = path.resolve(option(args, "--run-dir"));
    const deck = deckSchema.parse(readJson(specPath));
    const patternPlanPath = path.join(runDir, "pattern-plan.json");
    if (!fs.existsSync(patternPlanPath)) throw new Error(`Skeleton render requires ${patternPlanPath}. Run \`pattern-resolve\` first.`);
    const patternsPath = path.join(runDir, "template", "template-patterns.json");
    if (!fs.existsSync(patternsPath)) throw new Error(`Skeleton render requires ${patternsPath}. Run \`template-analyze\` first.`);
    const elementsPath = path.join(runDir, "template", "template-elements.json");
    if (!fs.existsSync(elementsPath)) throw new Error(`Skeleton render requires ${elementsPath}. Run \`template-analyze\` first.`);
    const elements = readJson(elementsPath) as TemplateElementsArtifact;
    assertCanonicalTemplateElements(elements);
    const patternsArtifact = readJson(patternsPath) as TemplatePatternsArtifact;
    if (patternsArtifact.sourceDigest !== elements.source.sha256 || patternsArtifact.elementsDigest !== elementsDigest(elements)) throw new Error("Skeleton render blocked: template-patterns.json is stale for template-elements.json. Re-run template-analyze.");
    assertTemplatePatternsArtifact(patternsArtifact, elements.source.slideSize);
    const patternProvenance = path.join(runDir, "artifact-provenance.json");
    if (!fs.existsSync(patternProvenance)) throw new Error("Skeleton render requires artifact-provenance.json. Run pattern-resolve first.");
    const provenance = readJson(patternProvenance) as ArtifactProvenance & Record<string, string>;
    if (!provenance.templatePatternsDigest || sha256File(patternsPath) !== provenance.templatePatternsDigest) throw new Error("Skeleton render blocked: template-patterns.json changed after pattern resolution. Re-run pattern-resolve.");
    const patternPlan = readJson(patternPlanPath) as { slides: Array<{ id: string; candidates: Array<{ patternId: string; rank: number }> }> };
    const patternsById = new Map<string, TemplatePattern>(patternsArtifact.patterns.map((pattern) => [pattern.id, pattern]));
    const renderStrategy = elements.strategy;
    if (renderStrategy === "source_slide_pattern") {
      const designSystemPath = path.join(runDir, "template", "template-design-system.json");
      const componentsPath = path.join(runDir, "template", "template-components.json");
      if (!fs.existsSync(designSystemPath) || !fs.existsSync(componentsPath)) throw new Error("Adaptive raw-template rendering requires template-design-system.json and template-components.json. Re-run template-analyze.");
      const candidatesBySlide = new Map(patternPlan.slides.map((slide) => [slide.id, slide.candidates.map((candidate) => ({ rank: candidate.rank, pattern: patternsById.get(candidate.patternId) })).filter((candidate): candidate is { rank: number; pattern: TemplatePattern } => Boolean(candidate.pattern))]));
      const runtime = await renderAdaptiveRuntime({ templatePath, scratchPath, outputPath: outPath, slides: deck.slides, candidatesBySlide, elements, designSystem: readJson(designSystemPath) as import("./template-design-system").TemplateDesignSystemArtifact, components: readJson(componentsPath) as import("./template-components").TemplateComponentsArtifact });
      const manifestPath = path.join(runDir, "render-manifest.json");
      fs.writeFileSync(path.join(runDir, "adaptive-selection.json"), JSON.stringify(runtime.decisions, null, 2));
      fs.writeFileSync(manifestPath, JSON.stringify(runtime.manifest, null, 2));
      emit({ status: "pass", outputPath: path.resolve(outPath), manifestPath, slides: runtime.manifest.length, rendererSlides: runtime.manifest.filter((entry) => entry.mode === "renderer").length }, runtime);
      return;
    }
    // Walk each slide's shortlist in rank order and take the first candidate that would actually
    // carry the slide's real content and fit its required slots — not unconditionally rank 1. A
    // rank-1 pattern that would silently drop a process's steps, or overflow its headline slot, is
    // exactly the candidate rank 2/3 exist to fall back from. If no candidate fits, the slide gets
    // no resolved pattern at all and falls through to the generic renderer (recorded as such in
    // render-manifest.json) rather than clone a pattern that loses content.
    const deckSlidesById = new Map(deck.slides.map((slide) => [slide.id, slide]));
    const { resolvedPatterns, selectionLog } = selectPatternsForSlides(patternPlan, patternsById, deckSlidesById);
    // Reading the strategy this run's own template-analyze already recorded is what turns a
    // no-fitting-candidate slide into an immediate hard failure instead of a silent generic
    // redraw — see applyPatternSkeleton's own comment. Absent (template-analyze never wrote it
    // for some reason) falls back to the lenient default rather than guessing.
    const manifest = await applyPatternSkeleton(templatePath, scratchPath, outPath, deck.slides, resolvedPatterns, { strategy: renderStrategy });
    // The record of which candidate was actually chosen (and why the ones ranked above it were
    // skipped) — render-manifest.json's mode already names the chosen pattern per slide, but not
    // its rank or what was rejected along the way.
    fs.writeFileSync(path.join(runDir, "pattern-selection.json"), JSON.stringify(selectionLog, null, 2));
    const manifestPath = path.join(runDir, "render-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    emit({ status: "pass", outputPath: path.resolve(outPath), manifestPath, slides: manifest.length }, manifest);
    return;
  }

  if (command === "adaptive-statement") {
    const templatePath = option(args, "--template");
    const elementsPath = option(args, "--elements");
    const designSystemPath = option(args, "--design-system");
    const componentsPath = option(args, "--components");
    const intentPath = option(args, "--intent");
    const outputPath = path.resolve(option(args, "--out"));
    const planPath = path.resolve(optionalOption(args, "--plan-out") ?? `${outputPath}.adaptive-slide-plan.json`);
    const qaPath = path.resolve(optionalOption(args, "--qa-out") ?? `${outputPath}.adaptive-qa.json`);
    const outputTargets = [templatePath, elementsPath, designSystemPath, componentsPath, intentPath, outputPath, planPath, qaPath].map(physicalPath);
    if (new Set(outputTargets).size !== outputTargets.length) throw new Error("ADAPTIVE_STATEMENT_OUTPUT_ALIAS: template, PPTX output, plan output, and QA output must be distinct physical paths.");
    const result = await renderAdaptiveStatement(
      templatePath,
      outputPath,
      readJson(designSystemPath) as Parameters<typeof renderAdaptiveStatement>[2],
      readJson(componentsPath) as Parameters<typeof renderAdaptiveStatement>[3],
      readJson(elementsPath) as Parameters<typeof renderAdaptiveStatement>[4],
      readJson(intentPath),
    );
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.mkdirSync(path.dirname(qaPath), { recursive: true });
    fs.writeFileSync(planPath, JSON.stringify(result.plan, null, 2));
    fs.writeFileSync(qaPath, JSON.stringify(result.qa, null, 2));
    print({ status: result.qa.status, outputPath: result.outputPath, planPath, qaPath, findings: result.qa.findings.map((finding) => finding.code) });
    if (result.qa.status !== "pass") process.exitCode = 2;
    return;
  }

  if (command === "visual") {
    const specPath = option(args, "--spec");
    const pptxPath = option(args, "--pptx");
    const runDir = option(args, "--run-dir");
    const slidesRaw = optionalOption(args, "--slides");
    const deck = deckSchema.parse(readJson(specPath));
    const slideIds = slidesRaw ? slidesRaw.split(",").map((id) => id.trim()) : undefined;
    const projectDir = projectDirectory();
    const referenceSelection = loadReferenceSelectionIfExists(path.join(path.resolve(runDir), "reference-selection.json"));
    const style = resolvePresentationStyle(deck.contract, { projectDir, referenceSelection, legacyTheme: deck.theme });
    const index = await renderVisual(deck, pptxPath, runDir, slideIds, style);
    const deckContext = buildDeckContext(deck, index.map((entry) => entry.slideId), style);
    fs.writeFileSync(path.join(path.resolve(runDir), "visual", "deck-context.json"), JSON.stringify(deckContext, null, 2));
    emit({ status: "pass", rendered: index.length, montage: path.join(path.resolve(runDir), "visual", "montage.png"), deckContext: path.join(path.resolve(runDir), "visual", "deck-context.json") }, { status: "pass", index });
    return;
  }

  if (command === "visual-qa") {
    const specPath = option(args, "--spec");
    const runDir = option(args, "--run-dir");
    const findingsPath = option(args, "--findings");
    // Mandatory: judgment without the pptx that produced the render is judgment of nothing in
    // particular. This is exactly the gap that let the Japan Career Agent deliverable diverge
    // from what Visual QA actually looked at.
    const pptxPath = option(args, "--pptx");
    const deck = deckSchema.parse(readJson(specPath));
    const findings = readJson(findingsPath);
    const projectDir = projectDirectory();
    const references = loadReferenceSelectionIfExists(path.join(path.resolve(runDir), "reference-selection.json"));
    const style = resolvePresentationStyle(deck.contract, { projectDir, referenceSelection: references, legacyTheme: deck.theme });
    const provenance: ProvenanceFinding[] = verifyRenderProvenance(runDir, pptxPath, deck).map(({ code, message, slideId }) => ({ code: code as ProvenanceFinding["code"], message, slideId }));
    const backendPath = path.join(path.resolve(runDir), "visual", "backend.json");
    if (fs.existsSync(backendPath)) {
      const backendInfo = JSON.parse(fs.readFileSync(backendPath, "utf8")) as { substitutedFonts?: string[] | "unknown" };
      if (Array.isArray(backendInfo.substitutedFonts) && backendInfo.substitutedFonts.length > 0) {
        provenance.push({ code: "RENDER_FONT_SUBSTITUTION", message: `Rendered PDF uses font(s) outside the contracted heading/body pair: ${backendInfo.substitutedFonts.join(", ")}.` });
      }
    }
    const report = visualQa(deck, findings, undefined, style, provenance);
    const outputPath = path.join(path.resolve(runDir), "visual-qa.json");
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    markPhase(runDir, "visualJudgment");
    emitReport(report, outputPath);
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
    const projectDir = projectDirectory();
    const style = resolvePresentationStyle(deck.contract, { projectDir, referenceSelection: referenceSelection as Array<{ id: string; style?: { density?: string; visualWeight?: string }; layout?: { whitespace?: string; headline?: string }; traits?: string[] }> | undefined, legacyTheme: deck.theme });
    const context = buildRepairContext(deck, slideId, contentModel, visualQaReport, referenceSelection, imagePath, style);
    const outDir = path.join(path.resolve(runDir), "repair", slideId);
    fs.mkdirSync(outDir, { recursive: true });
    const contextPath = path.join(outDir, "context.json");
    fs.writeFileSync(contextPath, JSON.stringify(context, null, 2));
    // Opens the repair phase. `repair-apply` marks it again when the repair actually lands, and the
    // later mark wins — so the measurement window covers the authoring turns in between rather than
    // closing here, before the model has written anything. Marking here at all is what keeps an
    // abandoned repair (context built, never applied) from vanishing from the accounting entirely.
    markPhase(runDir, "repair");
    // The repair author needs the whole context, but it needs exactly one copy of it: read the file.
    emit({ status: "pass", slideId, outputPath: contextPath, findings: (context as { findings?: Array<{ code: string }> }).findings?.map((finding) => finding.code) ?? [] }, context);
    return;
  }

  if (command === "repair-apply") {
    await repairApply(args);
    return;
  }

  if (command === "release") {
    await release(args);
    return;
  }

  const specPath = option(args, "--spec");
  const rawDeck = readJson(specPath);
  const deck = deckSchema.parse(rawDeck);
  if (["validate", "render", "qa"].includes(command)) {
    const runDir = optionalOption(args, "--run-dir");
    const isV2 = Boolean(rawDeck && typeof rawDeck === "object" && (rawDeck as { version?: unknown }).version === 2);
    if (!isV2 && !hasFlag(args, "--allow-legacy")) throw new Error("Legacy DeckSpec requires --allow-legacy.");
    if (isV2) {
      if (!runDir) throw new Error("DeckSpec v2 requires --run-dir for DeckPlan verification.");
      const resolvedRunDir = path.resolve(runDir);
      const planPath = path.join(resolvedRunDir, "deck-plan.json");
      const compositionPath = path.join(resolvedRunDir, "composition-plan.json");
      if (!fs.existsSync(planPath) || !fs.existsSync(compositionPath)) throw new Error("DeckSpec v2 requires deck-plan.json and composition-plan.json in --run-dir.");
      const findings = verifyDeckAgainstPlan(deck, readJson(planPath), readJson(compositionPath));
      if (findings.length > 0) throw new Error(`DeckSpec v2 violates its DeckPlan: ${findings.map((finding) => finding.code).join(", ")}`);
    }
  }

  if (command === "metrics") {
    const runDir = option(args, "--run-dir");
    const metrics = writeP3Metrics(deck, runDir);
    emit({ status: "pass", outputPath: path.join(path.resolve(runDir), "p3-metrics.json"), themeId: metrics.themeId }, metrics);
    return;
  }

  if (command === "tokens") {
    const runDir = option(args, "--run-dir");
    const projectDir = projectDirectory();
    const since = optionalOption(args, "--since") ? Date.parse(option(args, "--since")) : undefined;
    const until = optionalOption(args, "--until") ? Date.parse(option(args, "--until")) : undefined;
    const sessionId = optionalOption(args, "--session-id");
    const transcriptPath = optionalOption(args, "--transcript")
      ?? (sessionId ? path.join(transcriptDirectory(projectDir), `${sessionId}.jsonl`) : undefined)
      ?? resolveTranscript(projectDir, os.homedir(), measurementWindow(runDir, specPath, since, until));
    const report = writeTokenReport({
      runDir,
      transcriptPath: path.resolve(transcriptPath),
      slides: deck.slides.length,
      specPath,
      benchmark: optionalOption(args, "--benchmark"),
      since,
      until,
    });
    emit({
      status: "pass",
      outputPath: path.join(path.resolve(runDir), "tokens.json"),
      total: report.tokenUsage.total.total,
      effective: report.tokenUsage.total.effective,
      tokensPerSlide: report.tokensPerSlide,
      repairOverhead: report.repairOverhead,
      measurement: report.measurement,
    }, report);
    // A measurement failure is not a passing run's silence — it is a distinct condition the
    // caller must see, or a 0-token deck slips through as if telemetry had succeeded.
    if (report.measurement === "unavailable" && !hasFlag(args, "--allow-unmeasured")) process.exitCode = 2;
    return;
  }

  if (command === "score") {
    const runDir = option(args, "--run-dir");
    const report = writeQualityReport(deck, runDir, readJson(option(args, "--scores")));
    emit({ status: report.status, outputPath: path.join(path.resolve(runDir), "quality.json"), qualityScore: report.qualityScore, hardFailures: report.hardFailures, hardFailureCodes: report.hardFailureCodes }, report);
    if (report.status !== "pass") process.exitCode = 2;
    return;
  }

  if (command === "record") {
    const runDir = option(args, "--run-dir");
    const projectDir = projectDirectory();
    const { record, historyPath } = recordRun({ deck, runDir, benchmark: option(args, "--benchmark"), version: option(args, "--version"), projectDir });
    emit({ status: "pass", outputPath: historyPath, qualityScore: record.qualityScore, tokens: record.tokens, hardFailures: record.hardFailures }, record);
    return;
  }

  if (command === "validate") {
    assertFontsInstalled(deck.contract.fonts);
    const runDir = optionalOption(args, "--run-dir");
    const projectDir = projectDirectory();
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
    const projectDir = projectDirectory();
    const contentModel = runDir ? loadContentModelIfExists(path.join(path.resolve(runDir), "content-model.json")) : undefined;
    const referenceSelection = runDir ? loadReferenceSelectionIfExists(path.join(path.resolve(runDir), "reference-selection.json")) : undefined;
    const style = resolvePresentationStyle(deck.contract, { projectDir, referenceSelection, legacyTheme: deck.theme });
    if (runDir) {
      fs.mkdirSync(path.resolve(runDir), { recursive: true });
      fs.writeFileSync(path.join(path.resolve(runDir), "resolved-style.json"), JSON.stringify(style, null, 2));
      fs.writeFileSync(path.join(path.resolve(runDir), "style-context.json"), JSON.stringify(styleContext(style), null, 2));
      markPhase(runDir, "styleResolution");
    }
    const result = await renderDeck(deck, outPath, projectDir, { contentModel, referenceSelection });
    fs.writeFileSync(`${path.resolve(outPath)}.geometry.json`, JSON.stringify(result.slideRects, null, 2));
    if (runDir) markPhase(runDir, "compositionAuthoring");
    print({ status: "pass", outputPath: result.outputPath });
    return;
  }

  if (command === "first-page") {
    const outPath = option(args, "--out");
    const runDir = option(args, "--run-dir");
    const usePowerPoint = hasFlag(args, "--powerpoint");
    const projectDir = projectDirectory();
    const contentModelPath = path.join(path.resolve(runDir), "content-model.json");
    const referenceSelectionPath = path.join(path.resolve(runDir), "reference-selection.json");
    const references = loadReferenceSelectionIfExists(referenceSelectionPath);
    const result = await renderDeck(deck, outPath, projectDir, { pageLimit: 1, contentModel: loadContentModelIfExists(contentModelPath), referenceSelection: references });
    const style = resolvePresentationStyle(deck.contract, { projectDir, referenceSelection: references, legacyTheme: deck.theme });
    const canonicalDeck = { ...deck, theme: { schemaVersion: style.schemaVersion, id: style.themeId, palette: style.palette, data: style.data } };
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
    const reportPath = path.join(path.resolve(runDir), "first-page-qa.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(`${path.resolve(outPath)}.geometry.json`, JSON.stringify(result.slideRects, null, 2));
    emitReport(report, reportPath);
    if (report.status !== "pass") process.exitCode = 2;
    return;
  }

  if (command === "qa") {
    const pptxPath = option(args, "--pptx");
    const runDir = option(args, "--run-dir");
    const usePowerPoint = hasFlag(args, "--powerpoint");
    const projectDir = projectDirectory();
    const contentModelPath = path.join(path.resolve(runDir), "content-model.json");
    const referenceSelectionPath = path.join(path.resolve(runDir), "reference-selection.json");
    const references = loadReferenceSelectionIfExists(referenceSelectionPath);
    const style = resolvePresentationStyle(deck.contract, { projectDir, referenceSelection: references, legacyTheme: deck.theme });
    const canonicalDeck = { ...deck, theme: { schemaVersion: style.schemaVersion, id: style.themeId, palette: style.palette, data: style.data } };
    const structural = structuralQa(canonicalDeck, projectDir, contentModelPath, referenceSelectionPath);
    const renderManifestPath = path.join(path.resolve(runDir), "render-manifest.json");
    const renderManifest = fs.existsSync(renderManifestPath) ? (readJson(renderManifestPath) as import("./template-fidelity").RenderManifestEntry[]) : undefined;
    const patternRenderedSlideIds = new Set((renderManifest ?? []).filter((entry) => entry.mode.startsWith("pattern:")).map((entry) => entry.slideId));
    // A raw template's own grammar is the source of its native font vocabulary. Read the run-scoped
    // artifact directly so cloned source-slide typography is not mistaken for substitution.
    const runGrammarPath = path.join(path.resolve(runDir), "template", "template-grammar.json");
    const runTemplateFonts = fs.existsSync(runGrammarPath) ? ((readJson(runGrammarPath) as { typography?: { families?: string[] } }).typography?.families ?? []) : [];
    const styleForFonts = runTemplateFonts.length > 0 ? { ...style, templateGrammar: { typography: { families: runTemplateFonts } } } : style;
    const ooxmlFindings = fs.existsSync(path.resolve(pptxPath))
      ? await ooxmlQa(pptxPath, canonicalDeck, undefined, styleForFonts as never, patternRenderedSlideIds)
      : [{ severity: "hard" as const, code: "OOXML_INVALID", message: `Rendered PPTX does not exist: ${pptxPath}` }];
    let report = mergeFindings(structural, ooxmlFindings);
    // The raw template path is the only source-slide fidelity source.
    const templateSource = resolveTemplateSourceSpec(canonicalDeck.contract);
    const sourceTemplatePath = templateSource
      ? path.resolve(projectDir, templateSource.path)
      : undefined;
    // `render-pattern-skeleton` never even ran: no render-manifest.json exists at all. The block
    // below (templateFidelityQa, which itself calls checkTemplateFidelityUnproven) only runs when
    // renderManifest is truthy, so that check was entirely unreachable in exactly the case it
    // exists to catch — going straight from a raw template to `render`+`qa` would otherwise allow
    // a source_slide_pattern template to be redrawn generically without a manifest.
    if (!renderManifest && sourceTemplatePath && fs.existsSync(sourceTemplatePath)) {
      const elementsPathForStrategy = path.join(path.resolve(runDir), "template", "template-elements.json");
      const strategy = fs.existsSync(elementsPathForStrategy)
        ? (readJson(elementsPathForStrategy) as { strategy: import("./template-analysis").TemplateStrategy }).strategy
        : (await extractTemplateElements(sourceTemplatePath)).strategy;
      const allGenericManifest = deck.slides.map((slide) => ({ slideId: slide.id, mode: "renderer" }));
      report = mergeFindings(report, checkTemplateFidelityUnproven(strategy, allGenericManifest));
    }
    if (renderManifest && sourceTemplatePath && fs.existsSync(sourceTemplatePath) && fs.existsSync(path.resolve(pptxPath))) {
      const manifest = renderManifest;
      const patternsPath = path.join(path.resolve(runDir), "template", "template-patterns.json");
      const elementsPath = path.join(path.resolve(runDir), "template", "template-elements.json");
      if (fs.existsSync(patternsPath) && fs.existsSync(elementsPath)) {
        const patterns = (readJson(patternsPath) as { patterns: Parameters<typeof templateFidelityQa>[4] }).patterns;
        const strategy = (readJson(elementsPath) as { strategy: Parameters<typeof templateFidelityQa>[5] }).strategy;
        const fidelityFindings = await templateFidelityQa(pptxPath, sourceTemplatePath, canonicalDeck, manifest, patterns, strategy);
        const patternsById = new Map(patterns.map((pattern) => [pattern.id, pattern]));
        const chosenPatterns = new Map(
          manifest
            .map((entry) => [entry.slideId, patternsById.get((entry.mode.startsWith("pattern:") ? entry.mode.slice(8) : "") as string)] as const)
            .filter((tuple): tuple is [string, (typeof patterns)[number]] => Boolean(tuple[1])),
        );
        const capacityFindings = checkTemplateSlotCapacity(canonicalDeck, chosenPatterns);
        // Independent of, and never covered by, the REQUIRED_NATIVE_OBJECT_MISSING exemption for
        // pattern-rendered slides above (that exemption is about connector/shape geometry; this is
        // about whether the slide's actual grounded content reached a slot at all).
        const semanticContentFindings = checkTemplateSemanticContentDropped(canonicalDeck, chosenPatterns);
        report = mergeFindings(report, [...fidelityFindings, ...capacityFindings, ...semanticContentFindings]);
      }
    }
    if (usePowerPoint && process.platform === "win32") {
      const powerpoint = runPowerPointQa(pptxPath, canonicalDeck, runDir);
      report = mergeQa(report, powerpoint);
    } else if (usePowerPoint) {
      report = { ...report, powerpoint: { status: "skipped", findings: [], reason: "PowerPoint COM QA requires Windows; run this command there for Level 3 verification." } };
    }
    fs.mkdirSync(path.resolve(runDir), { recursive: true });
    const reportPath = path.join(path.resolve(runDir), "qa.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    emitReport(report, reportPath);
    if (report.status !== "pass") process.exitCode = 2;
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

// Only run the CLI when invoked directly, not when imported (e.g. by tests exercising `repairApply`).
if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
