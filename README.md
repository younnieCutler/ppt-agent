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
```

`qa` performs structural checks on every platform. PowerPoint COM checks require Windows with Microsoft PowerPoint installed.

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
