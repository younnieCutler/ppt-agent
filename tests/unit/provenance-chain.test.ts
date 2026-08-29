import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256File, writeArtifactProvenance } from "../../src/provenance";

describe("artifact provenance", () => {
  it("is stable for identical bytes and changes after a byte mutation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-provenance-"));
    const file = path.join(dir, "input.json");
    fs.writeFileSync(file, "a");
    const first = sha256File(file);
    expect(sha256File(file)).toBe(first);
    fs.writeFileSync(file, "b");
    expect(sha256File(file)).not.toBe(first);
  });

  it("writes the root inputs and optional derived artifact digests", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-provenance-"));
    const output = writeArtifactProvenance(dir, { contractDigest: "a", contentModelDigest: "b", deckPlanDigest: "c" });
    expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual({ contractDigest: "a", contentModelDigest: "b", deckPlanDigest: "c" });
  });
});
