import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const tsxPackage = createRequire(__filename).resolve("tsx/package.json");
const tsxCli = path.join(path.dirname(tsxPackage), JSON.parse(fs.readFileSync(tsxPackage, "utf8")).bin as string);

function cli(args: string[]): string {
  return execFileSync(process.execPath, [tsxCli, path.join(repoRoot, "src/cli.ts"), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

describe("workspace-open CLI", () => {
  it("creates a hidden run workspace under --project-dir/.ppt-agent/runs/ and prints its path", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-workspace-cli-"));
    try {
      const output = JSON.parse(cli(["workspace-open", "--name", "gao-it-weekly", "--project-dir", projectDir]));
      expect(output.status).toBe("pass");
      expect(output.runDir.startsWith(path.join(projectDir, ".ppt-agent", "runs"))).toBe(true);
      expect(fs.existsSync(output.runDir)).toBe(true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
