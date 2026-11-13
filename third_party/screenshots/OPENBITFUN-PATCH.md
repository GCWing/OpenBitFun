# Rust never-type fallback compatibility

Source: crates.io `screenshots` 0.8.10, published from
<https://github.com/nashaofu/screenshots-rs> (now maintained as `xcap`). The
upstream package sources and Apache-2.0 license are retained here.

The Linux Wayland screenshot implementation ignores the success values of two
D-Bus calls. Recent Rust type inference no longer falls back to `()` for their
unconstrained result type, so `dbus::blocking::Proxy::method_call` tries to use
`!`, which does not implement `ReadAll`. Both calls now explicitly bind their
result as `()`; runtime behavior is unchanged.

Verify the Linux target with:

```sh
cargo check --manifest-path third_party/screenshots/Cargo.toml --target x86_64-unknown-linux-gnu
```

Remove this override if a maintained upstream `screenshots` release includes
the explicit result typing and passes the Linux target check.
