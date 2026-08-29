# Host-neutral Authoring Runtime — proposed design

**Status:** design proposal. Nothing here is implemented. This document is the canonical design; it
is written against the contracts that exist in this repository today (`src/planning.ts`,
`src/schema.ts`, `src/cli.ts`, `SKILL.md`), and every rule below is checkable against them.

## Problem

A host authors the whole DeckSpec in one turn. That costs three things:

1. **Context.** All evidence, the style context, and the whole composition plan sit in one window,
   so a 20-slide deck spends most of its budget re-reading material only one slide needs.
2. **No parallelism.** Slides are independent once the plan and shortlist are fixed, but there is no
   unit of work smaller than the deck.
3. **Late detection.** Plan drift on one slide is found at deck verification, after every other slide
   was authored against the same window.

## Shape

```text
deck-plan.json + composition-plan.json + content-model.json + style-context.json
        │
        ├── authoring-context --slide S04 ──> <run-dir>/authoring/S04.context.json
        │                                              │
        │                                    host worker (3–5 concurrent)
        │                                              v
        │                                     <run-dir>/authoring/fragments/S04.json
        v
   deck-assemble ──> deck.json (DeckSpec v2)
```

- `src/authoring.ts` — context building, fragment validation, assembly. Pure functions over parsed
  input, like `src/planning.ts`; the CLI owns all I/O.
- `authoring-context --run-dir <dir> --slide <id>`
- `deck-assemble --run-dir <dir> --out <deck.json>`

## 1. Composition is a shortlist, not a decision

`resolveCompositionPlan` emits, per slide, a **ranked shortlist** of catalog entries whose layout is
allowed for that slide's `function` (`layoutsByFunction`):

```jsonc
{ "version": 1, "slides": [ { "id": "S04", "candidates": [ { "layout": "…", "composition": "…", "family": "…", "rank": 1, "reasons": ["…"] } ] } ] }
```

So the authoring context exposes `compositionCandidates`, plural. The worker chooses exactly one and
records why. Assembly checks membership only:

- selected `{ layout, composition }` ∈ that slide's candidates → accepted, **whatever its rank**.
- selected pair outside the shortlist → rejected.

Rank is advice. `verifyDeckAgainstPlan` already implements exactly this membership rule
(`VISUAL_INTENT_MISMATCH`), and assembly reuses it rather than defining a second one.

## 2. Plan conformance — only checks the schema can express

`SlideSpec` has no `function` field, so there is no `fragment.function === plan.function` check to
make. What is checkable, and what `verifyDeckAgainstPlan` already enforces:

| Rule | Existing code |
| --- | --- |
| `slide.id`, `slide.storyBeat`, `slide.headline` equal the plan's `id`, `storyBeat`, `thesis` | `PLAN_STORY_BEAT_DRIFT` |
| every planned primary ref present, no ref outside primary+secondary | `PRIMARY_EVIDENCE_MISSING` |
| selected layout/composition ∈ shortlist | `VISUAL_INTENT_MISMATCH` |
| slide count matches the plan | `PLAN_SLIDE_COUNT_MISMATCH` |
| `planDigest` equals the digest of the current plan | `DECK_PLAN_DIGEST_MISMATCH` |

The layout is constrained to the plan's `function` transitively: the shortlist only ever contains
layouts from `layoutsByFunction[intent.function]`, so shortlist membership *is* the function check.

`slide.claims[0].text === slide.headline` is the one rule not in `verifyDeckAgainstPlan` today. It
belongs in `src/authoring.ts` as a fragment-level rule, because a fragment is the first place a
single slide is validated on its own.

## 3. AuthoringContext

```jsonc
{
  "version": 1,
  "slideId": "S04",
  "plan": { /* exactly one SlideIntent, verbatim from deck-plan.json */ },
  "compositionCandidates": [ { "layout": "…", "composition": "…", "family": "…", "rank": 1, "reasons": ["…"] } ],
  "excerpts": [ { "sourceId": "…", "excerptId": "…", "locator": "…", "text": "…" } ],
  "style": { /* authoring style projection — see below, NOT style-context.json verbatim */ },
  "neighbours": { "previous": { "id": "S03", "takeaway": "…" }, "next": { "id": "S05", "takeaway": "…" } },
  "assets": [ { "id": "logo-primary", "path": "assets/logo.png", "kind": "image", "digest": "…", "source": "organization-pack" } ],
  "constraints": {
    "language": "ja",
    "designDirection": "balanced",
    "textBudgets": { "headline": 60, "claim": 120 },
    "byCandidate": { "<layout>:<composition>": { "maxClaims": 3, "supportsMetrics": true } }
  },
  "provenance": {
    "contractDigest": "…", "contentModelDigest": "…", "deckPlanDigest": "…",
    "compositionPlanDigest": "…", "resolvedStyleDigest": "…",
    "referenceSelectionDigest": "…", "templateGrammarDigest": "…"
  }
}
```

- `excerpts` contains **only** the excerpts named by this slide's `primaryEvidence` and
  `secondaryEvidence`, resolved through the ContentModel. Never the raw sources.
- No reference index, no other slide's content, no deck-wide material.
- `style` is a **projection**, not `style-context.json` verbatim: today `styleContext()` includes
  `organization.templatePath`, an absolute machine-local path, which would make `contextDigest`
  machine-dependent. The projection carries semantics only:

  ```jsonc
  {
    "themeId": "…",
    "designDirection": "balanced",
    "organization": { "id": "acme", "grammarDigest": "…" },
    "grammar": { /* density, surfaceUsage, chartTreatment, scales, compositionPreferences */ },
    "locked": { /* … */ },
    "reference": { /* id and grammar traits */ }
  }
  ```

  Excluded, without exception: `templatePath` and every other absolute repository or pack path, run
  directory paths, timestamps (`provenance.resolvedAt` and anything like it), hostnames, usernames,
  and any other host-specific filesystem value. The organization is identified by `id` plus
  `grammarDigest` — the identity, not where the file happens to live.
- `assets` is an **allow-list**. `SlideSpec` permits `title.content.imagePath` and
  `evidence.content.assetPath`, so without one a worker could name any path on the machine running
  the render. The list contains only assets legitimately available to *this* slide — from the
  organization pack, the ContentModel, or the run's own asset directory — each with a stable `id`,
  a repo/run-relative `path`, a `kind`, a content `digest`, and its `source`. Fragment validation
  requires every `imagePath`/`assetPath` in the slide to resolve to an entry in that list; anything
  else is rejected rather than rendered. `contextDigest` covers each asset's `id`, `kind`, and
  content `digest` — not an absolute path — so the same asset at a different checkout root does not
  change the digest, while editing the asset's bytes does.
- `constraints` is per candidate where it differs, because no candidate has been selected yet. It
  carries budgets and capability flags only — never `x`/`y`/`w`/`h`, which `deckSchema` rejects
  outright anyway.
- `provenance` mirrors the fields `artifact-provenance.json` actually produces and verifies today.
  `organizationPackDigest`, `deckSpecDigest`, and `pptxDigest` do not exist any more and must not
  reappear here.

## 4. contextDigest binds a fragment to what it was given

```jsonc
{ "version": 1, "slideId": "S04", "contextDigest": "<sha256>", "slide": { /* one SlideSpec */ } }
```

`contextDigest = sha256(JSON.stringify(context))` over the normalized context, computed by the same
single helper that produces it — the pattern `deckPlanDigest()` already establishes.

At assembly, each slide's context is rebuilt deterministically from the current artifacts and
re-digested. A fragment whose `contextDigest` no longer matches is stale **for that slide only**, and
only those slides are re-authored. This is deliberately stronger than `deckPlanDigest +
compositionPlanDigest`: evidence text, style, references, and template grammar all reach the worker
through the context, and any of them changing makes the fragment stale.

Context building must therefore be deterministic — no timestamps, no absolute paths, no ordering that
depends on filesystem enumeration. The test that proves it: copy one semantically identical run to
two different absolute filesystem roots, build the context for the same slide in each, and require
both the `AuthoringContext` and its `contextDigest` to be byte-identical. A digest that changes when
the repository is checked out at a different path is not a staleness signal, it is noise, and it
would invalidate every fragment on any machine but the one that authored it.

## 5. `deck-assemble` contract

Top-level DeckSpec fields:

| Field | Source |
| --- | --- |
| `contract` | `<run-dir>/contract.json` |
| `title` | `deck-plan.json.title` |
| `slides` | validated fragments, in DeckPlan order |
| `version` | `2` |
| `planDigest` | `deckPlanDigest(deck-plan.json)` |
| `theme` | omitted — v2 decks resolve style through the contract; only a legacy migration would set it |

Order of operations:

1. Collect findings for every slide before deciding anything.
2. Refuse to write on any hard finding — **no partial assembly**.
3. Construct the DeckSpec v2 object.
4. Parse it with `deckV2Schema.parse()` — exported from `src/schema.ts` today as
   `z.intersection(deckSchema, deckV2ShapeSchema)`, which enforces the DeckSpec rules and the v2
   fields (`version: 2`, a well-formed `planDigest`) in one pass. The plan-binding half of
   `planDigest` is a *contract* check, not a schema one, and comes from `verifyDeckAgainstPlan` in
   the next step.
5. Run `verifyDeckAgainstPlan` on the assembled deck.
6. Only then write, using `writeArtifactPair` from `src/artifacts.ts` so a failed write leaves the
   previous deck intact.
7. Record nothing new in `artifact-provenance.json`. **`deckSpecDigest` is deliberately not
   reintroduced for the MVP**: nothing would consume it. The deck is already tied to its plan by
   `planDigest` + `verifyDeckAgainstPlan` on `validate`/`render`/`qa`, and to its rendered output by
   `visual/render-provenance.json`. Add the field only alongside a verifier that reads it.

## 6. Concurrency belongs to the host

The CLI runs no model and spawns no workers, so it takes no `--concurrency` flag. `SKILL.md` gets the
loop: build contexts, author 3–5 fragments concurrently, assemble, and on failure re-author only the
slides named in the findings. Fragments are independent files and validation is per slide, so
concurrency is safe by construction.

## 7. Commands

```sh
node dist/cli.js authoring-context --run-dir <run-dir> --slide S04
node dist/cli.js deck-assemble --run-dir <run-dir> --out <deck.json>
```

Per-slide context is the primitive: a repair rebuilds one context. A batch command is not in scope
until repeated use shows the per-slide call is the bottleneck.

## 8. Tests the implementation must ship

Each one red-green: it fails when the rule it covers is removed.

Context building
1. Context contains exactly the slide's planned excerpts — no others.
2. A primary or secondary ref that does not resolve in the ContentModel fails context building.
3. Context is deterministic: two builds from identical inputs digest identically.
3a. The same semantic run copied to two different absolute filesystem roots produces an identical
    `AuthoringContext` and an identical `contextDigest` — no `templatePath`, run-dir path, or
    timestamp reaches the context.

Assets
3b. A slide whose `imagePath`/`assetPath` names an allow-listed asset passes.
3c. An arbitrary local path (`/etc/passwd`, `../../secret.png`, an absolute pack path) fails.
3d. An asset that is in another slide's context but not this one's fails.
3e. Changing an asset's bytes changes only the digest of the contexts that carry it, invalidating
    those slides and no others.

Fragment validation
4. A fragment citing evidence outside its context fails.
5. A fragment whose `contextDigest` is stale fails, and only that slide is reported.
6. A fragment whose headline or story beat drifts from the plan fails.
7. A fragment whose `claims[0].text` differs from its headline fails.
8. A composition outside the shortlist fails.
9. A **rank-2** candidate is accepted.
10. An invalid `SlideSpec` (schema violation) fails.

Assembly
11. A missing fragment fails.
12. An extra fragment for a slide not in the plan fails.
13. Two fragments for the same slide fail.
14. An arbitrary well-formed `planDigest` fails.
15. No `deck.json` is written when any hard finding exists, and a previous `deck.json` survives.
16. A successful assembly produces a DeckSpec v2 that passes `validate` → `render` → `qa`.

## 9. Design decisions

These are decided, not open:

- **Fragment format:** `contextDigest` + `SlideSpec`. Upstream digests live in the context.
- **Neighbour scope:** previous/next `{ id, takeaway }` only.
- **Partial assembly:** forbidden.
- **Context generation:** per-slide command.
- **Concurrency:** host-level, 3–5 recommended, never a CLI flag.
- **Composition:** shortlist membership, any rank.
- **Theme:** omitted from assembled v2 decks.
- **Style in context:** an authoring projection with no filesystem values, so `contextDigest` is
  host-neutral.
- **Assets:** an explicit per-slide allow-list; a fragment may not name a path outside it.
- **`deckSpecDigest`:** not reintroduced for the MVP — no verifier consumes it.

## 10. Scope

Design proposal only. `src/authoring.ts` is not implemented in the current stack, and #11 stays
scoped to host-neutral runtime plumbing.
