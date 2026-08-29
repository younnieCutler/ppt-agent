import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { pruneUnreachablePptxParts, readPptxOoxml } from "../../src/ooxml";
import { renderDeck } from "../../src/renderer";
import { deckSchema } from "../../src/schema";

const deckFixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/deck.json"), "utf8"));

async function fixture(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-prune-"));
  const output = path.join(dir, "deck.pptx");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/slides/slide1.xml" ContentType="x"/><Override PartName="/ppt/slides/slide2.xml" ContentType="x"/></Types>');
  zip.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="ppt/presentation.xml" Type="x"/></Relationships>');
  zip.file("ppt/presentation.xml", "<presentation/>");
  zip.file("ppt/_rels/presentation.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="slides/slide1.xml" Type="x"/></Relationships>');
  zip.file("ppt/slides/slide1.xml", "<slide>PUBLIC</slide>");
  zip.file("ppt/slides/_rels/slide1.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="../media/image1.png" Type="x"/></Relationships>');
  zip.file("ppt/media/image1.png", "PUBLIC_MEDIA");
  zip.file("ppt/slides/slide2.xml", "PRIVATE_TEMPLATE_EXAMPLE_SENTENCE");
  zip.file("ppt/media/image2.png", "PRIVATE_MEDIA");
  fs.writeFileSync(output, await zip.generateAsync({ type: "nodebuffer" }));
  return output;
}

describe("OOXML template pruning", () => {
  it("removes unreachable example slide parts, media, and content-type overrides", async () => {
    const output = await fixture();
    await pruneUnreachablePptxParts(output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    expect(Object.keys(zip.files)).toContain("ppt/slides/slide1.xml");
    expect(Object.keys(zip.files)).not.toContain("ppt/slides/slide2.xml");
    expect(Object.keys(zip.files)).not.toContain("ppt/media/image2.png");
    expect((await zip.file("[Content_Types].xml")?.async("string")) ?? "").not.toContain("slide2.xml");
  });
});

describe("organization template adapter pruning", () => {
  it("drops the template's private example media from the delivered deck", async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-prune-adapter-"));
    const scratch = path.join(runDir, "scratch.pptx");
    await renderDeck(deckFixture, scratch, process.cwd());

    const organizationDir = path.join(runDir, "organization");
    fs.mkdirSync(organizationDir, { recursive: true });
    const templatePath = path.join(organizationDir, "template.pptx");
    // A real Organization Template Pack ships example slides whose media stays in the package
    // after pptx-automizer replaces the slides; an unreachable media part reproduces that.
    const template = await JSZip.loadAsync(fs.readFileSync(scratch));
    template.file("ppt/media/private-example.png", "PRIVATE_EXAMPLE_MEDIA");
    fs.writeFileSync(templatePath, await template.generateAsync({ type: "nodebuffer" }));
    fs.writeFileSync(path.join(organizationDir, "brand.yaml"), [
      "name: Prune Test",
      "palette:",
      '  background: "FFFFFF"',
      '  surface: "FFFFFF"',
      '  text: "111111"',
      '  primary: "123456"',
      '  accent: "654321"',
      '  muted: "666666"',
      '  border: "DDDDDD"',
    ].join("\n"));
    fs.writeFileSync(path.join(organizationDir, "template-map.json"), JSON.stringify({
      version: 1,
      chromeOwnership: { background: "template", logo: "template", footer: "template", pageNumber: "template" },
      defaultLayout: { nativeLayout: "DEFAULT", canvasColor: "FFFFFF", contentRegion: { x: 0.72, y: 0.48, w: 11.85, h: 6.14 }, reservedRegions: [] },
      layouts: {},
      requiredElements: [],
    }));

    const deck = deckSchema.parse({ ...deckFixture, contract: { ...deckFixture.contract, organization: { kind: "directory", path: organizationDir } } });
    const output = path.join(runDir, "filled.pptx");
    await renderDeck(deck, output, process.cwd());

    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    expect(Object.keys(zip.files)).not.toContain("ppt/media/private-example.png");
    const facts = await readPptxOoxml(output);
    expect(facts.parseOk).toBe(true);
    expect(facts.slideCount).toBe(deck.slides.length);
  }, 60000);
});
