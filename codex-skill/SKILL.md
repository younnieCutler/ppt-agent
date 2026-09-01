---
name: ppt-agent
description: Create editable 16:9 PowerPoint decks from an approved DeckSpec with deterministic rendering and structural QA.
metadata:
  short-description: Create a QA-gated editable PPTX deck
---

# PPT Agent for Codex

This file is the Codex entry point only. **The workflow — every command, gate, and rubric — lives in
the repository's canonical `SKILL.md`, which is host-neutral. Read it and follow it.** Keeping the
commands in one file is deliberate: two copies drifted apart, and the copy a host read was not the
copy that was maintained.

- Invoke as `$ppt-agent` for a new presentation.
- The repository root is the parent directory of this skill; the canonical workflow is `<repo-root>/SKILL.md`.
- Export `PPT_AGENT_PROJECT_DIR=<repo-root>` so brand, theme, and organization pack paths resolve
  from the project rather than from whatever directory Codex happened to start in.
- Run `npm run build` in the repository root once before the first run of a session.
- Confirm audience, slide count, fonts, and delivery environment before rendering. Do not invent
  source-backed claims or substitute unavailable fonts.
- **Template-native failure is terminal.** If `template-analyze`, coordinate canonicalization,
  Generative Scene rendering, or any template/brand QA gate fails, stop and surface the exact error.
  Never continue by manually recreating the template, copying only its colors/layout impression,
  switching to a generic redraw, or dropping logo/header/footer/vector chrome. A plausible-looking
  PPTX produced after bypassing a failed template gate is an invalid result.
- Judge the rendered montage yourself against the Visual QA rubric in `<repo-root>/SKILL.md`; that
  judgment happens in the host, never in the CLI.
