use super::tool_activity::ToolActivityProjection;
use super::{LoopxPersistedState, LoopxStateStore, LoopxTaskRuntimeRecord};
use crate::util::elapsed_ms_u64;
use openbitfun_product_domains::miniapp::loopx::*;
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, mpsc, Mutex, RwLock};

const DEFAULT_AGENT_ID: &str = "bitfun-agent";
const EVENT_CHANNEL_CAPACITY: usize = 256;
const INTAKE_PREVIEW_TTL_MS: i64 = 5 * 60 * 1000;
const MAX_INTAKE_PREVIEWS: usize = 64;
const MAX_AGENT_SUMMARY_CHARS: usize = 16_000;
const GOAL_RECONCILE_TTL_MS: i64 = 30_000;
const GOAL_RECONCILE_DEADLINE_MS: i64 = 30_000;
/// Default requeue delay for a waiting goal when the envelope projects no
/// cadence label at all (degraded or salvaged snapshots). Bounded so a task
/// can never sleep forever, but far above LoopX's own minimum cadence
/// (`active_work` wakes after 3 minutes) so an unlabeled wait never becomes a
/// hot poll of the control plane.
const WAIT_RESCHEDULE_FALLBACK_MS: u64 = 5 * 60 * 1000;
/// Backoff before re-driving after a retryable turn-build conflict.
const TURN_CONFLICT_RETRY_MS: u64 = 5_000;

/// One-shot host note appended to the corrective turn instruction after a
/// NoDurableProgress settlement. The note routes the agent through the LoopX
/// CLI write boundary so settlement can validate the writeback; it never
/// fabricates goal state on the agent's behalf.
const LOOPX_DURABLE_COMPENSATION_NOTE: &str = "The previous turn finished, but LoopX settlement reported no validated durable progress. Re-submit the pending vision and resolution artifacts through the LoopX CLI write boundary (`loopx refresh-state`) so they are recorded inside the goal workspace; do not write these artifacts to paths outside the workspace such as the system temp directory. If the previous turn modified product source files under the worktree but did not commit them, commit those product changes to the task branch with a descriptive message before ending the turn (leave `.loopx`/`.codex` bookkeeping out of the commit). When the writeback receipts are confirmed, end the turn so settlement can validate them.";

/// Environment boundary appended to every LoopX agent turn instruction.
///
/// The pinned LoopX CLI provided by the host is the only authoritative source
/// for LoopX behavior, commands, flags, and schemas. Users may have LoopX
/// source checkouts elsewhere on the machine (any tree containing
/// `loopx/pyproject.toml`, a `loopx/capabilities/` layout, and so on); those
/// trees can be a different version than the pinned runtime, so treating them
/// as documentation derails the turn (observed live as a different-version
/// LoopX checkout steering a turn executed by the pinned CLI, including a
/// hallucinated capability path retried over a hundred times). The runtime
/// must work identically whether or not such a checkout exists.
const LOOPX_AGENT_ENVIRONMENT_BOUNDARY_NOTE: &str = "\n\n---\n[BitFun environment boundary] The LoopX runtime on this machine is the CLI binary provided by the BitFun host at a pinned version; it is the only authoritative source for LoopX behavior, commands, flags, and schemas. Consult `loopx --help`, the help of the exact subcommand, or artifacts inside the goal workspace instead. Do not read, grep, or follow any LoopX source checkout on this machine (for example any directory containing `loopx/pyproject.toml`, a `loopx/capabilities/` tree, or a similar source layout): such trees may be a different version than the pinned runtime and are not documentation. Do not load, read, or follow any `loopx` or `loopx-*` entries from your skill catalog or from user-level skill directories (`~/.codex/skills`, `~/.agents/skills`): other LoopX installations of a different version may have placed them there, and the authoritative LoopX workflow documents for this task are ONLY the pinned files under this worktree's `.loopx/` directory that this instruction names - when a LoopX document tells you to load another `loopx-*` skill, read the matching seeded `.loopx/` file instead of resolving the skill name through the catalog. Never install, update, self-update, or repair the LoopX installation (for example `loopx update`, `loopx self-repair` install flows, `scripts/install-local.sh`, or `scripts/install-windows.ps1`): the BitFun host owns the pinned binary, and installation repair is a host concern, never a task action. GitHub EXTERNAL WRITES are owner-gated: do NOT run `git push` to a remote, `gh pr create`, `gh issue comment`, `gh pr merge/close`, or any other GitHub write unless this turn's contract explicitly carries that approval. LoopX plans external writes behind a user gate (`requires_user_gate_before_external_write`); a todo's text (for example \"open a PR\") is a plan description, NOT an authorization. Prepare the branch and local validation, record the publish recommendation in your report, and stop - the owner approves publication from the host UI. GitHub reads stay allowed, but use the `gh` CLI for ALL GitHub data (issues, PRs, comments, releases): direct WebFetch calls to github.com / api.github.com are rejected with HTTP 403 (observed repeatedly). If a file path you assumed does not exist, do not retry the same path; re-derive it from CLI help output or goal-workspace artifacts.";

/// Host-side compensation for the pinned sidecar: the pinned LoopX CLI does
/// not bundle the workflow-skill markdown, so this exact CLI reference (help
/// output of the pinned version, captured at build time) is seeded into each
/// worktree as `.loopx/pinned-loopx-reference.md`; the agent reads it once
/// per session instead of the host reverse-engineering commands.
const LOOPX_PINNED_CLI_REFERENCE: &str = include_str!("resources/loopx-pinned-cli-reference.md");

/// Verbatim LoopX workflow-skill documents from the pinned v1.0.1 source
/// (`skills/loopx-project/SKILL.md` + `skills/loopx-self-repair/SKILL.md`).
/// This is the same first-party documentation a LoopX-style agent host (e.g.
/// the codex path) loads at session start - it is the ROOT-CAUSE fix for the
/// agent inventing packet shapes: the official docs contain the exact
/// `goal_vision_replan_contract_v0` / `vision_patch` schema and the
/// refresh-state closure flags, which `--help` output does not. Seeded into
/// each worktree alongside the CLI reference; the agent reads the file once
/// per session (mirroring the codex skill-loading mechanism) instead of the
/// host pasting the bytes into every instruction.
const LOOPX_PINNED_SKILLS_REFERENCE: &str =
    include_str!("resources/loopx-pinned-skills-reference.md");

/// Additional official workflow-skill documents delivered per the custom-host
/// integration guide ("deliver loopx-project, loopx-pr-program, loopx-pr-review,
/// loopx-doc-registry and loopx-self-repair from the same LoopX revision");
/// change-quality is additional and activated by goal policy, so it is seeded
/// but the agent reads it only when a quality-qualified step applies.
const LOOPX_PINNED_SKILL_DOC_REGISTRY: &str =
    include_str!("resources/pinned-skill-loopx-doc-registry.md");
const LOOPX_PINNED_SKILL_PR_PROGRAM: &str =
    include_str!("resources/pinned-skill-loopx-pr-program.md");
const LOOPX_PINNED_SKILL_PR_REVIEW: &str =
    include_str!("resources/pinned-skill-loopx-pr-review.md");
const LOOPX_PINNED_SKILL_CHANGE_QUALITY: &str =
    include_str!("resources/pinned-skill-loopx-change-quality.md");

/// Closing-ceremony order gleaned from live guard rejections on the pinned
/// CLI (observed 2026-09-07): a terminal no-follow-up completion request is
/// rejected with a typed refusal unless an accountable durable writeback and
/// the quota-spend receipt already exist, and the guard demanded the sequence
/// refresh-state -> quota spend-slot -> terminal. Minimal host facts for the
/// closing ceremony. The authoritative semantics (refresh-state / todo /
/// quota / vision packet schemas and ordering) come from the pinned official
/// skill document seeded in the worktree. Single source of truth (observed
/// 2026-09-08): agents actively execute a read directive in this note — it
/// must therefore only NAME the document and defer to the pointer section
/// above, which alone owns the read-once policy (fresh session: read once;
/// continued session: already loaded, reuse context). A read verb here would
/// re-read the 59KB document every turn of a reused session.
const LOOPX_CLOSING_CEREMONY_NOTE: &str = "\n\n---\n[BitFun host facts - closing ceremony]\n\
- Closing-ceremony semantics (refresh-state / todo / quota / vision packet\n\
  schemas and ordering) are authoritative in `.loopx/pinned-loopx-skill.md`;\n\
  when to read that document is governed only by the pointer section above.\n\
- On a TYPED refusal, apply exactly the parameter the CLI error names and retry ONCE;\n\
  do not retry the same argv, do not reorder steps, and report a blocker after two ordered attempts.\n\
- The runtime is project-local (`<worktree>/.loopx/runtime`); never write to `~/.codex/loopx`.";

/// Composes the final agent turn instruction: the CLI-provided turn
/// instruction, then the always-on environment boundary, then a short pointer
/// to the pinned LoopX reference file seeded in the worktree (the agent reads
/// it once per session, mirroring how a LoopX codex-style host loads its
/// workflow skills), then the minimal closing-ceremony host facts, then the
/// one-shot host note (if any) last so corrective guidance stays closest to
/// the end. `session_continuation` marks turns that continue the goal's live
/// agent session: the pointer then reminds the agent the references are
/// already in its conversation instead of asking for a fresh read.
fn compose_agent_turn_instruction(
    instruction: String,
    host_note: Option<&str>,
    pinned_reference_path: Option<&str>,
    session_continuation: bool,
) -> String {
    let mut composed = instruction;
    composed.push_str(LOOPX_AGENT_ENVIRONMENT_BOUNDARY_NOTE);
    if let Some(reference_path) = pinned_reference_path {
        if session_continuation {
            composed.push_str("\n\n---\n[Pinned LoopX references - already loaded]\n");
            composed.push_str(
                "This conversation continues an earlier turn of the same goal; the \
pinned LoopX skill document you already read from `",
            );
            composed.push_str(reference_path);
            composed.push_str(
                "` - and its sibling documents seeded under the same `.loopx/` \
directory - remain the authoritative LoopX workflow references for this host. \
Reuse them from your conversation context; re-read a file only if this \
conversation was compacted and its content is no longer present.\n",
            );
        } else {
            composed.push_str("\n\n---\n[Pinned LoopX references - read exactly once]\n");
            composed.push_str("Read `");
            composed.push_str(reference_path);
            composed.push_str(
                "` ONCE before acting - it is the authoritative LoopX skill document \
(refresh-state / todo / quota / vision packet schemas and ordering). Use it from your \
conversation context afterwards; re-read only if this conversation was compacted. \
A separate CLI help file (`.loopx/pinned-loopx-cli-help.md`) exists ONLY for verifying a \
specific flag/argument when needed - do not read it up front. \
Sibling skill documents of the same pinned revision are seeded alongside it: \
`.loopx/loopx-doc-registry.md`, `.loopx/loopx-pr-program.md`, \
`.loopx/loopx-pr-review.md`, and `.loopx/loopx-change-quality.md`; when a skill \
document tells you to load another `loopx-*` skill, read the matching seeded file - \
never resolve loopx skill names through your skill catalog or user-level skill \
directories (they may hold a different LoopX version).\n\
- This host runs the `generic-cli / outer_controller / isolated-headless` runtime profile. \
Any `codex_app` scheduler/ACK fields the skill document mentions are CONCEPTUAL ONLY for this \
host; your actual scheduler hint comes from the packet you received - apply it as-is. \
- `.loopx/agent-onboard-pack.json` (fresh per goal) holds your agent-type's canonical \
doctor/bootstrap/quota/recheck command templates - prefer those forms over re-deriving them.\n",
            );
        }
    }
    composed.push_str(LOOPX_CLOSING_CEREMONY_NOTE);
    if let Some(note) = host_note {
        composed.push_str("\n\n---\n[BitFun host note] ");
        composed.push_str(note);
    }
    composed
}

/// `recovery_reason` for a Goal that is still Active after its plan ran dry:
/// no open todo, no waiting user decision, and no selected action remain, so
/// the host contract forbids fabricating a terminal transition. The task
/// parks with this explicit reason (instead of a generic execution failure)
/// so the recovery card can explain the plan is exhausted and guide the
/// owner: resume once the Goal gains a new todo or gate, or finish the
/// delivery manually from the task branch.
const LOOPX_PLAN_EXHAUSTED_REASON: &str = "plan_exhausted";

/// Owner-facing message persisted on the task when the RunNow frontier is
/// exhausted. Kept in English because the same text is host telemetry; the
/// MiniApp renders localized guidance keyed off `recovery_reason`.
const LOOPX_PLAN_EXHAUSTED_MESSAGE: &str = "LoopX goal is still active but its plan is exhausted: no open todo, no waiting user decision, and no selected action remain. BitFun does not fabricate a terminal Goal transition, so the task parks for an owner decision; the worktree, evidence, and any commits are preserved. Resume after the goal gains a new todo or gate (for example after an upstream PR merge), or finish the delivery manually from the task branch.";

struct ScheduledTask {
    task_id: String,
}

struct InProgressGuard<'a>(&'a AtomicBool);

impl Drop for InProgressGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Default)]
struct BufferedProgress(StdMutex<Vec<LoopxCliProgress>>);

impl BufferedProgress {
    fn take(&self) -> Vec<LoopxCliProgress> {
        std::mem::take(
            &mut *self
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }
}

impl LoopxCliProgressSink for BufferedProgress {
    fn report(&self, progress: LoopxCliProgress) {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(progress);
    }
}

pub struct LoopxController {
    cli: Arc<dyn LoopxCliPort>,
    workspace: Arc<dyn LoopxWorkspacePort>,
    agent: Arc<dyn LoopxAgentPort>,
    agent_capabilities: Vec<String>,
    store: LoopxStateStore,
    state: RwLock<LoopxPersistedState>,
    mutation_lock: Mutex<()>,
    reconcile_lock: Mutex<()>,
    previews: RwLock<HashMap<String, LoopxIntakePreview>>,
    active_tasks: Mutex<HashMap<String, bool>>,
    active_repositories: Mutex<HashMap<String, String>>,
    event_sender: broadcast::Sender<LoopxEvent>,
    task_sender: mpsc::UnboundedSender<ScheduledTask>,
    load_error: RwLock<Option<String>>,
    install_in_progress: AtomicBool,
    reset_in_progress: AtomicBool,
}

impl LoopxController {
    pub async fn load(
        cli: Arc<dyn LoopxCliPort>,
        workspace: Arc<dyn LoopxWorkspacePort>,
        agent: Arc<dyn LoopxAgentPort>,
        store: LoopxStateStore,
    ) -> Arc<Self> {
        let now = now_ms();
        let (mut persisted, load_error) = match store.load().await {
            Ok(Some(state)) => (state, None),
            Ok(None) => (LoopxPersistedState::new(now), None),
            Err(error) => (LoopxPersistedState::new(now), Some(error)),
        };
        let restart_changed = load_error.is_none() && persisted.apply_restart_policy(now);
        let (event_sender, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let (task_sender, mut task_receiver) = mpsc::unbounded_channel::<ScheduledTask>();
        let agent_capabilities = agent.available_capabilities();
        let controller = Arc::new(Self {
            cli,
            workspace,
            agent,
            agent_capabilities,
            store,
            state: RwLock::new(persisted),
            mutation_lock: Mutex::new(()),
            reconcile_lock: Mutex::new(()),
            previews: RwLock::new(HashMap::new()),
            active_tasks: Mutex::new(HashMap::new()),
            active_repositories: Mutex::new(HashMap::new()),
            event_sender,
            task_sender,
            load_error: RwLock::new(load_error),
            install_in_progress: AtomicBool::new(false),
            reset_in_progress: AtomicBool::new(false),
        });
        if restart_changed {
            if let Err(error) = controller.persist_current().await {
                *controller.load_error.write().await = Some(error);
            }
        }
        let task_runner = Arc::clone(&controller);
        tokio::spawn(async move {
            while let Some(scheduled) = task_receiver.recv().await {
                let task_runner = Arc::clone(&task_runner);
                tokio::spawn(async move {
                    if !task_runner.reserve_scheduled_task(&scheduled.task_id).await {
                        return;
                    }
                    loop {
                        let result = task_runner.drive_task(scheduled.task_id.clone()).await;
                        if let Err(error) = result {
                            let _ = task_runner.fail_task(&scheduled.task_id, error).await;
                        }
                        if !task_runner.release_scheduled_task(&scheduled.task_id).await {
                            break;
                        }
                        if !task_runner.reserve_scheduled_task(&scheduled.task_id).await {
                            break;
                        }
                    }
                });
            }
        });
        controller.enqueue_ready_tasks_after_load().await;
        controller
    }

    pub fn subscribe(&self) -> broadcast::Receiver<LoopxEvent> {
        self.event_sender.subscribe()
    }

    pub async fn attach(
        &self,
        execution_domain: LoopxExecutionDomain,
        execution_support: LoopxExecutionSupport,
        unsupported_reason: Option<String>,
    ) -> LoopxAttachResponse {
        let environment_ready =
            self.state.read().await.environment.status == LoopxEnvironmentStatus::Ready;
        if execution_support == LoopxExecutionSupport::Supported
            && environment_ready
            && self.load_error.read().await.is_none()
        {
            self.reconcile_goal_projections(false).await;
        }
        let state = self.state.read().await;
        let mut snapshot = state.snapshot(
            execution_domain,
            execution_support,
            unsupported_reason,
            now_ms(),
        );
        if let Some(error) = self.load_error.read().await.clone() {
            snapshot.execution_support = LoopxExecutionSupport::UnsupportedExecutionDomain;
            snapshot.unsupported_reason = Some(error);
            snapshot.environment.status = LoopxEnvironmentStatus::Blocked;
        }
        LoopxAttachResponse { snapshot }
    }

    /// Re-hydrates LoopX-owned projections after the trusted Desktop surface
    /// observes a suspend/resume clock discontinuity. Active Agent turns are
    /// preserved: Windows can resume their subprocess tree successfully, so
    /// this path invalidates stale clients and refreshes only read-only host
    /// facts instead of manufacturing a failure or duplicate turn.
    pub async fn handle_host_resume(self: &Arc<Self>) -> Result<(), String> {
        if self.reset_in_progress.load(Ordering::Acquire) {
            return Ok(());
        }
        {
            let _mutation = self.mutation_lock.lock().await;
            let mut state = self.state.write().await;
            let start_cursor = state.cursor;
            state.revision = state.revision.saturating_add(1);
            // A host resume is an implicit suite continue: the user is back and
            // the run should re-arm, so the durable stop flag clears here.
            state.suspended = false;
            state.append_event(LoopxEvent {
                kind: LoopxEventKind::SnapshotInvalidated,
                level: LoopxEventLevel::Info,
                source: LoopxEventSource::Controller,
                message: "Host resumed; refreshing LoopX projections".to_string(),
                occurred_at: now_ms(),
                ..LoopxEvent::default()
            });
            let persisted = state.clone();
            drop(state);
            self.store.save(&persisted).await?;
            self.broadcast_new_events(&persisted, start_cursor);
        }

        if let Err(error) = self.refresh_environment().await {
            log::warn!("LoopX environment refresh after host resume failed: {error}");
        }
        self.reconcile_goal_projections(true).await;
        Ok(())
    }

    /// Refresh the read-only LoopX Goal projection before presenting persisted
    /// host jobs. Failures preserve the last local projection and are surfaced
    /// in logs; they never manufacture a Goal transition or local fallback.
    async fn reconcile_goal_projections(&self, force: bool) {
        let Ok(_reconcile) = self.reconcile_lock.try_lock() else {
            return;
        };
        let now = now_ms();
        let candidates = {
            let state = self.state.read().await;
            state
                .tasks
                .iter()
                .filter(|task| {
                    task.goal_id.as_deref().is_some_and(|id| !id.is_empty())
                        && task
                            .workspace_path
                            .as_deref()
                            .is_some_and(|path| !path.is_empty())
                        && !matches!(
                            task.state,
                            LoopxTaskState::Preparing
                                | LoopxTaskState::Running
                                | LoopxTaskState::Cancelling
                                | LoopxTaskState::Aborted
                                | LoopxTaskState::Archived
                        )
                        // Passive states change through explicit host actions. Re-
                        // inspecting them on every UI attach only spawns sidecar
                        // processes that can time out. Suspend/resume keeps the force
                        // path so an externally changed Goal is still repaired.
                        && (force
                            || (task.state == LoopxTaskState::WaitingForUser
                                && task.pending_gate_id.is_none())
                            || !matches!(
                                task.state,
                                LoopxTaskState::WaitingForUser
                                    | LoopxTaskState::Completed
                                    | LoopxTaskState::Stopped
                                    | LoopxTaskState::Failed
                                    | LoopxTaskState::RecoveryRequired
                            ))
                        && (force
                            || task.goal_state.is_none()
                            || now.saturating_sub(task.updated_at) >= GOAL_RECONCILE_TTL_MS)
                })
                .filter_map(|task| {
                    let runtime = state.runtime.get(&task.task_id)?.clone();
                    // The reconcile throttle is tracked per task on the runtime
                    // record, not via `updated_at`: progress events from the
                    // reconcile itself must not restart the window, otherwise
                    // every UI attach spawns a fresh sidecar probe.
                    let throttle_ok = force
                        || task.goal_state.is_none()
                        || runtime
                            .last_goal_reconcile_at_ms
                            .map(|at| now.saturating_sub(at) >= GOAL_RECONCILE_TTL_MS)
                            .unwrap_or(true);
                    (throttle_ok && !runtime.registry_path.is_empty())
                        .then(|| (task.clone(), runtime))
                })
                .collect::<Vec<_>>()
        };

        for (task, runtime) in candidates {
            let mut context = self.goal_context(&task, &runtime);
            context.call.operation_id =
                format!("reconcile-goal-{}-{}", task.task_id, uuid::Uuid::new_v4());
            context.call.deadline_at = Some(now_ms().saturating_add(GOAL_RECONCILE_DEADLINE_MS));
            let progress = BufferedProgress::default();
            let result = self
                .cli
                .inspect_goal(
                    LoopxCliInspectGoalRequest {
                        context,
                        goal_id: task.goal_id.clone().unwrap_or_default(),
                        agent_id: task
                            .agent_id
                            .clone()
                            .unwrap_or_else(|| DEFAULT_AGENT_ID.to_string()),
                    },
                    &progress,
                )
                .await;
            if let Err(error) = self.record_progress(progress.take()).await {
                log::warn!(
                    "Failed to persist LoopX reconciliation progress: task_id={}, error={}",
                    task.task_id,
                    error
                );
            }
            let snapshot = match result {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    log::warn!(
                        "LoopX Goal reconciliation failed: task_id={}, goal_id={}, error={}",
                        task.task_id,
                        task.goal_id.as_deref().unwrap_or("unknown"),
                        error
                    );
                    continue;
                }
            };
            // Record the attempt regardless of outcome so a chatty UI attach
            // cadence cannot turn reconciliation into a sidecar hot loop.
            // Bookkeeping write: this deliberately does not bump the state
            // revision — background reconciliation must never invalidate the
            // expected revision of a pending UI action (for example the
            // repository recovery button).
            let reconciled_at = now_ms();
            {
                let _mutation = self.mutation_lock.lock().await;
                let mut state = self.state.write().await;
                if let Some(runtime) = state.runtime.get_mut(&task.task_id) {
                    runtime.last_goal_reconcile_at_ms = Some(reconciled_at);
                }
                let persisted = state.clone();
                drop(state);
                if let Err(error) = self.store.save(&persisted).await {
                    log::warn!(
                        "Failed to persist LoopX reconcile throttle: task_id={}, error={}",
                        task.task_id,
                        error
                    );
                }
            }
            if let Err(error) = self.apply_goal_projection(&task, &snapshot).await {
                log::warn!(
                    "Failed to apply LoopX Goal projection: task_id={}, goal_id={}, error={}",
                    task.task_id,
                    snapshot.goal_id,
                    error
                );
            }
        }
    }

    pub async fn events_since(&self, request: LoopxEventsSinceRequest) -> LoopxEventsSinceResponse {
        self.state.read().await.events_since(
            &request.stream_id,
            request.after_cursor,
            request.limit,
        )
    }

    pub async fn turn_output_since(
        &self,
        request: LoopxTurnOutputSinceRequest,
    ) -> LoopxTurnOutputSinceResponse {
        let (task, runtime) = {
            let state = self.state.read().await;
            let Some(task) = state
                .tasks
                .iter()
                .find(|task| task.task_id == request.task_id)
            else {
                return LoopxTurnOutputSinceResponse {
                    status: LoopxTurnOutputStatus::TaskNotFound,
                    task_id: request.task_id,
                    message: Some("LoopX task was not found".to_string()),
                    ..LoopxTurnOutputSinceResponse::default()
                };
            };
            let runtime = state
                .runtime
                .get(&task.task_id)
                .cloned()
                .unwrap_or_default();
            (task.clone(), runtime)
        };

        if task.state != LoopxTaskState::Running || task.phase != LoopxPhase::AgentRunning {
            return LoopxTurnOutputSinceResponse {
                status: LoopxTurnOutputStatus::NotRunning,
                task_id: task.task_id,
                turn_id: task.current_turn_id,
                message: Some("LoopX task does not have an active Agent turn".to_string()),
                ..LoopxTurnOutputSinceResponse::default()
            };
        }
        let Some(session_id) = runtime.session_id else {
            return LoopxTurnOutputSinceResponse {
                status: LoopxTurnOutputStatus::OutputUnavailable,
                task_id: task.task_id,
                turn_id: task.current_turn_id,
                message: Some("LoopX Agent session output is unavailable".to_string()),
                ..LoopxTurnOutputSinceResponse::default()
            };
        };
        let Some(turn_id) = runtime
            .agent_turn_id
            .clone()
            .or_else(|| task.current_turn_id.clone())
        else {
            return LoopxTurnOutputSinceResponse {
                status: LoopxTurnOutputStatus::OutputUnavailable,
                task_id: task.task_id,
                message: Some("LoopX Agent turn output is unavailable".to_string()),
                ..LoopxTurnOutputSinceResponse::default()
            };
        };
        if request
            .turn_id
            .as_deref()
            .is_some_and(|requested| requested != turn_id)
        {
            return LoopxTurnOutputSinceResponse {
                status: LoopxTurnOutputStatus::StaleTurn,
                task_id: task.task_id,
                turn_id: Some(turn_id),
                message: Some("LoopX task moved to a different Agent turn".to_string()),
                ..LoopxTurnOutputSinceResponse::default()
            };
        }

        match self
            .agent
            .output_since(LoopxAgentOutputSinceRequest {
                operation_id: format!("output-agent-{}", uuid::Uuid::new_v4()),
                session_id,
                turn_id: turn_id.clone(),
                stream_id: request.stream_id,
                after_cursor: request.after_cursor,
                limit: request.limit,
            })
            .await
        {
            Ok(page) => LoopxTurnOutputSinceResponse {
                status: LoopxTurnOutputStatus::Current,
                task_id: task.task_id,
                turn_id: Some(turn_id),
                stream_id: page.stream_id,
                events: page.events,
                next_cursor: page.next_cursor,
                has_more: page.has_more,
                message: None,
            },
            Err(error) => LoopxTurnOutputSinceResponse {
                status: LoopxTurnOutputStatus::OutputUnavailable,
                task_id: task.task_id,
                turn_id: Some(turn_id),
                message: Some(error.to_string()),
                ..LoopxTurnOutputSinceResponse::default()
            },
        }
    }

    pub async fn refresh_environment(self: &Arc<Self>) -> Result<(), String> {
        self.ensure_writable().await?;
        let probe_id = uuid::Uuid::new_v4();
        self.mark_environment_checking().await?;
        let progress = BufferedProgress::default();
        let handshake = self.cli.handshake(
            LoopxCliHandshakeRequest {
                call: LoopxCliCallContext {
                    operation_id: format!("environment-sidecar-{probe_id}"),
                    deadline_at: None,
                },
                ..LoopxCliHandshakeRequest::default()
            },
            &progress,
        );
        let workspace = self.workspace.probe(LoopxWorkspaceProbeRequest {
            operation_id: format!("environment-workspace-{probe_id}"),
            repository: None,
        });
        let agent = self.agent.probe(LoopxAgentProbeRequest {
            operation_id: format!("environment-agent-{probe_id}"),
            model_id: Some("auto".to_string()),
        });
        let github_auth = self.probe_github_auth();
        let (handshake, workspace, agent, github_auth) =
            tokio::join!(handshake, workspace, agent, github_auth);
        self.record_progress(progress.take()).await?;
        self.commit_environment(handshake, workspace, agent, github_auth)
            .await?;
        self.reconcile_goal_projections(true).await;
        Ok(())
    }

    async fn probe_github_auth(&self) -> LoopxGithubAuthProbe {
        let operation_id = format!("github-auth-{}", uuid::Uuid::new_v4());
        match self
            .cli
            .probe_github_auth(LoopxGithubAuthProbeRequest {
                call: LoopxCliCallContext {
                    operation_id,
                    deadline_at: None,
                },
            })
            .await
        {
            Ok(probe) => probe,
            Err(error) => LoopxGithubAuthProbe {
                authenticated: false,
                detail: Some(format!("GitHub auth probe failed: {error}")),
                ..LoopxGithubAuthProbe::default()
            },
        }
    }

    pub async fn resolve_intake(
        &self,
        request: LoopxResolveIntakeRequest,
    ) -> Result<LoopxResolveIntakeResponse, String> {
        self.ensure_writable().await?;
        let target = parse_loopx_intake(&request.input).map_err(|error| error.to_string())?;
        let probe_id = uuid::Uuid::new_v4();
        let repository = target.repository().clone();
        let model_id = request.model_id;
        let progress = BufferedProgress::default();
        let resolved = self.cli.resolve_intake(
            LoopxCliResolveIntakeRequest {
                call: LoopxCliCallContext {
                    operation_id: format!("resolve-metadata-{probe_id}"),
                    deadline_at: None,
                },
                input: request.input,
                target: target.clone(),
            },
            &progress,
        );
        let workspace_probe = self.workspace.probe(LoopxWorkspaceProbeRequest {
            operation_id: format!("resolve-workspace-{probe_id}"),
            repository: Some(repository),
        });
        let agent_probe = self.agent.probe(LoopxAgentProbeRequest {
            operation_id: format!("resolve-agent-{probe_id}"),
            model_id: Some(model_id.clone()),
        });
        let (resolved, workspace_probe, agent_probe) =
            tokio::join!(resolved, workspace_probe, agent_probe);
        self.record_progress(progress.take()).await?;
        let resolved = resolved.map_err(|error| error.to_string())?;
        let scopes = LOOPX_REQUIRED_PERMISSION_SCOPES.to_vec();
        let model = match agent_probe {
            Ok(probe) => LoopxModelCapability {
                model_id,
                available: true,
                supports_images: probe.supports_images,
                detail: Some(format!("Resolved Agent model: {}", probe.model_id)),
            },
            Err(error) => LoopxModelCapability {
                model_id,
                available: false,
                supports_images: false,
                detail: Some(error.to_string()),
            },
        };
        let workspace = match workspace_probe {
            Ok(probe) => LoopxWorkspacePreview {
                disposition: LoopxWorkspaceDisposition::CloneRequired,
                path: None,
                repository_verified: probe.repository_verified,
                detail: Some(format!(
                    "{}; repository access verified",
                    probe
                        .git_version
                        .unwrap_or_else(|| "Git available".to_string())
                )),
            },
            Err(error) => LoopxWorkspacePreview {
                disposition: LoopxWorkspaceDisposition::Unavailable,
                path: None,
                repository_verified: false,
                detail: Some(error.to_string()),
            },
        };
        let fingerprint = build_intake_fingerprint(
            &resolved.target,
            &resolved.candidates,
            None,
            &model.model_id,
            &scopes,
        );
        let preview_resolved_at = if resolved.resolved_at > 0 {
            resolved.resolved_at
        } else {
            now_ms()
        };
        let expires_at = preview_resolved_at.saturating_add(INTAKE_PREVIEW_TTL_MS);
        let preview = LoopxIntakePreview {
            fingerprint: fingerprint.clone(),
            target: resolved.target,
            repository: resolved.repository,
            workspace,
            candidates: resolved.candidates,
            truncated: resolved.truncated,
            model,
            permission_scopes: scopes,
            resolved_at: preview_resolved_at,
            expires_at: Some(expires_at),
        };
        let mut previews = self.previews.write().await;
        prune_intake_previews(&mut previews, now_ms());
        previews.insert(fingerprint, preview.clone());
        prune_intake_previews(&mut previews, now_ms());
        Ok(LoopxResolveIntakeResponse { preview })
    }

    pub async fn create_tasks(
        self: &Arc<Self>,
        request: LoopxCreateTaskRequest,
    ) -> Result<LoopxCreateTaskResponse, String> {
        self.ensure_writable().await?;
        if request.client_request_id.trim().is_empty() {
            return Err("clientRequestId is required".to_string());
        }
        if self.state.read().await.suspended {
            return Err("LoopX is stopped; resume the suite before creating tasks".to_string());
        }
        let selected = request
            .selected_items
            .iter()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        if selected.is_empty() {
            return Err("Select at least one issue or pull request".to_string());
        }
        {
            let state = self.state.read().await;
            if state.has_processed_request(&request.client_request_id) {
                return Ok(LoopxCreateTaskResponse {
                    outcomes: existing_outcomes(&state, &selected),
                    snapshot_revision: state.revision,
                });
            }
        }
        let preview = match {
            let mut previews = self.previews.write().await;
            prune_intake_previews(&mut previews, now_ms());
            previews.get(&request.preview_fingerprint).cloned()
        } {
            Some(preview) => preview,
            None => {
                let state = self.state.read().await;
                if state.has_processed_request(&request.client_request_id) {
                    return Ok(LoopxCreateTaskResponse {
                        outcomes: existing_outcomes(&state, &selected),
                        snapshot_revision: state.revision,
                    });
                }
                return Err("Intake preview is missing or stale; resolve it again".to_string());
            }
        };
        if selected.iter().any(|key| {
            !preview
                .candidates
                .iter()
                .any(|candidate| &candidate.key == key)
        }) {
            return Err("Selected item was not present in the intake preview".to_string());
        }
        if preview.workspace.disposition == LoopxWorkspaceDisposition::Unavailable
            || !preview.workspace.repository_verified
        {
            return Err(preview.workspace.detail.clone().unwrap_or_else(|| {
                "The repository workspace did not pass live Git verification".to_string()
            }));
        }
        if !preview.model.available {
            return Err(preview
                .model
                .detail
                .clone()
                .unwrap_or_else(|| "The selected Agent model is unavailable".to_string()));
        }
        if request.granted_scopes.iter().any(|scope| {
            !preview.permission_scopes.contains(scope) || !intake_scope_is_pregrantable(*scope)
        }) {
            return Err("Intake includes a permission scope that was not previewed".to_string());
        }
        if !required_permission_scopes_are_granted(&request.granted_scopes) {
            return Err(
                "All LoopX permission scopes shown in intake are required for an autonomous issue-fix task"
                    .to_string(),
            );
        }

        let _mutation = self.mutation_lock.lock().await;
        let mut state = self.state.write().await;
        let start_cursor = state.cursor;
        if state.has_processed_request(&request.client_request_id) {
            return Ok(LoopxCreateTaskResponse {
                outcomes: existing_outcomes(&state, &selected),
                snapshot_revision: state.revision,
            });
        }
        let existing = state
            .tasks
            .iter()
            .map(|task| LoopxExistingTask {
                task_id: task.task_id.clone(),
                identity: task.identity.clone(),
                state: task.state,
            })
            .collect::<Vec<_>>();
        let batch_id = (selected.len() > 1).then(|| uuid::Uuid::new_v4().to_string());
        let now = now_ms();
        let mut outcomes = Vec::new();
        let mut created_task_ids = Vec::new();
        for key in selected {
            let candidate = preview
                .candidates
                .iter()
                .find(|candidate| candidate.key == key)
                .expect("selected candidates were validated before mutation");
            match decide_task_dedup(&key, candidate.state, &existing, request.retry_terminal) {
                LoopxDedupDecision::OpenExisting { task_id } => {
                    outcomes.push(LoopxCreateTaskOutcome {
                        item: key,
                        kind: LoopxCreateTaskOutcomeKind::OpenedExisting,
                        task_id: Some(task_id),
                        ..LoopxCreateTaskOutcome::default()
                    })
                }
                LoopxDedupDecision::RequireExplicitRetry {
                    previous_task_id,
                    next_attempt,
                } => outcomes.push(LoopxCreateTaskOutcome {
                    item: key,
                    kind: LoopxCreateTaskOutcomeKind::RetryConfirmationRequired,
                    task_id: Some(previous_task_id),
                    attempt: Some(next_attempt),
                    ..LoopxCreateTaskOutcome::default()
                }),
                LoopxDedupDecision::ClosedNoop => outcomes.push(LoopxCreateTaskOutcome {
                    item: key,
                    kind: LoopxCreateTaskOutcomeKind::ClosedNoop,
                    ..LoopxCreateTaskOutcome::default()
                }),
                LoopxDedupDecision::NeedsLiveVerification => {
                    outcomes.push(LoopxCreateTaskOutcome {
                        item: key,
                        kind: LoopxCreateTaskOutcomeKind::NeedsLiveVerification,
                        ..LoopxCreateTaskOutcome::default()
                    })
                }
                LoopxDedupDecision::CreateAttempt { attempt } => {
                    let task_id = uuid::Uuid::new_v4().to_string();
                    let operation_id = format!("prepare-{task_id}-1");
                    let task = LoopxTaskSnapshot {
                        task_id: task_id.clone(),
                        batch_id: batch_id.clone(),
                        identity: LoopxTaskIdentity {
                            item: key.clone(),
                            attempt,
                            title: candidate.title.clone(),
                            description: candidate.description.clone(),
                            state: candidate.state,
                            labels: candidate.labels.clone(),
                        },
                        generation: 1,
                        revision: 1,
                        agent_id: Some(DEFAULT_AGENT_ID.to_string()),
                        state: LoopxTaskState::Preparing,
                        phase: LoopxPhase::PreparingWorkspace,
                        model_id: Some(request.model_id.clone()),
                        granted_scopes: request.granted_scopes.clone(),
                        created_at: now,
                        updated_at: now,
                        ..LoopxTaskSnapshot::default()
                    };
                    state.runtime.insert(
                        task_id.clone(),
                        LoopxTaskRuntimeRecord {
                            operation_id,
                            ..LoopxTaskRuntimeRecord::default()
                        },
                    );
                    state.tasks.push(task);
                    state.revision = state.revision.saturating_add(1);
                    state.append_event(LoopxEvent {
                        task_id: Some(task_id.clone()),
                        generation: Some(1),
                        revision: Some(1),
                        kind: LoopxEventKind::TaskCreated,
                        source: LoopxEventSource::Controller,
                        phase: Some(LoopxPhase::PreparingWorkspace),
                        message: "LoopX task reserved before workspace preparation".to_string(),
                        important: true,
                        occurred_at: now,
                        ..LoopxEvent::default()
                    });
                    outcomes.push(LoopxCreateTaskOutcome {
                        item: key,
                        kind: LoopxCreateTaskOutcomeKind::Created,
                        task_id: Some(task_id.clone()),
                        attempt: Some(attempt),
                        ..LoopxCreateTaskOutcome::default()
                    });
                    created_task_ids.push(task_id);
                }
            }
        }
        state.record_processed_request(request.client_request_id);
        let snapshot_revision = state.revision;
        let persisted = state.clone();
        drop(state);
        self.store.save(&persisted).await?;
        drop(_mutation);
        self.broadcast_new_events(&persisted, start_cursor);

        // Enqueue only the first created task per repository. The rest stay
        // Preparing/Queued and are chained by schedule_next_for_repository
        // after each settlement, keeping execution order deterministic
        // (creation order) instead of letting concurrent drives race for the
        // repository slot (which could start the last-created task first).
        let mut enqueued_repositories: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        for task_id in &created_task_ids {
            let repository_id = {
                let state = self.state.read().await;
                match state.tasks.iter().find(|task| &task.task_id == task_id) {
                    Some(task) => task.identity.item.repository.canonical_id(),
                    None => continue,
                }
            };
            if !enqueued_repositories.insert(repository_id) {
                continue;
            }
            self.enqueue_task(task_id.clone(), Duration::ZERO)?;
        }
        Ok(LoopxCreateTaskResponse {
            outcomes,
            snapshot_revision,
        })
    }

    pub async fn action(
        self: &Arc<Self>,
        request: LoopxActionRequest,
    ) -> Result<LoopxActionResponse, String> {
        self.ensure_writable().await?;
        if request.action == LoopxActionKind::RetryEnvironment {
            self.refresh_environment().await?;
            return Ok(LoopxActionResponse {
                current_revision: self.state.read().await.revision,
                ..LoopxActionResponse::default()
            });
        }
        if request.action == LoopxActionKind::InstallLoopx {
            return self.start_loopx_install(&request).await;
        }
        if request.action == LoopxActionKind::ResumeRepository {
            return self.resume_repository(&request).await;
        }
        if request.action == LoopxActionKind::ResetAll {
            return self.reset_all(&request).await;
        }
        if request.action == LoopxActionKind::PauseAll {
            return self.pause_all(&request).await;
        }
        if request.action == LoopxActionKind::ResumeAll {
            return self.resume_all(&request).await;
        }
        if request.action == LoopxActionKind::Unsupported {
            return Err("Unsupported LoopX action".to_string());
        }
        let task_id = request
            .task_id
            .clone()
            .ok_or_else(|| "taskId is required".to_string())?;
        let (task, runtime) = {
            let state = self.state.read().await;
            if state.has_processed_request(&request.client_request_id) {
                return Ok(LoopxActionResponse {
                    status: LoopxActionStatus::Duplicate,
                    current_revision: state.revision,
                    task: state
                        .tasks
                        .iter()
                        .find(|task| task.task_id == task_id)
                        .cloned(),
                    ..LoopxActionResponse::default()
                });
            }
            let task = state
                .tasks
                .iter()
                .find(|task| task.task_id == task_id)
                .cloned()
                .ok_or_else(|| "LoopX task not found".to_string())?;
            if request.action == LoopxActionKind::Resume
                && matches!(
                    task.state,
                    LoopxTaskState::Preparing | LoopxTaskState::Queued | LoopxTaskState::Running
                )
            {
                return Ok(LoopxActionResponse {
                    status: LoopxActionStatus::Duplicate,
                    current_revision: task.revision,
                    task: Some(task),
                    message: Some("Task is already queued or running".to_string()),
                });
            }
            if task.revision != request.expected_revision {
                return Ok(LoopxActionResponse {
                    status: LoopxActionStatus::RevisionConflict,
                    current_revision: task.revision,
                    task: Some(task),
                    message: Some("Task changed; refresh before applying the action".to_string()),
                });
            }
            (
                task,
                state.runtime.get(&task_id).cloned().unwrap_or_default(),
            )
        };

        match request.action {
            LoopxActionKind::Pause => {
                self.pause_task(&task, &runtime, &request.client_request_id)
                    .await
            }
            LoopxActionKind::Abort => {
                self.abort_task(&task, &runtime, &request.client_request_id)
                    .await
            }
            LoopxActionKind::Resume => self.resume_task(&task, &request.client_request_id).await,
            LoopxActionKind::ResumeRepository
            | LoopxActionKind::ResetAll
            | LoopxActionKind::PauseAll
            | LoopxActionKind::ResumeAll
            | LoopxActionKind::InstallLoopx => unreachable!(),
            LoopxActionKind::Approve | LoopxActionKind::Reject => {
                self.answer_gate(&task, &runtime, &request).await
            }
            LoopxActionKind::Archive => {
                let response = self
                    .transition_action(
                        &task_id,
                        LoopxTaskState::Archived,
                        LoopxPhase::Finished,
                        &request.client_request_id,
                    )
                    .await?;
                // Explicit user action: archive is the only workflow that
                // destroys the task worktree (and its bare repository when
                // the last worktree is gone). Terminal states keep their
                // worktrees so the user can inspect agent output first.
                self.dispose_task_workspace(&task).await;
                Ok(response)
            }
            LoopxActionKind::Restore => {
                self.transition_action(
                    &task_id,
                    LoopxTaskState::RecoveryRequired,
                    LoopxPhase::Recovering,
                    &request.client_request_id,
                )
                .await
            }
            LoopxActionKind::RetryEnvironment | LoopxActionKind::Unsupported => unreachable!(),
        }
    }

    async fn start_loopx_install(
        self: &Arc<Self>,
        request: &LoopxActionRequest,
    ) -> Result<LoopxActionResponse, String> {
        let started_at = Instant::now();
        if request.client_request_id.trim().is_empty() {
            return Err("clientRequestId is required".to_string());
        }
        {
            let state = self.state.read().await;
            if state.has_processed_request(&request.client_request_id) {
                return Ok(LoopxActionResponse {
                    status: LoopxActionStatus::Duplicate,
                    current_revision: state.revision,
                    message: Some("LoopX installation request was already applied".to_string()),
                    ..LoopxActionResponse::default()
                });
            }
            if state.environment.core.sidecar.status == LoopxEnvironmentFactStatus::Available {
                return Ok(LoopxActionResponse {
                    status: LoopxActionStatus::Duplicate,
                    current_revision: state.revision,
                    message: Some("A compatible LoopX runtime is already available".to_string()),
                    ..LoopxActionResponse::default()
                });
            }
        }
        if self
            .install_in_progress
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Ok(LoopxActionResponse {
                status: LoopxActionStatus::Duplicate,
                current_revision: self.state.read().await.revision,
                message: Some("LoopX installation is already running".to_string()),
                ..LoopxActionResponse::default()
            });
        }
        let current_revision = match self.mark_loopx_installing(&request.client_request_id).await {
            Ok(revision) => revision,
            Err(error) => {
                self.install_in_progress.store(false, Ordering::Release);
                return Err(error);
            }
        };
        log::info!(
            "LoopX installation state persisted: request_id={}, revision={}, duration_ms={}",
            request.client_request_id,
            current_revision,
            elapsed_ms_u64(started_at)
        );
        let request_id = request.client_request_id.clone();
        let controller = Arc::clone(self);
        tokio::spawn(async move {
            let _install_guard = InProgressGuard(&controller.install_in_progress);
            log::info!("LoopX installation background task started: request_id={request_id}");
            if let Err(error) = controller.run_loopx_install(&request_id).await {
                log::error!(
                    "LoopX managed source installation failed: request_id={request_id}, error={error}"
                );
                let _ = controller.mark_loopx_install_failed(&error).await;
            }
        });
        Ok(LoopxActionResponse {
            status: LoopxActionStatus::Applied,
            current_revision,
            message: Some("LoopX installation started".to_string()),
            ..LoopxActionResponse::default()
        })
    }

    async fn run_loopx_install(self: &Arc<Self>, request_id: &str) -> Result<(), String> {
        let progress = BufferedProgress::default();
        let operation_id = format!("install-loopx-{}", uuid::Uuid::new_v4());
        let started_at = Instant::now();
        log::info!(
            "LoopX installation service call started: request_id={request_id}, operation_id={operation_id}"
        );
        let result = self
            .cli
            .install_managed_source(
                LoopxCliInstallManagedSourceRequest {
                    call: LoopxCliCallContext {
                        operation_id: operation_id.clone(),
                        deadline_at: None,
                    },
                },
                &progress,
            )
            .await;
        self.record_progress(progress.take()).await?;
        let installed = result.map_err(|error| error.to_string())?;
        log::info!(
            "LoopX installation service call completed: request_id={request_id}, operation_id={operation_id}, version={}, source={}, commit={}, duration_ms={}",
            installed.loopx_version,
            installed.source_repository,
            installed.source_commit,
            elapsed_ms_u64(started_at)
        );
        self.refresh_environment().await?;
        Ok(())
    }

    async fn mark_loopx_installing(&self, request_id: &str) -> Result<u64, String> {
        let _mutation = self.mutation_lock.lock().await;
        let mut state = self.state.write().await;
        let checked_at = Some(now_ms());
        state.environment.revision = state.environment.revision.saturating_add(1);
        state.environment.status = LoopxEnvironmentStatus::Checking;
        state.environment.checked_at = checked_at;
        state.environment.core.sidecar = LoopxEnvironmentFact {
            status: LoopxEnvironmentFactStatus::Checking,
            version: Some(LOOPX_PINNED_VERSION.to_string()),
            detail: Some("Downloading runtime files from the official GitHub source".to_string()),
            checked_at,
            ..LoopxEnvironmentFact::default()
        };
        state.record_processed_request(request_id.to_string());
        state.revision = state.revision.saturating_add(1);
        let current_revision = state.revision;
        let start_cursor = state.cursor;
        state.append_event(LoopxEvent {
            kind: LoopxEventKind::EnvironmentChanged,
            source: LoopxEventSource::System,
            message: "LoopX managed source installation started".to_string(),
            occurred_at: now_ms(),
            ..LoopxEvent::default()
        });
        let persisted = state.clone();
        drop(state);
        self.store.save(&persisted).await?;
        self.broadcast_new_events(&persisted, start_cursor);
        Ok(current_revision)
    }

    async fn mark_loopx_install_failed(&self, error: &str) -> Result<(), String> {
        let _mutation = self.mutation_lock.lock().await;
        let mut state = self.state.write().await;
        let checked_at = Some(now_ms());
        state.environment.revision = state.environment.revision.saturating_add(1);
        state.environment.status = LoopxEnvironmentStatus::Blocked;
        state.environment.checked_at = checked_at;
        state.environment.core.sidecar = unavailable_loopx_environment_fact(error, checked_at);
        state.revision = state.revision.saturating_add(1);
        let start_cursor = state.cursor;
        state.append_event(LoopxEvent {
            kind: LoopxEventKind::EnvironmentChanged,
            level: LoopxEventLevel::Error,
            source: LoopxEventSource::System,
            message: format!("LoopX managed source installation failed: {error}"),
            important: true,
            occurred_at: now_ms(),
            ..LoopxEvent::default()
        });
        let persisted = state.clone();
        drop(state);
        self.store.save(&persisted).await?;
        self.broadcast_new_events(&persisted, start_cursor);
        Ok(())
    }

    pub async fn handle_agent_terminal(
        self: &Arc<Self>,
        turn_id: &str,
        status: LoopxAgentTurnStatus,
        summary: Option<String>,
        blocks_repository: bool,
    ) -> Result<(), String> {
        let (task, runtime) = {
            let state = self.state.read().await;
            let Some((task_id, runtime)) = state
                .runtime
                .iter()
                .find(|(_, runtime)| runtime.agent_turn_id.as_deref() == Some(turn_id))
            else {
                return Ok(());
            };
            let Some(task) = state.tasks.iter().find(|task| &task.task_id == task_id) else {
                return Ok(());
            };
            (task.clone(), runtime.clone())
        };
        if task.state != LoopxTaskState::Running {
            return Ok(());
        }
        log::info!(
            "LoopX Agent terminal handling started: task_id={}, goal_id={}, agent_turn_id={}, status={:?}",
            task.task_id,
            task.goal_id.as_deref().unwrap_or("unknown"),
            turn_id,
            status
        );
        if let Some(summary) = summary
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let bounded = bounded_agent_summary(summary);
            let structured = parse_structured_summary(Some(summary));
            self.mutate_task(&task.task_id, None, |current, _| {
                if current.generation != task.generation {
                    return;
                }
                current.last_agent_summary = Some(bounded);
                current.structured_summary = structured;
                current.last_agent_summary_at = Some(now_ms());
                current.revision = current.revision.saturating_add(1);
            })
            .await?;
        }
        self.update_task_phase(
            &task.task_id,
            task.generation,
            LoopxPhase::ValidatingProgress,
            "Agent turn ended; verifying LoopX-owned durable settlement",
        )
        .await?;
        let progress = BufferedProgress::default();
        let settlement_started = Instant::now();
        let result = self
            .cli
            .verify_turn_settlement(
                LoopxCliSettleTurnRequest {
                    context: self.goal_context(&task, &runtime),
                    goal_id: task.goal_id.clone().unwrap_or_default(),
                    agent_id: task
                        .agent_id
                        .clone()
                        .unwrap_or_else(|| DEFAULT_AGENT_ID.to_string()),
                    turn_id: runtime.loopx_turn_id.clone().unwrap_or_default(),
                    settlement_token: runtime.settlement_token.clone().unwrap_or_default(),
                    expected_durable_revision: runtime
                        .expected_durable_revision
                        .clone()
                        .unwrap_or_default(),
                    agent_status: status,
                },
                &progress,
            )
            .await;
        match &result {
            Ok(settlement) => log::info!(
                "LoopX turn settlement completed: task_id={}, goal_id={}, loopx_turn_id={}, status={:?}, duration_ms={}",
                task.task_id,
                task.goal_id.as_deref().unwrap_or("unknown"),
                settlement.turn_id,
                settlement.status,
                settlement_started.elapsed().as_millis(),
            ),
            Err(error) => log::warn!(
                "LoopX turn settlement failed: task_id={}, goal_id={}, duration_ms={}, error={}",
                task.task_id,
                task.goal_id.as_deref().unwrap_or("unknown"),
                settlement_started.elapsed().as_millis(),
                error
            ),
        }
        self.record_progress(progress.take()).await?;
        // Codex-parity session policy: the agent session is NOT discarded
        // unconditionally after a turn. `apply_settlement` decides from the
        // final task state whether the goal's live agent session is kept for
        // the next turn (the same conversation continues, mirroring how the
        // LoopX codex host resumes `codex exec` sessions across turns of one
        // goal) or discarded. Only a settlement-verification failure discards
        // it here, because the task fails outright in that path.
        match result {
            Err(error) => {
                self.discard_agent_session(&task, &runtime).await;
                self.fail_task(&task.task_id, error.to_string()).await
            }
            Ok(settlement) => {
                self.apply_settlement(
                    &task,
                    settlement,
                    status,
                    summary.as_deref(),
                    blocks_repository,
                )
                .await
            }
        }
    }

    pub(super) async fn handle_agent_activity(&self, turn_id: &str) -> Result<(), String> {
        let task_id = {
            let state = self.state.read().await;
            state
                .runtime
                .iter()
                .find(|(_, runtime)| runtime.agent_turn_id.as_deref() == Some(turn_id))
                .map(|(task_id, _)| task_id.clone())
        };
        let Some(task_id) = task_id else {
            return Ok(());
        };
        self.mutate_task(&task_id, None, |task, _| {
            if task.state != LoopxTaskState::Running {
                return;
            }
            task.last_output_at = Some(now_ms());
            task.revision = task.revision.saturating_add(1);
        })
        .await?;
        Ok(())
    }

    pub(super) async fn handle_agent_tool_activity(
        &self,
        turn_id: &str,
        activity: ToolActivityProjection,
    ) -> Result<(), String> {
        let _mutation = self.mutation_lock.lock().await;
        let mut state = self.state.write().await;
        let Some(task_id) = state
            .runtime
            .iter()
            .find(|(_, runtime)| runtime.agent_turn_id.as_deref() == Some(turn_id))
            .map(|(task_id, _)| task_id.clone())
        else {
            return Ok(());
        };
        let Some(task_index) = state.tasks.iter().position(|task| task.task_id == task_id) else {
            return Ok(());
        };
        if state.tasks[task_index].state != LoopxTaskState::Running {
            return Ok(());
        }

        let now = now_ms();
        {
            let task = &mut state.tasks[task_index];
            task.last_output_at = Some(now);
            task.updated_at = now;
            task.current_tool = activity.current_tool.clone();
            task.revision = task.revision.saturating_add(1);
        }
        let updated = state.tasks[task_index].clone();
        state.revision = state.revision.saturating_add(1);
        state.append_event(LoopxEvent {
            task_id: Some(updated.task_id.clone()),
            generation: Some(updated.generation),
            revision: Some(updated.revision),
            kind: LoopxEventKind::Log,
            level: if activity.important {
                LoopxEventLevel::Error
            } else {
                LoopxEventLevel::Info
            },
            source: LoopxEventSource::Agent,
            phase: Some(updated.phase),
            message: activity.message,
            important: activity.important,
            tool_name: Some(activity.tool_name),
            details: activity.details,
            occurred_at: now,
            ..LoopxEvent::default()
        });
        let persisted = state.clone();
        let event = persisted.events.last().cloned();
        drop(state);
        self.store.save(&persisted).await?;
        if let Some(event) = event {
            let _ = self.event_sender.send(event);
        }
        Ok(())
    }

    async fn drive_task(self: &Arc<Self>, task_id: String) -> Result<(), String> {
        if self.state.read().await.suspended {
            // Suite is stopped: leave the task parked in its queue slot. The
            // resume path re-enqueues parked tasks.
            return Ok(());
        }
        let task = self.task(&task_id).await?;
        if !matches!(
            task.state,
            LoopxTaskState::Preparing | LoopxTaskState::Queued
        ) {
            return Ok(());
        }
        if !self.reserve_repository(&task).await {
            self.transition_task(
                &task_id,
                task.generation,
                LoopxTaskState::Queued,
                LoopxPhase::Queued,
                "Another task for this repository is running",
            )
            .await?;
            return Ok(());
        }
        // The goal binding survives restarts, but the workspace directory
        // may not (removed by a concurrent instance, a reset, or manual
        // cleanup). A deleted worktree also loses its `.loopx/registry.json`,
        // so re-running prepare alone would leave the goal disconnected from
        // a fresh project registry. Unbind first; the prepare + plan_item +
        // create_goal flow below re-adds the worktree and reconnects the same
        // deterministic goal id, and the frontier (including pending gates)
        // resurfaces from LoopX.
        if task_has_bound_goal(&task) && bound_workspace_missing(&task) {
            log::warn!(
                "LoopX bound workspace is missing, re-preparing and reconnecting the goal: task_id={} goal={} path={}",
                task.task_id,
                task.goal_id.as_deref().unwrap_or("-"),
                task.workspace_path.as_deref().unwrap_or("-"),
            );
            self.mutate_task(&task_id, None, |current, current_runtime| {
                if current.generation != task.generation {
                    return;
                }
                current.goal_id = None;
                current.goal_state = None;
                current.pending_gate_id = None;
                current.pending_gate_message = None;
                current.pending_gate_action_kind = None;
                current.current_turn_id = None;
                current.current_tool = None;
                current.current_todo = None;
                current.settlement = LoopxSettlementSummary::default();
                current.revision = current.revision.saturating_add(1);
                current_runtime.expected_durable_revision = None;
                current_runtime.loopx_turn_id = None;
                current_runtime.settlement_token = None;
                current_runtime.session_id = None;
                current_runtime.agent_turn_id = None;
            })
            .await?;
        }
        let workspace_result = self
            .workspace
            .prepare(LoopxWorkspacePrepareRequest {
                operation_id: format!("workspace-{}-{}", task.task_id, task.generation),
                task_id: task.task_id.clone(),
                item: task.identity.item.clone(),
            })
            .await;
        let workspace = workspace_result.map_err(|error| error.to_string())?;
        if !workspace.repository_verified {
            return Err("Prepared worktree does not match the requested repository".to_string());
        }
        self.bind_workspace(&task_id, task.generation, &workspace)
            .await?;
        let task = self.task(&task_id).await?;
        if task_has_bound_goal(&task) {
            return self.drive_turn(task_id).await;
        }
        let runtime = self.runtime(&task_id).await;
        let progress = BufferedProgress::default();
        let intake = self
            .cli
            .plan_item(
                LoopxCliPlanItemRequest {
                    context: self.goal_context(&task, &runtime),
                    item: task.identity.item.clone(),
                    title: task.identity.title.clone(),
                    state: task.identity.state,
                    labels: task.identity.labels.clone(),
                },
                &progress,
            )
            .await
            .map_err(|error| error.to_string())?;
        self.record_progress(progress.take()).await?;
        let goal_id = goal_id_for(&task.identity);
        let progress = BufferedProgress::default();
        let created = self
            .cli
            .create_goal(
                LoopxCliCreateGoalRequest {
                    context: self.goal_context(&task, &runtime),
                    goal_id: goal_id.clone(),
                    agent_id: task
                        .agent_id
                        .clone()
                        .unwrap_or_else(|| DEFAULT_AGENT_ID.to_string()),
                    intake,
                    granted_scopes: task.granted_scopes.clone(),
                },
                &progress,
            )
            .await
            .map_err(|error| error.to_string())?;
        self.record_progress(progress.take()).await?;
        let created_goal_id = created.goal_id.clone();
        self.bind_goal(&task_id, task.generation, created).await?;
        log::info!(
            "LoopX goal created: task_id={} goal={} agent={} worktree={}",
            task_id,
            created_goal_id,
            task.agent_id.as_deref().unwrap_or("bitfun-agent"),
            task.workspace_path.as_deref().unwrap_or("-"),
        );
        self.drive_turn(task_id).await
    }

    /// Mirrors a terminal state already reported by the authoritative LoopX
    /// Goal and advances the next task in the repository queue.
    async fn complete_projected_goal(
        self: &Arc<Self>,
        task: &LoopxTaskSnapshot,
        message: &str,
    ) -> Result<(), String> {
        let updated = self
            .transition_task(
                &task.task_id,
                task.generation,
                LoopxTaskState::Completed,
                LoopxPhase::Finished,
                message,
            )
            .await?;
        self.record_current_todo(&updated.task_id, updated.generation, None)
            .await?;
        self.schedule_next_for_repository(
            &updated.identity.item.repository.canonical_id(),
            Some(&updated.task_id),
        )
        .await;
        Ok(())
    }

    async fn drive_turn(self: &Arc<Self>, task_id: String) -> Result<(), String> {
        let task = self.task(&task_id).await?;
        let runtime = self.runtime(&task_id).await;
        let progress = BufferedProgress::default();
        let inspected = self
            .cli
            .inspect_goal(
                LoopxCliInspectGoalRequest {
                    context: self.goal_context(&task, &runtime),
                    goal_id: task.goal_id.clone().unwrap_or_default(),
                    agent_id: task
                        .agent_id
                        .clone()
                        .unwrap_or_else(|| DEFAULT_AGENT_ID.to_string()),
                },
                &progress,
            )
            .await
            .map_err(|error| error.to_string())?;
        self.record_progress(progress.take()).await?;
        let selected = inspected.selected_todo.as_ref();
        log::info!(
            "LoopX inspect goal: task_id={} goal={} decision={:?} state={:?} open_todos={} waiting_user={} selected_todo={} selected_kind={} claimed_by={} revision={} cadence={} over_budget={}",
            task.task_id,
            inspected.goal_id,
            inspected.run_decision,
            inspected.state,
            inspected.open_todo_count,
            inspected.waiting_user_todo_count,
            selected.map(|t| t.todo_id.as_str()).unwrap_or("-"),
            selected.map(|t| t.action_kind.as_str()).unwrap_or("-"),
            selected.map(|t| t.claimed_by.as_str()).unwrap_or("-"),
            inspected.durable_revision,
            inspected.scheduler_cadence.as_deref().unwrap_or("-"),
            inspected.envelope_over_budget,
        );
        self.record_goal_state(&task, inspected.state).await?;
        self.record_current_todo(&task_id, task.generation, inspected.selected_todo.clone())
            .await?;
        match inspected.run_decision {
            LoopxCliRunDecision::Wait => {
                if inspected.state == LoopxCliGoalState::Archived {
                    return self
                        .complete_projected_goal(&task, "LoopX Goal was archived")
                        .await;
                }
                self.transition_task(
                    &task_id,
                    task.generation,
                    LoopxTaskState::Queued,
                    LoopxPhase::Queued,
                    "LoopX is waiting before the next bounded turn",
                )
                .await?;
                self.schedule_next_for_repository(
                    &task.identity.item.repository.canonical_id(),
                    Some(&task_id),
                )
                .await;
                // The compacted v1.0.x envelope deliberately carries only
                // cadence labels, not numeric intervals (those live in the
                // quota decision detail), so the host owns translating the
                // label into a concrete requeue delay: an explicit numeric
                // hint wins when a future pin emits one, otherwise the
                // cadence class maps onto the pinned scheduler's own initial
                // interval, and a label-less snapshot falls back to a bounded
                // poll that can never sleep forever.
                let delay = wait_requeue_delay_ms(&inspected);
                log::info!(
                    "LoopX wait requeue: task_id={} goal={} delay_ms={}",
                    task_id,
                    inspected.goal_id,
                    delay,
                );
                self.enqueue_task(task_id, Duration::from_millis(delay))?;
                Ok(())
            }
            LoopxCliRunDecision::WaitingForUser => {
                self.waiting_user_frontier(&task, &runtime, &inspected)
                    .await
            }
            LoopxCliRunDecision::Complete => {
                return self
                    .complete_projected_goal(&task, "LoopX goal completed")
                    .await;
            }
            LoopxCliRunDecision::Failed => {
                self.fail_task(&task_id, "LoopX reported a failed goal".to_string())
                    .await
            }
            LoopxCliRunDecision::RunNow => {
                self.sync_concurrent_user_gate(&task, inspected.pending_user_gate.as_ref())
                    .await?;
                // The contradiction witness is the envelope's own action
                // projection, not the `open_count` scalar: the counter is a
                // claim-scoped summary that can legitimately be zero while
                // `action.selected_todo` still names an open, claimed todo.
                // Only refuse when the envelope itself asserts there is
                // nothing to do; `quota should-run --turn-envelope` remains
                // the authoritative execution gate either way.
                let has_selected_todo = inspected
                    .selected_todo
                    .as_ref()
                    .is_some_and(|todo| !todo.todo_id.is_empty());
                if run_now_is_frontier_contradiction(
                    inspected.open_todo_count,
                    inspected.waiting_user_todo_count,
                    has_selected_todo,
                ) {
                    // Runtime-data correction (2026-09-05 five-issue run,
                    // re-verified against the pinned v1.0.1): the CLI does NOT
                    // treat a todo-less `RunNow` frontier as terminal. When
                    // every todo is done or blocked
                    // and the goal vision is still open, it projects
                    // `should_run=true` plus an autonomous replan obligation
                    // and expects the host to drive one bounded replan turn
                    // bound to that obligation: the agent then writes back a
                    // successor todo, a typed terminal outcome (for example
                    // `coverage_backed_no_followup`, after which the goal
                    // projects Complete), or a concrete blocker. The quota
                    // guard admits exactly that turn and the settlement
                    // validates it by the `autonomous_replan` effect id.
                    // Parking here stranded every task of the five-issue run
                    // before any goal could close.
                    let replan_frontier = todoless_run_now_frontier(
                        inspected.pending_replan_obligation_id.as_deref(),
                    );
                    if replan_frontier == TodolessRunNowFrontier::DriveReplanTurn {
                        log::info!(
                            "LoopX plan exhausted with an open autonomous replan obligation; driving one replan turn: task_id={} goal={} obligation={}",
                            task_id,
                            inspected.goal_id,
                            inspected.pending_replan_obligation_id.as_deref().unwrap_or("-"),
                        );
                        // Fall through to the normal turn build below: the
                        // guard produces the `AutonomousReplan` binding and
                        // the re-entry instruction carries the replan flags.
                    } else {
                        // True contradiction: no open todo, no waiting user
                        // decision, no selected action, and no replan
                        // obligation the CLI would let the host drive. Park
                        // with an explicit reason so the recovery card can
                        // explain the plan is exhausted and guide the owner.
                        // The task keeps its worktree, evidence, and commits,
                        // and the repository slot yields to queued siblings.
                        if task.state == LoopxTaskState::RecoveryRequired
                            && task.recovery_reason.as_deref() == Some(LOOPX_PLAN_EXHAUSTED_REASON)
                        {
                            // Already parked with this exact diagnosis; do not
                            // churn another transition/event on a re-drive.
                            return Ok(());
                        }
                        return self.park_plan_exhausted(&task, &inspected.goal_id).await;
                    }
                }
                // An over-budget envelope no longer gates driving: the
                // continuation authority is the live quota decision (see
                // `quota_probe_args`), which keeps projecting should_run and
                // the selected todo past the 8192-byte compaction budget.
                // The flag stays informational for telemetry.
                if inspected.envelope_over_budget {
                    log::warn!(
                        "LoopX turn envelope is over the compaction budget; continuing from the quota decision: task_id={} goal={}",
                        task.task_id,
                        inspected.goal_id,
                    );
                }
                // User-gated frontier (live 2026-09-09, issue 3): the envelope
                // projects should_run=true through the `agent_with_user_gate`
                // fallback (the agent is asked to surface the owner decision),
                // but no agent work item remains - no selected todo and no
                // replan obligation, so the guard correctly refuses a
                // settlement binding and a turn cannot be built. The BitFun
                // UI already surfaces the gate, so driving a model turn just
                // to repeat the request is waste: park as waiting for the
                // owner instead of failing the task.
                if inspected.selected_todo.is_none()
                    && inspected.pending_replan_obligation_id.is_none()
                    && inspected.waiting_user_todo_count > 0
                {
                    log::info!(
                        "LoopX frontier is user-gated with no agent work item; parking for the owner decision: task_id={} goal={} waiting_user={}",
                        task.task_id,
                        inspected.goal_id,
                        inspected.waiting_user_todo_count,
                    );
                    return self
                        .waiting_user_frontier(&task, &runtime, &inspected)
                        .await;
                }
                if task.state == LoopxTaskState::RecoveryRequired {
                    // Restart-interrupted runs land here; the owner decides
                    // via the explicit recovery action in the UI (nothing
                    // silent, nothing forged, worktree and evidence kept).
                    return Ok(());
                }
                // v1.0.1 owns the monitor cadence itself: a monitor todo is
                // projected RunNow only when its `next_due_at` has passed
                // (`monitor_due`), and an unchanged monitor writeback is
                // rejected unless it advances the schedule. The host must not
                // interpose a second hold clock on top of that decision.
                let progress = BufferedProgress::default();
                let built = self
                    .cli
                    .build_turn(
                        LoopxCliBuildTurnRequest {
                            context: self.goal_context(&task, &runtime),
                            goal_id: task.goal_id.clone().unwrap_or_default(),
                            agent_id: task
                                .agent_id
                                .clone()
                                .unwrap_or_else(|| DEFAULT_AGENT_ID.to_string()),
                            expected_durable_revision: inspected.durable_revision,
                        },
                        &progress,
                    )
                    .await;
                let turn = match built {
                    Ok(turn) => turn,
                    Err(error) if error.kind == LoopxCliErrorKind::Conflict && error.retryable => {
                        // Transient durable-state race: a concurrent bootstrap
                        // or global-registry sync landed between this task's
                        // inspect and its quota guard. The envelope is healthy,
                        // so requeue with a short backoff instead of failing
                        // the host job (mirrors the envelope-over-budget
                        // degradation; the next drive re-reads fresh state).
                        let message = format!(
                            "LoopX durable state changed while building the turn ({}); requeueing with backoff",
                            error.message
                        );
                        log::warn!(
                            "LoopX turn build conflict, requeueing: task_id={} goal={} detail={}",
                            task_id,
                            task.goal_id.as_deref().unwrap_or("-"),
                            error.message
                        );
                        let updated = self
                            .transition_task(
                                &task_id,
                                task.generation,
                                LoopxTaskState::Queued,
                                LoopxPhase::RetryBackoff,
                                &message,
                            )
                            .await?;
                        self.record_progress(progress.take()).await?;
                        self.append_task_event(
                            &updated,
                            LoopxEventKind::StateChanged,
                            &message,
                            false,
                        )
                        .await?;
                        self.schedule_next_for_repository(
                            &task.identity.item.repository.canonical_id(),
                            Some(&task_id),
                        )
                        .await;
                        self.enqueue_task(task_id, Duration::from_millis(TURN_CONFLICT_RETRY_MS))?;
                        return Ok(());
                    }
                    Err(error) => return Err(error.to_string()),
                };
                self.record_progress(progress.take()).await?;
                self.bind_turn(&task, &turn).await?;
                let host_note = self.take_pending_host_note(&task.task_id).await;
                if host_note.is_some() {
                    log::info!(
                        "LoopX host note appended to turn instruction: task_id={}",
                        task.task_id,
                    );
                }
                // The pinned LoopX skill document is seeded into the worktree
                // (`.loopx/pinned-loopx-skill.md`) and the agent is pointed at
                // it; it reads the authoritative skill doc once per session
                // like a LoopX codex-style host, and consults the separate
                // CLI help file on demand.
                let pinned_reference_path = task
                    .workspace_path
                    .as_deref()
                    .map(|workspace| format!("{workspace}\\.loopx\\pinned-loopx-skill.md"));
                let agent_instruction = compose_agent_turn_instruction(
                    turn.agent_instruction,
                    host_note.as_deref(),
                    pinned_reference_path.as_deref(),
                    // A kept session continues the same conversation, so the
                    // reference pointer must not ask for a fresh read.
                    runtime.session_id.is_some(),
                );
                log::info!(
                    "LoopX turn built, starting agent: task_id={} goal={} turn={} deadline_ms={:?} instruction_bytes={}",
                    task.task_id,
                    turn.goal_id,
                    turn.turn_id,
                    turn.deadline_at,
                    agent_instruction.len(),
                );
                let started = self
                    .agent
                    .start(LoopxAgentStartRequest {
                        operation_id: format!("agent-{}-{}", task.task_id, task.generation),
                        task_id: task.task_id.clone(),
                        generation: task.generation,
                        worktree_path: task.workspace_path.clone().unwrap_or_default(),
                        instruction: agent_instruction,
                        model_id: task.model_id.clone().unwrap_or_else(|| "auto".to_string()),
                        granted_scopes: task.granted_scopes.clone(),
                        // Codex-parity: continue the goal's live agent session
                        // when the previous settled turn kept it (the runtime
                        // record clears the id whenever the session is
                        // discarded, and a stale id falls back to a fresh
                        // session inside the port).
                        reuse_session_id: runtime.session_id.clone(),
                        metadata: LoopxAgentTurnMetadata {
                            goal_id: task.goal_id.clone().unwrap_or_default(),
                            loopx_turn_id: turn.turn_id,
                            item: task.identity.item.clone(),
                            attempt: task.identity.attempt,
                        },
                    })
                    .await
                    .map_err(|error| error.to_string())?;
                self.bind_agent_run(&task, started).await
            }
        }
    }

    /// Handles a frontier whose next unlock is an owner decision: either a
    /// typed user gate (approval card, with read-only/reuse-merge
    /// auto-answers) or an owner action outside the host (external review
    /// queue). Reached both from the explicit `WaitingForUser` decision and
    /// from the user-gated `RunNow` fallback that has no agent work item.
    async fn waiting_user_frontier(
        self: &Arc<Self>,
        task: &LoopxTaskSnapshot,
        runtime: &LoopxTaskRuntimeRecord,
        inspected: &LoopxCliGoalSnapshot,
    ) -> Result<(), String> {
        let task_id = task.task_id.clone();
        let task_generation = task.generation;
        let repository_id = task.identity.item.repository.canonical_id();
        let Some(gate) = inspected.pending_user_gate.clone() else {
            // Owner action outside the host (live 2026-09-08, issue 2: the
            // agent opened PR #4 and LoopX projected the owner review/merge
            // queue as an open user todo without a typed user_gate). Park as
            // waiting: no approval card, the owner acts on the external
            // surface, the slot yields.
            return self
                .park_waiting_owner_action(task, inspected.waiting_user_summary.as_deref())
                .await;
        };
        if is_read_only_user_gate(gate.action_kind.as_deref()) {
            match self
                .auto_answer_gate(
                    &task,
                    &runtime,
                    &gate,
                    LoopxCliGateDecision::Approve,
                    "Auto-approved by BitFun: read-only public issue metadata access.".to_string(),
                    format!(
                        "Read-only user gate auto-approved by BitFun: {}",
                        gate.message
                    ),
                )
                .await
            {
                Ok(()) => return Ok(()),
                Err(error) => {
                    // Interactive approval stays available as the
                    // fallback when the automatic answer fails.
                    log::warn!(
                        "LoopX read-only gate auto-approval failed, falling back to interactive approval: task_id={} gate={} error={}",
                        task.task_id,
                        gate.gate_id,
                        error
                    );
                }
            }
        }
        if is_reuse_merge_user_gate(gate.action_kind.as_deref(), &gate.message) {
            let repository = task.identity.item.repository.clone();
            match self
                .cli
                .viewer_merge_authority(&self.goal_context(&task, &runtime), &repository)
                .await
            {
                // Authority confirmed or unknown: leave the decision
                // to the owner.
                Ok(Some(true)) | Ok(None) => {}
                Ok(Some(false)) => {
                    let pr_label = reuse_merge_pr_label(&gate.message);
                    match self
                        .auto_answer_gate(
                            &task,
                            &runtime,
                            &gate,
                            LoopxCliGateDecision::Reject,
                            format!(
                                "Auto-rejected by BitFun: the authenticated GitHub identity has no merge authority for {}; the agent must propose an alternative route (track the upstream PR, or an independent patch).",
                                repository.label()
                            ),
                            format!(
                                "Merge gate auto-rejected: no merge authority for {} ({}); the agent will need an alternative route",
                                repository.label(),
                                pr_label
                            ),
                        )
                        .await
                    {
                        Ok(()) => return Ok(()),
                        Err(error) => log::warn!(
                            "LoopX merge-gate auto-reject failed, falling back to interactive: task_id={} gate={} error={}",
                            task.task_id,
                            gate.gate_id,
                            error
                        ),
                    }
                }
                Err(error) => {
                    log::warn!(
                        "LoopX merge authority probe failed, surfacing gate interactively: task_id={} gate={} error={}",
                        task.task_id,
                        gate.gate_id,
                        error
                    );
                }
            }
        }
        let LoopxCliUserGate {
            gate_id,
            message,
            action_kind,
        } = gate;
        let durable_revision = inspected.durable_revision.clone();
        let updated = self
            .mutate_task(&task_id, None, |current, current_runtime| {
                if current.generation != task.generation {
                    return;
                }
                current.state = LoopxTaskState::WaitingForUser;
                current.phase = LoopxPhase::WaitingForApproval;
                current.pending_gate_id = Some(gate_id.clone());
                current.pending_gate_message = Some(message.clone());
                current.pending_gate_action_kind = action_kind.clone();
                current.revision = current.revision.saturating_add(1);
                current_runtime.expected_durable_revision = Some(durable_revision.clone());
            })
            .await?;
        let mut details = BTreeMap::new();
        details.insert("gateId".to_string(), gate_id.clone());
        if let Some(action_kind) = action_kind.clone() {
            details.insert("actionKind".to_string(), action_kind);
        }
        self.append_task_event_with_details(
            &updated,
            LoopxEventKind::ApprovalRequired,
            &message,
            true,
            details,
        )
        .await?;
        self.schedule_next_for_repository(
            &task.identity.item.repository.canonical_id(),
            Some(&task_id),
        )
        .await;
        Ok(())
    }

    /// Best-effort discard of a task's live agent session: clears the
    /// runtime record's session binding (so the next started turn opens a
    /// fresh transient session instead of trying to reuse a discarded one)
    /// and tears the session itself down. Failures are logged only; LoopX
    /// durable state is never affected by host-side session hygiene.
    async fn discard_agent_session(
        self: &Arc<Self>,
        task: &LoopxTaskSnapshot,
        runtime: &LoopxTaskRuntimeRecord,
    ) {
        let Some(session_id) = runtime.session_id.clone() else {
            return;
        };
        let generation = task.generation;
        let _ = self
            .mutate_task(&task.task_id, None, |current, runtime| {
                if current.generation != generation {
                    return;
                }
                runtime.session_id = None;
            })
            .await;
        let finish_result = self
            .agent
            .finish(LoopxAgentFinishRequest {
                operation_id: format!("finish-agent-{}", uuid::Uuid::new_v4()),
                task_id: task.task_id.clone(),
                generation: task.generation,
                worktree_path: task.workspace_path.clone().unwrap_or_default(),
                session_id,
                turn_id: runtime.agent_turn_id.clone().unwrap_or_default(),
            })
            .await;
        match &finish_result {
            Ok(finish) => log::info!(
                "LoopX transient Agent session finished: task_id={}, session_id={}, discarded={}",
                task.task_id,
                finish.session_id,
                finish.discarded
            ),
            Err(error) => log::warn!(
                "LoopX transient Agent session cleanup failed: task_id={}, error={}",
                task.task_id,
                error
            ),
        }
    }

    /// Best-effort teardown of a task's agent run (cancel then finish). A stale
    /// session — for example one persisted before a host restart — must not
    /// abort pause or reset. The local record owns only host-job cleanup; LoopX
    /// remains authoritative for Goal lifecycle, so teardown failures are
    /// logged and the operator action continues.
    async fn teardown_agent_run(
        self: &Arc<Self>,
        task: &LoopxTaskSnapshot,
        runtime: &LoopxTaskRuntimeRecord,
    ) {
        let (Some(session_id), Some(turn_id)) =
            (runtime.session_id.as_ref(), runtime.agent_turn_id.as_ref())
        else {
            return;
        };
        // The session is being torn down: drop the record binding too, so a
        // later requeue cannot hand the stale id to the session-reuse path.
        let generation = task.generation;
        let _ = self
            .mutate_task(&task.task_id, None, |current, runtime| {
                if current.generation != generation {
                    return;
                }
                runtime.session_id = None;
            })
            .await;
        if let Err(error) = self
            .agent
            .cancel(LoopxAgentCancelRequest {
                operation_id: format!("teardown-agent-{}", uuid::Uuid::new_v4()),
                target_operation_id: runtime.operation_id.clone(),
                task_id: task.task_id.clone(),
                generation: task.generation,
                session_id: session_id.clone(),
                turn_id: turn_id.clone(),
            })
            .await
        {
            log::warn!(
                "LoopX agent cancel skipped for task {}: {}",
                task.task_id,
                error
            );
        }
        if let Err(error) = self
            .agent
            .finish(LoopxAgentFinishRequest {
                operation_id: format!("teardown-agent-finish-{}", uuid::Uuid::new_v4()),
                task_id: task.task_id.clone(),
                generation: task.generation,
                worktree_path: task.workspace_path.clone().unwrap_or_default(),
                session_id: session_id.clone(),
                turn_id: turn_id.clone(),
            })
            .await
        {
            log::warn!(
                "LoopX agent finish skipped for task {}: {}",
                task.task_id,
                error
            );
        }
    }

    /// Suite-level stop: pauses every active agent turn held by this host and
    /// sets the durable suspension flag so intake and scheduling hold until the
    /// user explicitly resumes the suite. Waiting-for-user gates are left
    /// intact: they reflect a decision the owner still owes, and resume re-arms
    /// them. There is deliberately no per-task stop; stopping is suite-scoped.
    async fn pause_all(
        self: &Arc<Self>,
        request: &LoopxActionRequest,
    ) -> Result<LoopxActionResponse, String> {
        self.ensure_writable().await?;
        let paused_task_ids = {
            let state = self.state.read().await;
            state
                .tasks
                .iter()
                .filter(|task| {
                    matches!(
                        task.state,
                        LoopxTaskState::Preparing
                            | LoopxTaskState::Queued
                            | LoopxTaskState::Running
                    )
                })
                .map(|task| task.task_id.clone())
                .collect::<Vec<_>>()
        };
        let mut paused = 0usize;
        for task_id in paused_task_ids {
            let (task, runtime) = {
                let state = self.state.read().await;
                let Some(task) = state.tasks.iter().find(|t| t.task_id == task_id).cloned() else {
                    continue;
                };
                (
                    task,
                    state.runtime.get(&task_id).cloned().unwrap_or_default(),
                )
            };
            if task.state == LoopxTaskState::Running {
                if self
                    .pause_task(&task, &runtime, &request.client_request_id)
                    .await
                    .is_ok()
                {
                    paused += 1;
                }
            } else {
                // Queued/Preparing: nothing is executing yet; park them without
                // touching any agent run so resume can re-arm them per task.
                self.transition_task(
                    &task.task_id,
                    task.generation,
                    LoopxTaskState::Stopped,
                    LoopxPhase::Finished,
                    "Suite stopped before the task started",
                )
                .await?;
                paused += 1;
            }
        }
        {
            let _mutation = self.mutation_lock.lock().await;
            let mut state = self.state.write().await;
            let start_cursor = state.cursor;
            if !state.suspended {
                state.suspended = true;
                state.revision = state.revision.saturating_add(1);
                state.append_event(LoopxEvent {
                    kind: LoopxEventKind::SnapshotInvalidated,
                    level: LoopxEventLevel::Info,
                    source: LoopxEventSource::Controller,
                    message: format!(
                        "LoopX suite stopped; intake and scheduling are held until resume (paused {paused} task(s))"
                    ),
                    occurred_at: now_ms(),
                    ..LoopxEvent::default()
                });
                let persisted = state.clone();
                drop(state);
                self.store.save(&persisted).await?;
                self.broadcast_new_events(&persisted, start_cursor);
            }
        }
        Ok(LoopxActionResponse {
            status: LoopxActionStatus::Applied,
            current_revision: self.state.read().await.revision,
            message: Some("LoopX suite stopped".to_string()),
            ..LoopxActionResponse::default()
        })
    }

    /// Suite-level continue: clears the durable suspension flag, refreshes
    /// host projections exactly like a host resume, and re-enqueues tasks that
    /// were parked by the stop.
    async fn resume_all(
        self: &Arc<Self>,
        _request: &LoopxActionRequest,
    ) -> Result<LoopxActionResponse, String> {
        self.ensure_writable().await?;
        {
            let _mutation = self.mutation_lock.lock().await;
            let mut state = self.state.write().await;
            let start_cursor = state.cursor;
            if state.suspended {
                state.suspended = false;
                state.revision = state.revision.saturating_add(1);
                state.append_event(LoopxEvent {
                    kind: LoopxEventKind::SnapshotInvalidated,
                    level: LoopxEventLevel::Info,
                    source: LoopxEventSource::Controller,
                    message: "LoopX suite resumed; intake and scheduling re-enabled".to_string(),
                    occurred_at: now_ms(),
                    ..LoopxEvent::default()
                });
                let persisted = state.clone();
                drop(state);
                self.store.save(&persisted).await?;
                self.broadcast_new_events(&persisted, start_cursor);
            }
        }
        if let Err(error) = self.refresh_environment().await {
            log::warn!("LoopX environment refresh after suite resume failed: {error}");
        }
        self.reconcile_goal_projections(true).await;
        self.enqueue_ready_tasks_after_load().await;
        Ok(LoopxActionResponse {
            status: LoopxActionStatus::Applied,
            current_revision: self.state.read().await.revision,
            message: Some("LoopX suite resumed".to_string()),
            ..LoopxActionResponse::default()
        })
    }

    async fn pause_task(
        self: &Arc<Self>,
        task: &LoopxTaskSnapshot,
        runtime: &LoopxTaskRuntimeRecord,
        request_id: &str,
    ) -> Result<LoopxActionResponse, String> {
        self.transition_task(
            &task.task_id,
            task.generation,
            LoopxTaskState::Cancelling,
            LoopxPhase::Cancelling,
            "Cancelling the active LoopX task",
        )
        .await?;
        self.teardown_agent_run(task, runtime).await;
        let progress = BufferedProgress::default();
        let _ = self
            .cli
            .cancel(
                LoopxCliCancelRequest {
                    call: LoopxCliCallContext {
                        operation_id: format!("cancel-cli-{}", uuid::Uuid::new_v4()),
                        deadline_at: None,
                    },
                    target_operation_id: runtime.operation_id.clone(),
                },
                &progress,
            )
            .await;
        self.record_progress(progress.take()).await?;
        let response = self
            .transition_action(
                &task.task_id,
                LoopxTaskState::Stopped,
                LoopxPhase::Finished,
                request_id,
            )
            .await?;
        self.schedule_next_for_repository(
            &task.identity.item.repository.canonical_id(),
            Some(&task.task_id),
        )
        .await;
        Ok(response)
    }

    async fn abort_task(
        self: &Arc<Self>,
        task: &LoopxTaskSnapshot,
        runtime: &LoopxTaskRuntimeRecord,
        request_id: &str,
    ) -> Result<LoopxActionResponse, String> {
        self.transition_task(
            &task.task_id,
            task.generation,
            LoopxTaskState::Cancelling,
            LoopxPhase::Cancelling,
            "Aborting the active LoopX task",
        )
        .await?;
        self.teardown_agent_run(task, runtime).await;
        let progress = BufferedProgress::default();
        let _ = self
            .cli
            .cancel(
                LoopxCliCancelRequest {
                    call: LoopxCliCallContext {
                        operation_id: format!("abort-cli-{}", uuid::Uuid::new_v4()),
                        deadline_at: None,
                    },
                    target_operation_id: runtime.operation_id.clone(),
                },
                &progress,
            )
            .await;
        self.record_progress(progress.take()).await?;
        let response = self
            .transition_action(
                &task.task_id,
                LoopxTaskState::Aborted,
                LoopxPhase::Finished,
                request_id,
            )
            .await?;
        self.schedule_next_for_repository(
            &task.identity.item.repository.canonical_id(),
            Some(&task.task_id),
        )
        .await;
        Ok(response)
    }

    async fn resume_task(
        self: &Arc<Self>,
        task: &LoopxTaskSnapshot,
        request_id: &str,
    ) -> Result<LoopxActionResponse, String> {
        if self.state.read().await.suspended {
            return Ok(LoopxActionResponse {
                status: LoopxActionStatus::Rejected,
                current_revision: task.revision,
                task: Some(task.clone()),
                message: Some("LoopX suite is stopped; resume the suite first".to_string()),
            });
        }
        if !matches!(
            task.state,
            LoopxTaskState::Stopped | LoopxTaskState::Failed | LoopxTaskState::RecoveryRequired
        ) {
            return Ok(LoopxActionResponse {
                status: LoopxActionStatus::Rejected,
                current_revision: task.revision,
                task: Some(task.clone()),
                message: Some(
                    "Only stopped, failed, or recovery-required tasks can resume".to_string(),
                ),
            });
        }
        let updated = self
            .mutate_task(&task.task_id, Some(request_id), |task, runtime| {
                task.generation = task.generation.saturating_add(1);
                task.revision = task.revision.saturating_add(1);
                task.state = LoopxTaskState::Queued;
                task.phase = LoopxPhase::Recovering;
                task.current_turn_id = None;
                task.pending_gate_id = None;
                task.pending_gate_message = None;
                task.pending_gate_action_kind = None;
                task.error = None;
                task.recovery_reason = None;
                runtime.operation_id = format!("resume-{}-{}", task.task_id, task.generation);
                runtime.session_id = None;
                runtime.agent_turn_id = None;
                runtime.loopx_turn_id = None;
                runtime.settlement_token = None;
                runtime.expected_durable_revision = None;
            })
            .await?;
        let task_id = task.task_id.clone();
        self.enqueue_task(task_id, Duration::ZERO)?;
        Ok(LoopxActionResponse {
            current_revision: updated.revision,
            task: Some(updated),
            ..LoopxActionResponse::default()
        })
    }

    async fn resume_repository(
        self: &Arc<Self>,
        request: &LoopxActionRequest,
    ) -> Result<LoopxActionResponse, String> {
        let repository = request
            .repository
            .as_ref()
            .ok_or_else(|| "repository is required for resume_repository".to_string())?;
        let repository_id = repository.canonical_id();
        let _mutation = self.mutation_lock.lock().await;
        let mut state = self.state.write().await;
        if state.has_processed_request(&request.client_request_id) {
            return Ok(LoopxActionResponse {
                status: LoopxActionStatus::Duplicate,
                current_revision: state.revision,
                message: Some("Repository resume was already applied".to_string()),
                ..LoopxActionResponse::default()
            });
        }
        if state.revision != request.expected_revision {
            return Ok(LoopxActionResponse {
                status: LoopxActionStatus::RevisionConflict,
                current_revision: state.revision,
                message: Some(
                    "Task list changed; refresh before resuming the repository".to_string(),
                ),
                ..LoopxActionResponse::default()
            });
        }

        let task_indexes = state
            .tasks
            .iter()
            .enumerate()
            .filter_map(|(index, task)| {
                is_repository_recovery_candidate(task, &repository_id).then_some(index)
            })
            .collect::<Vec<_>>();
        let start_cursor = state.cursor;
        let now = now_ms();
        let mut task_ids = Vec::with_capacity(task_indexes.len());
        for task_index in task_indexes {
            let task_id = state.tasks[task_index].task_id.clone();
            let mut runtime = state.runtime.remove(&task_id).unwrap_or_default();
            {
                let task = &mut state.tasks[task_index];
                task.generation = task.generation.saturating_add(1);
                task.revision = task.revision.saturating_add(1);
                task.state = LoopxTaskState::Queued;
                task.phase = LoopxPhase::Recovering;
                task.current_turn_id = None;
                task.error = None;
                task.recovery_reason = None;
                task.updated_at = now;
                runtime.operation_id = format!("resume-{}-{}", task.task_id, task.generation);
                runtime.session_id = None;
                runtime.agent_turn_id = None;
                runtime.loopx_turn_id = None;
                runtime.settlement_token = None;
                runtime.expected_durable_revision = None;
            }
            let updated = state.tasks[task_index].clone();
            state.runtime.insert(task_id.clone(), runtime);
            state.revision = state.revision.saturating_add(1);
            state.append_event(LoopxEvent {
                task_id: Some(task_id.clone()),
                generation: Some(updated.generation),
                revision: Some(updated.revision),
                kind: LoopxEventKind::StateChanged,
                source: LoopxEventSource::Controller,
                phase: Some(LoopxPhase::Recovering),
                message: "Task queued by repository resume".to_string(),
                occurred_at: now,
                ..LoopxEvent::default()
            });
            task_ids.push(task_id);
        }
        state.record_processed_request(request.client_request_id.clone());
        let resumed_count = task_ids.len();
        let current_revision = state.revision;
        let persisted = state.clone();
        drop(state);
        self.store.save(&persisted).await?;
        drop(_mutation);
        self.broadcast_new_events(&persisted, start_cursor);
        for task_id in task_ids {
            self.enqueue_task(task_id, Duration::ZERO)?;
        }
        Ok(LoopxActionResponse {
            current_revision,
            message: Some(format!("Queued {resumed_count} repository tasks")),
            ..LoopxActionResponse::default()
        })
    }

    async fn reset_all(
        self: &Arc<Self>,
        request: &LoopxActionRequest,
    ) -> Result<LoopxActionResponse, String> {
        if self
            .reset_in_progress
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Ok(LoopxActionResponse {
                status: LoopxActionStatus::Duplicate,
                current_revision: self.state.read().await.revision,
                message: Some("LoopX reset is already in progress".to_string()),
                ..LoopxActionResponse::default()
            });
        }
        let _reset_guard = InProgressGuard(&self.reset_in_progress);
        let (tasks, runtimes, previous_stream_id, environment) = {
            let _mutation = self.mutation_lock.lock().await;
            let mut state = self.state.write().await;
            if state.has_processed_request(&request.client_request_id) {
                return Ok(LoopxActionResponse {
                    status: LoopxActionStatus::Duplicate,
                    current_revision: state.revision,
                    message: Some("LoopX reset was already applied".to_string()),
                    ..LoopxActionResponse::default()
                });
            }
            if state.revision != request.expected_revision {
                return Ok(LoopxActionResponse {
                    status: LoopxActionStatus::RevisionConflict,
                    current_revision: state.revision,
                    message: Some("LoopX state changed; refresh before resetting".to_string()),
                    ..LoopxActionResponse::default()
                });
            }
            let tasks = state.tasks.clone();
            let runtimes = state.runtime.clone();
            let environment = state.environment.clone();
            for task in &mut state.tasks {
                if matches!(
                    task.state,
                    LoopxTaskState::Preparing
                        | LoopxTaskState::Queued
                        | LoopxTaskState::Running
                        | LoopxTaskState::Cancelling
                ) {
                    task.state = LoopxTaskState::Cancelling;
                    task.phase = LoopxPhase::Cancelling;
                    task.revision = task.revision.saturating_add(1);
                    task.updated_at = now_ms();
                }
            }
            state.record_processed_request(request.client_request_id.clone());
            state.revision = state.revision.saturating_add(1);
            let persisted = state.clone();
            let previous_stream_id = state.stream_id.clone();
            drop(state);
            self.store.save(&persisted).await?;
            (tasks, runtimes, previous_stream_id, environment)
        };

        for task in &tasks {
            let runtime = runtimes.get(&task.task_id).cloned().unwrap_or_default();
            self.teardown_agent_run(task, &runtime).await;
            if !runtime.operation_id.trim().is_empty() {
                let progress = BufferedProgress::default();
                let _ = self
                    .cli
                    .cancel(
                        LoopxCliCancelRequest {
                            call: LoopxCliCallContext {
                                operation_id: format!("reset-cli-{}", uuid::Uuid::new_v4()),
                                deadline_at: None,
                            },
                            target_operation_id: runtime.operation_id.clone(),
                        },
                        &progress,
                    )
                    .await;
            }
            let _ = self
                .workspace
                .cancel(LoopxWorkspaceCancelRequest {
                    operation_id: format!("reset-workspace-{}", uuid::Uuid::new_v4()),
                    target_operation_id: format!("workspace-{}-{}", task.task_id, task.generation),
                    task_id: task.task_id.clone(),
                })
                .await;
        }

        self.workspace
            .reset(LoopxWorkspaceResetRequest {
                operation_id: format!("reset-workspaces-{}", uuid::Uuid::new_v4()),
            })
            .await
            .map_err(|error| error.to_string())?;
        let goal_ids = tasks
            .iter()
            .map(|task| goal_id_for(&task.identity))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let reset_goals = if goal_ids.is_empty() {
            LoopxCliResetGoalsResult::default()
        } else {
            let progress = BufferedProgress::default();
            let result = self
                .cli
                .reset_goals(
                    LoopxCliResetGoalsRequest {
                        call: LoopxCliCallContext {
                            operation_id: format!("reset-goals-{}", uuid::Uuid::new_v4()),
                            deadline_at: None,
                        },
                        goal_ids,
                    },
                    &progress,
                )
                .await
                .map_err(|error| error.to_string())?;
            self.record_progress(progress.take()).await?;
            result
        };
        log::info!(
            "LoopX reset goal cleanup completed: requested={}, retired={}, already_absent={}, archived={}, missing_runtime={}",
            reset_goals.requested_goal_ids.len(),
            reset_goals.retired_goal_ids.len(),
            reset_goals.already_absent_goal_ids.len(),
            reset_goals.archived_goal_ids.len(),
            reset_goals.missing_runtime_goal_ids.len()
        );
        self.agent
            .reset(LoopxAgentResetRequest {
                operation_id: format!("reset-history-{}", uuid::Uuid::new_v4()),
            })
            .await
            .map_err(|error| error.to_string())?;

        let mut fresh = LoopxPersistedState::new(now_ms());
        fresh.environment = environment;
        self.store.clear().await?;
        {
            let _mutation = self.mutation_lock.lock().await;
            *self.state.write().await = fresh.clone();
            self.active_tasks.lock().await.clear();
            self.active_repositories.lock().await.clear();
            self.previews.write().await.clear();
            *self.load_error.write().await = None;
        }
        let _ = self.event_sender.send(LoopxEvent {
            stream_id: fresh.stream_id,
            cursor: 0,
            kind: LoopxEventKind::SnapshotInvalidated,
            level: LoopxEventLevel::Info,
            source: LoopxEventSource::Controller,
            message: format!("LoopX reset replaced stream {previous_stream_id}"),
            occurred_at: now_ms(),
            ..LoopxEvent::default()
        });
        Ok(LoopxActionResponse {
            current_revision: fresh.revision,
            message: Some(format!(
                "Cleared {} LoopX tasks, {} global goal routes, managed workspaces, runtime state, and persisted controller state",
                tasks.len(),
                reset_goals.retired_goal_ids.len()
                    + reset_goals.already_absent_goal_ids.len()
            )),
            ..LoopxActionResponse::default()
        })
    }

    async fn answer_gate(
        self: &Arc<Self>,
        task: &LoopxTaskSnapshot,
        runtime: &LoopxTaskRuntimeRecord,
        request: &LoopxActionRequest,
    ) -> Result<LoopxActionResponse, String> {
        if bound_workspace_missing(task) {
            // A dead workspace cannot answer gates: the CLI spawn would fail
            // with an invalid-directory error. The next drive re-prepares the
            // workspace and reconnects the goal, then the gate resurfaces.
            return Err(
                "LoopX workspace is missing for this task; it will be re-prepared on the next run — retry the approval after the task leaves recovery and re-raises the gate"
                    .to_string(),
            );
        }
        let gate_id = request
            .gate_id
            .clone()
            .ok_or_else(|| "gateId is required".to_string())?;
        let progress = BufferedProgress::default();
        let result = self
            .cli
            .answer_gate(
                LoopxCliAnswerGateRequest {
                    context: self.goal_context(task, runtime),
                    goal_id: task.goal_id.clone().unwrap_or_default(),
                    agent_id: task
                        .agent_id
                        .clone()
                        .unwrap_or_else(|| DEFAULT_AGENT_ID.to_string()),
                    gate_id,
                    decision: if request.action == LoopxActionKind::Approve {
                        LoopxCliGateDecision::Approve
                    } else {
                        LoopxCliGateDecision::Reject
                    },
                    note: request.note.clone(),
                    granted_scope: None,
                },
                &progress,
            )
            .await
            .map_err(|error| error.to_string())?;
        self.record_progress(progress.take()).await?;
        if !result.applied {
            return Ok(LoopxActionResponse {
                status: LoopxActionStatus::Rejected,
                current_revision: task.revision,
                task: Some(task.clone()),
                message: Some("LoopX did not apply the gate decision".to_string()),
            });
        }
        self.record_goal_state(task, result.goal_state).await?;
        self.mutate_task(&task.task_id, None, |current, current_runtime| {
            if current.generation != task.generation {
                return;
            }
            current.revision = current.revision.saturating_add(1);
            current_runtime.expected_durable_revision = Some(result.durable_revision.clone());
        })
        .await?;
        let response = self
            .transition_action(
                &task.task_id,
                LoopxTaskState::Queued,
                LoopxPhase::Queued,
                &request.client_request_id,
            )
            .await?;
        self.enqueue_task(task.task_id.clone(), Duration::ZERO)?;
        Ok(response)
    }

    /// Generic durable gate answer used by the automatic approvers. The
    /// decision is recorded as a durable task event so the surface stays
    /// auditable.
    async fn auto_answer_gate(
        self: &Arc<Self>,
        task: &LoopxTaskSnapshot,
        runtime: &LoopxTaskRuntimeRecord,
        gate: &LoopxCliUserGate,
        decision: LoopxCliGateDecision,
        note: String,
        event_message: String,
    ) -> Result<(), String> {
        log::info!(
            "LoopX auto-answering user gate: task_id={} goal={} gate={} decision={:?} kind={:?}",
            task.task_id,
            task.goal_id.as_deref().unwrap_or("-"),
            gate.gate_id,
            decision,
            gate.action_kind,
        );
        let progress = BufferedProgress::default();
        let result = self
            .cli
            .answer_gate(
                LoopxCliAnswerGateRequest {
                    context: self.goal_context(task, runtime),
                    goal_id: task.goal_id.clone().unwrap_or_default(),
                    agent_id: task
                        .agent_id
                        .clone()
                        .unwrap_or_else(|| DEFAULT_AGENT_ID.to_string()),
                    gate_id: gate.gate_id.clone(),
                    decision,
                    note: Some(note),
                    granted_scope: None,
                },
                &progress,
            )
            .await;
        self.record_progress(progress.take()).await?;
        let result = result.map_err(|error| error.to_string())?;
        if !result.applied {
            return Err("LoopX did not apply the automatic gate answer".to_string());
        }
        self.record_goal_state(task, result.goal_state).await?;
        self.mutate_task(&task.task_id, None, |current, current_runtime| {
            if current.generation != task.generation {
                return;
            }
            current.revision = current.revision.saturating_add(1);
            current.pending_gate_id = None;
            current.pending_gate_message = None;
            current.pending_gate_action_kind = None;
            current_runtime.expected_durable_revision = Some(result.durable_revision.clone());
        })
        .await?;
        let updated = self.task(&task.task_id).await?;
        let mut details = BTreeMap::new();
        details.insert("gateId".to_string(), gate.gate_id.clone());
        if let Some(kind) = gate.action_kind.clone() {
            details.insert("actionKind".to_string(), kind);
        }
        details.insert("autoAnswered".to_string(), "true".to_string());
        self.append_task_event_with_details(
            &updated,
            LoopxEventKind::StateChanged,
            &event_message,
            true,
            details,
        )
        .await?;
        self.schedule_next_for_repository(
            &task.identity.item.repository.canonical_id(),
            Some(&task.task_id),
        )
        .await;
        self.enqueue_task(task.task_id.clone(), Duration::ZERO)?;
        Ok(())
    }

    /// Takes the one-shot host note (if any) so the next agent instruction
    /// carries it exactly once.
    async fn take_pending_host_note(&self, task_id: &str) -> Option<String> {
        let note = self.runtime(task_id).await.pending_host_note.clone();
        if note.is_some() {
            self.mutate_task(task_id, None, |_current, runtime| {
                runtime.pending_host_note = None;
            })
            .await
            .ok();
        }
        note
    }

    async fn apply_settlement(
        self: &Arc<Self>,
        task: &LoopxTaskSnapshot,
        settlement: LoopxCliSettleTurnResult,
        agent_status: LoopxAgentTurnStatus,
        failure_summary: Option<&str>,
        blocks_repository: bool,
    ) -> Result<(), String> {
        let post_settlement_goal =
            if inspects_goal_after_settlement(agent_status, settlement.status) {
                let runtime = self.runtime(&task.task_id).await;
                let progress = BufferedProgress::default();
                let inspected = self
                    .cli
                    .inspect_goal(
                        LoopxCliInspectGoalRequest {
                            context: self.goal_context(task, &runtime),
                            goal_id: task.goal_id.clone().unwrap_or_default(),
                            agent_id: task
                                .agent_id
                                .clone()
                                .unwrap_or_else(|| DEFAULT_AGENT_ID.to_string()),
                        },
                        &progress,
                    )
                    .await;
                self.record_progress(progress.take()).await?;
                match inspected {
                    Ok(snapshot) => Some(snapshot),
                    Err(error) => {
                        log::warn!(
                            "LoopX post-settlement Goal inspection failed: task_id={}, error={}",
                            task.task_id,
                            error
                        );
                        None
                    }
                }
            } else {
                None
            };
        // A NoDurableProgress settlement after a healthy agent turn usually
        // means the workflow produced its artifacts outside the CLI write
        // boundary (for example files under the system temp directory), so
        // settlement could not validate them. Schedule exactly one corrective
        // turn that re-submits the pending writebacks before parking the task
        // for interactive recovery. The corrective turn is a normal turn with
        // an explicit host note; nothing is forged and every step is recorded
        // as a task event.
        let compensate_durable_writeback = agent_status != LoopxAgentTurnStatus::Failed
            && settlement.status == LoopxCliSettlementStatus::NoDurableProgress
            && !self
                .runtime(&task.task_id)
                .await
                .durable_compensation_pending;
        let final_state = if compensate_durable_writeback {
            LoopxTaskState::Queued
        } else {
            task_state_after_settlement(
                agent_status,
                settlement.status,
                post_settlement_goal.as_ref(),
            )
        };
        let phase = phase_after_settlement(final_state);
        // Codex-parity session policy: a healthy completed turn whose task
        // continues (more turns queued for this goal, or a user gate the
        // session itself asked about) keeps the agent session so the next
        // turn continues the same conversation — the pinned skill document
        // and project context stay loaded instead of being re-read every
        // turn. Terminal (Completed), recovery, and failed turns discard
        // the session: a fresh context is the safer recovery surface and
        // nothing durable is lost (LoopX goal state remains authoritative).
        let keep_agent_session = agent_status == LoopxAgentTurnStatus::Completed
            && matches!(
                final_state,
                LoopxTaskState::Queued | LoopxTaskState::WaitingForUser
            );
        // Captured before the mutation below: when the session is not kept,
        // the mutation clears `runtime.session_id` first, and the discard
        // call still needs the id to tear the live session down.
        let session_runtime = self.runtime(&task.task_id).await;
        let updated = self
            .mutate_task(&task.task_id, None, |task, runtime| {
                task.state = final_state;
                task.phase = phase;
                task.recovery_reason = if final_state == LoopxTaskState::RecoveryRequired {
                    Some("settlement_unverified".to_string())
                } else {
                    None
                };
                task.goal_state = post_settlement_goal
                    .as_ref()
                    .map(|goal| goal.state)
                    .or_else(|| {
                        Some(match settlement.status {
                            LoopxCliSettlementStatus::GoalCompleted => LoopxCliGoalState::Completed,
                            _ => LoopxCliGoalState::Active,
                        })
                    });
                task.revision = task.revision.saturating_add(1);
                task.current_turn_id = None;
                let pending_gate = post_settlement_goal
                    .as_ref()
                    .and_then(|goal| goal.pending_user_gate.as_ref());
                task.pending_gate_id = pending_gate.map(|gate| gate.gate_id.clone());
                task.pending_gate_message = pending_gate.map(|gate| gate.message.clone());
                task.pending_gate_action_kind =
                    pending_gate.and_then(|gate| gate.action_kind.clone());
                task.deadline_at = None;
                task.error = (agent_status == LoopxAgentTurnStatus::Failed)
                    .then(|| failure_summary.unwrap_or("Agent turn failed").to_string());
                task.settlement = LoopxSettlementSummary {
                    turn_id: Some(settlement.turn_id.clone()),
                    receipt_id: Some(settlement.receipt_id.clone()),
                    durable_revision: Some(settlement.after_revision.clone()),
                    settled_at: Some(now_ms()),
                };
                if !keep_agent_session {
                    runtime.session_id = None;
                }
                runtime.agent_turn_id = None;
                if compensate_durable_writeback {
                    runtime.durable_compensation_pending = true;
                    runtime.pending_host_note = Some(LOOPX_DURABLE_COMPENSATION_NOTE.to_string());
                }
                // A settled turn proves the quota contract works again; the
                // one-shot compensation allowance must re-arm for a future
                // unrelated NoDurableProgress episode.
                if matches!(
                    settlement.status,
                    LoopxCliSettlementStatus::Settled
                        | LoopxCliSettlementStatus::AlreadySettled
                        | LoopxCliSettlementStatus::GoalCompleted
                ) {
                    runtime.durable_compensation_pending = false;
                }
                runtime.expected_durable_revision = Some(
                    post_settlement_goal
                        .as_ref()
                        .map(|goal| goal.durable_revision.clone())
                        .unwrap_or_else(|| settlement.after_revision.clone()),
                );
            })
            .await?;
        log::info!(
            "LoopX task settlement applied: task_id={}, goal_id={}, final_state={:?}, phase={:?}, settlement_status={:?}",
            updated.task_id,
            updated.goal_id.as_deref().unwrap_or("unknown"),
            updated.state,
            updated.phase,
            settlement.status
        );
        if keep_agent_session {
            log::info!(
                "LoopX Agent session kept for the goal's next turn: task_id={}, session_id={:?}",
                task.task_id,
                session_runtime.session_id
            );
        } else {
            self.discard_agent_session(&task, &session_runtime).await;
        }
        // Loud, auditable degradation for the false-negative settlement:
        // the durable writeback validated and the Goal projection decided
        // the next state, but the turn's quota spend receipt is permanently
        // missing. The host neither retries nor fabricates the receipt; the
        // loss is recorded as a task event so it stays visible in the
        // timeline and telemetry. Cancelled/interrupted turns and failed
        // post-settlement inspections keep the loud recovery card instead.
        if agent_status == LoopxAgentTurnStatus::Completed
            && settlement.status == LoopxCliSettlementStatus::RetryRequired
            && post_settlement_goal.is_some()
        {
            let message = format!(
                "LoopX settlement for turn {} reported RetryRequired: the durable writeback validated but the quota spend receipt is missing; the task continues from the authoritative Goal projection ({:?}). The receipt is not retried or fabricated by the host.",
                settlement.turn_id,
                updated.state
            );
            log::warn!(
                "LoopX settlement quota receipt missing, continuing from goal projection: task_id={} turn={}",
                updated.task_id,
                settlement.turn_id
            );
            self.append_task_event(&updated, LoopxEventKind::SettlementRecorded, &message, true)
                .await?;
        }
        let yielded_repository;
        if agent_status == LoopxAgentTurnStatus::Failed {
            let reason = failure_summary.unwrap_or("Agent turn failed");
            self.append_task_event(&updated, LoopxEventKind::StateChanged, reason, true)
                .await?;
            if blocks_repository {
                self.pause_repository_after_failure(&updated, reason)
                    .await?;
            }
        } else {
            if final_state == LoopxTaskState::WaitingForUser {
                let Some(gate) = post_settlement_goal
                    .as_ref()
                    .and_then(|goal| goal.pending_user_gate.as_ref())
                else {
                    // Owner action outside the host: park as waiting with a
                    // human explanation instead of failing a finished task
                    // (live 2026-09-08, issue 2: PR opened, review/merge
                    // queue projected without a typed user_gate).
                    return self
                        .park_waiting_owner_action(
                            &updated,
                            post_settlement_goal
                                .as_ref()
                                .and_then(|goal| goal.waiting_user_summary.as_deref()),
                        )
                        .await;
                };
                // Read-only gates are policy answers, not consent: the owner
                // decided that reading public issue content never needs a
                // human, so answer them here exactly like the drive-turn
                // inspector does (same durable boundary, host-attributed
                // note). Interactive approval stays the fallback on failure.
                if is_read_only_user_gate(gate.action_kind.as_deref()) {
                    let runtime = self.runtime(&task.task_id).await;
                    match self
                        .auto_answer_gate(
                            &updated,
                            &runtime,
                            gate,
                            LoopxCliGateDecision::Approve,
                            "Auto-approved by BitFun: read-only public issue metadata access."
                                .to_string(),
                            format!(
                                "Read-only user gate auto-approved by BitFun after settlement: {}",
                                gate.message
                            ),
                        )
                        .await
                    {
                        Ok(()) => return Ok(()),
                        Err(error) => {
                            log::warn!(
                                "LoopX read-only gate auto-approval after settlement failed, falling back to interactive approval: task_id={} gate={} error={}",
                                task.task_id,
                                gate.gate_id,
                                error
                            );
                        }
                    }
                }
                let mut details = BTreeMap::new();
                details.insert("gateId".to_string(), gate.gate_id.clone());
                if let Some(action_kind) = gate.action_kind.clone() {
                    details.insert("actionKind".to_string(), action_kind);
                }
                self.append_task_event_with_details(
                    &updated,
                    LoopxEventKind::ApprovalRequired,
                    &gate.message,
                    true,
                    details,
                )
                .await?;
            } else {
                let (kind, message, important) = if compensate_durable_writeback {
                    (
                        LoopxEventKind::StateChanged,
                        "LoopX durable writeback was not validated; scheduling one corrective turn to re-submit pending artifacts via the CLI write boundary",
                        true,
                    )
                } else {
                    match final_state {
                        LoopxTaskState::Completed => (
                            LoopxEventKind::SettlementRecorded,
                            "LoopX goal completed",
                            false,
                        ),
                        LoopxTaskState::RecoveryRequired => (
                            LoopxEventKind::StateChanged,
                            if settlement.status == LoopxCliSettlementStatus::RetryRequired {
                                "LoopX writeback validated but the quota spend settlement is missing; resume retries the turn with the current quota contract"
                            } else {
                                "LoopX turn requires recovery after settlement"
                            },
                            true,
                        ),
                        _ => (
                            LoopxEventKind::SettlementRecorded,
                            "LoopX turn settlement recorded",
                            false,
                        ),
                    }
                };
                self.append_task_event(&updated, kind, message, important)
                    .await?;
            }
            if sticky_continue_after_settlement(
                final_state,
                post_settlement_goal.as_ref().map(|goal| goal.run_decision),
            ) {
                // Depth-first repository lane: the segment settled cleanly and
                // the Goal is still runnable (RunNow), so the same task keeps
                // the repository slot and continues with its next bounded
                // segment instead of yielding to the next queued issue. The
                // slot is intentionally not released here; reserve_repository
                // accepts the same owner on the next drive.
                self.enqueue_task(updated.task_id.clone(), Duration::ZERO)?;
            } else {
                yielded_repository = self
                    .schedule_next_for_repository(
                        &updated.identity.item.repository.canonical_id(),
                        Some(&updated.task_id),
                    )
                    .await;
                if yielded_repository {
                    self.suppress_pending_task_rerun(&updated.task_id).await;
                } else if matches!(
                    final_state,
                    LoopxTaskState::RecoveryRequired | LoopxTaskState::WaitingForUser
                ) {
                    // Nothing queued could take the freed slot. Surface what the
                    // remaining repository tasks are stuck in so a stalled line
                    // shows up in the log instead of silent idling.
                    let stalled: Vec<String> = {
                        let state = self.state.read().await;
                        state
                            .tasks
                            .iter()
                            .filter(|task| {
                                task.task_id != updated.task_id
                                    && task.identity.item.repository.canonical_id()
                                        == updated.identity.item.repository.canonical_id()
                                    && !matches!(
                                        task.state,
                                        LoopxTaskState::Completed
                                            | LoopxTaskState::Archived
                                            | LoopxTaskState::Stopped
                                    )
                            })
                            .map(|task| format!("{} {:?}", task.task_id, task.state))
                            .collect()
                    };
                    log::warn!(
                        "LoopX repository queue stalled after parking task {}: remaining non-terminal tasks {:?}",
                        updated.task_id,
                        stalled
                    );
                }
                if should_requeue_after_settlement(final_state, yielded_repository) {
                    let task_id = task.task_id.clone();
                    // The next bounded turn is admitted by the quota guard,
                    // so a parked-and-requeued task re-drives immediately.
                    self.enqueue_task(task_id, Duration::ZERO)?;
                }
            }
        }
        Ok(())
    }

    /// Parks a task whose LoopX goal waits on an OWNER ACTION outside the
    /// host: an open user todo without a typed `user_gate` (for example the
    /// owner review/merge queue entry recorded after the agent opened a PR).
    /// There is no host-answerable approval card - the owner acts on the
    /// external surface (GitHub) and the goal gains new work (or is resumed)
    /// afterwards. The repository slot yields to queued siblings while the
    /// task waits.
    async fn park_waiting_owner_action(
        self: &Arc<Self>,
        task: &LoopxTaskSnapshot,
        summary: Option<&str>,
    ) -> Result<(), String> {
        let message = match summary {
            Some(text) => format!(
                "LoopX is waiting for an owner action outside this host: {text}. Finish that action (for example review or merge the pull request on GitHub); the task continues when the goal gains new work, or use Resume after acting."
            ),
            None => "LoopX is waiting for an owner action outside this host. Finish the pending owner decision on the external surface (for example GitHub); the task continues when the goal gains new work, or use Resume after acting."
                .to_string(),
        };
        let generation = task.generation;
        let updated = self
            .mutate_task(&task.task_id, None, |current, _| {
                if current.generation != generation {
                    return;
                }
                current.state = LoopxTaskState::WaitingForUser;
                current.phase = LoopxPhase::WaitingForApproval;
                current.pending_gate_id = None;
                current.pending_gate_message = Some(message.clone());
                current.pending_gate_action_kind = None;
                current.revision = current.revision.saturating_add(1);
            })
            .await?;
        log::info!(
            "LoopX goal waits on an owner action outside the host; task parked: task_id={} summary={:?}",
            task.task_id,
            summary
        );
        self.append_task_event(&updated, LoopxEventKind::StateChanged, &message, true)
            .await?;
        self.schedule_next_for_repository(
            &task.identity.item.repository.canonical_id(),
            Some(&task.task_id),
        )
        .await;
        Ok(())
    }

    async fn sync_concurrent_user_gate(
        &self,
        task: &LoopxTaskSnapshot,
        gate: Option<&LoopxCliUserGate>,
    ) -> Result<(), String> {
        let unchanged = task.pending_gate_id.as_deref() == gate.map(|gate| gate.gate_id.as_str())
            && task.pending_gate_message.as_deref() == gate.map(|gate| gate.message.as_str())
            && task.pending_gate_action_kind.as_deref()
                == gate.and_then(|gate| gate.action_kind.as_deref());
        if unchanged {
            return Ok(());
        }

        let updated = self
            .mutate_task(&task.task_id, None, |current, _| {
                if current.generation != task.generation {
                    return;
                }
                current.pending_gate_id = gate.map(|gate| gate.gate_id.clone());
                current.pending_gate_message = gate.map(|gate| gate.message.clone());
                current.pending_gate_action_kind = gate.and_then(|gate| gate.action_kind.clone());
                current.revision = current.revision.saturating_add(1);
            })
            .await?;

        if let Some(gate) = gate {
            let mut details = BTreeMap::new();
            details.insert("gateId".to_string(), gate.gate_id.clone());
            if let Some(action_kind) = gate.action_kind.clone() {
                details.insert("actionKind".to_string(), action_kind);
            }
            self.append_task_event_with_details(
                &updated,
                LoopxEventKind::ApprovalRequired,
                &gate.message,
                true,
                details,
            )
            .await?;
        }
        Ok(())
    }

    async fn pause_repository_after_failure(
        &self,
        failed_task: &LoopxTaskSnapshot,
        reason: &str,
    ) -> Result<(), String> {
        let repository_id = failed_task.identity.item.repository.canonical_id();
        let message = format!(
            "Repository queue paused after Issue #{} failed: {}",
            failed_task.identity.item.number,
            reason.chars().take(700).collect::<String>()
        );
        let _mutation = self.mutation_lock.lock().await;
        let mut state = self.state.write().await;
        let start_cursor = state.cursor;
        let now = now_ms();
        let mut paused = Vec::new();
        for task in &mut state.tasks {
            if task.task_id == failed_task.task_id
                || task.identity.item.repository.canonical_id() != repository_id
                || task.state != LoopxTaskState::Queued
            {
                continue;
            }
            task.state = LoopxTaskState::RecoveryRequired;
            task.phase = LoopxPhase::Recovering;
            task.error = Some(message.clone());
            task.recovery_reason = Some("repository_paused".to_string());
            task.current_turn_id = None;
            task.deadline_at = None;
            task.revision = task.revision.saturating_add(1);
            task.updated_at = now;
            paused.push(task.clone());
        }
        for task in &paused {
            state.revision = state.revision.saturating_add(1);
            state.append_event(LoopxEvent {
                task_id: Some(task.task_id.clone()),
                generation: Some(task.generation),
                revision: Some(task.revision),
                kind: LoopxEventKind::StateChanged,
                level: LoopxEventLevel::Error,
                source: LoopxEventSource::Controller,
                phase: Some(LoopxPhase::Recovering),
                message: message.clone(),
                important: true,
                occurred_at: now,
                ..LoopxEvent::default()
            });
        }
        state.environment.core.agent_model.status = LoopxEnvironmentFactStatus::Degraded;
        state.environment.core.agent_model.detail = Some(reason.to_string());
        state.environment.core.agent_model.checked_at = Some(now);
        state.environment.status =
            derive_environment_status(&state.environment.core, &state.environment.optional);
        state.environment.revision = state.environment.revision.saturating_add(1);
        state.revision = state.revision.saturating_add(1);
        state.append_event(LoopxEvent {
            kind: LoopxEventKind::EnvironmentChanged,
            level: LoopxEventLevel::Error,
            source: LoopxEventSource::System,
            message: "Agent model runtime failed; repository queue paused".to_string(),
            important: true,
            occurred_at: now,
            ..LoopxEvent::default()
        });
        let persisted = state.clone();
        drop(state);
        self.store.save(&persisted).await?;
        drop(_mutation);
        self.broadcast_new_events(&persisted, start_cursor);
        Ok(())
    }

    async fn reserve_repository(&self, task: &LoopxTaskSnapshot) -> bool {
        let repo = task.identity.item.repository.canonical_id();
        let mut active = self.active_repositories.lock().await;
        match active.get(&repo) {
            Some(owner) => owner == &task.task_id,
            None => {
                active.insert(repo, task.task_id.clone());
                true
            }
        }
    }

    async fn mark_environment_checking(&self) -> Result<(), String> {
        let _mutation = self.mutation_lock.lock().await;
        let mut state = self.state.write().await;
        let checked_at = Some(now_ms());
        state.environment.revision = state.environment.revision.saturating_add(1);
        state.environment.status = LoopxEnvironmentStatus::Checking;
        state.environment.checked_at = checked_at;
        state.environment.core.sidecar = checking_environment_fact(checked_at);
        state.environment.core.node_runtime = checking_environment_fact(checked_at);
        state.environment.core.git_worktree = checking_environment_fact(checked_at);
        state.environment.core.agent_model = checking_environment_fact(checked_at);
        state.environment.optional.github_auth = checking_environment_fact(checked_at);
        state.revision = state.revision.saturating_add(1);
        state.append_event(LoopxEvent {
            kind: LoopxEventKind::EnvironmentChanged,
            source: LoopxEventSource::System,
            message: "LoopX environment validation started".to_string(),
            occurred_at: now_ms(),
            ..LoopxEvent::default()
        });
        let persisted = state.clone();
        let event = persisted.events.last().cloned();
        drop(state);
        self.store.save(&persisted).await?;
        if let Some(event) = event {
            let _ = self.event_sender.send(event);
        }
        Ok(())
    }

    async fn commit_environment(
        &self,
        handshake: LoopxCliResult<LoopxCliManifest>,
        workspace: LoopxHostResult<LoopxWorkspaceProbeResult>,
        agent: LoopxHostResult<LoopxAgentProbeResult>,
        github_auth: LoopxGithubAuthProbe,
    ) -> Result<(), String> {
        let _mutation = self.mutation_lock.lock().await;
        let mut state = self.state.write().await;
        let checked_at = Some(now_ms());
        let (sidecar, python_fallback, node_runtime) = match handshake {
            Ok(manifest) => {
                let node_runtime = loopx_node_environment_fact(&manifest.node_runtime, checked_at);
                let python_fallback =
                    if manifest.executable.source == LoopxCliSource::PythonFallback {
                        LoopxEnvironmentFact {
                            status: LoopxEnvironmentFactStatus::Available,
                            version: Some("Python 3.11+".to_string()),
                            detail: Some(
                                "Managed LoopX source runs in isolated Python mode".to_string(),
                            ),
                            checked_at,
                            ..LoopxEnvironmentFact::default()
                        }
                    } else {
                        LoopxEnvironmentFact {
                            status: LoopxEnvironmentFactStatus::Unknown,
                            detail: Some("Not required by the selected LoopX runtime".to_string()),
                            checked_at,
                            ..LoopxEnvironmentFact::default()
                        }
                    };
                (
                    LoopxEnvironmentFact {
                        status: LoopxEnvironmentFactStatus::Available,
                        version: Some(manifest.loopx_version),
                        detail: Some(manifest.executable.identity),
                        checked_at,
                        ..LoopxEnvironmentFact::default()
                    },
                    python_fallback,
                    node_runtime,
                )
            }
            Err(error)
                if matches!(
                    error.kind,
                    LoopxCliErrorKind::NotFound | LoopxCliErrorKind::VersionMismatch
                ) =>
            {
                (
                    unavailable_loopx_environment_fact(error.to_string(), checked_at),
                    LoopxEnvironmentFact::default(),
                    checking_environment_fact(checked_at),
                )
            }
            Err(error) => (
                unavailable_environment_fact(error.to_string(), checked_at),
                LoopxEnvironmentFact::default(),
                checking_environment_fact(checked_at),
            ),
        };
        let git_worktree = match workspace {
            Ok(probe) => LoopxEnvironmentFact {
                status: LoopxEnvironmentFactStatus::Available,
                version: probe.git_version,
                detail: Some(format!("Writable workspace root: {}", probe.workspace_root)),
                checked_at,
                ..LoopxEnvironmentFact::default()
            },
            Err(error) => unavailable_environment_fact(error.to_string(), checked_at),
        };
        let agent_model = match agent {
            Ok(probe) => LoopxEnvironmentFact {
                status: LoopxEnvironmentFactStatus::Available,
                version: Some(probe.model_id),
                detail: Some("Configured Agent model is enabled for text chat".to_string()),
                checked_at,
                ..LoopxEnvironmentFact::default()
            },
            Err(error) => unavailable_environment_fact(error.to_string(), checked_at),
        };
        let github_auth = LoopxEnvironmentFact {
            status: github_auth_fact_status(&github_auth),
            detail: github_auth.detail,
            checked_at,
            ..LoopxEnvironmentFact::default()
        };
        state.environment.revision = state.environment.revision.saturating_add(1);
        state.environment.checked_at = checked_at;
        state.environment.core.sidecar = sidecar;
        state.environment.core.node_runtime = node_runtime;
        state.environment.core.git_worktree = git_worktree;
        state.environment.core.agent_model = agent_model;
        state.environment.optional.python_fallback = python_fallback;
        state.environment.optional.github_auth = github_auth;
        state.environment.status =
            derive_environment_status(&state.environment.core, &state.environment.optional);
        let status = state.environment.status;
        state.revision = state.revision.saturating_add(1);
        state.append_event(LoopxEvent {
            kind: LoopxEventKind::EnvironmentChanged,
            level: if status == LoopxEnvironmentStatus::Blocked {
                LoopxEventLevel::Error
            } else {
                LoopxEventLevel::Info
            },
            source: LoopxEventSource::System,
            message: format!("LoopX environment validation finished with status {status:?}"),
            important: status == LoopxEnvironmentStatus::Blocked,
            occurred_at: now_ms(),
            ..LoopxEvent::default()
        });
        let persisted = state.clone();
        let event = persisted.events.last().cloned();
        drop(state);
        self.store.save(&persisted).await?;
        if let Some(event) = event {
            let _ = self.event_sender.send(event);
        }
        Ok(())
    }

    async fn record_progress(&self, progress: Vec<LoopxCliProgress>) -> Result<(), String> {
        if progress.is_empty() {
            return Ok(());
        }
        let _mutation = self.mutation_lock.lock().await;
        let mut state = self.state.write().await;
        let start_cursor = state.cursor;
        for item in progress {
            if is_normal_process_lifecycle_message(&item.message) {
                continue;
            }
            state.append_event(LoopxEvent {
                task_id: item.task_id,
                kind: LoopxEventKind::Progress,
                source: LoopxEventSource::Sidecar,
                message: item.message,
                occurred_at: item.occurred_at,
                ..LoopxEvent::default()
            });
        }
        let persisted = state.clone();
        drop(state);
        self.store.save(&persisted).await?;
        self.broadcast_new_events(&persisted, start_cursor);
        Ok(())
    }

    async fn bind_workspace(
        &self,
        task_id: &str,
        generation: u64,
        workspace: &LoopxWorkspacePrepareResult,
    ) -> Result<(), String> {
        self.mutate_task(task_id, None, |task, runtime| {
            if task.generation != generation {
                return;
            }
            task.workspace_path = Some(workspace.worktree_path.clone());
            task.phase = LoopxPhase::CreatingGoal;
            task.revision = task.revision.saturating_add(1);
            runtime.registry_path = workspace.registry_path.clone();
            // Seed the pinned LoopX references into the worktree as TWO files
            // so the agent loads only the authoritative skill document up
            // front and consults the CLI help text on demand:
            // - pinned-loopx-skill.md: official workflow-skill documents (the
            //   exact schemas/flags; must-read once per session).
            // - pinned-loopx-cli-help.md: generator `--help` text (only when
            //   the agent needs to verify a specific flag; NOT preloaded).
            // 2026-09-08: a single 125KB blob caused the agent to read it 3x
            // and bloat the context (skill text after the help text, so the
            // helpful part was buried), which made each turn slower.
            // NOTE: create the `.loopx` directory first - at this point of the
            // prepare flow bootstrap has not run yet, so it may not exist.
            let reference_dir = std::path::Path::new(&workspace.worktree_path).join(".loopx");
            let _ = std::fs::create_dir_all(&reference_dir);
            let _ = std::fs::write(
                reference_dir.join("pinned-loopx-skill.md"),
                LOOPX_PINNED_SKILLS_REFERENCE,
            );
            let _ = std::fs::write(
                reference_dir.join("pinned-loopx-cli-help.md"),
                LOOPX_PINNED_CLI_REFERENCE,
            );
            // Deliver the remaining official workflow-skill documents of the
            // pinned revision (custom-host guide: the host delivers the full
            // skill set from the same revision; the agent reads the one that
            // applies to the active step).
            let _ = std::fs::write(
                reference_dir.join("loopx-doc-registry.md"),
                LOOPX_PINNED_SKILL_DOC_REGISTRY,
            );
            let _ = std::fs::write(
                reference_dir.join("loopx-pr-program.md"),
                LOOPX_PINNED_SKILL_PR_PROGRAM,
            );
            let _ = std::fs::write(
                reference_dir.join("loopx-pr-review.md"),
                LOOPX_PINNED_SKILL_PR_REVIEW,
            );
            let _ = std::fs::write(
                reference_dir.join("loopx-change-quality.md"),
                LOOPX_PINNED_SKILL_CHANGE_QUALITY,
            );
        })
        .await
        .map(|_| ())
    }

    async fn bind_goal(
        &self,
        task_id: &str,
        generation: u64,
        goal: LoopxCliCreateGoalResult,
    ) -> Result<(), String> {
        self.mutate_task(task_id, None, |task, runtime| {
            if task.generation != generation {
                return;
            }
            task.goal_id = Some(goal.goal_id.clone());
            task.goal_state = Some(LoopxCliGoalState::Active);
            task.state = LoopxTaskState::Queued;
            task.phase = LoopxPhase::InspectingGoal;
            task.revision = task.revision.saturating_add(1);
            runtime.expected_durable_revision = Some(goal.durable_revision.clone());
        })
        .await
        .map(|_| ())
    }

    async fn record_goal_state(
        &self,
        task: &LoopxTaskSnapshot,
        goal_state: LoopxCliGoalState,
    ) -> Result<(), String> {
        if task.goal_state == Some(goal_state) {
            return Ok(());
        }
        self.mutate_task(&task.task_id, None, |current, _| {
            if current.generation != task.generation {
                return;
            }
            current.goal_state = Some(goal_state);
            current.revision = current.revision.saturating_add(1);
        })
        .await
        .map(|_| ())
    }

    /// Persists the bounded LoopX frontier-todo projection for UI display.
    /// The projection is written only when it actually changes so heartbeat
    /// polling does not churn the durable revision.
    async fn record_current_todo(
        &self,
        task_id: &str,
        generation: u64,
        todo: Option<LoopxCurrentTodo>,
    ) -> Result<(), String> {
        self.mutate_task(task_id, None, |current, _| {
            if current.generation != generation || current.current_todo == todo {
                return;
            }
            current.current_todo = todo;
            current.revision = current.revision.saturating_add(1);
        })
        .await
        .map(|_| ())
    }

    async fn apply_goal_projection(
        &self,
        expected: &LoopxTaskSnapshot,
        goal: &LoopxCliGoalSnapshot,
    ) -> Result<(), String> {
        let projection = project_host_task_from_goal(expected.state, expected.phase, goal.state);
        let preserve_pending_gate = preserve_unanswered_local_gate(expected, goal);
        let pending_gate_id = if preserve_pending_gate {
            expected.pending_gate_id.as_deref()
        } else {
            goal.pending_user_gate
                .as_ref()
                .map(|gate| gate.gate_id.as_str())
        };
        let pending_gate_message = if preserve_pending_gate {
            expected.pending_gate_message.as_deref()
        } else {
            goal.pending_user_gate
                .as_ref()
                .map(|gate| gate.message.as_str())
        };
        let pending_gate_action_kind = if preserve_pending_gate {
            expected.pending_gate_action_kind.as_deref()
        } else {
            goal.pending_user_gate
                .as_ref()
                .and_then(|gate| gate.action_kind.as_deref())
        };
        if expected.goal_state == Some(goal.state)
            && expected.state == projection.state
            && expected.phase == projection.phase
            && expected.pending_gate_id.as_deref() == pending_gate_id
            && expected.pending_gate_message.as_deref() == pending_gate_message
            && expected.pending_gate_action_kind.as_deref() == pending_gate_action_kind
        {
            return Ok(());
        }

        let host_state_changed = expected.state != projection.state;
        let updated = self
            .mutate_task(&expected.task_id, None, |task, runtime| {
                if task.generation != expected.generation {
                    return;
                }
                let preserve_pending_gate = preserve_unanswered_local_gate(task, goal);
                let current = project_host_task_from_goal(task.state, task.phase, goal.state);
                task.goal_state = Some(goal.state);
                task.state = current.state;
                task.phase = current.phase;
                if current.state == LoopxTaskState::Completed {
                    task.current_todo = None;
                }
                // The authoritative Goal projection is healthy again: a stale
                // environment-level error (for example a coordination store
                // schema rejection from a cross-build data home) must not keep
                // resurfacing on a task that is demonstrably running.
                if !matches!(
                    current.state,
                    LoopxTaskState::RecoveryRequired | LoopxTaskState::Failed
                ) {
                    task.error = None;
                }
                if !preserve_pending_gate {
                    task.pending_gate_id = goal
                        .pending_user_gate
                        .as_ref()
                        .map(|gate| gate.gate_id.clone());
                    task.pending_gate_message = goal
                        .pending_user_gate
                        .as_ref()
                        .map(|gate| gate.message.clone());
                    task.pending_gate_action_kind = goal
                        .pending_user_gate
                        .as_ref()
                        .and_then(|gate| gate.action_kind.clone());
                }
                task.revision = task.revision.saturating_add(1);
                runtime.expected_durable_revision = Some(goal.durable_revision.clone());
                if task.state.is_terminal() {
                    task.current_turn_id = None;
                    task.current_tool = None;
                    task.deadline_at = None;
                    task.retry_at = None;
                }
            })
            .await?;

        if host_state_changed {
            self.append_task_event(
                &updated,
                LoopxEventKind::SnapshotInvalidated,
                "BitFun host task reconciled with authoritative LoopX Goal state",
                false,
            )
            .await?;
            if updated.state == LoopxTaskState::Queued {
                self.enqueue_task(updated.task_id.clone(), Duration::ZERO)?;
            }
        }
        Ok(())
    }

    async fn bind_turn(
        &self,
        task: &LoopxTaskSnapshot,
        turn: &LoopxCliBuildTurnResult,
    ) -> Result<(), String> {
        let generation = task.generation;
        self.mutate_task(&task.task_id, None, |task, runtime| {
            if task.generation != generation {
                return;
            }
            task.phase = LoopxPhase::StartingAgent;
            task.deadline_at = turn.deadline_at;
            task.current_turn_id = Some(turn.turn_id.clone());
            task.revision = task.revision.saturating_add(1);
            runtime.loopx_turn_id = Some(turn.turn_id.clone());
            runtime.settlement_token = Some(turn.settlement_token.clone());
            runtime.expected_durable_revision = Some(turn.durable_revision.clone());
        })
        .await
        .map(|_| ())
    }

    async fn bind_agent_run(
        &self,
        task: &LoopxTaskSnapshot,
        run: LoopxAgentStartResult,
    ) -> Result<(), String> {
        let updated = self
            .mutate_task(&task.task_id, None, |task, runtime| {
                task.state = LoopxTaskState::Running;
                task.phase = LoopxPhase::AgentRunning;
                task.current_turn_id = Some(run.turn_id.clone());
                task.last_output_at = Some(now_ms());
                task.revision = task.revision.saturating_add(1);
                runtime.session_id = Some(run.session_id.clone());
                runtime.agent_turn_id = Some(run.turn_id.clone());
            })
            .await?;
        self.append_task_event(
            &updated,
            LoopxEventKind::StateChanged,
            "Agent turn started",
            false,
        )
        .await
    }

    async fn transition_task(
        &self,
        task_id: &str,
        generation: u64,
        state: LoopxTaskState,
        phase: LoopxPhase,
        message: &str,
    ) -> Result<LoopxTaskSnapshot, String> {
        let updated = self
            .mutate_task(task_id, None, |task, _| {
                if task.generation != generation {
                    return;
                }
                task.state = state;
                task.phase = phase;
                if state != LoopxTaskState::WaitingForUser {
                    task.pending_gate_id = None;
                    task.pending_gate_message = None;
                    task.pending_gate_action_kind = None;
                }
                task.revision = task.revision.saturating_add(1);
            })
            .await?;
        self.append_task_event(
            &updated,
            LoopxEventKind::StateChanged,
            message,
            state == LoopxTaskState::RecoveryRequired,
        )
        .await?;
        Ok(updated)
    }

    async fn transition_action(
        &self,
        task_id: &str,
        state: LoopxTaskState,
        phase: LoopxPhase,
        request_id: &str,
    ) -> Result<LoopxActionResponse, String> {
        let updated = self
            .mutate_task(task_id, Some(request_id), |task, _| {
                task.state = state;
                task.phase = phase;
                task.recovery_reason = if state == LoopxTaskState::RecoveryRequired {
                    Some("manual_restore".to_string())
                } else {
                    None
                };
                if state != LoopxTaskState::WaitingForUser {
                    task.pending_gate_id = None;
                    task.pending_gate_message = None;
                    task.pending_gate_action_kind = None;
                }
                task.revision = task.revision.saturating_add(1);
            })
            .await?;
        Ok(LoopxActionResponse {
            current_revision: updated.revision,
            task: Some(updated),
            ..LoopxActionResponse::default()
        })
    }

    async fn update_task_phase(
        &self,
        task_id: &str,
        generation: u64,
        phase: LoopxPhase,
        message: &str,
    ) -> Result<(), String> {
        let updated = self
            .mutate_task(task_id, None, |task, _| {
                if task.generation != generation {
                    return;
                }
                task.phase = phase;
                task.revision = task.revision.saturating_add(1);
            })
            .await?;
        self.append_task_event(&updated, LoopxEventKind::PhaseChanged, message, false)
            .await
    }

    async fn fail_task(self: &Arc<Self>, task_id: &str, error: String) -> Result<(), String> {
        log::error!("LoopX task failed: task_id={} error={}", task_id, error);
        let updated = self
            .mutate_task(task_id, None, |task, _| {
                let workspace_was_never_prepared = task.workspace_path.is_none()
                    && task.goal_id.is_none()
                    && task.current_turn_id.is_none();
                task.state = if workspace_was_never_prepared {
                    LoopxTaskState::Failed
                } else {
                    LoopxTaskState::RecoveryRequired
                };
                task.phase = if workspace_was_never_prepared {
                    LoopxPhase::Finished
                } else {
                    LoopxPhase::Recovering
                };
                task.pending_gate_id = None;
                task.pending_gate_message = None;
                task.pending_gate_action_kind = None;
                task.error = Some(error.clone());
                task.recovery_reason = Some("execution_failure".to_string());
                task.deadline_at = None;
                task.revision = task.revision.saturating_add(1);
            })
            .await?;
        self.append_task_event(&updated, LoopxEventKind::StateChanged, &error, true)
            .await?;
        self.schedule_next_for_repository(
            &updated.identity.item.repository.canonical_id(),
            Some(&updated.task_id),
        )
        .await;
        Ok(())
    }

    /// Parks a task whose Goal is still Active after its plan ran dry. This
    /// is the mandated recovery for the `RunNow + 0 open todo` frontier
    /// contradiction: the host never fabricates a terminal Goal transition.
    /// Unlike [`Self::fail_task`] it records an explicit, stable reason
    /// (`plan_exhausted`) so the recovery card can offer targeted guidance
    /// instead of a generic execution failure, and it still yields the
    /// repository slot to queued sibling issues.
    async fn park_plan_exhausted(
        self: &Arc<Self>,
        task: &LoopxTaskSnapshot,
        goal_id: &str,
    ) -> Result<(), String> {
        log::warn!(
            "LoopX plan exhausted, parking for owner decision: task_id={} goal={}",
            task.task_id,
            goal_id
        );
        let message = LOOPX_PLAN_EXHAUSTED_MESSAGE;
        let updated = self
            .mutate_task(&task.task_id, None, |current, _| {
                current.state = LoopxTaskState::RecoveryRequired;
                current.phase = LoopxPhase::Recovering;
                current.recovery_reason = Some(LOOPX_PLAN_EXHAUSTED_REASON.to_string());
                current.error = Some(message.to_string());
                current.pending_gate_id = None;
                current.pending_gate_message = None;
                current.pending_gate_action_kind = None;
                current.deadline_at = None;
                current.revision = current.revision.saturating_add(1);
            })
            .await?;
        self.append_task_event(&updated, LoopxEventKind::StateChanged, message, true)
            .await?;
        self.schedule_next_for_repository(
            &updated.identity.item.repository.canonical_id(),
            Some(&updated.task_id),
        )
        .await;
        Ok(())
    }

    /// Best-effort cleanup of the task's on-disk worktree. Called only from
    /// the explicit Archive action; failure is recorded as an event, never
    /// fatal to the transition.
    async fn dispose_task_workspace(self: &Arc<Self>, task: &LoopxTaskSnapshot) {
        if task.workspace_path.is_none() {
            return;
        }
        let progress = BufferedProgress::default();
        let result = self
            .workspace
            .dispose(LoopxWorkspaceDisposeRequest {
                operation_id: format!("dispose-{}", uuid::Uuid::new_v4()),
                task_id: task.task_id.clone(),
                item: task.identity.item.clone(),
            })
            .await
            .map_err(|error| error.message.clone());
        self.record_progress(progress.take()).await.ok();
        let important = result.is_err();
        let message = match result {
            Ok(disposed) if disposed.removed => {
                "Archived task worktree cleaned up (disk space released)".to_string()
            }
            Ok(_) => "Archived task had no managed worktree to clean up".to_string(),
            Err(error) => {
                // Keep the archive transition; surface cleanup failure.
                format!("Failed to clean up archived task worktree: {error}")
            }
        };
        let _ = self
            .append_task_event(task, LoopxEventKind::StateChanged, &message, important)
            .await;
    }

    async fn schedule_next_for_repository(
        self: &Arc<Self>,
        repository_id: &str,
        exclude_task_id: Option<&str>,
    ) -> bool {
        if let Some(owner) = exclude_task_id {
            let mut active = self.active_repositories.lock().await;
            if active.get(repository_id).map(String::as_str) == Some(owner) {
                active.remove(repository_id);
            }
        }
        if self.state.read().await.suspended {
            return false;
        }
        let next = {
            let state = self.state.read().await;
            state
                .tasks
                .iter()
                .find(|task| {
                    // Preparing joins Queued as schedulable: a reserved task
                    // whose drive never completed would otherwise stall the
                    // whole repository line once the running slot frees up.
                    // Re-driving it is safe — reserve_repository bounces the
                    // task back to Queued when the slot is still taken.
                    matches!(
                        task.state,
                        LoopxTaskState::Queued | LoopxTaskState::Preparing
                    ) && task.identity.item.repository.canonical_id() == repository_id
                        && exclude_task_id != Some(task.task_id.as_str())
                })
                .map(|task| task.task_id.clone())
        };
        if let Some(task_id) = next {
            self.enqueue_task(task_id, Duration::ZERO).is_ok()
        } else {
            false
        }
    }

    async fn enqueue_ready_tasks_after_load(&self) {
        if self.load_error.read().await.is_some() {
            return;
        }
        if self.state.read().await.suspended {
            return;
        }
        let task_ids = {
            let state = self.state.read().await;
            state
                .tasks
                .iter()
                .filter(|task| task.state == LoopxTaskState::Queued)
                .map(|task| task.task_id.clone())
                .collect::<Vec<_>>()
        };
        for task_id in task_ids {
            let _ = self.enqueue_task(task_id, Duration::ZERO);
        }
    }

    fn enqueue_task(&self, task_id: String, delay: Duration) -> Result<(), String> {
        if !delay.is_zero() {
            let sender = self.task_sender.clone();
            tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                let _ = sender.send(ScheduledTask { task_id });
            });
            return Ok(());
        }
        self.task_sender
            .send(ScheduledTask { task_id })
            .map_err(|_| "LoopX controller task runner is unavailable".to_string())
    }

    async fn reserve_scheduled_task(&self, task_id: &str) -> bool {
        let mut active = self.active_tasks.lock().await;
        match active.get_mut(task_id) {
            Some(pending) => {
                *pending = true;
                false
            }
            None => {
                active.insert(task_id.to_string(), false);
                true
            }
        }
    }

    async fn release_scheduled_task(&self, task_id: &str) -> bool {
        self.active_tasks
            .lock()
            .await
            .remove(task_id)
            .unwrap_or(false)
    }

    async fn suppress_pending_task_rerun(&self, task_id: &str) {
        if let Some(pending) = self.active_tasks.lock().await.get_mut(task_id) {
            *pending = false;
        }
    }

    async fn mutate_task(
        &self,
        task_id: &str,
        request_id: Option<&str>,
        update: impl FnOnce(&mut LoopxTaskSnapshot, &mut LoopxTaskRuntimeRecord),
    ) -> Result<LoopxTaskSnapshot, String> {
        let _mutation = self.mutation_lock.lock().await;
        let mut state = self.state.write().await;
        let task_index = state
            .tasks
            .iter()
            .position(|task| task.task_id == task_id)
            .ok_or_else(|| "LoopX task not found".to_string())?;
        let mut runtime = state.runtime.remove(task_id).unwrap_or_default();
        update(&mut state.tasks[task_index], &mut runtime);
        state.tasks[task_index].updated_at = now_ms();
        let updated = state.tasks[task_index].clone();
        state.runtime.insert(task_id.to_string(), runtime);
        state.revision = state.revision.saturating_add(1);
        if let Some(request_id) = request_id {
            state.record_processed_request(request_id.to_string());
        }
        let persisted = state.clone();
        drop(state);
        self.store.save(&persisted).await?;
        Ok(updated)
    }

    async fn append_task_event(
        &self,
        task: &LoopxTaskSnapshot,
        kind: LoopxEventKind,
        message: &str,
        important: bool,
    ) -> Result<(), String> {
        self.append_task_event_with_details(task, kind, message, important, BTreeMap::new())
            .await
    }

    async fn append_task_event_with_details(
        &self,
        task: &LoopxTaskSnapshot,
        kind: LoopxEventKind,
        message: &str,
        important: bool,
        details: BTreeMap<String, String>,
    ) -> Result<(), String> {
        let _mutation = self.mutation_lock.lock().await;
        let mut state = self.state.write().await;
        state.append_event(LoopxEvent {
            task_id: Some(task.task_id.clone()),
            generation: Some(task.generation),
            revision: Some(task.revision),
            kind,
            level: if kind == LoopxEventKind::ApprovalRequired {
                LoopxEventLevel::Warning
            } else if important {
                LoopxEventLevel::Error
            } else {
                LoopxEventLevel::Info
            },
            source: LoopxEventSource::Controller,
            phase: Some(task.phase),
            message: message.to_string(),
            important,
            details,
            occurred_at: now_ms(),
            ..LoopxEvent::default()
        });
        let persisted = state.clone();
        let event = persisted.events.last().cloned();
        drop(state);
        self.store.save(&persisted).await?;
        if let Some(event) = event {
            let _ = self.event_sender.send(event);
        }
        Ok(())
    }

    async fn task(&self, task_id: &str) -> Result<LoopxTaskSnapshot, String> {
        self.state
            .read()
            .await
            .tasks
            .iter()
            .find(|task| task.task_id == task_id)
            .cloned()
            .ok_or_else(|| "LoopX task not found".to_string())
    }

    async fn runtime(&self, task_id: &str) -> LoopxTaskRuntimeRecord {
        self.state
            .read()
            .await
            .runtime
            .get(task_id)
            .cloned()
            .unwrap_or_default()
    }

    async fn ensure_writable(&self) -> Result<(), String> {
        match self.load_error.read().await.clone() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    async fn persist_current(&self) -> Result<(), String> {
        let state = self.state.read().await.clone();
        self.store.save(&state).await
    }

    fn broadcast_new_events(&self, state: &LoopxPersistedState, after_cursor: u64) {
        for event in state
            .events
            .iter()
            .filter(|event| event.cursor > after_cursor)
        {
            let _ = self.event_sender.send(event.clone());
        }
    }

    fn goal_context(
        &self,
        task: &LoopxTaskSnapshot,
        runtime: &LoopxTaskRuntimeRecord,
    ) -> LoopxCliGoalContext {
        LoopxCliGoalContext {
            call: LoopxCliCallContext {
                operation_id: runtime.operation_id.clone(),
                deadline_at: task.deadline_at,
            },
            task_id: task.task_id.clone(),
            generation: task.generation,
            worktree_path: task.workspace_path.clone().unwrap_or_default(),
            registry_path: runtime.registry_path.clone(),
            available_capabilities: self.agent_capabilities.clone(),
        }
    }
}

fn is_normal_process_lifecycle_message(message: &str) -> bool {
    matches!(
        message,
        "Starting LoopX process" | "LoopX process exited successfully"
    )
}

fn task_has_bound_goal(task: &LoopxTaskSnapshot) -> bool {
    task.goal_id
        .as_deref()
        .is_some_and(|goal_id| !goal_id.trim().is_empty())
}

/// The bound goal's workspace directory is gone from disk; the task must
/// re-run the prepare + connect flow instead of spawning CLI processes
/// against an invalid working directory.
fn bound_workspace_missing(task: &LoopxTaskSnapshot) -> bool {
    task.workspace_path
        .as_deref()
        .map(|path| !std::path::Path::new(path).exists())
        .unwrap_or(false)
}

fn is_repository_recovery_candidate(task: &LoopxTaskSnapshot, repository_id: &str) -> bool {
    decide_repository_recovery_candidate(task, repository_id)
}
/// Whether `apply_settlement` should re-inspect the durable Goal after a
/// settlement before deciding the task's next state.
///
/// `Settled`/`AlreadySettled` keep today's behavior (any non-failed agent
/// status). `RetryRequired` from a COMPLETED turn is the pinned CLI's
/// false-negative settlement: the durable writeback matched but the quota
/// spend receipt is missing (observed live 2026-09-05 on dsh-desktop#830,
/// whose final onboarding turn closed the goal vision but skipped
/// `quota spend-slot`), so the authoritative Goal projection — not the
/// missing bookkeeping receipt — decides what happens next, and a
/// corrective turn is not an option because a terminal frontier refuses
/// the quota guard. `RetryRequired` from a cancelled or interrupted turn
/// keeps the explicit recovery path: the owner interrupted that turn, so
/// the host does not silently re-drive it. A failed agent turn and
/// `NoDurableProgress` (no validated writeback) keep their existing paths.
fn inspects_goal_after_settlement(
    agent_status: LoopxAgentTurnStatus,
    settlement_status: LoopxCliSettlementStatus,
) -> bool {
    match settlement_status {
        LoopxCliSettlementStatus::Settled | LoopxCliSettlementStatus::AlreadySettled => {
            agent_status != LoopxAgentTurnStatus::Failed
        }
        LoopxCliSettlementStatus::RetryRequired => agent_status == LoopxAgentTurnStatus::Completed,
        LoopxCliSettlementStatus::NoDurableProgress | LoopxCliSettlementStatus::GoalCompleted => {
            false
        }
    }
}

/// Decides the task state after a turn settlement. When the post-settlement
/// Goal inspection produced a snapshot, the CLI's authoritative projection
/// wins: this covers normal settled turns and the false-negative
/// `RetryRequired` settlement (validated writeback, missing quota receipt;
/// see [`inspects_goal_after_settlement`]). Without a snapshot (inspection
/// failed or not attempted), the settlement status alone decides — missing
/// durable progress or a missing receipt then parks in explicit recovery.
fn task_state_after_settlement(
    agent_status: LoopxAgentTurnStatus,
    settlement_status: LoopxCliSettlementStatus,
    post_settlement_goal: Option<&LoopxCliGoalSnapshot>,
) -> LoopxTaskState {
    if agent_status == LoopxAgentTurnStatus::Failed {
        return LoopxTaskState::RecoveryRequired;
    }
    if let Some(goal) = post_settlement_goal {
        return match goal.run_decision {
            LoopxCliRunDecision::WaitingForUser => LoopxTaskState::WaitingForUser,
            LoopxCliRunDecision::Complete => LoopxTaskState::Completed,
            LoopxCliRunDecision::Failed => LoopxTaskState::RecoveryRequired,
            LoopxCliRunDecision::RunNow | LoopxCliRunDecision::Wait => LoopxTaskState::Queued,
        };
    }
    match settlement_status {
        LoopxCliSettlementStatus::GoalCompleted => LoopxTaskState::Completed,
        LoopxCliSettlementStatus::Settled | LoopxCliSettlementStatus::AlreadySettled => {
            LoopxTaskState::Queued
        }
        LoopxCliSettlementStatus::NoDurableProgress | LoopxCliSettlementStatus::RetryRequired => {
            LoopxTaskState::RecoveryRequired
        }
    }
}

/// Pure witness for the RunNow frontier contradiction described in
/// `drive_turn`: the envelope must itself assert there is nothing to do.
fn run_now_is_frontier_contradiction(
    open_todo_count: u32,
    waiting_user_todo_count: u32,
    has_selected_todo: bool,
) -> bool {
    open_todo_count == 0 && waiting_user_todo_count == 0 && !has_selected_todo
}

/// What the host does with a todo-less `RunNow` frontier. Runtime-data
/// correction (2026-09-05 five-issue run, re-verified against v1.0.1): the
/// pinned CLI projects `should_run=true` with an autonomous replan obligation
/// when the plan runs
/// dry, and expects the host to drive one bounded replan turn bound to that
/// obligation — parking there stranded every task of that run. Only a
/// todo-less frontier WITHOUT an open obligation is a contract contradiction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TodolessRunNowFrontier {
    /// Drive one autonomous replan turn bound to the open obligation: the
    /// agent writes back a successor todo, a typed terminal outcome, or a
    /// concrete blocker; settlement validates by the `autonomous_replan`
    /// effect id and the CLI's replan stall threshold bounds no-op cycles.
    DriveReplanTurn,
    /// No actionable frontier remains: park with `plan_exhausted` for an
    /// owner decision.
    Park,
}

fn todoless_run_now_frontier(pending_replan_obligation_id: Option<&str>) -> TodolessRunNowFrontier {
    if pending_replan_obligation_id.is_some_and(|value| !value.trim().is_empty()) {
        TodolessRunNowFrontier::DriveReplanTurn
    } else {
        TodolessRunNowFrontier::Park
    }
}

/// Read-only LoopX user gates: public issue/comment metadata access is
/// agent work, not an owner decision. New read-only gate kinds must be
/// added here deliberately; external-write gates always stay interactive.
fn is_read_only_user_gate(action_kind: Option<&str>) -> bool {
    let Some(kind) = action_kind.map(str::trim) else {
        return false;
    };
    kind == "approve_github_issue_body_or_comment_read"
        || (kind.starts_with("approve_") && kind.ends_with("_read"))
}

/// Reuse-existing-PR merge gates. LoopX may project these without a typed
/// action kind, so the envelope message carries the semantics.
fn is_reuse_merge_user_gate(action_kind: Option<&str>, message: &str) -> bool {
    let kind = action_kind
        .map(str::trim)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let message_lower = message.to_ascii_lowercase();
    kind.contains("merge")
        || kind.contains("reuse")
        || message_lower.contains("merge pr #")
        || message_lower.contains("reuse existing pr")
}

fn reuse_merge_pr_label(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    let index = match lower.find("pr #") {
        Some(index) => index + 3,
        None => return "the referenced PR".to_string(),
    };
    let digits: String = message[index..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    if digits.is_empty() {
        "the referenced PR".to_string()
    } else {
        format!("PR #{digits}")
    }
}

fn phase_after_settlement(state: LoopxTaskState) -> LoopxPhase {
    match state {
        LoopxTaskState::Completed => LoopxPhase::Finished,
        LoopxTaskState::RecoveryRequired => LoopxPhase::Recovering,
        LoopxTaskState::WaitingForUser => LoopxPhase::WaitingForApproval,
        _ => LoopxPhase::Queued,
    }
}

fn should_requeue_after_settlement(final_state: LoopxTaskState, yielded_repository: bool) -> bool {
    final_state == LoopxTaskState::Queued && !yielded_repository
}

/// Depth-first repository lane: after a cleanly settled segment, the same task
/// keeps the slot and continues while its Goal is still runnable. Yield to the
/// next queued issue only when the Goal actually paused (user gate, cadence
/// wait, terminal, recovery) or the post-settlement inspection failed to
/// project a decision — a re-drive re-inspects and parks at the gate, so
/// treating an unknown decision as runnable is self-correcting. A monitor
/// successor needs no special case on v1.0.1: LoopX projects it RunNow only
/// when the monitor is actually due, and as a cadence wait otherwise.
fn sticky_continue_after_settlement(
    final_state: LoopxTaskState,
    post_settlement_run_decision: Option<LoopxCliRunDecision>,
) -> bool {
    if final_state != LoopxTaskState::Queued {
        return false;
    }
    match post_settlement_run_decision {
        None => true,
        Some(decision) => matches!(decision, LoopxCliRunDecision::RunNow),
    }
}

/// Requeue delay for a waiting goal, translated from the pinned LoopX v1.0.1
/// scheduler projection. The compacted turn envelope carries the decision's
/// `cadence_class` label but omits numeric intervals (they live in the quota
/// decision detail the envelope compacts away), so the host maps the label
/// onto the pinned scheduler's own initial intervals
/// (`loopx/control_plane/scheduler/scheduler_hint.py`: active_work 3m,
/// monitor_wait 15m host floor, human_gate 30m, quiet_wait 30m,
/// unchanged_noop 60m, agent_scope_wait 10m). Unknown or missing labels fall
/// back to a bounded poll so a waiting goal can never sleep forever or
/// hot-poll.
fn wait_requeue_delay_ms(snapshot: &LoopxCliGoalSnapshot) -> u64 {
    match snapshot.scheduler_cadence.as_deref() {
        Some("active_work") => 3 * 60 * 1000,
        Some("monitor_wait") => 15 * 60 * 1000,
        Some("human_gate") => 30 * 60 * 1000,
        Some("quiet_wait") => 30 * 60 * 1000,
        Some("unchanged_noop") => 60 * 60 * 1000,
        Some("agent_scope_wait") => 10 * 60 * 1000,
        _ => WAIT_RESCHEDULE_FALLBACK_MS,
    }
}

fn goal_id_for(identity: &LoopxTaskIdentity) -> String {
    let item = &identity.item;
    let kind = match item.kind {
        LoopxItemKind::Issue => "issue",
        LoopxItemKind::PullRequest => "pr",
    };
    let suffix = if identity.attempt > 1 {
        format!("-{}", identity.attempt)
    } else {
        String::new()
    };
    format!(
        "bfx-{}-{}-{kind}-{}{}",
        item.repository.owner, item.repository.repository, item.number, suffix
    )
}

fn existing_outcomes(
    state: &LoopxPersistedState,
    selected: &std::collections::BTreeSet<LoopxIssueKey>,
) -> Vec<LoopxCreateTaskOutcome> {
    selected
        .iter()
        .map(|item| {
            let task = state
                .tasks
                .iter()
                .filter(|task| &task.identity.item == item)
                .max_by_key(|task| task.identity.attempt);
            LoopxCreateTaskOutcome {
                item: item.clone(),
                kind: LoopxCreateTaskOutcomeKind::OpenedExisting,
                task_id: task.map(|task| task.task_id.clone()),
                attempt: task.map(|task| task.identity.attempt),
                ..LoopxCreateTaskOutcome::default()
            }
        })
        .collect()
}

fn prune_intake_previews(previews: &mut HashMap<String, LoopxIntakePreview>, now: i64) {
    previews.retain(|_, preview| intake_preview_is_fresh(preview, now));
    if previews.len() <= MAX_INTAKE_PREVIEWS {
        return;
    }

    let mut by_age = previews
        .iter()
        .map(|(fingerprint, preview)| (fingerprint.clone(), preview.resolved_at))
        .collect::<Vec<_>>();
    by_age.sort_by_key(|(_, resolved_at)| *resolved_at);
    let excess = previews.len().saturating_sub(MAX_INTAKE_PREVIEWS);
    for (fingerprint, _) in by_age.into_iter().take(excess) {
        previews.remove(&fingerprint);
    }
}

fn intake_preview_is_fresh(preview: &LoopxIntakePreview, now: i64) -> bool {
    match preview.expires_at {
        Some(expires_at) => expires_at > now,
        None => false,
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn bounded_agent_summary(summary: &str) -> String {
    let mut chars = summary.chars();
    let bounded = chars
        .by_ref()
        .take(MAX_AGENT_SUMMARY_CHARS)
        .collect::<String>();
    if chars.next().is_some() {
        format!("{bounded}\n\n[Summary truncated by LoopX host]")
    } else {
        bounded
    }
}

fn github_auth_fact_status(probe: &LoopxGithubAuthProbe) -> LoopxEnvironmentFactStatus {
    if probe.authenticated {
        LoopxEnvironmentFactStatus::Available
    } else if probe.rate_limit_remaining.is_some() {
        LoopxEnvironmentFactStatus::Degraded
    } else {
        LoopxEnvironmentFactStatus::Unavailable
    }
}

/// Maps the CLI adapter's Node.js probe onto the environment fact surface.
/// A missing or too-old Node BLOCKS the environment (the pinned v1.0.x control
/// plane fail-closes bootstrap without it), with a concrete remediation that
/// names the minimum version instead of a generic failure.
fn loopx_node_environment_fact(
    probe: &openbitfun_product_domains::miniapp::loopx::LoopxNodeRuntimeFact,
    checked_at: Option<i64>,
) -> LoopxEnvironmentFact {
    LoopxEnvironmentFact {
        status: if probe.available {
            LoopxEnvironmentFactStatus::Available
        } else {
            LoopxEnvironmentFactStatus::Unavailable
        },
        version: probe.version.clone(),
        detail: probe.detail.clone(),
        remediation: (!probe.available).then(|| {
            "Install Node.js from https://nodejs.org (or via your package manager),              then re-check this environment"
                .to_string()
        }),
        checked_at,
        ..LoopxEnvironmentFact::default()
    }
}

fn checking_environment_fact(checked_at: Option<i64>) -> LoopxEnvironmentFact {
    LoopxEnvironmentFact {
        status: LoopxEnvironmentFactStatus::Checking,
        checked_at,
        ..LoopxEnvironmentFact::default()
    }
}

fn unavailable_environment_fact(
    detail: impl Into<String>,
    checked_at: Option<i64>,
) -> LoopxEnvironmentFact {
    LoopxEnvironmentFact {
        status: LoopxEnvironmentFactStatus::Unavailable,
        detail: Some(detail.into()),
        checked_at,
        ..LoopxEnvironmentFact::default()
    }
}

fn unavailable_loopx_environment_fact(
    detail: impl Into<String>,
    checked_at: Option<i64>,
) -> LoopxEnvironmentFact {
    LoopxEnvironmentFact {
        status: LoopxEnvironmentFactStatus::Unavailable,
        detail: Some(detail.into()),
        remediation: Some(
            "Download the pinned LoopX source from GitHub into BitFun-managed storage".to_string(),
        ),
        remediation_action: LoopxEnvironmentRemediationAction::InstallLoopx,
        checked_at,
        ..LoopxEnvironmentFact::default()
    }
}

/// Reconciliation may replace a local gate with a durable gate projection, but
/// it must never infer approval from an active Goal. Only an explicit gate
/// answer transitions the host task away from WaitingForUser.
fn preserve_unanswered_local_gate(task: &LoopxTaskSnapshot, goal: &LoopxCliGoalSnapshot) -> bool {
    task.state == LoopxTaskState::WaitingForUser
        && task.pending_gate_id.is_some()
        && goal.pending_user_gate.is_none()
        && !matches!(
            goal.state,
            LoopxCliGoalState::Completed | LoopxCliGoalState::Failed | LoopxCliGoalState::Archived
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_turn_instruction_always_carries_the_environment_boundary() {
        // The pinned LoopX runtime must not be steered by LoopX source
        // checkouts that happen to exist on the user's machine: the boundary
        // note is part of every turn instruction, first turn included.
        let composed = compose_agent_turn_instruction("turn body".to_string(), None, None, false);
        assert!(composed.starts_with("turn body"));
        assert!(composed.contains("[BitFun environment boundary]"));
        assert!(composed.contains("loopx/pyproject.toml"));
        assert!(!composed.contains("[BitFun host note]"));
    }

    #[test]
    fn agent_turn_instruction_keeps_host_note_after_the_boundary() {
        let composed = compose_agent_turn_instruction(
            "turn body".to_string(),
            Some("corrective guidance"),
            None,
            false,
        );
        let boundary = composed
            .find("[BitFun environment boundary]")
            .expect("boundary note present");
        let host_note = composed
            .find("[BitFun host note]")
            .expect("host note present");
        assert!(boundary < host_note);
        assert!(composed.ends_with("corrective guidance"));
    }

    #[test]
    fn fresh_session_turn_instruction_asks_for_a_one_time_reference_read() {
        let composed = compose_agent_turn_instruction(
            "turn body".to_string(),
            None,
            Some(r"C:\wt\.loopx\pinned-loopx-skill.md"),
            false,
        );
        assert!(composed.contains("[Pinned LoopX references - read exactly once]"));
        assert!(composed.contains("pinned-loopx-skill.md"));
        // The stale filename from the 2026-09-08 run must not come back: it
        // cost every turn one failed Read plus a recovery reasoning round.
        assert!(!composed.contains("pinned-loopx-reference.md"));
        // Cross-skill references resolve to the seeded sibling files, never
        // through the skill catalog (user-level `~/.codex/skills` may hold a
        // different LoopX version - observed 0.5.3 copies on this machine).
        assert!(composed.contains(".loopx/loopx-doc-registry.md"));
        assert!(composed.contains(".loopx/loopx-pr-program.md"));
        assert!(composed.contains(".loopx/loopx-pr-review.md"));
        assert!(composed.contains(".loopx/loopx-change-quality.md"));
        assert!(composed.contains("never resolve loopx skill names through your skill catalog"));
        // Single source of truth for the read policy: exactly one read
        // directive per fresh instruction (the pointer). The closing-ceremony
        // note below names the same file but must not issue its own read
        // instruction - agents execute it literally (observed 2026-09-08)
        // and a reused session would re-read the 59KB document every turn.
        assert_eq!(composed.matches("Read `").count(), 1);
        assert!(composed.contains("[BitFun host facts - closing ceremony]"));
        assert!(composed.contains("governed only by the pointer section above"));
    }

    #[test]
    fn continued_session_turn_instruction_reuses_the_loaded_reference() {
        let composed = compose_agent_turn_instruction(
            "turn body".to_string(),
            None,
            Some(r"C:\wt\.loopx\pinned-loopx-skill.md"),
            true,
        );
        assert!(composed.contains("[Pinned LoopX references - already loaded]"));
        assert!(composed.contains("remain the authoritative"));
        assert!(composed.contains("sibling documents"));
        assert!(!composed.contains("read exactly once]"));
        // No read directive at all on a continued turn: the document is
        // already in the conversation, and the closing-ceremony note defers
        // to the pointer instead of re-issuing a read.
        assert_eq!(composed.matches("Read `").count(), 0);
        assert!(composed.contains("pinned-loopx-skill.md"));
    }

    #[test]
    fn turn_instruction_blocks_loopx_skill_catalog_and_installer_drift() {
        // Version-drift guard: the environment boundary must forbid (a) the
        // user-level loopx-* skill copies a different LoopX install may have
        // placed in ~/.codex/skills / ~/.agents/skills, and (b) installer /
        // self-update flows the pinned skill documents describe - the host
        // owns the pinned binary. Without this, a session can load
        // different-version docs against the pinned runtime and, with session
        // reuse, carry the contradiction across every following turn.
        let composed = compose_agent_turn_instruction("turn body".to_string(), None, None, false);
        assert!(composed.contains("[BitFun environment boundary]"));
        assert!(composed.contains("loopx-*` entries from your skill catalog"));
        assert!(composed.contains("~/.codex/skills"));
        assert!(composed
            .contains("Never install, update, self-update, or repair the LoopX installation"));
    }

    #[test]
    fn run_now_with_a_selected_todo_is_not_a_frontier_contradiction() {
        // Regression: the outer-controller turn plan can report
        // open_count = 0 while `action.selected_todo` still names an open,
        // agent-claimed todo (observed on the huangruiteng/loopx issue-3859
        // goal). The contradiction witness is the envelope's action
        // projection, not the scalar counter.
        assert!(!run_now_is_frontier_contradiction(0, 0, true));
        assert!(run_now_is_frontier_contradiction(0, 0, false));
        assert!(!run_now_is_frontier_contradiction(2, 0, false));
        assert!(!run_now_is_frontier_contradiction(0, 1, false));
    }

    #[test]
    fn todoless_run_now_frontier_drives_a_replan_turn_only_with_an_obligation() {
        // Runtime-data correction (2026-09-05 five-issue run): the pinned CLI
        // projects the plan-exhausted frontier as RunNow + replan obligation,
        // expecting the host to drive one replan turn. Parking there stranded
        // all five tasks in recovery before any goal could close.
        assert_eq!(
            todoless_run_now_frontier(Some("replan-d4066f99c1ea4b11")),
            TodolessRunNowFrontier::DriveReplanTurn,
        );
        // A todo-less RunNow frontier without an obligation is the real
        // contract contradiction: park for an owner decision.
        assert_eq!(
            todoless_run_now_frontier(None),
            TodolessRunNowFrontier::Park,
        );
        assert_eq!(
            todoless_run_now_frontier(Some("")),
            TodolessRunNowFrontier::Park,
        );
        assert_eq!(
            todoless_run_now_frontier(Some("   ")),
            TodolessRunNowFrontier::Park,
        );
    }

    #[test]
    fn retry_required_from_a_completed_turn_recovers_from_the_goal_projection() {
        // The false-negative settlement (observed live on dsh-desktop#830):
        // a completed turn validated its durable writeback but skipped the
        // quota spend. The Goal projection — not the missing receipt — must
        // decide the next state, because a terminal frontier refuses the
        // quota guard and no corrective turn can run.
        assert!(inspects_goal_after_settlement(
            LoopxAgentTurnStatus::Completed,
            LoopxCliSettlementStatus::RetryRequired,
        ));
        // Cancelled/interrupted turns keep the explicit recovery path: the
        // owner interrupted that turn, so the host must not silently
        // re-drive it from the projection.
        assert!(!inspects_goal_after_settlement(
            LoopxAgentTurnStatus::Cancelled,
            LoopxCliSettlementStatus::RetryRequired,
        ));
        assert!(!inspects_goal_after_settlement(
            LoopxAgentTurnStatus::Interrupted,
            LoopxCliSettlementStatus::RetryRequired,
        ));
        // Settled turns keep today's projection-driven handling for any
        // non-failed agent status; failed turns and missing writebacks keep
        // their existing explicit paths.
        assert!(inspects_goal_after_settlement(
            LoopxAgentTurnStatus::Cancelled,
            LoopxCliSettlementStatus::Settled,
        ));
        assert!(!inspects_goal_after_settlement(
            LoopxAgentTurnStatus::Failed,
            LoopxCliSettlementStatus::Settled,
        ));
        assert!(!inspects_goal_after_settlement(
            LoopxAgentTurnStatus::Completed,
            LoopxCliSettlementStatus::NoDurableProgress,
        ));
    }

    #[test]
    fn goal_ids_are_per_item_and_attempt() {
        let identity = LoopxTaskIdentity {
            item: LoopxIssueKey {
                repository: LoopxRepositoryKey {
                    host: "github.com".to_string(),
                    owner: "owner".to_string(),
                    repository: "repo".to_string(),
                },
                kind: LoopxItemKind::Issue,
                number: 42,
            },
            attempt: 2,
            ..Default::default()
        };
        assert_eq!(goal_id_for(&identity), "bfx-owner-repo-issue-42-2");
    }

    #[test]
    fn repository_recovery_includes_all_resumable_tasks() {
        let repository = LoopxRepositoryKey {
            host: "github.com".to_string(),
            owner: "owner".to_string(),
            repository: "repo".to_string(),
        };
        let task = |state| LoopxTaskSnapshot {
            identity: LoopxTaskIdentity {
                item: LoopxIssueKey {
                    repository: repository.clone(),
                    kind: LoopxItemKind::Issue,
                    number: 42,
                },
                ..LoopxTaskIdentity::default()
            },
            state,
            ..LoopxTaskSnapshot::default()
        };
        let repository_id = repository.canonical_id();

        assert!(is_repository_recovery_candidate(
            &task(LoopxTaskState::RecoveryRequired),
            &repository_id,
        ));
        assert!(is_repository_recovery_candidate(
            &task(LoopxTaskState::Failed),
            &repository_id,
        ));
        assert!(is_repository_recovery_candidate(
            &task(LoopxTaskState::Stopped),
            &repository_id,
        ));
    }

    #[test]
    fn agent_summary_projection_is_bounded_on_character_boundaries() {
        let summary = "界".repeat(MAX_AGENT_SUMMARY_CHARS + 1);
        let bounded = bounded_agent_summary(&summary);

        assert!(bounded.ends_with("[Summary truncated by LoopX host]"));
        assert_eq!(bounded.matches('界').count(), MAX_AGENT_SUMMARY_CHARS);
    }

    #[test]
    fn settled_task_does_not_self_requeue_after_yielding_repository() {
        assert!(!should_requeue_after_settlement(
            LoopxTaskState::Queued,
            true,
        ));
        assert!(should_requeue_after_settlement(
            LoopxTaskState::Queued,
            false,
        ));
        assert!(!should_requeue_after_settlement(
            LoopxTaskState::Completed,
            false,
        ));
    }

    #[test]
    fn depth_first_sticky_continues_only_for_runnable_goals() {
        // Cleanly settled + still runnable: keep the slot, continue deep.
        assert!(sticky_continue_after_settlement(
            LoopxTaskState::Queued,
            Some(LoopxCliRunDecision::RunNow),
        ));
        // Unknown post-settlement decision (inspection failed): continue — the
        // re-drive re-inspects and parks at a gate, so this is self-correcting.
        assert!(sticky_continue_after_settlement(
            LoopxTaskState::Queued,
            None
        ));
        // Cadence wait: yield the slot to the next queued issue.
        assert!(!sticky_continue_after_settlement(
            LoopxTaskState::Queued,
            Some(LoopxCliRunDecision::Wait),
        ));
        assert!(!sticky_continue_after_settlement(
            LoopxTaskState::Queued,
            Some(LoopxCliRunDecision::WaitingForUser),
        ));
        // Terminal or parked states always yield.
        assert!(!sticky_continue_after_settlement(
            LoopxTaskState::Completed,
            Some(LoopxCliRunDecision::RunNow),
        ));
        assert!(!sticky_continue_after_settlement(
            LoopxTaskState::RecoveryRequired,
            Some(LoopxCliRunDecision::RunNow),
        ));
        assert!(!sticky_continue_after_settlement(
            LoopxTaskState::WaitingForUser,
            None,
        ));
    }

    #[test]
    fn wait_requeue_delay_follows_the_pinned_cadence_labels() {
        let snapshot = |cadence: Option<&str>| LoopxCliGoalSnapshot {
            scheduler_cadence: cadence.map(str::to_string),
            ..LoopxCliGoalSnapshot::default()
        };
        // v1.0.1 cadence labels map onto the pinned scheduler's initial
        // intervals (scheduler_hint.py: active 3m, monitor floor 15m, human
        // gate 30m, quiet 30m, unchanged 60m, agent-scope 10m).
        assert_eq!(
            wait_requeue_delay_ms(&snapshot(Some("active_work"))),
            3 * 60 * 1000
        );
        assert_eq!(
            wait_requeue_delay_ms(&snapshot(Some("monitor_wait"))),
            15 * 60 * 1000
        );
        assert_eq!(
            wait_requeue_delay_ms(&snapshot(Some("human_gate"))),
            30 * 60 * 1000
        );
        assert_eq!(
            wait_requeue_delay_ms(&snapshot(Some("quiet_wait"))),
            30 * 60 * 1000
        );
        assert_eq!(
            wait_requeue_delay_ms(&snapshot(Some("unchanged_noop"))),
            60 * 60 * 1000
        );
        assert_eq!(
            wait_requeue_delay_ms(&snapshot(Some("agent_scope_wait"))),
            10 * 60 * 1000
        );
        // Label-less degraded snapshots fall back to the bounded poll.
        assert_eq!(
            wait_requeue_delay_ms(&snapshot(None)),
            WAIT_RESCHEDULE_FALLBACK_MS
        );
        // Unknown labels fall back instead of guessing.
        assert_eq!(
            wait_requeue_delay_ms(&snapshot(Some("future_cadence"))),
            WAIT_RESCHEDULE_FALLBACK_MS
        );
    }

    #[test]
    fn post_settlement_gate_is_projected_before_requeue() {
        let goal = LoopxCliGoalSnapshot {
            state: LoopxCliGoalState::WaitingForUser,
            run_decision: LoopxCliRunDecision::WaitingForUser,
            pending_user_gate: Some(LoopxCliUserGate {
                gate_id: "todo-owner".to_string(),
                message: "Owner decision required".to_string(),
                ..LoopxCliUserGate::default()
            }),
            ..LoopxCliGoalSnapshot::default()
        };

        let state = task_state_after_settlement(
            LoopxAgentTurnStatus::Completed,
            LoopxCliSettlementStatus::Settled,
            Some(&goal),
        );
        assert_eq!(state, LoopxTaskState::WaitingForUser);
        assert_eq!(
            phase_after_settlement(state),
            LoopxPhase::WaitingForApproval
        );
        assert!(!should_requeue_after_settlement(state, false));
    }

    #[test]
    fn successful_process_lifecycle_messages_are_not_persisted_as_task_events() {
        assert!(is_normal_process_lifecycle_message(
            "Starting LoopX process"
        ));
        assert!(is_normal_process_lifecycle_message(
            "LoopX process exited successfully"
        ));
        assert!(!is_normal_process_lifecycle_message(
            "LoopX process exited with an error"
        ));
        assert!(!is_normal_process_lifecycle_message(
            "Building a fresh LoopX custom-runner turn contract"
        ));
    }

    #[test]
    fn resumed_tasks_with_a_goal_skip_intake_and_goal_creation() {
        assert!(task_has_bound_goal(&LoopxTaskSnapshot {
            goal_id: Some("goal-42".to_string()),
            ..LoopxTaskSnapshot::default()
        }));
        assert!(!task_has_bound_goal(&LoopxTaskSnapshot::default()));
        assert!(!task_has_bound_goal(&LoopxTaskSnapshot {
            goal_id: Some("  ".to_string()),
            ..LoopxTaskSnapshot::default()
        }));
    }

    #[test]
    fn reconciliation_cannot_clear_an_unanswered_local_gate() {
        let task = LoopxTaskSnapshot {
            state: LoopxTaskState::WaitingForUser,
            phase: LoopxPhase::WaitingForApproval,
            pending_gate_id: Some("todo_owner_review".to_string()),
            ..LoopxTaskSnapshot::default()
        };
        let active_goal = LoopxCliGoalSnapshot {
            state: LoopxCliGoalState::Active,
            ..LoopxCliGoalSnapshot::default()
        };
        assert!(preserve_unanswered_local_gate(&task, &active_goal));

        let answered_task = LoopxTaskSnapshot {
            state: LoopxTaskState::Queued,
            ..task.clone()
        };
        assert!(!preserve_unanswered_local_gate(
            &answered_task,
            &active_goal,
        ));

        let completed_goal = LoopxCliGoalSnapshot {
            state: LoopxCliGoalState::Completed,
            ..active_goal
        };
        assert!(!preserve_unanswered_local_gate(&task, &completed_goal));
    }
}
