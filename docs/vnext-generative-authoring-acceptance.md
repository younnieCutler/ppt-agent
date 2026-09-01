# Generative Authoring Acceptance

A host-authored response is accepted only when all of the following are true:

1. Request/template provenance matches exactly.
2. The response contains exactly the non-exact target slides and no others.
3. Slide id, semantic intent and headline remain identical to the planned slide.
4. Corporate constraints remain `immutable` / `template_only`.
5. Every text node binds to one planned content atom.
6. Every planned content atom is delivered exactly once.
7. Bound text is unchanged after whitespace normalization.
8. Structural nodes do not masquerade as grounded text.
9. No chart/media approximation is allowed until the Scene IR supports those primitives natively.
10. Only the existing Generative Scene runtime may convert the accepted Scene to physical PPTX geometry.

The model is allowed to choose normalized positions, sizes, grouping and emphasis. Example-slide geometry is never an acceptance criterion.
