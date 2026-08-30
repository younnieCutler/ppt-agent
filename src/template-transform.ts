import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { pruneUnreachablePptxParts } from "./ooxml";
import type { TemplateComponent, TemplateComponentsArtifact } from "./template-components";
import { canonicalizeRect } from "./template-analysis";

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const EMU_PER_INCH = 914400;

type Rect = { x: number; y: number; w: number; h: number };
type SlideState = { id: string; partPath: string; document: Document; relationships: Document };
type ComponentHandle = { componentId: string; slideId: string; partPath: string; node?: Element; component?: TemplateComponent };

function physicalPath(filePath: string): string {
  const absolute = path.resolve(filePath);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
  }
}

export type ComponentTransformOperation =
  | { operation: "clone"; componentId: string; targetSlideId?: string; as?: string }
  | { operation: "move"; componentId: string; x: number; y: number }
  | { operation: "resize"; componentId: string; w: number; h: number }
  | { operation: "repeat"; componentId: string; count: number; offset: { x: number; y: number }; targetSlideId?: string; as?: string }
  | { operation: "remove"; componentId: string }
  | { operation: "replace_text"; componentId: string; text: string };

export type ComponentTransformResult = { outputPath: string; appliedOperations: number; createdComponents: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteField(value: unknown, field: string, index: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`COMPONENT_TRANSFORM_INVALID: operation ${index} requires a finite numeric '${field}'.`);
  return value;
}

function optionalString(value: unknown, field: string, index: number): void {
  if (value !== undefined && (typeof value !== "string" || value.length === 0)) throw new Error(`COMPONENT_TRANSFORM_INVALID: operation ${index} requires '${field}' to be a non-empty string when provided.`);
}

function assertOperationFields(input: Record<string, unknown>, allowed: readonly string[], index: number): void {
  const unsupported = Object.keys(input).find((field) => !allowed.includes(field));
  if (unsupported) throw new Error(`COMPONENT_TRANSFORM_INVALID: operation ${index} has unsupported field '${unsupported}'.`);
}

function validateOperation(input: unknown, index: number): ComponentTransformOperation {
  if (!isRecord(input) || typeof input.operation !== "string" || typeof input.componentId !== "string" || input.componentId.length === 0) throw new Error(`COMPONENT_TRANSFORM_INVALID: operation ${index} requires an operation name and semantic componentId.`);
  switch (input.operation) {
    case "clone":
      assertOperationFields(input, ["operation", "componentId", "targetSlideId", "as"], index);
      optionalString(input.targetSlideId, "targetSlideId", index);
      optionalString(input.as, "as", index);
      return input as ComponentTransformOperation;
    case "move":
      assertOperationFields(input, ["operation", "componentId", "x", "y"], index);
      finiteField(input.x, "x", index);
      finiteField(input.y, "y", index);
      return input as ComponentTransformOperation;
    case "resize":
      assertOperationFields(input, ["operation", "componentId", "w", "h"], index);
      finiteField(input.w, "w", index);
      finiteField(input.h, "h", index);
      return input as ComponentTransformOperation;
    case "repeat":
      assertOperationFields(input, ["operation", "componentId", "count", "offset", "targetSlideId", "as"], index);
      optionalString(input.targetSlideId, "targetSlideId", index);
      optionalString(input.as, "as", index);
      if (typeof input.count !== "number" || !Number.isInteger(input.count) || input.count < 1 || input.count > 100) throw new Error(`COMPONENT_TRANSFORM_INVALID: operation ${index} repeat count must be an integer from 1 to 100.`);
      if (!isRecord(input.offset)) throw new Error(`COMPONENT_TRANSFORM_INVALID: operation ${index} repeat requires an offset object.`);
      finiteField(input.offset.x, "offset.x", index);
      finiteField(input.offset.y, "offset.y", index);
      return input as ComponentTransformOperation;
    case "replace_text":
      assertOperationFields(input, ["operation", "componentId", "text"], index);
      if (typeof input.text !== "string") throw new Error(`COMPONENT_TRANSFORM_INVALID: operation ${index} replace_text requires a string text.`);
      if (/[\r\n]/.test(input.text)) throw new Error(`COMPONENT_TRANSFORM_INVALID: operation ${index} replace_text text must not contain a newline.`);
      return input as ComponentTransformOperation;
    case "remove":
      assertOperationFields(input, ["operation", "componentId"], index);
      return input as ComponentTransformOperation;
    default:
      throw new Error(`COMPONENT_TRANSFORM_INVALID: unsupported operation '${input.operation}'.`);
  }
}

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
}

function serializeXml(document: Document): string {
  return new XMLSerializer().serializeToString(document as unknown as Parameters<XMLSerializer["serializeToString"]>[0]);
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

function relationshipPath(partPath: string): string {
  return path.posix.join(path.posix.dirname(partPath), "_rels", `${path.posix.basename(partPath)}.rels`);
}

function packagePath(base: string, target: string): string {
  return target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join(base, target));
}

function relativeTarget(sourcePart: string, targetPart: string): string {
  return path.posix.relative(path.posix.dirname(sourcePart), targetPart);
}

function relationshipId(attribute: Attr): string | undefined {
  return attribute.namespaceURI === R_NS ? attribute.value : undefined;
}

function relationshipAttributes(node: Element): Attr[] {
  const attributes: Attr[] = [];
  for (let index = 0; index < node.attributes.length; index += 1) {
    const attribute = node.attributes.item(index);
    if (attribute) attributes.push(attribute as unknown as Attr);
  }
  return attributes;
}

function relById(document: Document, id: string): Element | undefined {
  return all(document, REL_NS, "Relationship").find((relationship) => relationship.getAttribute("Id") === id);
}

function nodeName(node: Element): string {
  return first(node, P_NS, "cNvPr")?.getAttribute("name") ?? "";
}

function componentNodes(tree: Element, names: string[]): Array<{ node: Element; grouped: boolean }> {
  const wanted = new Set(names);
  const found: Array<{ node: Element; grouped: boolean }> = [];
  const visit = (nodes: Element[], grouped: boolean): void => {
    for (const node of nodes) {
      if (node.localName === "grpSp") {
        visit(children(node), true);
        continue;
      }
      if (["sp", "pic", "graphicFrame", "cxnSp"].includes(node.localName ?? "") && wanted.has(nodeName(node))) found.push({ node, grouped });
    }
  };
  visit(children(tree), false);
  return found;
}

function slideTree(document: Document, partPath: string): Element {
  const tree = first(document, P_NS, "spTree");
  if (!tree) throw new Error(`Component transform requires a slide shape tree: ${partPath}`);
  return tree;
}

function xfrmFor(node: Element, partPath: string): Element {
  const xfrm = first(node, A_NS, "xfrm") ?? first(node, P_NS, "xfrm");
  if (!xfrm || !first(xfrm, A_NS, "off") || !first(xfrm, A_NS, "ext")) throw new Error(`ADAPTIVE_COMPONENT_UNSUPPORTED: component shape has no transformable bounds in ${partPath}.`);
  return xfrm;
}

function rectFor(node: Element, partPath: string): Rect {
  const xfrm = xfrmFor(node, partPath);
  const off = first(xfrm, A_NS, "off")!;
  const ext = first(xfrm, A_NS, "ext")!;
  return {
    x: Number(off.getAttribute("x") ?? 0) / EMU_PER_INCH,
    y: Number(off.getAttribute("y") ?? 0) / EMU_PER_INCH,
    w: Number(ext.getAttribute("cx") ?? 0) / EMU_PER_INCH,
    h: Number(ext.getAttribute("cy") ?? 0) / EMU_PER_INCH,
  };
}

function setRect(node: Element, partPath: string, rect: Rect): void {
  const xfrm = xfrmFor(node, partPath);
  const off = first(xfrm, A_NS, "off")!;
  const ext = first(xfrm, A_NS, "ext")!;
  off.setAttribute("x", String(Math.round(rect.x * EMU_PER_INCH)));
  off.setAttribute("y", String(Math.round(rect.y * EMU_PER_INCH)));
  ext.setAttribute("cx", String(Math.round(rect.w * EMU_PER_INCH)));
  ext.setAttribute("cy", String(Math.round(rect.h * EMU_PER_INCH)));
}

function ensureFiniteRect(rect: Rect, operation: string): void {
  if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) || rect.x < 0 || rect.y < 0 || rect.w < 0 || rect.h < 0 || rect.w + rect.h <= 0) {
    throw new Error(`COMPONENT_TRANSFORM_INVALID: ${operation} produced a non-finite or empty rectangle.`);
  }
}

function ensureInsideCanvas(rect: Rect, canvas: Rect, operation: string): void {
  ensureFiniteRect(rect, operation);
  const x = Math.round(rect.x * EMU_PER_INCH);
  const y = Math.round(rect.y * EMU_PER_INCH);
  const w = Math.round(rect.w * EMU_PER_INCH);
  const h = Math.round(rect.h * EMU_PER_INCH);
  const canvasW = Math.round(canvas.w * EMU_PER_INCH);
  const canvasH = Math.round(canvas.h * EMU_PER_INCH);
  if (x < 0 || y < 0 || w < 0 || h < 0 || x + w > canvasW || y + h > canvasH) {
    throw new Error(`COMPONENT_TRANSFORM_OUT_OF_BOUNDS: ${operation} produced ${JSON.stringify(rect)} outside the ${canvas.w}x${canvas.h}in canvas.`);
  }
}

function nextShapeId(document: Document | Element): number {
  return Math.max(1, ...all(document, P_NS, "cNvPr").map((node) => Number(node.getAttribute("id") ?? 0)).filter(Number.isFinite)) + 1;
}

function uniqueCloneName(tree: Element, base: string, sequence: number): string {
  const names = new Set(all(tree, P_NS, "cNvPr").map((node) => node.getAttribute("name") ?? ""));
  let name = `${base || "component"}__adaptive_clone_${sequence}`;
  while (names.has(name)) name = `${name}_1`;
  return name;
}

function renameCloneIds(clone: Element, tree: Element, name: string): void {
  let id = nextShapeId(tree);
  for (const property of all(clone, P_NS, "cNvPr")) {
    property.setAttribute("id", String(id));
    id += 1;
  }
  const rootName = first(clone, P_NS, "cNvPr");
  if (rootName) rootName.setAttribute("name", name);
}

async function loadSlide(zip: JSZip, id: string, partPath: string): Promise<SlideState> {
  const xml = await zip.file(partPath)?.async("string");
  if (xml === undefined) throw new Error(`Component transform slide is missing: ${partPath}`);
  const relXml = await zip.file(relationshipPath(partPath))?.async("string");
  if (!relXml) throw new Error(`Component transform slide relationships are missing: ${relationshipPath(partPath)}`);
  return { id, partPath, document: parseXml(xml), relationships: parseXml(relXml) };
}

function findHandleNode(handle: ComponentHandle): Element {
  const node = handle.node;
  if (node?.parentNode) return node;
  throw new Error(`ADAPTIVE_COMPONENT_UNSUPPORTED: component '${handle.componentId}' is no longer on its slide.`);
}

function componentNodeFor(state: SlideState, component: TemplateComponent): Element {
  if (component.shapeNames.length !== 1) throw new Error(`ADAPTIVE_COMPONENT_UNSUPPORTED: component '${component.id}' contains ${component.shapeNames.length} shapes; grouped component transforms are not supported in Goal 3.`);
  const matches = componentNodes(slideTree(state.document, state.partPath), component.shapeNames);
  if (matches.length !== 1) throw new Error(`ADAPTIVE_COMPONENT_PROVENANCE_MISSING: component '${component.id}' does not resolve to exactly one source shape on ${component.sourceSlideId}.`);
  if (matches[0].grouped) throw new Error(`ADAPTIVE_COMPONENT_UNSUPPORTED: grouped component '${component.id}' requires coordinate canonicalization in Goal 3.5.`);
  return matches[0].node;
}

function usedRelationshipIds(document: Document): Set<string> {
  const used = new Set<string>();
  const visit = (node: Element): void => {
    for (const attribute of relationshipAttributes(node)) {
      const id = relationshipId(attribute);
      if (id) used.add(id);
    }
    for (const child of children(node)) visit(child);
  };
  visit(document.documentElement);
  return used;
}

function isContentRelationship(type: string): boolean {
  return !["/slideLayout", "/notesSlide", "/comments", "/tags", "/slideMaster"].some((suffix) => type.endsWith(suffix));
}

function cleanupRelationships(state: SlideState): void {
  const used = usedRelationshipIds(state.document);
  for (const relationship of all(state.relationships, REL_NS, "Relationship")) {
    const id = relationship.getAttribute("Id") ?? "";
    if (!used.has(id) && isContentRelationship(relationship.getAttribute("Type") ?? "")) relationship.parentNode?.removeChild(relationship);
  }
}

function relationshipTargetPart(sourcePart: string, relationship: Element): string | undefined {
  if (relationship.getAttribute("TargetMode") === "External") return undefined;
  const target = relationship.getAttribute("Target");
  return target ? packagePath(path.posix.dirname(sourcePart), target) : undefined;
}

function findOrCreateRelationship(source: SlideState, target: SlideState, relationship: Element, zip: JSZip): string {
  const sourceTarget = relationshipTargetPart(source.partPath, relationship);
  const sourceType = relationship.getAttribute("Type") ?? "";
  const sourceMode = relationship.getAttribute("TargetMode") ?? "";
  if (!sourceTarget && sourceMode !== "External") throw new Error(`COMPONENT_RELATION_MISSING: relationship '${relationship.getAttribute("Id") ?? ""}' has no target.`);
  const existing = all(target.relationships, REL_NS, "Relationship").find((candidate) => {
    const candidateTarget = relationshipTargetPart(target.partPath, candidate);
    return candidate.getAttribute("Type") === sourceType && (candidate.getAttribute("TargetMode") ?? "") === sourceMode && candidateTarget === sourceTarget && (sourceMode === "External" ? candidate.getAttribute("Target") === relationship.getAttribute("Target") : true);
  });
  if (existing) return existing.getAttribute("Id") ?? "";
  if (sourceTarget && !zip.file(sourceTarget)) throw new Error(`COMPONENT_RELATION_MISSING: relationship target '${sourceTarget}' is absent from the PPTX package.`);
  const usedIds = new Set(all(target.relationships, REL_NS, "Relationship").map((candidate) => candidate.getAttribute("Id") ?? ""));
  let index = 1;
  let id = `rId${index}`;
  while (usedIds.has(id)) {
    index += 1;
    id = `rId${index}`;
  }
  const created = target.relationships.createElementNS(REL_NS, "Relationship");
  created.setAttribute("Id", id);
  created.setAttribute("Type", sourceType);
  if (sourceMode === "External") {
    created.setAttribute("Target", relationship.getAttribute("Target") ?? "");
    created.setAttribute("TargetMode", sourceMode);
  } else {
    created.setAttribute("Target", relativeTarget(target.partPath, sourceTarget!));
  }
  target.relationships.documentElement.appendChild(created);
  return id;
}

function remapCloneRelationships(clone: Element, source: SlideState, target: SlideState, zip: JSZip): void {
  if (source.partPath === target.partPath) return;
  const visit = (node: Element): void => {
    for (const attribute of relationshipAttributes(node)) {
      const id = relationshipId(attribute);
      if (!id) continue;
      const relationship = relById(source.relationships, id);
      if (!relationship) throw new Error(`COMPONENT_RELATION_MISSING: source slide relationship '${id}' is not defined.`);
      attribute.value = findOrCreateRelationship(source, target, relationship, zip);
    }
    for (const child of children(node)) visit(child);
  };
  visit(clone);
}

function canvasFromPresentation(document: Document): Rect {
  const size = first(document, P_NS, "sldSz");
  const w = Number(size?.getAttribute("cx") ?? 0) / EMU_PER_INCH;
  const h = Number(size?.getAttribute("cy") ?? 0) / EMU_PER_INCH;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error("COMPONENT_TRANSFORM_INVALID: PPTX has no usable p:sldSz canvas.");
  return { x: 0, y: 0, w, h };
}

function slidesFromPresentation(presentationXml: string, relationshipsXml: string): Map<string, { id: string; sourceSlidePart: string }> {
  const presentation = parseXml(presentationXml);
  const relationships = parseXml(relationshipsXml);
  const targets = new Map(all(relationships, REL_NS, "Relationship").map((relationship) => [relationship.getAttribute("Id") ?? "", relationship.getAttribute("Target") ?? ""]));
  return new Map(all(presentation, P_NS, "sldId").map((slideId, index) => {
    const target = targets.get(slideId.getAttributeNS(R_NS, "id") ?? "");
    if (!target) throw new Error(`ADAPTIVE_COMPONENT_PROVENANCE_MISSING: presentation slide ${index + 1} has no relationship target.`);
    const id = `S${String(index + 1).padStart(2, "0")}`;
    return [id, { id, sourceSlidePart: packagePath("ppt", target) }] as const;
  }));
}

function replaceText(node: Element, text: string, componentId: string): void {
  if (node.namespaceURI !== P_NS || node.localName !== "sp") throw new Error(`ADAPTIVE_COMPONENT_UNSUPPORTED: component '${componentId}' is not a text shape.`);
  const runs = all(node, A_NS, "t");
  if (runs.length === 0) throw new Error(`ADAPTIVE_COMPONENT_UNSUPPORTED: component '${componentId}' has no text runs.`);
  if (runs.some((run) => /[\r\n]/.test(run.textContent ?? ""))) throw new Error(`ADAPTIVE_COMPONENT_UNSUPPORTED: component '${componentId}' has rich or multiline text that cannot be replaced losslessly.`);
  if (all(node, A_NS, "r").length !== 1 || all(node, A_NS, "p").length !== 1 || all(node, A_NS, "fld").length > 0 || all(node, A_NS, "br").length > 0 || all(node, A_NS, "tab").length > 0) {
    throw new Error(`ADAPTIVE_COMPONENT_UNSUPPORTED: component '${componentId}' has rich or multiline text that cannot be replaced losslessly.`);
  }
  runs[0].textContent = text;
  runs.slice(1).forEach((run) => { run.textContent = ""; });
}

async function validatePackageRelationships(pptxPath: string): Promise<void> {
  const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
  const presentationXml = await zip.file("ppt/presentation.xml")?.async("string");
  const presentationRelationshipsXml = await zip.file("ppt/_rels/presentation.xml.rels")?.async("string");
  if (!presentationXml || !presentationRelationshipsXml) throw new Error("COMPONENT_RELATION_MISSING: presentation package is incomplete.");
  const partPaths = [...slidesFromPresentation(presentationXml, presentationRelationshipsXml).values()].map((slide) => slide.sourceSlidePart);
  for (const partPath of partPaths) {
    const xml = await zip.file(partPath)?.async("string");
    const relXml = await zip.file(relationshipPath(partPath))?.async("string");
    if (!xml || !relXml) throw new Error(`COMPONENT_RELATION_MISSING: slide package is incomplete for ${partPath}.`);
    const document = parseXml(xml);
    const relationships = parseXml(relXml);
    for (const id of usedRelationshipIds(document)) {
      const relationship = relById(relationships, id);
      if (!relationship) throw new Error(`COMPONENT_RELATION_MISSING: ${partPath} references undefined relationship '${id}'.`);
      const target = relationshipTargetPart(partPath, relationship);
      if (target && !zip.file(target)) throw new Error(`COMPONENT_RELATION_MISSING: ${partPath} relationship '${id}' targets missing '${target}'.`);
    }
  }
}

export async function transformTemplateComponents(
  templatePath: string,
  outputPath: string,
  artifact: TemplateComponentsArtifact,
  operations: ComponentTransformOperation[],
): Promise<ComponentTransformResult> {
  if (!Array.isArray(operations)) throw new Error("COMPONENT_TRANSFORM_INVALID: operations must be an array.");
  const checkedOperations = operations.map(validateOperation);
  const sourcePath = path.resolve(templatePath);
  const resolvedOutput = path.resolve(outputPath);
  if (!fs.existsSync(sourcePath)) throw new Error(`Template not found: ${sourcePath}`);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  if (physicalPath(sourcePath) === physicalPath(resolvedOutput)) throw new Error("COMPONENT_TRANSFORM_SOURCE_IMMUTABLE: outputPath must differ from the source template path.");
  const sourceDigest = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
  if (sourceDigest !== artifact.sourceDigest) throw new Error(`COMPONENT_CATALOG_SOURCE_MISMATCH: catalog describes ${artifact.sourceDigest}, but template is ${sourceDigest}.`);

  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const presentationXml = await zip.file("ppt/presentation.xml")?.async("string");
  if (!presentationXml) throw new Error("Component transform requires ppt/presentation.xml.");
  const presentationRelationshipsXml = await zip.file("ppt/_rels/presentation.xml.rels")?.async("string");
  if (!presentationRelationshipsXml) throw new Error("Component transform requires ppt/_rels/presentation.xml.rels.");
  const canvas = canvasFromPresentation(parseXml(presentationXml));
  const slidesById = slidesFromPresentation(presentationXml, presentationRelationshipsXml);
  const states = new Map<string, SlideState>();
  const getState = async (slideId: string): Promise<SlideState> => {
    const cached = states.get(slideId);
    if (cached) return cached;
    const slide = slidesById.get(slideId);
    if (!slide) throw new Error(`ADAPTIVE_COMPONENT_PROVENANCE_MISSING: slide '${slideId}' is not present in the component catalog.`);
    const state = await loadSlide(zip, slide.id, slide.sourceSlidePart);
    states.set(slideId, state);
    return state;
  };
  const componentsById = new Map<string, TemplateComponent>();
  const handles = new Map<string, ComponentHandle>();
  for (const component of artifact.components) {
    if (componentsById.has(component.id)) throw new Error(`ADAPTIVE_COMPONENT_PROVENANCE_MISSING: duplicate component id '${component.id}'.`);
    const existingSlide = slidesById.get(component.sourceSlideId);
    if (!existingSlide || existingSlide.sourceSlidePart !== component.sourceSlidePart) throw new Error(`ADAPTIVE_COMPONENT_PROVENANCE_MISSING: component '${component.id}' does not match the source presentation slide part.`);
    componentsById.set(component.id, component);
    const state = await getState(component.sourceSlideId);
    handles.set(component.id, { componentId: component.id, slideId: component.sourceSlideId, partPath: state.partPath, component });
  }

  let cloneSequence = 0;
  const createdComponents: string[] = [];
  const resolve = (componentId: string): ComponentHandle => {
    const handle = handles.get(componentId);
    if (!handle) throw new Error(`ADAPTIVE_COMPONENT_PROVENANCE_MISSING: unknown semantic component id '${componentId}'.`);
    if (!handle.node && handle.component) {
      const state = states.get(handle.slideId);
      if (!state) throw new Error(`ADAPTIVE_COMPONENT_PROVENANCE_MISSING: slide '${handle.slideId}' is not loaded for component '${componentId}'.`);
      handle.node = componentNodeFor(state, handle.component);
    }
    findHandleNode(handle);
    return handle;
  };
  const registerClone = (alias: string, state: SlideState, node: Element): void => {
    if (!alias || handles.has(alias)) throw new Error(`ADAPTIVE_COMPONENT_PROVENANCE_MISSING: duplicate semantic clone id '${alias}'.`);
    handles.set(alias, { componentId: alias, slideId: state.id, partPath: state.partPath, node });
    createdComponents.push(alias);
  };
  if (artifact.coordinateSpace?.mode === "scaled") {
    for (const component of artifact.components) {
      if (component.offCanvasHelper) continue;
      const handle = resolve(component.id);
      const state = states.get(handle.slideId)!;
      const node = findHandleNode(handle);
      const rawBounds = rectFor(node, state.partPath);
      const alreadyCanonical = ["x", "y", "w", "h"].every((key) => Math.abs(rawBounds[key as keyof Rect] - component.sourceBounds[key as keyof Rect]) <= 0.00001);
      if (alreadyCanonical) continue;
      const canonicalBounds = canonicalizeRect(rawBounds, artifact.coordinateSpace);
      ensureInsideCanvas(canonicalBounds, canvas, `canonicalize '${component.id}'`);
      setRect(node, state.partPath, canonicalBounds);
    }
  }
  const clone = async (handle: ComponentHandle, targetSlideId: string, alias?: string, offset?: { x: number; y: number }): Promise<string> => {
    const sourceState = await getState(handle.slideId);
    const targetState = await getState(targetSlideId);
    const sourceNode = findHandleNode(handle);
    const sourceParent = sourceNode.parentNode as Element | null;
    if (sourceParent?.localName === "grpSp") throw new Error(`ADAPTIVE_COMPONENT_UNSUPPORTED: grouped component '${handle.componentId}' requires coordinate canonicalization in Goal 3.5.`);
    const tree = slideTree(targetState.document, targetState.partPath);
    const cloned = sourceNode.cloneNode(true) as Element;
    cloneSequence += 1;
    renameCloneIds(cloned, tree, uniqueCloneName(tree, nodeName(sourceNode), cloneSequence));
    remapCloneRelationships(cloned, sourceState, targetState, zip);
    const sourceRect = rectFor(sourceNode, sourceState.partPath);
    const targetRect = { ...sourceRect, x: sourceRect.x + (offset?.x ?? 0), y: sourceRect.y + (offset?.y ?? 0) };
    ensureInsideCanvas(targetRect, canvas, `clone '${handle.componentId}'`);
    setRect(cloned, targetState.partPath, targetRect);
    tree.appendChild(cloned);
    const createdId = alias ?? `${handle.componentId}.clone.${cloneSequence}`;
    registerClone(createdId, targetState, cloned);
    return createdId;
  };

  for (const operation of checkedOperations) {
    if (operation.operation === "clone") {
      const source = resolve(operation.componentId);
      await clone(source, operation.targetSlideId ?? source.slideId, operation.as);
      continue;
    }
    if (operation.operation === "repeat") {
      const source = resolve(operation.componentId);
      const targetSlideId = operation.targetSlideId ?? source.slideId;
      const base = operation.as ?? `${operation.componentId}.repeat`;
      for (let index = 0; index < operation.count; index += 1) {
        await clone(source, targetSlideId, `${base}.${index + 1}`, { x: operation.offset.x * (index + 1), y: operation.offset.y * (index + 1) });
      }
      continue;
    }
    const handle = resolve(operation.componentId);
    const state = await getState(handle.slideId);
    const node = findHandleNode(handle);
    if (operation.operation === "move") {
      const current = rectFor(node, state.partPath);
      const next = { ...current, x: operation.x, y: operation.y };
      ensureInsideCanvas(next, canvas, `move '${operation.componentId}'`);
      setRect(node, state.partPath, next);
    } else if (operation.operation === "resize") {
      const current = rectFor(node, state.partPath);
      const next = { ...current, w: operation.w, h: operation.h };
      ensureInsideCanvas(next, canvas, `resize '${operation.componentId}'`);
      setRect(node, state.partPath, next);
    } else if (operation.operation === "replace_text") {
      replaceText(node, operation.text, operation.componentId);
    } else if (operation.operation === "remove") {
      node.parentNode?.removeChild(node);
      handles.delete(operation.componentId);
    } else {
      throw new Error(`COMPONENT_TRANSFORM_INVALID: unsupported operation '${String((operation as { operation?: unknown }).operation)}'.`);
    }
  }

  for (const state of states.values()) {
    cleanupRelationships(state);
    zip.file(state.partPath, serializeXml(state.document));
    zip.file(relationshipPath(state.partPath), serializeXml(state.relationships));
  }
  const temporary = `${resolvedOutput}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, await zip.generateAsync({ type: "nodebuffer" }));
    await pruneUnreachablePptxParts(temporary);
    await validatePackageRelationships(temporary);
    fs.renameSync(temporary, resolvedOutput);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { outputPath: resolvedOutput, appliedOperations: checkedOperations.length, createdComponents };
}
