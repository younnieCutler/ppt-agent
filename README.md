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

`visual` renders each slide to PNG plus a labeled montage (requires PowerPoint on Windows, or LibreOffice once implemented). Judging the montage against a hierarchy/density/anti-slop rubric and writing `visual-findings.json` is a skill-level (LLM) responsibility, not something the CLI does — see `SKILL.md`. `visual-qa` validates those findings against a closed code set and rolls them up; a hard finding fails. `repair-context`/`repair-apply` scope a fix to exactly one failed slide (never the whole deck), enforce that a replacement can't drift its `id`/`storyBeat`, weaken grounding, or drop a required native chart, and cap automatic repair at 2 attempts per slide via `repair-state.json`. `release` accepts `--visual-qa <path>` and `--accept-risk` to gate on visual findings in addition to Core QA.

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
