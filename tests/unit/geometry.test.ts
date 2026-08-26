import { describe, expect, it } from "vitest";
import { validateGeometry } from "../../src/geometry";

describe("geometry QA", () => {
  it("detects an off-canvas rectangle", () => {
    const issues = validateGeometry([{ id: "bad", x: 12.8, y: 1, w: 1, h: 1 }]);
    expect(issues.map((issue) => issue.code)).toContain("OFF_CANVAS");
  });

  it("allows intentional background overlap", () => {
    const issues = validateGeometry([
      { id: "background", x: 1, y: 1, w: 4, h: 3, allowOverlap: true },
      { id: "text", x: 1.2, y: 1.2, w: 2, h: 0.4 },
    ]);
    expect(issues).toHaveLength(0);
  });

  it("detects unintended collision", () => {
    const issues = validateGeometry([
      { id: "one", x: 1, y: 1, w: 2, h: 2 },
      { id: "two", x: 2, y: 1.5, w: 2, h: 2 },
    ]);
    expect(issues.map((issue) => issue.code)).toContain("COLLISION");
  });
});
