import type { GenerationContract } from "./schema";

/**
 * A raw `.pptx` (the ChatGPT-shaped first-class input — nothing pre-authored) or a pre-built
 * Organization Pack (the advanced/reusable mode: brand.yaml + template-map.json). Two fields on the
 * contract can express this — `contract.template` (new) and `contract.organization` (existing) — so
 * every caller normalizes through this one function rather than re-deriving the precedence rule.
 */
export type TemplateSource = { kind: "pptx"; path: string } | { kind: "organization"; path: string };

/**
 * `contract.template` wins when present; `contract.organization: {kind:"directory"}` is read as
 * sugar for `template: {kind:"organization", path}` otherwise, so every existing contract using
 * only `organization` keeps resolving exactly as it did before this field existed. Returns
 * `undefined` when the contract names no template at all (the plain, no-organization renderer
 * path) — callers decide what that means, this function only normalizes the two input shapes.
 */
export function resolveTemplateSourceSpec(contract: Pick<GenerationContract, "template" | "organization">): TemplateSource | undefined {
  if (contract.template) return contract.template;
  if (contract.organization?.kind === "directory") return { kind: "organization", path: contract.organization.path };
  return undefined;
}
