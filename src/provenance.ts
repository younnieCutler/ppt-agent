import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ArtifactProvenance = {
  contractDigest: string;
  contentModelDigest: string;
  referenceSelectionDigest?: string;
  deckPlanDigest?: string;
  resolvedStyleDigest?: string;
  templateGrammarDigest?: string;
  compositionPlanDigest?: string;
};

// Removed rather than kept as decoration: organizationPackDigest, deckSpecDigest, and pptxDigest were
// declared here but never produced or verified. The pack's identity is already carried by
// templateGrammarDigest, and the rendered PPTX by visual/render-provenance.json.

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
