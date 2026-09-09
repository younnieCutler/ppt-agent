---
name: ppt
description: Create grounded, editable PowerPoint decks through storyline, pilot approval, deterministic assembly, and structural/visual QA.
disable-model-invocation: true
---

# `/ppt`

This file is the canonical, host-neutral workflow. Other hosts (for example `codex-skill/SKILL.md`)
carry only their invocation and setup and point back here, so the commands below have exactly one
maintained copy.

Two environment variables cover host differences; both are optional and both fall back to the
Claude Code behaviour that existed before them:

- `PPT_AGENT_PROJECT_DIR` — project root for theme and raw-template resolution
  (falls back to `CLAUDE_PROJECT_DIR`, then the working directory).
- `PPT_AGENT_TRANSCRIPT_DIR` — directory of host session `.jsonl` transcripts read by `tokens`
  (falls back to Claude Code's `~/.claude/projects/<slug>`).

## Run workspace

Every run is scoped to a hidden directory, never the user's output directory:

```sh
node dist/cli.js workspace-open --name <presentation-name> [--project-dir <dir>]
# → { runId, runDir } — runDir is <project-dir>/.ppt-agent/runs/<runId>/, already gitignored.
```

Use the printed `runDir` as `--run-dir` for every command below. On success, `release` deletes the
whole run directory automatically — the user's output directory holds only the deliverable(s). On
any failure the workspace is left in place for debugging, since `release` throws before it ever
reaches the cleanup step. Pass `--keep-workspace` to `release` to keep a **successful** run's
workspace too (debugging, or inspecting what a pattern-based render actually preserved).

Confirm audience, slide count, fonts, and delivery environment before rendering. Do not invent source-backed claims or substitute unavailable fonts. Commands below are cross-platform (Windows and macOS); adjust path separators for your shell.

## Interview: presentation style

Ask for the presentation style once, alongside audience and slide count, and offer exactly these choices — default **Auto**:

| Choice | When |
| --- | --- |
| **Auto** (default) | Let the contract purpose pick the archetype. |
| Corporate | Standard business reporting; the production default. |
| Executive | Decision-first, sparse, large KPIs. |
| Analytical | Data-led, dense, charts and evidence carry the hierarchy. |
| Editorial | Statement-led, generous whitespace, no surfaces. |
| Product | Product/startup/SaaS narrative with semantic surfaces. |
| Stage | Keynote scale: very large type, minimal copy. |
| Reference-first | Take the grammar from the primary reference; requires `referenceIds[0]` to carry P3 grammar metadata, otherwise it hard-fails. |

Write the answer to `contract.presentationStyle`, then resolve the style **before authoring any composition** so slide density and composition choices are made against the archetype the deck will actually render in:

```sh
node dist/cli.js style --contract <contract.json> --run-dir <run-dir>
# → <run-dir>/resolved-style.json (full) and <run-dir>/style-context.json (compact, <1k tokens).
#   Author compositions against style-context.json; never author palette HEX into the DeckSpec.
```

## Template input: a raw .pptx — the only supported path

`contract.template: { kind: "pptx", path: "<path-to>.pptx" }`. Analyze the file itself directly; the template's own
master/layout/theme and its actual source slides are the design, not a hand-authored
reconstruction of it.

**Run `template-analyze` always, before deciding how to render.** Template tokens say nothing about
where a template's *design* lives; a real company template routinely has design that lives entirely
in its example slide bodies (GAO is exactly this — `strategy: source_slide_pattern` with 16 real
patterns). The raw runtime reuses those source slides and hard-fails unsupported composition rather
than silently falling back to a generic redraw:

```sh
node dist/cli.js template-analyze --input <path-to>.pptx --out <run-dir>/template
# → <run-dir>/template/{template-elements,template-grammar,template-design-system,template-components,template-patterns}.json, printed strategy:
#   "native_layout" | "source_slide_pattern" | "hybrid". Deleted with the rest of the run workspace
#   on a successful release.
```

When the printed `strategy` is `source_slide_pattern` (design lives in the example
slide bodies, not the master/layout — GAO is this shape) or `hybrid`, it also writes
`<out>/template-patterns.json`: one `TemplatePattern` per source slide, with `skeleton.replaceableSlots`
already bound to real `SlideSpec` fields (`headline`, `content.body`, `content.left.label`, …) and
`skeleton.preservedShapeIds`/`removableContentIds` already sanitization-classified. A pattern's
`suitableFor.functions` starts empty — geometry alone cannot prove "this source slide is the cover" —
so look at the template's own montage and tell it which `SlideFunction` each source slide serves:

```sh
node dist/cli.js template-preview --input <path-to>.pptx --run-dir <run-dir>
# → <run-dir>/template/visual/montage.png (the template's own slides, labeled by source slide id).

# Look at the montage, then write <run-dir>/pattern-labels.json:
# [{ "sourceSlideId": "S01", "functions": ["cover"] }, { "sourceSlideId": "S03", "functions": ["statement"] }]

node dist/cli.js pattern-label --run-dir <run-dir> --labels <run-dir>/pattern-labels.json
# → merges into <run-dir>/template/template-patterns.json. functions/compositionFamily only —
#   an invented SlideFunction is rejected, and there is no field here that could ever hold a
#   coordinate or a shapeId.
```

Aspect ratio:

- **generic renderer: 16:9 only** — a plain 4:3 deck is rejected.
- **raw PPTX runtime:** the source file's actual `p:sldSz` canvas is authoritative, including 4:3
  templates; adaptive final bounds must remain inside that canvas.

## The run, in dependency order

The full DeckSpec is **assembled last**, not authored in one model pass. Storyline and plan are
validated first; a representative three-slide Pilot proves the narrative/design direction; only
then are the remaining slides authored from slide-local contexts. Every phase records provenance,
and downstream commands re-hash their inputs rather than trusting workflow discipline.

```sh
npm run build

# 1. Evidence + StorylineBlueprint. Every excerpt gets an id; sourceRefs cite it as excerptId.
#    Put the contract in the run directory first. The host may research/normalize sources, but the
#    runtime only accepts the strict ContentModel and StorylineBlueprint artifacts it can validate.
cp <contract.json> <run-dir>/contract.json
npm run planning -- storyline-validate --run-dir <run-dir> \
  --storyline <storyline.json> --content-model <content-model.json> [--findings <storyline-findings.json>]
# → <run-dir>/storyline.json, storyline-qa.json, storyline-context.json, content-model.json
#   status `review` or `fail` blocks downstream authoring. Fix the argument, not the slides.

# 2. DeckPlan. The plan must pass both canonical grounding QA and Storyline alignment.
node dist/cli.js plan-validate --plan <deck-plan.json> --content-model <content-model.json> \
  --run-dir <run-dir> [--findings <plan-findings.json>]
npm run planning -- storyline-plan-validate --run-dir <run-dir>
# → planning-qa.json + storyline-plan-qa.json. Both must be `pass`.

# 3. Reference retrieval, when contract.referenceIds exists.
node dist/cli.js reference --contract <contract.json> --reference-root <ppt-master-path> \
  --run-dir <run-dir> [--top-k 3]

# 4. Style resolution. Resolve once before any composition authoring.
node dist/cli.js style --contract <contract.json> --run-dir <run-dir>

# 5. Composition shortlist per slide.
node dist/cli.js composition-resolve --plan <run-dir>/deck-plan.json \
  --style-context <run-dir>/style-context.json --run-dir <run-dir>
# → <run-dir>/composition-plan.json — ranked candidates, not a model-authored final choice.

# 5.5. Raw source_slide_pattern/hybrid templates only. Skip for native_layout.
node dist/cli.js pattern-resolve --plan <run-dir>/deck-plan.json --run-dir <run-dir>

# 6. Select and author only the Pilot (default 3 representative slides; selection = 0 model calls).
npm run planning -- pilot-select --run-dir <run-dir>
npm run pilot -- context --run-dir <run-dir>
# Read <run-dir>/pilot-authoring-context.json and author ONLY those selected slides as:
# { "version": 1, "slides": [<SlideSpec>, ...] }
npm run pilot -- apply --run-dir <run-dir> --slides <pilot-slides.json>
# → pilot-spec.json + pilot-deck.json. Thesis/evidence/composition drift hard-fails here.

# 7. Render and approve the Pilot before spending tokens on the rest of the deck.
# Generic path:
node dist/cli.js render --spec <run-dir>/pilot-deck.json --out <pilot.pptx> \
  --run-dir <run-dir> --allow-legacy
# Raw-template path instead uses a generic scratch plus the canonical template runtime:
node dist/cli.js render --spec <run-dir>/pilot-deck.json --out <pilot-scratch.pptx> \
  --run-dir <run-dir> --allow-legacy
node dist/cli.js render-pattern-skeleton --spec <run-dir>/pilot-deck.json \
  --scratch <pilot-scratch.pptx> --template <path-to>.pptx --out <pilot.pptx> --run-dir <run-dir>

node dist/cli.js visual --spec <run-dir>/pilot-deck.json --pptx <pilot.pptx> --run-dir <run-dir>
npm run pilot -- core-qa --run-dir <run-dir> --pptx <pilot.pptx>
npm run pilot -- judge-context --run-dir <run-dir> --pptx <pilot.pptx>
# Read the rendered Pilot + judge context, write closed-code findings, then:
npm run pilot -- approve --run-dir <run-dir> --pptx <pilot.pptx> \
  --findings <pilot-visual-findings.json>
# Pilot approval requires pass. A risk is blocking here; do not multiply a known design defect.

# 8. Author every NON-PILOT slide independently. Never re-author an approved Pilot slide.
npm run pilot -- full-slide-context --run-dir <run-dir> --slide S04 --out <S04-context.json>
# Read only S04-context.json; write { "version": 1, "slide": <SlideSpec> }.
npm run full-deck -- slide-apply --run-dir <run-dir> --slide S04 --input <S04.json>
# Repeat for each remaining id. slide-apply rechecks thesis, evidence, shortlist, and provenance.

# 9. Deterministic assembly: 0 model calls. No deck.json exists until every non-pilot slide passed.
npm run full-deck -- assemble --run-dir <run-dir>
# → <run-dir>/deck.json, full-deck-assembly-qa.json, full-slide-manifest.json

# 10. Canonical final validation/render/Core QA.
node dist/cli.js validate --spec <run-dir>/deck.json --run-dir <run-dir>
node dist/cli.js render --spec <run-dir>/deck.json --out <draft.pptx> --run-dir <run-dir>
# Raw source_slide_pattern/hybrid path: use the render above as scratch, then:
node dist/cli.js render-pattern-skeleton --spec <run-dir>/deck.json --scratch <draft.pptx> \
  --template <path-to>.pptx --out <draft.raw.pptx> --run-dir <run-dir>
node dist/cli.js qa --spec <run-dir>/deck.json --pptx <final-draft.pptx> --run-dir <run-dir> [--powerpoint]
```

For the generic path, `<final-draft.pptx>` is `<draft.pptx>`; for the raw-template path it is the
output of `render-pattern-skeleton` (for example `<draft.raw.pptx>`). Do not run both generic and raw
outputs through release as if they were equivalent artifacts.

DeckSpec v2 is verified against DeckPlan on `validate`, `render`, and `qa`: digest, ids, story beats,
theses, evidence, and resolved composition shortlist must still match. When Full Deck Assembly was
used, those same canonical gates additionally re-hash Storyline, Pilot approval, assembly QA,
manifest, and every stored `full-slides/slide-*.json` artifact. Editing a non-pilot artifact after
assembly therefore invalidates the assembled deck rather than silently changing its provenance.

A legacy (unversioned) DeckSpec still renders with `--allow-legacy` for compatibility. The Pilot
envelope uses that compatibility surface only to reuse the existing renderer; it is not a release
artifact. The final assembled deck is DeckSpec v2 and must pass the full provenance chain.

Use `managed_device` when recipients have the selected fonts. Core QA (font, native-object, rasterization, and font-embedding checks against the rendered PPTX's OOXML) runs on every platform and is the release bar. `--powerpoint` on Windows with Microsoft PowerPoint installed adds optional Level 3 verification (live text-overflow measurement); its absence never blocks a pass.

`reference` retrieves top-k style/layout metadata from an external `ppt-master`-shaped directory (never bundled in this repo) and writes `reference-selection.json` to `--run-dir`; set `contract.designDirection: "reference"` with matching `contract.referenceIds` to require it. A `chart` layout slide needs a `content-model.json` with a matching `datasets` entry — pass `--run-dir` to `render` whenever the deck contains one. `contract.designDirection` (`dense`/`balanced`/`visual`/`minimal`) also scales text and native-visual sizing at render time and is checked against slide composition choices at QA time.

## Visual QA and failed-slide repair

Core QA (above) never looks at a rendered image — it only checks structure and OOXML. Some defects (weak hierarchy, a slide that reads as decorative when it should read as data, an anti-slop pattern) can only be judged by looking at the deck. That judgment happens here in the skill, not in the CLI.

```sh
node dist/cli.js visual --spec <deck.json> --pptx <draft.pptx> --run-dir <run-dir> [--slides S04,S07]
```

Renders `<run-dir>/visual/slide-NNN.png`, `montage.png` (slide-ID labeled), `backend.json`, `index.json`, `deck-context.json`, and `render-provenance.json` (a digest of the exact PPTX and DeckSpec that produced this render). Requires a visual render backend: PowerPoint COM on Windows, otherwise `soffice` + Poppler `pdftoppm`. When neither probes clean, the error names each missing capability. On the `soffice` path, the intermediate PDF is kept as `<run-dir>/visual/deck.pdf` — the one artifact any downstream conversion of this deck should be compared against — and `backend.json.substitutedFonts` lists any font embedded in that PDF outside the contracted heading/body pair (`"unknown"` when `pdffonts` is unavailable; never treat that as "no substitution").

**Read `montage.png` and `deck-context.json`, then judge the deck against this rubric:**

- **Hierarchy** — one clear primary message per slide; no competing focal points.
- **Readability** — text legible at presentation scale; nothing important buried.
- **Spacing / Balance** — no accidental crowding; visual weight matches intent.
- **Density**, read against `deck-context.json`'s `designDirection`: `dense` → high density is fine; `visual` → large text blocks are suspicious; `minimal` → empty space is fine; `balanced` → avoid both extremes.
- **Semantic fit** — is the visual representation structurally valid but semantically weak (a process shown as unrelated cards, a comparison with no visible contrast, a quantitative story rendered as decoration instead of data)?
- **Archetype fit**, read against `deck-context.json`'s `resolvedStyle`: does the slide match its archetype's `surfaceUsage`, `chartTreatment`, and spacing/headline scale? An analytical deck that reads as decorative, or a stage deck rendered at report density, is `ARCHETYPE_*_MISMATCH`. Brand/theme colors and fonts are resolved deterministically — a color or typeface outside `resolvedStyle` is `BRAND_COLOR_VIOLATION` / `BRAND_FONT_VIOLATION` / `THEME_DATA_COLOR_VIOLATION`, all hard.
- **Semantic visualization** — `WEAK_SEMANTIC_VISUALIZATION` when the slide *contains* its information without *explaining* it: text plus primitive shapes where a diagram would carry the message, bullets for conceptually rich material, a KPI row with no narrative implication. This is weaker than `SEMANTIC_VISUAL_MISMATCH` (hard), which is for a representation that is outright wrong for the message.
- **Anti-slop** — flag: excessive rounded cards, decorative shapes with no semantic role, repeated 3-column layouts across many slides, unnecessary gradients, identical structure slide after slide, arbitrary icons, generic dashboard styling unrelated to content, fake infographics that encode no information.
- **Not slop by themselves**: plain white backgrounds, tables, sparse layouts, minimal decoration, dense report-style slides, a rough utilitarian style. Quality is purpose-fit, not visual complexity.

Two defects are checked deterministically in Core QA, before any judgment call, because a count is not a matter of opinion:

- `VISUAL_DOES_NOT_PROVE_HEADLINE` — the headline names a quantity (`"18 skills"`) larger than the composition's countable elements actually show (5 stage cards). A generic heuristic (headline number vs. the layout's natural countable collection) catches this as `risk` — weak evidence, since it can misfire on phrasing that was never meant as a countable claim. To make it `hard`, author an explicit contract: `slide.visualProof: { kind: "count", value: 18, collection: "process.members" }`. Three numbers must then agree exactly: the headline's own claimed number (if it names one), the declared `value`, and what `collection` actually resolves to (e.g. the sum of `process.content.steps[].members` across stages, rendered as chips on `stage_gate`) — any pairwise mismatch is hard, not just an undercount. `collection` must also be one of the closed set in `src/schema.ts` (`visualProofCollections`) and apply to the slide's own layout, or the contract itself is a hard failure.
- `UNIFORM_CELL_RHYTHM` (risk, deck-level) — composition-name variety can pass (enough distinct names, none dominant) while the deck still reads as the same primitive repeated: `architecture_zones`, `pipeline_lanes`, and `sequence` are three different names that all draw equal-width cells on one axis. This fires when ≥60% of body slides do that, regardless of which names they use. `addCompositionFamilyFindings` (family-level `REPEATED_COMPOSITION_FAMILY_RUN` / `DOMINANT_COMPOSITION_FAMILY` / `LOW_COMPOSITION_FAMILY_VARIETY`, all risk) runs alongside it but is not sufficient on its own — see `src/qa.ts` `structuralSkeleton` for exactly which compositions count as equal-cell.

Write findings as `<run-dir>/visual-findings.json`, an array of `{ slideId?, code, message }`. `code` must come from the closed set in `src/visual-qa.ts` (`visualFindingCodes`) — an invented code is rejected, not silently accepted. Do not include a `severity` field: severity is derived deterministically from `code` (`findingSeverityByCode` in `src/visual-qa.ts`), so the judgment layer cannot downgrade a hard finding past the release gate by picking a softer severity.

```sh
node dist/cli.js visual-qa --spec <deck.json> --run-dir <run-dir> --findings <run-dir>/visual-findings.json --pptx <draft.pptx>
```
Validates and rolls the findings into `<run-dir>/visual-qa.json`; a hard finding fails the run. `--pptx` is required — judgment of a deck without the file that produced the render it judged is judgment of nothing in particular. It compares the file being judged against `visual/render-provenance.json`: a digest mismatch (the PPTX or DeckSpec changed since `visual` last ran) is hard `VISUAL_QA_STALE_RENDER`; no provenance file at all (a run made before this existed) is risk `VISUAL_RENDER_PROVENANCE_UNKNOWN`. A non-empty `backend.json.substitutedFonts` is folded in automatically as risk `RENDER_FONT_SUBSTITUTION`.

**Repairing a failed slide** (never regenerate the whole deck for one bad slide):

```sh
node dist/cli.js repair-context --spec <deck.json> --run-dir <run-dir> --slide S04
# → <run-dir>/repair/S04/context.json: that slide, its cited excerpts, its dataset (if chart),
#   its reference selection, its findings, designDirection, theme, and its rendered PNG path.
#   Nothing about any other slide, no raw source text, no full reference index.
#   The command prints the path and the finding codes; read context.json for the contents.

# Author a replacement slide fragment for S04 only, then:
node dist/cli.js repair-apply --spec <deck.json> --run-dir <run-dir> --slide S04 \
    --replacement <fragment.json> --out <deck.v2.json>
```
`repair-apply` rejects a replacement that changes the slide's `id` or `storyBeat`, weakens grounding (a new `sourceRefs` entry must already resolve in `content-model.json`), or drops a required native chart. It caps automatic attempts at 2 per slide (tracked in `<run-dir>/repair-state.json`) and reports `regressionScope: "slide" | "deck"` — `"deck"` means the composition or layout changed, so re-render and re-judge the whole montage, not just the one slide, before re-running `visual-qa`.

After a repair: re-run `qa` (Core QA, full deck — it's free), then `visual`/`visual-qa` scoped to `regressionScope`.

A repair replaces exactly one `SlideSpec`. It cannot change `brand`, `presentationStyle`, `designDirection`, or the reference grammar — those live in the contract and are resolved once. If a finding can only be fixed by changing the style, stop and re-run the interview instead of repairing.

## Composition families: choose by what the slide argues, not by "architecture" vs "process"

`layout`/`composition` name a rendering routine; `compositionFamily` (`src/schema.ts`) names the perceptual shape it draws (`column_zones`, `horizontal_sequence`, `stacked_rows`, `radial`, `split_panels`, `single_focal`, `plot`). Two different composition names can still be the same family — `architecture_zones` and `sequence` are both equal-width cells on one axis — which is why `UNIFORM_CELL_RHYTHM` above exists alongside name-level variety checks. Three `architecture`/`comparison` compositions exist specifically to break that rhythm when the message calls for it, not as decoration:

- `central_hub` (`architecture`) — `zones[0]` is the hub, drawn large with an accent border; the rest are satellites in two flanking columns, each wired back by an explicit edge. Use for "one thing everything else depends on" (a shared vault, a single core).
- `layered_stack` (`architecture`) — full-width bands stacked top to bottom, weighted by node count, with a single dependency rail down the left. Use for an ordered layer model (context → experience → evidence; a runtime's dependency layers), never a row of equal columns.
- `verdict_contrast` (`comparison`) — the contested figure (`delta`) renders at KPI scale above two intentionally asymmetric panels, the rejected reading visibly muted against the adopted one. Use when the slide's point is the contrast itself, not a feature-by-feature list (`two_column`/`diagnosis_matrix` are for the latter).

`architecture_zones` itself also breaks symmetry automatically: when every edge in the slide converges on one zone, that zone renders 1.35× wider with the accent border — the renderer and `UNIFORM_CELL_RHYTHM`'s `structuralSkeleton` both derive this from `content.edges` (`architectureHubZone` in `src/schema.ts`), so a slide's own asymmetry and the repetition check that reads it can never drift apart.

## Structural findings you cannot argue with

Core QA now hard-fails two data-encoding defects, before any render or judgment:

- `MISLEADING_QUANTITATIVE_ENCODING` — a `ranked_bars` / `sparkline_row` / `gauge_row` slide whose metrics carry different units. Those compositions plot everything on one shared axis, so mixed units invite a comparison the data does not support. **Repair by changing composition to `kpi_row` or `metric_story`**, which present each figure on its own terms — never by deleting the data.
- `INCOMPARABLE_METRIC_SCALE` — same compositions, one unit, but the largest metric is over 100× the smallest, so the small bars carry no readable length.

`gauge_row` is a **bounded** encoding and the schema enforces both halves of that: every metric's `unit` must be `%`, and every `value` must fall within `0`–`100`. The renderer draws `value / 100`, so 250% would fill the same arc as 100%. Unbounded figures belong on `kpi_row` or `ranked_bars`.

Text budgets are measured in **display columns**, not codepoints, so a Japanese glyph counts as two. Japanese decks (`contract.language` starting `ja`) additionally get `JAPANESE_ORPHAN_PUNCTUATION` and `JAPANESE_AWKWARD_LINE_BREAK` from a kinsoku wrap simulation, and every deck gets `HEADLINE_BAD_WRAP`. These are `risk`, not `hard`: they run against an estimated column budget rather than real font metrics, so live measurement is still `qa --powerpoint`.

## Template fidelity gates

`qa` runs these automatically whenever `<run-dir>/render-manifest.json` exists (i.e. after
`render-pattern-skeleton`) and the deck used a raw template — no separate command. All are
deterministic (`src/template-fidelity.ts`); none of them is a judgment call:

- `TEMPLATE_EXAMPLE_CONTENT_LEAK` (hard) — verbatim source example text from a slot the pattern
  declared replaceable or removable still present in the delivered package. Checked against
  `template.pptx` directly at check time — the elements/patterns artifacts never persist example
  strings, so this is the only place the actual text exists to compare against.
- `TEMPLATE_EXAMPLE_MEDIA_LEAK` (hard) — a picture or graphic frame the pattern declared removable
  is still present in the delivered slide.
- `TEMPLATE_PATTERN_STRUCTURE_DRIFT` (hard) — a shape the pattern declared preserved is missing
  from the delivered slide, by name.
- `TEMPLATE_FIDELITY_UNPROVEN` (hard) — a `source_slide_pattern` template rendered a slide with the
  generic renderer instead of a cloned pattern. Never fires for `hybrid`, where mixing both is
  legitimate.
- `TEMPLATE_PATTERN_NOT_FOUND` (hard) — an empty exact-clone shortlist remains unresolved. Raw
  adaptive runtime runs may defer an empty exact shortlist to `TEMPLATE_COMPOSITION_UNSUPPORTED`,
  which is hard only when adaptive composition also fails.
- `TEMPLATE_SLOT_OVERFLOW` (hard) / `TEMPLATE_SLOT_TRUNCATED` (risk) — injected content exceeds a
  slot's estimated capacity (`maxChars`, from the slot's own geometry — approximate, same caveat as
  every other text-budget check above). Hard when the slot is `required`; risk otherwise, since a
  non-required slot's excess content is truncated rather than blocking the deck.

Three additional codes are **judgment**, not deterministic — read against a template-vs-generated
montage comparison, same as every other visual finding: `TEMPLATE_STYLE_DRIFT`,
`TEMPLATE_HIERARCHY_DRIFT`, `TEMPLATE_COMPOSITION_DRIFT` (all `risk` — no calibrated gold set exists
yet to justify a hard numeric fidelity threshold). Judge cover treatment, body surface rhythm, type
hierarchy, logo/footer behavior, section numbering, divider behavior, key-message treatment,
composition variety, whitespace character, and visual density against the template's own render,
the same rubric the Visual QA section above already uses for everything else.

## Run metrics

```sh
node dist/cli.js metrics --spec <deck.json> --run-dir <run-dir>
```

Writes `<run-dir>/p3-metrics.json` with a numerator/denominator per metric (brand violations, archetype fit, chart palette violations, layout repetition, Visual QA failures, repair success, style-resolution failure, style-context tokens). It reads only artifacts already in the run directory and sends nothing anywhere.

## Quality and cost — always reported together

```sh
node dist/cli.js tokens --spec <deck.json> --run-dir <run-dir> [--transcript <path> | --session-id <uuid>] [--since <iso>] [--until <iso>] [--allow-unmeasured]
node dist/cli.js score  --spec <deck.json> --run-dir <run-dir> --scores <scores.json>
npm run eval-gate -- --run-dir <run-dir> --benchmark <id>
node dist/cli.js record --spec <deck.json> --run-dir <run-dir> --benchmark <id> --version <label>
```

`tokens` reads the host's session transcript — Claude Code's `~/.claude/projects/<slug>/*.jsonl` by default, or `$PPT_AGENT_TRANSCRIPT_DIR/*.jsonl` on any other host — the only real source of `usage`, since no LLM runs inside this CLI — and writes `<run-dir>/tokens.json`. It reports `total` (everything, cache reads included) and `effective` (`input + cache_creation + output`) separately; per-slide targets are read against `effective`.

**The measurement window is `[run-dir creation, last phase boundary]`.** It has to close, or work you do later in the same session gets billed to this deck. `style`, `reference`, `render`, `visual-qa`, and `repair-context` each append a marker to `<run-dir>/run.jsonl` as they complete, so boundaries are *recorded* rather than guessed; artifact mtimes remain a fallback for runs made before markers existed. `tokens.json` says which was used (`phase-marker` / `mixed` / `artifact-mtime-window`) and how the window closed. Override with `--since` / `--until` when you need a different window.

Without `--transcript`, the project-slug directory can hold more than one session — a `/ppt` run followed by an unrelated later session touches the same directory. Picking "the newest `.jsonl`" there once produced a report with every number at `0`, silently read as "this deck cost nothing." The CLI instead scores every transcript in the directory by how many of its turns actually fall inside the measurement window and picks the best-covering one; pass `--session-id <uuid>` to point at a session explicitly by id (a shorthand for `--transcript` into the same directory), or `--transcript <path>` for a transcript outside it entirely. If the selected transcript still contributes zero turns, `tokens.json` reports `measurement: "unavailable"` with `unavailableReason`, and `tokensPerSlide` / `effectiveTokensPerSlide` / `tokensPerAcceptedSlide` / `repairOverhead` are `null`, never `0` — a real deck's cost is never legitimately zero. The `tokens` command exits non-zero on `unavailable` unless `--allow-unmeasured` is passed.

`score` takes `{ "scores": { <dimension>: 0-100 } }` covering every dimension in `src/score.ts` (`contentFidelity`, `narrativeQuality`, `visualHierarchy`, `semanticVisualization`, `referenceGrammarFit`, `layoutVariety`, `typographyReadability`, `purposeFit`, `antiSlop`). Weights live in code, not in your input, and `referenceGrammarFit` must be **omitted** when the contract declares no `referenceIds` — its weight is redistributed so a no-reference deck is not capped at 90. **A hard finding in `qa.json` or `visual-qa.json` fails the run whatever the dimensions say.**

`eval-gate` is benchmark-scoped. If `evals/real-world/<benchmark>/policy.yaml` exists, it enforces that fixed benchmark's declared token/correctness budgets and compares the current run with the latest recorded history. `jp-ai-weekly-update` opts into PRD §15's `<30k total tokens` P0 target because it is the fixed ordinary 8-slide business case the target describes; research-heavy/general decks do not inherit that ceiling. The configured benchmark also rejects unavailable token measurement, hard failures, raw-quality regression, and quality-per-10k-effective-token regression.

`record` appends one line to `evals/real-world/<benchmark>/history.jsonl` merging quality and tokens. It refuses to run without `tokens.json`, refuses a `tokens.json` whose `measurement` is `"unavailable"`, and **recomputes `eval-gate` immediately before append** when a benchmark policy exists. A stale `eval-gate.json` therefore cannot authorize a regressed run. Each record carries `tokensPerSlide`, `effectiveTokensPerSlide`, and `qualityPer10kEffectiveTokens` together, so a version whose score rose while its cost rose faster cannot read as an improvement.

A repair extends the measurement window: `repair-context` opens the repair phase and `repair-apply` closes it, so the turns spent authoring the replacement slide are counted. Run `tokens` **after** `repair-apply`, not between the two.

## Output is summarized by default

Every command that writes a run-dir artifact prints a one-line summary, not the whole blob — the artifact is on disk, and printing it puts a second copy into the conversation for nothing. **Read the file when you need the contents.** Failing QA runs still print their full findings, because that is what you have to act on. `--print` restores full output on any command.

`release` additionally accepts `--visual-qa <path>` and `--accept-risk`: a hard visual finding always blocks; an unresolved risk finding blocks unless `--accept-risk` is passed, in which case the release status is `pass_with_warning` instead of `pass`. Passing `--visual-qa` makes `--run-dir <run-dir>` mandatory alongside it: release reads `visual/render-provenance.json` from that run directory and blocks — missing file, or a digest mismatch against the PPTX being released — rather than silently shipping a file re-rendered after Visual QA last judged it.

`release` also accepts `--pdf` and `--keep-workspace`. `--pdf` requires `--run-dir` and publishes `<run-dir>/visual/deck.pdf` — the exact PDF Visual QA judged — as `<out-basename>.pdf` next to the PPTX; it never re-converts, since a different converter run after judgment is exactly what produced a phantom duplicated headline in a past regression. Without `--pdf`, no PDF is published — the default visible output is the PPTX alone. After a successful release, `--run-dir`'s workspace is deleted unless `--keep-workspace` is passed; a cleanup failure is reported as a warning on the release result and never retracts the already-published deliverable.
