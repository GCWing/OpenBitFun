[English] | [简体中文](Peer-Device-Mode-中文) · [Home](Home)

# Peer Device Mode

## Use another device's workspace

Peer Device Mode keeps the controller shell local while product commands and events come from a selected OpenBitFun Desktop or CLI host. The peer owns execution, sessions, filesystem, terminals, and permission interactions.

This differs from SSH workspace IO and from submitting a [Dispatch job](Detached-Dispatch).

## Connect

1. Configure the account/Relay service and sign in with GitHub on the relevant devices.
2. Open Remote Connect device management and inspect same-account devices and online state.
3. Connect the intended device and enter its supported peer surface.
4. Select a workspace that exists on the peer, then open or create a session.
5. Verify the device indicator and path before changing files or running commands.

Capabilities come from the target host; Desktop and CLI do not necessarily expose the same set. Unsupported operations must be reported, not silently executed on the controller.

## Ownership and disconnect

Paths that look identical on two devices are still different resources. Never reuse a controller path as a peer execution path. Download destinations belong to the controller, while source files belong to the peer.

Switching back to the local view is not cancellation or teardown of peer work. Accepted tasks remain owned by the executing runtime, even with no controller attached, provided that runtime remains available. Reconnect to recover history and unanswered interactions.

Controller-local window, account identity, and deployment actions do not become remote merely because the peer view is active. Keep both devices secure and remove obsolete device access.

[Peer behavior reference](https://github.com/GCWing/OpenBitFun/blob/v1.0.0/src/web-ui/src/infrastructure/peer-device/README.md)

> Screenshot pending: S31 — device connection and peer indicator.
