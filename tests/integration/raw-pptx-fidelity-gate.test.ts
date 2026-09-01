import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { renderDeck } from "../../src/renderer";
import { applyPatternSkeleton } from "../../src/template";
import { buildPatternFixture } from "../fixtures/pattern-template";

// RED->GREEN for the raw-pptx first-class input path specifically: `qa` resolves the
// template it checks leakage against from `contract.template` — proven here through the real `qa` CLI
// command, not just the fidelity-check functions in isolation (see template-fidelity-leak.test.ts).

const repoRoot = path.resolve(__dirname, "../..");
const deckFixtureContract = JSON.parse(fs.readFileSync(path.join(repoRoot, "tests/fixtures/deck.json"), "utf8")).contract;
const tsxPackage = createRequire(__filename).resolve("tsx/package.json");
const tsxCli = path.join(path.dirname(tsxPackage), JSON.parse(fs.readFileSync(tsxPackage, "utf8")).bin as string);

function cli(args: string[]): string {
  return execFileSync(process.execPath, [tsxCli, path.join(repoRoot, "src/cli.ts"), ...args], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// `qa` exits non-zero whenever its own report isn't a clean pass (exactly what both RED and GREEN
// here are), so its JSON has to be read off a rejected execFileSync the same way qa.json itself is
// always written regardless of status.
function cliAllowingFailure(args: string[]): string {
  try {
    return execFileSync(process.execPath, [tsxCli, path.join(repoRoot, "src/cli.ts"), ...args], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return (error as { stdout?: string }).stdout ?? "";
  }
}

function deckSlide(overrides: Record<string, unknown> & { layout: string; id: string; headline: string }): unknown {
  return {
    role: "body", composition: overrides.layout === "title" ? "cover" : "hero_evidence",
    sourceRefs: [{ sourceId: "prompt", excerptId: "R001" }], storyBeat: "opening",
    claims: [{ text: overrides.headline, kind: "interpretation", status: "verified" }],
    ...overrides,
  };
}
function filler(id: string): unknown {
  return deckSlide({ id, layout: "statement", headline: `Filler ${id}`, content: { body: "Filler body.", proofs: [] } });
}

describe("qa: template fidelity gate for the raw-pptx entry point", () => {
  it(
    "fires TEMPLATE_EXAMPLE_CONTENT_LEAK on an unsanitized output and stays clean once sanitized — both reached through `qa`, not called directly",
    async () => {
      const templatePath = await buildPatternFixture();
      const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-raw-pptx-fidelity-"));
      try {
        cli(["template-analyze", "--input", templatePath, "--out", path.join(runDir, "template")]);
        const patterns = JSON.parse(fs.readFileSync(path.join(runDir, "template", "template-patterns.json"), "utf8")).patterns;
        const coverPattern = patterns[0];

        const deck = {
          contract: { ...deckFixtureContract, slideCount: 3, template: { kind: "pptx", path: templatePath } },
          title: "Raw pptx fidelity gate fixture",
          slides: [
            deckSlide({ id: "S01", layout: "title", headline: "CLEAN HEADLINE", content: { subtitle: "x" } }),
            filler("S02"),
            filler("S03"),
          ],
        };
        const specPath = path.join(runDir, "deck.json");
        fs.writeFileSync(specPath, JSON.stringify(deck, null, 2));
        fs.writeFileSync(path.join(runDir, "render-manifest.json"), JSON.stringify([{ slideId: "S01", mode: `pattern:${coverPattern.id}` }], null, 2));

        // RED: the "output" is a byte-identical copy of the template itself — still full of its
        // own example strings.
        const unsanitizedPath = path.join(runDir, "unsanitized.pptx");
        fs.copyFileSync(templatePath, unsanitizedPath);
        const redReport = JSON.parse(cliAllowingFailure(["qa", "--spec", specPath, "--pptx", unsanitizedPath, "--run-dir", runDir, "--allow-legacy"]));
        expect(redReport.findings.some((f: { code: string }) => f.code === "TEMPLATE_EXAMPLE_CONTENT_LEAK")).toBe(true);

        // GREEN: the real skeleton-clone renderer's sanitized output.
        const scratchPath = path.join(runDir, "scratch.pptx");
        await renderDeck(deck as never, scratchPath, repoRoot);
        const sanitizedPath = path.join(runDir, "final.pptx");
        await applyPatternSkeleton(templatePath, scratchPath, sanitizedPath, deck.slides as never, new Map([["S01", coverPattern]]));
        const greenReport = JSON.parse(cliAllowingFailure(["qa", "--spec", specPath, "--pptx", sanitizedPath, "--run-dir", runDir, "--allow-legacy"]));
        expect(greenReport.findings.some((f: { code: string }) => f.code === "TEMPLATE_EXAMPLE_CONTENT_LEAK")).toBe(false);
      } finally {
        fs.rmSync(runDir, { recursive: true, force: true });
        fs.rmSync(path.dirname(templatePath), { recursive: true, force: true });
      }
    },
    60000,
  );
});
