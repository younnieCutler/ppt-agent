# vNext Generative Authoring

The authoring layer is intentionally host-neutral. Claude Code, Codex, or another capable model may design a slide, but the runtime never trusts free-form presentation code or raw OOXML authored by the model.

## Authority boundary

```text
SlideSpec / grounded content
        +
Brand Constraint Profile
        +
Template Semantics
        +
Reference component summaries
        ↓
Generative Authoring Request
        ↓
LLM / agent host
        ↓
Generative Scene v2 + content bindings
        ↓
Strict response validation
        ↓
existing Generative Scene runtime
```

- The model owns composition inside normalized `0..1` content-canvas coordinates.
- Master/layout chrome remains immutable.
- Fonts and colors remain template-only.
- Completed source-slide geometry is reference-only. It cannot become output geometry merely because it resembles the requested slide.
- Reference metadata exposes semantic roles, component-kind counts and repeat-pattern observations. It does not expose raw shape ids, OOXML ids, source bounds or example text.
- Every model-authored text node must bind to exactly one planned content atom and preserve that atom's text exactly.
- Every planned content atom must be delivered exactly once. Invented text, dropped content, stale request provenance and weakened template constraints hard-fail.

## Unsupported primitives

Generative Scene v2 currently has no native chart or media node. A generative chart slide or an image-bearing title/evidence slide therefore fails explicitly instead of being silently approximated. Add native primitives before enabling those cases.

## Provider integration

Provider SDK calls do not belong in this module. The request/response contract is the stable integration boundary. A host may serialize the request into its own model call and submit the returned JSON to `parseGenerativeAuthoringResponse`.

This keeps the deterministic runtime independent from model vendor, prompt transport, transcript layout and authentication mechanism.
