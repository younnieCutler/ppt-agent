# PPT Agent

A small TypeScript toolkit for generating editable 16:9 PowerPoint decks and checking their structure.

## Install

```bash
git clone https://github.com/younnieCutler/ppt-agent.git
cd ppt-agent
npm ci
npm run build
```

## Use

```bash
node dist/cli.js validate --spec tests/fixtures/deck.json
node dist/cli.js render --spec tests/fixtures/deck.json --out output/example.pptx
node dist/cli.js qa --spec tests/fixtures/deck.json --pptx output/example.pptx --run-dir output/run
```

`contract.presentationStyle` selects `auto`, `corporate`, `executive`, `analytical`, `editorial`, `product`, `stage`, or `reference-first`. `auto` maps the contract purpose to an archetype and resolves the V2 palette/grammar in code; the DeckSpec does not need to repeat HEX tokens. `node dist/cli.js style --contract contract.json --run-dir output/run` writes the resolved style and compact model context.

An organisation pack is selected with `contract.organization: { kind: "directory", path: "organizations/acme" }` and contains `template.pptx`, `brand.yaml`, and `template-map.json`. The default renderer is 16:9 only, but an organisation pack may be 16:9 or 4:3 — a 4:3 pack sets `template-map.json`'s `aspectRatio: "4:3"` and ships a 10×7.5in `template.pptx`, and `contract.aspectRatio` must match or style resolution hard-fails. The shared semantic renderer writes a scratch deck, then `pptx-automizer` applies native masters/layouts without an organisation-specific renderer fork.

Each slide's `sourceRefs` reference an excerpt `id` from a `content-model.json` you provide via `--run-dir`; excerpt text lives there once instead of being duplicated on every slide. A `chart` layout slide's `content.dataRef` similarly resolves against a `datasets` entry in the same `content-model.json`, so its values render as an editable native PowerPoint chart instead of DeckSpec-authored numbers.

### Reference retrieval

```bash
node dist/cli.js reference --contract contract.json --reference-root /path/to/ppt-master --run-dir output/run --top-k 3
```

Reads `templates/{styles,layouts}/*_index.json` from an external `ppt-master`-shaped directory (never bundled in this repo), scores entries deterministically against the contract's purpose/audience/designDirection/visualIntent/storyline, and writes the top-k selection to `<run-dir>/reference-selection.json`. Set `contract.designDirection: "reference"` and `contract.referenceIds` (ids from that selection) to require it — `qa` hard-fails if a referenced id is missing.

`qa` performs structural, source-grounding, and OOXML-based checks (font substitution, required native objects, full-slide rasterization, font embedding) on every platform — this is the release bar. Pass `--powerpoint` on Windows with Microsoft PowerPoint installed for additional, optional PowerPoint COM verification; its absence never blocks a pass.

### Visual QA and repair

```bash
node dist/cli.js visual --spec <deck.json> --pptx <draft.pptx> --run-dir <run-dir> [--slides S04,S07]
node dist/cli.js visual-qa --spec <deck.json> --run-dir <run-dir> --findings <run-dir>/visual-findings.json
node dist/cli.js repair-context --spec <deck.json> --run-dir <run-dir> --slide S04
node dist/cli.js repair-apply --spec <deck.json> --run-dir <run-dir> --slide S04 --replacement <fragment.json> --out <deck.v2.json>
```

`visual` renders each slide to PNG plus a labeled montage (PowerPoint COM on Windows, otherwise LibreOffice + Poppler). Judging the montage against a hierarchy/density/anti-slop rubric and writing `visual-findings.json` is a skill-level (LLM) responsibility, not something the CLI does — see `SKILL.md`. `visual-qa` validates those findings against a closed code set and rolls them up; a hard finding fails. `repair-context`/`repair-apply` scope a fix to exactly one failed slide (never the whole deck), enforce that a replacement can't drift its `id`/`storyBeat`, weaken grounding, or drop a required native chart, and cap automatic repair at 2 attempts per slide via `repair-state.json`. `release` accepts `--visual-qa <path>` and `--accept-risk` to gate on visual findings in addition to Core QA.

The visual backend probes PowerPoint COM capability on Windows and falls back to a real LibreOffice -> PDF -> Poppler PNG pipeline when both `soffice` and `pdftoppm` are available. Native charts use the six `theme.data` colors only; structural tokens are never categorical colors.

Core QA reads the rendered package as XML (namespace-based, not by prefix) so an arbitrary organisation template is inspected safely, and hard-fails a gradient fill authored on a semantic shape or native chart — template master chrome and source images are exempt.

```bash
node dist/cli.js metrics --spec <deck.json> --run-dir <run-dir>
```

Writes `<run-dir>/p3-metrics.json`: a numerator/denominator per metric (brand violations, archetype fit, chart palette violations, layout repetition, Visual QA failures, repair success, style-resolution failure, style-context tokens). It reads only what is already in the run directory and transmits nothing.

## Development

```bash
npm run build
npm run typecheck
npm test
```

## Evaluation history

`evals/evals.json` contains synthetic prompts. `evals/history.jsonl` is an append-only record of anonymous, versioned outcomes and intentionally excludes source materials and generated decks.

## License

[MIT](LICENSE)
