import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { buildPatternFixture } from "../fixtures/pattern-template";

// RED->GREEN for the exact real-world failure this whole branch exists to fix: a
// source_slide_pattern Organization Pack (GAO's own shape — design lives in the example slide
// bodies, not the master/layout) rendered with the plain `render` + `qa` sequence, never once
// calling `template-analyze`/`pattern-resolve`/`render-pattern-skeleton`. Before this fix,
// TEMPLATE_FIDELITY_UNPROVEN lived entirely inside the `if (renderManifest && ...)` block in the
// `qa` command, so skipping straight to a generic render with an Organization Pack produced a
// clean qa.json — silently reproducing the original root-cause bug
// (artifacts/gao-tech-briefing/template-usage-root-cause.md) even after the whole pattern-clone
// pipeline shipped, because nothing forced a session to actually use it.

const repoRoot = path.resolve(__dirname, "../..");
const deckFixtureContract = JSON.parse(fs.readFileSync(path.join(repoRoot, "tests/fixtures/deck.json"), "utf8")).contract;
const tsxPackage = createRequire(__filename).resolve("tsx/package.json");
const tsxCli = path.join(path.dirname(tsxPackage), JSON.parse(fs.readFileSync(tsxPackage, "utf8")).bin as string);

function cli(args: string[]): string {
  return execFileSync(process.execPath, [tsxCli, path.join(repoRoot, "src/cli.ts"), ...args], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function cliAllowingFailure(args: string[]): string {
  try {
    return execFileSync(process.execPath, [tsxCli, path.join(repoRoot, "src/cli.ts"), ...args], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return (error as { stdout?: string }).stdout ?? "";
  }
}

async function buildOrganizationPack(): Promise<string> {
  const templatePath = await buildPatternFixture();
  const root = path.dirname(templatePath); // buildPatternFixture already gives template.pptx its own dir
  fs.writeFileSync(path.join(root, "brand.yaml"), [
    "name: Fixture Org",
    "palette:",
    '  background: "FFFFFF"',
    '  surface: "FFFFFF"',
    '  text: "111111"',
    '  primary: "123456"',
    '  accent: "654321"',
    '  muted: "666666"',
    '  border: "DDDDDD"',
    "footer:",
    "  showPageNumber: true",
    "  text: Fixture",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "template-map.json"), JSON.stringify({
    version: 1,
    chromeOwnership: { background: "template", logo: "template", footer: "template", pageNumber: "template" },
    defaultLayout: { nativeLayout: "1", canvasColor: "FFFFFF", contentRegion: { x: 0.72, y: 0.48, w: 11.85, h: 6.14 }, reservedRegions: [] },
    layouts: {},
    requiredElements: [],
  }));
  return root;
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

describe("qa: catches an Organization Pack template rendered generically, even when render-pattern-skeleton was never run at all", () => {
  it(
    "fires TEMPLATE_FIDELITY_UNPROVEN for a source_slide_pattern pack skipped straight to render+qa (no render-manifest.json)",
    async () => {
      const orgRoot = await buildOrganizationPack();
      const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-org-fidelity-"));
      try {
        const deck = {
          contract: { ...deckFixtureContract, slideCount: 3, organization: { kind: "directory", path: orgRoot } },
          title: "Org pack fidelity gate fixture",
          slides: [
            deckSlide({ id: "S01", layout: "title", headline: "CLEAN HEADLINE", content: { subtitle: "x" } }),
            filler("S02"),
            filler("S03"),
          ],
        };
        const specPath = path.join(runDir, "deck.json");
        fs.writeFileSync(specPath, JSON.stringify(deck, null, 2));

        // The exact failure sequence: render, then qa — no template-analyze, no pattern-resolve,
        // no render-pattern-skeleton, no render-manifest.json ever written.
        const outputPath = path.join(runDir, "final.pptx");
        cli(["render", "--spec", specPath, "--out", outputPath, "--run-dir", runDir, "--allow-legacy"]);
        expect(fs.existsSync(path.join(runDir, "render-manifest.json"))).toBe(false);

        const report = JSON.parse(cliAllowingFailure(["qa", "--spec", specPath, "--pptx", outputPath, "--run-dir", runDir, "--allow-legacy"]));
        expect(report.findings.some((f: { code: string }) => f.code === "TEMPLATE_FIDELITY_UNPROVEN")).toBe(true);
        expect(report.status).toBe("fail");
      } finally {
        fs.rmSync(runDir, { recursive: true, force: true });
        fs.rmSync(orgRoot, { recursive: true, force: true });
      }
    },
    60000,
  );

  it(
    "does not fire once the pattern-clone pipeline actually ran and produced a render-manifest.json — proven via the real pipeline, not a hand-written manifest",
    async () => {
      const orgRoot = await buildOrganizationPack();
      const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-org-fidelity-green-"));
      try {
        const { extractTemplateElements, compileTemplateGrammar } = await import("../../src/template-analysis");
        const { compileTemplatePatterns } = await import("../../src/template-patterns");
        const { applyPatternSkeleton } = await import("../../src/template");
        const { renderDeck } = await import("../../src/renderer");

        const templatePath = path.join(orgRoot, "template.pptx");
        const elements = await extractTemplateElements(templatePath);
        const grammar = compileTemplateGrammar(elements);
        const artifact = compileTemplatePatterns(elements, grammar);
        fs.mkdirSync(path.join(runDir, "template"), { recursive: true });
        fs.writeFileSync(path.join(runDir, "template", "template-elements.json"), JSON.stringify(elements, null, 2));
        fs.writeFileSync(path.join(runDir, "template", "template-patterns.json"), JSON.stringify(artifact, null, 2));

        const slides = [
          deckSlide({ id: "S01", layout: "title", headline: "CLEAN HEADLINE", content: { subtitle: "x" } }),
          filler("S02"),
          filler("S03"),
        ];
        // Render/clone against a plain contract.template pptx (the proven-working path from
        // raw-pptx-fidelity-gate.test.ts) — the interaction between Organization Pack chrome
        // application (renderDeck's own applyOrganizationTemplate) and the pattern-clone renderer
        // is real production behavior but not what this test is checking. What this test needs is
        // only that `qa`'s new unconditional TEMPLATE_FIDELITY_UNPROVEN check reads the deck.json
        // actually passed to it — which does carry contract.organization — and does not
        // false-positive once a real render-manifest.json exists.
        const renderDeckSpec = { contract: { ...deckFixtureContract, slideCount: 3, template: { kind: "pptx", path: templatePath } }, title: "x", slides };
        const scratchPath = path.join(runDir, "scratch.pptx");
        await renderDeck(renderDeckSpec as never, scratchPath, repoRoot);
        const outputPath = path.join(runDir, "final.pptx");
        // Every slide needs a resolved pattern — strategy here is source_slide_pattern, so any
        // slide left generically-rendered is exactly what TEMPLATE_FIDELITY_UNPROVEN correctly
        // fires on (and should, per the RED test above); this GREEN case is checking the
        // fully-covered pipeline, not a legitimate hybrid partial case.
        const resolvedPatterns = new Map(slides.map((slide, index) => [(slide as { id: string }).id, artifact.patterns[index]] as const));
        const manifest = await applyPatternSkeleton(templatePath, scratchPath, outputPath, slides as never, resolvedPatterns);
        fs.writeFileSync(path.join(runDir, "render-manifest.json"), JSON.stringify(manifest, null, 2));

        const deck = { contract: { ...deckFixtureContract, slideCount: 3, organization: { kind: "directory", path: orgRoot } }, title: "Org pack fidelity gate fixture", slides };
        const specPath = path.join(runDir, "deck.json");
        fs.writeFileSync(specPath, JSON.stringify(deck, null, 2));

        const report = JSON.parse(cliAllowingFailure(["qa", "--spec", specPath, "--pptx", outputPath, "--run-dir", runDir, "--allow-legacy"]));
        expect(report.findings.some((f: { code: string }) => f.code === "TEMPLATE_FIDELITY_UNPROVEN")).toBe(false);
      } finally {
        fs.rmSync(runDir, { recursive: true, force: true });
        fs.rmSync(orgRoot, { recursive: true, force: true });
      }
    },
    60000,
  );
});
