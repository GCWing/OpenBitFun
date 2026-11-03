#!/usr/bin/env python3
"""Rewrite OpenBitFun ExecCommand payloads with RTK."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def find_rtk() -> str | None:
    configured = os.environ.get("RTK_BIN")
    if configured:
        return configured

    # Prefer the common user-local installation explicitly. Remote SSH
    # commands frequently do not source .bashrc, so PATH may be incomplete.
    for name in ("rtk", "rtk.exe"):
        candidate = Path.home() / ".local" / "bin" / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)

    return shutil.which("rtk") or shutil.which("rtk.exe")


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError) as error:
        print(f"RTK hook received invalid JSON: {error}", file=sys.stderr)
        return 0

    if not isinstance(payload, dict):
        return 0

    if payload.get("tool_name") != "ExecCommand":
        return 0

    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict) or not isinstance(tool_input.get("cmd"), str):
        return 0

    rtk = find_rtk()
    if not rtk:
        print("RTK hook: rtk was not found; leaving the command unchanged", file=sys.stderr)
        return 0

    try:
        result = subprocess.run(
            [rtk, "rewrite", "--", tool_input["cmd"]],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError as error:
        print(f"RTK hook could not start rtk: {error}", file=sys.stderr)
        return 0

    if result.returncode == 1:
        return 0
    if result.returncode == 2:
        reason = result.stderr.strip() or "RTK denied this command."
        print(reason, file=sys.stderr)
        return 2
    if result.returncode not in (0, 3):
        return 0

    rewritten = result.stdout.strip()
    if not rewritten:
        return 0

    updated_input = dict(tool_input)
    updated_input["cmd"] = rewritten
    hook_output = {
        "hookEventName": "PreToolUse",
        "updatedInput": updated_input,
    }
    if result.returncode == 0:
        hook_output["permissionDecision"] = "allow"
        hook_output["permissionDecisionReason"] = "RTK auto-rewrite"
    print(
        json.dumps(
            {"hookSpecificOutput": hook_output},
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
