import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadReferenceIndex, previewPathsFor, queryFromContract, retrieveReferences } from "../../src/reference";
import { contractSchema } from "../../src/schema";

const root = path.resolve(__dirname, "../fixtures/reference-root");
const contract = contractSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/contract.json"), "utf8")));

describe("reference index", () => {
  it("loads style and layout entries from ppt-master-shaped indices", () => {
    const index = loadReferenceIndex(root);
    expect(index.map((entry) => entry.id).sort()).toEqual([
      "layout:presentation_core",
      "layout:presentation_core_43",
      "style:consulting-decision",
      "style:narrative-keynote",
    ]);
  });

  it("throws a clear error when no index files exist under the root", () => {
    expect(() => loadReferenceIndex(path.resolve(__dirname, "../fixtures"))).toThrow(/reference-root/);
  });

  it("clamps topK to 1..3 and excludes layouts with a mismatched canvas format", () => {
    const index = loadReferenceIndex(root);
    const results = retrieveReferences(index, queryFromContract(contract), 10);
    expect(results.length).toBeLessThanOrEqual(3);
    expect(results.some((entry) => entry.id === "layout:presentation_core_43")).toBe(false);
  });

  it("ranks entries matching visualIntent and purpose keywords above unrelated ones", () => {
    const index = loadReferenceIndex(root);
    const results = retrieveReferences(index, queryFromContract(contract), 2);
    const ids = results.map((entry) => entry.id);
    expect(ids[0]).toBe("layout:presentation_core");
    expect(ids).not.toContain("style:narrative-keynote");
  });

  it("stays within the ~2k token retrieval budget", () => {
    const index = loadReferenceIndex(root);
    const results = retrieveReferences(index, queryFromContract(contract), 3)
      .map((entry) => ({ ...entry, previewPaths: previewPathsFor(root, entry) }));
    expect(JSON.stringify(results).length).toBeLessThan(8000);
  });

  it("returns at most 3 lazily-resolved preview paths for a layout entry, none for a style entry", () => {
    const index = loadReferenceIndex(root);
    const layoutEntry = index.find((entry) => entry.id === "layout:presentation_core")!;
    const styleEntry = index.find((entry) => entry.id === "style:consulting-decision")!;
    const previews = previewPathsFor(root, layoutEntry);
    expect(previews.length).toBe(3);
    expect(previews.every((preview) => preview.endsWith(".svg"))).toBe(true);
    expect(previewPathsFor(root, styleEntry)).toEqual([]);
  });
});
