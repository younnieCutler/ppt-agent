import fs from "node:fs";
import path from "node:path";
import {
  assembleFullDeck,
  buildFullSlideArtifact,
  fullDeckDigest,
  fullSlideArtifactDigest,
  validateFullSlideInput,
  type FullSlideArtifact,
} from "./full-deck-assembly";
import { deckPlanDigest } from "./planning";
import { pilotEnvelopeDigest, pilotSpecArtifactSchema, pilotSpecDigest } from "./pilot-authoring";
import { storylineBlueprintDigest } from "./storyline";
import { sha256File, writeArtifactProvenance, type ArtifactProvenance } from "./provenance";

type FullDeckProvenance = ArtifactProvenance & {
  fullSlideManifestDigest?: string;
  fullDeckDigest?: string;
  fullDeckAssemblyQaDigest?: string;
  fullDeckSource?: {
    pilotApprovalDigest: string;
    pilotSpecDigest: string;
    deckPlanDigest: string;
    compositionPlanDigest: string;
    storylineDigest: string;
    fullSlideManifestDigest: string;
  };
};

type SlideManifest = {
  version: 1;
  pilotSpecDigest: string;
  pilotApprovalDigest: string;
  slides: Array<{ id: string; artifactDigest: string }>;
};

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

function requirePassing(filePath: string, phase: string): void {
  requireFile(filePath, `${phase} requires ${filePath}.`);
  const report = readJson(filePath) as { status?: string };
  if (report.status !== "pass") throw new Error(`${phase} requires ${path.basename(filePath)} status to be 'pass'.`);
}

function loadProvenance(runDir: string): FullDeckProvenance {
  const filePath = path.join(path.resolve(runDir), "artifact-provenance.json");
  requireFile(filePath, "Full-deck workflow requires artifact-provenance.json.");
  return readJson(filePath) as FullDeckProvenance;
}

function recordProvenance(runDir: string, fields: Partial<FullDeckProvenance>): FullDeckProvenance {
  const merged = { ...loadProvenance(runDir), ...fields } as FullDeckProvenance;
  writeArtifactProvenance(runDir, merged);
  return merged;
}

function artifactPath(runDir: string, slideId: string): string {
  return path.join(path.resolve(runDir), "full-slides", `slide-${encodeURIComponent(slideId)}.json`);
}

function artifactQaPath(runDir: string, slideId: string): string {
  return path.join(path.resolve(runDir), "full-slides", `slide-${encodeURIComponent(slideId)}.qa.json`);
}

function assertFullAuthoringGate(runDir: string, provenance: FullDeckProvenance): { pilotSlideIds: string[] } {
  const resolved = path.resolve(runDir);
  const planPath = path.join(resolved, "deck-plan.json");
  const compositionPath = path.join(resolved, "composition-plan.json");
  const storylinePath = path.join(resolved, "storyline.json");
  const pilotSpecPath = path.join(resolved, "pilot-spec.json");
  const pilotDeckPath = path.join(resolved, "pilot-deck.json");
  const approvalPath = path.join(resolved, "pilot-approval.json");
  const coreQaPath = path.join(resolved, "pilot-core-qa.json");
  const visualQaPath = path.join(resolved, "pilot-visual-qa.json");

  for (const [filePath, label] of [
    [planPath, "DeckPlan"],
    [compositionPath, "composition plan"],
    [storylinePath, "StorylineBlueprint"],
    [pilotSpecPath, "pilot spec"],
    [pilotDeckPath, "pilot deck"],
    [approvalPath, "pilot approval"],
    [coreQaPath, "pilot Core QA"],
    [visualQaPath, "pilot Visual QA"],
  ] as const) requireFile(filePath, `Full-deck workflow requires current ${label}: ${filePath}`);
  requirePassing(approvalPath, "Full-deck workflow");

  if (!provenance.deckPlanDigest || deckPlanDigest(readJson(planPath)) !== provenance.deckPlanDigest) throw new Error("Full-deck workflow blocked: deck-plan.json is stale.");
  if (!provenance.compositionPlanDigest || sha256File(compositionPath) !== provenance.compositionPlanDigest) throw new Error("Full-deck workflow blocked: composition-plan.json is stale.");
  if (!provenance.storylineDigest || storylineBlueprintDigest(readJson(storylinePath)) !== provenance.storylineDigest) throw new Error("Full-deck workflow blocked: storyline.json is stale.");
  if (!provenance.pilotSpecDigest || pilotSpecDigest(readJson(pilotSpecPath)) !== provenance.pilotSpecDigest) throw new Error("Full-deck workflow blocked: pilot-spec.json is stale.");
  if (!provenance.pilotDeckDigest || pilotEnvelopeDigest(readJson(pilotDeckPath)) !== provenance.pilotDeckDigest) throw new Error("Full-deck workflow blocked: pilot-deck.json is stale.");
  if (!provenance.pilotApprovalDigest || sha256File(approvalPath) !== provenance.pilotApprovalDigest || !provenance.pilotApprovalSource) throw new Error("Full-deck workflow blocked: pilot approval provenance is missing or stale.");
  if (provenance.pilotApprovalSource.pilotSpecDigest !== provenance.pilotSpecDigest || provenance.pilotApprovalSource.pilotDeckDigest !== provenance.pilotDeckDigest) throw new Error("Full-deck workflow blocked: pilot approval points at different pilot artifacts.");
  if (sha256File(coreQaPath) !== provenance.pilotApprovalSource.pilotCoreQaDigest || sha256File(visualQaPath) !== provenance.pilotApprovalSource.pilotVisualQaDigest) throw new Error("Full-deck workflow blocked: pilot QA changed after approval.");

  const pilot = pilotSpecArtifactSchema.parse(readJson(pilotSpecPath));
  return { pilotSlideIds: pilot.slides.map((slide) => slide.id) };
}

function rebuildManifest(runDir: string, provenance: FullDeckProvenance): { manifest: SlideManifest; outputPath: string } {
  const plan = readJson(path.join(runDir, "deck-plan.json")) as { slides: Array<{ id: string }> };
  const pilot = pilotSpecArtifactSchema.parse(readJson(path.join(runDir, "pilot-spec.json")));
  const pilotIds = new Set(pilot.slides.map((slide) => slide.id));
  const slides: SlideManifest["slides"] = [];
  for (const planned of plan.slides) {
    if (pilotIds.has(planned.id)) continue;
    const filePath = artifactPath(runDir, planned.id);
    if (!fs.existsSync(filePath)) continue;
    slides.push({ id: planned.id, artifactDigest: fullSlideArtifactDigest(readJson(filePath)) });
  }
  const manifest: SlideManifest = {
    version: 1,
    pilotSpecDigest: provenance.pilotSpecDigest!,
    pilotApprovalDigest: provenance.pilotApprovalDigest!,
    slides,
  };
  const outputPath = path.join(path.resolve(runDir), "full-slide-manifest.json");
  writeJson(outputPath, manifest);
  return { manifest, outputPath };
}

export function fullSlideApply(runDirInput: string, slideId: string, inputPath: string): { status: "pass" | "fail"; outputPath?: string; qaPath: string; findings: unknown[] } {
  const runDir = path.resolve(runDirInput);
  const provenance = loadProvenance(runDir);
  const gate = assertFullAuthoringGate(runDir, provenance);
  const validated = validateFullSlideInput(
    readJson(inputPath),
    slideId,
    gate.pilotSlideIds,
    readJson(path.join(runDir, "deck-plan.json")),
    readJson(path.join(runDir, "composition-plan.json")),
  );
  const qaPath = artifactQaPath(runDir, slideId);
  const qa = { status: validated.findings.length === 0 ? "pass" as const : "fail" as const, findings: validated.findings };
  writeJson(qaPath, qa);
  if (qa.status !== "pass") return { status: "fail", qaPath, findings: qa.findings };

  const artifact = buildFullSlideArtifact(validated.input, {
    deckPlanDigest: provenance.deckPlanDigest!,
    compositionPlanDigest: provenance.compositionPlanDigest!,
    storylineDigest: provenance.storylineDigest!,
    pilotApprovalDigest: provenance.pilotApprovalDigest!,
  });
  const outputPath = artifactPath(runDir, slideId);
  writeJson(outputPath, artifact);
  const { outputPath: manifestPath } = rebuildManifest(runDir, provenance);
  fs.rmSync(path.join(runDir, "deck.json"), { force: true });
  fs.rmSync(path.join(runDir, "full-deck-assembly-qa.json"), { force: true });
  recordProvenance(runDir, {
    fullSlideManifestDigest: sha256File(manifestPath),
    fullDeckDigest: undefined,
    fullDeckAssemblyQaDigest: undefined,
    fullDeckSource: undefined,
  });
  return { status: "pass", outputPath, qaPath, findings: [] };
}

export function fullDeckAssemble(runDirInput: string): { status: "pass" | "fail"; outputPath?: string; qaPath: string; findings: unknown[]; pilotSlidesReused: string[]; authoredSlides: string[] } {
  const runDir = path.resolve(runDirInput);
  const provenance = loadProvenance(runDir);
  assertFullAuthoringGate(runDir, provenance);
  const plan = readJson(path.join(runDir, "deck-plan.json")) as { slides: Array<{ id: string }> };
  const pilot = pilotSpecArtifactSchema.parse(readJson(path.join(runDir, "pilot-spec.json")));
  const pilotIds = new Set(pilot.slides.map((slide) => slide.id));
  const artifacts: FullSlideArtifact[] = [];
  for (const planned of plan.slides) {
    if (pilotIds.has(planned.id)) continue;
    const filePath = artifactPath(runDir, planned.id);
    if (fs.existsSync(filePath)) artifacts.push(readJson(filePath) as FullSlideArtifact);
  }

  const result = assembleFullDeck(
    readJson(path.join(runDir, "contract.json")),
    readJson(path.join(runDir, "deck-plan.json")),
    readJson(path.join(runDir, "composition-plan.json")),
    pilot,
    artifacts,
    {
      deckPlanDigest: provenance.deckPlanDigest!,
      compositionPlanDigest: provenance.compositionPlanDigest!,
      storylineDigest: provenance.storylineDigest!,
      pilotApprovalDigest: provenance.pilotApprovalDigest!,
    },
  );
  const qaPath = path.join(runDir, "full-deck-assembly-qa.json");
  const qa = {
    status: result.status,
    findings: result.findings,
    pilotSlidesReused: result.pilotSlidesReused,
    authoredSlides: result.authoredSlides,
    tokenPolicy: { pilotReauthorCount: 0, assemblyModelCalls: 0 },
  };
  writeJson(qaPath, qa);
  if (result.status !== "pass" || !result.deck) {
    fs.rmSync(path.join(runDir, "deck.json"), { force: true });
    recordProvenance(runDir, { fullDeckDigest: undefined, fullDeckAssemblyQaDigest: sha256File(qaPath), fullDeckSource: undefined });
    return { status: "fail", qaPath, findings: result.findings, pilotSlidesReused: result.pilotSlidesReused, authoredSlides: result.authoredSlides };
  }

  const outputPath = path.join(runDir, "deck.json");
  writeJson(outputPath, result.deck);
  const { outputPath: manifestPath } = rebuildManifest(runDir, provenance);
  const manifestDigest = sha256File(manifestPath);
  recordProvenance(runDir, {
    fullSlideManifestDigest: manifestDigest,
    fullDeckDigest: fullDeckDigest(result.deck),
    fullDeckAssemblyQaDigest: sha256File(qaPath),
    fullDeckSource: {
      pilotApprovalDigest: provenance.pilotApprovalDigest!,
      pilotSpecDigest: provenance.pilotSpecDigest!,
      deckPlanDigest: provenance.deckPlanDigest!,
      compositionPlanDigest: provenance.compositionPlanDigest!,
      storylineDigest: provenance.storylineDigest!,
      fullSlideManifestDigest: manifestDigest,
    },
  });
  return { status: "pass", outputPath, qaPath, findings: [], pilotSlidesReused: result.pilotSlidesReused, authoredSlides: result.authoredSlides };
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing required option ${name}`);
  return args[index + 1];
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  let result: ReturnType<typeof fullSlideApply> | ReturnType<typeof fullDeckAssemble>;
  if (command === "slide-apply") result = fullSlideApply(option(args, "--run-dir"), option(args, "--slide"), option(args, "--input"));
  else if (command === "assemble") result = fullDeckAssemble(option(args, "--run-dir"));
  else throw new Error("Usage: full-deck-run-cli.js <slide-apply|assemble> ...");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "pass") process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
