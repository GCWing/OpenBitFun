# OpenBitFun Desktop

For development commands, see [AGENTS.md](AGENTS.md) and the repository
[contribution guide](../../../CONTRIBUTING.md).

## Application updates

Choose **Background download** in the new-version dialog to download and verify
an update while continuing to use OpenBitFun. Downloading does not install the
update or restart the application.

When the download finishes, OpenBitFun offers **Install and restart** or
**Later**. Installation restarts OpenBitFun on this device and interrupts its
active sessions. Choosing Later, or closing the dialog, keeps the downloaded
update. Open **About → Install and restart** whenever you are ready; the same
confirmation appears before installation.

Downloaded updates remain available after closing and reopening OpenBitFun.
After reopening, the current updater requires access to the update server to
restore installer metadata, but does not download the package again. If this
step or installation fails, the pending update remains available to retry.
Use **Download again** in the error dialog if the cached package is damaged.

Application updates always belong to the local desktop, including while viewing
a peer device or a remote workspace. They do not install software on the peer or
cancel independently running detached jobs on another host. Connections through
the restarting desktop are interrupted.

## Windows WSL workspaces

In the remote connection dialog, choose **Workspace target → Windows WSL**.
Select an installed Linux distribution, optionally enter a Linux user, then
connect and choose a folder inside that distribution. **Refresh distributions**
reloads the list after you install another distribution. No SSH server or SSH
credentials are needed. WSL must already be installed and the distribution must
have completed its first-run setup on the Windows host.

Files, search, Git, Agent commands, and terminal sessions use the selected Linux
filesystem and processes. Paths use POSIX separators. Saved connections retain
the distribution and optional user for reconnect; omitting the user uses the
distribution's configured default user.

In Peer Device Mode, the selected Windows Desktop host owns WSL discovery and
execution. Older peers and CLI peers explicitly refuse native WSL setup;
non-Windows hosts show an unsupported state. Existing mobile and bot session
controls can continue driving a host session, but do not expose WSL connection
setup. Detached Dispatch does not provision WSL connections. SSH port forwarding
is unavailable for native WSL targets; use Windows WSL networking to reach a
Linux service.

## Remote SSH file handle errors

If writing files and browsing directories both start failing with
`Limit exceeded: handle limit reached`, update OpenBitFun to a build containing
the SFTP handle-lifecycle fix. Earlier builds can exhaust a client-side counter
even when the server has already closed the files. Save ongoing work before
manually disconnecting and reconnecting the remote workspace as a temporary
recovery; reconnecting can interrupt its terminals and commands.

This message alone does not establish a server configuration problem. Raising
server limits only delays a leaked-counter failure. Running `ulimit` in a new
SSH shell does not change the limits of the already-running SFTP subsystem.
OpenBitFun does not modify the remote user's shell startup files, SSH daemon
configuration, or OS limits automatically. If the problem persists after the
fix, capture the OpenBitFun version and logs plus the server's SFTP implementation
and advertised limits so genuine concurrent-handle or server resource exhaustion
can be distinguished from a client lifecycle problem.

## Development startup

Run `pnpm run desktop:dev` from the repository root. The launcher prepares
Flashgrep and the locked Sherpa speech libraries before compiling Desktop.
Sherpa libraries or archives are reused from the current target cache or the
main Git checkout's target cache. If absent, curl downloads the version-specific
archive, supporting HTTP and SOCKS proxies; Cargo handles extraction and linking.
Explicit `SHERPA_ONNX_LIB_DIR` and `SHERPA_ONNX_ARCHIVE_DIR` overrides are preserved.

When another worktree uses the default ports, start a separate dev server:

```sh
OPENBITFUN_DEV_PORT=1432 pnpm run desktop:dev
```

HMR uses port 1431 in this example; `OPENBITFUN_DEV_HMR_PORT` can override it.
The launcher supplies the same HTTP URL to Tauri that Vite listens on, and both
the main window and companion window read that configured URL.


## Windows release signing (maintainers)

`Desktop Package` uses Certum SimplySign on the hosted Windows runner. Configure
these repository Actions secrets before publishing a release:

| Secret | Value |
| --- | --- |
| `CERTUM_USERNAME` | SimplySign login account |
| `CERTUM_OTP_URI` | Full `otpauth://totp/...` provisioning URI, including its original algorithm, digits and period |
| `CERTUM_KEY_ID` | SHA-1 fingerprint of the activated Code Signing certificate |

The OTP URI is provisioning data from the activation QR code, not a current
mobile token, an email activation code or the certificate PIN. Do not paste it
into an issue, PR, log or online QR decoder. Certum's
[activation instructions](https://support.certum.eu/en/how-to-activate-access-to-simply-sign-application/)
describe the activation-link email and separate activation-code email used to
show the QR code. If the original provisioning data is unavailable, contact
Certum/the reseller about regaining access; do not assume the Desktop login can
export it. Replacing the provisioning seed also requires updating the CI secret
and potentially reactivating the mobile app.

The workflow compiles with `--no-bundle`, then opens the SimplySign session.
`--bundle-only` in the Desktop build wrapper runs `tauri bundle` using the same
product and updater configuration, without recompiling. Tauri signs the NSIS
payload and installer before generating updater `.sig` files. Since Tauri
restores the unsigned raw Desktop EXE after bundling, the workflow separately
signs that EXE before the custom installer hashes and embeds it. Finally, it
signs the custom installer. Subsequent release staging copies/renames those
bytes and generates the existing updater/manual-download signatures.

Verification requires Windows Authenticode trust, the configured signer and a
timestamp. Any failure blocks artifact upload. A publication run requires all
three secrets; an artifact-only run with none configured explicitly builds
unsigned packages. Partial configuration always fails. No PFX/private-key export
is required, and the existing Tauri updater key remains unchanged.

Login uses a pinned community action, not an official Certum CI API. Its GUI
login compatibility and any additional certificate PIN prompt must be validated
with the actual account before the first signed release. Diagnostic screenshots
are disabled. A timed-out signing step must be investigated rather than bypassed.
Only trusted release code should receive the secrets. Code signing identifies
the publisher; it does not guarantee that SmartScreen reputation warnings vanish.

Focused checks:

```sh
pnpm run check:github-config
node --test scripts/desktop-tauri-build.test.mjs OpenBitFun-Installer/scripts/build-installer.test.cjs
pwsh -NoProfile -File scripts/ci/sign-windows.test.ps1
```

The PowerShell test uses mocked signing results; a Windows build with the real
certificate is still required to prove cloud signing and timestamp/trust validation.
