# Subagent avatars

These twenty authored SVGs are the OpenBitFun joystick family, refined for
small avatars on 2026-09-19. They preserve the existing characters, body and
knob palettes, and expressions; light eyes share one warm ivory color. Do not
apply hue rotation or a generic icon stroke to them.

The SVGs are the runtime assets and editable vector sources. Their square
viewBoxes center the complete artwork at 87.5% of the longest side, equivalent
to a 112px drawing inside a 128px canvas. Bodies use compact round, pillow,
bean, square, and bell silhouettes; the joystick knobs remain round, with
short connected stems and separate oval eyes. There are no embedded bitmaps,
backgrounds, gradients, textures, filters, or white outline treatments.

`palette.json` owns the four fixed colors of each character: stem, body, knob,
and face. These identify characters across light and dark themes; semantic,
component, and status tokens would change their identity with the UI state.
The surrounding component continues to use theme tokens for lifecycle dots.
The frontend color registry delegates only these twenty named SVGs to
`node scripts/check-subagent-avatar-assets.mjs`, which checks their palettes,
vector-only content, inventory, and runtime imports. Generic theme budgets
remain unchanged; new assets and neighboring UI sources are not exempted.

The twenty SVG files total 13,781 bytes (13.5 KiB), replacing 125,440 bytes
(122.5 KiB) of WebP files. The brand exploration output
`2026-09-19-round-14-svg-family-20` keeps the previous WebPs, original SVG
masters, 128px transparent lossless WebP exports, and rendering receipts.

Legacy `robot-XX` IDs and the `subagent-identity-v1` seed in
`subagent-identity/catalog.ts` remain unchanged. Expanding the catalog from
fifteen to twenty characters can change an existing session's selected avatar;
the mapping is deterministic across all shared Web UI consumers for this catalog.
No avatar identity is persisted; lifecycle markers stay in the avatar component
rather than being drawn into these assets.

| Runtime ID | Character |
| --- | --- |
| robot-01 | Cream |
| robot-02 | Lake Blue |
| robot-03 | Lilac |
| robot-04 | Ink Mint |
| robot-05 | Peach |
| robot-06 | Pea |
| robot-07 | Tangerine |
| robot-08 | Berry |
| robot-09 | Sea Salt |
| robot-10 | Matcha |
| robot-11 | Lemon |
| robot-12 | Grape |
| robot-13 | Coral |
| robot-14 | Glacier |
| robot-15 | Cocoa |
| robot-16 | Cloud |
| robot-17 | Pistachio |
| robot-18 | Sakura |
| robot-19 | Indigo |
| robot-20 | Oat |
