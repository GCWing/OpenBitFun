# Recovery utilities

Keep distributable recovery scripts standalone and standard-library-only.
Default to read-only planning; require explicit apply/rollback flags for data
mutations. Never test repairs against a developer's real session data.

For session-storage repair changes, use the focused fixture suite:

```shell
python scripts/recovery/repair-session-storage.test.py
```

Run from the repository root. Fixtures use the configured system temporary
directory; set `TEMP`/`TMP` externally when needed. Broad Rust, UI, and repository
suites are not required for this utility unless their contracts also change.
