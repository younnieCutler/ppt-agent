import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { structuralQa } from "../../src/qa";
import { displayWidth, headlineWrapProblem, kinsokuProblems, wrapByWidth } from "../../src/typography";

const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/all-layouts.json"), "utf8"));
const contentModel = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/content-model-all-layouts.json"), "utf8"));

/** Re-headline the first body slide so a budget/break check can be exercised through the real gate. */
function deckWithHeadline(headline: string, language: string) {
  const target = fixture.slides.find((slide: { layout: string }) => slide.layout === "statement");
  return {
    ...fixture,
    contract: { ...fixture.contract, language },
    slides: fixture.slides.map((slide: { id: string }) =>
      slide.id === target.id ? { ...target, headline, claims: [{ ...target.claims[0], text: headline }, ...target.claims.slice(1)] } : slide,
    ),
  };
}

const codesFor = (deck: unknown, code: string) =>
  structuralQa(deck as never, process.cwd(), contentModel).findings.filter((finding) => finding.code === code);

describe("display width", () => {
  it("counts East Asian glyphs as two columns and everything else as one", () => {
    expect(displayWidth("あア漢")).toBe(6);
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("AI導入")).toBe(6);
    expect(displayWidth("")).toBe(0);
  });

  it("wraps on rendered width, so a Japanese line holds half as many characters as a Latin one", () => {
    expect(wrapByWidth("あいうえおかきくけこ", 10).map((line) => line.text)).toEqual(["あいうえお", "かきくけこ"]);
    expect(wrapByWidth("abcdefghij", 10).map((line) => line.text)).toEqual(["abcdefghij"]);
  });
});

describe("text budgets measure columns, not codepoints", () => {
  it("flags a 40-character Japanese headline that a codepoint budget of 64 would have passed", () => {
    const headline = "生成".repeat(20); // 40 codepoints, 80 display columns
    expect(headline.length).toBeLessThan(64);
    const findings = codesFor(deckWithHeadline(headline, "ja-JP"), "TEXT_WRAP_RISK");
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("80 display columns");
  });

  it("leaves a short Japanese headline alone", () => {
    expect(codesFor(deckWithHeadline("生成AIの導入は加速する", "ja-JP"), "TEXT_WRAP_RISK")).toHaveLength(0);
  });
});

describe("kinsoku shori", () => {
  it("detects punctuation orphaned onto the start of a line", () => {
    // A 10-column budget puts the 6th glyph — the comma — at the head of line two.
    const problems = kinsokuProblems("あいうえお、かきくけこ", 10);
    expect(problems.map((problem) => problem.issue)).toContain("JAPANESE_ORPHAN_PUNCTUATION");
    expect(problems[0].detail).toContain("begins with '、'");
  });

  it("detects an opening bracket stranded at the end of a line", () => {
    const problems = kinsokuProblems("あいうえ「かきくけこ", 10);
    expect(problems.map((problem) => problem.issue)).toContain("JAPANESE_ORPHAN_PUNCTUATION");
  });

  it("detects a katakana word split across the break", () => {
    // "あいうえ" fills 8 columns and "ガ" the last 2, so the break falls inside ガバナンス.
    const problems = kinsokuProblems("あいうえガバナンス", 10);
    expect(problems.map((problem) => problem.issue)).toContain("JAPANESE_AWKWARD_LINE_BREAK");
  });

  it("detects a latin token split across the break", () => {
    const problems = kinsokuProblems("あいうえabcdefgh", 10);
    expect(problems.map((problem) => problem.issue)).toContain("JAPANESE_AWKWARD_LINE_BREAK");
  });

  it("stays silent on text that breaks cleanly", () => {
    expect(kinsokuProblems("あいうえおかきくけこ", 10)).toHaveLength(0);
  });

  it("only runs for Japanese decks", () => {
    // 32 wide glyphs exactly fill the 64-column headline budget, orphaning the comma onto line two.
    const badBreak = `${"あ".repeat(32)}、導入`;
    expect(codesFor(deckWithHeadline(badBreak, "ja-JP"), "JAPANESE_ORPHAN_PUNCTUATION").length).toBeGreaterThan(0);
    expect(codesFor(deckWithHeadline(badBreak, "en-US"), "JAPANESE_ORPHAN_PUNCTUATION")).toHaveLength(0);
    expect(codesFor(deckWithHeadline(badBreak, "en-US"), "JAPANESE_AWKWARD_LINE_BREAK")).toHaveLength(0);
  });
});

describe("headline wrap quality", () => {
  it("flags a fragment pushed onto its own line", () => {
    // 66 columns at a 64 budget leaves a 2-column tail alone on line two.
    const problem = headlineWrapProblem(`${"a".repeat(64)}あ`, 64);
    expect(problem?.issue).toBe("HEADLINE_BAD_WRAP");
    expect(problem?.detail).toContain("onto its own line");
  });

  it("flags a headline that runs to three lines", () => {
    const problem = headlineWrapProblem("a".repeat(140), 64);
    expect(problem?.detail).toContain("wraps to 3 lines");
  });

  it("accepts a headline that fits, and one that breaks into two balanced lines", () => {
    expect(headlineWrapProblem("A short headline", 64)).toBeUndefined();
    expect(headlineWrapProblem("a".repeat(100), 64)).toBeUndefined();
  });

  it("applies in every language, unlike the kinsoku checks", () => {
    const fragmenting = `${"a".repeat(64)}xy`;
    expect(codesFor(deckWithHeadline(fragmenting, "en-US"), "HEADLINE_BAD_WRAP").length).toBeGreaterThan(0);
  });
});
