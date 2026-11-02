# Cursor Session Adapter

Read Cursor's local history without launching Cursor, reading credentials,
executing imported tools, or modifying source stores. Native discovery, caching,
continuation and persistence remain in their existing product owners.

The CLI reader uses the committed SQLite snapshot, its current root's JSON
message references and summary archives. Never scan arbitrary blobs as messages:
they include superseded branches and non-conversation data. Desktop messages use
the stored conversation header order, with legacy inline history supported.
Current Desktop stores workspace identity in the separate `composerHeaders`
table. Read it in the same snapshot as the composer, and keep older databases
without that table readable. Never resolve an explicit remote URI through a
local workspace fallback.
JSONL transcripts are a fallback; surface their missing tool results explicitly.
Never reconstruct a workspace path from Cursor's lossy directory slug.

Use the existing bounded filesystem helpers and read-only SQLite transactions.
Unknown required structures, missing referenced blobs and unreadable stores must
produce clear errors. Keep source IDs, tool names, arguments and results intact;
native card parameter projection belongs in the Web UI.

```bash
cargo test -p openbitfun-cursor-adapter --lib session::tests
```

Optional installed-source verification (counts only):
`cargo test -p openbitfun-cursor-adapter --lib inspect_installed_cursor -- --ignored --nocapture`.
Set `OPENBITFUN_TEST_CURSOR_SESSION_ID` to the real two-turn validation fixture:
three Read calls (one missing file), one Write, and final `CURSOR_IMPORT_OK` /
`CURSOR_RESUME_OK` markers. Ordinary user sessions are not this assertion fixture.
Use Cursor's `CURSOR_CONFIG_DIR` and `CURSOR_DATA_DIR` for an isolated CLI home.
`OPENBITFUN_CURSOR_USER_DATA_DIR` selects a custom desktop user-data root for
OpenBitFun discovery; it does not configure Cursor itself.
