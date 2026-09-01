import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { readPptxOoxml } from "./ooxml";
import type { ResolvedScene } from "./scene";
import type { SceneComponentPlan } from "./scene-components";
import type { TemplateComponentsArtifact, TemplateComponent } from "./template-components";
import type { TemplateElementsArtifact } from "./template-analysis";

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const EMU_PER_INCH = 914400;

export const sceneQaCodes = [
  "SCENE_COMPONENT_PROVENANCE_MISSING",
  "SCENE_CONTENT_DROPPED",
  "SCENE_GEOMETRY_OVERFLOW",
  "SCENE_GEOMETRY_DRIFT",
  "SCENE_TEXT_OVERLAP",
  "SCENE_EXAMPLE_CONTENT_LEAK",
  "SCENE_STYLE_SOURCE_VIOLATION",
  "SCENE_COMPONENT_UNSUPPORTED",
] as const;
export type SceneQaCode = (typeof sceneQaCodes)[number];
export type SceneQaFinding = { severity: "hard"; code: SceneQaCode; message: string };
export type SceneQaReport = { status: "pass" | "fail"; findings: SceneQaFinding[] };
export type SceneQaInput = {
  templatePath: string;
  outputPath: string;
  scene: ResolvedScene;
  componentPlan: SceneComponentPlan;
  components: TemplateComponentsArtifact;
  elements: TemplateElementsArtifact;
};

type Rect = { x: number; y: number; w: number; h: number };

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

function rectOf(node: Element): Rect | undefined {
  const xfrm = first(node, A_NS, "xfrm") ?? first(node, P_NS, "xfrm");
  const off = xfrm ? first(xfrm, A_NS, "off") : undefined;
  const ext = xfrm ? first(xfrm, A_NS, "ext") : undefined;
  if (!off || !ext) return undefined;
  return {
    x: Number(off.getAttribute("x") ?? 0) / EMU_PER_INCH,
    y: Number(off.getAttribute("y") ?? 0) / EMU_PER_INCH,
    w: Number(ext.getAttribute("cx") ?? 0) / EMU_PER_INCH,
    h: Number(ext.getAttribute("cy") ?? 0) / EMU_PER_INCH,
  };
}

function styleTokens(root: Element): Set<string> {
  return new Set([
    ...["latin", "ea", "cs"].flatMap((name) => all(root, A_NS, name).map((node) => `font:${node.getAttribute("typeface") ?? ""}`)),
    ...all(root, A_NS, "srgbClr").map((node) => `color:${node.getAttribute("val") ?? ""}`),
    ...all(root, A_NS, "schemeClr").map((node) => `scheme:${node.getAttribute("val") ?? ""}`),
  ]);
}

async function onlyVisibleSlidePart(zip: JSZip): Promise<string | undefined> {
  const presentationXml = await zip.file("ppt/presentation.xml")?.async("string");
  const relsXml = await zip.file("ppt/_rels/presentation.xml.rels")?.async("string");
  if (!presentationXml || !relsXml) return undefined;
  const targets = new Map(all(parse(relsXml), REL_NS, "Relationship").map((node) => [node.getAttribute("Id") ?? "", node.getAttribute("Target") ?? ""]));
  const slideIds = all(parse(presentationXml), P_NS, "sldId");
  if (slideIds.length !== 1) return undefined;
  const target = targets.get(slideIds[0].getAttributeNS(R_NS, "id") ?? "");
  if (!target) return undefined;
  return target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join("ppt", target));
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function matchesComponentName(outputName: string, sourceName: string): boolean {
  return outputName === sourceName || outputName.startsWith(`${sourceName}__adaptive_clone_`);
}

function add(findings: SceneQaFinding[], code: SceneQaCode, message: string): void {
  findings.push({ severity: "hard", code, message });
}

function intersects(left: Rect, right: Rect, epsilon: number): boolean {
  return Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x) > epsilon
    && Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y) > epsilon;
}

function rectDistance(left: Rect, right: Rect): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y) + Math.abs(left.w - right.w) + Math.abs(left.h - right.h);
}

async function sourceRoot(zip: JSZip, component: TemplateComponent): Promise<Element | undefined> {
  const xml = await zip.file(component.sourceSlidePart)?.async("string");
  return xml ? first(parse(xml), P_NS, "spTree") : undefined;
}

export async function runSceneQa(input: SceneQaInput): Promise<SceneQaReport> {
  const findings: SceneQaFinding[] = [];
  const epsilon = 4 / EMU_PER_INCH;
  const byId = new Map(input.components.components.map((component) => [component.id, component]));
  const base = input.elements.slides.find((slide) => slide.id === input.componentPlan.targetSlideId);
  if (!base) add(findings, "SCENE_COMPONENT_PROVENANCE_MISSING", `Scene base '${input.componentPlan.targetSlideId}' is absent from template extraction.`);
  if (input.componentPlan.provenance.length !== input.scene.nodes.length + 1) add(findings, "SCENE_COMPONENT_PROVENANCE_MISSING", "Scene component provenance must cover the headline and every semantic scene node exactly once.");

  for (const entry of input.componentPlan.provenance) {
    const component = byId.get(entry.componentId);
    if (!component || component.sourceSlideId !== entry.sourceSlideId || component.shapeNames.length !== 1) add(findings, "SCENE_COMPONENT_PROVENANCE_MISSING", `Scene node '${entry.sceneNodeId}' has invalid source component provenance '${entry.componentId}'.`);
    const bounds = entry.bounds;
    if (bounds.x < input.scene.frame.x - epsilon || bounds.y < input.scene.frame.y - epsilon || bounds.x + bounds.w > input.scene.frame.x + input.scene.frame.w + epsilon || bounds.y + bounds.h > input.scene.frame.y + input.scene.frame.h + epsilon) add(findings, "SCENE_GEOMETRY_OVERFLOW", `Scene node '${entry.sceneNodeId}' escaped the resolved content frame.`);
  }
  for (let index = 0; index < input.componentPlan.provenance.length; index += 1) {
    for (let other = index + 1; other < input.componentPlan.provenance.length; other += 1) {
      const left = input.componentPlan.provenance[index];
      const right = input.componentPlan.provenance[other];
      if (intersects(left.bounds, right.bounds, epsilon)) add(findings, "SCENE_TEXT_OVERLAP", `Scene text '${left.sceneNodeId}' overlaps '${right.sceneNodeId}'.`);
    }
  }

  const templateZip = await JSZip.loadAsync(fs.readFileSync(path.resolve(input.templatePath)));
  const outputZip = await JSZip.loadAsync(fs.readFileSync(path.resolve(input.outputPath)));
  const outputPart = await onlyVisibleSlidePart(outputZip);
  const outputXml = outputPart ? await outputZip.file(outputPart)?.async("string") : undefined;
  const outputRoot = outputXml ? first(parse(outputXml), P_NS, "spTree") : undefined;
  if (!outputRoot) return { status: "fail", findings: [...findings, { severity: "hard", code: "SCENE_COMPONENT_UNSUPPORTED", message: "Scene output is not a readable single visible slide." }] };
  const outputNodes = slideNodes(outputRoot);
  const outputNames = outputNodes.map(nameOf);
  const allSourceNames = input.components.components.flatMap((component) => component.shapeNames);

  for (const outputNode of outputNodes) {
    const name = nameOf(outputNode);
    if (name && !allSourceNames.some((sourceName) => matchesComponentName(name, sourceName))) add(findings, "SCENE_COMPONENT_PROVENANCE_MISSING", `Output object '${name}' has no raw-template component provenance.`);
    const rect = rectOf(outputNode);
    if (rect && (rect.x < -epsilon || rect.y < -epsilon || rect.x + rect.w > input.components.canvas.w + epsilon || rect.y + rect.h > input.components.canvas.h + epsilon)) add(findings, "SCENE_GEOMETRY_OVERFLOW", `Output object '${name || "(unnamed)"}' escaped the template canvas.`);
  }

  const usedOutputNodes = new Set<Element>();
  for (const entry of input.componentPlan.provenance) {
    const component = byId.get(entry.componentId);
    if (!component) continue;
    const sourceName = component.shapeNames[0];
    const candidates = outputNodes.filter((node) => !usedOutputNodes.has(node) && matchesComponentName(nameOf(node), sourceName) && normalize(textOf(node)) === entry.text);
    const selected = candidates.map((node) => ({ node, rect: rectOf(node) })).filter((candidate): candidate is { node: Element; rect: Rect } => Boolean(candidate.rect)).sort((left, right) => rectDistance(left.rect, entry.bounds) - rectDistance(right.rect, entry.bounds))[0];
    if (!selected) {
      add(findings, "SCENE_CONTENT_DROPPED", `Scene node '${entry.sceneNodeId}' did not reach an output text object with its source provenance.`);
      continue;
    }
    usedOutputNodes.add(selected.node);
    if (rectDistance(selected.rect, entry.bounds) > 0.02) add(findings, "SCENE_GEOMETRY_DRIFT", `Scene node '${entry.sceneNodeId}' rendered outside its resolved Scene IR bounds.`);
  }

  const intendedTexts = new Set(input.componentPlan.provenance.map((entry) => entry.text));
  const sourceComponentIds = new Set<string>();
  for (const operation of input.componentPlan.operations) if (operation.operation === "clone" || operation.operation === "remove") sourceComponentIds.add(operation.componentId);
  const roots = new Map<string, Element>();
  const sourceStyleTokens = new Set<string>();
  for (const componentId of sourceComponentIds) {
    const component = byId.get(componentId);
    if (!component) {
      add(findings, "SCENE_COMPONENT_PROVENANCE_MISSING", `Scene operation references unknown source component '${componentId}'.`);
      continue;
    }
    let root = roots.get(component.sourceSlidePart);
    if (!root) {
      root = await sourceRoot(templateZip, component);
      if (root) roots.set(component.sourceSlidePart, root);
    }
    if (!root) {
      add(findings, "SCENE_COMPONENT_PROVENANCE_MISSING", `Source slide part '${component.sourceSlidePart}' is missing for '${component.id}'.`);
      continue;
    }
    styleTokens(root).forEach((token) => sourceStyleTokens.add(token));
    const sourceTexts = slideNodes(root).filter((node) => component.shapeNames.includes(nameOf(node))).map((node) => normalize(textOf(node))).filter(Boolean);
    for (const sourceText of sourceTexts) {
      if (!intendedTexts.has(sourceText) && outputNodes.some((node) => normalize(textOf(node)) === sourceText)) add(findings, "SCENE_EXAMPLE_CONTENT_LEAK", `Template example text survived Scene authoring: '${sourceText}'.`);
    }
  }
  if (base) {
    const baseXml = await templateZip.file(base.sourceSlidePart)?.async("string");
    const baseRoot = baseXml ? first(parse(baseXml), P_NS, "spTree") : undefined;
    if (baseRoot) styleTokens(baseRoot).forEach((token) => sourceStyleTokens.add(token));
  }
  const novelStyles = [...styleTokens(outputRoot)].filter((token) => !sourceStyleTokens.has(token));
  if (novelStyles.length > 0) add(findings, "SCENE_STYLE_SOURCE_VIOLATION", `Scene output contains style tokens absent from its template-native source components/base: ${novelStyles.join(", ")}.`);

  const removedSourceNames = input.componentPlan.operations.filter((operation): operation is Extract<(typeof input.componentPlan.operations)[number], { operation: "remove" }> => operation.operation === "remove").map((operation) => byId.get(operation.componentId)?.shapeNames[0]).filter((name): name is string => Boolean(name));
  for (const sourceName of removedSourceNames) if (outputNames.includes(sourceName)) add(findings, "SCENE_EXAMPLE_CONTENT_LEAK", `Removed base example object '${sourceName}' survived Scene authoring.`);

  const facts = await readPptxOoxml(input.outputPath);
  if (!facts.parseOk || facts.slideCount !== 1) add(findings, "SCENE_COMPONENT_UNSUPPORTED", "Scene output must be a parseable single-slide PPTX.");
  return { status: findings.length > 0 ? "fail" : "pass", findings };
}
