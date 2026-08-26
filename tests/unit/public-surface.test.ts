import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");

describe("public distribution surface", () => {
  it("does not expose private reference commands", () => {
    const cli = fs.readFileSync(path.join(root, "src/cli.ts"), "utf8");
    expect(cli).not.toContain("company-template");
    expect(cli).not.toContain("library");
  });

  it("records only structured anonymous evaluation outcomes", () => {
    const lines = fs.readFileSync(path.join(root, "evals/history.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ version: expect.any(String), suite: "generic-core", outcome: "pass" });
    }
  });
});
