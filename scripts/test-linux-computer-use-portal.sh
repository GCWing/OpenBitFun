#!/usr/bin/env bash
# Native Ubuntu fixture: real GTK window, real portal consent and PipeWire frames.
set -euo pipefail
if [[ $(uname -s) != Linux ]]; then
  echo "This fixture requires an interactive Ubuntu/Linux desktop." >&2
  exit 1
fi
if [[ -z ${DBUS_SESSION_BUS_ADDRESS:-} || ( -z ${WAYLAND_DISPLAY:-} && -z ${DISPLAY:-} ) ]]; then
  echo "Run in the target desktop user's session, not a headless container or sudo shell." >&2
  exit 1
fi
python3 - <<'PY' &
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk
window = Gtk.Window(title='OpenBitFun Portal Fixture')
window.set_default_size(640, 360)
window.connect('destroy', Gtk.main_quit)
area = Gtk.DrawingArea()
def draw(widget, context):
    context.set_source_rgb(0.08, 0.62, 0.62)
    context.paint()
    context.set_source_rgb(1, 1, 1)
    context.set_font_size(22)
    context.move_to(35, 150)
    context.show_text('OpenBitFun Portal Fixture')
    context.set_font_size(15)
    context.move_to(35, 190)
    context.show_text('Select this window in the system sharing dialog.')
area.connect('draw', draw)
window.add(area)
window.show_all()
Gtk.main()
PY
fixture_pid=$!
trap 'kill "$fixture_pid" 2>/dev/null || true' EXIT
cargo test --locked -p openbitfun-computer-use --lib portal_observe_lifecycle -- --ignored --nocapture --test-threads=1
