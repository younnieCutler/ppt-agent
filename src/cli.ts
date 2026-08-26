import fs from "node:fs";
import path from "node:path";
import { assertFontsInstalled, listInstalledFonts } from "./fonts";
import { resolveTheme } from "./brand";
import { renderDeck } from "./renderer";
import { deckSchema } from "./schema";
import { mergeQa, runPowerPointQa, structuralQa } from "./qa";

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing required option ${name}`);
  return args[index + 1];
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command) throw new Error("Usage: cli.js <fonts|theme|validate|first-page|render|qa|release> ...");

  if (command === "fonts") {
    print(listInstalledFonts());
    return;
  }

  if (command === "theme") {
    const contractPath = option(args, "--contract");
    const contract = require(path.resolve(contractPath));
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    assertFontsInstalled(contract.fonts);
    print(resolveTheme(contract, projectDir));
    return;
  }

  if (command === "release") {
    const qaPath = option(args, "--qa");
    const judgmentPath = option(args, "--judgment");
    const repairStatePath = option(args, "--repair-state");
    const pptxPath = option(args, "--pptx");
    const outPath = option(args, "--out");
    const qa = readJson(qaPath) as { status?: string; attempts?: number };
    const judgment = fs.readFileSync(path.resolve(judgmentPath), "utf8");
    const repairState = readJson(repairStatePath) as { attempts?: unknown };
    if (qa.status !== "pass") throw new Error("Release blocked: qa.json.status must be pass.");
    if (!/Outcome:\s*good\b/i.test(judgment) || !/Release decision:\s*pass\b/i.test(judgment)) {
      throw new Error("Release blocked: judgment.md must declare Outcome: good and Release decision: pass.");
    }
    if (!Number.isInteger(repairState.attempts) || (repairState.attempts as number) < 0 || (repairState.attempts as number) > 2) {
      throw new Error("Release blocked: repair-state.json must record integer attempts from 0 to 2.");
    }
    if (!fs.existsSync(path.resolve(pptxPath))) throw new Error(`Release blocked: PPTX does not exist: ${pptxPath}`);
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.copyFileSync(path.resolve(pptxPath), path.resolve(outPath));
    print({ status: "pass", outputPath: path.resolve(outPath), attempts: repairState.attempts });
    return;
  }

  const specPath = option(args, "--spec");
  const rawDeck = readJson(specPath);
  const deck = deckSchema.parse(rawDeck);

  if (command === "validate") {
    assertFontsInstalled(deck.contract.fonts);
    print({ status: "pass", slides: deck.slides.length, fonts: deck.contract.fonts });
    return;
  }

  if (command === "render") {
    const outPath = option(args, "--out");
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const result = await renderDeck(deck, outPath, projectDir);
    fs.writeFileSync(`${path.resolve(outPath)}.geometry.json`, JSON.stringify(result.slideRects, null, 2));
    print({ status: "pass", outputPath: result.outputPath });
    return;
  }

  if (command === "first-page") {
    const outPath = option(args, "--out");
    const runDir = option(args, "--run-dir");
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const result = await renderDeck(deck, outPath, projectDir, { pageLimit: 1 });
    const canonicalDeck = { ...deck, theme: resolveTheme(deck.contract, projectDir) };
    const contentModelPath = path.join(path.resolve(runDir), "content-model.json");
    const structural = structuralQa(canonicalDeck, projectDir, contentModelPath);
    const powerpoint: Record<string, unknown> = process.platform === "win32"
      ? runPowerPointQa(outPath, canonicalDeck, path.join(path.resolve(runDir), "first-page"), [canonicalDeck.slides[0].id])
      : { status: "skipped", findings: [], reason: "PowerPoint COM QA requires Windows; run this command there to complete release-grade QA." };
    const report = mergeQa(structural, powerpoint);
    fs.mkdirSync(path.resolve(runDir), { recursive: true });
    fs.writeFileSync(path.join(path.resolve(runDir), "first-page-qa.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(`${path.resolve(outPath)}.geometry.json`, JSON.stringify(result.slideRects, null, 2));
    print(report);
    if (report.status !== "pass") process.exitCode = 2;
    return;
  }

  if (command === "qa") {
    const pptxPath = option(args, "--pptx");
    const runDir = option(args, "--run-dir");
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const canonicalDeck = { ...deck, theme: resolveTheme(deck.contract, projectDir) };
    const contentModelPath = path.join(path.resolve(runDir), "content-model.json");
    const structural = structuralQa(canonicalDeck, projectDir, contentModelPath);
    let report = structural;
    let powerpoint: Record<string, unknown> = { status: "skipped", findings: [] };
    if (process.platform === "win32" && fs.existsSync(path.resolve(pptxPath))) {
      powerpoint = runPowerPointQa(pptxPath, canonicalDeck, runDir);
      report = mergeQa(structural, powerpoint);
    } else if (process.platform !== "win32") {
      powerpoint = { status: "skipped", findings: [], reason: "PowerPoint COM QA requires Windows; run this command there to complete release-grade QA." };
    }
    fs.mkdirSync(path.resolve(runDir), { recursive: true });
    fs.writeFileSync(path.join(path.resolve(runDir), "qa.json"), JSON.stringify(report, null, 2));
    print(report);
    if (report.status !== "pass") process.exitCode = 2;
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
