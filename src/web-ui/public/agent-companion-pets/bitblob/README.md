# BitBlob

A smooth, rounded lavender companion with dark oval eyes and a soft ball antenna, inspired by the user-provided visual reference. The artwork uses a clear 3D toy style, with no pixel-art conversion.

## Asset contract

- `pet.json`: id `bitblob`, display name `BitBlob`, `spriteVersionNumber: 2`.
- `spritesheet.webp`: transparent, lossless WebP; 1536 × 2288 pixels; 8 columns × 11 rows; 192 × 208 pixels per cell.
- Rows 0–8: idle (6), running-right (8), running-left (8), waving (4), jumping (5), failed (8), waiting (6), running (6), review (6). The v2 neutral/default pose occupies row 0, column 6; all other unused cells are transparent.
- Row 9: 000, 022.5, 045, 067.5, 090, 112.5, 135, 157.5 degrees.
- Row 10: 180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5 degrees.
- Directions are clockwise in screen coordinates: 000 up, 090 right, 180 down, 270 left. Neutral remains the idle frame.

## Generation and prompt summary

Created with the built-in image generation tool and the `hatch-pet` v2 workflow on 2026-09-21. The canonical prompt specifies a compact lavender blob, dark purple inset oval eyes, a short soft antenna with purple ball, optional small attached hands, smooth soft shading, no mouth or props, no text, shadows or detached effects. The supplied sheet serves only as a visual reference.

Each state was generated as its own grounded strip: quiet breathing/blinking; rightward squash/stretch gliding; connected-hand wave; squash/rise/peak/fall/landing; disappointed antenna droop; expectant hands-together asking pose; focused stationary task processing; calm thoughtful review. Leftward gliding is the sole derived visual row, produced by an approved framewise mirror of the symmetric rightward sequence without reversing timing. The four-cardinal anchors and each eight-pose look row were generated separately. Look directions keep the lower base planted and the face nearly frontal. Both inset oval eyes remain near the middle of the face, with restrained directional offsets and gentle antenna follow-through.

Deterministic extraction, registration, composition and edge cleanup use the skill's scripts. Jumping uses the supported shared-viewport extraction to preserve the generated vertical arc; other standard rows use connected-component extraction.

## Consistent state transitions

The packaged atlas re-registers the existing artwork across all states, including
the neutral slot and look directions. Each cell is uniformly scaled against a
15,000-pixel alpha-weighted silhouette area, retaining 15% of its original
within-row area variation for breathing and squash. This avoids using the full
antenna height or a raised hand as a proxy for body size. The lower-body center
is aligned to x=95.5 and the baseline to y=194 in each 192×208 cell. Jump frames
use offsets of 0, 4, 16, 6, 0 pixels from that baseline.

This corrects the former half-sized jump, oversized working/waiting frames and
per-frame size drift during review. The standard action poses, frame order, v2 layout
and transparency remain intact. BitBlob plays only the atlas animation in the
shared renderer; additional CSS breathing, hover squash and work/drag transforms
are disabled for this built-in pet so they do not compound its authored motion.

## Gentle gaze

The 16 look directions were regenerated as two coherent eight-pose strips on
2026-09-22, grounded in the existing neutral pose and a new set of restrained
cardinal anchors. Both eyes remain visible on the central front face; lateral
looks no longer push them toward the silhouette or turn the body into a profile.
The downward-to-left-to-upward eye line rises gradually through the second row.

Only rows 9–10 are replaced. Decoded pixels in rows 0–8, including the neutral
slot, are identical to the preceding size-normalized atlas. The new look cells
use the same silhouette-area normalization and baseline; their alpha-weighted
areas vary by less than 2% across the 16 directions.

## Verification

The packaged v2 atlas passes geometry, populated/unused cell, transparency and
chroma checks. Registration also checks final-cell edges and verifies that all
standard rows are pixel-identical. Direction continuity measurements and an
independent visual review cover all 16 poses. Three isolated reviewers classify
the randomized horizontal/vertical direction pairs. Very small intermediate
vertical cues are intentionally subtle; cardinal directions remain readable.

This is a static artwork replacement with no renderer, persisted data or
transport changes. Remote workspace, remote control, Peer Device Mode and
Detached Dispatch were not exercised for this asset-only change.
