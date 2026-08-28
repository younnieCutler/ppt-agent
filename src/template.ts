import fs from "node:fs";
import path from "node:path";
import Automizer from "pptx-automizer";
import JSZip from "jszip";
import { bindingForLayout, type TemplateMap } from "./organization";
import type { ResolvedPresentationStyle } from "./style";
import type { SlideSpec } from "./schema";

/**
 * Applies an organisation's native PowerPoint template after the semantic
 * renderer has produced an editable scratch deck.  Keeping this as a small
 * adapter means semantic layouts never need an organisation-specific fork.
 */
export async function applyOrganizationTemplate(
  scratchPath: string,
  outputPath: string,
  style: ResolvedPresentationStyle,
  slides: SlideSpec[],
): Promise<void> {
  const organization = style.organization;
  if (!organization) {
    fs.copyFileSync(path.resolve(scratchPath), path.resolve(outputPath));
    return;
  }
  if (!fs.existsSync(organization.templatePath)) {
    throw new Error(`Organization template not found: ${organization.templatePath}`);
  }
  const { nameToIndex } = await validateTemplateContract(organization.templatePath, organization.map, slides);

  const resolvedOutput = path.resolve(outputPath);
  const outputDir = path.dirname(resolvedOutput);
  fs.mkdirSync(outputDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(outputDir, `.ppt-agent-template-${process.pid}-`));
  const rootName = "organization-template.pptx";
  const generatedName = "semantic-render.pptx";
  try {
    fs.copyFileSync(organization.templatePath, path.join(staging, rootName));
    fs.copyFileSync(path.resolve(scratchPath), path.join(staging, generatedName));

    const automizer = new Automizer({
      templateDir: staging,
      outputDir,
      removeExistingSlides: true,
    });
    const presentation = automizer.loadRoot(rootName).load(generatedName, "semantic-render");
    slides.forEach((slideSpec, index) => {
      const binding = bindingForLayout(organization.map, slideSpec.layout);
      // pptx-automizer's by-name useSlideLayout() only resolves against layouts that were
      // explicitly imported/tracked as "mapped content" from a secondary template — it does not
      // look up a layout that's already native to the root document (loadRoot never registers its
      // own layouts that way), so it silently fails to find any name and fabricates a new layout
      // instead of binding to the real one. Resolving the name to its 1-based index ourselves and
      // always calling useSlideLayout() with a number sidesteps that path entirely: a plain number
      // is used verbatim against the root's own layouts, which is exactly what already works today
      // for numeric-index bindings.
      const nativeLayout = /^\d+$/.test(binding.nativeLayout) ? Number(binding.nativeLayout) : nameToIndex.get(binding.nativeLayout)!;
      presentation.addSlide("semantic-render", index + 1, (slide) => {
        slide.useSlideLayout(nativeLayout);
      });
    });
    await presentation.write(path.basename(resolvedOutput));
    if (!fs.existsSync(resolvedOutput)) throw new Error(`Organization template adapter did not produce ${resolvedOutput}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function validateTemplateContract(templatePath: string, map: TemplateMap, slides: SlideSpec[]): Promise<{ nameToIndex: Map<string, number> }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(templatePath));
  } catch (error) {
    throw new Error(`Organization template is not a readable PPTX: ${templatePath} (${error instanceof Error ? error.message : String(error)})`);
  }
  const presentationXml = await zip.file("ppt/presentation.xml")?.async("string");
  if (!presentationXml) throw new Error(`Organization template is missing ppt/presentation.xml: ${templatePath}`);
  const sizeTag = presentationXml.match(/<p:sldSz\b[^>]*>/)?.[0];
  const cx = Number(sizeTag?.match(/\bcx="(\d+)"/)?.[1] ?? 0);
  const cy = Number(sizeTag?.match(/\bcy="(\d+)"/)?.[1] ?? 0);
  const expectedRatio = map.aspectRatio === "4:3" ? 4 / 3 : 16 / 9;
  if (!cx || !cy || Math.abs(cx / cy - expectedRatio) > 0.02) {
    throw new Error(`Organization template must be ${map.aspectRatio}; template.pptx has an incompatible slide size.`);
  }

  const layoutFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name))
    .sort((left, right) => Number(left.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(right.match(/(\d+)\.xml$/)?.[1] ?? 0));
  // A real PowerPoint template can legitimately have two layouts sharing a display name (they
  // come from different masters/themes). Tracking every index per name — not just the last one
  // seen — lets ambiguous name bindings be rejected explicitly instead of silently resolving to
  // whichever layout happened to be parsed last.
  const layoutNamesByOccurrence = new Map<string, number[]>();
  const layoutXmlByIndex = new Map<number, string>();
  for (const [index, fileName] of layoutFiles.entries()) {
    const xml = await zip.file(fileName)?.async("string");
    if (xml) layoutXmlByIndex.set(index + 1, xml);
    const name = xml?.match(/<p:cSld\b[^>]*\bname="([^"]+)"/)?.[1] ?? xml?.match(/<p:sldLayout\b[^>]*\bname="([^"]+)"/)?.[1];
    if (name) layoutNamesByOccurrence.set(name, [...(layoutNamesByOccurrence.get(name) ?? []), index + 1]);
  }
  const nameToIndex = new Map<string, number>();
  const bindings = new Map<string, string>();
  slides.forEach((slide) => {
    const binding = bindingForLayout(map, slide.layout);
    bindings.set(binding.nativeLayout, slide.layout);
  });
  bindings.forEach((layout, nativeLayout) => {
    if (/^\d+$/.test(nativeLayout)) {
      const index = Number(nativeLayout);
      if (index < 1 || index > layoutFiles.length) throw new Error(`Template map layout '${nativeLayout}' for semantic layout '${layout}' does not exist in template.pptx.`);
      return;
    }
    const indexes = layoutNamesByOccurrence.get(nativeLayout);
    if (!indexes) throw new Error(`Template map layout '${nativeLayout}' for semantic layout '${layout}' does not exist in template.pptx.`);
    if (indexes.length > 1) {
      throw new Error(`Template map layout '${nativeLayout}' for semantic layout '${layout}' is ambiguous: ${indexes.length} layouts in template.pptx share this name (indexes ${indexes.join(", ")}). Use the 1-based layout index instead.`);
    }
    nameToIndex.set(nativeLayout, indexes[0]);
  });

  const layoutNames = new Map(nameToIndex);
  const templateXml = (await Promise.all(Object.keys(zip.files)
    .filter((name) => /^ppt\/(?:slides|slideLayouts|slideMasters)\/.*\.xml$/.test(name))
    .map(async (name) => (await zip.file(name)?.async("string")) ?? ""))).join("\n");
  map.requiredElements.forEach((required) => {
    const found = required.layouts.includes("*")
      ? templateXml.includes(`name="${required.name}"`)
      : required.layouts.some((semanticLayout) => {
        const binding = bindingForLayout(map, semanticLayout as SlideSpec["layout"]);
        const layoutIndex = /^\d+$/.test(binding.nativeLayout) ? Number(binding.nativeLayout) : layoutNames.get(binding.nativeLayout);
        return layoutIndex ? (layoutXmlByIndex.get(layoutIndex)?.includes(`name="${required.name}"`) ?? false) : false;
      });
    if (!found) throw new Error(`Template map requires element '${required.name}', but it was not found in template.pptx.`);
  });

  return { nameToIndex };
}
