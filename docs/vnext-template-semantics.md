# vNext Template Semantics

The vNext authoring runtime separates three kinds of authority that may coexist inside one PPTX.

## Structural authority

PowerPoint master/layout geometry and placeholder-driven source slides may constrain output structure. These are the only source slides eligible for `exact_clone`.

## Brand/style authority

Fonts, colors, reusable surfaces, dividers, text treatments, logos, footer chrome, and other template-native components remain valid reference material across the whole raw PPTX.

## Reference-only example slides

A completed source slide whose content geometry is not placeholder-driven is a design example, not an output skeleton. Its components/styles may be sampled, but its card count, column count, metric arrangement, and exact coordinates do not constrain a new Generative Scene.

This distinction is deliberate for example-heavy corporate decks: a file can contain many polished reference slides while still exposing a large model-authored content canvas.

## Runtime policy

```text
master/layout chrome        -> immutable / structural
placeholder-driven skeleton -> exact_clone eligible
source example geometry     -> reference_only
source component/style      -> reference_library
new content composition     -> model-authored Scene
```

A source pattern that would otherwise qualify as an exact clone is ignored when its source slide is classified `reference_only`; that output slide must use a validated `generative_scene` instead. There is no generic-renderer or adaptive-compose fallback in the vNext deck runtime.
