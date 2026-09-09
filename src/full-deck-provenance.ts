import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { deckV2Schema } from "./schema";
import { deckPlanDigest } from "./planning";
import { pilotSpecArtifactSchema, pilotSpecDigest } from "./pilot-authoring";
import { fullDeckDigest, fullSlideArtifactDigest } from "./full-deck-assembly";
import { storylineBlueprintDigest } from "./storyline";
import { sha256File, type ArtifactProvenance } from "./provenance";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z.object({
  version: z.literal(1),
  pilotSpecDigest: digestSchema,
  pilotApprovalDigest: digestSchema,
  slides: z.array(z.object({ id: z.string().regex(/^S\d{2,}$/), artifactDigest: digestSchema }).strict()),
}).strict();

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function requireFile(filePath: string, message: string): void {
  if (!fs.existsSync(filePath)) throw new Error(message);
}

function slideArtifactPath(runDir: string, slideId: string): string {
  return path.join(path.resolve(runDir), "full-slides", `slide-${encodeURIComponent(slideId)}.json`);
}

/**
 * Full-deck assembly is optional for backward compatibility. Once a run contains any assembly
 * marker, however, the whole provenance chain becomes mandatory: canonical validate/render/qa
 * must not accept a deck assembled from slide artifacts that changed after approval.
 */
export function assertFullDeckAssemblyProvenance(runDirInput: string, deckInput: unknown): "not_applicable" | "pass" {
  const runDir = path.resolve(runDirInput);
  const provenancePath = path.join(runDir, "artifact-provenance.json");
  const manifestPath = path.join(runDir, "full-slide-manifest.json");
  const assemblyQaPath = path.join(runDir, "full-deck-assembly-qa.json");
  const hasAssemblyMarker = fs.existsSync(manifestPath) || fs.existsSync(assemblyQaPath);

  if (!fs.existsSync(provenancePath)) {
    if (hasAssemblyMarker) throw new Error("Full-deck provenance blocked: assembly artifacts exist but artifact-provenance.json is missing.");
    return "not_applicable";
  }

  const provenance = readJson(provenancePath) as ArtifactProvenance;
  const hasRecordedAssembly = Boolean(provenance.fullDeckDigest || provenance.fullDeckSource || provenance.fullSlideManifestDigest || provenance.fullDeckAssemblyQaDigest);
  if (!hasAssemblyMarker && !hasRecordedAssembly) return "not_applicable";
  if (!provenance.fullDeckDigest || !provenance.fullDeckSource || !provenance.fullSlideManifestDigest || !provenance.fullDeckAssemblyQaDigest) {
    throw new Error("Full-deck provenance blocked: assembly provenance is incomplete. Re-run `npm run full-deck -- assemble`.");
  }

  const deck = deckV2Schema.parse(deckInput);
  if (fullDeckDigest(deck) !== provenance.fullDeckDigest) {
    throw new Error("Full-deck provenance blocked: supplied DeckSpec does not match the assembled fullDeckDigest. Re-run assembly or use the current run-dir/deck.json.");
  }

  const planPath = path.join(runDir, "deck-plan.json");
  const compositionPath = path.join(runDir, "composition-plan.json");
  const storylinePath = path.join(runDir, "storyline.json");
  const pilotSpecPath = path.join(runDir, "pilot-spec.json");
  const pilotApprovalPath = path.join(runDir, "pilot-approval.json");
  for (const [filePath, label] of [
    [planPath, "deck-plan.json"],
    [compositionPath, "composition-plan.json"],
    [storylinePath, "storyline.json"],
    [pilotSpecPath, "pilot-spec.json"],
    [pilotApprovalPath, "pilot-approval.json"],
    [manifestPath, "full-slide-manifest.json"],
    [assemblyQaPath, "full-deck-assembly-qa.json"],
  ] as const) requireFile(filePath, `Full-deck provenance blocked: ${label} is missing.`);

  const current = {
    deckPlanDigest: deckPlanDigest(readJson(planPath)),
    compositionPlanDigest: sha256File(compositionPath),
    storylineDigest: storylineBlueprintDigest(readJson(storylinePath)),
    pilotSpecDigest: pilotSpecDigest(readJson(pilotSpecPath)),
    pilotApprovalDigest: sha256File(pilotApprovalPath),
    fullSlideManifestDigest: sha256File(manifestPath),
    fullDeckAssemblyQaDigest: sha256File(assemblyQaPath),
  };
  const source = provenance.fullDeckSource;

  if (source.deckPlanDigest !== current.deckPlanDigest || source.deckPlanDigest !== provenance.deckPlanDigest) throw new Error("Full-deck provenance blocked: DeckPlan changed after assembly.");
  if (source.compositionPlanDigest !== current.compositionPlanDigest || source.compositionPlanDigest !== provenance.compositionPlanDigest) throw new Error("Full-deck provenance blocked: composition plan changed after assembly.");
  if (source.storylineDigest !== current.storylineDigest || source.storylineDigest !== provenance.storylineDigest) throw new Error("Full-deck provenance blocked: StorylineBlueprint changed after assembly.");
  if (source.pilotSpecDigest !== current.pilotSpecDigest || source.pilotSpecDigest !== provenance.pilotSpecDigest) throw new Error("Full-deck provenance blocked: pilot spec changed after assembly.");
  if (source.pilotApprovalDigest !== current.pilotApprovalDigest || source.pilotApprovalDigest !== provenance.pilotApprovalDigest) throw new Error("Full-deck provenance blocked: pilot approval changed after assembly.");
  if (source.fullSlideManifestDigest !== current.fullSlideManifestDigest || current.fullSlideManifestDigest !== provenance.fullSlideManifestDigest) throw new Error("Full-deck provenance blocked: full-slide manifest changed after assembly.");
  if (current.fullDeckAssemblyQaDigest !== provenance.fullDeckAssemblyQaDigest) throw new Error("Full-deck provenance blocked: full-deck assembly QA changed after assembly.");

  const assemblyQa = readJson(assemblyQaPath) as { status?: string };
  if (assemblyQa.status !== "pass") throw new Error("Full-deck provenance blocked: full-deck-assembly-qa.json must have status 'pass'.");
  const pilotApproval = readJson(pilotApprovalPath) as { status?: string };
  if (pilotApproval.status !== "pass") throw new Error("Full-deck provenance blocked: pilot-approval.json must still have status 'pass'.");

  const pilot = pilotSpecArtifactSchema.parse(readJson(pilotSpecPath));
  const pilotIds = new Set(pilot.slides.map((slide) => slide.id));
  const manifest = manifestSchema.parse(readJson(manifestPath));
  if (manifest.pilotSpecDigest !== current.pilotSpecDigest || manifest.pilotApprovalDigest !== current.pilotApprovalDigest) {
    throw new Error("Full-deck provenance blocked: full-slide manifest points at a different pilot approval chain.");
  }

  const manifestIds = manifest.slides.map((entry) => entry.id);
  if (new Set(manifestIds).size !== manifestIds.length) throw new Error("Full-deck provenance blocked: full-slide manifest contains duplicate slide ids.");
  const expectedNonPilot = deck.slides.map((slide) => slide.id).filter((id) => !pilotIds.has(id));
  if (JSON.stringify(manifestIds) !== JSON.stringify(expectedNonPilot)) {
    throw new Error("Full-deck provenance blocked: full-slide manifest no longer matches the non-pilot slides in DeckSpec order.");
  }

  for (const entry of manifest.slides) {
    const artifactPath = slideArtifactPath(runDir, entry.id);
    requireFile(artifactPath, `Full-deck provenance blocked: validated slide artifact '${entry.id}' is missing.`);
    if (fullSlideArtifactDigest(readJson(artifactPath)) !== entry.artifactDigest) {
      throw new Error(`Full-deck provenance blocked: validated slide artifact '${entry.id}' changed after assembly.`);
    }
  }

  return "pass";
}

/** CLI default used by verifyDeckAgainstPlan without making non-CLI callers invent a run-dir. */
export function runDirFromArgv(argv: string[] = process.argv): string | undefined {
  const index = argv.indexOf("--run-dir");
  return index >= 0 && argv[index + 1] ? argv[index + 1] : undefined;
}
