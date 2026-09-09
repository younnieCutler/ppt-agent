import fs from "node:fs";
import path from "node:path";
import { buildPilotAuthoringContext, buildPilotDeckEnvelope, buildPilotSpecArtifact, buildSingleSlideAuthoringContext, pilotEnvelopeDigest, pilotSpecDigest, validatePilotSlides } from "./pilot-authoring";
import { buildSlideAuthoringContext, planningContextBytes } from "./planning-context";
import { deckPlanDigest } from "./planning";
import { deckSchema, type DeckSpec } from "./schema";
import { mergeFindings, ooxmlQa, structuralQa, type QaFinding } from "./qa";
import { resolvePresentationStyle, type ResolvedPresentationStyle } from "./style";
import { buildDeckContext, verifyRenderProvenance } from "./visual";
import { visualQa, type ProvenanceFinding } from "./visual-qa";
import { checkTemplateFidelityUnproven, checkTemplateSemanticContentDropped, checkTemplateSlotCapacity, templateFidelityQa, type RenderManifestEntry } from "./template-fidelity";
import { extractTemplateElements } from "./template-analysis";
import { resolveTemplateSourceSpec } from "./template-source";
import { sha256File, writeArtifactProvenance, type ArtifactProvenance } from "./provenance";

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function writeJson(filePath: string, value: unknown): void {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(value, null, 2));
}

function requireFile(filePath: string, message: string): void {
  if (!fs.existsSync(filePath)) throw new Error(message);
}

function projectDirectory(): string {
  return process.env.PPT_AGENT_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function loadProvenance(runDir: string): ArtifactProvenance {
  const filePath = path.join(path.resolve(runDir), "artifact-provenance.json");
  requireFile(filePath, "Pilot workflow requires artifact-provenance.json.");
  return readJson(filePath) as ArtifactProvenance;
}

function recordProvenance(runDir: string, fields: Partial<ArtifactProvenance>): ArtifactProvenance {
  const merged = { ...loadProvenance(runDir), ...fields } as ArtifactProvenance;
  writeArtifactProvenance(runDir, merged);
  return merged;
}

function requirePassing(filePath: string, phase: string): void {
  requireFile(filePath, `${phase} requires ${filePath}.`);
  const report = readJson(filePath) as { status?: string };
  if (report.status !== "pass") throw new Error(`${phase} requires ${path.basename(filePath)} status to be 'pass'.`);
}

function assertPilotRoots(runDir: string, provenance: ArtifactProvenance): void {
  const resolved = path.resolve(runDir);
  const files: Array<[string | undefined, string, string]> = [
    [provenance.pilotSelectionDigest, "pilot-selection.json", "pilot selection"],
    [provenance.pilotContextDigest, "pilot-context.json", "pilot context"],
    [provenance.compositionPlanDigest, "composition-plan.json", "composition plan"],
    [provenance.resolvedStyleDigest, "style-context.json", "style context"],
  ];
  for (const [digest, name, label] of files) {
    if (!digest) throw new Error(`Pilot workflow requires ${label} provenance.`);
    const filePath = path.join(resolved, name);
    requireFile(filePath, `Pilot workflow requires ${filePath}.`);
    if (sha256File(filePath) !== digest) throw new Error(`Pilot workflow blocked: ${name} changed after its producing phase.`);
  }
  const planPath = path.join(resolved, "deck-plan.json");
  requireFile(planPath, `Pilot workflow requires ${planPath}.`);
  if (!provenance.deckPlanDigest || deckPlanDigest(readJson(planPath)) !== provenance.deckPlanDigest) throw new Error("Pilot workflow blocked: deck-plan.json is stale.");
  requirePassing(path.join(resolved, "storyline-plan-qa.json"), "Pilot workflow");
}

function assertPilotSpecFresh(runDir: string, provenance: ArtifactProvenance): { specPath: string; deckPath: string; deck: DeckSpec } {
  const resolved = path.resolve(runDir);
  const specPath = path.join(resolved, "pilot-spec.json");
  const deckPath = path.join(resolved, "pilot-deck.json");
  requireFile(specPath, "Pilot spec is missing. Run `pilot apply`.");
  requireFile(deckPath, "Pilot deck envelope is missing. Run `pilot apply`.");
  if (!provenance.pilotSpecDigest || pilotSpecDigest(readJson(specPath)) !== provenance.pilotSpecDigest) throw new Error("Pilot spec changed after validation.");
  if (!provenance.pilotDeckDigest || pilotEnvelopeDigest(readJson(deckPath)) !== provenance.pilotDeckDigest) throw new Error("Pilot deck envelope changed after validation.");
  if (!provenance.pilotSpecSource || provenance.pilotSpecSource.pilotSelectionDigest !== provenance.pilotSelectionDigest || provenance.pilotSpecSource.deckPlanDigest !== provenance.deckPlanDigest || provenance.pilotSpecSource.compositionPlanDigest !== provenance.compositionPlanDigest) {
    throw new Error("Pilot spec provenance is stale for current selection/plan/composition inputs.");
  }
  return { specPath, deckPath, deck: deckSchema.parse(readJson(deckPath)) };
}

function clearAfterPilotApply(runDir: string): void {
  const resolved = path.resolve(runDir);
  for (const name of ["pilot-core-qa.json", "pilot-judge-context.json", "pilot-visual-qa.json", "pilot-approval.json"]) fs.rmSync(path.join(resolved, name), { force: true });
}

export function pilotAuthoringContext(runDirInput: string): { status: "pass"; outputPath: string; contextBytes: number; slides: string[] } {
  const runDir = path.resolve(runDirInput);
  const provenance = loadProvenance(runDir);
  assertPilotRoots(runDir, provenance);
  const selection = readJson(path.join(runDir, "pilot-selection.json")) as { slideIds: string[] };
  const context = buildPilotAuthoringContext(
    readJson(path.join(runDir, "pilot-context.json")),
    readJson(path.join(runDir, "style-context.json")),
    readJson(path.join(runDir, "composition-plan.json")),
    selection,
  );
  const outputPath = path.join(runDir, "pilot-authoring-context.json");
  writeJson(outputPath, context);
  recordProvenance(runDir, { pilotAuthoringContextDigest: sha256File(outputPath) });
  return { status: "pass", outputPath, contextBytes: Buffer.byteLength(JSON.stringify(context), "utf8"), slides: selection.slideIds };
}

export function pilotApply(runDirInput: string, slidesPath: string): { status: "pass" | "fail"; outputPath: string; deckPath: string; findings: QaFinding[]; renderMode: "generic" | "canonical_template_runtime" } {
  const runDir = path.resolve(runDirInput);
  const provenance = loadProvenance(runDir);
  assertPilotRoots(runDir, provenance);
  const authorContextPath = path.join(runDir, "pilot-authoring-context.json");
  requireFile(authorContextPath, "Pilot apply requires pilot-authoring-context.json. Run `pilot context` first.");
  if (!provenance.pilotAuthoringContextDigest || sha256File(authorContextPath) !== provenance.pilotAuthoringContextDigest) throw new Error("Pilot authoring context is stale.");
  const selection = readJson(path.join(runDir, "pilot-selection.json")) as { slideIds: string[] };
  const validated = validatePilotSlides(readJson(slidesPath), selection, readJson(path.join(runDir, "deck-plan.json")), readJson(path.join(runDir, "composition-plan.json")));
  const qaPath = path.join(runDir, "pilot-authoring-qa.json");
  writeJson(qaPath, validated.qa);
  if (validated.qa.status !== "pass") {
    recordProvenance(runDir, { pilotAuthoringQaDigest: sha256File(qaPath), pilotSpecDigest: undefined, pilotDeckDigest: undefined, pilotSpecSource: undefined, pilotCoreQaDigest: undefined, pilotVisualQaDigest: undefined, pilotApprovalDigest: undefined, pilotApprovalSource: undefined });
    return { status: "fail", outputPath: "", deckPath: "", findings: validated.qa.findings, renderMode: "generic" };
  }

  const spec = buildPilotSpecArtifact(validated.input, {
    selectionDigest: provenance.pilotSelectionDigest!,
    deckPlanDigest: provenance.deckPlanDigest!,
    compositionPlanDigest: provenance.compositionPlanDigest!,
  });
  const plan = readJson(path.join(runDir, "deck-plan.json")) as { title: string };
  const contract = readJson(path.join(runDir, "contract.json"));
  const deck = buildPilotDeckEnvelope(contract, plan.title, spec);
  const outputPath = path.join(runDir, "pilot-spec.json");
  const deckPath = path.join(runDir, "pilot-deck.json");
  writeJson(outputPath, spec);
  writeJson(deckPath, deck);
  clearAfterPilotApply(runDir);
  recordProvenance(runDir, {
    pilotAuthoringQaDigest: sha256File(qaPath),
    pilotSpecDigest: pilotSpecDigest(spec),
    pilotDeckDigest: pilotEnvelopeDigest(deck),
    pilotSpecSource: { pilotSelectionDigest: provenance.pilotSelectionDigest!, deckPlanDigest: provenance.deckPlanDigest!, compositionPlanDigest: provenance.compositionPlanDigest! },
    pilotCoreQaDigest: undefined,
    pilotJudgeContextDigest: undefined,
    pilotVisualQaDigest: undefined,
    pilotApprovalDigest: undefined,
    pilotApprovalSource: undefined,
  });
  const hasTemplate = Boolean((deck.contract as { template?: unknown }).template);
  return { status: "pass", outputPath, deckPath, findings: [], renderMode: hasTemplate ? "canonical_template_runtime" : "generic" };
}

function resolvedStyleForRun(runDir: string, deck: DeckSpec): ResolvedPresentationStyle {
  const resolvedPath = path.join(path.resolve(runDir), "resolved-style.json");
  if (fs.existsSync(resolvedPath)) return readJson(resolvedPath) as ResolvedPresentationStyle;
  const referencePath = path.join(path.resolve(runDir), "reference-selection.json");
  type ResolveStyleOptions = NonNullable<Parameters<typeof resolvePresentationStyle>[1]>;
  const references = fs.existsSync(referencePath) ? readJson(referencePath) as ResolveStyleOptions["referenceSelection"] : undefined;
  return resolvePresentationStyle(deck.contract, { projectDir: projectDirectory(), referenceSelection: references, legacyTheme: deck.theme });
}

async function pilotCoreReport(runDir: string, pptxPath: string, deck: DeckSpec): Promise<ReturnType<typeof structuralQa>> {
  const projectDir = projectDirectory();
  const contentModelPath = path.join(runDir, "content-model.json");
  const referenceSelectionPath = path.join(runDir, "reference-selection.json");
  const style = resolvedStyleForRun(runDir, deck);
  const structural = structuralQa(deck, projectDir, contentModelPath, referenceSelectionPath);
  const renderManifestPath = path.join(runDir, "render-manifest.json");
  const renderManifest = fs.existsSync(renderManifestPath) ? readJson(renderManifestPath) as RenderManifestEntry[] : undefined;
  const patternRenderedSlideIds = new Set((renderManifest ?? []).filter((entry) => entry.mode.startsWith("pattern:")).map((entry) => entry.slideId));
  const grammarPath = path.join(runDir, "template", "template-grammar.json");
  const templateFonts = fs.existsSync(grammarPath) ? ((readJson(grammarPath) as { typography?: { families?: string[] } }).typography?.families ?? []) : [];
  const styleForFonts = templateFonts.length > 0 ? { ...style, templateGrammar: { typography: { families: templateFonts } } } : style;
  let report = mergeFindings(structural, await ooxmlQa(pptxPath, deck, styleForFonts as never, undefined, patternRenderedSlideIds));

  const sourceTemplate = resolveTemplateSourceSpec(deck.contract);
  const sourceTemplatePath = sourceTemplate ? path.resolve(projectDir, sourceTemplate.path) : undefined;
  if (!renderManifest && sourceTemplatePath && fs.existsSync(sourceTemplatePath)) {
    const elementsPath = path.join(runDir, "template", "template-elements.json");
    const strategy = fs.existsSync(elementsPath)
      ? (readJson(elementsPath) as { strategy: import("./template-analysis").TemplateStrategy }).strategy
      : (await extractTemplateElements(sourceTemplatePath)).strategy;
    report = mergeFindings(report, checkTemplateFidelityUnproven(strategy, deck.slides.map((slide) => ({ slideId: slide.id, mode: "renderer" }))));
  }
  if (renderManifest && sourceTemplatePath && fs.existsSync(sourceTemplatePath) && fs.existsSync(pptxPath)) {
    const patternsPath = path.join(runDir, "template", "template-patterns.json");
    const elementsPath = path.join(runDir, "template", "template-elements.json");
    if (fs.existsSync(patternsPath) && fs.existsSync(elementsPath)) {
      const patterns = (readJson(patternsPath) as { patterns: Parameters<typeof templateFidelityQa>[4] }).patterns;
      const strategy = (readJson(elementsPath) as { strategy: Parameters<typeof templateFidelityQa>[5] }).strategy;
      const fidelity = await templateFidelityQa(pptxPath, sourceTemplatePath, deck, renderManifest, patterns, strategy);
      const patternsById = new Map(patterns.map((pattern) => [pattern.id, pattern]));
      const chosen = new Map(
        renderManifest
          .map((entry) => [entry.slideId, patternsById.get(entry.mode.startsWith("pattern:") ? entry.mode.slice(8) : "")] as const)
          .filter((entry): entry is [string, (typeof patterns)[number]] => Boolean(entry[1])),
      );
      report = mergeFindings(report, [...fidelity, ...checkTemplateSlotCapacity(deck, chosen), ...checkTemplateSemanticContentDropped(deck, chosen)]);
    }
  }
  return report;
}

export async function pilotCoreQa(runDirInput: string, pptxPathInput: string): Promise<{ status: string; outputPath: string; findings: QaFinding[] }> {
  const runDir = path.resolve(runDirInput);
  const provenance = loadProvenance(runDir);
  const { deck } = assertPilotSpecFresh(runDir, provenance);
  const pptxPath = path.resolve(pptxPathInput);
  requireFile(pptxPath, `Pilot PPTX not found: ${pptxPath}`);
  const report = await pilotCoreReport(runDir, pptxPath, deck);
  const outputPath = path.join(runDir, "pilot-core-qa.json");
  writeJson(outputPath, report);
  recordProvenance(runDir, { pilotCoreQaDigest: sha256File(outputPath), pilotJudgeContextDigest: undefined, pilotVisualQaDigest: undefined, pilotApprovalDigest: undefined, pilotApprovalSource: undefined });
  return { status: report.status, outputPath, findings: report.findings };
}

function renderProvenanceFindings(runDir: string, pptxPath: string, deck: DeckSpec): ProvenanceFinding[] {
  const findings = verifyRenderProvenance(runDir, pptxPath, deck).map((finding) => ({ slideId: finding.slideId, code: finding.code as ProvenanceFinding["code"], message: finding.message }));
  const backendPath = path.join(runDir, "visual", "backend.json");
  if (fs.existsSync(backendPath)) {
    const backend = readJson(backendPath) as { substitutedFonts?: unknown };
    if (Array.isArray(backend.substitutedFonts) && backend.substitutedFonts.length > 0) {
      findings.push({ slideId: undefined, code: "RENDER_FONT_SUBSTITUTION", message: `Rendered output contains font substitution(s): ${backend.substitutedFonts.join(", ")}.` });
    }
  }
  return findings;
}

export function pilotJudgeContext(runDirInput: string, pptxPathInput: string): { status: "pass"; outputPath: string; contextBytes: number } {
  const runDir = path.resolve(runDirInput);
  const provenance = loadProvenance(runDir);
  const { deck } = assertPilotSpecFresh(runDir, provenance);
  const corePath = path.join(runDir, "pilot-core-qa.json");
  requirePassing(corePath, "Pilot visual judgment");
  if (!provenance.pilotCoreQaDigest || sha256File(corePath) !== provenance.pilotCoreQaDigest) throw new Error("Pilot Core QA is stale.");
  const pptxPath = path.resolve(pptxPathInput);
  const provenanceFindings = renderProvenanceFindings(runDir, pptxPath, deck);
  if (provenanceFindings.length > 0) throw new Error(`Pilot visual judgment requires a fresh clean visual render: ${provenanceFindings.map((finding) => finding.code).join(", ")}.`);
  const style = resolvedStyleForRun(runDir, deck);
  const context = buildDeckContext(deck, deck.slides.map((slide) => slide.id), style);
  const outputPath = path.join(runDir, "pilot-judge-context.json");
  writeJson(outputPath, context);
  recordProvenance(runDir, { pilotJudgeContextDigest: sha256File(outputPath) });
  return { status: "pass", outputPath, contextBytes: Buffer.byteLength(JSON.stringify(context), "utf8") };
}

export function pilotApprove(runDirInput: string, pptxPathInput: string, findingsPath: string): { status: "pass" | "fail"; outputPath: string; visualQaPath: string; findings: QaFinding[] } {
  const runDir = path.resolve(runDirInput);
  const provenance = loadProvenance(runDir);
  const { deck } = assertPilotSpecFresh(runDir, provenance);
  const corePath = path.join(runDir, "pilot-core-qa.json");
  const judgeContextPath = path.join(runDir, "pilot-judge-context.json");
  requirePassing(corePath, "Pilot approval");
  requireFile(judgeContextPath, "Pilot approval requires pilot-judge-context.json.");
  if (!provenance.pilotCoreQaDigest || sha256File(corePath) !== provenance.pilotCoreQaDigest) throw new Error("Pilot Core QA is stale.");
  if (!provenance.pilotJudgeContextDigest || sha256File(judgeContextPath) !== provenance.pilotJudgeContextDigest) throw new Error("Pilot judgment context is stale.");
  const pptxPath = path.resolve(pptxPathInput);
  const style = resolvedStyleForRun(runDir, deck);
  const visual = visualQa(deck, readJson(findingsPath), undefined, style, renderProvenanceFindings(runDir, pptxPath, deck));
  const visualQaPath = path.join(runDir, "pilot-visual-qa.json");
  writeJson(visualQaPath, visual);
  const renderProvenancePath = path.join(runDir, "visual", "render-provenance.json");
  requireFile(renderProvenancePath, "Pilot approval requires visual/render-provenance.json.");
  const approval = {
    version: 1,
    status: visual.status === "pass" ? "pass" as const : "fail" as const,
    pilotSpecDigest: provenance.pilotSpecDigest,
    pilotDeckDigest: provenance.pilotDeckDigest,
    pilotPptxDigest: sha256File(pptxPath),
    coreQaDigest: sha256File(corePath),
    visualQaDigest: sha256File(visualQaPath),
    renderProvenanceDigest: sha256File(renderProvenancePath),
    findings: visual.findings,
  };
  const outputPath = path.join(runDir, "pilot-approval.json");
  writeJson(outputPath, approval);
  recordProvenance(runDir, {
    pilotVisualQaDigest: approval.visualQaDigest,
    pilotApprovalDigest: sha256File(outputPath),
    pilotApprovalSource: {
      pilotSpecDigest: provenance.pilotSpecDigest!,
      pilotDeckDigest: provenance.pilotDeckDigest!,
      pilotCoreQaDigest: approval.coreQaDigest,
      pilotVisualQaDigest: approval.visualQaDigest,
      pilotPptxDigest: approval.pilotPptxDigest,
      renderProvenanceDigest: approval.renderProvenanceDigest,
    },
  });
  return { status: approval.status, outputPath, visualQaPath, findings: visual.findings };
}

function assertPilotApproved(runDir: string, provenance: ArtifactProvenance): void {
  const approvalPath = path.join(runDir, "pilot-approval.json");
  const visualPath = path.join(runDir, "pilot-visual-qa.json");
  const corePath = path.join(runDir, "pilot-core-qa.json");
  requirePassing(approvalPath, "Full-deck authoring");
  if (!provenance.pilotApprovalDigest || sha256File(approvalPath) !== provenance.pilotApprovalDigest || !provenance.pilotApprovalSource) throw new Error("Full-deck authoring blocked: pilot approval provenance is missing or stale.");
  if (provenance.pilotApprovalSource.pilotSpecDigest !== provenance.pilotSpecDigest || provenance.pilotApprovalSource.pilotDeckDigest !== provenance.pilotDeckDigest) throw new Error("Full-deck authoring blocked: approved pilot no longer matches current pilot spec/deck.");
  if (sha256File(corePath) !== provenance.pilotApprovalSource.pilotCoreQaDigest || sha256File(visualPath) !== provenance.pilotApprovalSource.pilotVisualQaDigest) throw new Error("Full-deck authoring blocked: pilot QA changed after approval.");
}

export function fullSlideContext(runDirInput: string, slideId: string, outPath?: string): { status: "pass"; outputPath?: string; context: unknown; contextBytes: number } {
  const runDir = path.resolve(runDirInput);
  const provenance = loadProvenance(runDir);
  assertPilotSpecFresh(runDir, provenance);
  assertPilotApproved(runDir, provenance);
  const selection = readJson(path.join(runDir, "pilot-selection.json")) as { slideIds: string[] };
  if (selection.slideIds.includes(slideId)) throw new Error(`Slide '${slideId}' is already approved in the pilot; reuse pilot-spec.json instead of spending tokens to author it again.`);
  const storyContext = buildSlideAuthoringContext(readJson(path.join(runDir, "storyline.json")), readJson(path.join(runDir, "content-model.json")), slideId);
  const context = buildSingleSlideAuthoringContext(storyContext, readJson(path.join(runDir, "style-context.json")), readJson(path.join(runDir, "composition-plan.json")), slideId);
  if (outPath) writeJson(outPath, context);
  return { status: "pass", outputPath: outPath ? path.resolve(outPath) : undefined, context, contextBytes: planningContextBytes(storyContext) + Buffer.byteLength(JSON.stringify((context as { style?: unknown; composition?: unknown }).style ?? {}), "utf8") + Buffer.byteLength(JSON.stringify((context as { composition?: unknown }).composition ?? []), "utf8") };
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

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command) throw new Error("Usage: pilot-run-cli.js <context|apply|core-qa|judge-context|approve|full-slide-context> ...");
  let result: unknown;
  if (command === "context") result = pilotAuthoringContext(option(args, "--run-dir"));
  else if (command === "apply") result = pilotApply(option(args, "--run-dir"), option(args, "--slides"));
  else if (command === "core-qa") result = await pilotCoreQa(option(args, "--run-dir"), option(args, "--pptx"));
  else if (command === "judge-context") result = pilotJudgeContext(option(args, "--run-dir"), option(args, "--pptx"));
  else if (command === "approve") result = pilotApprove(option(args, "--run-dir"), option(args, "--pptx"), option(args, "--findings"));
  else if (command === "full-slide-context") result = fullSlideContext(option(args, "--run-dir"), option(args, "--slide"), optionalOption(args, "--out"));
  else throw new Error("Usage: pilot-run-cli.js <context|apply|core-qa|judge-context|approve|full-slide-context> ...");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result && typeof result === "object" && "status" in result && (result as { status?: string }).status !== "pass") process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}