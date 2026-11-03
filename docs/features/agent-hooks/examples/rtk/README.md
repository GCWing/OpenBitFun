# RTK command rewrite example

This example connects [RTK](https://github.com/rtk-ai/rtk) to OpenBitFun's
`PreToolUse` hook for `ExecCommand`. RTK can rewrite a command before it is
sent to the terminal and can reject a command with exit code 2.

The files in this directory are templates. They are deliberately not stored
under a live `.openbitfun/` directory, so cloning this repository does not
activate a hook in the development checkout.

## Windows local workspace

1. Install `rtk` and make sure it is visible to the OpenBitFun process.
2. Copy `rtk-hook.ps1` to `%USERPROFILE%\.openbitfun\hooks\rtk-hook.ps1`.
3. Merge `hooks.windows.user.json` into
   `%APPDATA%\openbitfun\config\hooks.json` (merge the `hooks` entries if the
   file already contains other hooks).
4. Keep `app.hooks.enabled` enabled.

The Windows template invokes PowerShell with `-NoProfile`. The script first
honors `RTK_BIN`, then searches `rtk.exe` and
`rtk` on `PATH`.

## POSIX remote workspace

Copy both project files into the target repository:

```text
<workspace>/.openbitfun/config/hooks.json
<workspace>/.openbitfun/hooks/rtk-hook.py
```

Use `hooks.posix.project.json` as the contents of the project `hooks.json`, or
merge its `PreToolUse` entry into an existing file. Enable
`app.hooks.project_hooks_enabled` in OpenBitFun.

The command runs on the workspace host:

```text
python3 .openbitfun/hooks/rtk-hook.py
```

The script looks for `~/.local/bin/rtk` before falling back to `PATH`. This is
intentional: SSH non-interactive shells often do not source `.bashrc`, so an
export in `.bashrc` alone is not sufficient. RTK must be installed on the
workspace host, not only on the controller.

Remote workspaces use the project layer only. User hooks and imported hook
snapshots stay on the controller and are skipped for remote dispatch.

## Manual check

From the target workspace, pipe a representative payload to the script:

```bash
printf '%s\n' '{"tool_name":"ExecCommand","tool_input":{"cmd":"git status"}}' \
  | python3 .openbitfun/hooks/rtk-hook.py
```

The script emits a JSON `hookSpecificOutput.updatedInput` document when RTK
rewrites the command. An RTK exit code of 1 means "leave the command alone";
exit code 2 blocks the tool call and writes the reason to stderr. Exit code 3
rewrites without adding an `allow` decision.

Project hooks execute repository code with the target user account. Enable
them only for repositories you trust.
