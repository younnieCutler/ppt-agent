// Width-aware text measurement and line-break simulation.
//
// The text budgets in qa.ts used to count codepoints, which under-measures CJK by roughly half:
// a 40-character Japanese headline occupies the same rendered width as an 80-character Latin one
// but passed a 64-"character" budget cleanly. Everything here works in *display columns* instead.
//
// The wrap simulation is a heuristic over that column budget, not a real font metric — it cannot
// know the actual glyph advances of the chosen typeface. Findings derived from it are therefore
// always `risk`, never `hard`; live measurement stays with the PowerPoint COM Level 3 check.

/** Unicode East Asian Wide / Fullwidth blocks. Anything outside these advances one column. */
const wideRanges: Array<[number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2e80, 0x303e], // CJK Radicals, Kangxi, CJK Symbols and Punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul Compatibility Jamo, CJK Compatibility
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // Vertical forms
  [0xfe30, 0xfe6f], // CJK Compatibility Forms, Small Form Variants
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1f64f], // Emoji
  [0x20000, 0x2fffd], // CJK Extension B and beyond
  [0x30000, 0x3fffd],
];

export function charWidth(codePoint: number): 1 | 2 {
  return wideRanges.some(([low, high]) => codePoint >= low && codePoint <= high) ? 2 : 1;
}

/** Rendered width of `text` in display columns: 2 per East Asian wide glyph, 1 otherwise. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) width += charWidth(character.codePointAt(0)!);
  return width;
}

// 行頭禁則: may not begin a line. Closing brackets, trailing punctuation, sound marks, and the
// small kana, which are all bound to the glyph preceding them.
const noLineStart = new Set([
  ..."、。，．・：；？！゛゜ゝゞーヽヾ々",
  ..."」』）］｝〉》〕〙〗｣”’",
  ..."ぁぃぅぇぉっゃゅょゎゕゖ",
  ..."ァィゥェォッャュョヮヵヶ",
  ...",.:;?!)]}>",
]);

// 行末禁則: may not end a line. Opening brackets pull their content onto the next line with them.
const noLineEnd = new Set([..."「『（［｛〈《〔〘〖｢“‘", ..."([{<"]);

const isKatakana = (character: string): boolean => /[ァ-ヺー]/.test(character);
const isLatinOrDigit = (character: string): boolean => /[A-Za-z0-9]/.test(character);

export type WrappedLine = { text: string; width: number };

/**
 * Greedy fixed-column wrap. Deliberately naive — it breaks wherever the column budget runs out,
 * exactly as a renderer with no kinsoku support does. The point is to reproduce the bad break so
 * it can be reported, not to produce a good one.
 */
export function wrapByWidth(text: string, budget: number): WrappedLine[] {
  if (budget < 2) return [{ text, width: displayWidth(text) }];
  const lines: WrappedLine[] = [];
  let current = "";
  let width = 0;
  for (const character of text) {
    const advance = charWidth(character.codePointAt(0)!);
    if (width + advance > budget && current !== "") {
      lines.push({ text: current, width });
      current = "";
      width = 0;
    }
    current += character;
    width += advance;
  }
  if (current !== "") lines.push({ text: current, width });
  return lines;
}

export type BreakIssue =
  | "JAPANESE_ORPHAN_PUNCTUATION"
  | "JAPANESE_AWKWARD_LINE_BREAK"
  | "HEADLINE_BAD_WRAP";

export type BreakProblem = { issue: BreakIssue; detail: string };

/**
 * Kinsoku violations in the greedy wrap of `text` at `budget` columns. Japanese-specific, so
 * callers gate this on the contract language.
 */
export function kinsokuProblems(text: string, budget: number): BreakProblem[] {
  const lines = wrapByWidth(text, budget);
  const problems: BreakProblem[] = [];
  for (const [index, line] of lines.entries()) {
    const first = [...line.text][0];
    const last = [...line.text].at(-1);
    if (index > 0 && first && noLineStart.has(first)) {
      problems.push({ issue: "JAPANESE_ORPHAN_PUNCTUATION", detail: `line ${index + 1} begins with '${first}'` });
    }
    if (index < lines.length - 1 && last && noLineEnd.has(last)) {
      problems.push({ issue: "JAPANESE_ORPHAN_PUNCTUATION", detail: `line ${index + 1} ends with '${last}'` });
    }
    if (index < lines.length - 1 && last) {
      const next = [...lines[index + 1].text][0];
      if (next && isKatakana(last) && isKatakana(next)) {
        problems.push({ issue: "JAPANESE_AWKWARD_LINE_BREAK", detail: `katakana word split across lines ${index + 1}/${index + 2} ('${last}' | '${next}')` });
      }
      if (next && isLatinOrDigit(last) && isLatinOrDigit(next)) {
        problems.push({ issue: "JAPANESE_AWKWARD_LINE_BREAK", detail: `latin token split across lines ${index + 1}/${index + 2} ('${last}' | '${next}')` });
      }
    }
  }
  return problems;
}

/**
 * Headline-specific wrap quality, independent of language: a headline that runs to three lines,
 * or that pushes a short fragment onto a line of its own, reads as an accident rather than a
 * composed break.
 */
export function headlineWrapProblem(text: string, budget: number): BreakProblem | undefined {
  const lines = wrapByWidth(text, budget);
  if (lines.length < 2) return undefined;
  if (lines.length > 2) {
    return { issue: "HEADLINE_BAD_WRAP", detail: `headline wraps to ${lines.length} lines at a ${budget}-column budget` };
  }
  const last = lines.at(-1)!;
  if (last.width < budget * 0.25) {
    return { issue: "HEADLINE_BAD_WRAP", detail: `headline pushes a ${last.width}-column fragment ('${last.text}') onto its own line` };
  }
  return undefined;
}
