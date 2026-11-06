# office-documents

Cargo package: `openbitfun-office-documents`. Owns the portable OOXML engine
behind the `GenOfficeFile` tool: Word (`.docx`), Excel (`.xlsx`), and
PowerPoint (`.pptx`) document models, atomic edit operations, structure reads
with paging, and package writers. The models follow GenOffice's agent-facing
shapes (Markdown/blocks for Word, the workbook cell DSL for Excel, the
1280×720 px page spec for decks).

## Boundaries

- Pure in-memory bytes: no file, network, or process IO. The tool in
  `assembly/core` resolves paths, loads referenced images through the
  session's workspace file system (local or remote), and writes the result.
- Depends only on serialization, zip, Markdown parsing, and hashing crates.
  Do not add Core, services, or runtime dependencies.

## Contracts

- Every package carries its editable model in `openbitfun/genoffice.json`
  (package relationship type
  `http://schemas.openbitfun.com/genoffice/2026/relationships/source`), with a
  fingerprint of the rendered parts. Reopening refuses packages without the
  part (`not_generated`) and packages another program changed
  (`externally_modified`) unless the caller opts to discard those changes.
- The stored model is read by older and newer versions: model structs keep
  unknown fields (`extra`) and round-trip them; new fields need defaults. The
  envelope `version` gates incompatible changes. Operation input, in contrast,
  reports unknown fields so a typo is not silently ignored.
- A batch is atomic: operations run on a clone, and an error names the failing
  operation index.
- Embedded pictures are content-addressed assets kept in the media parts and
  reused on later rebuilds without the original file.

## Verification

```bash
cargo test -p openbitfun-office-documents
```

`OFFICE_DOCUMENTS_SAMPLE_DIR=/some/dir cargo test -p openbitfun-office-documents --test end_to_end`
also writes the generated samples there for manual inspection in Office.
