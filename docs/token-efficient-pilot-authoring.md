# Token-efficient pilot and full-deck authoring

This workflow sits between validated planning and the existing canonical render / QA pipeline. It reduces host-model context by proving the storyline and design direction on a representative pilot before authoring the remaining slides.

## Gate order

```text
StorylineBlueprint
  -> DeckPlan
  -> composition shortlist
  -> deterministic pilot-select (default 3 slides, 0 model calls)
  -> pilot authoring context (selected slides only)
  -> pilot apply
  -> canonical render / Core QA / Visual QA
  -> pilot approve
  -> slide-local authoring for non-pilot slides only
  -> deterministic full-deck assembly (0 model calls)
  -> canonical validate / render / QA
  -> tokens + quality score
  -> benchmark eval gate
  -> regression history
  -> release
```

The approved pilot slides are immutable inputs to full-deck assembly. `full-slide-context` and `full-deck slide-apply` reject those ids instead of spending model tokens to generate them a second time. Canonical `validate`, `render`, and `qa` also re-hash the full assembly provenance chain, including every stored non-pilot slide artifact, so post-assembly edits cannot bypass the gate.

## Commands after planning / style / composition

```sh
npm run planning -- pilot-select --run-dir <run-dir>
npm run pilot -- context --run-dir <run-dir>
# Host authors only the selected slides into <pilot-slides.json>.
npm run pilot -- apply --run-dir <run-dir> --slides <pilot-slides.json>

# Render pilot-deck.json with the existing canonical generic or raw-template runtime.
# Then run the existing visual renderer so render-provenance.json exists.
npm run pilot -- core-qa --run-dir <run-dir> --pptx <pilot.pptx>
npm run pilot -- judge-context --run-dir <run-dir> --pptx <pilot.pptx>
# Host judges only the rendered pilot and writes closed-code visual findings.
npm run pilot -- approve --run-dir <run-dir> --pptx <pilot.pptx> --findings <visual-findings.json>
```

Only a `pass` pilot unlocks the rest of the deck. A Visual QA `risk` is intentionally blocking here because continuing would multiply the same design defect across the remaining slides.

For every non-pilot slide, request a slide-local context and author exactly that slide:

```sh
npm run pilot -- full-slide-context --run-dir <run-dir> --slide S04 --out <S04-context.json>
# Host writes { "version": 1, "slide": <SlideSpec> }.
npm run full-deck -- slide-apply --run-dir <run-dir> --slide S04 --input <S04.json>
```

`slide-apply` re-checks the approved thesis, story beat, primary evidence and resolved composition shortlist. The stored artifact is bound to the current Storyline, DeckPlan, composition plan and pilot approval digests.

When every non-pilot slide has passed:

```sh
npm run full-deck -- assemble --run-dir <run-dir>
# -> <run-dir>/deck.json
# -> <run-dir>/full-deck-assembly-qa.json
# -> <run-dir>/full-slide-manifest.json
```

Assembly is deterministic and makes no model call. Slides are ordered by DeckPlan. Pilot slides come directly from `pilot-spec.json`; only non-pilot slides come from `full-slides/`. The output is DeckSpec v2 with the current `planDigest`, so the existing `validate`, `render`, `qa` and release gates remain authoritative.

## Measured evaluation and regression gate

Token efficiency is not inferred from prompt size proxies. For a real-world benchmark, measure the actual host transcript, score the final rendered deck, then run the benchmark policy before recording history:

```sh
node dist/cli.js tokens --spec <run-dir>/deck.json --run-dir <run-dir> \
  --benchmark jp-ai-weekly-update --transcript <session.jsonl>
node dist/cli.js score --spec <run-dir>/deck.json --run-dir <run-dir> --scores <scores.json>
npm run eval-gate -- --run-dir <run-dir> --benchmark jp-ai-weekly-update
node dist/cli.js record --spec <run-dir>/deck.json --run-dir <run-dir> \
  --benchmark jp-ai-weekly-update --version <version>
```

`record` recomputes the same gate immediately before appending history; a stale `eval-gate.json` cannot be used to bypass a regression. Benchmark limits live in `evals/real-world/<benchmark>/policy.yaml`, not in general generation code. This matters because PRD §15 explicitly describes `<30k` as an engineering target for ordinary 8–12 slide business presentations, not a universal hard limit for research-heavy decks.

For `jp-ai-weekly-update`, the policy requires:

- measured token telemetry; an unavailable denominator cannot pass as a zero-cost run;
- **<30,000 total tokens** (exclusive), matching the PRD P0 target for this fixed 8-slide moderate-complexity task;
- zero hard QA failures;
- after the first passing record establishes a baseline, no decrease in raw quality score;
- no decrease in quality per 10k effective tokens.

The last two checks make the history Pareto-style: lowering tokens by sacrificing quality is not an improvement, and raising quality while spending proportionally more tokens is not an efficiency improvement.

## Token policy

- Never send the full ContentModel to a slide author when its slide-local evidence is sufficient.
- Shared evidence appears once per compact context and is referenced by key.
- Speaker notes are excluded from structural planning context.
- Pilot selection and full-deck assembly are deterministic runtime work, not model work.
- An approved pilot slide is never re-authored during the same provenance chain.
- Do not create a full-deck authoring prompt before pilot approval.
- Use the existing token telemetry phases; do not create a new phase merely for this workflow, so before/after runs remain comparable.
