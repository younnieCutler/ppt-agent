import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const skillPath = path.resolve(__dirname, "../../SKILL.md");
const skill = fs.readFileSync(skillPath, "utf8");

function position(fragment: string): number {
  const index = skill.indexOf(fragment);
  expect(index, `SKILL.md is missing canonical workflow fragment: ${fragment}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe("canonical /ppt workflow", () => {
  it("locks the pilot-first authoring order before full-deck assembly", () => {
    const storyline = position("npm run planning -- storyline-validate");
    const plan = position("node dist/cli.js plan-validate");
    const storylinePlan = position("npm run planning -- storyline-plan-validate");
    const pilotSelect = position("npm run planning -- pilot-select");
    const pilotContext = position("npm run pilot -- context");
    const pilotApproval = position("npm run pilot -- approve");
    const fullSlideContext = position("npm run pilot -- full-slide-context");
    const slideApply = position("npm run full-deck -- slide-apply");
    const assembly = position("npm run full-deck -- assemble");
    const finalValidate = position("node dist/cli.js validate --spec <run-dir>/deck.json");

    expect(storyline).toBeLessThan(plan);
    expect(plan).toBeLessThan(storylinePlan);
    expect(storylinePlan).toBeLessThan(pilotSelect);
    expect(pilotSelect).toBeLessThan(pilotContext);
    expect(pilotContext).toBeLessThan(pilotApproval);
    expect(pilotApproval).toBeLessThan(fullSlideContext);
    expect(fullSlideContext).toBeLessThan(slideApply);
    expect(slideApply).toBeLessThan(assembly);
    expect(assembly).toBeLessThan(finalValidate);
  });

  it("does not instruct a host to author the whole DeckSpec before Pilot approval", () => {
    expect(skill).not.toContain("# 6. Author the DeckSpec v2");
    expect(skill).toContain("The full DeckSpec is **assembled last**, not authored in one model pass.");
    expect(skill).toContain("Never re-author an approved Pilot slide.");
    expect(skill).toContain("Deterministic assembly: 0 model calls.");
  });

  it("keeps measured benchmark efficiency in the canonical post-QA path", () => {
    const tokens = position("node dist/cli.js tokens --spec <deck.json>");
    const score = position("node dist/cli.js score  --spec <deck.json>");
    const evalGate = position("npm run eval-gate -- --run-dir <run-dir> --benchmark <id>");
    const record = position("node dist/cli.js record --spec <deck.json>");

    expect(tokens).toBeLessThan(score);
    expect(score).toBeLessThan(evalGate);
    expect(evalGate).toBeLessThan(record);
  });
});
