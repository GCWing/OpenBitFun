# Browser control observation context

Keep browser transport and action orchestration in the existing owners.
`snapshot.js`, `resolve_element.js`, and `snapshot_context.rs` are local
observation/targeting helpers, used by both built-in and external browser clients.

## Contracts

- Snapshot collection, stale-ref cleanup, and target lookup must traverse the
  same open shadow roots and same-origin iframe hierarchy.
- Frame-relative geometry carries its coordinate-space label. Hidden/offscreen
  parent frames must not expose their descendants as visible controls.
- An empty accessible-name attribute must not suppress later label fallbacks.
  Keep form state separate from the name; never include password values.
- Preserve structured elements verbatim in `refs`. Invalid/missing JSON or
  duplicate refs are errors, not successful empty snapshots.
- Bounded text/value projections declare truncation. Inaccessible frames and
  offscreen elements are reported so absence is not mistaken for nonexistence.
- External browser control is background work. Creating or selecting a tab must
  not raise the user's window or take focus: pass `background: true` to
  `Target.createTarget` and keep `Page.bringToFront` behind an explicit
  `activate` request. Launch paths follow the same rule (`open -g` on macOS), and
  only a browser-owned consent prompt or a user-visible launch may activate.

## Focused verification

```bash
node scripts/test-computer-use-context.mjs
# Real Chromium collection and ref activation, followed by compiled Rust
# parsing/presentation of the actual browser payload (Node 22/24 + Chrome):
node scripts/test-browser-snapshot.mjs
# Production dispatcher workflow in disposable Chromium (same Node requirement):
node scripts/test-browser-workflow.mjs
cargo test -p openbitfun-core --no-default-features --features agent-runtime,tools-browser-web,tools-computer-use,git --lib browser_control::
cargo test -p openbitfun-core --no-default-features --features agent-runtime,tools-browser-web,tools-computer-use,git --lib control_hub_tool::
cargo test -p openbitfun-core --no-default-features --features agent-runtime,tools-browser-web,tools-miniapp,git --lib playbook_tool::tests::
cargo test -p openbitfun-core --no-default-features --features agent-runtime,tools-browser-web,tools-computer-use,git --lib computer_use_tool::tests::
```

The Core test target currently needs `git` for its worktree tool module and
`tools-browser-web` for the shared ControlHub error contract. Computer Use schema
checks additionally select `tools-computer-use`; none requires `product-full`.

The Chromium fixture verifies local external-browser behavior. It is not
evidence of built-in WebKit, remote workspace, mobile/IM remote control, Peer
Device Mode, or Detached Dispatch execution.

Navigation creates a page when needed; optional `observe` reuses that page's
state. Keep conversation selections and stale-id errors through all actions.
External user-profile identity/access requires a successful Settings connection;
headless endpoints are explicit and verified. Browser setup/consent is never an
Agent recovery action. Preserve legacy open/read payloads and result fields.
