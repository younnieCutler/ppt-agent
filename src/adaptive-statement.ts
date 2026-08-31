import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { readPptxOoxml } from "./ooxml";
import { adaptiveSlideIntentSchema, planAdaptiveSlide, type AdaptiveSlideIntent, type AdaptiveSlidePlan } from "./adaptive-composition";
import { transformTemplateComponents } from "./template-transform";
import { assertCanonicalTemplateElements, compileTemplateGrammar, elementsDigest, extractTemplateElements, type TemplateElementsArtifact } from "./template-analysis";
import { compileTemplateComponents, type TemplateComponentsArtifact, type TemplateComponent } from "./template-components";
import { compileTemplateDesignSystem, type TemplateDesignSystemArtifact } from "./template-design-system";

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const EMU_PER_INCH = 914400;
const STRUCTURAL_ROLES = new Set(["surface", "divider", "footer", "logo"]);

type Rect = { x: number; y: number; w: number; h: number };
export type AdaptiveStatementFinding = { code: "ADAPTIVE_GEOMETRY_OVERFLOW" | "ADAPTIVE_CONTENT_DROPPED" | "ADAPTIVE_EXAMPLE_CONTENT_LEAK" | "ADAPTIVE_STYLE_SOURCE_VIOLATION" | "ADAPTIVE_TEMPLATE_PROVENANCE_MISSING" | "OOXML_INVALID"; message: string };
export type AdaptiveStatementQa = { status: "pass" | "fail"; findings: AdaptiveStatementFinding[] };
export type AdaptiveStatementResult = { outputPath: string; plan: AdaptiveSlidePlan; qa: AdaptiveStatementQa };
export type AdaptiveRenderableLayout = "statement" | "comparison" | "quantitative";

function parse(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
}

function all(scope: Document | Element, namespace: string, name: string): Element[] {
  return Array.from(scope.getElementsByTagNameNS(namespace, name));
}

function first(scope: Document | Element, namespace: string, name: string): Element | undefined {
  return all(scope, namespace, name)[0];
}

function children(node: Element): Element[] {
  return Array.from(node.childNodes).filter((child): child is Element => child.nodeType === 1) as Element[];
}

function nameOf(node: Element): string {
  return first(node, P_NS, "cNvPr")?.getAttribute("name") ?? "";
}

function rectOf(node: Element): Rect | undefined {
  const xfrm = first(node, A_NS, "xfrm") ?? first(node, P_NS, "xfrm");
  const off = xfrm ? first(xfrm, A_NS, "off") : undefined;
  const ext = xfrm ? first(xfrm, A_NS, "ext") : undefined;
  if (!off || !ext) return undefined;
  return { x: Number(off.getAttribute("x") ?? 0) / EMU_PER_INCH, y: Number(off.getAttribute("y") ?? 0) / EMU_PER_INCH, w: Number(ext.getAttribute("cx") ?? 0) / EMU_PER_INCH, h: Number(ext.getAttribute("cy") ?? 0) / EMU_PER_INCH };
}

function slideNodes(root: Element): Element[] {
  return [...all(root, P_NS, "sp"), ...all(root, P_NS, "pic"), ...all(root, P_NS, "graphicFrame"), ...all(root, P_NS, "cxnSp")];
}

function textOf(node: Element): string {
  return all(node, A_NS, "t").map((text) => text.textContent ?? "").join("");
}

function styleTokens(root: Element): Set<string> {
  return new Set([
    ...["latin", "ea", "cs"].flatMap((name) => all(root, A_NS, name).map((node) => `font:${node.getAttribute("typeface") ?? ""}`)),
    ...all(root, A_NS, "srgbClr").map((node) => `color:${node.getAttribute("val") ?? ""}`),
    ...all(root, A_NS, "schemeClr").map((node) => `scheme:${node.getAttribute("val") ?? ""}`),
  ]);
}

function structural(component: TemplateComponent): boolean {
  return Boolean(component.offCanvasHelper) || component.semanticRoles.some((role) => STRUCTURAL_ROLES.has(role));
}

function physicalPath(filePath: string): string {
  const absolute = path.resolve(filePath);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
  }
}

function insideCanvas(rect: Rect, canvas: { w: number; h: number }): boolean {
  const epsilon = 2 / EMU_PER_INCH;
  return rect.x >= -epsilon && rect.y >= -epsilon && rect.w >= 0 && rect.h >= 0 && rect.x + rect.w <= canvas.w + epsilon && rect.y + rect.h <= canvas.h + epsilon;
}

function geometryOperations(componentId: string, current: Rect, target: Rect, canvas: { w: number; h: number }): Parameters<typeof transformTemplateComponents>[3] {
  const resizeThenMove = { ...current, w: target.w, h: target.h };
  const moveThenResize = { ...current, x: target.x, y: target.y };
  if (insideCanvas(resizeThenMove, canvas)) return [{ operation: "resize", componentId, w: target.w, h: target.h }, { operation: "move", componentId, x: target.x, y: target.y }];
  if (insideCanvas(moveThenResize, canvas)) return [{ operation: "move", componentId, x: target.x, y: target.y }, { operation: "resize", componentId, w: target.w, h: target.h }];
  throw new Error(`ADAPTIVE_GEOMETRY_OVERFLOW: component '${componentId}' cannot reach its in-canvas target without an out-of-canvas intermediate transform.`);
}

function operationsFor(plan: AdaptiveSlidePlan, components: TemplateComponentsArtifact): Parameters<typeof transformTemplateComponents>[3] {
  const byId = new Map(components.components.map((component) => [component.id, component]));
  const used = new Set(plan.placements.map((placement) => placement.componentId));
  const usage = new Map<string, number>();
  const bounds = new Map(components.components.map((component) => [component.id, { ...component.sourceBounds }]));
  const operations: Parameters<typeof transformTemplateComponents>[3] = [];
  for (const placement of plan.placements) {
    const component = byId.get(placement.componentId);
    if (!component) throw new Error(`ADAPTIVE_TEMPLATE_PROVENANCE_MISSING: plan references unknown component '${placement.componentId}'.`);
    const count = usage.get(component.id) ?? 0;
    usage.set(component.id, count + 1);
    const target = count === 0 ? component.id : `${component.id}.adaptive.${count + 1}`;
    if (count > 0) operations.push({ operation: "clone", componentId: component.id, as: target });
    const current = bounds.get(target) ?? bounds.get(component.id);
    if (!current) throw new Error(`ADAPTIVE_TEMPLATE_PROVENANCE_MISSING: no source bounds for component '${target}'.`);
    const targetBounds = { x: placement.x, y: placement.y, w: placement.w, h: placement.h };
    operations.push(...geometryOperations(target, current, targetBounds, components.canvas));
    bounds.set(target, targetBounds);
    const text = plan.textAllocation.find((allocation) => allocation.blockId === placement.blockId)?.text;
    if (!text) throw new Error(`ADAPTIVE_CONTENT_DROPPED: plan has no text allocation for '${placement.blockId}'.`);
    operations.push({ operation: "replace_text", componentId: target, text });
  }
  components.components.filter((component) => component.sourceSlideId === plan.slideId && !used.has(component.id) && !structural(component)).forEach((component) => {
    if (component.shapeNames.length !== 1) throw new Error(`ADAPTIVE_TEMPLATE_PROVENANCE_MISSING: unused component '${component.id}' has no single semantic shape selector.`);
    operations.push({ operation: "remove", componentId: component.id });
  });
  return operations;
}

async function qaAdaptiveStatement(templatePath: string, outputPath: string, plan: AdaptiveSlidePlan, components: TemplateComponentsArtifact): Promise<AdaptiveStatementQa> {
  const findings: AdaptiveStatementFinding[] = [];
  const facts = await readPptxOoxml(outputPath);
  if (!facts.parseOk || facts.slideCount !== 1) findings.push({ code: "OOXML_INVALID", message: "Adaptive statement output is not a parseable single-slide PPTX." });
  const sourceZip = await JSZip.loadAsync(fs.readFileSync(path.resolve(templatePath)));
  const outputZip = await JSZip.loadAsync(fs.readFileSync(path.resolve(outputPath)));
  const sourceXml = await sourceZip.file(components.components[0].sourceSlidePart)?.async("string");
  const outputXml = await outputZip.file(components.components[0].sourceSlidePart)?.async("string");
  if (!sourceXml || !outputXml) return { status: "fail", findings: [...findings, { code: "OOXML_INVALID", message: "Adaptive statement source/output slide part is missing." }] };
  const sourceRoot = first(parse(sourceXml), P_NS, "spTree");
  const outputRoot = first(parse(outputXml), P_NS, "spTree");
  if (!sourceRoot || !outputRoot) return { status: "fail", findings: [...findings, { code: "OOXML_INVALID", message: "Adaptive statement source/output shape tree is missing." }] };

  const templateOwnedNames = new Set(components.components.filter(structural).flatMap((component) => component.shapeNames));
  const outputNodes = slideNodes(outputRoot);
  for (const node of outputNodes) {
    if (templateOwnedNames.has(nameOf(node))) continue;
    const rect = rectOf(node);
    if (rect && (rect.x < 0 || rect.y < 0 || rect.w <= 0 || rect.h <= 0 || rect.x + rect.w > plan.contentFrame.x + plan.contentFrame.w || rect.y + rect.h > plan.contentFrame.y + plan.contentFrame.h)) findings.push({ code: "ADAPTIVE_GEOMETRY_OVERFLOW", message: `Output shape '${nameOf(node) || "(unnamed)"}' with bounds ${JSON.stringify(rect)} escaped the adaptive content frame ${JSON.stringify(plan.contentFrame)}.` });
  }

  const sourceExampleNames = new Set(components.components.filter((component) => !structural(component)).flatMap((component) => component.shapeNames));
  const sourceExamples = slideNodes(sourceRoot).filter((node) => sourceExampleNames.has(nameOf(node))).map(textOf).filter((text) => text.length > 0);
  const outputTextNodes = outputNodes.map(textOf).filter((text) => text.length > 0);
  const outputText = all(outputRoot, A_NS, "t").map((text) => text.textContent ?? "").join(" ");
  sourceExamples.forEach((text) => { if (outputTextNodes.includes(text)) findings.push({ code: "ADAPTIVE_EXAMPLE_CONTENT_LEAK", message: `Template example text survived: '${text}'.` }); });
  for (const allocation of plan.textAllocation) if (!outputText.includes(allocation.text)) findings.push({ code: "ADAPTIVE_CONTENT_DROPPED", message: `Adaptive content block '${allocation.blockId}' did not reach the output.` });
  const removableMediaNames = new Set(components.components.filter((component) => !structural(component) && component.assetProvenance.kind !== "none").flatMap((component) => component.shapeNames));
  outputNodes.filter((node) => removableMediaNames.has(nameOf(node))).forEach((node) => findings.push({ code: "ADAPTIVE_EXAMPLE_CONTENT_LEAK", message: `Template example media survived: '${nameOf(node)}'.` }));

  const sourceStyles = styleTokens(sourceRoot);
  const outputStyles = styleTokens(outputRoot);
  const novel = [...outputStyles].filter((token) => !sourceStyles.has(token));
  if (novel.length > 0) findings.push({ code: "ADAPTIVE_STYLE_SOURCE_VIOLATION", message: `Output contains style tokens absent from the source template: ${novel.join(", ")}.` });
  const structuralNames = components.components.filter(structural).flatMap((component) => component.shapeNames).filter(Boolean);
  const outputNames = new Set(outputNodes.map(nameOf));
  const missingStructural = structuralNames.filter((name) => !outputNames.has(name));
  if (missingStructural.length > 0) findings.push({ code: "ADAPTIVE_TEMPLATE_PROVENANCE_MISSING", message: `Template-native structural components are missing: ${missingStructural.join(", ")}.` });
  return { status: findings.length > 0 ? "fail" : "pass", findings };
}

export async function renderAdaptiveContent(templatePath: string, outputPath: string, designSystem: TemplateDesignSystemArtifact, components: TemplateComponentsArtifact, elements: TemplateElementsArtifact, intentInput: unknown, layout: AdaptiveRenderableLayout): Promise<AdaptiveStatementResult> {
  const intent = adaptiveSlideIntentSchema.parse(intentInput);
  if (intent.blocks.some((block) => /[\r\n]/.test(block.text))) throw new Error(`ADAPTIVE_${layout.toUpperCase()}_UNSUPPORTED: content must fit the single-run text replacement contract and must not contain newlines.`);
  if (layout === "statement" && (intent.blocks.some((block) => !["headline", "body", "support"].includes(block.role)) || intent.family !== "stack" || !intent.blocks.some((block) => block.role === "headline") || !intent.blocks.some((block) => block.role === "body"))) throw new Error("ADAPTIVE_STATEMENT_UNSUPPORTED: statement vertical slice requires stack family with headline and body content.");
  if (layout === "comparison" && (intent.family !== "two_column" || intent.blocks.some((block) => !["support", "item"].includes(block.role)) || new Set(intent.blocks.map((block) => block.group).filter(Boolean)).size < 2)) throw new Error("ADAPTIVE_COMPARISON_UNSUPPORTED: comparison requires two semantic groups in a two_column intent.");
  if (layout === "quantitative" && (intent.family !== "metric_row" || intent.blocks.some((block) => block.role !== "metric"))) throw new Error("ADAPTIVE_QUANTITATIVE_UNSUPPORTED: quantitative requires metric_row with metric blocks only.");
  const extracted = await extractTemplateElements(templatePath);
  assertCanonicalTemplateElements(elements);
  if (JSON.stringify(elements) !== JSON.stringify(extracted) || elements.source.sha256 !== components.sourceDigest || elements.source.sha256 !== designSystem.sourceDigest || components.elementsDigest !== elementsDigest(elements) || designSystem.elementsDigest !== elementsDigest(elements)) throw new Error(`ADAPTIVE_${layout.toUpperCase()}_PROVENANCE_MISMATCH: template artifacts do not describe the current raw template extraction.`);
  if (JSON.stringify(components) !== JSON.stringify(compileTemplateComponents(elements)) || JSON.stringify(designSystem) !== JSON.stringify(compileTemplateDesignSystem(elements, compileTemplateGrammar(elements)))) throw new Error(`ADAPTIVE_${layout.toUpperCase()}_PROVENANCE_MISMATCH: Design System or Component Catalog is not the compiler output for the supplied template elements.`);
  const sourceSlideIds = new Set(components.components.map((component) => component.sourceSlideId));
  if (sourceSlideIds.size !== 1 || !sourceSlideIds.has(intent.slideId)) throw new Error(`ADAPTIVE_${layout.toUpperCase()}_UNSUPPORTED: adaptive content requires a single source slide in the component catalog.`);
  const sourceKinds = new Set(components.components.filter((component) => !component.offCanvasHelper && !component.grouped).map((component) => component.kind));
  if (layout === "statement" && (!sourceKinds.has("title_block") || (intent.blocks.some((block) => block.role === "body") && !sourceKinds.has("body_block")))) throw new Error("ADAPTIVE_STATEMENT_UNSUPPORTED: statement requires template-native title_block and body_block capability.");
  if (layout === "quantitative" && !sourceKinds.has("metric")) throw new Error("ADAPTIVE_QUANTITATIVE_UNSUPPORTED: quantitative requires a template-native metric component.");
  const plan = planAdaptiveSlide({ templateDigest: components.sourceDigest, designSystem, components, intent });
  if (plan.textAllocation.some((allocation) => allocation.fits === "no")) throw new Error(`ADAPTIVE_${layout.toUpperCase()}_UNSUPPORTED: text does not fit the calculated native component placement.`);
  const operations = operationsFor(plan, components);
  const resolvedOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  if (physicalPath(templatePath) === physicalPath(resolvedOutput)) throw new Error("ADAPTIVE_STATEMENT_SOURCE_IMMUTABLE: outputPath must differ from the source template path.");
  const temporary = `${resolvedOutput}.${process.pid}.adaptive.tmp`;
  try {
    await transformTemplateComponents(templatePath, temporary, components, operations);
    const qa = await qaAdaptiveStatement(templatePath, temporary, plan, components);
    if (qa.status === "pass") fs.renameSync(temporary, resolvedOutput);
    return { outputPath: resolvedOutput, plan, qa };
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export async function renderAdaptiveStatement(templatePath: string, outputPath: string, designSystem: TemplateDesignSystemArtifact, components: TemplateComponentsArtifact, elements: TemplateElementsArtifact, intentInput: unknown): Promise<AdaptiveStatementResult> {
  return renderAdaptiveContent(templatePath, outputPath, designSystem, components, elements, intentInput, "statement");
}

export async function renderAdaptiveComparison(templatePath: string, outputPath: string, designSystem: TemplateDesignSystemArtifact, components: TemplateComponentsArtifact, elements: TemplateElementsArtifact, intentInput: unknown): Promise<AdaptiveStatementResult> {
  return renderAdaptiveContent(templatePath, outputPath, designSystem, components, elements, intentInput, "comparison");
}

export async function renderAdaptiveQuantitative(templatePath: string, outputPath: string, designSystem: TemplateDesignSystemArtifact, components: TemplateComponentsArtifact, elements: TemplateElementsArtifact, intentInput: unknown): Promise<AdaptiveStatementResult> {
  return renderAdaptiveContent(templatePath, outputPath, designSystem, components, elements, intentInput, "quantitative");
}
