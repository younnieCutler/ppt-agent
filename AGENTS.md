# AGENTS.md

This file defines the engineering contract for coding agents working in this repository. It does not replace `README.md` or `SKILL.md`.

## Read first

Before changing code, read the smallest relevant set of documents:

1. `README.md` for repository usage and development commands.
2. `SKILL.md` for presentation-generation and Visual QA behavior.
3. `codex-skill/SKILL.md` when changing Codex host behavior.
4. `docs/feedback-learning-loop.md` when changing feedback, diagnosis, correction, resolution, or promotion behavior.

If these documents conflict, preserve hard runtime/data/safety contracts first, then follow the more specific document for the subsystem being changed.

## Repository invariants

- Generated PPTX output must remain editable. Do not replace required native PowerPoint objects with raster-only approximations.
- Do not fabricate source claims, evidence, data, or citations. Preserve source-grounding contracts.
- When a raw template is supplied, do not silently replace it with a generic reconstruction. Preserve the source canvas, master/theme, corporate chrome, and required native assets unless the contract explicitly permits otherwise.
- Do not weaken package validity, grounding, brand, template, or Visual QA gates to make a test pass.
- Prefer deterministic runtime behavior over hidden model-side heuristics when a rule can be encoded and tested.
- Keep schemas strict. When persisted JSON contracts change, update validation, producers, consumers, documentation, and regression tests together.

## Feedback governance

User correction is authoritative product evidence.

- A `user_correction` may be the first feedback event for a run.
- Existing feedback history is append-only. Never erase an earlier failure, diagnosis, or correction when recording a later event.
- After a case contains a user correction, later automated diagnoses are advisory and must not replace the accepted user direction, including after maintainer resolution.
- Promotion into `feedback-cases/` requires a resolved case and an existing regression test/fixture as declared by the case.
- Promotion must fail closed on identity/path collisions; never silently overwrite existing regression knowledge.
- Use the feedback CLI and repository APIs rather than manually rewriting promoted case history.

See `docs/feedback-learning-loop.md` for the full state model.

## Change discipline

- Make the smallest coherent change that fixes the underlying contract, not only the observed fixture.
- Add a regression test for every reusable bug fix. For stateful behavior, test the complete state transition that previously failed.
- Avoid unrelated refactors in the same change unless they are required for correctness.
- Preserve public CLI behavior and persisted file formats unless the change explicitly requires a versioned contract update.
- Do not hand-edit generated or promoted evidence to hide an earlier incorrect diagnosis.

## Validation

Run the relevant focused tests while developing, then run the full release checks before considering the change complete:

```bash
npm run typecheck
npm test
npm run build
```

Use `npm run test:integration` when the change affects end-to-end rendering, templates, OOXML/package behavior, reference retrieval, release gates, or cross-command workflows.

A change is not complete merely because TypeScript compiles. New behavior must be covered by tests that would fail if the regression returned.

## Agent completion criteria

Before reporting completion:

- inspect the final diff for accidental scope expansion;
- confirm required tests cover the actual failure path;
- confirm no hard contract was weakened to obtain green CI;
- report any validation that could not be run;
- do not claim a failure has been learned from unless it has durable feedback evidence and, where reusable, regression coverage.
