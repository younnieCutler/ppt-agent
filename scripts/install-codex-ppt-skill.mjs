import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(repoRoot, "codex-skill");
const targetPath = path.join(os.homedir(), ".codex", "skills", "ppt-agent");

if (!fs.existsSync(path.join(sourcePath, "SKILL.md"))) {
  throw new Error(`Codex skill source is missing: ${sourcePath}`);
}

const npmCommand = process.platform === "win32" ? "cmd.exe" : "npm";
const npmArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd run build"] : ["run", "build"];
execFileSync(npmCommand, npmArgs, { cwd: repoRoot, stdio: "inherit" });
fs.mkdirSync(path.dirname(targetPath), { recursive: true });

if (fs.existsSync(targetPath)) {
  const resolved = fs.realpathSync(targetPath);
  if (path.resolve(resolved) !== path.resolve(sourcePath)) {
    throw new Error(`Refusing to overwrite an existing Codex skill: ${targetPath}`);
  }
  process.stdout.write(`Codex skill already points to ${sourcePath}\n`);
  process.exit(0);
}

fs.symlinkSync(sourcePath, targetPath, process.platform === "win32" ? "junction" : "dir");
process.stdout.write(`Installed Codex skill: ${targetPath}\n`);
