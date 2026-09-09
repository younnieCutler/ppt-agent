import fs from "node:fs";
import path from "node:path";
import { contentModelSchema, contractSchema, deckPlanSchema } from "./schema";
import { deckPlanDigest } from "./planning";
import { buildSlideAuthoringContext, buildStorylinePlanningContext, planningContextBytes } from "./planning-context";
import { selectPilotSlides } from "./pilot";
import { storylineBlueprintDigest, validateStorylineBlueprint } from "./storyline";
import { verifyDeckPlanAgainstStoryline } from "./storyline-plan";
import { sha256File, writeArtifactProvenance, type ArtifactProvenance } from "./provenance";

export type StorylineValidateOptions = {
  runDir: string;
  storylinePath: string;
  contentModelPath: string;
  findingsPath?: string;
};

export type StorylinePlanValidateOptions = { runDir: string; planPath?: string };
export type PilotSelectOptions = { runDir: string; count?: number };
export type SlideContextOptions = { runDir: string; slideId: string; outPath?: string };

type PlanningProvenance = ArtifactProvenance;

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

function loadProvenance(runDir: string): PlanningProvenance | undefined {
  const filePath = path.join(path.resolve(runDir), "artifact-provenance.json");
  return fs.existsSync(filePath) ? readJson(filePath) as PlanningProvenance : undefined;
}

function recordProvenance(runDir: string, fields: Partial<PlanningProvenance>): PlanningProvenance {
  const existing = loadProvenance(runDir) ?? {} as PlanningProvenance;
  const merged = { ...existing, ...fields } as PlanningProvenance;
  writeArtifactProvenance(runDir, merged);
  return merged;
}

function clearDownstreamPlanning(runDir: string): void {
  for (const name of ["storyline-plan-qa.json", "pilot-selection.json", "pilot-context.json"]) {
    fs.rmSync(path.join(path.resolve(runDir), name), { force: true });
  }
}

function clearPilot(runDir: string): void {
  for (const name of ["pilot-selection.json", "pilot-context.json"]) {
    fs.rmSync(path.join(path.resolve(runDir), name), { force: true });
  }
}

function requirePassingReport(filePath: string, phase: string): void {
  requireFile(filePath, `${phase} requires ${filePath}.`);
  const report = readJson(filePath) as { status?: string };
  if (report.status !== "pass") throw new Error(`${phase} requires ${path.basename(filePath)} status to be 'pass'.`);
}

function assertStorylineFresh(runDir: string, provenance: PlanningProvenance): void {
  const resolved = path.resolve(runDir);
  const contractPath = path.join(resolved, "contract.json");
  const contentModelPath = path.join(resolved, "content-model.json");
  const storylinePath = path.join(resolved, "storyline.json");
  if (!provenance.contractDigest || !provenance.contentModelDigest || !provenance.storylineDigest || !provenance.storylineSource) {
    throw new Error("Storyline provenance is incomplete. Re-run `planning storyline-validate`.");
  }
  requireFile(contractPath, `Missing run contract: ${contractPath}`);
  requireFile(contentModelPath, `Missing run ContentModel: ${contentModelPath}`);
  requireFile(storylinePath, `Missing run StorylineBlueprint: ${storylinePath}`);
  if (sha256File(contractPath) !== provenance.contractDigest) throw new Error("Storyline gate blocked: contract.json changed after storyline validation.");
  if (sha256File(contentModelPath) !== provenance.contentModelDigest) throw new Error("Storyline gate blocked: content-model.json changed after storyline validation.");
  if (storylineBlueprintDigest(readJson(storylinePath)) !== provenance.storylineDigest) throw new Error("Storyline gate blocked: storyline.json changed after storyline validation.");
  if (provenance.storylineSource.contractDigest !== provenance.contractDigest || provenance.storylineSource.contentModelDigest !== provenance.contentModelDigest) {
    throw new Error("Storyline gate blocked: storyline provenance points at different root inputs.");
  }
}

function assertPlanFresh(runDir: string, provenance: PlanningProvenance, planPath: string): void {
  if (!provenance.deckPlanDigest) throw new Error("Planning gate has no deckPlanDigest. Run the canonical `plan-validate` command first.");
  if (deckPlanDigest(readJson(planPath)) !== provenance.deckPlanDigest) throw new Error("Planning gate blocked: deck-plan.json changed after canonical plan validation.");
}

export function storylineValidate(options: StorylineValidateOptions): { status: string; findings: number; contextBytes?: number; outputPath: string } {
  const runDir = path.resolve(options.runDir);
  const contractPath = path.join(runDir, "contract.json");
  requireFile(contractPath, `Missing run contract: ${contractPath}`);
  const contract = contractSchema.parse(readJson(contractPath));
  const contentModel = contentModelSchema.parse(readJson(options.contentModelPath));
  const judgment = options.findingsPath ? readJson(options.findingsPath) : [];
  const report = validateStorylineBlueprint(readJson(options.storylinePath), contract, contentModel, judgment);

  fs.mkdirSync(runDir, { recursive: true });
  const contentModelPath = path.join(runDir, "content-model.json");
  const storylinePath = path.join(runDir, "storyline.json");
  const qaPath = path.join(runDir, "storyline-qa.json");
  const contextPath = path.join(runDir, "storyline-context.json");
  writeJson(contentModelPath, contentModel);
  writeJson(storylinePath, report.storyline);
  writeJson(qaPath, report);
  clearDownstreamPlanning(runDir);

  const contractDigest = sha256File(contractPath);
  const contentModelDigest = sha256File(contentModelPath);
  const storylineDigest = storylineBlueprintDigest(report.storyline);
  const provenanceFields: Partial<PlanningProvenance> = {
    contractDigest,
    contentModelDigest,
    storylineDigest,
    storylineSource: { contractDigest, contentModelDigest },
    storylinePlanQaDigest: undefined,
    storylinePlanQaSource: undefined,
    pilotSelectionDigest: undefined,
    pilotContextDigest: undefined,
    pilotSource: undefined,
  };

  let contextBytes: number | undefined;
  if (report.status === "pass") {
    const context = buildStorylinePlanningContext(report.storyline, contentModel);
    writeJson(contextPath, context);
    contextBytes = planningContextBytes(context);
    provenanceFields.storylineContextDigest = sha256File(contextPath);
  } else {
    fs.rmSync(contextPath, { force: true });
    provenanceFields.storylineContextDigest = undefined;
  }
  recordProvenance(runDir, provenanceFields);
  return { status: report.status, findings: report.findings.length, contextBytes, outputPath: qaPath };
}

export function storylinePlanValidate(options: StorylinePlanValidateOptions): { status: "pass" | "fail"; findings: number; outputPath: string } {
  const runDir = path.resolve(options.runDir);
  const planPath = path.resolve(options.planPath ?? path.join(runDir, "deck-plan.json"));
  const storylinePath = path.join(runDir, "storyline.json");
  requirePassingReport(path.join(runDir, "storyline-qa.json"), "Storyline-plan validation");
  requirePassingReport(path.join(runDir, "planning-qa.json"), "Storyline-plan validation");
  requireFile(planPath, `Missing DeckPlan: ${planPath}`);
  requireFile(storylinePath, `Missing StorylineBlueprint: ${storylinePath}`);
  const provenance = loadProvenance(runDir);
  if (!provenance) throw new Error("Storyline-plan validation requires artifact-provenance.json.");
  assertStorylineFresh(runDir, provenance);
  assertPlanFresh(runDir, provenance, planPath);

  const findings = verifyDeckPlanAgainstStoryline(readJson(planPath), readJson(storylinePath));
  const report = { status: findings.length === 0 ? "pass" as const : "fail" as const, findings };
  const outputPath = path.join(runDir, "storyline-plan-qa.json");
  writeJson(outputPath, report);
  clearPilot(runDir);
  recordProvenance(runDir, {
    storylinePlanQaDigest: sha256File(outputPath),
    storylinePlanQaSource: { storylineDigest: provenance.storylineDigest!, deckPlanDigest: provenance.deckPlanDigest! },
    pilotSelectionDigest: undefined,
    pilotContextDigest: undefined,
    pilotSource: undefined,
  });
  return { status: report.status, findings: findings.length, outputPath };
}

function assertStorylinePlanGate(runDir: string, provenance: PlanningProvenance): void {
  const qaPath = path.join(path.resolve(runDir), "storyline-plan-qa.json");
  requirePassingReport(qaPath, "Pilot selection");
  if (!provenance.storylinePlanQaDigest || !provenance.storylinePlanQaSource) throw new Error("Pilot selection requires storyline-plan provenance.");
  if (sha256File(qaPath) !== provenance.storylinePlanQaDigest) throw new Error("Pilot selection blocked: storyline-plan-qa.json changed after validation.");
  if (provenance.storylinePlanQaSource.storylineDigest !== provenance.storylineDigest || provenance.storylinePlanQaSource.deckPlanDigest !== provenance.deckPlanDigest) {
    throw new Error("Pilot selection blocked: storyline-plan QA was produced from stale inputs.");
  }
}

export function pilotSelect(options: PilotSelectOptions): { status: "pass"; slideIds: string[]; contextByteProxy: { fullDeck: number; pilot: number; reductionPercent: number }; outputPath: string } {
  const runDir = path.resolve(options.runDir);
  const planPath = path.join(runDir, "deck-plan.json");
  const storylinePath = path.join(runDir, "storyline.json");
  const contentModelPath = path.join(runDir, "content-model.json");
  requirePassingReport(path.join(runDir, "planning-qa.json"), "Pilot selection");
  const provenance = loadProvenance(runDir);
  if (!provenance) throw new Error("Pilot selection requires artifact-provenance.json.");
  assertStorylineFresh(runDir, provenance);
  assertPlanFresh(runDir, provenance, planPath);
  assertStorylinePlanGate(runDir, provenance);

  const plan = deckPlanSchema.parse(readJson(planPath));
  const storyline = readJson(storylinePath);
  const contentModel = readJson(contentModelPath);
  const selection = selectPilotSlides(plan, options.count ?? 3);
  const context = buildStorylinePlanningContext(storyline, contentModel, selection.slideIds);
  const fullContext = buildStorylinePlanningContext(storyline, contentModel);
  const fullBytes = planningContextBytes(fullContext);
  const pilotBytes = planningContextBytes(context);
  const reductionPercent = fullBytes === 0 ? 0 : Math.round((1 - pilotBytes / fullBytes) * 10_000) / 100;

  const selectionPath = path.join(runDir, "pilot-selection.json");
  const contextPath = path.join(runDir, "pilot-context.json");
  writeJson(selectionPath, selection);
  writeJson(contextPath, context);
  recordProvenance(runDir, {
    pilotSelectionDigest: sha256File(selectionPath),
    pilotContextDigest: sha256File(contextPath),
    pilotSource: {
      storylineDigest: provenance.storylineDigest!,
      deckPlanDigest: provenance.deckPlanDigest!,
      contentModelDigest: provenance.contentModelDigest,
      storylinePlanQaDigest: provenance.storylinePlanQaDigest!,
    },
  });
  return {
    status: "pass",
    slideIds: selection.slideIds,
    contextByteProxy: { fullDeck: fullBytes, pilot: pilotBytes, reductionPercent },
    outputPath: contextPath,
  };
}

export function slideContext(options: SlideContextOptions): { status: "pass"; context: ReturnType<typeof buildSlideAuthoringContext>; contextBytes: number; outputPath?: string } {
  const runDir = path.resolve(options.runDir);
  const provenance = loadProvenance(runDir);
  if (!provenance) throw new Error("Slide context requires artifact-provenance.json.");
  assertStorylineFresh(runDir, provenance);
  const context = buildSlideAuthoringContext(
    readJson(path.join(runDir, "storyline.json")),
    readJson(path.join(runDir, "content-model.json")),
    options.slideId,
  );
  if (options.outPath) writeJson(options.outPath, context);
  return { status: "pass", context, contextBytes: planningContextBytes(context), outputPath: options.outPath ? path.resolve(options.outPath) : undefined };
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

export function runPlanningCommand(command: string, args: string[]): { exitCode: number; result: unknown } {
  if (command === "storyline-validate") {
    const result = storylineValidate({ runDir: option(args, "--run-dir"), storylinePath: option(args, "--storyline"), contentModelPath: option(args, "--content-model"), findingsPath: optionalOption(args, "--findings") });
    return { exitCode: result.status === "pass" ? 0 : 2, result };
  }
  if (command === "storyline-plan-validate") {
    const result = storylinePlanValidate({ runDir: option(args, "--run-dir"), planPath: optionalOption(args, "--plan") });
    return { exitCode: result.status === "pass" ? 0 : 2, result };
  }
  if (command === "pilot-select") {
    const rawCount = optionalOption(args, "--count");
    const result = pilotSelect({ runDir: option(args, "--run-dir"), count: rawCount ? Number(rawCount) : undefined });
    return { exitCode: 0, result };
  }
  if (command === "slide-context") {
    const result = slideContext({ runDir: option(args, "--run-dir"), slideId: option(args, "--slide"), outPath: optionalOption(args, "--out") });
    return { exitCode: 0, result: result.outputPath ? { status: result.status, contextBytes: result.contextBytes, outputPath: result.outputPath } : result };
  }
  throw new Error("Usage: planning-run-cli.js <storyline-validate|storyline-plan-validate|pilot-select|slide-context> ...");
}

if (require.main === module) {
  try {
    const [, , command, ...args] = process.argv;
    if (!command) throw new Error("Usage: planning-run-cli.js <storyline-validate|storyline-plan-validate|pilot-select|slide-context> ...");
    const { exitCode, result } = runPlanningCommand(command, args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
