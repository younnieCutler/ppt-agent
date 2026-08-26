import { describe, expect, it } from "vitest";
import { assertFontsInstalled } from "../../src/fonts";

describe("mandatory font contract", () => {
  it("accepts a confirmed heading/body pair", () => {
    expect(() => assertFontsInstalled({ heading: "Heading", body: "Body" }, [{ family: "Heading", source: "test" }, { family: "Body", source: "test" }])).not.toThrow();
  });

  it("hard-fails instead of silently substituting a missing font", () => {
    expect(() => assertFontsInstalled({ heading: "Missing", body: "Body" }, [{ family: "Body", source: "test" }])).toThrow(/no fallback|not installed/i);
  });
});
