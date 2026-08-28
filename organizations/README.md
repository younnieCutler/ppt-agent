# Organization template packs

An organization pack is intentionally data-only and is consumed by the shared
renderer:

```text
organizations/<organization-id>/
├── template.pptx
├── brand.yaml
└── template-map.json
```

`template.pptx` must be a 16:9 native PowerPoint template. `brand.yaml` accepts
either the legacy seven-token palette (`background`, `surface`, `text`,
`primary`, `accent`, `muted`, `border`) or the full 19-token semantic palette;
whichever is present wins outright over the archetype's own tokens — a legacy
brand only has its 8 remaining semantic tokens (`surfaceAlt`, `textSecondary`,
`divider`, `gridline`, `mutedFill`, `highlightedRegion`, plus the archetype's
own `inverseText`/`accentSecondary`) derived for it. It may also declare an
optional `data: [6 hex colors]` for its own chart series palette — without it,
chart series 1-2 use the brand's `primary`/`accent` and series 3-6 fall back to
the archetype's data colors. `brand.yaml` may also declare `paletteLocked`,
`lockedPalette`, and `locks.fonts`.

`template-map.json` maps semantic layouts (`title`, `statement`, `comparison`,
`process`, `pipeline`, `architecture`, `quantitative`, `timeline`, `evidence`,
`chart`) to native layout names or 1-based layout indexes, and declares which
chrome regions are owned by the template versus the renderer. Each layout
binding's `contentRegion` is not just validated metadata — the renderer scales
and translates every shape it draws for that layout into this exact rectangle,
so declaring a smaller or offset region actually relocates content. To
reproduce the renderer's own default geometry exactly (an identity mapping),
declare `{ "x": 0.72, "y": 0.48, "w": 11.85, "h": 6.14 }` — this is the
headline-plus-body area the shared layouts are authored against, not just the
body region below the headline.

The pack owns identity and locked chrome. Archetypes and design directions are
resolved independently and continue to use the shared semantic layout
contracts; there is no organization-specific renderer fork.
