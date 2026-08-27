---
name: ppt-agent
description: Create editable 16:9 PowerPoint decks from an approved DeckSpec with deterministic rendering and structural QA.
metadata:
  short-description: Create a QA-gated editable PPTX deck
---

# PPT Agent for Codex

Use this skill as `$ppt-agent` for a new presentation. Confirm the audience, slide count, fonts, and delivery environment before rendering. Do not invent source-backed claims or substitute unavailable fonts.

- Resolve the repository root as the parent directory of this skill.
- Run `node <repo-root>/dist/cli.js validate --spec <deck.json> --run-dir <run-dir>` before rendering.
- Run `node <repo-root>/dist/cli.js render --spec <deck.json> --out <draft.pptx>` for editable output.
- Run `node <repo-root>/dist/cli.js qa --spec <deck.json> --pptx <draft.pptx> --run-dir <run-dir>` for Core QA (cross-platform OOXML checks — this is the release bar on macOS and Linux too).
- Keep source excerpts in `content-model.json` (each excerpt has an `id`; `sourceRefs` reference it as `excerptId`) and record repair attempts in `repair-state.json`.
- `--powerpoint` adds optional Level 3 PowerPoint COM verification, available only on Windows with Microsoft PowerPoint installed. Its absence never blocks release.
