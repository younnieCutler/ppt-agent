import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { buildPatternFixture } from "../fixtures/pattern-template";

// Proves the "raw pptx first-class input" path end to end: a template.pptx with zero
// pre-authored brand.yaml/template-map.json, analyzed straight into a run-scoped directory
// (standing in for <run-dir>/template/ under the hidden workspace from PR A).

const repoRoot = path.resolve(__dirname, "../..");
const tsxPackage = createRequire(__filename).resolve("tsx/package.json");
const tsxCli = path.join(path.dirname(tsxPackage), JSON.parse(fs.readFileSync(tsxPackage, "utf8")).bin as string);

function cli(args: string[]): string {
  return execFileSync(process.execPath, [tsxCli, path.join(repoRoot, "src/cli.ts"), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

describe("template-analyze on a raw .pptx with no organization pack", () => {
  it("analyzes a bare template.pptx into an arbitrary run-scoped directory and reports its detected strategy", async () => {
    const templatePath = await buildPatternFixture();
    const runScopedTemplateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-raw-pptx-run-"));
    try {
      const output = JSON.parse(cli(["template-analyze", "--input", templatePath, "--out", runScopedTemplateDir]));
      expect(output.status).toBe("pass");
      expect(output.slides).toBe(3);
      expect(output.strategy).toBe("source_slide_pattern");
      expect(output.roleOverrides).toBe(0); // no template-map.json existed to supply any
      expect(fs.existsSync(path.join(runScopedTemplateDir, "template-elements.json"))).toBe(true);
      expect(fs.existsSync(path.join(runScopedTemplateDir, "template-grammar.json"))).toBe(true);
      expect(fs.existsSync(path.join(runScopedTemplateDir, "template-design-system.json"))).toBe(true);
      // Nothing was written back next to the user's own template file.
      expect(fs.readdirSync(path.dirname(templatePath))).toEqual(["template.pptx"]);
    } finally {
      fs.rmSync(runScopedTemplateDir, { recursive: true, force: true });
      fs.rmSync(path.dirname(templatePath), { recursive: true, force: true });
    }
  });
});
