---
name: ppt
description: Create editable 16:9 PowerPoint decks from an approved DeckSpec, with deterministic rendering and structural QA.
disable-model-invocation: true
---

# `/ppt`

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

An organisation template pack is selected with `contract.organization: { kind: "directory", path: "organizations/acme" }` (`template.pptx` + `brand.yaml` + `template-map.json`, 16:9 only). It cannot be combined with a standalone `brand.kind: "file"`, and a locked identity conflict hard-fails rather than falling back.

```sh
npm run build
node dist/cli.js reference --contract <contract.json> --reference-root <ppt-master-path> --run-dir <run-dir> [--top-k 3]
node dist/cli.js validate --spec <deck.json> --run-dir <run-dir>
node dist/cli.js render --spec <deck.json> --out <draft.pptx> [--run-dir <run-dir>]
node dist/cli.js qa --spec <deck.json> --pptx <draft.pptx> --run-dir <run-dir> [--powerpoint]
```

Use `managed_device` when recipients have the selected fonts. Core QA (font, native-object, rasterization, and font-embedding checks against the rendered PPTX's OOXML) runs on every platform and is the release bar. `--powerpoint` on Windows with Microsoft PowerPoint installed adds optional Level 3 verification (live text-overflow measurement); its absence never blocks a pass.

`reference` retrieves top-k style/layout metadata from an external `ppt-master`-shaped directory (never bundled in this repo) and writes `reference-selection.json` to `--run-dir`; set `contract.designDirection: "reference"` with matching `contract.referenceIds` to require it. A `chart` layout slide needs a `content-model.json` with a matching `datasets` entry — pass `--run-dir` to `render` whenever the deck contains one. `contract.designDirection` (`dense`/`balanced`/`visual`/`minimal`) also scales text and native-visual sizing at render time and is checked against slide composition choices at QA time.

## Visual QA and failed-slide repair

Core QA (above) never looks at a rendered image — it only checks structure and OOXML. Some defects (weak hierarchy, a slide that reads as decorative when it should read as data, an anti-slop pattern) can only be judged by looking at the deck. That judgment happens here in the skill, not in the CLI.

```sh
node dist/cli.js visual --spec <deck.json> --pptx <draft.pptx> --run-dir <run-dir> [--slides S04,S07]
```

Renders `<run-dir>/visual/slide-NNN.png`, `montage.png` (slide-ID labeled), `backend.json`, `index.json`, and `deck-context.json`. Requires a visual render backend: PowerPoint COM on Windows, otherwise `soffice` + Poppler `pdftoppm`. When neither probes clean, the error names each missing capability.

**Read `montage.png` and `deck-context.json`, then judge the deck against this rubric:**

- **Hierarchy** — one clear primary message per slide; no competing focal points.
- **Readability** — text legible at presentation scale; nothing important buried.
- **Spacing / Balance** — no accidental crowding; visual weight matches intent.
- **Density**, read against `deck-context.json`'s `designDirection`: `dense` → high density is fine; `visual` → large text blocks are suspicious; `minimal` → empty space is fine; `balanced` → avoid both extremes.
- **Semantic fit** — is the visual representation structurally valid but semantically weak (a process shown as unrelated cards, a comparison with no visible contrast, a quantitative story rendered as decoration instead of data)?
- **Archetype fit**, read against `deck-context.json`'s `resolvedStyle`: does the slide match its archetype's `surfaceUsage`, `chartTreatment`, and spacing/headline scale? An analytical deck that reads as decorative, or a stage deck rendered at report density, is `ARCHETYPE_*_MISMATCH`. Brand/theme colors and fonts are resolved deterministically — a color or typeface outside `resolvedStyle` is `BRAND_COLOR_VIOLATION` / `BRAND_FONT_VIOLATION` / `THEME_DATA_COLOR_VIOLATION`, all hard.
- **Anti-slop** — flag: excessive rounded cards, decorative shapes with no semantic role, repeated 3-column layouts across many slides, unnecessary gradients, identical structure slide after slide, arbitrary icons, generic dashboard styling unrelated to content, fake infographics that encode no information.
- **Not slop by themselves**: plain white backgrounds, tables, sparse layouts, minimal decoration, dense report-style slides, a rough utilitarian style. Quality is purpose-fit, not visual complexity.

Write findings as `<run-dir>/visual-findings.json`, an array of `{ slideId?, code, message }`. `code` must come from the closed set in `src/visual-qa.ts` (`visualFindingCodes`) — an invented code is rejected, not silently accepted. Do not include a `severity` field: severity is derived deterministically from `code` (`findingSeverityByCode` in `src/visual-qa.ts`), so the judgment layer cannot downgrade a hard finding past the release gate by picking a softer severity.

```sh
node dist/cli.js visual-qa --spec <deck.json> --run-dir <run-dir> --findings <run-dir>/visual-findings.json
```
Validates and rolls the findings into `<run-dir>/visual-qa.json`; a hard finding fails the run.

**Repairing a failed slide** (never regenerate the whole deck for one bad slide):

```sh
node dist/cli.js repair-context --spec <deck.json> --run-dir <run-dir> --slide S04
# → <run-dir>/repair/S04/context.json: that slide, its cited excerpts, its dataset (if chart),
#   its reference selection, its findings, designDirection, theme, and its rendered PNG path.
#   Nothing about any other slide, no raw source text, no full reference index.

# Author a replacement slide fragment for S04 only, then:
node dist/cli.js repair-apply --spec <deck.json> --run-dir <run-dir> --slide S04 \
    --replacement <fragment.json> --out <deck.v2.json>
```
`repair-apply` rejects a replacement that changes the slide's `id` or `storyBeat`, weakens grounding (a new `sourceRefs` entry must already resolve in `content-model.json`), or drops a required native chart. It caps automatic attempts at 2 per slide (tracked in `<run-dir>/repair-state.json`) and reports `regressionScope: "slide" | "deck"` — `"deck"` means the composition or layout changed, so re-render and re-judge the whole montage, not just the one slide, before re-running `visual-qa`.

After a repair: re-run `qa` (Core QA, full deck — it's free), then `visual`/`visual-qa` scoped to `regressionScope`.

A repair replaces exactly one `SlideSpec`. It cannot change `organization`, `brand`, `presentationStyle`, `designDirection`, or the reference grammar — those live in the contract and are resolved once. If a finding can only be fixed by changing the style, stop and re-run the interview instead of repairing.

## Run metrics

```sh
node dist/cli.js metrics --spec <deck.json> --run-dir <run-dir>
```

Writes `<run-dir>/p3-metrics.json` with a numerator/denominator per metric (brand violations, archetype fit, chart palette violations, layout repetition, Visual QA failures, repair success, style-resolution failure, style-context tokens). It reads only artifacts already in the run directory and sends nothing anywhere.

`release` additionally accepts `--visual-qa <path>` and `--accept-risk`: a hard visual finding always blocks; an unresolved risk finding blocks unless `--accept-risk` is passed, in which case the release status is `pass_with_warning` instead of `pass`.
