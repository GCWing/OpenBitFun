# Offline migration engine

Own bounded source discovery, durable tasks, snapshot/staging/backup/journal IO,
atomic commit and safe cancellation. Never initialize the main product runtime.
`reset` owns explicitly confirmed destination deletion for starting migration
again. Preview and revalidate the scope, preserve source/protected directories,
and report partial failures. The host excludes concurrent operations and writers.
Historical handoff and onboarding files remain readable compatibility formats;
new standalone tasks use save_task/load_task and do not depend on request expiry.
Do not delete or reset corrupt plans, reports or user data. Validate UUIDs and
plan identities before using task paths. Keep source/destination isolation.

`directory` owns ordinary tree traversal and OS-backed file copying for staging.
Workspace trees have no product-specific depth/count/size admission limits.
Adapters own conversion, conflicts and manifest verification; the engine retains
phase progress and cancellation boundaries. Links remain explicit errors.

Process inspection must fail explicitly when inventory is unavailable. Never
interpret an inspection error as an empty writer list. On macOS, inspect executable
names with the system `ps`, preserving full bundle paths and excluding arguments.

Focused verification:

```bash
cargo test -p openbitfun-legacy-migration --lib
cargo test -p openbitfun-legacy-migration --test migration_engine_contracts
```

For process inventory, writer classification, and handoff changes, use
`cargo test -p openbitfun-legacy-migration --lib handoff::tests`.
The macOS inventory test exercises the real host process list and must run on
macOS; parser and classification fixtures run on all test platforms. These local
checks do not establish remote-workspace, remote-control, peer, or dispatch behavior.
