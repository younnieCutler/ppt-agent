---
name: ppt-agent
description: Create a new editable PowerPoint deck through a mandatory interview, font confirmation, semantic layout planning, deterministic rendering, PowerPoint QA, and controlled release. Use when the user asks to create a new presentation or slide deck; do not use for editing an existing deck.
metadata:
  short-description: Create a QA-gated editable PPTX deck
---

# PPT Agent for Codex

Use this skill as `$ppt-agent` when the user asks for a new PPTX. Start with the same interview-first workflow as the Claude `/ppt` entrypoint; never generate a deck before the Generation Contract and outline are approved.

The repository-root [workflow authority](../SKILL.md) contains the complete semantic layout, Company Template Pack, execution lock, source grounding, first-page QA, repair, and release rules. Read it before planning and apply every product rule below, while translating only its host-specific references:

- Treat the user's `$ppt-agent` request as the optional topic/source argument.
- Resolve the repository root as the parent directory of this skill. Use `<repo-root>` wherever the shared workflow says `${CLAUDE_SKILL_DIR}`.
- Treat the active workspace as `<project-root>` wherever it says `${CLAUDE_PROJECT_DIR}`.
- Run `node <repo-root>/dist/cli.js ...` for validation, rendering, QA, and release.
- Do not create Claude command files or depend on the `pptx` companion skill. For a Company Template Pack that requires native-template fill, explain that this repository's direct 16:9 renderer cannot safely fill it; use the verified native workflow only when the required local tooling is available.

Codex-specific completion criteria are unchanged: confirm fonts, preserve native editability, write `content-model.json` and `repair-state.json`, pass first-page and full PowerPoint QA, record a good/pass judgment, then execute the `release` CLI command. On macOS, plan and render as permitted, but do not claim final PASS without Windows PowerPoint QA.
