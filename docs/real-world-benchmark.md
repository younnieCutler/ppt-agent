# Bound real-world benchmark runs

Real-world evaluation is meaningful only when the generated deck can be proven to come from the benchmark task and source bytes being compared. A `--benchmark` string by itself is not provenance.

## Start a run

```sh
npm run benchmark -- start --benchmark jp-ai-weekly-update
```

This creates a fresh `.ppt-agent/runs/<run-id>/` workspace and writes:

- `contract.json` — normalized GenerationContract built from `task.yaml` plus the fixture source paths;
- `benchmark-run.json` — SHA-256 binding for `task.yaml`, `policy.yaml`, `contract.json`, and every source file;
- `benchmark-context.json` — compact host-facing task metadata and source paths.

Read `benchmark-context.json`, the listed source files, and the canonical `SKILL.md`. Do **not** read `baseline/` or `history.jsonl` while authoring or judging the run: they are regression outputs, not generation inputs.

Then execute the canonical workflow from StorylineBlueprint through Pilot approval, slide-local authoring, deterministic assembly, final render, Core QA, Visual QA, and failed-slide-only repair.

## Verify identity at any time

```sh
npm run benchmark -- verify \
  --benchmark jp-ai-weekly-update \
  --run-dir <run-dir>
```

The check fails if the benchmark id differs or any bound task, policy, contract, or source bytes changed after run start.

## Measure and record

After the final accepted deck and Visual QA:

```sh
node dist/cli.js tokens --spec <run-dir>/deck.json --run-dir <run-dir> \
  --benchmark jp-ai-weekly-update --transcript <session.jsonl>
node dist/cli.js score --spec <run-dir>/deck.json --run-dir <run-dir> --scores <scores.json>
npm run eval-gate -- --run-dir <run-dir> --benchmark jp-ai-weekly-update
node dist/cli.js record --spec <run-dir>/deck.json --run-dir <run-dir> \
  --benchmark jp-ai-weekly-update --version <version>
```

For a policy with `identity.requireBoundRun: true`, `eval-gate` re-verifies `benchmark-run.json` against the current fixture bytes. `record` recomputes `eval-gate` immediately before appending `history.jsonl`, so neither a stale gate file nor an unrelated deck can be recorded as a valid benchmark result.

`jp-ai-weekly-update` currently requires measured telemetry, zero hard failures, and fewer than 30,000 total tokens. Once the first passing measured run is recorded, raw quality and quality per 10k effective tokens must also remain non-regressing.
