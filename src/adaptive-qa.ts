import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { readPptxOoxml } from "./ooxml";
import type { AdaptiveSlidePlan } from "./adaptive-composition";
import type { TemplateComponentsArtifact, TemplateComponent } from "./template-components";

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const EMU_PER_INCH = 914400;

export const adaptiveQaCodes = [
  "TEMPLATE_COMPONENT_PROVENANCE_MISSING",
  "TEMPLATE_STYLE_SOURCE_VIOLATION",
  "ADAPTIVE_CONTENT_DROPPED",
  "ADAPTIVE_GEOMETRY_OVERFLOW",
  "ADAPTIVE_COMPONENT_UNSUPPORTED",
  "ADAPTIVE_EXAMPLE_CONTENT_LEAK",
] as const;
export type AdaptiveQaCode = (typeof adaptiveQaCodes)[number];
export type AdaptiveQaFinding = { severity: "hard"; code: AdaptiveQaCode; message: string };
export type AdaptiveQaReport = { status: "pass" | "fail"; findings: AdaptiveQaFinding[] };
export type AdaptiveQaInput = { templatePath: string; outputPath: string; plan: AdaptiveSlidePlan; components: TemplateComponentsArtifact };

function parse(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
}

function all(scope: Document | Element, namespace: string, name: string): Element[] {
  return Array.from(scope.getElementsByTagNameNS(namespace, name));
}

function first(scope: Document | Element, namespace: string, name: string): Element | undefined {
  return all(scope, namespace, name)[0];
}

function nameOf(node: Element): string {
  return first(node, P_NS, "cNvPr")?.getAttribute("name") ?? "";
}

function textOf(node: Element): string {
  return all(node, A_NS, "t").map((text) => text.textContent ?? "").join("");
}

function slideNodes(root: Element): Element[] {
  return [...all(root, P_NS, "sp"), ...all(root, P_NS, "pic"), ...all(root, P_NS, "graphicFrame"), ...all(root, P_NS, "cxnSp")];
}

function rectOf(node: Element): { x: number; y: number; w: number; h: number } | undefined {
  const xfrm = first(node, A_NS, "xfrm") ?? first(node, P_NS, "xfrm");
  const off = xfrm ? first(xfrm, A_NS, "off") : undefined;
  const ext = xfrm ? first(xfrm, A_NS, "ext") : undefined;
  if (!off || !ext) return undefined;
  return { x: Number(off.getAttribute("x") ?? 0) / EMU_PER_INCH, y: Number(off.getAttribute("y") ?? 0) / EMU_PER_INCH, w: Number(ext.getAttribute("cx") ?? 0) / EMU_PER_INCH, h: Number(ext.getAttribute("cy") ?? 0) / EMU_PER_INCH };
}

function styleTokens(root: Element): Set<string> {
  return new Set([
    ...["latin", "ea", "cs"].flatMap((name) => all(root, A_NS, name).map((node) => `font:${node.getAttribute("typeface") ?? ""}`)),
    ...all(root, A_NS, "srgbClr").map((node) => `color:${node.getAttribute("val") ?? ""}`),
    ...all(root, A_NS, "schemeClr").map((node) => `scheme:${node.getAttribute("val") ?? ""}`),
  ]);
}

function structural(component: TemplateComponent): boolean {
  return Boolean(component.offCanvasHelper) || component.semanticRoles.some((role) => ["surface", "divider", "footer", "logo"].includes(role));
}

function matchesComponentName(outputName: string, sourceName: string): boolean {
  return outputName === sourceName || outputName.startsWith(`${sourceName}__adaptive_clone_`);
}

function add(findings: AdaptiveQaFinding[], code: AdaptiveQaCode, message: string): void {
  findings.push({ severity: "hard", code, message });
}

export function normalizeAdaptiveText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function hasExactAdaptiveTextNode(textNodes: string[], expected: string): boolean {
  const normalizedExpected = normalizeAdaptiveText(expected);
  return textNodes.some((text) => normalizeAdaptiveText(text) === normalizedExpected);
}

export async function runAdaptiveQa(input: AdaptiveQaInput): Promise<AdaptiveQaReport> {
  const findings: AdaptiveQaFinding[] = [];
  const epsilon = 2 / EMU_PER_INCH;
  if (!input.components.coordinateSpace) add(findings, "TEMPLATE_COMPONENT_PROVENANCE_MISSING", "Adaptive QA requires canonical template coordinate-space metadata.");
  const sourcePart = input.components.components[0]?.sourceSlidePart;
  if (!sourcePart) return { status: "fail", findings: [...findings, { severity: "hard", code: "TEMPLATE_COMPONENT_PROVENANCE_MISSING", message: "Component catalog has no source slide part." }] };
  const sourceZip = await JSZip.loadAsync(fs.readFileSync(path.resolve(input.templatePath)));
  const outputZip = await JSZip.loadAsync(fs.readFileSync(path.resolve(input.outputPath)));
  const sourceXml = await sourceZip.file(sourcePart)?.async("string");
  const outputXml = await outputZip.file(sourcePart)?.async("string");
  if (!sourceXml || !outputXml) return { status: "fail", findings: [...findings, { severity: "hard", code: "TEMPLATE_COMPONENT_PROVENANCE_MISSING", message: `Source/output slide part '${sourcePart}' is missing.` }] };
  const sourceRoot = first(parse(sourceXml), P_NS, "spTree");
  const outputRoot = first(parse(outputXml), P_NS, "spTree");
  if (!sourceRoot || !outputRoot) return { status: "fail", findings: [...findings, { severity: "hard", code: "TEMPLATE_COMPONENT_PROVENANCE_MISSING", message: "Source/output slide shape tree is missing." }] };

  const sourceNodes = slideNodes(sourceRoot);
  const outputNodes = slideNodes(outputRoot);
  const sourceNames = new Set(input.components.components.flatMap((component) => component.shapeNames));
  const outputNames = new Set(outputNodes.map(nameOf));
  const byId = new Map(input.components.components.map((component) => [component.id, component]));
  const plannedTexts = new Set(input.plan.textAllocation.map((allocation) => allocation.text));

  for (const placement of input.plan.placements) {
    const component = byId.get(placement.componentId);
    if (!component) {
      add(findings, "TEMPLATE_COMPONENT_PROVENANCE_MISSING", `Plan placement '${placement.blockId}' references unknown component '${placement.componentId}'.`);
      continue;
    }
    if (component.offCanvasHelper || component.grouped || component.kind === "unknown") add(findings, "ADAPTIVE_COMPONENT_UNSUPPORTED", `Plan placement '${placement.blockId}' uses unsupported component '${component.id}'.`);
    if (component.shapeNames.length !== 1 || !outputNames.has(component.shapeNames[0]) && ![...outputNames].some((name) => matchesComponentName(name, component.shapeNames[0] ?? ""))) add(findings, "TEMPLATE_COMPONENT_PROVENANCE_MISSING", `Plan placement '${placement.blockId}' cannot be traced to source component '${component.id}'.`);
  }
  if (input.plan.media) {
    const media = byId.get(input.plan.media.componentId);
    if (!media || media.kind !== "media_frame" || media.shapeNames.length !== 1) add(findings, "ADAPTIVE_COMPONENT_UNSUPPORTED", "Adaptive media placement does not reference a single native media_frame component.");
  }

  for (const node of outputNodes) {
    const name = nameOf(node);
    const helper = input.components.components.some((component) => component.offCanvasHelper && component.shapeNames.includes(name));
    if (name && !helper && ![...sourceNames].some((sourceName) => matchesComponentName(name, sourceName))) add(findings, "TEMPLATE_COMPONENT_PROVENANCE_MISSING", `Output visual object '${name}' has no source component provenance.`);
    if (helper) continue;
    const rect = rectOf(node);
    if (rect && (rect.x < -epsilon || rect.y < -epsilon || rect.x + rect.w > input.components.canvas.w + epsilon || rect.y + rect.h > input.components.canvas.h + epsilon)) add(findings, "ADAPTIVE_GEOMETRY_OVERFLOW", `Output visual object '${name || "(unnamed)"}' escaped the template canvas: ${JSON.stringify(rect)}.`);
  }

  const outputTextNodes = outputNodes.map(textOf).filter((text) => normalizeAdaptiveText(text).length > 0);
  input.plan.textAllocation.forEach((allocation) => { if (!hasExactAdaptiveTextNode(outputTextNodes, allocation.text)) add(findings, "ADAPTIVE_CONTENT_DROPPED", `Adaptive content block '${allocation.blockId}' did not reach an output text node exactly.`); });
  for (const component of input.components.components.filter((candidate) => !candidate.offCanvasHelper && !structural(candidate))) {
    const sourceTexts = sourceNodes.filter((node) => component.shapeNames.includes(nameOf(node))).map(textOf).filter((text) => text.length > 0);
    sourceTexts.forEach((text) => { if (!plannedTexts.has(text) && outputTextNodes.includes(text)) add(findings, "ADAPTIVE_EXAMPLE_CONTENT_LEAK", `Template example text survived: '${text}'.`); });
    if (component.assetProvenance.kind !== "none" && component.id !== input.plan.media?.componentId && outputNodes.some((node) => component.shapeNames.includes(nameOf(node)))) add(findings, "ADAPTIVE_EXAMPLE_CONTENT_LEAK", `Template example media survived: '${component.id}'.`);
  }

  const sourceStyles = styleTokens(sourceRoot);
  const novel = [...styleTokens(outputRoot)].filter((token) => !sourceStyles.has(token));
  if (novel.length > 0) add(findings, "TEMPLATE_STYLE_SOURCE_VIOLATION", `Output contains style tokens absent from the source template: ${novel.join(", ")}.`);
  const facts = await readPptxOoxml(input.outputPath);
  if (!facts.parseOk || facts.slideCount !== 1) add(findings, "ADAPTIVE_COMPONENT_UNSUPPORTED", "Adaptive output is not a parseable single-slide PPTX.");
  return { status: findings.length > 0 ? "fail" : "pass", findings };
}
