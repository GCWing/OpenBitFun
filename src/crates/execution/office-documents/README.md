# Office document engine

Portable, in-memory Word, Excel, and PowerPoint generation for the
`GenOfficeFile` Agent tool. See [AGENTS.md](AGENTS.md) for ownership, stored
model compatibility, and focused verification.

## GenOffice attribution and licensing

This implementation was developed with reference to
[GenOffice](https://github.com/genspark-ai/genoffice), copyright 2026
Mainfunc, Inc., licensed under Apache License 2.0. The reference revision
recorded for this attribution is
[`f8c17004fb730df11f0f743164ffd8b4281bb38c`](https://github.com/genspark-ai/genoffice/tree/f8c17004fb730df11f0f743164ffd8b4281bb38c).
It identifies the source reviewed for attribution, not a claim that all
OpenBitFun code was ported from that revision.

The agent-facing designs used as references include:

- Word Markdown/block operations:
  [`packages/cli/src/formats/docx.ts`](https://github.com/genspark-ai/genoffice/blob/f8c17004fb730df11f0f743164ffd8b4281bb38c/packages/cli/src/formats/docx.ts).
- Excel cell DSL, styles, and workbook operations:
  [`packages/cli/src/formats/xlsx-dsl.ts`](https://github.com/genspark-ai/genoffice/blob/f8c17004fb730df11f0f743164ffd8b4281bb38c/packages/cli/src/formats/xlsx-dsl.ts).
- PowerPoint 1280×720 page specs and positioned elements:
  [`packages/pipelines/src/slides/page-spec.ts`](https://github.com/genspark-ai/genoffice/blob/f8c17004fb730df11f0f743164ffd8b4281bb38c/packages/pipelines/src/slides/page-spec.ts).

OpenBitFun implements these capabilities in Rust with its own in-memory
models and OOXML package writers, atomic edit batches, embedded editable
source and integrity checks, paged reads, and workspace filesystem adapter.
The tool accepts a supported subset; it does not claim full GenOffice format
or operation compatibility.

The complete upstream [license](LICENSE-GENOFFICE.txt) and
[NOTICE](NOTICE-GENOFFICE.txt) are preserved here. GenOffice-derived material
remains subject to Apache-2.0; OpenBitFun-authored additions use the repository's
MIT license. This attribution does not relicense the rest of OpenBitFun.
The upstream NOTICE describes components in GenOffice's own distribution;
those references do not mean OpenBitFun bundles those components.

The applicable GenOffice attribution and complete Apache-2.0 license are also
included in the repository-level [third-party notices](../../../../THIRD_PARTY_NOTICES.md),
which existing Desktop and CLI packaging distributes with the binaries.
