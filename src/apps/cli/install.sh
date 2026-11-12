#!/usr/bin/env bash
# OpenBitFun CLI — one-click build + install into PATH.
#
# Usage (from anywhere inside the repo, or this directory):
#   bash src/apps/cli/install.sh
#   bash install.sh                 # when cwd is src/apps/cli
#
# What it does:
#   1. cargo build -p openbitfun-cli --release (native host arch)
#   2. Install openbitfun to ~/.local/bin (override with OPENBITFUN_CLI_BIN_DIR)
#   3. Idempotently append a PATH block to ~/.bashrc and ~/.zshrc
#   4. Print explicit current-shell and new-terminal instructions
#   5. Restart the account daemon's auto-start service when installed, so
#      upgrades take effect (a running daemon keeps the old binary otherwise)
#
# Supported hosts: Linux/macOS on amd64 (x86_64) and arm64 (aarch64).
#
# Environment:
#   OPENBITFUN_CLI_BIN_DIR       Install directory (default: ~/.local/bin)
#   OPENBITFUN_CLI_SKIP_SHELLRC  Set to 1 to skip bashrc/zshrc edits
#   CARGO_TARGET_DIR         Optional cargo target dir (e.g. $HOME/openbitfun-build/target)
#   CARGO_BUILD_JOBS         Optional rustc parallelism limit for small VPS

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Resolve repository root (directory that owns the workspace Cargo.toml) ──
resolve_repo_root() {
  local dir candid
  dir="$SCRIPT_DIR"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/Cargo.toml" ] && [ -d "$dir/src/apps/cli" ]; then
      # Prefer the workspace root that lists members / workspace deps.
      if grep -q '^\[workspace\]' "$dir/Cargo.toml" 2>/dev/null; then
        echo "$dir"
        return 0
      fi
      candid="$dir"
    fi
    dir="$(dirname "$dir")"
  done
  if [ -n "${candid:-}" ]; then
    echo "$candid"
    return 0
  fi
  echo "Error: could not locate OpenBitFun repository root from $SCRIPT_DIR" >&2
  exit 1
}

host_arch_label() {
  local m
  m="$(uname -m 2>/dev/null || echo unknown)"
  case "$m" in
    x86_64 | amd64) echo "amd64" ;;
    aarch64 | arm64) echo "arm64" ;;
    *) echo "$m" ;;
  esac
}

assert_supported_host() {
  local os arch
  os="$(uname -s 2>/dev/null || echo unknown)"
  arch="$(host_arch_label)"
  case "$os" in
    Linux | Darwin) ;;
    *)
      echo "Error: unsupported OS '$os'. install.sh supports Linux and macOS."
      exit 1
      ;;
  esac
  case "$arch" in
    amd64 | arm64) ;;
    *)
      echo "Error: unsupported CPU '$arch' ($(uname -m))."
      echo "install.sh supports amd64 (x86_64) and arm64 (aarch64)."
      exit 1
      ;;
  esac
}

require_cargo() {
  if ! command -v cargo >/dev/null 2>&1; then
    echo "Error: cargo not found. Install Rust from https://rustup.rs and re-run."
    exit 1
  fi
  if ! command -v rustc >/dev/null 2>&1; then
    echo "Error: rustc not found. Install Rust from https://rustup.rs and re-run."
    exit 1
  fi
}

# Marker keeps shellrc edits idempotent across re-installs.
SHELLRC_MARKER_BEGIN="# >>> OpenBitFun CLI PATH (managed by src/apps/cli/install.sh) >>>"
SHELLRC_MARKER_END="# <<< OpenBitFun CLI PATH (managed by src/apps/cli/install.sh) <<<"

ensure_bin_dir_on_path_block() {
  local bin_dir="$1"
  cat <<EOF
${SHELLRC_MARKER_BEGIN}
# Added so \`openbitfun\` is available in new shells after install.sh.
case ":\$PATH:" in
  *":${bin_dir}:"*) ;;
  *) export PATH="${bin_dir}:\$PATH" ;;
esac
${SHELLRC_MARKER_END}
EOF
}

upsert_shellrc_path() {
  local rc_file="$1"
  local bin_dir="$2"
  local tmp block
  mkdir -p "$(dirname "$rc_file")"
  touch "$rc_file"

  block="$(ensure_bin_dir_on_path_block "$bin_dir")"

  if grep -Fq "$SHELLRC_MARKER_BEGIN" "$rc_file" 2>/dev/null; then
    tmp="$(mktemp)"
    # Replace existing managed block.
    awk -v begin="$SHELLRC_MARKER_BEGIN" -v end="$SHELLRC_MARKER_END" '
      $0 == begin { in_block=1; next }
      $0 == end { in_block=0; next }
      !in_block { print }
    ' "$rc_file" >"$tmp"
    printf '\n%s\n' "$block" >>"$tmp"
    mv "$tmp" "$rc_file"
    echo "Updated PATH block in $rc_file"
  else
    printf '\n%s\n' "$block" >>"$rc_file"
    echo "Appended PATH block to $rc_file"
  fi
}

print_path_guidance() {
  local bin_dir="$1"
  echo "Open a new terminal, then run: openbitfun"
  echo "Current shell: export PATH=\"${bin_dir}:\$PATH\" && openbitfun"
  echo "Direct path: ${bin_dir}/openbitfun"
}

assert_entrypoint() {
  local executable="$1"
  "$executable" --version >/dev/null
  "$executable" --help >/dev/null
}

assert_plugin_host_resources() {
  local directory="$1"
  local entry
  for entry in extension-host.js; do
    if [ ! -f "${directory}/${entry}" ]; then
      echo "Error: plugin Host resource is missing: ${directory}/${entry}" >&2
      return 1
    fi
  done
}

install_bundle() (
  local primary_source="$1"
  local plugin_host_source="$2"
  local destination="$3"
  local stage_dir staged_primary staged_plugin_host
  local primary_target plugin_host_target
  local primary_backup plugin_host_backup
  local primary_backed_up=0 plugin_host_backed_up=0
  local primary_committed=0 plugin_host_committed=0
  local failed=0

  mkdir -p "$destination"
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$destination/.openbitfun-cli-install.lock"
    flock -n 9 || { echo "Error: another CLI installation or update is running." >&2; return 1; }
  elif command -v shlock >/dev/null 2>&1; then
    shlock -p "$$" -f "$destination/.openbitfun-cli-install.lock" || { echo "Error: another CLI installation is running." >&2; return 1; }
    trap 'rm -f "$destination/.openbitfun-cli-install.lock"' EXIT
  else
    echo "Error: a native installation lock (flock or shlock) is required." >&2
    return 1
  fi
  stage_dir="$(mktemp -d "${destination}/.openbitfun-install.XXXXXX")"
  staged_primary="${stage_dir}/openbitfun"
  staged_plugin_host="${stage_dir}/ext-host"
  primary_target="${destination}/openbitfun"
  plugin_host_target="${destination}/resources/ext-host"
  primary_backup="${stage_dir}/previous-openbitfun"
  plugin_host_backup="${stage_dir}/previous-ext-host"

  install -m 755 "$primary_source" "$staged_primary" || failed=1
  if [ "$failed" -eq 0 ]; then
    mkdir -p "$staged_plugin_host"
    cp "$plugin_host_source/extension-host.js" "$staged_plugin_host/" || failed=1
  fi
  if [ "$failed" -eq 0 ]; then
    assert_entrypoint "$staged_primary" || failed=1
  fi
  if [ "$failed" -eq 0 ]; then
    assert_plugin_host_resources "$staged_plugin_host" || failed=1
  fi
  if [ "$failed" -eq 0 ] && { [ -e "$primary_target" ] || [ -L "$primary_target" ]; }; then
    if mv "$primary_target" "$primary_backup"; then primary_backed_up=1; else failed=1; fi
  fi
  if [ "$failed" -eq 0 ] && [ -d "$plugin_host_target" ]; then
    if mv "$plugin_host_target" "$plugin_host_backup"; then plugin_host_backed_up=1; else failed=1; fi
  fi
  if [ "$failed" -eq 0 ]; then
    if mv "$staged_primary" "$primary_target"; then primary_committed=1; else failed=1; fi
  fi
  if [ "$failed" -eq 0 ]; then
    mkdir -p "$(dirname "$plugin_host_target")"
    if mv "$staged_plugin_host" "$plugin_host_target"; then plugin_host_committed=1; else failed=1; fi
  fi
  if [ "$failed" -eq 0 ]; then
    assert_entrypoint "$primary_target" || failed=1
  fi
  if [ "$failed" -eq 0 ]; then
    assert_plugin_host_resources "$plugin_host_target" || failed=1
  fi

  if [ "$failed" -ne 0 ]; then
    local recovery_failed=0
    if [ "$plugin_host_committed" -eq 1 ]; then rm -rf "$plugin_host_target" || recovery_failed=1; fi
    if [ "$primary_committed" -eq 1 ]; then rm -f "$primary_target" || recovery_failed=1; fi
    if [ "$primary_backed_up" -eq 1 ]; then mv "$primary_backup" "$primary_target" || recovery_failed=1; fi
    if [ "$plugin_host_backed_up" -eq 1 ]; then
      mkdir -p "$(dirname "$plugin_host_target")"
      mv "$plugin_host_backup" "$plugin_host_target" || recovery_failed=1
    fi
    if [ "$recovery_failed" -ne 0 ]; then
      echo "Error: CLI rollback failed; recovery copies retained at $stage_dir" >&2
      return 1
    fi
    rm -rf "$stage_dir"
    echo "Error: CLI installation failed; the previous OpenBitFun CLI was restored." >&2
    return 1
  fi

  rm -rf "$stage_dir"
)

# A running daemon keeps executing the previous binary (old inode) until it is
# restarted; `systemctl enable --now` does NOT restart an already-active
# service either. Restart the installed auto-start service so upgrades take
# effect. Best-effort: skips cleanly when nothing is installed.
restart_daemon_for_upgrade() {
  local os unit_name agent_label config_home plist uid
  os="$(uname -s)"
  unit_name="openbitfun-cli-daemon.service"
  agent_label="com.openbitfun.cli.daemon"

  case "$os" in
    Linux)
      config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
      if [ -f "$config_home/systemd/user/$unit_name" ]; then
        if command -v systemctl >/dev/null 2>&1 && systemctl --user try-restart "$unit_name" 2>/dev/null; then
          echo "Restarted $unit_name to pick up the new binary."
        else
          echo "Note: daemon service installed but could not be restarted from this shell."
          echo "Run: systemctl --user restart $unit_name"
        fi
        return 0
      fi
      ;;
    Darwin)
      plist="$HOME/Library/LaunchAgents/${agent_label}.plist"
      if [ -f "$plist" ]; then
        uid="$(id -u)"
        if launchctl kickstart -k "gui/${uid}/${agent_label}" 2>/dev/null; then
          echo "Restarted LaunchAgent ${agent_label} to pick up the new binary."
        else
          echo "Note: daemon LaunchAgent installed but could not be restarted."
          echo "Run: launchctl kickstart -k gui/${uid}/${agent_label}"
        fi
        return 0
      fi
      ;;
  esac

  # No auto-start service installed — warn only when a manually supervised
  # daemon is still running the old binary.
  if "${BIN_DIR}/openbitfun" daemon status 2>/dev/null | grep -q "daemon process: running"; then
    echo "Note: a running daemon was detected (not service-managed); restart it"
    echo "so it picks up the new binary."
  fi
}

usage() {
  cat <<'EOF'
OpenBitFun CLI install script

Usage:
  bash install.sh [--help]

Builds and installs the openbitfun command.

Options:
  -h, --help    Show this help

Environment:
  OPENBITFUN_CLI_BIN_DIR       Install directory (default: ~/.local/bin)
  OPENBITFUN_CLI_SKIP_SHELLRC  Set to 1 to skip ~/.bashrc and ~/.zshrc edits
  CARGO_TARGET_DIR         Cargo target directory override
  CARGO_BUILD_JOBS         Limit rustc parallelism (useful on small VPS)
EOF
}

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $arg"
      usage
      exit 1
      ;;
  esac
done

REPO_ROOT="$(resolve_repo_root)"
BIN_DIR="${OPENBITFUN_CLI_BIN_DIR:-${HOME}/.local/bin}"
HOST_ARCH="$(host_arch_label)"
HOST_OS="$(uname -s)"

echo "=== OpenBitFun CLI Install ==="
echo "Repo:   $REPO_ROOT"
echo "Host:   ${HOST_OS} / ${HOST_ARCH} ($(uname -m))"
echo "Install dir: $BIN_DIR"

assert_supported_host
require_cargo

mkdir -p "$BIN_DIR"

echo ""
echo "[1/4] Building openbitfun (release)..."
cd "$REPO_ROOT"
# Build from workspace root so path deps resolve.
cargo build -p openbitfun-cli --release --bin openbitfun

TARGET_DIR="${CARGO_TARGET_DIR:-${REPO_ROOT}/target}"
if [ -n "${CARGO_BUILD_TARGET:-}" ]; then
  RELEASE_DIR="${TARGET_DIR}/${CARGO_BUILD_TARGET}/release"
else
  RELEASE_DIR="${TARGET_DIR}/release"
fi
BUILT_BIN="${RELEASE_DIR}/openbitfun"
PLUGIN_HOST_DIST="${REPO_ROOT}/src/apps/extension-host/dist"
if [ ! -x "$BUILT_BIN" ]; then
  echo "Error: built binary not found at $BUILT_BIN"
  exit 1
fi
assert_plugin_host_resources "$PLUGIN_HOST_DIST"

echo ""
echo "[2/4] Installing binaries..."
install_bundle "$BUILT_BIN" "$PLUGIN_HOST_DIST" "$BIN_DIR"
echo "Installed: ${BIN_DIR}/openbitfun"
assert_entrypoint "${BIN_DIR}/openbitfun"
assert_plugin_host_resources "${BIN_DIR}/resources/ext-host"

echo ""
echo "[3/4] Configuring shell PATH..."
if [ "${OPENBITFUN_CLI_SKIP_SHELLRC:-0}" = "1" ]; then
  echo "Skipped shell rc edits (OPENBITFUN_CLI_SKIP_SHELLRC=1)."
else
  upsert_shellrc_path "${HOME}/.bashrc" "$BIN_DIR"
  upsert_shellrc_path "${HOME}/.zshrc" "$BIN_DIR"
fi

echo ""
echo "[4/4] Restarting account daemon (if installed)..."
restart_daemon_for_upgrade

echo ""
echo "=== Install complete ==="
print_path_guidance "$BIN_DIR"
echo "Login (Peer Host): open /login inside the TUI after start."
echo "Server use: after /login, run \`openbitfun daemon install\` to keep this"
echo "device reachable by your account even after exit or reboot."
