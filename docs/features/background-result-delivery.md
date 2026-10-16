# Background result delivery

[中文](background-result-delivery.zh-CN.md)

A background execution and a user-facing report are separate facts. A scheduled
run may complete successfully without producing a report, while a failed run
still needs attention even if its task instructions normally request silence.
Reading the saved execution is a third operation; a history read failure does
not establish whether the task itself succeeded.

## Contract and ownership

The execution host admits a scheduled run with a versioned `backgroundDelivery`
descriptor in the original user-message metadata. Its identity contains the task,
turn, and execution generation. Ordinary submissions cannot acquire this
authority by copying metadata. The current producer is the native scheduler;
the report decisions are generic Runtime policy, independent of task names,
languages, workspace paths, platforms, or output phrases.

`core-types::background_delivery` owns the additive DTOs. The portable decisions
live in `agent-runtime::scheduler::result_delivery`. Core owns task admission,
run-scoped proposals, AI-provider access, persistence, and completion-event
wiring. Services project durable facts, and each presentation surface consumes
those facts. The controller never classifies results or reads another host's
files through a local fallback.

| Policy | Behavior |
| --- | --- |
| `inherit` | Follow the saved task instructions. Suppression requires explicit authorization in those instructions. This is the default for old jobs. |
| `always` | Publish every result. A model proposal cannot override it. |
| `conditional` | Permit conditional reports according to the conditions in the task instructions. |
| unknown policy | Keep execution data and publish the result. |

| Disposition | Meaning |
| --- | --- |
| `pending` | The run is executing and its report has not been decided. |
| `quiet` | Completed successfully, with no report required by its policy. |
| `report` | Publish the result, including conservative fallback when a decision is unavailable. |
| `attention` | Execution failed, was interrupted, or requires attention. |

Completion persists the decision before publishing the completion event. A
quiet decision needs a supported schema, matching run/generation, an eligible
policy, and a resolution timestamp. Failures and partial recovery override
quiet proposals. Restoring an interrupted execution increments the generation;
the earlier decision cannot hide the resumed execution. Successful recovery is
itself a visible lifecycle result. Earlier decisions remain in the original
turn's `backgroundDeliveryHistory`.

Observer checkpoints may contain the initial pending descriptor. Saving one
must preserve a decision already resolved by the host and its audit history.
Raw model text, thinking, tools, result bodies, and turn ordinals are retained.

## Structured and legacy model output

The scheduler's reminder explains `Cron` with `action=report`, a final
`disposition`, and a reason. The tool records a proposal for the current admitted
run; it does not finish, rerun, or modify the task. An explicit quiet proposal
also permits a clean, empty natural model ending. Thinking-only output,
interrupted streams, required tool interaction, and Stop hooks keep their
existing lifecycle behavior.

Models that still produce an acknowledgement such as "remaining quiet" receive
compatibility adjudication. The host makes one tool-free request through the
configured `fast` model binding. It supplies the saved task instructions, all
available current-turn assistant/tool text, the final output, the structured
proposal if present, and a previous bound assistant output when available.
Current output is untrusted evidence, not instructions for the adjudicator.

The response must be valid structured JSON, explicitly authorize quiet, and
state a clear final decision with a reason. Uncertainty, missing comparison
evidence, unexpected tools, invalid output, provider failure, excessive input,
or timeout retain a visible report. This is a semantic compatibility path;
there is no keyword or task-specific suppression rule. It judges reporting
intent and cannot independently verify the task's factual claims.

The compatibility request has a 30-second IO deadline and a 64-KiB input budget.
These constrain report adjudication, not the Agent loop or task execution.
Adjudication tokens are recorded separately in `decisionUsage`; the quiet
execution's expanded record displays that additional usage. They do not alter
the recorded task output or masquerade as task-model tokens. An unavailable or
uncertain decision and a failed decision write produce an English diagnostic
bound to the session and turn.

## Presentation, unread, and notifications

The Web UI and mobile transcript fold eligible pending/quiet executions into
an execution receipt. Expanding it exposes the original task and output. Search
can expand the Web UI receipt. Outstanding permissions and questions are always
presented directly; a failure or unsupported descriptor stays visible.

The session's latest execution may advance past its latest unread report. The
host stores the unread result identity in additive custom metadata and projects
it as `SessionActivitySummary.unreadTurn`. Old summaries fall back to
`lastTurn`. A quiet run creates no unread result and does not clear previous
unread work or user-attention state. Read acknowledgements target the reported
turn and generation, so acknowledging an older result cannot clear a newer one.
An older observer also cannot recreate unread work for a known quiet completion.

Desktop notifications use the same disposition. Actual failure events are
subscribed as well as completion events, with duplicate terminal notifications
coalesced for the same result. Existing focus, user preference, and child-session
rules still govern OS delivery. Weixin proactive output consumes the persisted
decision after the persistence fence, suppresses quiet acknowledgements, and
keeps background execution errors visible. Human-initiated bot turns keep their
ordinary reply path.

## History recovery

The history boundary says that records could not be read, rather than implying
that newer content is still being generated. `Resync records` reads a fresh
snapshot from the session's owning host and then re-evaluates the requested
boundary. It does not submit an Agent turn or rerun the scheduled task. Reaching
the authoritative latest boundary clears a residual error.

Surface activation, session identity, presentation generation, and request
tickets fence asynchronous outcomes. Navigation or a newer recovery request
invalidates the earlier request. Persisted snapshots cannot shorten streaming
output. Viewport changes continue through the existing pager commit and anchor
owners. Failed reads log a reason and target ordinal even when detailed history
diagnostics are disabled; repeated identical failures are coalesced.

Detached dispatch history is owned by the target's event replay. Its controller
does not offer the snapshot-resync action, and the store explicitly rejects a
request that would read controller storage. This does not implement quiet
report policy for detached job completion or other producers; those producers
need their own admitted contract and surface handling before adopting it.

## Upgrade and remote boundaries

Job policy, completion delivery, and unread identity are additive, with defaults
for legacy persisted jobs and events. Unknown descriptors remain readable and
visible. No migration deletes, resets, or rewrites user output.

Peer hosts and Remote Connect advertise `background_result_delivery_v1`.
Setting policy on a peer checks that capability; the editor disables policy
selection for older peers and saves other fields through the established path.
Older consumers that do not understand the new fields continue to receive raw
execution content.

| Scenario | Verification boundary |
| --- | --- |
| Local workspace | Runtime decisions, disk-backed completion/checkpoint/recovery, unread contracts, Web UI reduction and notifications. |
| Remote workspace | The run and record use existing execution-host/session-storage ownership. Real SSH or Docker execution requires host validation; local fixtures do not establish it. |
| Remote control | Remote history projection and real Chrome mobile rendering/event reduction, plus the existing host-stream browser suite with a simulated host/relay. No live IM delivery is exercised. |
| Peer Device | Capability negotiation, older-peer rejection, source synchronization and cancellation are contract-tested. No live second-device execution is exercised. |
| Detached Dispatch | Controller snapshot fallback is explicitly rejected; existing target replay remains its recovery path. |

Focused verification commands live in the owning module guides. Semantic model
accuracy still needs evaluation against the configured provider; parser and
policy tests cannot prove it.
