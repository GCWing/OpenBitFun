# MiniApp private IPC

This non-published adapter is shared only by Desktop and the lightweight MiniApp
Shell. It owns the existing v1 launch-record format, discovery record, credentials,
bounded JSON framing and local UDS/Named Pipe client. It has no Tauri, Agent,
execution, storage, task, permission, or instance ownership.

Keep wire and persisted records compatible with existing system apps. Preserve
unknown launch-record fields and reject unsupported versions without rewriting
data. Remote workspace, Peer, mobile and detached execution remain explicitly
unsupported by this local presentation adapter. Do not reuse the separate Shared
TUI Runtime IPC protocol or add TCP/browser access.

Focused verification:

```bash
cargo test --locked -p openbitfun-miniapp-ipc
pnpm run check:core-boundaries
```
