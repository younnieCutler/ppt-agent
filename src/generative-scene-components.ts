import type { TemplateConstraintProfile, ImmutableBrandRegion, Rect } from "./brand-constraints";
import { isGenerativeNativePrimitiveNode, type GenerativeSceneNode, type GenerativeTextNode, type ResolvedGenerativeScene } from "./generative-scene";
import type { ComponentTransformOperation } from "./template-transform";
import type { ComponentKind, TemplateComponent, TemplateComponentsArtifact } from "./template-components";

export type GenerativeComponentProvenance = {
  sceneNodeId: string;
  alias: string;
  componentId: string;
  componentKind: ComponentKind;
  sourceSlideId: string;
  bounds: Rect;
  text?: string;
};

export type GenerativeSceneComponentPlan = {
  targetSlideId: string;
  operations: ComponentTransformOperation[];
  provenance: GenerativeComponentProvenance[];
  preservedImmutableComponentIds: string[];
};

const textPreferences: Record<GenerativeTextNode["role"], ComponentKind[]> = {
  headline: ["title_block", "key_message", "body_block"],
  body: ["body_block", "key_message", "list_item", "label"],
  label: ["label", "body_block", "list_item"],
  metric: ["metric", "key_message", "body_block"],
  item: ["list_item", "body_block", "label", "key_message"],
  step: ["list_item", "label", "body_block"],
  evidence: ["body_block", "list_item", "label"],
  action: ["key_message", "label", "body_block"],
};

const structuralKinds = new Set<ComponentKind>(["surface", "card", "divider", "footer", "logo"]);

function usable(component: TemplateComponent): boolean {
  return !component.offCanvasHelper && !component.grouped && component.shapeNames.length === 1 && component.kind !== "unknown" && component.kind !== "media_frame";
}

function near(left: number, right: number): boolean { return Math.abs(left - right) <= 0.015; }
function sameBounds(left: Rect, right: Rect): boolean { return near(left.x, right.x) && near(left.y, right.y) && near(left.w, right.w) && near(left.h, right.h); }

function immutableMatch(component: TemplateComponent, region: ImmutableBrandRegion): boolean {
  if (component.elementIds.includes(region.sourceElementId) && component.sourceSlideId === region.sourceSlideId) return true;
  if (!region.evidence.includes("cross_slide_repeat") || !structuralKinds.has(component.kind)) return false;
  return sameBounds(component.sourceBounds, region.bounds);
}

function immutableComponent(component: TemplateComponent, profile: TemplateConstraintProfile): boolean {
  return profile.immutableRegions.some((region) => immutableMatch(component, region));
}

function textPrototype(node: GenerativeTextNode, artifact: TemplateComponentsArtifact): TemplateComponent {
  const preferences = node.componentPreference ? [node.componentPreference] : textPreferences[node.role];
  const candidates = artifact.components.filter(usable).filter((component) => preferences.includes(component.kind) && component.assetProvenance.kind === "none");
  candidates.sort((left, right) => {
    const leftStyle = node.styleRole && left.semanticRoles.includes(node.styleRole) ? 1 : 0;
    const rightStyle = node.styleRole && right.semanticRoles.includes(node.styleRole) ? 1 : 0;
    if (leftStyle !== rightStyle) return rightStyle - leftStyle;
    const kindRank = preferences.indexOf(left.kind) - preferences.indexOf(right.kind);
    if (kindRank !== 0) return kindRank;
    const repeatability = Number(right.repeatability.signal === "repeatable") - Number(left.repeatability.signal === "repeatable");
    if (repeatability !== 0) return repeatability;
    return right.confidence - left.confidence || left.sourceSlideId.localeCompare(right.sourceSlideId) || left.id.localeCompare(right.id);
  });
  const selected = candidates[0];
  if (!selected) throw new Error(`GENERATIVE_COMPONENT_UNSUPPORTED: template exposes no reusable component for Scene node '${node.id}' (${node.role}).`);
  return selected;
}

function structuralPrototype(node: Extract<GenerativeSceneNode, { role: "surface" | "divider" }>, artifact: TemplateComponentsArtifact): TemplateComponent {
  const desired: ComponentKind[] = node.role === "surface" ? (node.componentPreference ? [node.componentPreference] : ["card", "surface"]) : ["divider"];
  const candidates = artifact.components.filter(usable).filter((component) => desired.includes(component.kind) && component.assetProvenance.kind === "none");
  candidates.sort((left, right) => desired.indexOf(left.kind) - desired.indexOf(right.kind) || right.confidence - left.confidence || left.sourceSlideId.localeCompare(right.sourceSlideId) || left.id.localeCompare(right.id));
  const selected = candidates[0];
  if (!selected) throw new Error(`GENERATIVE_COMPONENT_UNSUPPORTED: template exposes no reusable ${node.role} component for Scene node '${node.id}'.`);
  return selected;
}

function prototypeFor(node: Exclude<GenerativeSceneNode, { role: "connector" | "chart" | "image" | "icon" }>, artifact: TemplateComponentsArtifact): TemplateComponent {
  return node.role === "surface" || node.role === "divider" ? structuralPrototype(node, artifact) : textPrototype(node, artifact);
}

function aliasFor(nodeId: string): string { return `generative.${nodeId}`; }

function appendNode(operations: ComponentTransformOperation[], provenance: GenerativeComponentProvenance[], node: Exclude<ResolvedGenerativeScene["nodes"][number], { role: "connector" | "chart" | "image" | "icon" }>, component: TemplateComponent, targetSlideId: string): void {
  const alias = aliasFor(node.id);
  operations.push({ operation: "clone", componentId: component.id, targetSlideId, as: alias });
  operations.push({ operation: "resize", componentId: alias, w: node.bounds.w, h: node.bounds.h });
  operations.push({ operation: "move", componentId: alias, x: node.bounds.x, y: node.bounds.y });
  const record: GenerativeComponentProvenance = { sceneNodeId: node.id, alias, componentId: component.id, componentKind: component.kind, sourceSlideId: component.sourceSlideId, bounds: { ...node.bounds } };
  if ("text" in node && node.text) {
    const text = node.text.replace(/\s+/g, " ").trim();
    if (!text) throw new Error(`GENERATIVE_COMPONENT_UNSUPPORTED: Scene node '${node.id}' has no renderable text.`);
    operations.push({ operation: "replace_text", componentId: alias, text });
    record.text = text;
  }
  provenance.push(record);
}

function sanitizableBase(targetSlideId: string, artifact: TemplateComponentsArtifact, profile: TemplateConstraintProfile): { target: TemplateComponent[]; preserved: Set<string> } {
  const target = artifact.components.filter((component) => component.sourceSlideId === targetSlideId);
  if (target.length === 0) throw new Error(`GENERATIVE_BASE_UNSUPPORTED: template source slide '${targetSlideId}' has no catalogued components.`);
  const preserved = new Set(target.filter((component) => immutableComponent(component, profile)).map((component) => component.id));
  const removable = target.filter((component) => !preserved.has(component.id));
  const unsafe = removable.filter((component) => component.grouped || component.shapeNames.length !== 1);
  if (unsafe.length > 0) throw new Error(`GENERATIVE_BASE_UNSANITIZABLE: source slide '${targetSlideId}' contains non-immutable content that cannot be removed losslessly: ${unsafe.map((component) => component.id).join(", ")}`);
  return { target, preserved };
}

export function compileGenerativeSceneComponentPlan(scene: ResolvedGenerativeScene, targetSlideId: string, artifact: TemplateComponentsArtifact, profile: TemplateConstraintProfile): GenerativeSceneComponentPlan {
  if (artifact.sourceDigest !== profile.sourceDigest || artifact.elementsDigest !== profile.elementsDigest) throw new Error("GENERATIVE_COMPONENT_PROVENANCE_MISMATCH: component catalog and brand profile describe different template inputs.");
  const { target, preserved } = sanitizableBase(targetSlideId, artifact, profile);
  const operations: ComponentTransformOperation[] = [];
  const provenance: GenerativeComponentProvenance[] = [];
  const componentNodes = scene.nodes.filter((node) => !isGenerativeNativePrimitiveNode(node)) as Array<Exclude<ResolvedGenerativeScene["nodes"][number], { role: "connector" | "chart" | "image" | "icon" }>>;
  const ordered = [...componentNodes].sort((left, right) => {
    const layer = (role: GenerativeSceneNode["role"]): number => role === "surface" ? 0 : role === "divider" ? 1 : 2;
    return layer(left.role) - layer(right.role) || componentNodes.indexOf(left) - componentNodes.indexOf(right);
  });
  for (const node of ordered) appendNode(operations, provenance, node, prototypeFor(node, artifact), targetSlideId);
  for (const component of target) if (!preserved.has(component.id)) operations.push({ operation: "remove", componentId: component.id });
  return { targetSlideId, operations, provenance, preservedImmutableComponentIds: [...preserved].sort() };
}
