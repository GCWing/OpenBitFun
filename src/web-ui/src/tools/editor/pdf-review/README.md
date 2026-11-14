# PDF review

`PdfReviewSession` owns review history and serializes writes for one
`EditorDocument` and source path. Save All includes pending comment drafts and
writes only sessions with unsaved changes, so a session left behind by an
abandoned main-file path never blocks it. Review JSON is versioned, preserves
additive fields, and is written through the document's workspace-scoped adapter
with an expected content hash. Invalid or unsupported records stay intact. A lost
write response is reconciled against the last attempted content before retrying.
Any other host change enters a conflict: writes pause until the user explicitly
replaces that exact host version with local notes or loads the host file (Undo
restores the replaced local notes).

Coordinates are PDF user-space points. `PdfReviewLayer` converts them through the
current page viewport, so zoom and rotation do not change stored coordinates.
The review keeps the fingerprint of the build its notes were placed on. Edits and
PDF saves never update it; a recompile warning stays until the user confirms the
current layout. Page coordinates are not a text-reanchoring or SyncTeX implementation.

`pdf-lib` (MIT) writes standard Highlight, Text/reply, and Ink annotations. It also
embeds the review for reopening. Only our tagged annotations are replaced during
export; other annotations and form fields remain. Saved appearances are removed
before overlay editing, so deleting a reopened annotation also removes it visually.
`pdf-lib` can neither decrypt existing strings nor encrypt the objects it adds, so
encrypted PDFs are reviewed through the sidecar only and annotated copies are
disabled. PDFs that `pdf-lib` cannot parse are treated the same way.
Workspace PDF saves use the existing bounded upload port and compare-and-swap
hashes. Download/export belongs to the viewing controller. Neither path falls
back to a controller-side workspace file.

Focused checks from the repository root:

```bash
pnpm --dir src/web-ui run test:run src/tools/editor/pdf-review src/tools/editor/components/LatexEditor.test.tsx src/tools/editor/components/PdfViewer.test.tsx src/tools/editor/utils/latexDocument.test.ts src/infrastructure/file-export/savePdfFile.test.ts
```

These are local DOM, PDF-format, and simulated transport tests. They do not prove
live SSH, Docker, Peer Device Mode, Remote Connect, or Detached Dispatch behavior.
