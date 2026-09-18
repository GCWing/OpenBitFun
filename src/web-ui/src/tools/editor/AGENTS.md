# Editor

This directory follows `src/web-ui/AGENTS.md`.

## Markdown editing

- File editing exposes rich text (`ir`) and source (`edit`). Pure preview is
  reserved for explicit viewer consumers, never an automatic compatibility mode.
- Keep ordinary blocks editable when a document contains special syntax.
  Unsupported Markdown regions use source-backed embedded blocks; preserve their
  original Markdown when parsing and serializing. HTML rendering uses the shared
  sanitized Markdown renderer.
- Markdown serialization uses the parser-matched remark extensions. Preserve link titles, code whitespace, and literal syntax; validate emitted inline ranges and use equivalent inline HTML only when Markdown delimiters cannot preserve them. Unsupported block conversions stay local to their source region.
- Source-backed reference blocks share document-level definitions, numbering,
  and anchors. Preview context is transient and must not enter saved Markdown.
- Rich text reuses the existing MarkdownRenderer typography and component styles.
  Preserve the pre-existing preview appearance; do not add an editor-specific
  visual redesign.
- Outside local editing, embeds keep their original rendered appearance. Show
  additional source-editing labels and completion controls only while that embed
  is being edited.
- Embedded changes participate in the document's dirty state, save shortcuts,
  undo/redo, and explicit readonly policy. Changing modes or editability must
  not clear unsaved changes or emit a document edit.
- Keep imported Markdown bytes associated with their rich document state. Undo
  back to that state must restore the exact source; do not hide source-formatting
  edits by weakening the owner's comparison with the last saved bytes.
- File access, conflict dialogs, local image loading, and peer disk synchronization
  continue through existing infrastructure adapters.

## Focused verification

Run from the repository root after Markdown editor changes:

```bash
pnpm --dir src/web-ui run test:run src/tools/editor/components/MarkdownEditor.test.tsx src/tools/editor/meditor/components/MEditor.test.tsx src/tools/editor/meditor/extensions/SoftBreakExtension.test.ts src/tools/editor/meditor/utils/tiptapMarkdown.test.ts src/tools/editor/meditor/utils/tiptapMarkdown.roundtrip.test.ts src/tools/editor/meditor/utils/embeddedSource.test.ts src/tools/editor/meditor/utils/markdownFrontmatter.test.ts src/tools/editor/meditor/utils/loadLocalImages.test.ts src/infrastructure/markdown/rehypeSourceRange.test.ts src/infrastructure/markdown/MarkdownRenderer.test.tsx
```

For UI, types, and theme contracts, also follow the parent guide's `check:web`
command. Local DOM tests do not establish remote workspace, Remote Connect,
Peer Device Mode, or Detached Dispatch behavior.

For rich-text interaction changes, run the focused browser E2E from the root:

```bash
pnpm --dir tests/e2e exec wdio run ./config/wdio.markdown-browser.ts
```

This runs Chrome against the production MarkdownEditor with a test filesystem
adapter backed by a temporary file. It checks local block editing, live rendering,
keyboard completion, undo/redo, rich/source switching, readonly and save/reload.
The runner owns localhost ports 1447/1450, isolates browser state, removes its
temporary file, and writes screenshots to `tests/e2e/reports/markdown-browser`.
It does not test Tauri, relay, SSH, peer transport, or detached dispatch.

For actual desktop integration, build the current desktop and frontend, then run:

```bash
cargo build -p openbitfun-desktop
pnpm run build:web
pnpm --dir tests/e2e exec wdio run ./config/wdio.markdown-native.ts
```

The native spec opens a temporary workspace in OpenBitFun, opens its Markdown file
from the file tree, edits native and embedded blocks, saves via the production
Tauri transport, and closes/reopens the file. Packaged frontend mode prevents
accidentally testing another checkout's Vite server. The focused runner uses a
fresh application profile on every run and removes it on completion. Screenshots
go to `tests/e2e/reports/screenshots`.
This covers a local desktop workspace; remote scenarios still require live hosts.
