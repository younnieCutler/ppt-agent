# Organization template packs

An organization pack is intentionally data-only and is consumed by the shared
renderer:

```text
organizations/<organization-id>/
├── template.pptx
├── brand.yaml
└── template-map.json
```

`template.pptx` must be a 16:9 native PowerPoint template. `brand.yaml` uses
the legacy seven-token brand format for migration compatibility and may declare
`paletteLocked`, `lockedPalette`, and `locks.fonts`. `template-map.json` maps
semantic layouts (`title`, `statement`, `comparison`, `process`, `pipeline`,
`architecture`, `quantitative`, `timeline`, `evidence`, `chart`) to native
layout names or 1-based layout indexes, and declares which chrome regions are
owned by the template versus the renderer.

The pack owns identity and locked chrome. Archetypes and design directions are
resolved independently and continue to use the shared semantic layout
contracts; there is no organization-specific renderer fork.
