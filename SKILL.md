---
name: ppt
description: Create editable 16:9 PowerPoint decks from an approved DeckSpec, with deterministic rendering and structural QA.
disable-model-invocation: true
shell: powershell
---

# `/ppt`

Confirm audience, slide count, fonts, and delivery environment before rendering. Do not invent source-backed claims or substitute unavailable fonts.

```powershell
npm.cmd run build
node .\dist\cli.js validate --spec <deck.json>
node .\dist\cli.js render --spec <deck.json> --out <draft.pptx>
node .\dist\cli.js qa --spec <deck.json> --pptx <draft.pptx> --run-dir <run-dir>
```

Use `managed_device` when recipients have the selected fonts. Final PowerPoint COM QA requires Windows with Microsoft PowerPoint.
