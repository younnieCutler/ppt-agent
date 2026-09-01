import type { ResolvedScene, SceneNodeRole } from "./scene";
import type { ComponentTransformOperation } from "./template-transform";
import type { ComponentKind, TemplateComponent, TemplateComponentsArtifact } from "./template-components";

export type SceneComponentProvenance = {
  sceneNodeId: string;
  alias: string;
  componentId: string;
  componentKind: ComponentKind;
  sourceSlideId: string;
};

export type SceneComponentPlan = {
  targetSlideId: string;
  operations: ComponentTransformOperation[];
  provenance: SceneComponentProvenance[];
};

const preservedChromeKinds = new Set<ComponentKind>(["surface", "footer", "logo"]);

const kindPreferences: Record<SceneNodeRole | "headline", ComponentKind[]> = {
  headline: ["title_block", "key_message", "body_block"],
  body: ["body_block", "key_message", "list_item", "label"],
  label: ["label", "body_block", "list_item"],
  metric: ["metric", "key_message", "body_block"],
  item: ["list_item", "body_block", "label", "key_message"],
  step: ["list_item", "label", "body_block"],
  evidence: ["body_block", "list_item", "label"],
  action: ["key_message", "label", "body_block"],
};

function usable(component: TemplateComponent): boolean {
  return !component.offCanvasHelper
    && !component.grouped
    && component.shapeNames.length === 1
    && component.kind !== "unknown"
    && component.kind !== "media_frame"
    && component.assetProvenance.kind === "none";
}

function prototypeFor(role: SceneNodeRole | "headline", artifact: TemplateComponentsArtifact): TemplateComponent {
  const preferences = kindPreferences[role];
  const candidates = artifact.components.filter(usable).filter((component) => preferences.includes(component.kind));
  candidates.sort((left, right) => {
    const kindRank = preferences.indexOf(left.kind) - preferences.indexOf(right.kind);
    if (kindRank !== 0) return kindRank;
    const semanticMatch = Number(right.semanticRoles.includes(role as never)) - Number(left.semanticRoles.includes(role as never));
    if (semanticMatch !== 0) return semanticMatch;
    const repeatability = Number(right.repeatability.signal === "repeatable") - Number(left.repeatability.signal === "repeatable");
    if (repeatability !== 0) return repeatability;
    return right.confidence - left.confidence || left.sourceSlideId.localeCompare(right.sourceSlideId) || left.id.localeCompare(right.id);
  });
  const selected = candidates[0];
  if (!selected) throw new Error(`SCENE_COMPONENT_UNSUPPORTED: template exposes no reusable text component for '${role}'.`);
  return selected;
}

function cardPrototype(artifact: TemplateComponentsArtifact): TemplateComponent | undefined {
  return artifact.components.filter(usable).filter((component) => component.kind === "card").sort((left, right) => right.confidence - left.confidence || left.sourceSlideId.localeCompare(right.sourceSlideId) || left.id.localeCompare(right.id))[0];
}

function dividerPrototype(artifact: TemplateComponentsArtifact): TemplateComponent | undefined {
  return artifact.components.filter(usable).filter((component) => component.kind === "divider").sort((left, right) => right.confidence - left.confidence || left.sourceSlideId.localeCompare(right.sourceSlideId) || left.id.localeCompare(right.id))[0];
}

function assertSanitizableBase(targetSlideId: string, artifact: TemplateComponentsArtifact): TemplateComponent[] {
  const target = artifact.components.filter((component) => component.sourceSlideId === targetSlideId && !component.offCanvasHelper);
  if (target.length === 0) throw new Error(`SCENE_BASE_UNSUPPORTED: template source slide '${targetSlideId}' has no catalogued components.`);
  const unsafe = target.filter((component) => !preservedChromeKinds.has(component.kind) && (component.grouped || component.shapeNames.length !== 1));
  if (unsafe.length > 0) throw new Error(`SCENE_BASE_UNSANITIZABLE: source slide '${targetSlideId}' contains content that cannot be removed losslessly: ${unsafe.map((component) => component.id).join(", ")}`);
  return target;
}

function aliasFor(nodeId: string): string {
  return `scene.${nodeId}`;
}

function appendPlacement(operations: ComponentTransformOperation[], provenance: SceneComponentProvenance[], component: TemplateComponent, alias: string, targetSlideId: string, bounds: { x: number; y: number; w: number; h: number }, text: string, sceneNodeId: string): void {
  operations.push({ operation: "clone", componentId: component.id, targetSlideId, as: alias });
  provenance.push({ sceneNodeId, alias, componentId: component.id, componentKind: component.kind, sourceSlideId: component.sourceSlideId });
  operations.push({ operation: "move", componentId: alias, x: bounds.x, y: bounds.y });
  operations.push({ operation: "resize", componentId: alias, w: bounds.w, h: bounds.h });
  operations.push({ operation: "replace_text", componentId: alias, text: text.replace(/\s+/g, " ").trim() });
}

function headerBounds(scene: ResolvedScene): { x: number; y: number; w: number; h: number } {
  const rows = 12;
  const gap = scene.gap.value;
  const cellH = (scene.frame.h - gap * (rows - 1)) / rows;
  if (!Number.isFinite(cellH) || cellH <= 0) throw new Error("SCENE_GEOMETRY_UNSUPPORTED: no positive header grid row remains after template spacing.");
  return { x: scene.frame.x, y: scene.frame.y, w: scene.frame.w, h: cellH * 2 + gap };
}

function decorationPlan(scene: ResolvedScene, targetSlideId: string, artifact: TemplateComponentsArtifact): ComponentTransformOperation[] {
  const operations: ComponentTransformOperation[] = [];
  const card = cardPrototype(artifact);
  if (card && ["metric_strip", "card_grid", "split"].includes(scene.kind)) {
    scene.zones.forEach((zone, index) => {
      const alias = `scene.decor.card.${index + 1}`;
      operations.push({ operation: "clone", componentId: card.id, targetSlideId, as: alias });
      operations.push({ operation: "move", componentId: alias, x: zone.bounds.x, y: zone.bounds.y });
      operations.push({ operation: "resize", componentId: alias, w: zone.bounds.w, h: zone.bounds.h });
    });
  }

  const divider = dividerPrototype(artifact);
  if (divider && (scene.kind === "sequence" || scene.kind === "timeline") && scene.zones.length > 1) {
    const ordered = [...scene.zones].sort((left, right) => left.bounds.x - right.bounds.x);
    ordered.slice(0, -1).forEach((left, index) => {
      const right = ordered[index + 1];
      const start = left.bounds.x + left.bounds.w;
      const end = right.bounds.x;
      const width = Math.max(0.01, end - start);
      const height = Math.max(0.01, Math.min(divider.sourceBounds.h || 0.02, 0.05));
      const y = left.bounds.y + left.bounds.h / 2 - height / 2;
      const alias = `scene.decor.connector.${index + 1}`;
      operations.push({ operation: "clone", componentId: divider.id, targetSlideId, as: alias });
      operations.push({ operation: "move", componentId: alias, x: start, y });
      operations.push({ operation: "resize", componentId: alias, w: width, h: height });
    });
  }
  return operations;
}

export function compileSceneComponentPlan(scene: ResolvedScene, targetSlideId: string, artifact: TemplateComponentsArtifact): SceneComponentPlan {
  const targetComponents = assertSanitizableBase(targetSlideId, artifact);
  const operations: ComponentTransformOperation[] = [];
  const provenance: SceneComponentProvenance[] = [];

  operations.push(...decorationPlan(scene, targetSlideId, artifact));

  const headline = prototypeFor("headline", artifact);
  appendPlacement(operations, provenance, headline, "scene.headline", targetSlideId, headerBounds(scene), scene.nodes.length > 0 ? scene.nodes[0].text && scene.nodes[0].text !== scene.slideId ? scene.nodes[0].text : scene.slideId : scene.slideId, "$headline");

  const zoneById = new Map(scene.zones.map((zone) => [zone.id, zone]));
  for (const node of [...scene.nodes].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))) {
    const zone = zoneById.get(node.zoneId);
    if (!zone) throw new Error(`SCENE_COMPONENT_UNSUPPORTED: scene node '${node.id}' references missing resolved zone '${node.zoneId}'.`);
    const prototype = prototypeFor(node.role, artifact);
    appendPlacement(operations, provenance, prototype, aliasFor(node.id), targetSlideId, zone.bounds, node.text, node.id);
  }

  for (const component of targetComponents) {
    if (preservedChromeKinds.has(component.kind)) continue;
    operations.push({ operation: "remove", componentId: component.id });
  }

  return { targetSlideId, operations, provenance };
}
