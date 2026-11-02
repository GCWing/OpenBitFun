#!/usr/bin/env bash
# Real AT-SPI semantic input against a dedicated GTK window; works with Xvfb too.
set -euo pipefail
if [[ $(uname -s) != Linux || -z ${DBUS_SESSION_BUS_ADDRESS:-} ]]; then
  echo "Run this fixture in a Linux user D-Bus session with GTK and AT-SPI." >&2
  exit 1
fi
fixture_ready=$(mktemp)
export OPENBITFUN_ATSPI_FIXTURE_READY="$fixture_ready"
python3 - <<'PY' &
import gi
import os
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, GLib
window = Gtk.Window(title='OpenBitFun AT-SPI Fixture')
window.set_default_size(480, 240)
window.connect('destroy', Gtk.main_quit)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
box.set_border_width(24)
button = Gtk.Button(label='Activate fixture')
count = 0
def clicked(widget):
    global count
    count += 1
    button.set_label('Activated ' + str(count))
button.connect('clicked', clicked)
entry = Gtk.Entry()
entry.set_text('prefix ')
entry.set_position(-1)
entry.get_accessible().set_name('Fixture text')
box.add(button)
box.add(entry)
window.add(box)
window.show_all()
def ready():
    with open(os.environ['OPENBITFUN_ATSPI_FIXTURE_READY'], 'w') as stream:
        stream.write('ready')
    return False
GLib.timeout_add(1000, ready)
Gtk.main()
PY
fixture_pid=$!
export OPENBITFUN_ATSPI_FIXTURE_PID="$fixture_pid"
trap 'kill "$fixture_pid" 2>/dev/null || true; rm -f "$fixture_ready"' EXIT
for attempt in {1..100}; do
  [[ -s "$fixture_ready" ]] && break
  kill -0 "$fixture_pid" 2>/dev/null || { echo "GTK fixture failed to start." >&2; exit 1; }
  sleep 0.1
done
[[ -s "$fixture_ready" ]] || { echo "GTK fixture readiness timed out." >&2; exit 1; }
cargo test --locked -p openbitfun-computer-use --lib atspi_semantic_fixture -- --ignored --nocapture --test-threads=1
