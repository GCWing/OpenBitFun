# Zcode Adapter

This adapter reads Zcode's local `~/.zcode/cli/db/db.sqlite` session store.
It owns source schema, visibility, ordering and tool-result translation only.
Keep native import, workspace registration and continuation in their existing
product owners. Do not launch Zcode, execute imported tools, load credentials,
change SQLite schema or write to the source database. Use read-only SQLite
transactions so committed WAL records and message parts form one snapshot.

Only top-level task sessions are listed. Inherited hidden context, system
reminders and nested/side tasks are not additional human conversation turns.
Missing stores are empty; unreadable or unsupported stores must report errors.
Unknown optional columns are tolerated; required-column loss is unsupported.

```bash
cargo test -p openbitfun-zcode-adapter --lib session::tests
```

Optional local read-only verification (prints counts, never conversation text):

```bash
cargo test -p openbitfun-zcode-adapter --lib inspect_installed_zcode -- --ignored --nocapture
```
