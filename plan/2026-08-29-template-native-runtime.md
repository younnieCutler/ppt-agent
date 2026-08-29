# ppt-agent — Template-native Presentation Runtime (PR A–F)

Base: `origin/main` @ `fb7f1a1` (PR#10 planning/Template Element Grammar + PR#11 host-neutral).
Branch: `feat/template-native-runtime`. Baseline before any edit: 282 passed, 0 failures.

Supersedes the earlier PRD-literal draft (`/Users/macbook/Downloads/PRD_ppt_agent_template_native_runtime_ko.md`)
where the user's follow-up goal corrected it. See "Corrections" below for every place the two disagree.

## Product principle

Do not inspect a template and redraw something similar. Choose a real editable source-slide
skeleton, sanitize it, inject new content into it. Only fall back to the generic renderer when the
template's design genuinely lives in native master/layout objects (`native_layout` strategy).

## Target UX

```
template.pptx + goal → internal analysis → reuse real editable source-slide skeletons
→ inject grounded content → QA/repair → final.pptx (final.pdf only if requested)
→ all successful-run intermediate artifacts deleted automatically
```

## Corrections against the PRD draft (explicit, per user's follow-up goal)

| PRD said | This plan does instead | Why |
| --- | --- | --- |
| §26 `templateFidelityScore: 0-100`, release gate `>= 80` | **No numeric score.** Deterministic hard checks (skeleton selected, slots valid, required shapes preserved, no leak, valid package) + three new **risk**-severity visual-judgment codes (`TEMPLATE_STYLE_DRIFT`, `TEMPLATE_HIERARCHY_DRIFT`, `TEMPLATE_COMPOSITION_DRIFT`) | No calibrated gold set exists to justify a threshold number; a fake score is worse than an honest checklist. Add scoring after enough real regressions exist. |
| Org Template Pack is the only template input (`contract.organization: {kind:"directory"}`) | **Raw `.pptx` is first-class.** `contract.template: {kind:"pptx", path} \| {kind:"organization", path}`. `organization` kept working forever as sugar for `template:{kind:"organization",...}` — zero breakage for existing GAO usage/tests. | The ChatGPT-shaped UX cannot require a user to hand-author `brand.yaml`/`template-map.json` before their first run. |
| `TemplateSlot` bound to renderer-only `role` | Each slot also carries an explicit `binding: SlotBindingPath` (`"headline"`, `"content.body"`, `"content.proofs[]"`, …) — a closed union of `SlideSpec` field paths. | Makes "LLM authors semantic content, runtime resolves it into slots" a literal, schema-checked contract instead of an implicit convention. |
| Leakage gate = text only | Leakage gate = **text and media**. New `TEMPLATE_EXAMPLE_MEDIA_LEAK` alongside `TEMPLATE_EXAMPLE_CONTENT_LEAK`. Media reachable from a cloned slide is not caught by existing `pruneUnreachablePptxParts` (that removes *unreachable* parts; a cloned slide's photo is reachable). | A cloned skeleton can leak a sample screenshot as easily as a sample sentence. |
| 8 phases (0–7) | **PRs A–F**, G (Authoring Runtime) explicitly deferred | Matches the user's literal ask; each PR is independently reviewable and mergeable. |

## Conflicts / questionable parts in the request, called out per instruction 6

1. **Auto-deriving brand from a raw template.** Nothing in the codebase reads `ppt/theme/theme1.xml`
   today — `loadBrandFile` (`src/brand.ts:11`) always requires a human-authored `brand.yaml`, and
   `BRAND_COLOR_VIOLATION`/`THEME_DATA_COLOR_VIOLATION` (`src/qa.ts:801`) assume a *curated* palette.
   Deriving `primaryColors`/`accentColors`/font family from theme XML for a raw-pptx run is real new
   scope, not a rename of existing capability. Mitigation: mark the derived brand `source: "derived"`
   in the ephemeral pack so any report can distinguish "curated" from "guessed," and scope derivation
   to typography/background baseline only — never invent a semantic accent palette from thin air.
2. **"reject unknown media by default" is safe but can misfire on legitimate full-bleed decorative
   photography** if the image classifier has no image-specific heuristic. The current role classifier
   (`NAMED_ROLES` in `src/template-analysis.ts:44`) is text/shape-name driven only. This plan adds an
   explicit rule: a full-bleed, z-index-0 image with no text overlay in its bounds defaults
   `structural`; anything else with no name/role signal defaults `unknown` → rejected. Flagging this
   as the concrete rule rather than leaving "unknown" underspecified.
3. **`slotBindings` as a separate dictionary vs. a field on each slot.** The request shows both a
   `TemplateSlot` type and a same-shaped `slotBindings: {...}` example. Keeping two synchronized
   representations of the same mapping is exactly the kind of redundancy CLAUDE.md's simplicity rule
   flags. This plan puts `binding: SlotBindingPath` directly on `TemplateSlot` and drops the separate
   dictionary — one source of truth, same contract.
4. **PR A "raw PPTX plumbing if needed"** is deferred entirely to PR B. PR A ships workspace +
   cleanup only — that logic is orthogonal to template analysis and is the cheapest thing to prove
   correct in isolation (its own regression class: don't delete a user's deliverable). Bundling raw-pptx
   resolution into PR A would make it depend on B/C's not-yet-written analysis pipeline.
5. **Host "visually labels patterns"** needs a concrete, schema-checked contract or it's just prose.
   PR C adds `template-preview` (montage of source slides only, no DeckSpec/provenance coupling) and
   `pattern-label` (validates a host-authored `pattern-labels.json` against the closed `SlideFunction`/
   `CompositionFamily` enums, mirroring how `visual-findings.json` is validated today). This is the
   only host-writable artifact that touches pattern classification, and it can express zero geometry.

## Base architecture already in place (reused, not rebuilt)

- `src/template-analysis.ts` — `extractTemplateElements` (jszip + xmldom, no python-pptx/pptxgenjs in
  the read path), `TemplateElement`/`TemplateElementsArtifact`, `classifyTemplateElement` role table,
  `compileTemplateGrammar`. Currently reads **only** `ppt/slides/*.xml`, never layouts/masters, never
  records which layout a slide uses.
- `src/organization.ts` — `loadOrganizationPack`, `templateMapV1Schema`/`V2Schema` union, digest-based
  staleness chain (`TEMPLATE_ANALYZER_VERSION`, `TEMPLATE_GRAMMAR_COMPILER_VERSION`, `elementsDigest`,
  `roleOverridesDigest`).
- `src/template.ts` — `applyOrganizationTemplate` via `pptx-automizer`; today it always
  `removeExistingSlides: true` from the org template and copies slides **out of the renderer's own
  scratch deck** — the org template's own example slides are never cloned. `pruneUnreachablePptxParts`
  (`src/ooxml.ts:201`) runs after.
- `src/planning.ts` — `resolveCompositionPlan`, `compositionCatalog`, ranking idiom (organization →
  reference → visual → density → rhythm → archetype → lexical tie-break) — the exact idiom the Pattern
  Resolver reuses.
- `src/cli.ts` — `DERIVED_ARTIFACTS`/`DERIVED_PROVENANCE` + `assertFresh`/`assertDerivedFrom` chain
  (`src/cli.ts:27-94`) — the provenance mechanism new artifacts must join, not bypass.
- `src/visual-qa.ts` — closed `visualFindingCodes` union + `findingSeverityByCode` table — the pattern
  new drift codes follow exactly.
- No LLM runs inside this CLI (`src/tokens.ts:5-8`); `SKILL.md` is the orchestrator. No `run` command
  is added — this plan does not build one.

---

## PR A — Hidden run workspace + cleanup

**New `src/workspace.ts`**
```ts
export function createRunWorkspace(projectDir: string, name: string): { runId: string; runDir: string };
export function removeRunWorkspace(runDir: string, projectDir: string): void;
```
`removeRunWorkspace` throws unless `path.resolve(runDir)` is inside
`path.resolve(projectDir, ".ppt-agent/runs")` — this containment check is the only thing standing
between a cleanup bug and deleting `organizations/`, `outputs/`, or the project root.

**CLI**: `workspace-open --name <name> [--project-dir <dir>]` → prints `{ runId, runDir }`.

**`release` (`src/cli.ts`) gains `--pdf` and `--keep-workspace`.** Safe sequence, exact order:
1. existing gates unchanged (qa.json pass, judgment.md, repair attempts 0-2, hard/risk visual
   findings, render-provenance SHA-256 match);
2. copy PPTX to `--out`;
3. if `--pdf`: copy `<run-dir>/visual/deck.pdf` to `<out>.pdf` (never re-convert — re-conversion is
   what produced the phantom duplicated headline in the Japan Career Agent regression, see
   `[[jca-s02-not-copy-bug]]`); missing file is an error, not a silent skip;
4. re-hash both published files against their sources (publish integrity);
5. only if `--run-dir` given and `--keep-workspace` not passed: `removeRunWorkspace`, wrapped in
   try/catch — a cleanup failure logs a warning and never touches the already-published deliverables.

Failed run → `release` already throws before step 2 → workspace survives by construction (no new
code needed for that half of the contract).

**`src/metrics.ts`** — add published-file-count / workspace-leftover-count / cleanup-outcome to
`p3-metrics.json`.

**Tests** (`tests/unit/workspace.test.ts`): containment guard rejects `../`, `outputs/`,
`organizations/`, and any path outside `.ppt-agent/runs/`; `createRunWorkspace` produces a fresh dir
each call; `release --pdf` copies `deck.pdf` verbatim (byte-identical) and errors when it's missing;
`release` without `--keep-workspace` deletes the run dir only after the copy+hash steps succeed;
`release --keep-workspace` leaves it; a thrown gate failure leaves the workspace untouched.

**Non-goals**: no `run` command, no resume, no raw-pptx plumbing (PR B).

---

## PR B — Template inspection, strategy detection, raw-pptx input

**`src/template-analysis.ts`**
- Read each slide's `_rels/slideN.xml.rels` to resolve its `slideLayoutN.xml`, and that layout's own
  rels to its `slideMasterN.xml`. Add `nativeLayout: { index, name, masterIndex? }` and
  `sourceSlidePart` to each slide entry.
- Run the existing `extractSlide` walker (namespace-generic already) over the bound layout and master
  too, tagging every element `ownership: "master-owned" | "layout-owned" | "slide-body-owned"`.
- `detectTemplateStrategy(artifact): "native_layout" | "source_slide_pattern" | "hybrid"` — the PRD §7
  heuristic (`blankLayoutShare`, `medianSlideBodyElements`, `visualPatternDiversity`), but
  **`blankLayoutShare` measured by layout emptiness** (near-zero layout/master-owned elements), never
  by the layout's display name — names are locale/theme-dependent and "Blank" is incidental, not a
  signal.
- Bump `TEMPLATE_ANALYZER_VERSION` to `"2"` — `loadOrganizationPack` (`src/organization.ts:82`)
  already hard-fails a pack whose artifacts predate the current analyzer version, so this *is* the
  migration path for existing v2 packs; no new invalidation code needed.

**New `src/template-source.ts`**
```ts
export type TemplateSource = { kind: "pptx"; path: string } | { kind: "organization"; path: string };
export function resolveTemplateSource(source: TemplateSource, runDir: string): OrganizationPack;
```
- `kind: "organization"` → `loadOrganizationPack(source.path)`, unchanged.
- `kind: "pptx"` → `buildEphemeralOrganizationPack(source.path, runDir)`:
  writes `<run-dir>/template/{template-elements,template-grammar}.json` (patterns land in PR C), runs
  `detectTemplateStrategy`, derives a minimal `BrandFile` from `ppt/theme/theme1.xml` (`clrScheme`/
  `fontScheme` — new parsing, flagged in Conflicts #1) marked `source: "derived"`, and synthesizes an
  in-memory `TemplateMap` v3 (`strategy` = detected, `chromeOwnership` all `"template"` when strategy
  is `source_slide_pattern`, else `"renderer"`). **Nothing is written outside `runDir`** — this is
  what makes PRD §O's "no persistent cache for raw pptx" true by construction, not by a rule someone
  has to remember.

**`src/schema.ts`** — add `template: templateSourceSchema.optional()` to `contractSchema`.
`contract.organization: { kind: "directory", path }` (existing field) stays parsed exactly as today;
internally normalized to `template: { kind: "organization", path }` at the single call site in
`style.ts` that currently reads `contract.organization`. Zero test breakage expected — verify by
running `tests/integration/template-adapter.test.ts` and `tests/unit/*template*` unchanged.

**CLI**: `template-analyze` gains layout/master extraction and strategy output (extends the existing
command, not a new one) — `{ status, outputPath, grammarPath, slides, strategy }`.

**Public synthetic fixture** — `scripts/make-pattern-fixture.mjs`, builds a 3-slide, all-Blank
template with pptxgenjs at test time (no `.pptx` committed, matching existing convention): S01 dark
cover, S02 light editorial body, S03 black key-message band, each with distinctive example strings
(`FIXTURE_EXAMPLE_HEADLINE`, …). No company/GAO strings.

**Tests** (`tests/unit/template-strategy.test.ts`, `tests/integration/template-source.test.ts`):
strategy detects `source_slide_pattern` on the fixture; a Blank-layout relationship alone is *not* a
failure (assert strategy detection does not key on the layout name at all — feed it a template whose
Blank-equivalent layout is renamed and confirm identical detection); native-layout-only fallback is
rejected for a `source_slide_pattern` template (asserted properly in PR E once the gate exists — this
PR asserts detection only); `kind: "pptx"` writes nothing outside `runDir`; `kind: "organization"`
behavior is byte-identical to pre-PR-B.

---

## PR C — Pattern, slot, and binding contracts

**New `src/template-patterns.ts`**
```ts
export const slotBindingPaths = [
  "headline", "subhead", "content.body", "content.keyMessage",
  "content.proofs[]", "content.metrics[]",
  "comparison.left.label", "comparison.left.items[]",
  "comparison.right.label", "comparison.right.items[]", "source",
] as const;
export type SlotBindingPath = (typeof slotBindingPaths)[number];

export type TemplateSlot = {
  id: string;                 // "title-main", "proof-row-*"
  role: SemanticRole;          // reuse template-analysis.ts's existing vocabulary
  binding: SlotBindingPath;    // NEW — the one thing "slotBindings" was trying to express
  shapeId: string;
  bounds: Rect;
  maxChars?: number;
  maxLines?: number;
  required: boolean;
  repeatable?: boolean;        // proof-row-*, item groups
};

export type AssetClass = "structural" | "brand" | "example_content" | "unknown";

export type TemplatePattern = {
  id: string;
  sourceSlideId: string;
  suitableFor: { functions: SlideFunction[]; compositions: string[]; densities: Density[]; confidence: number };
  skeleton: {
    sourceSlidePart: string;
    preservedShapeIds: string[];
    replaceableSlots: TemplateSlot[];
    removableContentIds: string[];
    assetClasses: Record<string /* elementId */, AssetClass>;
  };
  visualSignature: { backgroundTreatment: string; compositionFamily: CompositionFamily; surfaceUsage: string; density: Density };
};
```

- `maxChars`/`maxLines` computed from slot geometry through the existing display-column budget in
  `src/typography.ts` (a Japanese glyph already counts as two there) — **not** from the example
  text's own length, which measures the example, not the box.
- `classifyTemplateAsset(element, slidePatternContext): AssetClass` (Conflicts #2's rule): image/media
  whose role is `logo` → `brand`; role ∈ `{divider, surface}` or a full-bleed z-index-0 image with no
  text overlay in its bounds → `structural`; an image/picture inside a `replaceableSlots` region, or
  whose role ∈ `{body, caption, metric, ...}` → `example_content`; anything else (no role signal, not
  full-bleed, not in a slot) → `unknown`. Same four-way split applies to text: slide-body text in a
  replaceable role → `example_content`; text also present in the bound layout/master → `structural`
  (this *is* the leakage allow-list, built once here instead of hand-maintained); anything in
  `map.persistentStrings` → `brand`; anything else left over post-injection → `unknown`.
- `compileTemplatePatterns(elements, grammar): TemplatePatternsArtifact` — one pattern per source
  slide (today's `compileTemplateGrammar` emits exactly one deck-wide synthetic pattern; this replaces
  that with a real per-slide pattern for `source_slide_pattern`/`hybrid` strategies).
- `resolveSlotContent(slideSpec: SlideSpec, binding: SlotBindingPath): string | string[] | undefined`
  — pure deterministic field lookup against the existing zod-typed `SlideSpec`. This is the whole
  "runtime resolves semantic content into slots" contract; the host never sees a `shapeId`.
- No text strings are persisted in the patterns artifact — only `charCount`/geometry, matching the
  existing elements-artifact discipline.

**CLI**
- `template-preview --input <pptx> --run-dir <dir>` — rasterizes the raw template's own slides (a
  thin wrapper reusing `visual.ts`'s backend selection, decoupled from DeckSpec/provenance — template
  preview has neither) to `<run-dir>/template/preview/slide-NNN.png` + `montage.png`.
- `pattern-label --run-dir <dir> --labels <path>` — validates a host-authored
  `<run-dir>/template/pattern-labels.json` (`[{ sourceSlideId, functions: SlideFunction[],
  compositionFamily?: CompositionFamily }]`) against the closed enums in `src/schema.ts`, merges into
  `template-patterns.json.suitableFor`. Same idiom as `visual-findings.json` validation
  (`src/cli.ts` visual-qa path) — an invented value is rejected, not silently accepted. This is the
  *only* host-writable artifact in the whole pattern pipeline, and it cannot express a coordinate.

`template-analyze` writes `template-patterns.json` as a third file in the existing
`writeArtifactPair`-style atomic write (`src/artifacts.ts:28`), so elements/grammar/patterns land
together — extends the digest chain PR B already wired.

**Tests** (`tests/unit/template-patterns.test.ts`, `tests/unit/asset-classification.test.ts`,
`tests/unit/pattern-label.test.ts`): fixture's 3 source slides each produce a pattern with correctly
bucketed slots; `classifyTemplateAsset` covers all four classes with one example each including the
full-bleed-image edge case from Conflicts #2; `pattern-label` rejects an invented `SlideFunction`;
`resolveSlotContent` covers a scalar (`headline`), a nested path (`comparison.left.label`), and a
repeatable path (`content.proofs[]`).

---

## PR D — Pattern Resolver + Skeleton Renderer

**`src/template-patterns.ts`** (resolver, colocated with the contracts it ranks)
```ts
export function resolvePatternPlan(deckPlan: DeckPlan, compositionPlan: CompositionPlan, patterns: TemplatePatternsArtifact, styleContext: unknown): PatternPlan;
```
Ranking, in order (PRD §9, same idiom as `resolveCompositionPlan` in `src/planning.ts:177`): exact
layout+composition match → `SlideFunction` match → visualIntent match → density match → **binding
coverage** (every field the slide's composition needs has a matching slot `binding` on the candidate
— this is the concrete, schema-checked replacement for the PRD's looser "role bucket" filter) →
pattern confidence → neighboring-slide repetition penalty → lexical tie-break. A candidate whose
binding coverage or slot capacity fails is dropped, not shrunk (§6/§G): the next candidate is tried;
exhausting all candidates is `TEMPLATE_PATTERN_NOT_FOUND` (PR E).

Repeatable-slot overflow: required repeatable slot with fewer rows than content items →
`TEMPLATE_SLOT_OVERFLOW` (hard, PR E); non-required → new risk finding `TEMPLATE_SLOT_TRUNCATED`,
excess items dropped deterministically (last-N, not silently reordered).

**CLI**: `pattern-resolve --plan <deck-plan.json> --run-dir <dir>` → `pattern-plan.json`, after
`composition-resolve`. Joins the existing provenance chain exactly like `composition-plan.json` does:
add `"pattern-plan.json"` to `DERIVED_ARTIFACTS`, `patternPlanDigest` to `DERIVED_PROVENANCE`
(`src/cli.ts:27-28`), `assertFresh` against `composition-plan.json`.

**`src/template.ts`** — new branch in `applyOrganizationTemplate` for `source_slide_pattern`/`hybrid`
slides with a resolved pattern:
```ts
const presentation = automizer.loadRoot(rootName)
  .load(rootName, "org-source")          // NEW — the template's own example slides as a clone source
  .load(generatedName, "semantic-render"); // unchanged — still used for native_layout/fallback slides

presentation.addSlide("org-source", pattern.sourceSlideNumber, (slide) => {
  pattern.skeleton.removableContentIds.forEach((id) => slide.removeElement(id));
  for (const slot of pattern.skeleton.replaceableSlots) {
    const content = resolveSlotContent(slideSpec, slot.binding);
    if (content === undefined) {
      if (slot.required) throw new Error(`Required slot '${slot.id}' has no matching content for binding '${slot.binding}'.`);
      slide.removeElement(slot.shapeId);
      continue;
    }
    slide.modifyElement(slot.shapeId, [ModifyTextHelper.setText(Array.isArray(content) ? content[0] : content)]);
    // repeatable: expand across the slot group's *-numbered siblings, capped at available rows
  }
});
```
`preservedShapeIds` are never touched, so background/logo/watermark/dividers/surfaces/footer/section-
number shapes survive by construction (nothing removes them) — the whole "do not run the generic
renderer first" requirement (§8/§I) is satisfied because this branch never calls the generic per-slide
renderer at all for a pattern-bound slide.

**Explicit no-fallback rule**: for `source_slide_pattern` strategy, a slide with no resolved pattern
never silently drops to the generic renderer — that is exactly `TEMPLATE_PATTERN_NOT_FOUND`, and
whether it's hard or risk is decided by PR E's gate, not by this renderer branch improvising.

`<run-dir>/render-manifest.json` records `"renderer" | "pattern:<patternId>"` per slide — PR E's
gates and geometry validation (`src/geometry.ts`, which legitimately does not apply to pattern-cloned
slides) both need this to be a provable fact, not an inference.

**Tests** (`tests/integration/pattern-skeleton.test.ts`): cover/editorial/key-message skeletons
cloned and their preserved shapes survive in the output OOXML; slot-only injection (grep the output
for the fixture's example strings — zero matches for replaced slots); a candidate whose slot capacity
is exceeded is rejected and the next candidate tried; `source_slide_pattern` with zero candidates
throws rather than falling back to the generic renderer; output remains a valid, editable PPTX
(reuses the existing `pptxgenjs`/automizer editability assertions from `template-adapter.test.ts`).

---

## PR E — Sanitization gates, drift findings, release wiring

**`src/qa.ts`** (Core QA, deterministic — matches the existing inline-literal convention, not a new
enum, consistent with how every other Core QA code is added):
- `TEMPLATE_EXAMPLE_CONTENT_LEAK` (hard) — after render, walk `readPptxOoxml` text runs; any string
  classified `example_content` by PR C's classifier that survives in the final package (not replaced,
  not removed) fails. Text classified `structural`/`brand` never triggers this by construction.
- `TEMPLATE_EXAMPLE_MEDIA_LEAK` (hard) — runs **after** `pruneUnreachablePptxParts`, walks
  `<a:blip r:embed>`/`r:link` targets actually referenced from surviving slide XML; any reachable part
  whose source element was classified `example_content` fails. This is the check
  `pruneUnreachablePptxParts` cannot do — it only removes *unreachable* parts, and a cloned slide's
  sample photo is very much reachable.
- `TEMPLATE_FIDELITY_UNPROVEN` (hard) — pack v3 + strategy `source_slide_pattern` + a slide in
  `render-manifest.json` used `"renderer"` instead of a pattern, with no recorded
  `TEMPLATE_PATTERN_NOT_FOUND`/`fallbackPolicy` exception covering it. Catches a silent fallback that
  slipped past PR D's explicit-throw rule some other way.
- `TEMPLATE_PATTERN_NOT_FOUND` (severity per `fallbackPolicy[layout]`, default hard) — PR D's resolver
  exhausted candidates.
- `TEMPLATE_SLOT_OVERFLOW` (hard) / `TEMPLATE_SLOT_TRUNCATED` (risk) — from PR D.
- `TEMPLATE_PATTERN_STRUCTURE_DRIFT` (hard) — a `preservedShapeIds` entry from the selected pattern is
  missing from the rendered slide, or a shape exists outside every declared slot/preserved-id (a
  deterministic structural diff, not a judgment call).

**`src/visual-qa.ts`** — three new **risk**-severity codes added to the closed
`visualFindingCodes`/`findingSeverityByCode` tables (`src/visual-qa.ts:8`, `:50`), judged by the host
from a template-vs-generated montage comparison exactly like every existing visual finding:
`TEMPLATE_STYLE_DRIFT`, `TEMPLATE_HIERARCHY_DRIFT`, `TEMPLATE_COMPOSITION_DRIFT`. Risk, not hard —
per Corrections table, no calibrated threshold exists yet; these block release only through the
existing `--accept-risk` mechanism, same as every other risk finding today.

**`SKILL.md`** — Visual QA rubric gains a template-fidelity comparison checklist (cover treatment,
body surface rhythm, type hierarchy, logo/footer behavior, section numbering, divider behavior,
key-message treatment, composition variety, whitespace character, visual density) as judgment
guidance for the three new codes.

**`release`** needs no new plumbing here — it already blocks on any hard finding in `qa.json` or
`visual-qa.json`; the new codes just have to exist and be wired into `structuralQa`/`visual-qa`'s
closed sets, which is this PR's entire job.

**Tests** (`tests/unit/template-leakage.test.ts`, `tests/unit/template-drift-findings.test.ts`): a
generated deck with a leftover example sentence fails `TEMPLATE_EXAMPLE_CONTENT_LEAK`; one with a
leftover example image fails `TEMPLATE_EXAMPLE_MEDIA_LEAK`; persistent/layout-owned strings never
trigger either; an invented drift code is rejected by the closed-set check (mirrors existing
`VISUAL_FINDING_INVALID` test); `source_slide_pattern` deck with one slide silently rendered
generically fails `TEMPLATE_FIDELITY_UNPROVEN`. Red-green: each leakage test asserts failure with the
sanitization step stubbed out, then passes once it runs — proving the test catches the defect, not
just exercises the code path.

**Full fixture regression suite now closes** (PRD §P items 1-22): strategy detection, Blank-legality,
skeleton reuse, slot-only injection, no arbitrary geometry (asserted by type — `resolveSlotContent`
returns `string | string[]`, never a `Rect`), overflow handling, zero text/media leakage, editable
output, no full-slide rasterization (existing `FULL_SLIDE_RASTERIZATION` check, unchanged), unused
content pruned, successful/failed workspace behavior (PR A), `--keep-workspace` (PR A), default
output count = 1 PPTX (PR A's `release` without `--pdf`).

---

## PR F — GAO private E2E (uncommitted)

`organizations/` is gitignored; nothing here is committed. Manual/scripted verification, not CI:

1. Re-run `template-analyze` against the real `organizations/GAO/template.pptx` with PR B–E's code —
   confirm detected `strategy: "source_slide_pattern"` and a per-slide pattern for each GAO source
   slide (dark cover, editorial body, key-message band, etc. — whatever GAO's actual source slides
   are).
2. Promote `organizations/GAO/template-map.json` to v3 with the tool-detected strategy — **not
   hand-edited**; if the tool can't produce a usable map without hand edits, that's a defect in PR B/C,
   not a reason to hand-author it.
3. Full `/ppt` run: Japanese IT/AI weekly briefing, 8-10 slides, using `contract.template: {kind:
   "organization", path: "organizations/GAO"}`.
4. Report (written to a local, uncommitted file — same convention as
   `artifacts/gao-tech-briefing/template-usage-root-cause.md`): detected strategy; source-slide→pattern
   mapping; generated-slide→pattern mapping; slot-binding summary; text/media leakage count (must be
   0); editability; OOXML validity; `TEMPLATE_STYLE_DRIFT`/`HIERARCHY_DRIFT`/`COMPOSITION_DRIFT`
   findings if any; template-vs-generated montage comparison; final visible output file count; and
   confirmation `.ppt-agent/runs/<id>` was removed after success.
5. Visual confirmation against PRD AC1-AC5: dark cover, editorial/light body, section numbering, blue
   or whatever GAO's actual accent is, key-message band, logo/footer rhythm — read by eye against
   `organizations/GAO/template.pptx`'s own render, not inferred from a score.

---

## PR G — Authoring Runtime — explicitly not this round

Per-slide `authoring-context`/`deck-assemble`, host-level parallel dispatch. Only starts once A-F are
proven. No code in this branch touches it.

## Migration / backward compatibility summary

- `contract.organization` keeps working unchanged; `contract.template` is additive.
- Organization Pack v1/v2 behavior is byte-identical after this branch — every new gate is opt-in via
  pack `version: 3` (`strategy`, `patternsFile`, `fallbackPolicy`, `persistentStrings` are new v3-only
  fields). GAO's own pack is promoted in PR F, not silently upgraded by loader code.
- `TEMPLATE_ANALYZER_VERSION` bump to `"2"` is the migration signal for any v2 pack analyzed before
  layout/master reading existed — `loadOrganizationPack` already refuses a stale analyzer version, so
  a v2 pack simply needs `template-analyze` re-run; no new invalidation logic required.
- No existing CLI command's argument shape changes. Every addition is a new command or a new optional
  flag (`--pdf`, `--keep-workspace`).

## Verification (after each PR)

```sh
npm run build && npm test && npm run test:integration
```
Zero regressions against the 282-test baseline is the bar for every PR in this branch, not just the
last one.
