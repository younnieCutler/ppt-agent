import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTranscript, transcriptDirectory } from "../../src/tokens";

const skillPath = path.resolve(__dirname, "../../SKILL.md");
const codexSkillPath = path.resolve(__dirname, "../../codex-skill/SKILL.md");

afterEach(() => {
  delete process.env.PPT_AGENT_TRANSCRIPT_DIR;
});

describe("host-neutral runtime", () => {
  it("takes the transcript directory from the host instead of assuming Claude Code's layout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-host-"));
    const hostDir = path.join(root, "codex-sessions");
    fs.mkdirSync(hostDir, { recursive: true });
    const transcript = path.join(hostDir, "session.jsonl");
    fs.writeFileSync(transcript, "");

    expect(transcriptDirectory("/some/project", path.join(root, "home"))).toContain(path.join(".claude", "projects"));
    process.env.PPT_AGENT_TRANSCRIPT_DIR = hostDir;
    expect(transcriptDirectory("/some/project", path.join(root, "home"))).toBe(hostDir);
    expect(resolveTranscript("/some/project", path.join(root, "home"))).toBe(transcript);
  });

  it("names a host-neutral escape hatch when no transcript directory exists", () => {
    process.env.PPT_AGENT_TRANSCRIPT_DIR = path.join(os.tmpdir(), "ppt-agent-missing-transcripts");
    expect(() => resolveTranscript("/some/project")).toThrow(/PPT_AGENT_TRANSCRIPT_DIR/);
  });

  it("resolves the project directory from a host-neutral variable before the Claude-specific one", () => {
    const cli = fs.readFileSync(path.resolve(__dirname, "../../src/cli.ts"), "utf8");
    expect(cli).toContain("process.env.PPT_AGENT_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd()");
    // One shared resolver, so a new command cannot reintroduce a host-specific default.
    expect(cli.match(/process\.env\.CLAUDE_PROJECT_DIR/g)?.length).toBe(1);
  });
});

describe("host-neutral authoring docs", () => {
  it("keeps the CLI workflow in one canonical skill and points hosts at it", () => {
    const codex = fs.readFileSync(codexSkillPath, "utf8");
    const canonical = fs.readFileSync(skillPath, "utf8");
    // Duplicated command prose is how the two hosts drifted apart; the canonical file owns it.
    expect(codex).not.toMatch(/dist\/cli\.js/);
    expect(codex).toMatch(/SKILL\.md/);
    expect(canonical).toMatch(/dist\/cli\.js/);
  });
});
