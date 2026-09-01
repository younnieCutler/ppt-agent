import type { GenerationContract } from "./schema";

/** The raw `.pptx` is the only template source accepted by the runtime. */
export type TemplateSource = { kind: "pptx"; path: string };

/**
 * Returns `undefined` when the contract names no template at all; callers decide what that means.
 */
export function resolveTemplateSourceSpec(contract: Pick<GenerationContract, "template">): TemplateSource | undefined {
  return contract.template;
}
