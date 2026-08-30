# Adaptive Template Runtime Contract

Status: architecture contract, Goal 0

This document fixes the boundary for the Adaptive Template Runtime. It does not change runtime
behavior. The existing strict source-slide clone path remains the compatibility baseline until an
adaptive path is verified end to end.

## Governing principle

> The template controls visual language; content controls composition.

The raw `.pptx` is the only style source. Its masters, layouts, themes, source-slide bodies,
typography, geometry, surfaces, dividers, colors, and assets are authoritative. `brand.yaml`,
`template-map.json`, an Organization Pack, or a host-authored palette cannot invent or override
visual language for an Adaptive raw-template run.

## Runtime modes

| Mode | Contract | Allowed source | Failure behavior |
| --- | --- | --- | --- |
| `exact_clone` | Reuse an existing `TemplatePattern` source slide, sanitize its example content, and fill its semantic slots. | The raw template's source slide and its analyzed artifacts. | Fail when no compatible pattern exists on a strict `source_slide_pattern` template. |
| `adaptive_compose` | Reuse template-native components and deterministically move, resize, duplicate, remove, or reflow them into a content-first composition. | The raw template's extracted design DNA, component catalog, and cloned component styles/assets. | Fail explicitly when the required component or structured layout capability is unsupported. |
| `generic_redraw` | Draw a slide from renderer-authored generic geometry, palette, typography, or surfaces. | None for a raw-template run. | Prohibited; it must never be a silent fallback for either adaptive or exact-clone selection. |

`exact_clone` and `adaptive_compose` are separate modes and coexist during migration. The
existing clone path is not deleted or replaced until the adaptive path has a passing raw-PPTX E2E
test. A plain deck with no raw template may continue to use the existing deterministic renderer;
that compatibility path is not evidence that generic redraw is valid for a raw-template run.

## Ownership boundary

The host or LLM may provide semantic intent: the slide function, content priority, desired
grouping, emphasis, and a preferred component family. It may not provide or infer implementation
geometry.

The runtime owns, validates, and records:

- content frame, margins, rows, columns, gaps, placement, resize, and text allocation;
- raw PowerPoint shape names/IDs, source-slide parts, OOXML relationships, and package edits;
- component capability checks and exact-clone versus adaptive-compose selection;
- style and asset provenance back to the raw PPTX;
- overflow, content-drop, example-leak, relationship-corruption, and unsupported-capability
  failures.

Coordinates (`x/y/w/h`), font sizes, colors, shape IDs, and OOXML details are runtime-internal.
They must not be required in a host-authored DeckSpec or semantic adaptive plan. The existing
`TemplateElement`/`TemplatePattern` artifacts may retain internal bounds and shape names because
the low-level renderer needs them; that does not make them host input.

## Unsupported layouts

Adaptive composition is capability-gated. If the catalog cannot provide the required
template-native component family, transformation, media capability, or structured-layout
representation, the runtime returns an explicit hard failure (`TEMPLATE_COMPOSITION_UNSUPPORTED`
or the more specific adaptive capability code introduced by the later QA contract). It must not
approximate a graph, chart, timeline, media frame, or other structured payload with unrelated
generic shapes, and it must not drop content to make a pattern fit.

## Current implementation connection

The current raw-template flow is:

```text
contract.template: { kind: "pptx", path }
        │
        ▼
resolveTemplateSourceSpec                 src/template-source.ts
        │
        ├─ template-analyze                 src/cli.ts
        │    ├─ extractTemplateElements     src/template-analysis.ts
        │    │    └─ template-elements.json
        │    ├─ compileTemplateGrammar      src/template-analysis.ts
        │    │    └─ template-grammar.json
        │    └─ compileTemplatePatterns     src/template-patterns.ts
        │         └─ template-patterns.json
        │
        ├─ plan-validate                    src/cli.ts → src/planning.ts
        │    └─ deck-plan.json + planning-qa.json
        │
        ├─ reference (optional) → style     src/reference.ts / src/style.ts
        │    └─ style-context.json
        │
        ├─ composition-resolve              src/cli.ts → src/planning.ts
        │    └─ composition-plan.json
        │
        ├─ pattern-resolve                  src/cli.ts → src/template-patterns.ts
        │    └─ pattern-plan.json
        │
        └─ DeckSpec → render/QA             src/schema.ts / src/renderer.ts / src/qa.ts
             └─ render-pattern-skeleton    src/cli.ts → src/template.ts
                  └─ exact source-slide clone + sanitization + slot fill
```

The existing `DeckSpec` and composition resolver remain compatible with this contract. Goal 0
does not add an adaptive artifact or alter their behavior. Later goals add the following bounded
connections beside the current path:

1. `TemplateGrammar` becomes the first design-DNA input; a versioned design-system artifact
   preserves observed typography, geometry, surface, branding, and spacing vocabulary rather than
   inventing defaults.
2. `template-patterns.json` is complemented by a component catalog that records reusable
   template-native components and their internal provenance.
3. A low-level transformation engine applies only supported component operations while preserving
   cloned styles, assets, and relationships.
4. A render-independent `AdaptiveSlidePlan` converts semantic intent and content into deterministic
   component placement. The selection policy tries `exact_clone` when coverage/capacity matches;
   otherwise it checks `adaptive_compose`; if neither is capable, it hard-fails.
5. Adaptive QA checks provenance, style source, content preservation, canvas bounds, and example
   leakage independently of the pixel-identical clone check. The existing clone fidelity gates
   remain for `exact_clone`.

## Migration invariant

For every raw-template slide, the final mode must be recorded as `exact_clone` or
`adaptive_compose`. `generic_redraw` is never an implicit third choice. Until the adaptive
vertical slice passes raw-PPTX E2E verification, the current strict source-slide clone path and
its hard failures remain in place and are the default evidence for template fidelity.
