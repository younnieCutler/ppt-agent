import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ArtifactProvenance = {
  contractDigest: string;
  contentModelDigest: string;
  referenceSelectionDigest?: string;
  deckPlanDigest?: string;
  resolvedStyleDigest?: string;
  compositionPlanDigest?: string;
  templatePatternsDigest?: string;
  patternPlanDigest?: string;
  storylineDigest?: string;
  storylineContextDigest?: string;
  storylinePlanQaDigest?: string;
  pilotSelectionDigest?: string;
  pilotContextDigest?: string;
  pilotAuthoringContextDigest?: string;
  pilotSpecDigest?: string;
  pilotDeckDigest?: string;
  pilotAuthoringQaDigest?: string;
  pilotCoreQaDigest?: string;
  pilotJudgeContextDigest?: string;
  pilotVisualQaDigest?: string;
  pilotApprovalDigest?: string;
  fullSlideManifestDigest?: string;
  fullDeckDigest?: string;
  fullDeckAssemblyQaDigest?: string;
  /**
   * What each derived artifact was derived *from*. File-by-file freshness cannot see a mixed run:
   * every file can match its own digest while a later artifact was produced from older roots.
   * These causal edges are verified before downstream planning/pilot/full-deck work is allowed to proceed.
   */
  referenceSelectionSource?: { contractDigest: string };
  resolvedStyleSource?: { contractDigest: string; referenceSelectionDigest?: string };
  storylineSource?: { contractDigest: string; contentModelDigest: string };
  storylinePlanQaSource?: { storylineDigest: string; deckPlanDigest: string };
  pilotSource?: {
    storylineDigest: string;
    deckPlanDigest: string;
    contentModelDigest: string;
    storylinePlanQaDigest: string;
  };
  pilotSpecSource?: {
    pilotSelectionDigest: string;
    deckPlanDigest: string;
    compositionPlanDigest: string;
  };
  pilotApprovalSource?: {
    pilotSpecDigest: string;
    pilotDeckDigest: string;
    pilotCoreQaDigest: string;
    pilotVisualQaDigest: string;
    pilotPptxDigest: string;
    renderProvenanceDigest: string;
  };
  fullDeckSource?: {
    pilotApprovalDigest: string;
    pilotSpecDigest: string;
    deckPlanDigest: string;
    compositionPlanDigest: string;
    storylineDigest: string;
    fullSlideManifestDigest: string;
  };
};

// Removed rather than kept as decoration: template-pack, deckSpecDigest, and pptxDigest were
// declared here but never produced or verified. The rendered PPTX is carried by visual provenance.

export function sha256(input: Buffer | string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function sha256File(filePath: string): string {
  return sha256(fs.readFileSync(path.resolve(filePath)));
}

export function writeArtifactProvenance(runDir: string, provenance: ArtifactProvenance): string {
  const output = path.join(path.resolve(runDir), "artifact-provenance.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(provenance, null, 2));
  return output;
}
