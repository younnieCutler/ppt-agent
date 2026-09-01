# Goal 12 dependency map

This map is the cleanup boundary for the legacy Organization Pack removal. It is
based on the current call sites, not on filename similarity.

## Raw PPTX path to preserve

```text
contract.template { kind: "pptx", path }
  -> resolveTemplateSourceSpec
  -> template-analyze
       -> extractTemplateElements
       -> compileTemplateGrammar
       -> compileTemplateDesignSystem
       -> compileTemplateComponents
       -> compileTemplatePatterns
  -> pattern-resolve
  -> render-pattern-skeleton
       -> renderAdaptiveRuntime
            -> diagnoseAdaptiveMode
            -> planAdaptiveSlide
            -> adaptiveOperationsForPlan
            -> transformTemplateComponents
            -> applyPatternSkeleton
  -> qa / ooxmlQa / visual
```

Keep these modules and their shared contracts: `schema.ts`, `template-analysis.ts`,
`template-grammar.ts` behavior, `template-design-system.ts`,
`template-components.ts`, `template-patterns.ts`, `template-transform.ts`,
`adaptive-*.ts`, `template.ts` source-slide skeleton assembly,
`ooxml.ts`, `qa.ts`, `visual.ts`, and `CANVAS_DIMENSIONS`/semantic layout
vocabulary used by the renderer and template extraction.

## Legacy Organization Pack path

```text
contract.organization { kind: "directory", path }
  -> resolvePresentationStyle
       -> loadOrganizationPack
            -> brand.yaml
            -> template-map.json
            -> optional cached template-elements/grammar
       -> applyLegacyBrand
  -> renderer.renderDeck
       -> contextFor(map.layouts[*].contentRegion)
       -> applyOrganizationTemplate
            -> useSlideLayout(nativeLayout)
```

Additional legacy-only edges are:

- `theme` CLI -> `resolveTheme` -> `brand.yaml`.
- `pattern-label --map` and `qa` override recovery -> `templateMapSchema` and
  `template-map.json`.
- `contract.brand { kind: "file" }`, `brandFileSchema`, legacy palette/theme
  migration, and `themes/default/brand.yaml`.
- Organization Pack fixtures/tests: `organization-pack-fidelity-gate`,
  `template-adapter`, organization branches in `style`, `schema`, `renderer`,
  and `template` tests.

## Cleanup rule

Remove only the legacy-only nodes and their tests/docs after the raw path is
still green. If a symbol is imported by the raw path, retain it or move only
the shared definition without changing its contract. In particular, do not
remove coordinate canonicalization, template component transforms, adaptive
selection, source-slide pattern assembly, or raw-PPTX QA while removing the
pack loader.
