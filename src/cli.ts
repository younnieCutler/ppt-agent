import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { assertFontsInstalled, listInstalledFonts } from "./fonts";
import { resolveTheme } from "./brand";
import { renderDeck } from "./renderer";
import { contentModelSchema, contractSchema, deckSchema, type ContentModel } from "./schema";
import { mergeFindings, mergeQa, ooxmlQa, runPowerPointQa, structuralQa, verifySourceRefs } from "./qa";
import { loadReferenceIndex, previewPathsFor, queryFromContract, retrieveReferences } from "./reference";
import { buildDeckContext, renderVisual, verifyRenderProvenance } from "./visual";
import { visualQa, type ProvenanceFinding } from "./visual-qa";
import { applyRepair, buildRepairContext, recordRepairAttempt } from "./repair";
import { resolvePresentationStyle, styleContext } from "./style";
import { writeP3Metrics } from "./metrics";
import { markPhase, measurementWindow, projectSlug, resolveTranscript, writeTokenReport } from "./tokens";
import { recordRun, writeQualityReport } from "./score";
import { deckPlanDigest, resolveCompositionPlan, validateDeckPlan, verifyDeckAgainstPlan } from "./planning";
import { sha256, sha256File, writeArtifactProvenance, type ArtifactProvenance } from "./provenance";
import { writeArtifactPair } from "./artifacts";
import { compileTemplateGrammar, extractTemplateElements } from "./template-analysis";
import { templateMapSchema } from "./organization";

/**
 * Everything downstream of the plan, and the provenance that describes it. Listed once so an added
 * phase cannot forget to clear its own output.
 */
const DERIVED_ARTIFACTS = ["reference-selection.json", "resolved-style.json", "style-context.json", "template-grammar.json", "composition-plan.json"] as const;
const DERIVED_PROVENANCE = ["referenceSelectionDigest", "referenceSelectionSource", "resolvedStyleDigest", "resolvedStyleSource", "templateGrammarDigest", "compositionPlanDigest"] as const;

/**
 * Root inputs changed, so everything derived from them is obsolete — including artifacts the new
 * contract no longer produces at all (a deck that dropped its references, or its organization pack).
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
  if ((styleSource.templateGrammarDigest ?? undefined) !== (provenance.templateGrammarDigest ?? undefined)) throw new Error("Composition resolution blocked: the resolved style was derived from a different template grammar. Re-run `style --run-dir`.");
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
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.copyFileSync(path.resolve(pptxPath), path.resolve(outPath));
  print({ status: releaseStatus, outputPath: path.resolve(outPath), attempts: repairState.attempts });
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command) {
    throw new Error("Usage: cli.js <fonts|style|theme|reference|template-analyze|plan-validate|composition-resolve|validate|first-page|render|qa|visual|visual-qa|repair-context|repair-apply|metrics|tokens|score|record|release> ...");
  }
  fullOutput = hasFlag(args, "--print");

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
      const contractDigest = assertRunContract(runDir, contractPath);
      fs.writeFileSync(path.join(path.resolve(runDir), "resolved-style.json"), JSON.stringify(style, null, 2));
      fs.writeFileSync(path.join(path.resolve(runDir), "style-context.json"), JSON.stringify(styleContext(style), null, 2));
      // composition-resolve reads the run directory's grammar, so style writes the copy it recorded:
      // a digest describing a file nobody put there would block every run with a v2 pack.
      const grammarRunPath = path.join(path.resolve(runDir), "template-grammar.json");
      if (style.templateGrammar) fs.writeFileSync(grammarRunPath, JSON.stringify(style.templateGrammar, null, 2));
      const referencePath = path.join(path.resolve(runDir), "reference-selection.json");
      const templateGrammarDigest = style.templateGrammar ? sha256File(grammarRunPath) : undefined;
      recordProvenance(runDir, {
        resolvedStyleDigest: sha256File(path.join(path.resolve(runDir), "style-context.json")),
        templateGrammarDigest,
        resolvedStyleSource: {
          contractDigest,
          referenceSelectionDigest: fs.existsSync(referencePath) ? sha256File(referencePath) : undefined,
          templateGrammarDigest,
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
    // The pack's own template-map.json is the only place a human can correct a misread role, so the
    // analyzer reads it: overrides that never reach the classifier are a contract nobody honours.
    const mapPath = optionalOption(args, "--map") ?? path.join(out, "template-map.json");
    const map = fs.existsSync(mapPath) ? templateMapSchema.parse(readJson(mapPath)) : undefined;
    const overrides = map?.version === 2 ? map.elementRoleOverrides : {};
    const elements = await extractTemplateElements(input, overrides);
    const grammar = compileTemplateGrammar(elements);
    fs.mkdirSync(out, { recursive: true });
    const outputPath = path.join(out, "template-elements.json");
    const grammarPath = path.join(out, "template-grammar.json");
    writeArtifactPair([{ path: outputPath, contents: JSON.stringify(elements, null, 2) }, { path: grammarPath, contents: JSON.stringify(grammar, null, 2) }]);
    print({ status: "pass", outputPath, grammarPath, slides: elements.slides.length, roleOverrides: Object.keys(overrides).length });
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
      ["templateGrammarDigest", "template-grammar.json"],
    ]);
    // Style resolution is a prerequisite phase, and the style actually passed here is the one that
    // must match it — checking only the run directory's copy would miss a --style-context pointing
    // somewhere else entirely.
    if (!provenance.resolvedStyleDigest) throw new Error("Composition resolution requires style provenance. Run `style --run-dir` first.");
    if (sha256File(styleContextPath) !== provenance.resolvedStyleDigest) throw new Error("Composition resolution blocked: style-context.json changed after style resolution (artifact-provenance.json digest mismatch). Re-run `style`.");
    assertDerivedFrom(provenance);
    if (provenance.deckPlanDigest !== deckPlanDigest(readJson(planPath))) throw new Error("Composition resolution blocked: deck plan digest is stale.");
    const styleContext = readJson(styleContextPath);
    const grammarPath = path.join(runDir, "template-grammar.json");
    const grammar = fs.existsSync(grammarPath) ? readJson(grammarPath) : {};
    const compositionPlan = resolveCompositionPlan(readJson(planPath), styleContext as never, grammar as never);
    const outputPath = path.join(runDir, "composition-plan.json");
    fs.writeFileSync(outputPath, JSON.stringify(compositionPlan, null, 2));
    recordProvenance(runDir, { compositionPlanDigest: sha256(JSON.stringify(compositionPlan)) });
    emit({ status: "pass", outputPath, slides: compositionPlan.slides.length }, compositionPlan);
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
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const references = loadReferenceSelectionIfExists(path.join(path.resolve(runDir), "reference-selection.json"));
    const style = resolvePresentationStyle(deck.contract, { projectDir, referenceSelection: references, legacyTheme: deck.theme });
    const provenance: ProvenanceFinding[] = verifyRenderProvenance(runDir, pptxPath, deck, style).map(({ code, message, slideId }) => ({ code: code as ProvenanceFinding["code"], message, slideId }));
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
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
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
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const since = optionalOption(args, "--since") ? Date.parse(option(args, "--since")) : undefined;
    const until = optionalOption(args, "--until") ? Date.parse(option(args, "--until")) : undefined;
    const sessionId = optionalOption(args, "--session-id");
    const transcriptPath = optionalOption(args, "--transcript")
      ?? (sessionId ? path.join(os.homedir(), ".claude", "projects", projectSlug(projectDir), `${sessionId}.jsonl`) : undefined)
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
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const { record, historyPath } = recordRun({ deck, runDir, benchmark: option(args, "--benchmark"), version: option(args, "--version"), projectDir });
    emit({ status: "pass", outputPath: historyPath, qualityScore: record.qualityScore, tokens: record.tokens, hardFailures: record.hardFailures }, record);
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
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
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
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const contentModelPath = path.join(path.resolve(runDir), "content-model.json");
    const referenceSelectionPath = path.join(path.resolve(runDir), "reference-selection.json");
    const references = loadReferenceSelectionIfExists(referenceSelectionPath);
    const style = resolvePresentationStyle(deck.contract, { projectDir, referenceSelection: references, legacyTheme: deck.theme });
    const canonicalDeck = { ...deck, theme: { schemaVersion: style.schemaVersion, id: style.themeId, palette: style.palette, data: style.data } };
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
