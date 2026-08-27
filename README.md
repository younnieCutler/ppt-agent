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

Each slide's `sourceRefs` reference an excerpt `id` from a `content-model.json` you provide via `--run-dir`; excerpt text lives there once instead of being duplicated on every slide.

`qa` performs structural, source-grounding, and OOXML-based checks (font substitution, required native objects, full-slide rasterization, font embedding) on every platform — this is the release bar. Pass `--powerpoint` on Windows with Microsoft PowerPoint installed for additional, optional PowerPoint COM verification; its absence never blocks a pass.

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
