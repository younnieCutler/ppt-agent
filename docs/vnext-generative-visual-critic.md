# vNext Generative Visual Critic

The Generative Scene runtime already owns deterministic validity. The visual critic has a different job: judge whether a valid slide is actually well designed, then request the smallest legal Scene patch.

## Authority boundary

```text
Grounded Generative Scene
        ↓
PPTX render + slide images
        ↓
Visual Critic
  hierarchy / balance / purpose fit /
  readability / professionalism / template fit
        ↓
Targeted Scene patch
  frame / emphasis / grouping / style role /
  template component preference / structural surface-divider
        ↓
Deterministic Scene + brand validation
        ↓
re-render + re-judge
        ↓
PASS or hard fail after 2 repairs
```

The critic never edits PPTX coordinates, OOXML, source shape ids, text content, semantic intent, headline, fonts, colors, or immutable company chrome.

## Scores

Every generative slide receives 0–10 scores for:

- Visual Hierarchy
- Composition Balance
- Purpose Fit
- Readability
- Professionalism
- Template Fit

Thresholds are deterministic runtime policy, not model-authored severity. A below-threshold dimension or an explicit repairable visual finding routes only that slide into repair.

## Repair contract

Repair is patch-based, not regeneration-based. Allowed operations are:

- `set_frame`
- `set_emphasis`
- `set_group`
- `set_style_role`
- `set_component_preference`
- `add_structure` (`surface` or `divider` only)
- `remove_structure` (`surface` or `divider` only)

Text node ids, roles and text are frozen as a signature before the patch and verified after it. Structural additions cannot carry text. Every patched Scene is parsed again and passed through `resolveGenerativeScene`, so content-canvas overflow, immutable chrome collision, unsupported style roles and corporate brand policy still hard-fail.

## Bounded loop

`runBoundedGenerativeCriticLoop` is provider-neutral. The host supplies three callbacks:

1. `render(scenes, round)` — produce the current judged slide images and exact sha256 provenance.
2. `judge(request)` — invoke a vision-capable model using the critic contract.
3. `repair(request)` — invoke a model to return only allowed Scene patch operations.

Round 0 is the first judgment. At most two repair rounds are allowed. Passing slides are not patched. If any slide remains below threshold after round 2, the loop throws `GENERATIVE_CRITIC_REPAIR_EXHAUSTED`; weak output is not silently published.

No model provider SDK is embedded in core. Claude Code, Codex, an API host or another capable agent may implement the callback boundary without changing the deterministic runtime.
