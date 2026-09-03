# Feedback learning loop

The runtime already repairs a slide inside one generation run. This document defines the separate, cross-run loop for failures that reveal a product gap.

## Goal

A failed render, a wrong automated diagnosis, or explicit user correction must become durable evidence rather than disappearing with the chat/session that discovered it.

The loop is:

```text
run failure / quality failure
        ↓
failure-report.json
        ↓
feedback-case.json (append-only events)
        ↓
user correction, when supplied
        ↓
maintainer resolution
        ↓
regression test / fixture
        ↓
feedback-cases/<case-id>.json
        ↓
CI prevents recurrence
```

A user correction may also be the **first** event. A run can pass every automated gate and still violate the user's requested behavior. The system must not require its own prior failure classification before it is willing to record the correction.

This is **not** a self-modifying agent. The runtime does not rewrite production code from feedback. It records evidence and makes regression promotion explicit and reviewable.

## Authority rule: user correction wins

Automated diagnosis is a hypothesis. If the user says the diagnosis is wrong, points out a missing requirement, or identifies the actual failure path, record that statement as a `user_correction` event immediately.

An accepted user correction becomes `effectiveConclusionEventId`. Later automated diagnoses may still be appended for investigation, but they are marked `advisory` and **must not replace the accepted user correction**. Only a newer user correction can supersede it directly. A maintainer resolution can close the case after the implementation has addressed the correction.

This rule exists because a visual/product failure often contains information that static QA cannot observe: the wrong template interpretation, a missing logo despite package validity, an output that is structurally valid but violates the user's requested behavior, or a workaround the host silently took outside the intended runtime.

It does not weaken hard safety/data contracts. A user correction changes the accepted product diagnosis/requirement; it does not authorize fabricated source claims, broken PPTX packages, or bypassing immutable brand constraints.

## CLI

Build first:

```sh
npm run build
```

Record a failed run:

```sh
node dist/feedback-cli.js failure \
  --run-dir <run-dir> \
  --stage template-routing \
  --code SPARSE_TEMPLATE_SEMANTIC_LOSS \
  --message "Sparse template was routed through source-slide patterns and dropped semantic content" \
  --evidence <artifact-path>
```

Record an automated diagnosis:

```sh
node dist/feedback-cli.js diagnose \
  --case <run-dir>/feedback-case.json \
  --code <diagnosis-code> \
  --summary "<current hypothesis>"
```

If the user corrects an existing diagnosis, record the correction **before continuing investigation**:

```sh
node dist/feedback-cli.js correct \
  --case <run-dir>/feedback-case.json \
  --code <corrected-code> \
  --summary "<user correction>" \
  --evidence "user feedback"
```

If no failure case exists because the run was previously considered successful, accept the correction directly from the run:

```sh
node dist/feedback-cli.js correct \
  --run-dir <run-dir> \
  --case-id <reusable-case-id> \
  --code <corrected-code> \
  --summary "<user correction>" \
  --evidence "user feedback"
```

This creates `feedback-case.json` with the user's correction as the first and effective event. `correct` prints `status: accepted`. A subsequent `diagnose` is advisory and does not change the effective conclusion.

After the code fix exists:

```sh
node dist/feedback-cli.js resolve \
  --case <run-dir>/feedback-case.json \
  --summary "<what changed and why>"
```

Promote only when a regression test (and fixture, if declared) exists:

```sh
node dist/feedback-cli.js promote \
  --case <run-dir>/feedback-case.json \
  --project-dir <repo-root> \
  --expected "<behavior that must never regress>" \
  --test tests/integration/<case>.test.ts \
  [--fixture tests/fixtures/<fixture>]
```

Promotion copies the case into `feedback-cases/`. The case retains its full event history, including superseded automated diagnoses and the user correction that changed the accepted direction. Promotion is rejected until the case has a maintainer resolution and the declared regression test/fixture actually exists.

## What becomes a feedback case

Use this loop for failures that can recur across runs or templates:

- wrong template strategy/routing;
- semantic content dropped while structural QA passes;
- mixed canvas/aspect ratio;
- corporate chrome/logo missing;
- fallback taken outside the intended runtime;
- package or editability regression;
- user explicitly says the result or our diagnosis is wrong.

Do not promote ordinary one-off content edits (typos, a preference for different wording) unless they expose a reusable rule or product contract.

## Example: sparse 4:3 brand shell

Observed failure:

```text
4:3 template with only logo + one thin text placeholder
→ treated as reusable source-slide pattern
→ steps/zones/comparison structure lost
→ some slides generic 16:9
→ mixed aspect ratio and inherited placeholder font
```

A system may initially diagnose this as “the template cannot satisfy the deck.” If the user corrects that conclusion to “this is a runtime routing gap; preserve the 4:3 brand shell and generate semantic bodies,” the user correction becomes authoritative for the case.

The eventual regression should prove the corrected requirement, not the superseded diagnosis:

```text
sparse template
→ preserve source canvas/master/theme/chrome
→ generative semantic body composition
→ one canvas across the deck
→ no semantic content loss
```
