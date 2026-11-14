[English] | [简体中文](远程与多设备) · [Home](Home)

# Remote and multi-device

## Choose the right remote scenario

| Scenario | What moves | Execution and data ownership |
| --- | --- | --- |
| Remote workspace | Workspace IO and commands target SSH/container/WSL | Agent Runtime and session metadata stay on the OpenBitFun host; files and workspace commands use the target |
| Remote control | Mobile or Bot sends requests to a host | The connected host owns execution and sessions |
| Peer Device Mode | A local shell uses another device's product commands/events | The selected Desktop/CLI owns work and records |
| Detached Dispatch | A durable job is submitted to another host | The target owns its runtime, job session, managed worktree, and records |

These are not interchangeable “remote modes.” A remote workspace does not automatically install or start OpenBitFun on the target. See [Peer Device Mode](Peer-Device-Mode) and [Detached Dispatch](Detached-Dispatch) for their prerequisites.

## Mobile and Bot control

1. Open Remote Connect on the host.
2. Choose LAN or the configured official Relay path; inspect connection state and network information.
3. Sign in with the same GitHub identity on the host and mobile controller, then follow the QR invitation flow. The QR contains the endpoint/device identity, not anonymous access authorization.
4. Verify the selected host/workspace, then send a request or inspect an existing session.
5. Answer supported permission requests from the driving surface and reconnect to recover history.

The current UI does not offer separate ngrok or custom-server tabs. Same-network mode starts a Relay on the host; both LAN and official Relay modes use GitHub identity verification and need internet for sign-in. The official endpoint is fixed: self-hosting requires a matching client build, not an editable server URL or deployment wizard. Use the [Relay guide](https://github.com/GCWing/OpenBitFun/blob/v1.0.0/src/apps/relay-server/README.md).

Feishu, Telegram, and WeChat/iLink have dedicated Bot configuration. Supported session controls differ by surface and connector. Mobile web supports adaptive layouts; do not infer universal desktop feature parity or a standalone mobile execution runtime.

## Remote workspaces

Supported targets include SSH, jump-host chains, Docker on SSH, local Docker, container sshd, and Windows WSL on the executing Windows host. Configure the connection, test it, select the actual target workspace path, and verify the terminal and files belong to that environment.

Remote paths use POSIX separators. Container paths are inside the container; host bind mounts are visible only at their mounted path. Docker commands require a compatible POSIX shell.

Agent Grep/Glob and remote file-name search remain available through supported providers. Flashgrep-accelerated remote content search/index controls are unavailable; the application must not silently search local files instead. Remote file rollback also has coverage restrictions; see [coding workspace](Coding-Workspace).

If Git reports unsafe ownership, inspect the exact target and grant safe.directory trust yourself on the repository-owning machine; OpenBitFun does not silently grant remote trust.

## Disconnect and security

A controller disconnect is not a guarantee of cancellation. The executing host must remain running; a job waiting on permissions still needs an answer. Paired payload encryption does not hide all routing metadata or protect compromised endpoints. See [security](Security-and-Privacy).

[Detailed workspace guide](https://github.com/GCWing/OpenBitFun/blob/v1.0.0/docs/features/remote-workspaces.md)

> Screenshot pending: S18 — Remote Connect and QR; S19 — mobile layouts; S20 — target connection; S21 — Bot configuration.
