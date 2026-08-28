# PRD — Presentation Quality & Efficiency Upgrade

**Status:** Canonical
**Scope:** Post-PR5
**Product:** `ppt-agent`
**Priority:** P0

> This is the canonical requirements document for the presentation quality and efficiency
> initiative. Code, rubrics, and eval fixtures are downstream of it — `evals/real-world/*/rubric.yaml`
> records the findings for one benchmark and is **not** a substitute for this document.
>
> Every PR in this initiative should be traceable to a section here. If a change cannot be traced to
> one, either the change is out of scope or this document needs updating first.

---

## 1. Background

`ppt-agent` has reached a relatively mature structural foundation:

* deterministic PPTX rendering
* compact DeckSpec
* source grounding
* native editable charts
* reference retrieval
* OOXML/Core QA
* Visual QA
* slide-scoped repair
* presentation archetypes
* organization template packs
* 16:9 / 4:3 canvas support

However, structural correctness is ahead of actual presentation quality.

The current default design remains below the desired production standard.

A representative pre-PR5 8-slide `AI WEEKLY UPDATE` deck demonstrates the gap. The deck successfully communicates a coherent narrative from AI governance and PoC adoption through digital workers, Physical AI, national security, and SMB investment.
Despite this, the resulting presentation still requires significant human redesign.

The same generation consumed approximately **70k LLM tokens for only 8 slides**.

This creates two P0 product gaps:

1. **Default presentation quality is insufficient.**
2. **Token cost is disproportionate to final quality.**

---

## 2. Product Principle

The product must optimize for:

> **Maximum reliable presentation quality per unit of model computation.**

Neither of the following is sufficient:

* Core QA passes.
* The output does not look like stereotypical AI slop.

The target is:

> A competent presentation designer should consider the generated structure, hierarchy, typography, and visual representation reasonable without redesigning the deck from scratch.

---

## 3. Goals

### G1. Redesign Default Presentation Quality

Improve the no-reference/default path so that it produces professional presentation design without requiring external inspiration.

Primary dimensions:

* Visual Hierarchy
* Composition
* Typography
* Semantic Visualization
* Layout Variety
* Purpose Fit
* Long-deck Consistency

Every slide should look intentionally composed for its specific message.

### G2. Introduce Reference-driven Design Grammar

External references should improve the internal presentation grammar without becoming templates to copy.

Preferred reference sources:

#### Presentation Design Vocabulary

**PPTX.gallery**

Use for:

* layout taxonomy
* narrative vocabulary
* palette concepts
* font hierarchy
* presentation design ontology

#### Real-world Presentation Quality

**Beautiful Decks**

**Deck.gallery**

Use for:

* composition quality
* layout variation
* visual hierarchy
* real pitch/report/product presentation patterns

#### Japanese Corporate

Use official public materials from high-quality Japanese companies such as:

* Sony
* SoftBank Group
* Recruit Holdings

Use for:

* Japanese typography
* information-dense layouts
* charts
* annotations
* footnotes
* corporate hierarchy
* long-deck consistency

#### Technical Presentations

**Speaker Deck**

Use for:

* architecture diagrams
* system flows
* engineering explanations
* technical trade-offs
* before/after diagrams
* benchmark presentation

---

## 4. Reference Design Principle

References are **grammar sources**, not golden screenshots.

Preferred flow:

```text
Reference
   ↓
Reference Analysis
   ↓
Frozen Design Grammar
   ↓
Resolved Presentation Style
   ↓
Deck Composition
```

Example:

```yaml
grammar:
  density: high

  headline:
    type: assertion
    scale: medium

  whitespace: moderate
  surfaceUsage: low
  chartTreatment: analytical
  decoration: minimal
  layoutVariation: high
```

The evaluation question is:

> Did the output reproduce the relevant design principles?

Not:

> Does the output visually copy the original deck?

Reference content must never be treated as factual source material unless explicitly supplied as such.

---

## 5. Default Design Must Remain First-class

`ppt-agent` must not become dependent on external references.

The following must remain a valid production path:

```text
Source
  ↓
Purpose / Audience
  ↓
Presentation Style
  ↓
Internal Design Grammar
  ↓
Composition Selection
  ↓
Professional Deck
```

A significant part of evaluation must therefore contain **no reference**.

Recommended benchmark distribution:

```text
30%  No reference
30%  Design direction only
20%  Website / visual reference
20%  Real deck / report reference
```

---

## 6. Known Baseline Problems

The pre-PR5 deck is retained as the first real-world regression baseline.

### 6.1 Japanese Typography

Observed issues include:

* punctuation orphaning
* unnatural Japanese line wrapping
* headline fragments pushed to another line
* mechanically valid but visually poor wrapping

Required Visual QA findings:

```text
JAPANESE_ORPHAN_PUNCTUATION
JAPANESE_AWKWARD_LINE_BREAK
HEADLINE_BAD_WRAP
```

Japanese Kinsoku Shori and headline-aware line breaking should be considered separately from basic overflow detection.

### 6.2 Misleading Quantitative Encoding

A baseline slide contains:

* 200 humanoids
* 300,000 accumulated learning hours
* 100 intended deployments

These values use different units and cannot be represented as directly comparable quantitative bars.

A slide can therefore be:

```text
source-grounded     PASS
native objects      PASS
geometry            PASS
text overflow       PASS
```

while still being semantically wrong.

Required findings:

```text
MISLEADING_QUANTITATIVE_ENCODING
INCOMPARABLE_METRIC_SCALE
WEAK_SEMANTIC_VISUALIZATION
```

`MISLEADING_QUANTITATIVE_ENCODING` should be eligible for hard-failure treatment.

### 6.3 Weak Semantic Composition

The renderer currently tends to choose structurally safe compositions.

Symptoms include:

* text + primitive shapes where a diagram would communicate better
* bullet slides for conceptually rich information
* KPI slides without sufficient narrative implication
* weak use of available canvas
* visual treatments that correctly contain information but do not explain it

Composition selection should answer:

> What representation best communicates this message?

not merely:

> Which supported layout can contain these objects?

### 6.4 Weak Default Visual Language

The current default style frequently appears mechanically generated.

Failure patterns include:

* insufficient focal hierarchy
* layouts exposing renderer primitives
* overly cautious compositions
* weak relationship between message importance and visual treatment
* unused space without compositional intent
* insufficient visual distinction across slide purposes

This must be treated as a core product problem rather than a cosmetic enhancement.

---

## 7. Anti-Slop Requirement

Avoiding AI slop remains mandatory.

Existing undesirable patterns include:

* excessive rounded cards
* decorative shapes without semantic purpose
* repeated three-column layouts
* unnecessary gradients
* arbitrary icons
* fake dashboards
* generic infographic patterns
* repetitive slide structures

However:

> **Not AI slop ≠ good presentation.**

Sparse layouts, white backgrounds, tables, dense reports, and restrained compositions must not be penalized simply for being visually simple.

---

## 8. Real-world Evaluation System

Synthetic/unit tests are insufficient for judging presentation quality.

Create a fixed real-world Gold Set.

Initial target:

**20–30 presentation tasks**

Recommended domains:

| Domain                | Initial Cases |
| --------------------- | ------------: |
| No-reference baseline |             5 |
| Corporate             |             4 |
| Executive             |             3 |
| Analytical            |             4 |
| Product               |             3 |
| Editorial / Stage     |             3 |
| Japanese Corporate    |             5 |
| Technical             |           3–4 |

Cases may overlap archetypes where appropriate.

---

## 9. First Regression Fixture

Preserve the current deck as:

```text
evals/
└── real-world/
    └── jp-ai-weekly-update/
        ├── task.yaml
        ├── source/
        ├── baseline/
        │   └── pre-pr5.pdf
        ├── rubric.yaml
        └── history.jsonl
```

Initial known findings:

```yaml
knownFindings:

  - code: JAPANESE_ORPHAN_PUNCTUATION

  - code: HEADLINE_BAD_WRAP

  - code: MISLEADING_QUANTITATIVE_ENCODING
    severity: hard

  - code: WEAK_SEMANTIC_VISUALIZATION

  - code: JAPANESE_AWKWARD_LINE_BREAK
```

This fixture should remain stable so future versions can be compared against a real pre-improvement baseline.

---

## 10. Evaluation Dimensions

Each real-world output should be scored separately.

Recommended dimensions:

| Dimension                | Weight |
| ------------------------ | -----: |
| Content Fidelity         |     20 |
| Narrative Quality        |     15 |
| Visual Hierarchy         |     15 |
| Semantic Visualization   |     10 |
| Reference Grammar Fit    |     10 |
| Layout Variety           |     10 |
| Typography / Readability |     10 |
| Purpose Fit              |      5 |
| Anti-slop                |      5 |

Structural/native QA remains independent.

Hard failures override aggregate quality scores.

Examples:

```text
unsupported factual claim
source grounding failure
misleading quantitative encoding
required native object missing
unreadable content
off-canvas content
organization template violation
```

---

## 11. Same-source A/B Evaluation

The same source should periodically be generated under multiple design contexts.

Example:

```text
Same Source
   │
   ├── No Reference
   ├── Japanese Corporate
   ├── Analytical
   └── Product / SaaS
```

Expected differences:

* information density
* headline style
* whitespace
* visualization selection
* annotation density
* typography scale
* layout composition

Content claims must remain unchanged.

This verifies that the system understands presentation grammar rather than simply copying visual assets.

---

## 12. Token Efficiency

Token efficiency is a first-class product metric.

Current real-world baseline:

```text
Slides              8
Approx. Tokens       70,000
Tokens / Slide       ~8,750
Final Quality        Below production target
```

This is not acceptable as the normal operating profile for a small business deck.

The desired trajectory is:

```text
Quality ↑
Tokens  ↓
```

---

## 13. Token Telemetry

Each evaluation run should record:

```yaml
tokenUsage:

  total:
  input:
  output:

  phases:
    sourceUnderstanding:
    outline:
    referenceRetrieval:
    styleResolution:
    compositionAuthoring:
    visualJudgment:
    repair:

  tokensPerSlide:
  repairOverhead:
```

If exact provider-level phase metrics are unavailable, use the closest reliable measurement.

---

## 14. Efficiency Metrics

Track at minimum:

### Tokens per Slide

```text
totalTokens / slideCount
```

### Tokens per Accepted Slide

```text
totalTokens / finalAcceptedSlides
```

### Repair Overhead

```text
repairTokens / totalTokens
```

### Quality per 10k Tokens

```text
qualityScore / (totalTokens / 10,000)
```

Quality should never be evaluated without cost context.

---

## 15. Initial Token Targets

For ordinary 8–12 slide business presentations with moderate source complexity:

### P0

```text
< 30k total tokens
```

### Desired

```text
15k–25k total tokens
```

### Long-term Stretch

```text
< 2k effective LLM tokens / slide
```

These are engineering targets rather than universal hard limits.

Research-heavy or unusually large source material may legitimately exceed them.

---

## 16. Context Efficiency Requirements

Do not repeatedly expose the model to already-normalized information.

Preferred pipeline:

```text
Raw Sources
     ↓
Compact Content Model
     ↓
Story / Outline
     ↓
Compact Style Context
     ↓
Slide-local Authoring
     ↓
Render
     ↓
Visual QA
     ↓
Failed-slide-only Repair
```

Avoid repeatedly injecting:

```text
full source corpus
+ full reference catalog
+ complete schema
+ full DeckSpec
+ every slide
+ QA history
+ repair history
```

into multiple LLM calls.

---

## 17. Slide-local Reasoning

After deck-level story and style are resolved, most authoring should be slide-local.

A slide author should normally receive only:

* deck purpose
* audience
* slide story beat
* required source references
* relevant dataset
* resolved design grammar
* limited adjacent-slide context when necessary

Full-source re-ingestion should be exceptional.

---

## 18. Reference Retrieval Efficiency

The reference library must scale through retrieval, not context dumping.

Required model:

```text
Reference Library
      ↓
Index
      ↓
Retrieval
      ↓
Top-k candidates
      ↓
Compact Design Grammar
      ↓
LLM
```

Increasing the number of available references must not proportionally increase generation context size.

---

## 19. Repair Efficiency

A failed slide must not trigger full-deck regeneration.

Required:

```text
Slide 05 fails
     ↓
Slide 05 repair context
     ↓
Slide 05 regeneration
     ↓
Scoped render
     ↓
Scoped QA
```

Not:

```text
Slide 05 fails
     ↓
Full deck returned to model
     ↓
Entire deck regenerated
```

The existing scoped-repair architecture remains mandatory.

---

## 20. Evaluation History

`evals/history.jsonl` should evolve from pass/fail history into quality regression history.

Recommended record:

```json
{
  "benchmark": "jp-ai-weekly-update",
  "version": "post-pr5",
  "slides": 8,
  "tokens": 24000,
  "qualityScore": 84.2,
  "hardFailures": 0,
  "dimensions": {
    "narrative": 86,
    "hierarchy": 82,
    "semanticVisualization": 85,
    "typography": 80,
    "antiSlop": 91
  }
}
```

The system should make regressions visible.

Example:

```text
Version       Tokens     Quality
---------------------------------
pre-PR5       70k        71
next          34k        80
future        22k        86
```

---

## 21. Priority Order

Post-PR5 work should prioritize:

### P0 — Measurement

* preserve current real-world baseline
* token telemetry by phase
* quality scoring
* regression history

### P0 — Default Design

* improve composition selection
* improve visual hierarchy
* improve semantic visualization
* improve Japanese typography

### P0 — Reference System

* establish reference manifest
* extract frozen design grammar
* integrate presentation references into evaluation
* maintain a strong no-reference path

### P1 — Real-world Gold Set

* expand to 20–30 cases
* cover Japanese Corporate and Technical decks
* add same-source A/B cases

### P1 — Context Optimization

* eliminate repeated full-context injection
* enforce compact context budgets
* reduce Visual QA and repair overhead

---

## 22. Non-goals

This phase is NOT primarily about:

* adding dozens of new renderer primitives
* implementing hundreds of PPTX.gallery layouts
* exact reproduction of reference decks
* pixel-level similarity scoring
* adding decorative effects
* increasing template count for its own sake
* optimizing token count at the expense of presentation quality

---

## 23. Exit Criteria

This initiative is considered successful when:

1. Default/no-reference decks show a material improvement over the pre-PR5 baseline.
2. The known Japanese typography failures are detectable.
3. Misleading quantitative encodings are detectable or prevented.
4. Real-world Gold Set regression runs are repeatable.
5. Reference grammar can alter presentation language without altering factual content.
6. Quality and token consumption are reported together.
7. Typical 8–12 slide decks fall below the initial 30k-token target.
8. Improvements can be demonstrated as:

```text
quality ↑
hard failures ↓
tokens ↓
```

rather than by unit-test count alone.

---

## 24. Product Definition of Done

`ppt-agent` should no longer be considered successful merely because it can safely generate structurally valid PowerPoint files.

The target product is:

> A presentation compiler and QA runtime that enables an LLM to produce structurally correct, semantically appropriate, professionally designed, editable PowerPoint presentations at a predictable computational cost.

---

## Implementation Status

Traceability from this document to shipped work. Update with each PR in the initiative.

| Section | Requirement | Status | Where |
| --- | --- | --- | --- |
| §9 | First regression fixture preserved | done | `evals/real-world/jp-ai-weekly-update/` |
| §6.1 | `JAPANESE_ORPHAN_PUNCTUATION`, `HEADLINE_BAD_WRAP` | done | `src/typography.ts`, `src/qa.ts` |
| §6.1 | `JAPANESE_AWKWARD_LINE_BREAK` | detector done, not reproduced by fixture | `rubric.yaml` records why |
| §6.2 | `MISLEADING_QUANTITATIVE_ENCODING` (hard), `INCOMPARABLE_METRIC_SCALE` | done | `src/qa.ts` |
| §6.2 | `WEAK_SEMANTIC_VISUALIZATION` | code registered; judgment-layer only | `src/visual-qa.ts` |
| §10 | Quality dimensions and weights, hard-failure override | done | `src/score.ts` |
| §13 §14 | Token telemetry by phase, per-slide, repair overhead | done — boundaries recorded to `run.jsonl`, mtime inference kept only as fallback | `src/tokens.ts` |
| §14 | Quality per 10k tokens | done — `qualityPer10kEffectiveTokens` in every history record | `src/score.ts` |
| §20 | History as quality regression, not pass/fail | done — carries `tokensPerSlide`, `effectiveTokensPerSlide`, and `qualityPer10kEffectiveTokens` together | `record` command |
| §1 | "16:9 / 4:3 canvas support" | **partial.** The default (no-organization) renderer is 16:9 only (`renderer.ts:607`); a plain 4:3 deck is rejected. Organization Template Packs support 16:9 **and** 4:3 as of PR5: `CANVAS_DIMENSIONS` (`organization.ts:14`) is the single source of physical size per ratio, `resolvePresentationStyle` cross-checks `contract.aspectRatio` against the pack's declared `aspectRatio` and hard-fails `ORGANIZATION_TEMPLATE_ASPECT_RATIO_MISMATCH` (`style.ts:301`), and `validateTemplateContract` checks the real `template.pptx` is exactly 10×7.5in for a 4:3 pack (`template.ts:83`). A 4:3 pack needs `template-map.json.aspectRatio: "4:3"` plus that 10×7.5in `template.pptx`. Covered by `tests/unit/style.test.ts`, `tests/unit/organization.test.ts`, `tests/integration/template-adapter.test.ts`. `SKILL.md` states this correctly. | — |
| §16 | Stop re-injecting normalized artifacts | partial — CLI stdout diet only | `src/cli.ts` |
| §3 G1, §6.3, §6.4 | Default design overhaul | **not started** | next PR |
| §3 G2, §4, §18 | Reference grammar manifest and retrieval | **not started** | next PR |
| §8 | 20–30 case Gold Set | **not started** | 1 of 20–30 cases exist |
| §11 | Same-source A/B | **not started** | — |
| §15 | 8–12 slide decks under 30k tokens | **unverified** — needs a real run to measure | — |
