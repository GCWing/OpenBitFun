#!/usr/bin/env bash
# Exercise the production clipboard provider in disposable X11 and Wayland seats.
set -euo pipefail

for tool in cargo xvfb-run xclip xsel sway wl-copy wl-paste; do
  command -v "$tool" >/dev/null || { echo "Missing clipboard fixture dependency: $tool" >&2; exit 1; }
done

clipboard_fixture_dir="$(mktemp -d)"
clipboard_sway_pid=""
cleanup() {
  if [ -n "$clipboard_sway_pid" ]; then
    kill "$clipboard_sway_pid" 2>/dev/null || true
    wait "$clipboard_sway_pid" 2>/dev/null || true
  fi
  rm -rf "$clipboard_fixture_dir"
}
trap cleanup EXIT

clipboard_test=(cargo test --locked -p openbitfun-services-core --no-default-features
  --features process-runtime --lib system::local_actions::clipboard::tests::native_clipboard_roundtrip
  -- --ignored --exact --nocapture)

env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 xvfb-run -a "${clipboard_test[@]}"

mkdir "$clipboard_fixture_dir/runtime"
chmod 700 "$clipboard_fixture_dir/runtime"
cat > "$clipboard_fixture_dir/sway.conf" <<'EOF'
output * resolution 1280x720
seat seat0 fallback true
EOF
env -u DISPLAY -u WAYLAND_DISPLAY \
  XDG_RUNTIME_DIR="$clipboard_fixture_dir/runtime" WLR_BACKENDS=headless \
  WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman \
  sway --config "$clipboard_fixture_dir/sway.conf" > "$clipboard_fixture_dir/sway.log" 2>&1 &
clipboard_sway_pid=$!

clipboard_wayland_socket=""
for ((attempt=0; attempt<100; attempt++)); do
  if ! kill -0 "$clipboard_sway_pid" 2>/dev/null; then
    cat "$clipboard_fixture_dir/sway.log" >&2
    echo "The isolated Wayland compositor exited before the clipboard test" >&2
    exit 1
  fi
  for candidate in "$clipboard_fixture_dir/runtime"/wayland-*; do
    if [ -S "$candidate" ]; then clipboard_wayland_socket="${candidate##*/}"; break; fi
  done
  if [ -n "$clipboard_wayland_socket" ]; then break; fi
  sleep 0.1
done
if [ -z "$clipboard_wayland_socket" ]; then
  cat "$clipboard_fixture_dir/sway.log" >&2
  echo "The isolated Wayland clipboard socket did not become ready" >&2
  exit 1
fi
env -u DISPLAY XDG_RUNTIME_DIR="$clipboard_fixture_dir/runtime" \
  XDG_SESSION_TYPE=wayland WAYLAND_DISPLAY="$clipboard_wayland_socket" "${clipboard_test[@]}"
