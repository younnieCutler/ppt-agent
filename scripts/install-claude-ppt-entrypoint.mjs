import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const requested = process.argv.indexOf("--skill-dir");
const skillDir = path.resolve(requested >= 0 && process.argv[requested + 1] ? process.argv[requested + 1] : path.join(os.homedir(), ".claude", "skills", "ppt"));
const skillFile = path.join(skillDir, "SKILL.md");
if (!fs.existsSync(skillFile)) {
  throw new Error(`ppt Skill is not installed at ${skillDir}. Install or link this repository there first.`);
}

const packageFile = path.join(skillDir, "package.json");
if (fs.existsSync(packageFile)) {
  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd run build"] : ["run", "build"];
  execFileSync(command, args, { cwd: skillDir, stdio: "inherit" });
}

const commandDir = path.join(os.homedir(), ".claude", "commands");
const commandFile = path.join(commandDir, "ppt.md");
const command = [
  "---",
  "description: Run the local ppt-agent /ppt workflow with its interview and quality gates.",
  "---",
  "",
  "Execute the requested presentation task by reading and following the full workflow in:",
  "",
  "`~/.claude/skills/ppt/SKILL.md`",
  "",
  "This command must use the local `ppt` Skill's DeckSpec validation, font confirmation, render QA, and quality judgment.",
  "",
].join("\n");
fs.mkdirSync(commandDir, { recursive: true });
fs.writeFileSync(commandFile, command, "utf8");
process.stdout.write(`Installed Claude /ppt entrypoint: ${commandFile}\n`);
