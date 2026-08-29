import { describe, expect, it } from "vitest";
import { writeArtifactPair, type ArtifactIo } from "../../src/artifacts";

/** In-memory filesystem whose rename can be told to fail on a chosen destination. */
function fakeIo(initial: Record<string, string>, failRenameTo?: string): ArtifactIo & { files: Map<string, string>; renames: string[] } {
  const files = new Map(Object.entries(initial));
  const renames: string[] = [];
  return {
    files,
    renames,
    exists: (filePath) => files.has(filePath),
    read: (filePath) => Buffer.from(files.get(filePath) ?? ""),
    write: (filePath, contents) => { files.set(filePath, contents.toString()); },
    rename: (from, to) => {
      if (to === failRenameTo) throw new Error(`rename failed: ${to}`);
      renames.push(to);
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    remove: (filePath) => { files.delete(filePath); },
  };
}

const pair = [{ path: "/out/a.json", contents: "new A" }, { path: "/out/b.json", contents: "new B" }];

describe("writeArtifactPair", () => {
  it("writes the whole set when every rename lands", () => {
    const io = fakeIo({});
    writeArtifactPair(pair, io);
    expect(io.files.get("/out/a.json")).toBe("new A");
    expect(io.files.get("/out/b.json")).toBe("new B");
    expect([...io.files.keys()].some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("restores the previous set when a later rename fails", () => {
    // The exact regression: the first artifact has already landed when the second one throws.
    const io = fakeIo({ "/out/a.json": "old A", "/out/b.json": "old B" }, "/out/b.json");
    expect(() => writeArtifactPair(pair, io)).toThrow(/rename failed/);
    expect(io.renames).toEqual(["/out/a.json"]);
    expect(io.files.get("/out/a.json")).toBe("old A");
    expect(io.files.get("/out/b.json")).toBe("old B");
    expect([...io.files.keys()].some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("leaves nothing behind when a later rename fails and nothing existed before", () => {
    const io = fakeIo({}, "/out/b.json");
    expect(() => writeArtifactPair(pair, io)).toThrow(/rename failed/);
    expect(io.renames).toEqual(["/out/a.json"]);
    expect(io.files.has("/out/a.json")).toBe(false);
    expect(io.files.has("/out/b.json")).toBe(false);
    expect(io.files.size).toBe(0);
  });
});
