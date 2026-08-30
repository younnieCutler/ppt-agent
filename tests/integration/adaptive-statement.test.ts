import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import JSZip from "jszip";
import pptxgen from "pptxgenjs";
import { describe, expect, it } from "vitest";
import { compileTemplateGrammar, extractTemplateElements } from "../../src/template-analysis";
import { compileTemplateComponents } from "../../src/template-components";
import { compileTemplateDesignSystem } from "../../src/template-design-system";

const repoRoot = path.resolve(__dirname, "../..");
const tsxPackage = createRequire(__filename).resolve("tsx/package.json");
const tsxCli = path.join(path.dirname(tsxPackage), JSON.parse(fs.readFileSync(tsxPackage, "utf8")).bin as string);

async function statementFixture(): Promise<{ dir: string; template: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-adaptive-statement-"));
  const template = path.join(dir, "template.pptx");
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  const slide = pptx.addSlide();
  slide.background = { color: "F5F1E8" };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: "F5F1E8" }, line: { color: "F5F1E8" } });
  slide.addText("SOURCE EXAMPLE HEADLINE", { x: 0.85, y: 0.6, w: 6, h: 0.7, fontFace: "Arial", fontSize: 28, bold: true, color: "1A1A1A" });
  slide.addText("SOURCE EXAMPLE BODY", { x: 0.85, y: 1.8, w: 7, h: 1.2, fontFace: "Arial", fontSize: 16, color: "333333" });
  slide.addText("SOURCE EXAMPLE PROOF", { x: 0.85, y: 3.4, w: 5, h: 0.4, fontFace: "Arial", fontSize: 14, color: "666666" });
  slide.addShape(pptx.ShapeType.line, { x: 0.85, y: 5.8, w: 8, h: 0, line: { color: "1A1A1A", width: 1 } });
  await pptx.writeFile({ fileName: template });
  return { dir, template };
}

describe("adaptive statement vertical slice", () => {
  it("analyzes a raw PPTX, plans semantic statement content, transforms native components, and emits QA", async () => {
    const source = await statementFixture();
    try {
      const elements = await extractTemplateElements(source.template);
      const grammar = compileTemplateGrammar(elements);
      const designSystem = compileTemplateDesignSystem(elements, grammar);
      const components = compileTemplateComponents(elements);
      const planPath = path.join(source.dir, "adaptive-slide-plan.json");
      const qaPath = path.join(source.dir, "adaptive-qa.json");
      const outputPath = path.join(source.dir, "adaptive-statement.pptx");
      const intentPath = path.join(source.dir, "statement-intent.json");
      const designSystemPath = path.join(source.dir, "template-design-system.json");
      const componentsPath = path.join(source.dir, "template-components.json");
      fs.writeFileSync(intentPath, JSON.stringify({
        slideId: "S01",
        family: "stack",
        blocks: [
          { id: "headline", role: "headline", text: "ADAPTIVE HEADLINE", priority: 100, emphasis: "primary" },
          { id: "body", role: "body", text: "Adaptive body content", priority: 60, emphasis: "secondary" },
          { id: "proof", role: "support", text: "Grounded proof", priority: 20, emphasis: "supporting" },
        ],
      }, null, 2));
      fs.writeFileSync(designSystemPath, JSON.stringify(designSystem, null, 2));
      fs.writeFileSync(componentsPath, JSON.stringify(components, null, 2));

      const result = JSON.parse(execFileSync(process.execPath, [tsxCli, path.join(repoRoot, "src/cli.ts"), "adaptive-statement", "--template", source.template, "--design-system", designSystemPath, "--components", componentsPath, "--intent", intentPath, "--out", outputPath, "--plan-out", planPath, "--qa-out", qaPath], { cwd: repoRoot, encoding: "utf8" }));
      expect(result.status).toBe("pass");
      expect(fs.existsSync(outputPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(qaPath, "utf8"))).toMatchObject({ status: "pass", findings: [] });
      expect(JSON.parse(fs.readFileSync(planPath, "utf8")).placements).toHaveLength(3);

      const outputZip = await JSZip.loadAsync(fs.readFileSync(outputPath));
      const outputXml = await Promise.all(Object.keys(outputZip.files).filter((file) => /^ppt\/slides\/.*\.xml$/.test(file)).map((file) => outputZip.file(file)!.async("string")));
      expect(outputXml.join("\n")).toContain("ADAPTIVE HEADLINE");
      expect(outputXml.join("\n")).not.toContain("SOURCE EXAMPLE");
    } finally {
      fs.rmSync(source.dir, { recursive: true, force: true });
    }
  });
});
