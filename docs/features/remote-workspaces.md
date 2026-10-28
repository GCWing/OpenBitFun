# Remote SSH, container, and WSL workspaces

Flashgrep accelerated search is currently unavailable for remote workspaces.
Index controls are hidden; content-search operations that depend on Flashgrep
return an explicit unsupported error. Remote file-name search remains available.
OpenBitFun never falls back to searching the controller filesystem for a remote path.

OpenBitFun remote workspaces use one saved target for the file explorer, terminal,
Agent commands, and workspace tools. The target can be:

- an SSH host;
- an SSH host reached through one or more jump hosts;
- a Docker container on an SSH host;
- a Docker container on the local machine; or
- an sshd endpoint running inside a container; or
- a WSL Linux distribution on the Windows OpenBitFun host.

The local client behavior is supported on macOS, Windows, and Linux. Remote
workspace paths are always interpreted with POSIX `/` separators, independent
of the client OS. Docker workspace commands require a POSIX-compatible
container shell; selecting a Windows container does not silently reinterpret
paths or commands with Windows semantics.

## Windows WSL

Choose **This computer → WSL** in the work-location and environment controls. OpenBitFun discovers installed
distributions on the executing Windows host and connects through `wsl.exe`.
See [Desktop WSL setup](../../src/apps/desktop/README.md#windows-wsl-workspaces)
for prerequisites, user selection, and remote-surface support.

## Jump hosts

`ProxyJump` accepts a comma-separated chain such as `jump1,jump2` or
`ops@jump.example.com:2222`. SSH config aliases are resolved from
`~/.ssh/config`. Each alias may provide its own `HostName`, `Port`, `User`, and
`IdentityFile`, so hop credentials do not need to match the final target.

OpenBitFun opens each hop in order and carries the next SSH handshake over a
`direct-tcpip` channel. Connection errors identify the failed jump number or
the final target, and distinguish reachability from SSH authentication.

Each SSH-configured jump may use its own identity, OpenSSH certificate, or
ssh-agent identity. Explicit password and keyboard-interactive challenge
responses are also supported, with configurable connection/authentication
timeouts, whole-chain retries, and challenge-round limits.

## Docker targets

For **Remote host → Container → Through the Docker host**, OpenBitFun first establishes the SSH connection (and
optional jump chain), then wraps workspace operations with:

```text
docker exec -i [--user USER] CONTAINER SHELL -lc COMMAND
```

For **This computer → Container**, the same command runs through that host's
Docker CLI without opening SSH. The Docker executable, container user, and
container shell are configurable under **Advanced settings**.

For **Remote host → Container → SSH directly to the container**, the host, port, user, and authentication fields
must point directly to the container's sshd endpoint. Optional jump hosts use
the same SSH path described above. No Docker container ID is required; existing
saved container metadata is retained when a profile is edited.

`Auto` probes the container's published `22/tcp` endpoint and completes an SSH
handshake. If sshd is unavailable or rejects authentication, OpenBitFun falls back
to `docker exec`. The connection dialog shows the resolved access mode and can
test jumps, the target, and the container before connecting. It can also list
containers from local Docker or from the configured SSH Docker host.

## Filesystem semantics

When a Docker target is selected:

- terminal sessions start in the container;
- Agent and task commands execute in the container;
- reads, writes, directory listings, rename, create, and delete operations
  address the container filesystem;
- the workspace path is a path inside the container, not a host path.

A host bind mount is visible only through the path at which it is mounted in
the container. OpenBitFun does not silently translate host paths to container
paths. File transfer uses binary stdin/stdout streams. Uploads write to a
same-directory temporary file and rename atomically after success; cancellation
leaves the previous destination intact. Ordinary SSH workspaces continue to use
SFTP.

Text command output is decoded as one UTF-8 byte stream, so a multibyte
character split across SSH or Docker chunks is preserved. File bytes are never
decoded. Workspace metadata and paths must be valid UTF-8; names that cannot be
represented safely on the local filesystem (for example Windows reserved
names, traversal components, or case-colliding names on common Windows/macOS
filesystems) fail with an explicit error instead of being skipped or
overwritten. Recursive transfers reject symbolic links instead of following
them outside the selected tree.

Non-TTY Docker commands run under an in-container supervisor. Interrupt and
timeout handling signal the command's process group inside the container before
closing the local or SSH-hosted Docker CLI process. A read-only container
temporary directory does not make an existing Docker workspace unusable;
execution continues with transport-level cancellation as the compatibility
fallback.

The configured Docker CLI remains the security boundary. OpenBitFun does not expose
the Docker daemon over the network or bypass the current user's Docker
permissions.

### SFTP handle ownership

Whole-file SFTP transfers wait for CLOSE acknowledgement before reporting
success, including reads. The file guard retains cleanup ownership after cancellation,
I/O errors, or a dropped streaming reader; it also receives and closes late OPEN
replies after the caller stops waiting. Writes are not replayed if their outcome
is uncertain. A failed close or timed-out OPEN retires the affected SFTP subsystem
so its unknown handles and client accounting cannot poison later operations.

Full and bounded directory enumeration use the same serialized raw SFTP path,
which closes directory handles on errors as well as success. Cancellation retires
that directory subsystem, and subsequent enumeration replaces it without
invalidating the SSH transport or the separate file subsystem. No persisted
profile, workspace, or wire shape changes are required.

The locked russh-sftp 2.3 dependency sends CLOSE on ordinary file drop without
reducing its client-side handle count. Relying on that drop alone can therefore
produce `Limit exceeded: handle limit reached` even after the server has closed
every file. See [Desktop troubleshooting](../../src/apps/desktop/README.md#remote-ssh-file-handle-errors)
for recovery guidance.

## Search on hosts without ripgrep

Agent Grep keeps one matching and result-processing implementation. For
case-sensitive literals and literal alternatives such as `foo|bar`, an available
compatible `rg` can preselect candidate files to reduce SSH transfer. Without
`rg`, OpenBitFun can automatically use a compatible system `grep` in batches for the
same purpose. Both are checked for required behavior before use. The shared
scanner applies the query, file types, context, counting and pagination.
Complex regular expressions, case folding or unavailable target accelerators
use file streams through the existing workspace connection. Installing OpenBitFun
on the target is not required. Stream scanning can transfer more data and take
longer on a slow connection; results report the backend and scanned bytes.

System grep is not a transparent replacement: its default regular expression
syntax, supported options and filename framing differ. OpenBitFun does not silently
substitute a weaker expression and return a misleading empty result. Search
failures retain their diagnostics. Remote Glob uses the shared matcher on
POSIX paths, preserving filename boundaries and applying the pattern before
the result limit.

The built-in Grep tool accepts structured search arguments. This differs from
`ExecCommand`, where the model supplies a shell command executed in the Session's
target environment. A missing shell program is reported as such; OpenBitFun does
not silently rewrite that command or install software.

## Session forks and file previews

Forking a remote session copies the selected conversation history and keeps the
source session's SSH connection and POSIX workspace path. It does not create a
Git worktree or copy remote files. The original and forked sessions continue to
use the same remote working tree. Fork storage is selected by the verified
remote binding, even when another host has a workspace with the same path.

Read, Write, Edit, Delete and LS share their tool logic across local and remote
workspaces. Only filesystem IO changes provider. Agent Runtime, credentials,
permissions, Session history and snapshot metadata stay on the OpenBitFun host;
SSH workspaces do not start a remote OpenBitFun CLI or shared daemon.

New remote file modifications can record snapshots in the host's local mirror,
isolated by the complete connection identity. A successfully recorded operation
can display its persisted summary and diff even after disconnecting. An older
operation, failed snapshot, or unsupported symbolic-link target does not claim
that history exists; tool cards retain their inline preview instead.
Forked conversation history retains inline tool results but does not inherit
the source Session's snapshot preview capability.

These operation records do not prove complete historical coverage. Full file
rollback and edit-and-rerun remain unavailable for remote Sessions until the
Session's coverage can be verified. Existing history is retained, and no
baseline is fabricated from current remote files. A snapshot bookkeeping
failure never causes a file tool to execute twice.

## Git ownership trust

Git refuses a repository whose directory is owned by another user until the
path is listed in the protected `safe.directory` configuration — a common shape
for shared SSH hosts, bind-mounted trees, and containers that run as a
different uid. OpenBitFun classifies that refusal as its own state instead of
reporting "not a repository", so Git-backed surfaces can explain the wall and
the Review launch fails with a specific reason.

The decision itself belongs to the machine that owns the repository. For a
remote workspace OpenBitFun reports the state and hands over the exact command
(`git config --global --add safe.directory "<path>"`) to run on the remote
host; it never writes the remote user's global Git configuration, and it never
grants trust implicitly as a fallback of a failed read. The same rule applies
in Peer Device Mode: the read-only probe answers for a controller, granting is
refused on the peer host.

## Output files through remote control

Output links and images belong to the session that produced them. Remote Connect
resolves relative paths, `computer://`, and `file:` references against that
session's execution root, including its worktree. SSH workspace files are read
through the workspace filesystem provider. Runtime artifact references remain
scoped to the executing host and session, even when the SSH workspace is offline.
An unavailable session or provider returns an error; it never borrows the
controller's current workspace or a same-named local file.

Mobile web displays supported output images in the message and offers retry or
download when a preview cannot load. Native mobile surfaces expose output file
cards with image preview and download. Multi-chunk reads reject incomplete or
inconsistent transfers, and switching devices invalidates pending reads. Desktop
image caches are isolated by the active device surface.

Feishu, Telegram, and WeChat bots deliver files from the originating session
after its reply. Images use the provider's supported native image representation;
other outputs are sent as files. Duplicate image/link references are delivered
once, and Markdown code examples are not treated as delivery requests. Missing
files and upload failures produce an explicit reply.

Account-device bot submissions retain the original device, session, and account
identity for result polling, interactions, and attachment reads. Attachments use
bounded chunks so encrypted relay payloads stay within the transport limit.
New hosts include an optional file revision; supported readers reject a changed
revision, while legacy replies without this field remain readable. A temporary
connection failure replays the same turn query instead of resubmitting the prompt.
Questions and tool approvals return to that captured target even after menu
selection changes. Account replacement retires the observer's authority.

Detached Dispatch negotiates the optional `query_file_chunks_v1` capability for
binary images and downloads, alongside `query_file_content` for text previews.
Chunk reads carry an offset and file revision; the controller rejects inconsistent
transfers and drops responses after a device-surface switch. Older targets retain
working execution and text-query paths and receive an explicit upgrade instruction
for a missing binary capability. Existing Remote Connect file commands and
persisted session records remain compatible; the file-chunk revision is additive.

## User Skill resources

User Skill availability is controlled by the runtime host's
`workspace.remote_user_skills` preference: `skill_md_only` (the upgrade-compatible
default), `disabled`, or `full`. It applies to remote discovery, prompt listings
and explicit invocation, without changing remote project Skills. See the
[Desktop guide](../../src/apps/desktop/README.md#user-skills-in-remote-workspaces)
for prerequisites and behavior.

Full loading deploys the selected directory through the bound filesystem and
shell providers, never through a local fallback. Deterministic file hashes and
permissions identify package versions. Target verification checks the complete
tree before reuse; otherwise one streamed archive is validated in a staging
directory before publication. Returned Skill paths use target POSIX semantics,
and references rooted in the original package are mapped to that deployment.
The runtime reads instructions back from the deployed snapshot before reporting
success. This copies package resources; it does not install interpreters,
relocate executable hooks, or resolve external machine-specific dependencies.

## Upgrade compatibility

Existing SSH profiles remain plain SSH targets because the new `proxyJump` and
`container` fields are optional and connection policy fields have defaults.
Existing remote-workspace records keep their paths and connection metadata.
Legacy connection IDs that included the SSH port are migrated together with
their password-vault and workspace references.

Legacy local-Docker profiles do not need an SSH password-vault entry, even if
their old serialized auth placeholder is an empty password.

If a saved password is unavailable after an upgrade or local keychain reset,
OpenBitFun keeps the connection and workspace records and asks for the password on
the next manual reconnect. A startup timeout or temporary network failure marks
the workspace as unavailable but does not delete its restore metadata.

Private-key passphrases, keyboard-interactive responses, and one-time codes are
never persisted. Saved interactive profiles therefore remain visible after an
upgrade but require manual credential entry before reconnecting.

For the ownership and transport contracts behind these behaviors, see
[`remote-workspace-transport.md`](../architecture/remote-workspace-transport.md).
