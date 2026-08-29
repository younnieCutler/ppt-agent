import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ArtifactProvenance = {
  contractDigest: string;
  contentModelDigest: string;
  referenceSelectionDigest?: string;
  organizationPackDigest?: string;
  deckPlanDigest?: string;
  resolvedStyleDigest?: string;
  templateGrammarDigest?: string;
  compositionPlanDigest?: string;
  deckSpecDigest?: string;
  pptxDigest?: string;
};

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
