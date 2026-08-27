---
name: ppt
description: Create editable 16:9 PowerPoint decks from an approved DeckSpec, with deterministic rendering and structural QA.
disable-model-invocation: true
---

# `/ppt`

Confirm audience, slide count, fonts, and delivery environment before rendering. Do not invent source-backed claims or substitute unavailable fonts. Commands below are cross-platform (Windows and macOS); adjust path separators for your shell.

```sh
npm run build
node dist/cli.js validate --spec <deck.json> --run-dir <run-dir>
node dist/cli.js render --spec <deck.json> --out <draft.pptx>
node dist/cli.js qa --spec <deck.json> --pptx <draft.pptx> --run-dir <run-dir> [--powerpoint]
```

Use `managed_device` when recipients have the selected fonts. Core QA (font, native-object, rasterization, and font-embedding checks against the rendered PPTX's OOXML) runs on every platform and is the release bar. `--powerpoint` on Windows with Microsoft PowerPoint installed adds optional Level 3 verification (live text-overflow measurement); its absence never blocks a pass.
