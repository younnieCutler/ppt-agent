import { z } from "zod";

export const sourceRefSchema = z.object({
  sourceId: z.string().min(1),
  excerptId: z.string().min(1),
});

export const contentModelSchema = z
  .object({
    version: z.literal(1),
    sources: z.array(z.object({
      sourceId: z.string().min(1),
      excerpts: z.array(z.object({ id: z.string().min(1), locator: z.string().min(1), text: z.string().min(1) })).min(1),
    })).min(1),
    datasets: z.array(z.object({
      id: z.string().min(1),
      sourceId: z.string().min(1),
      excerptId: z.string().min(1),
      categories: z.array(z.string().min(1)).min(1).max(12),
      series: z.array(z.object({ name: z.string().min(1), values: z.array(z.number()) })).min(1).max(6),
      unit: z.string().optional(),
    })).optional(),
  })
  .superRefine((model, ctx) => {
    const ids = model.sources.flatMap((source) => source.excerpts.map((excerpt) => excerpt.id));
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sources"], message: "content-model excerpt ids must be unique across the whole model." });
    }
    const datasetIds = (model.datasets ?? []).map((dataset) => dataset.id);
    if (new Set(datasetIds).size !== datasetIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["datasets"], message: "content-model dataset ids must be unique." });
    }
    (model.datasets ?? []).forEach((dataset, index) => {
      dataset.series.forEach((series, seriesIndex) => {
        if (series.values.length !== dataset.categories.length) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["datasets", index, "series", seriesIndex, "values"], message: `Dataset '${dataset.id}' series '${series.name}' must have exactly ${dataset.categories.length} values (one per category).` });
        }
      });
    });
  });

export const claimSchema = z
  .object({
    text: z.string().min(1),
    kind: z.enum(["fact", "calculation", "interpretation"]),
    status: z.enum(["verified", "needs_confirmation"]),
    formula: z.string().min(1).optional(),
  })
  .superRefine((claim, ctx) => {
    if (claim.kind === "calculation" && !claim.formula) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["formula"], message: "Calculated claims require an explicit formula." });
    }
    if (claim.kind !== "calculation" && claim.formula) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["formula"], message: "Only calculated claims may contain a formula." });
    }
  });

export const storyBeatSchema = z.enum([
  "opening",
  "problem",
  "evidence",
  "insight",
  "design",
  "implementation",
  "architecture",
  "roadmap",
  "closing",
]);

export const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prompt"), id: z.string().min(1), text: z.string().min(1) }),
  z.object({
    kind: z.literal("file"),
    id: z.string().min(1),
    path: z.string().min(1),
    type: z.enum(["md", "txt", "pdf", "image"]),
  }),
]);

export const contractSchema = z.object({
  sources: z.array(sourceSchema).min(1),
  purpose: z.enum(["technical", "proposal", "internal", "executive", "sales", "training", "other", "research", "strategy", "evidence", "vision", "narrative", "product", "startup", "saas", "keynote", "conference"]),
  audience: z.string().min(1),
  objective: z.string().min(1).optional(),
  audienceDecision: z.string().min(1).optional(),
  visualIntent: z
    .array(z.enum(["comparison", "process", "pipeline", "hierarchy", "architecture", "trend", "evidence", "roadmap"]))
    .min(1)
    .max(3)
    .optional(),
  designDirection: z.enum(["auto", "dense", "balanced", "visual", "minimal", "reference"]).default("auto"),
  presentationStyle: z.enum(["auto", "corporate", "executive", "analytical", "editorial", "product", "stage", "reference-first"]).default("auto"),
  referenceIds: z.array(z.string().min(1)).min(1).max(3).optional(),
  storyline: z.array(storyBeatSchema).min(3).max(9),
  language: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, "language must be a BCP-47-like tag"),
  slideCount: z.number().int().min(3).max(30),
  brand: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("default") }),
    z.object({ kind: z.literal("file"), path: z.string().min(1) }),
  ]),
  organization: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("directory"), path: z.string().min(1) }),
  ]).default({ kind: "none" }),
  fonts: z.object({ heading: z.string().min(1), body: z.string().min(1) }),
  fontDelivery: z.enum(["managed_device", "portable"]).default("managed_device"),
  editability: z.literal("native_editable").default("native_editable"),
  aspectRatio: z.enum(["16:9", "4:3"]),
}).superRefine((contract, ctx) => {
  if ((contract.designDirection === "reference" || contract.presentationStyle === "reference-first") && (!contract.referenceIds || contract.referenceIds.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["referenceIds"], message: "designDirection 'reference' requires at least one referenceIds entry." });
  }
  if (contract.organization.kind === "directory" && contract.brand.kind === "file") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["organization"], message: "Organization packs own brand.yaml; do not combine organization.directory with brand.file." });
  }
});

// YAML treats an all-numeric six-digit token such as `123456` as a number
// unless it is quoted.  Coerce that representation back to its lexical form
// while still rejecting malformed/short colors and preserving the public
// string type.
export const hexColorSchema = z.preprocess((value) => typeof value === "number" ? String(value) : value, z.string().regex(/^[0-9A-Fa-f]{6}$/));

// V1 is retained solely for file/deck migration. New theme files use the
// expanded semantic palette below. `paletteSchema` accepts both during the
// migration window so existing imports continue to parse.
export const legacyPaletteSchema = z.object({
  background: hexColorSchema,
  surface: hexColorSchema,
  text: hexColorSchema,
  primary: hexColorSchema,
  accent: hexColorSchema,
  muted: hexColorSchema,
  border: hexColorSchema,
});

export const presentationArchetypes = ["corporate", "executive", "analytical", "editorial", "product", "stage"] as const;
export const presentationArchetypeSchema = z.enum(presentationArchetypes);

export const themePaletteSchema = z.object({
  background: hexColorSchema,
  surface: hexColorSchema,
  surfaceAlt: hexColorSchema,
  text: hexColorSchema,
  textSecondary: hexColorSchema,
  muted: hexColorSchema,
  inverseText: hexColorSchema,
  primary: hexColorSchema,
  accent: hexColorSchema,
  accentSecondary: hexColorSchema,
  border: hexColorSchema,
  divider: hexColorSchema,
  gridline: hexColorSchema,
  mutedFill: hexColorSchema,
  highlightedRegion: hexColorSchema,
  positive: hexColorSchema,
  warning: hexColorSchema,
  negative: hexColorSchema,
  neutral: hexColorSchema,
});

export const paletteSchema = z.union([themePaletteSchema, legacyPaletteSchema]);

export const themeV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: presentationArchetypeSchema,
  palette: themePaletteSchema,
  data: z.tuple([hexColorSchema, hexColorSchema, hexColorSchema, hexColorSchema, hexColorSchema, hexColorSchema]),
});

export const brandFileSchema = z.object({
  name: z.string().min(1),
  palette: paletteSchema,
  // Optional: an organisation's own categorical chart colors. Without this, chart series 3-6 fall
  // back to the archetype's data colors, which can visibly clash with a brand's identity colors
  // (series 1-2). Organization Brand outranks Archetype, so a brand that cares about its chart
  // palette should declare all six here.
  data: z.tuple([hexColorSchema, hexColorSchema, hexColorSchema, hexColorSchema, hexColorSchema, hexColorSchema]).optional(),
  fonts: z
    .object({ heading: z.string().min(1), body: z.string().min(1), locked: z.boolean().default(false) })
    .optional(),
  logo: z
    .object({ path: z.string().min(1) })
    .optional(),
  footer: z
    .object({ showPageNumber: z.boolean().default(true), text: z.string().default("") })
    .default({ showPageNumber: true, text: "" }),
  // Optional lock metadata is ignored by legacy callers but lets an
  // organisation pack declare which identity tokens may not be replaced by
  // an archetype or reference grammar.
  paletteLocked: z.boolean().default(false),
  lockedPalette: z.array(z.string()).default([]),
  locks: z.object({ palette: z.array(z.string()).default([]), fonts: z.boolean().optional() }).optional(),
});

// Named countable collections a `visualProof` can point at, one per layout that has a natural
// countable thing. Kept as a closed list — the same discipline as `visualFindingCodes` — so an
// authored contract can't reference a collection the resolver in qa.ts doesn't know how to count.
export const visualProofCollections = [
  "process.members",
  "process.steps",
  "architecture.nodes",
  "architecture.zones",
  "pipeline.nodes",
  "comparison.items",
  "quantitative.metrics",
  "timeline.milestones",
  "statement.proofs",
  "evidence.bullets",
] as const;

// A headline that names a quantity ("18 skills") can be checked against the visual two ways: a
// generic heuristic that scans for "<number> <plural noun>" (weak — it doesn't know which count
// the author meant, and can be fooled by phrasing), or this explicit contract, where the author
// states exactly which collection proves exactly which number. Only a violation of the explicit
// contract is a hard Core QA failure; the heuristic alone is `risk` (qa.ts
// addHeadlineProofFindings).
export const visualProofSchema = z.object({
  kind: z.literal("count"),
  value: z.number().int().positive(),
  collection: z.enum(visualProofCollections),
});

const baseSlideSchema = z.object({
  id: z.string().regex(/^S\d{2,}$/),
  role: z.string().min(1),
  storyBeat: storyBeatSchema,
  headline: z.string().min(1),
  headlineAlignment: z.enum(["left", "center", "right"]).default("left"),
  claims: z.array(claimSchema).min(1).max(5),
  composition: z.string().min(1),
  sourceRefs: z.array(sourceRefSchema).min(1),
  visualProof: visualProofSchema.optional(),
});

const titleSlideSchema = baseSlideSchema.extend({
  layout: z.literal("title"),
  content: z.object({ kicker: z.string().optional(), subtitle: z.string().optional(), imagePath: z.string().optional() }),
});

const statementSlideSchema = baseSlideSchema.extend({
  layout: z.literal("statement"),
  content: z.object({ body: z.string().min(1), proofs: z.array(z.string()).max(4).default([]) }),
});

const comparisonSlideSchema = baseSlideSchema.extend({
  layout: z.literal("comparison"),
  content: z.object({
    left: z.object({ label: z.string().min(1), items: z.array(z.string()).min(1).max(6) }),
    right: z.object({ label: z.string().min(1), items: z.array(z.string()).min(1).max(6) }),
    delta: z.string().optional(),
  }),
});

const processSlideSchema = baseSlideSchema.extend({
  layout: z.literal("process"),
  content: z.object({
    // `members` names the concrete items a stage groups (e.g. the named skills inside a
    // "Capture" stage). Optional and rendered only on stage_gate, but it is what lets a headline
    // like "18 skills, one job each" be proven visually rather than merely asserted — see
    // addHeadlineProofFindings in qa.ts.
    steps: z.array(z.object({ id: z.string().min(1), label: z.string().min(1), detail: z.string().optional(), members: z.array(z.string().min(1)).max(8).optional() })).min(2).max(7),
  }),
});

function calculatePipelineRanks(nodes: Array<{ id: string }>, edges: Array<{ from: string; to: string }>): Map<string, number> | undefined {
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) return undefined;
    outgoing.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const rank = new Map(nodes.map((node) => [node.id, 0]));
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited += 1;
    for (const next of outgoing.get(id) ?? []) {
      rank.set(next, Math.max(rank.get(next) ?? 0, (rank.get(id) ?? 0) + 1));
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  return visited === nodes.length ? rank : undefined;
}

const pipelineSlideSchema = baseSlideSchema.extend({
  layout: z.literal("pipeline"),
  content: z.object({
    lanes: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })).max(4).default([]),
    nodes: z.array(z.object({ id: z.string().min(1), label: z.string().min(1), laneId: z.string().optional(), detail: z.string().optional() })).min(2).max(10),
    edges: z.array(z.object({ from: z.string().min(1), to: z.string().min(1), label: z.string().optional() })).min(1).max(14),
  }).superRefine((content, ctx) => {
    const nodeIds = new Set(content.nodes.map((node) => node.id));
    if (nodeIds.size !== content.nodes.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes"], message: "Pipeline node ids must be unique." });
    }
    const laneIds = new Set(content.lanes.map((lane) => lane.id));
    if (laneIds.size !== content.lanes.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lanes"], message: "Pipeline lane ids must be unique." });
    }
    content.nodes.forEach((node, index) => {
      if (node.laneId && !laneIds.has(node.laneId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes", index, "laneId"], message: `Pipeline node '${node.id}' references unknown lane '${node.laneId}'.` });
      }
    });
    content.edges.forEach((edge, index) => {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["edges", index], message: `Pipeline edge references an unknown node: ${edge.from} -> ${edge.to}.` });
      }
      if (edge.from === edge.to) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["edges", index], message: "Pipeline edges may not self-reference." });
      }
    });
    const ranks = calculatePipelineRanks(content.nodes, content.edges);
    if (!ranks) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["edges"], message: "Pipeline must be acyclic so its flow can be laid out deterministically." });
      return;
    }
    const rowsByLaneAndRank = new Map<string, number>();
    content.nodes.forEach((node) => {
      const lane = node.laneId ?? "__default__";
      const key = `${lane}:${ranks.get(node.id)}`;
      rowsByLaneAndRank.set(key, (rowsByLaneAndRank.get(key) ?? 0) + 1);
    });
    if ([...rowsByLaneAndRank.values()].some((count) => count > 4)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes"], message: "Pipeline places at most four parallel nodes in each lane/rank cell." });
    }
  }),
});

const architectureSlideSchema = baseSlideSchema.extend({
  layout: z.literal("architecture"),
  content: z.object({
    zones: z.array(z.object({ id: z.string().min(1), label: z.string().min(1), description: z.string().optional(), nodes: z.array(z.string()).min(1).max(6) })).min(2).max(5),
    edges: z.array(z.object({ from: z.string().min(1), to: z.string().min(1), label: z.string().optional() })).min(1).max(12),
  }).superRefine((content, ctx) => {
    const endpoints = new Set(content.zones.flatMap((zone) => zone.nodes.map((node) => `${zone.id}:${node}`)));
    content.edges.forEach((edge, index) => {
      if (!endpoints.has(edge.from) || !endpoints.has(edge.to)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["edges", index], message: `Architecture edge must reference an explicit zone:node endpoint: ${edge.from} -> ${edge.to}.` });
      }
      if (edge.from === edge.to) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["edges", index], message: "Architecture edges may not self-reference." });
      }
    });
  }),
});

const quantitativeSlideSchema = baseSlideSchema.extend({
  layout: z.literal("quantitative"),
  content: z.object({
    kind: z.enum(["kpi", "bar", "line"]),
    metrics: z.array(z.object({
      label: z.string().min(1),
      value: z.number(),
      unit: z.string().min(1),
      period: z.string().min(1),
      comparisonBasis: z.string().min(1).optional(),
      note: z.string().optional(),
    })).min(1).max(8),
  }),
});

const timelineSlideSchema = baseSlideSchema.extend({
  layout: z.literal("timeline"),
  content: z.object({ milestones: z.array(z.object({ label: z.string().min(1), date: z.string().min(1), detail: z.string().optional() })).min(2).max(8) }),
});

const evidenceSlideSchema = baseSlideSchema.extend({
  layout: z.literal("evidence"),
  content: z.object({ assetPath: z.string().optional(), caption: z.string().optional(), bullets: z.array(z.string()).max(5).default([]) }),
});

const chartSlideSchema = baseSlideSchema.extend({
  layout: z.literal("chart"),
  content: z.object({
    chartType: z.enum(["bar", "horizontal_bar", "stacked_bar", "line", "pie", "donut"]),
    dataRef: z.string().min(1),
    caption: z.string().optional(),
  }),
});

export const slideSchema = z.discriminatedUnion("layout", [
  titleSlideSchema,
  statementSlideSchema,
  comparisonSlideSchema,
  processSlideSchema,
  pipelineSlideSchema,
  architectureSlideSchema,
  quantitativeSlideSchema,
  timelineSlideSchema,
  evidenceSlideSchema,
  chartSlideSchema,
]);

export const legacyThemeSchema = z.object({
  name: z.string().min(1),
  palette: legacyPaletteSchema,
  fonts: z.object({ heading: z.string().min(1), body: z.string().min(1), locked: z.boolean() }),
  logoPath: z.string().optional(),
  footer: z.object({ showPageNumber: z.boolean(), text: z.string() }),
});

// DeckSpec accepts both the historical V1 theme object and a V2 token object
// during migration.  New rendering always resolves a V2 style in code, so the
// optional field is retained only for old decks and import compatibility.
export const themeSchema = z.union([legacyThemeSchema, themeV2Schema]);

export const allowedCompositions: Record<string, string[]> = {
  title: ["cover"],
  statement: ["hero_evidence", "claim_actions"],
  comparison: ["two_column", "diagnosis_matrix", "ownership_split", "verdict_contrast"],
  process: ["sequence", "stage_gate"],
  pipeline: ["pipeline_lanes"],
  architecture: ["architecture_zones", "central_hub", "layered_stack"],
  quantitative: ["kpi_row", "ranked_bars", "metric_story", "gauge_row", "sparkline_row"],
  timeline: ["linear_roadmap", "now_next_later"],
  evidence: ["evidence_list", "evidence_panel"],
  chart: ["native_chart"],
};

// Every composition's perceptual skeleton, independent of its authored layout name. Two
// compositions with different names can still read as the same primitive on a rendered slide —
// `architecture_zones`, `central_hub`, and `layered_stack` are all `layout: "architecture"`, but
// only the first lays equal-width columns; `central_hub` is radial and `layered_stack` is
// unequal stacked bands. Repetition QA (qa.ts `addCompositionFindings`) counts variety at this
// family level, not the composition name, so renaming a layout cannot manufacture variety.
export type CompositionFamily = "single_focal" | "split_panels" | "column_zones" | "horizontal_sequence" | "stacked_rows" | "radial" | "plot";

export const compositionFamily: Record<string, CompositionFamily> = {
  cover: "single_focal",
  hero_evidence: "split_panels",
  claim_actions: "split_panels",
  two_column: "split_panels",
  diagnosis_matrix: "split_panels",
  ownership_split: "split_panels",
  verdict_contrast: "split_panels",
  sequence: "horizontal_sequence",
  stage_gate: "horizontal_sequence",
  linear_roadmap: "horizontal_sequence",
  now_next_later: "horizontal_sequence",
  pipeline_lanes: "stacked_rows",
  layered_stack: "stacked_rows",
  architecture_zones: "column_zones",
  central_hub: "radial",
  kpi_row: "column_zones",
  gauge_row: "column_zones",
  ranked_bars: "plot",
  sparkline_row: "plot",
  native_chart: "plot",
  metric_story: "split_panels",
  evidence_list: "single_focal",
  evidence_panel: "split_panels",
};

const deckShapeSchema = z.object({
  contract: contractSchema,
  title: z.string().min(1),
  theme: themeSchema.optional(),
  slides: z.array(slideSchema).min(3).max(30),
});

export const deckSchema = z
  .preprocess((input, ctx) => {
    const forbidden = new Set(["x", "y", "w", "h", "width", "height"]);
    const visit = (value: unknown, location: string): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${location}[${index}]`));
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (forbidden.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [location, key], message: `Arbitrary geometry field '${key}' is not allowed in DeckSpec.` });
        visit(child, `${location}.${key}`);
      }
    };
    visit(input, "deck");
    return input;
  }, deckShapeSchema)
  .superRefine((deck, ctx) => {
    if (deck.contract.slideCount !== deck.slides.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contract", "slideCount"], message: "contract.slideCount must equal slides.length." });
    }
    const ids = deck.slides.map((slide) => slide.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["slides"], message: "slide ids must be unique." });
    }
    const sourceIds = deck.contract.sources.map((source) => source.id);
    if (new Set(sourceIds).size !== sourceIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contract", "sources"], message: "source ids must be unique." });
    }
    const sourceSet = new Set(sourceIds);
    deck.slides.forEach((slide, slideIndex) => {
      if (slide.claims[0].text !== slide.headline) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["slides", slideIndex, "claims", 0, "text"],
          message: "The first claim must exactly match the slide headline so the primary message remains explicit.",
        });
      }
      slide.sourceRefs.forEach((ref, refIndex) => {
        if (!sourceSet.has(ref.sourceId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["slides", slideIndex, "sourceRefs", refIndex, "sourceId"], message: `Unknown source id '${ref.sourceId}'.` });
      });
      if (!allowedCompositions[slide.layout].includes(slide.composition)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["slides", slideIndex, "composition"],
          message: `Composition '${slide.composition}' is not supported by layout '${slide.layout}'.`,
        });
      }
      if (slide.layout === "quantitative" && slide.composition === "gauge_row" && slide.content.metrics.some((metric) => metric.unit !== "%")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["slides", slideIndex, "content", "metrics"],
          message: "gauge_row always renders each metric against a 0-100 scale; every metric.unit must be '%'.",
        });
      }
      // The unit check above is not sufficient on its own. gauge_row draws `value / 100`, so a
      // metric outside 0-100 renders as an empty or overflowing arc that misstates the figure —
      // 250% fills the same gauge as 100%. A gauge is a bounded encoding; the value must be bounded.
      if (slide.layout === "quantitative" && slide.composition === "gauge_row") {
        slide.content.metrics.forEach((metric, metricIndex) => {
          if (metric.value < 0 || metric.value > 100) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["slides", slideIndex, "content", "metrics", metricIndex, "value"],
              message: `gauge_row renders each metric against a fixed 0-100 arc, so '${metric.label}' (${metric.value}) cannot be drawn honestly. Use 'kpi_row' or 'ranked_bars' for unbounded values.`,
            });
          }
        });
      }
      if (slide.layout === "quantitative" && slide.composition === "sparkline_row" && slide.content.metrics.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["slides", slideIndex, "content", "metrics"],
          message: "sparkline_row requires at least 2 metrics to draw a connecting line.",
        });
      }
      if (!deck.contract.storyline.includes(slide.storyBeat)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["slides", slideIndex, "storyBeat"],
          message: `Story beat '${slide.storyBeat}' is absent from the GenerationContract storyline.`,
        });
      }
    });
  });

export type SourceRef = z.infer<typeof sourceRefSchema>;
export type ContentModel = z.infer<typeof contentModelSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type GenerationContract = z.infer<typeof contractSchema>;
export type BrandFile = z.infer<typeof brandFileSchema>;
export type ThemeTokens = z.infer<typeof themeSchema>;
export type LegacyThemeTokens = z.infer<typeof legacyThemeSchema>;
export type ThemePalette = z.infer<typeof themePaletteSchema>;
export type ThemeTokensV2 = z.infer<typeof themeV2Schema>;
export type PresentationArchetype = z.infer<typeof presentationArchetypeSchema>;
export type SlideSpec = z.infer<typeof slideSchema>;
export type VisualProof = z.infer<typeof visualProofSchema>;
export type VisualProofCollection = (typeof visualProofCollections)[number];
export type DeckSpec = z.infer<typeof deckSchema>;

export const layoutNames = [
  "title",
  "statement",
  "comparison",
  "process",
  "pipeline",
  "architecture",
  "quantitative",
  "timeline",
  "evidence",
  "chart",
] as const;

// Derived editability contract. `executionLock` used to be an LLM-authored field that
// merely restated these facts; the renderer/QA layer now derives them directly from
// `layout` and `composition` so the DeckSpec never repeats information the schema already knows.
export const primaryVisuals = ["cover_typography", "evidence_panel", "comparison", "process", "pipeline", "architecture", "chart", "timeline"] as const;
export type PrimaryVisual = (typeof primaryVisuals)[number];

export const nativeObjectKinds = ["text", "shapes", "connectors", "table", "chart", "source_image"] as const;
export type NativeObject = (typeof nativeObjectKinds)[number];

const primaryVisualByLayout: Record<SlideSpec["layout"], PrimaryVisual> = {
  title: "cover_typography",
  statement: "evidence_panel",
  comparison: "comparison",
  process: "process",
  pipeline: "pipeline",
  architecture: "architecture",
  quantitative: "chart",
  timeline: "timeline",
  evidence: "evidence_panel",
  chart: "chart",
};

export function primaryVisualFor(layout: SlideSpec["layout"]): PrimaryVisual {
  return primaryVisualByLayout[layout];
}

// Shared between the renderer (which draws the hub zone larger and accented) and QA's
// perceptual-repetition check (which needs to know a hub slide's cells are no longer equal-width
// before it counts an architecture_zones slide toward `UNIFORM_CELL_RHYTHM`). Kept as one
// definition so "which zone is the hub" can never drift between what's drawn and what's judged.
export function architectureHubZone(edges: Array<{ to: string }>): string | undefined {
  if (edges.length === 0) return undefined;
  const targets = new Set(edges.map((edge) => edge.to.split(":")[0]));
  return targets.size === 1 ? [...targets][0] : undefined;
}

const requiredNativeObjectsByComposition: Record<string, NativeObject[]> = {
  cover: ["text"], hero_evidence: ["text", "shapes"], claim_actions: ["text", "shapes"],
  two_column: ["text", "shapes"], diagnosis_matrix: ["text", "shapes"], ownership_split: ["text", "shapes"],
  sequence: ["text", "shapes", "connectors"], stage_gate: ["text", "shapes"],
  pipeline_lanes: ["text", "shapes", "connectors"], architecture_zones: ["text", "shapes", "connectors"],
  kpi_row: ["text", "shapes"], ranked_bars: ["text", "shapes"], metric_story: ["text", "shapes"],
  gauge_row: ["text", "shapes"], sparkline_row: ["text", "connectors"],
  linear_roadmap: ["text", "shapes", "connectors"], now_next_later: ["text", "shapes"],
  evidence_list: ["text"], evidence_panel: ["text"],
  native_chart: ["text", "chart"],
  central_hub: ["text", "shapes", "connectors"], layered_stack: ["text", "shapes"],
  verdict_contrast: ["text", "shapes"],
};

export function requiredNativeObjectsFor(slide: SlideSpec): NativeObject[] {
  const declared = requiredNativeObjectsByComposition[slide.composition] ?? [];
  // kpi_row's only shapes are the separators *between* metrics, so a single-KPI slide legitimately
  // draws none. Demanding one made a valid single-metric DeckSpec impossible to release — and
  // kpi_row is exactly where a slide flagged for MISLEADING_QUANTITATIVE_ENCODING gets repaired to.
  const base = slide.layout === "quantitative" && slide.composition === "kpi_row" && slide.content.metrics.length < 2
    ? declared.filter((kind) => kind !== "shapes")
    : declared;
  const usesSourceImage = (slide.layout === "title" && Boolean(slide.content.imagePath)) || (slide.layout === "evidence" && Boolean(slide.content.assetPath));
  return usesSourceImage && !base.includes("source_image") ? [...base, "source_image"] : base;
}
