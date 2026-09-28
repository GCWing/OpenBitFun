# Remote session lifecycle guidance

Android, iOS, and HarmonyOS should follow the same MVVM shape for remote
sessions. The native surfaces may use different language and UI primitives, but
the ViewModel layer should keep the same responsibilities and update order.

## Create

Every create entry point dispatches one create operation with the selected
device and workspace identity. After success, the ViewModel should generally:

1. select the returned session id and route to its conversation surface;
2. discard the previous session's draft, transcript, active turn, and file
   preview state;
3. open or subscribe to the returned session on the remote host;
4. publish the hydrated timeline, including an empty timeline for a new session;
5. send the optional first instruction and start live polling/stream replay.

The route should not wait for a non-empty transcript. An empty session is a
successful open and the conversation View owns its loading state.

## Open an existing session

Opening an existing row follows the same steps from selection onward. The
selected session id is the navigation identity; a stale timeline from another
session should not be rendered while the open request is pending.

## Ownership by platform

- Android and iOS receive most session state from the shared KMP session store.
  Shell state controls containers, drawers, and transient route presentation;
  it should not become a second session store.
- HarmonyOS keeps its native ViewModel and controller, but their responsibilities
  should mirror the KMP store and use the same remote command shapes.
- Transport, relay, and desktop behavior are not owned by a mobile surface.

Failures after the create commit should leave the created session visible and
route to its conversation surface with an explicit loading or error state.
