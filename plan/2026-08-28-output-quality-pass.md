# ppt-agent — output quality pass against the Japan Career Agent regression

## Context

The engine passes Core QA and still ships visually weak decks. The regression case is the
14-slide Japan Career Agent run at `/Users/macbook/dev/tools/ppt-storage/runs/jca`
(`deck.v4.json`, `visual/montage.png`, `japan-career-agent.pptx.pdf`). An external review
listed 8 failures. Seven hold up against the artifacts; one does not, and that correction
changes what gets built.

### What the artifacts actually show

- **`visual/montage.png`** — S04/S06/S11/S12 are all "N equal column zones, boxes stacked
  top-down, thin arrows"; S05/S10/S13 are all "numbered circles in one horizontal row".
  On 8 of 13 body slides the composition is a single row of equal cells occupying the top
  ~45% of the content box, with the bottom half empty. Root cause is in the renderer:
  `renderArchitecture` draws a fixed `h: 4.95` zone regardless of node count, and
  `renderProcess` pins its row at a fixed `y: CONTENT_Y + 1.1`. Nothing is fitted to its
  content and nothing is centred.
- **S07 "18 skills, one job each"** renders 5 stage cards. The headline asserts a quantity
  the visual never shows. Deterministically detectable — no judgment layer needed.
- **S02 `career AI is / is the confident guess` is NOT a copy bug.** `deck.v4.json` and
  `ppt/slides/slide2.xml` each contain the headline exactly once. The duplication exists
  only in `japan-career-agent.pptx.pdf`, produced at 20:58 — five minutes *after* `visual`
  ran at 20:53 — by a converter outside the pipeline, with a different font substitution
  (montage renders serif, PDF renders grotesk, neither is the contracted Helvetica Neue).
  A `DUPLICATED_ADJACENT_TOKEN` detector would never fire on this deck. The real defects
  underneath it are: the judged artifact was not the delivered artifact, and render-time
  font substitution goes unnoticed. Both are fixed below; the copy detector is not built.
- **`tokens.json` reports 0** across every phase. `resolveTranscript` picked the newest
  `.jsonl` in the project slug directory, which was not the session that ran `/ppt`, so the
  window caught zero turns and 0 was written as if measured.

Intended outcome: the same source material should read as intentionally designed slide by
slide, and the checks that were supposed to catch these failures should actually fire.

Scope confirmed with the user: all four workstreams (A–D). The regression deck is **not**
re-rendered in this PR — regression assertions pin the current `deck.v4.json` as a fixture
instead, so the failures are proven caught without spending the authoring loop.

---

## Step 0 — session-closure artifacts (global CLAUDE.md §5)

Plan mode permits editing only this file, so these are written first on execution:

1. `~/.claude/projects/-Users-macbook-dev-tools-ppt-agent-public/memory/` — save the S02
   root-cause finding (converter artifact, not a copy bug) and the "regression deck lives
   in `ppt-storage/runs/jca`, outside the repo" fact, then update `MEMORY.md`.
2. `plan/2026-08-28-output-quality-pass.md` in the repo — this plan, committed with the work.

---

## A. Verification and telemetry

**A1 — the deliverable PDF becomes the judged artifact.** `src/visual.ts`
`libreOfficeBackend.render` converts to PDF in a temp dir and deletes it. Move that PDF to
`<run-dir>/visual/deck.pdf` before the `finally` cleanup. One converter, one artifact; the
class of divergence that produced the `is / is` render is removed rather than detected.

**A2 — stale-render guard.** `visual/index.json` is written by the backend (including
`scripts/render-slides.ps1`), so leave its shape alone. `writeVisualArtifacts` additionally
writes `visual/render-provenance.json`: `{ pptxSha256, specSha256, renderedAt, slideIds }`.
`visual-qa` gains an optional `--pptx` and compares:

- provenance present, digest mismatch → **hard** `VISUAL_QA_STALE_RENDER`
- provenance absent (pre-existing runs) → **risk** `VISUAL_RENDER_PROVENANCE_UNKNOWN`

**A3 — release gate.** `release` (`src/cli.ts`) blocks when the released pptx digest differs
from the one in `render-provenance.json`. Reuses A2's helper.

**A4 — render-time font substitution.** After the soffice conversion, run Poppler `pdffonts`
on the produced PDF; families outside `{contract.fonts.heading, contract.fonts.body}` (subset
prefixes `ABCDEF+` stripped) land in `backend.json` as `substitutedFonts`. `visual-qa` emits
**risk** `RENDER_FONT_SUBSTITUTION`. `pdffonts` absent → record `"unknown"`, emit nothing.
CI is Windows-only and never runs `visual`, so this must degrade silently.

**A5 — token telemetry never reports a misleading zero.** In `src/tokens.ts`:

- `resolveTranscript` currently picks the newest `.jsonl` by mtime. Change it to pick, from
  the same project-slug directory, the transcript with the most turns inside the measurement
  window — that is the root cause of the 0, and it is deterministic, not a heuristic.
  Add `--session-id <uuid>` for an explicit override alongside the existing `--transcript`.
- `TokenReport` gains `measurement: "measured" | "unavailable"` plus `unavailableReason`.
  When `total.turns === 0`, per-slide ratios are `null`, not `0`.
- CLI `tokens` exits non-zero on `unavailable` unless `--allow-unmeasured`.
- `record` refuses to merge an `unavailable` report into `history.jsonl`.

## B. Headline ↔ visual proof

New Core QA check in `src/qa.ts`, `addHeadlineProofFindings` — deterministic, no new authored
schema fields (rejecting the reviewer's `assertion/support/visualIntent/mustShow` contract:
four more LLM-authored fields, more token cost, and nothing verifiable).

- Helper `countableElements(slide)` returns the slide's countable collection size per layout
  (process → steps, architecture → zones and total nodes, pipeline → nodes, comparison →
  items, quantitative → metrics, timeline → milestones, statement → proofs, evidence →
  bullets).
- Headline is scanned for `(\d+)\s+([a-z]+s)\b`. Fires **hard**
  `VISUAL_DOES_NOT_PROVE_HEADLINE` only when `number > count` — a slide showing more detail
  than it claims is fine, one claiming more than it shows is not.
- Suppressed when the number appears verbatim in a rendered label/detail, i.e. the claim is
  literally on the slide.

Schema support so S07 can be repaired rather than only flagged: `processSlideSchema` step
gains optional `members: z.array(z.string().min(1)).max(8)`, `stage_gate` renders them as
chips under each stage label, and they count toward `countableElements`. 5 stages carrying
18 named skills then proves "18 skills". Text budget: member ≤ 22 display columns.

## C. Composition families and perceptual repetition

**C1 — family map.** `src/schema.ts` exports `compositionFamily`, mapping every composition
to one of seven skeletons: `single_focal`, `split_panels`, `column_zones`,
`horizontal_sequence`, `stacked_rows`, `radial`, `plot`.

**C2 — repetition at the family level**, in `src/qa.ts`:

- `REPEATED_COMPOSITION_FAMILY_RUN` (risk) — 3+ consecutive body slides in one family
- `DOMINANT_COMPOSITION_FAMILY` (risk) — one family over 40% of body slides
- `LOW_COMPOSITION_FAMILY_VARIETY` (risk) — under 4 families at 12+ body slides, 3 at 8+

**C3 — `UNIFORM_CELL_RHYTHM` (risk, deck-level) is the check that actually catches this deck.**
Counting families is not enough, and the fixture proves it: `deck.v4.json` has 13 body slides
across 4 distinct families with the largest at 31%, so every threshold in C2 passes while the
deck reads as three slides repeated. The discriminator is cell geometry, not family name.
`structuralSkeleton(slide)` yields `{ axis, cellCount }` — `column_zones` and
`horizontal_sequence` both produce `axis: "x"`. When ≥60% of body slides lay equal cells on
the same axis, flag it. On the fixture that is 8/13 = 62%, and it fires.

**C4 — three new compositions.** Three, not twenty; each earns its slot from a specific
regression slide.

| Composition | Layout | Serves | Shape |
| --- | --- | --- | --- |
| `central_hub` | architecture | S04, S11 | zone[0] is the hub, drawn large and centred; zones[1..] radiate around it; edges hub↔satellite. 2–5 zones. |
| `layered_stack` | architecture | S06, S12 | zones as full-width bands stacked top→bottom, nodes as chips inside, band height weighted by node count, dependency rail down the left. 2–6 zones. |
| `verdict_contrast` | comparison | S09 | the contested figure (`delta`) as the focal object at KPI scale, the two readings as asymmetric panels — rejected reading muted, adopted reading accented. |

Each needs an entry in `allowedCompositions`, `requiredNativeObjectsByComposition`,
`compositionProfile` (`src/qa.ts`), `compositionFamily`, `visualCompositions`
(`src/visual-qa.ts`, so the stage archetype counts them as visual weight), plus the
composition table in `SKILL.md`.

## D. Renderer visual hierarchy

**D1 — content-fitted, vertically centred bands.** One helper in `src/renderer.ts`:

```ts
function band(contentHeight: number): { y: number; h: number }
```

centring a band of `contentHeight` inside `[CONTENT_Y, CONTENT_Y + CONTENT_H]`, clamped.
Applied in `renderArchitecture` (zone height becomes `1.22 + nodes * 0.62 + 0.2` instead of
the fixed `4.95`), both `renderProcess` branches, `renderTimeline`, `renderComparison`
(`two_column`, `ownership_split`), and `renderEvidence`. This single change removes the dead
bottom half on S04–S13.

**D2 — scale contrast.** Zone label `15` → `18 * focalVisualScale`; process step label `16` →
`19 * focalVisualScale`; node and chip text unchanged. The diagram gets a real type hierarchy
instead of 15pt against 11pt.

**D3 — asymmetry derived from meaning, not decoration.** In `architecture_zones`, when every
edge terminates in one zone, that zone is the subject: 1.35× width and the accent border.
Derived from `content.edges`, deterministic. On S04 the convergence target is
"Every task reuses it", which is exactly the slide's subject.

All D work is authored in canonical content space and passes through `ctx.transform`, so the
Organization Template Pack path — including 4:3 — is untouched by construction.

Explicitly **not** built, per the reviewer's own constraint: rounded-card proliferation,
gradients, decorative icons, fake dashboards, or a long tail of arbitrary layouts.

---

## Files touched

- `src/renderer.ts` — D1–D3, `central_hub`, `layered_stack`, `verdict_contrast`, `stage_gate` members
- `src/schema.ts` — `compositionFamily`, three new compositions, `step.members`
- `src/qa.ts` — headline proof, family repetition, `UNIFORM_CELL_RHYTHM`, member text budget
- `src/visual.ts` — keep `deck.pdf`, write `render-provenance.json`, `pdffonts` probe
- `src/visual-qa.ts` — 3 new codes and their severities, `visualCompositions` update
- `src/tokens.ts` — transcript selection by turn coverage, `measurement` field, null ratios
- `src/cli.ts` — `visual-qa --pptx`, `tokens --session-id/--allow-unmeasured`, release gate
- `SKILL.md`, `docs/PRD_PRESENTATION_QUALITY.md` — new codes, compositions, telemetry contract

## Tests

New:

- `tests/fixtures/japan-career-agent/` — `deck.v4.json`, `contract.json`, `content-model.json`
  copied from the run dir
- `tests/unit/composition-family.test.ts` — fixture trips `UNIFORM_CELL_RHYTHM`; documents
  that the C2 count thresholds do **not** fire on it, which is why C3 exists
- `tests/unit/headline-proof.test.ts` — S07 as authored trips
  `VISUAL_DOES_NOT_PROVE_HEADLINE`; the same slide with 18 `members` passes; a headline
  number ≤ the element count never fires
- `tests/unit/visual-provenance.test.ts` — digest match passes; a re-rendered pptx against a
  stale provenance file yields hard `VISUAL_QA_STALE_RENDER`; a missing file yields risk
- `tests/unit/tokens-unavailable.test.ts` — a window with zero turns yields
  `measurement: "unavailable"` and `null` ratios, never `0`; transcript selection picks the
  covering session over the merely-newest one

Updated: `tests/unit/architecture-layout.test.ts`, `tests/unit/pipeline-layout.test.ts`,
`tests/integration/render.test.ts` — D1–D3 move rects. Assertions are rewritten to the new
invariants (band is centred, zone height tracks node count) rather than to fresh magic numbers.

Must stay green untouched: `tests/integration/template-adapter.test.ts` (4:3 org pack),
`tests/unit/organization.test.ts`, `tests/unit/style.test.ts`.

## Verification

1. `npm run typecheck` — 0 errors.
2. `npm test` — full suite, 0 failures; report the counts.
3. `npm run build` — exit 0.
4. Red-green on the two new deterministic gates: confirm the fixture fails
   `VISUAL_DOES_NOT_PROVE_HEADLINE` and `UNIFORM_CELL_RHYTHM` before the S07 `members` /
   composition work lands, and passes after.
5. Visual proof of D: render the fixture deck to PPTX, rasterize with `soffice` + `pdftoppm`
   into a montage, read it, and confirm the dead bottom half is gone on the architecture and
   process slides. Report before/after side by side.
6. Confirm the 4:3 organization-pack test still passes — named explicitly, not assumed.

## Commit

Branch off `main` (`feat/output-quality-regression`), conventional commits per workstream,
push, open a PR summarizing A–D with the before/after montage and the corrected S02 finding.
