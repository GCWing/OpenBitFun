# Third-Party Notices

OpenBitFun redistributes selected material and links libraries from the following
third-party projects. These notices are included with OpenBitFun's Desktop and CLI
release packages.

## HarmonyOS Sans Fonts

- Project: HarmonyOS Sans Fonts
- Provider: Huawei Device Co., Ltd.
- License: HarmonyOS Sans Fonts License Agreement
- Copyright: Copyright 2021 Huawei Device Co., Ltd.

Non-Apple OpenBitFun GUI distributions bundle unmodified copies of the Base and
Simplified Chinese Regular, Medium, and Bold fonts. They do not bundle the
Traditional Chinese font family. Apple GUI distributions and Traditional
Chinese UI text use platform system fonts instead.

The complete license agreement and a font-specific notice are included only in
the non-Apple frontend artifact under `third-party/fonts/harmonyos-sans/`.

## models.dev catalog data

- Project: models.dev
- Source: https://github.com/anomalyco/models.dev
- Catalog API: https://models.dev/api.json
- License: MIT
- Copyright: Copyright (c) 2025 models.dev

OpenBitFun includes a curated, reasoning-only fallback derived from the models.dev
catalog. It is used when a newer cached catalog is unavailable. The precise
source revision, retrieval metadata, transformation, and content hashes are
recorded in `models-dev.provenance.json`, which is shipped as
`third-party/models.dev/provenance.json` in binary release packages. The
complete upstream license text is preserved in `models-dev.LICENSE.txt`, which
is shipped as `third-party/models.dev/LICENSE.txt`. Source distributions keep
the canonical copies of both files beside the bundled snapshot under
`src/crates/services/services-integrations/assets/`.

## anydoc

- Project: anydoc
- Source: https://github.com/firecrawl/anydoc
- Version: 0.1.6
- License: MIT
- Copyright: Copyright (c) 2026 Sideguide Technologies Inc.

OpenBitFun links anydoc to convert supported office documents, OpenDocument files,
RTF, EPUB, CSV, and PDFs into Markdown for the Agent Read tool.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## loopx

- Project: loopx
- Source: https://github.com/huangruiteng/loopx
- License: Apache-2.0
- Copyright: Copyright 2026 LoopX contributors

BitFun bundles a compiled, self-contained build of the loopx CLI as a desktop
sidecar resource (`resources/loopx/`). It powers the built-in bitfun-loopx
MiniApp's issue-fixing loop and is built at packaging time by
`scripts/build-loopx.mjs` from the pinned upstream release recorded in
`resources/loopx/manifest.json` (version, commit, content hash, and build
toolchain). The upstream Apache-2.0 license, NOTICE, historical MIT license, and
trademark policy ship alongside the binary as `resources/loopx/LICENSE`,
`resources/loopx/NOTICE`, `resources/loopx/LICENSE-MIT`, and
`resources/loopx/TRADEMARKS.md` in binary release packages. When the bundled
sidecar is unavailable, the local Desktop may download the pinned source tag
into BitFun-managed storage; that checkout retains the same upstream compliance
files. The `loopx` name is used descriptively to refer to the upstream project;
bitfun-loopx is a third-party integration and is not a LoopX project release.
