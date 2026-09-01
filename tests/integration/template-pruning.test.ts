import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { pruneUnreachablePptxParts } from "../../src/ooxml";

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
