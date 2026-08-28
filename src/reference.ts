import fs from "node:fs";
import path from "node:path";
import type { GenerationContract } from "./schema";

export type ReferenceEntry = {
  id: string;
  kind: "style" | "layout";
  summary: string;
  intent: string[];
  canvasFormat?: string;
  pageTypes?: string[];
  // Populated only from an optional `ppt-agent-traits.json` sidecar under --reference-root.
  // ppt-master's own indices do not carry these PRD-shaped fields; we never fabricate them.
  style?: { density?: string; visualWeight?: string; tone?: string };
  layout?: { columns?: number; whitespace?: string; headline?: string };
  traits?: string[];
};

export type ReferenceQuery = {
  purpose: string;
  audience: string;
  designDirection: string;
  visualIntent?: string[];
  storyline: string[];
  aspectRatio: "16:9" | "4:3";
};

type StylesIndexFile = Record<string, { summary: string; keywords?: string[] }>;
type LayoutsIndexFile = Record<string, { summary: string; canvas_format?: string; page_count?: number; page_types?: string[] }>;
type TraitsSidecar = Record<string, Partial<Pick<ReferenceEntry, "style" | "layout" | "traits">>>;

const ASPECT_TO_CANVAS: Record<string, string> = { "16:9": "ppt169", "4:3": "ppt43" };

function readJsonIfExists<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function loadReferenceIndex(root: string): ReferenceEntry[] {
  const stylesPath = path.join(root, "templates", "styles", "styles_index.json");
  const layoutsPath = path.join(root, "templates", "layouts", "layouts_index.json");
  const styles = readJsonIfExists<StylesIndexFile>(stylesPath);
  const layouts = readJsonIfExists<LayoutsIndexFile>(layoutsPath);
  if (!styles && !layouts) {
    throw new Error(`No reference index found under ${root}. Expected templates/styles/styles_index.json and/or templates/layouts/layouts_index.json — confirm --reference-root points at a ppt-master-shaped directory.`);
  }

  const entries: ReferenceEntry[] = [];
  for (const [name, data] of Object.entries(styles ?? {})) {
    entries.push({ id: `style:${name}`, kind: "style", summary: data.summary, intent: data.keywords ?? [] });
  }
  for (const [name, data] of Object.entries(layouts ?? {})) {
    entries.push({
      id: `layout:${name}`,
      kind: "layout",
      summary: data.summary,
      intent: data.page_types ?? [],
      canvasFormat: data.canvas_format,
      pageTypes: data.page_types,
    });
  }

  const traits = readJsonIfExists<TraitsSidecar>(path.join(root, "ppt-agent-traits.json"));
  if (traits) {
    for (const entry of entries) {
      const override = traits[entry.id];
      if (!override) continue;
      if (override.style) entry.style = override.style;
      if (override.layout) entry.layout = override.layout;
      if (override.traits) entry.traits = override.traits;
    }
  }
  return entries;
}

export function queryFromContract(contract: GenerationContract): ReferenceQuery {
  return {
    purpose: contract.purpose,
    audience: contract.audience,
    designDirection: contract.designDirection,
    visualIntent: contract.visualIntent,
    storyline: contract.storyline,
    aspectRatio: contract.aspectRatio,
  };
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9가-힣]+/).filter(Boolean);
}

function scoreEntry(entry: ReferenceEntry, matchTokens: Set<string>): number {
  let score = 0;
  for (const keyword of entry.intent) {
    if (tokenize(keyword).some((word) => matchTokens.has(word))) score += 3;
  }
  for (const word of tokenize(entry.summary)) {
    if (matchTokens.has(word)) score += 1;
  }
  return score;
}

export function retrieveReferences(index: ReferenceEntry[], query: ReferenceQuery, topK = 3): ReferenceEntry[] {
  const clampedTopK = Math.min(3, Math.max(1, topK));
  const expectedCanvas = ASPECT_TO_CANVAS[query.aspectRatio];
  const candidates = index.filter((entry) => !entry.canvasFormat || entry.canvasFormat === expectedCanvas);

  const matchTokens = new Set([
    ...tokenize(query.purpose),
    ...tokenize(query.audience),
    ...tokenize(query.designDirection),
    ...query.storyline.flatMap(tokenize),
    ...(query.visualIntent ?? []).flatMap(tokenize),
  ]);

  return candidates
    .map((entry) => ({ entry, score: scoreEntry(entry, matchTokens) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, clampedTopK)
    .map((ranked) => ranked.entry);
}

export function previewPathsFor(root: string, entry: ReferenceEntry, limit = 3): string[] {
  if (entry.kind !== "layout") return [];
  const packName = entry.id.slice("layout:".length);
  const templatesDir = path.join(root, "templates", "layouts", packName, "templates");
  if (!fs.existsSync(templatesDir)) return [];
  return fs.readdirSync(templatesDir)
    .filter((name) => name.endsWith(".svg"))
    .sort()
    .slice(0, limit)
    .map((name) => path.join(templatesDir, name));
}
