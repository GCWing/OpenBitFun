---
name: generate-image
description: Generate photos, illustrations, posters, and project assets through OpenBitFun's configured default image model. Shape prompts, inspect results, and make targeted refinements using generate_image. Not for image analysis, prompt-only discussions, or edits that must preserve an existing image.
---

# Generate Image

## Define the asset

Infer purpose, subject, framing, quantity, required text, and destination from context. Ask only for information that blocks success. Preserve detailed requests; enrich brief ones with useful composition, lighting, and material cues without inventing brands, slogans, characters, or story elements.

Prefer native formats for existing SVGs, icon systems, and editable charts. Deliver actual raster images when the user asks for photos or illustrations.

## Shape the prompt

For complex requests, use the following structure, keeping only useful fields. Choose the prompt language for the task; preserve required in-image text verbatim, including its original language and punctuation.

```text
Purpose: placement, audience, and intended effect
Content: subject, action, setting, and essential details
Style: photo/illustration/3D, materials, lighting, and palette
Composition: viewpoint, framing, crop-safe margins, and necessary negative space
Text: exact copy, hierarchy, placement, and number of occurrences
Constraints: required invariants and important exclusions
```

| Asset | Prompt emphasis |
| --- | --- |
| Photography and products | Describe texture, reflections, perspective, contact shadows, and product structure instead of stacking vague quality adjectives. |
| Web assets and covers | Match the actual container and crop; place negative space around existing copy. Keep headings and buttons in page code when appropriate. |
| Posters and infographics | Supply exact copy, verified data, relationships, hierarchy, and reading order. Do not let the model invent facts. |
| Illustrations and sets | Repeat concrete medium, palette, lighting, and subject descriptions. Give each image one clear purpose. |

Use `view_image` or `analyze_image` to describe visual references when available. The generation tool accepts no reference images, masks, or editing inputs; do not promise preserved identity, exact product details, or unchanged pixels.

## Generate and inspect

- Generate only with `generate_image`. Omit `service_id` by default to use the configured default image model. Do not mix in external `imagegen`, `image_gen`, genmedia, or direct API calls.
- Use `n: 1` unless another quantity was requested. Call separately for distinct content; `n` is for variants of one prompt. Track actual returned counts without silently adding candidates.
- Use `size` and `negative_prompt` only when supported by the service. Put style and layout in `prompt`; do not invent tool arguments.
- When inspection is available, check subject and count, structure and cropping, verbatim text, and consistency across sets. Verify actual dimensions, format, and alpha when required; a white or checkerboard background is not transparency. Disclose unverified requirements.
- Refine one specific defect at a time, retaining the original goal, valid constraints, and previous versions for comparison. Regeneration is not a local edit. Stop when the goal is met and stay within the user's quantity and budget.
- Report configuration, authentication, quota, or transport failures without automatically switching services or retrying without cause. For configuration issues, point to Settings → Models → Image generation model.

## Deliver

Show or deliver images using returned file paths. Place project assets in the agreed asset directory, update references within the task's scope, and check their actual display. Keep previous versions unless replacement was requested. Operate on remote files through their workspace, not as controller-local files.

Report delivered quantity, locations, and known limitations, including unmet text, size, transparency, or consistency requirements.
