# Ecosystem compatibility brand assets

These product marks are cached locally so external import and subscription-provider cards do not depend on runtime network access. External import, subscription sign-in, and account management share the [product icon catalog](../../../src/shared/ui/productBrandIcons.ts) and [ProductBrandIcon](../../../src/shared/ui/ProductBrandIcon.tsx). Add product icons there instead of defining a page-local mapping or renderer. The shared component uses standalone icon variants without application tiles or wordmarks, with alpha masks for monochrome symbols, full-color Antigravity artwork, and OpenCode's official light/dark variants.

| File | Upstream source |
| --- | --- |
| `claude-code.svg` | Claude official site: https://claude.ai/favicon.svg |
| `pi.svg` | Pi official site: https://pi.dev/favicon.svg |
| `deepseek-harness.svg` | DeepSeek Harness official repository: https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/website/public/favicon.svg |
| `cursor.svg` | Cursor official brand assets: https://cursor.com/brand — `General Logos/Cube/SVG/CUBE_2D_LIGHT.svg`, retrieved 2026-09-15 |
| `antigravity.png` | Google Antigravity [Press Assets](https://www.antigravity.google/press), **Icon - Full Color**: https://www.antigravity.google/assets/image/brand/antigravity-icon__full-color.png, retrieved 2026-10-29 |
| `codex-icon.svg` | OpenAI Developers: https://developers.openai.com/ — standalone OpenAI symbol from the page header, original SVG and viewBox, retrieved 2026-10-29 |
| `zcode-icon.svg` | ZCode official site: https://zcode.z.ai/ — standalone Z symbol from the page header, original SVG and viewBox, retrieved 2026-10-29 |
| `grok-icon.svg` | Grok official site: https://grok.com/ — both header SVG paths identified as `mark`, with their original geometry in an icon-sized viewBox, retrieved 2026-10-29 |
| `opencode-icon-light.png` | OpenCode [Brand guidelines](https://opencode.ai/brand), original standalone mark: https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/console/app/src/asset/brand/opencode-logo-light.png, retrieved 2026-10-29 |
| `opencode-icon-dark.png` | OpenCode [Brand guidelines](https://opencode.ai/brand), original standalone mark: https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/console/app/src/asset/brand/opencode-logo-dark.png, retrieved 2026-10-29 |
| `hermes.png` | Hermes Agent official repository, original foreground artwork without the app background: https://raw.githubusercontent.com/NousResearch/hermes-agent/main/apps/desktop/assets/icon.icon/Assets/art-light.png, retrieved 2026-10-29 |

Prefer original assets from official brand/media packages. The [Grok brand page](https://x.ai/legal/brand-guidelines) links to https://data.x.ai/logos/SpaceXAI_Grok_Assets.zip, which returned HTTP 403 on 2026-10-29. Where a standalone downloadable file was unavailable, the subscription icon preserves the official website's SVG symbol paths, rather than redrawing a mark or removing the background from a raster app icon. These extracted symbols are not represented as files from a downloadable brand package.

Entries without an individual date were retrieved on 2026-08-21. Product names and marks belong to their respective owners; inclusion identifies a compatibility target and does not imply endorsement.
