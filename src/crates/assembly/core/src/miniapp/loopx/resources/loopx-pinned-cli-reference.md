# LoopX v1.0.1 pinned CLI reference (host-provided)

> Generated from the exact pinned CLI supplied by the BitFun host. This is authoritative for LoopX behavior, commands, flags, and schemas on this machine; do not consult other LoopX source checkouts or installed versions.


## loopx bootstrap --help

usage: -c bootstrap [-h] [--project PROJECT] [--goal-id GOAL_ID]
                    [--fork-goal FORK_GOAL] [--objective OBJECTIVE]
                    [--display-name DISPLAY_NAME] [--domain DOMAIN]
                    [--role {controller,subagent}]
                    [--parent-goal-id PARENT_GOAL_ID]
                    [--state-file STATE_FILE] [--goal-doc GOAL_DOC]
                    [--adapter-kind ADAPTER_KIND]
                    [--adapter-status ADAPTER_STATUS]
                    [--next-probe NEXT_PROBE] [--spawn-allowed]
                    [--max-children MAX_CHILDREN]
                    [--allowed-domain ALLOWED_DOMAIN]
                    [--write-scope WRITE_SCOPE] [--fine-grained]
                    [--execution-minimum-scale EXECUTION_MINIMUM_SCALE]
                    [--execution-must-include EXECUTION_MUST_INCLUDE]
                    [--execution-small-streak-threshold EXECUTION_SMALL_STREAK_THRESHOLD]
                    [--execution-outcome-marker EXECUTION_OUTCOME_MARKER]
                    [--execution-surface-only-hint EXECUTION_SURFACE_ONLY_HINT]
                    [--execution-surface-streak-threshold EXECUTION_SURFACE_STREAK_THRESHOLD]
                    [--execution-outcome-must-advance EXECUTION_OUTCOME_MUST_ADVANCE]
                    [--no-onboarding-scan]
                    [--onboarding-connection-validation {agent,provider-prevalidated}]
                    [--accept-onboarding-agent-todos]
                    [--begin-autonomous-advance]
                    [--codex-app-heartbeat {ask,yes,no}]
                    [--onboarding-max-commits ONBOARDING_MAX_COMMITS]
                    [--onboarding-max-status-paths ONBOARDING_MAX_STATUS_PATHS]
                    [--onboarding-max-top-level-files ONBOARDING_MAX_TOP_LEVEL_FILES]
                    [--force] [--preserve-todos] [--replace-state] [--dry-run]
                    [--no-global-sync]

options:
  -h, --help            show this help message and exit
  --project PROJECT     Project directory to connect.
  --goal-id GOAL_ID     Stable goal id. Defaults to <project-name>-goal.
  --fork-goal FORK_GOAL
                        Create a new forked goal id instead of reusing an
                        existing global goal route.
  --objective OBJECTIVE
                        Initial goal objective.
  --display-name DISPLAY_NAME
                        Public display title for the goal. When omitted, a
                        public-safe title is derived from the objective; the
                        project name remains the fallback.
  --domain DOMAIN       Goal domain label.
  --role {controller,subagent}
  --parent-goal-id PARENT_GOAL_ID
                        Parent goal id when --role subagent.
  --state-file STATE_FILE
                        Active goal state path, relative to project unless
                        absolute.
  --goal-doc GOAL_DOC   Primary goal document path, relative to project unless
                        absolute.
  --adapter-kind ADAPTER_KIND
  --adapter-status ADAPTER_STATUS
  --next-probe NEXT_PROBE
                        Optional project-specific pre-tick command.
  --spawn-allowed       Declare that this controller may spawn child agents.
  --max-children MAX_CHILDREN
  --allowed-domain ALLOWED_DOMAIN
                        Allowed child work domain. Repeatable.
  --write-scope WRITE_SCOPE
                        Allowed write scope such as docs/**. Repeatable.
  --fine-grained        Persist one-small-checkpoint-per-turn execution with
                        evidence-driven replanning after each completed Todo.
  --execution-minimum-scale EXECUTION_MINIMUM_SCALE
                        Minimum delivery scale after repeated small follow-
                        through.
  --execution-must-include EXECUTION_MUST_INCLUDE
                        Required delivery component. Repeatable; defaults to
                        artifact, validation, and state writeback.
  --execution-small-streak-threshold EXECUTION_SMALL_STREAK_THRESHOLD
                        Repeated small-scale streak that triggers the delivery
                        contract.
  --execution-outcome-marker EXECUTION_OUTCOME_MARKER
                        Classification substring that counts as primary
                        outcome/evidence progress. Repeatable.
  --execution-surface-only-hint EXECUTION_SURFACE_ONLY_HINT
                        Classification substring that counts as surface-only
                        progress unless an outcome marker is present.
                        Repeatable.
  --execution-surface-streak-threshold EXECUTION_SURFACE_STREAK_THRESHOLD
                        Surface-progress streak that triggers the outcome-
                        floor contract.
  --execution-outcome-must-advance EXECUTION_OUTCOME_MUST_ADVANCE
                        Outcome/evidence floor label that future delivery must
                        advance. Repeatable.
  --no-onboarding-scan  Skip the fast first-connect repository scan and todo
                        candidate proposal.
  --onboarding-connection-validation {agent,provider-prevalidated}
                        Choose who validates the project connection. The
                        default 'agent' may create a loopx-check Todo;
                        'provider-prevalidated' records provider ownership and
                        omits that agent Todo.
  --accept-onboarding-agent-todos
                        Write all proposed onboarding agent todos into the
                        initial active state.
  --begin-autonomous-advance
                        Record that Codex may begin from accepted onboarding
                        agent todos after the quota guard permits work.
  --codex-app-heartbeat {ask,yes,no}
                        Codex App recurring heartbeat choice for onboarding.
                        Default ask creates a user gate; yes/no records an
                        explicit operator decision for headless setup.
  --onboarding-max-commits ONBOARDING_MAX_COMMITS
                        Maximum recent commits sampled by the fast onboarding
                        scan.
  --onboarding-max-status-paths ONBOARDING_MAX_STATUS_PATHS
                        Maximum git status lines sampled by the fast
                        onboarding scan.
  --onboarding-max-top-level-files ONBOARDING_MAX_TOP_LEVEL_FILES
                        Maximum top-level names sampled by the fast onboarding
                        scan.
  --force               Replace existing goal entry or state file.
  --preserve-todos      With --force, preserve the existing active state file
                        instead of replacing its todos.
  --replace-state       Allow replacing an existing global route for the same
                        goal id. Writes a global registry backup before
                        changing the route.
  --dry-run             Show planned writes without changing files.
  --no-global-sync      Do not merge this project registry into the shared
                        global registry.


## loopx register-agent --help

usage: -c register-agent [-h] --goal-id GOAL_ID --agent-id AGENT_ID
                         [--require-new] [--execute]

options:
  -h, --help           show this help message and exit
  --goal-id GOAL_ID    Goal id already present in the global registry.
  --agent-id AGENT_ID  Public-safe agent id to add. Repeatable; comma-
                       separated values are also accepted.
  --require-new        Fail when any requested id is already registered.
                       Fresh-agent onboarding uses this to prevent accidental
                       takeover; ordinary registration remains idempotent
                       without the flag.
  --execute            Write the source registry and sync it globally. Without
                       this flag, preview only.


## loopx todo --help

usage: -c todo [-h] [--format {markdown,json}] --goal-id GOAL_ID
               [--role {user,agent}] [--text TEXT] [--follow-up FOLLOWUPS]
               [--todo-id TODO_ID] [--claim-operation-id CLAIM_OPERATION_ID]
               [--turn-instance-id TURN_INSTANCE_ID]
               [--completion-identity-key COMPLETION_IDENTITY_KEY]
               [--replan-obligation-id REPLAN_OBLIGATION_ID]
               [--status {open,done,blocked,deferred}] [--note NOTE]
               [--evidence EVIDENCE] [--validation-command VALIDATION_COMMAND]
               [--validation-label VALIDATION_LABEL]
               [--validation-command-json VALIDATION_COMMAND_JSON]
               [--validation-timeout-seconds VALIDATION_TIMEOUT_SECONDS]
               [--reason REASON] [--authority-reason AUTHORITY_REASON]
               [--task-class {advancement_task,continuous_monitor,user_gate,user_action,blocker}]
               [--action-kind ACTION_KIND] [--task-domain TASK_DOMAIN]
               [--capability-binding-ref CAPABILITY_BINDING_REF]
               [--task-repository TASK_REPOSITORY]
               [--continuation-policy {independent_handoff,same_agent_non_delivery}]
               [--required-write-scope REQUIRED_WRITE_SCOPES]
               [--required-capability REQUIRED_CAPABILITIES]
               [--target-capability TARGET_CAPABILITIES]
               [--capability-gap-status {found,fixed,real_callsite_verified}]
               [--explore-result-node-ref EXPLORE_RESULT_NODE_REFS]
               [--clear-explore-result-node-refs]
               [--decision-scope DECISION_SCOPE]
               [--required-decision-scope REQUIRED_DECISION_SCOPES]
               [--decision-outcome {approve,reject,cancel}]
               [--claimed-by CLAIMED_BY]
               [--task-lease-idempotency-key TASK_LEASE_IDEMPOTENCY_KEY]
               [--task-lease-expected-version TASK_LEASE_EXPECTED_VERSION]
               [--bound-agent BOUND_AGENT] [--goal-bound]
               [--blocks-agent BLOCKS_AGENT] [--clear-blocks-agent]
               [--excluded-agent EXCLUDED_AGENTS] [--clear-excluded-agents]
               [--global-gate] [--clear-global-gate]
               [--unblocks-todo-id UNBLOCKS_TODO_ID]
               [--successor-todo-id SUCCESSOR_TODO_IDS]
               [--resume-when RESUME_WHEN] [--clear-resume-when]
               [--target-key MONITOR_TARGET_KEY] [--cadence CADENCE]
               [--next-due-at NEXT_DUE_AT] [--expires-at EXPIRES_AT]
               [--watch-only] [--clear-claim] [--no-follow-up]
               [--next-agent-todo NEXT_AGENT_TODO]
               [--next-user-todo NEXT_USER_TODO]
               [--next-user-task-class {user_gate,user_action}]
               [--next-claimed-by NEXT_CLAIMED_BY] [--self-merged]
               [--next-task-class {advancement_task,continuous_monitor,blocker}]
               [--next-action-kind NEXT_ACTION_KIND]
               [--next-task-repository NEXT_TASK_REPOSITORY]
               [--next-required-capability NEXT_REQUIRED_CAPABILITIES]
               [--next-continuation-policy {independent_handoff,same_agent_non_delivery}]
               [--next-excluded-agent NEXT_EXCLUDED_AGENTS]
               [--max-active-done MAX_ACTIVE_DONE] [--agent-id AGENT_ID]
               [--from {recent-repo,issues-prs,failing-checks,todo-markers,complexity-hotspots,loopx-deferred,docs-smokes}]
               [--limit TODO_LIMIT] [--thin]
               [--trigger {user-requested,post-connect,no-runnable-todo,repo-changed,quality-watch}]
               [--project PROJECT] [--state-file STATE_FILE] [--dry-run]
               [--execute] [--provider-revision PROVIDER_REVISION]
               [{add,list,claim,update,complete,supersede,archive-completed,suggest,capture-followups,project-markdown}]

Manage goal todos. The options below are the union for every todo command;
each option's help names the commands that accept it, and unsupported
combinations fail before state is read or written.

positional arguments:
  {add,list,claim,update,complete,supersede,archive-completed,suggest,capture-followups,project-markdown}
                        Use add to append a checkbox todo, claim to soft-claim
                        by registered agent id, list to read projected todos,
                        update/complete/supersede to transition by todo_id, or
                        archive-completed to move older completed todos into
                        Completed Work Archive. Use suggest to generate an
                        agent-facing candidate todo analysis prompt without
                        writing state. Use capture-followups to record a
                        capped public-safe unclaimed follow-up batch.

options:
  -h, --help            show this help message and exit
  --format {markdown,json}
                        Output format for this subcommand. Equivalent to
                        global --format before the command.
  --goal-id GOAL_ID     Goal id whose active state should receive the todo.
  --role {user,agent}   Todo owner. Required for add; optional todo_id search
                        scope for lifecycle commands. Defaults to agent for
                        archive-completed.
  --text TEXT           Todo text. Required for add; keep it short and public-
                        safe enough for local status.
  --follow-up FOLLOWUPS
                        For capture-followups, append one public-safe agent
                        follow-up todo. Repeat up to the requested batch.
  --todo-id TODO_ID     Structured todo id from status/quota, such as
                        todo_ab12cd34ef56.
  --claim-operation-id CLAIM_OPERATION_ID
                        For todo claim on promoted canonical authority only,
                        reuse this public-safe operation id across retries.
                        Changed intent with the same id is rejected; receipt
                        replay proves historical acceptance, not current lease
                        ownership. Omit to retain a fresh operation id per
                        invocation.
  --turn-instance-id TURN_INSTANCE_ID
                        For todo complete, bind the lifecycle receipt to the
                        original turn-scoped quota guard and reuse it on
                        retries.
  --completion-identity-key COMPLETION_IDENTITY_KEY
                        For todo complete --no-follow-up lifecycle reentry,
                        reuse the exact completion identity projected by
                        LoopX. This is not a quota turn id and cannot be
                        combined with --turn-instance-id.
  --replan-obligation-id REPLAN_OBLIGATION_ID
                        For todo add, bind one newly selected runnable
                        advancement successor to the exact open replan
                        obligation. Requires --action-kind and a stable
                        --target-key or --explore-result-node-ref. The Todo
                        write becomes the semantic receipt; no follow-up ACK
                        command is required.
  --status {open,done,blocked,deferred}
                        For todo add/update, set the lifecycle status.
  --note NOTE           Public-safe note to attach to a lifecycle transition.
  --evidence EVIDENCE   Public-safe evidence pointer or short result for
                        complete/update.
  --validation-command VALIDATION_COMMAND
                        Caller-approved validation command (no shell) to run
                        before a todo's completion commits, e.g. 'pytest -q
                        tests/test_x.py'. Set on `todo add`; completion runs
                        it independently and blocks on a non-zero exit.
  --validation-label VALIDATION_LABEL
                        Optional public-safe label for the validation receipt.
  --validation-command-json VALIDATION_COMMAND_JSON
                        Trusted JSON string array (argv form, no shell
                        parsing) for the completion validation command, e.g.
                        '["pytest","-q","tests/test_x.py"]'. Mutually
                        exclusive with --validation-command; set on `todo
                        add`.
  --validation-timeout-seconds VALIDATION_TIMEOUT_SECONDS
                        Per-todo timeout for the caller-approved validation
                        command. Only meaningful with --validation-command or
                        --validation-command-json on `todo add`; must be 1-29
                        so a timed-out validation still produces a typed
                        receipt inside the 30s outer subprocess budget.
                        Defaults to 20.
  --reason REASON       Public-safe reason for blocked/deferred/supersede
                        transitions.
  --authority-reason AUTHORITY_REASON
                        For a delegated lifecycle override, record the public-
                        safe reason. Required when the matching
                        coordination.todo_lifecycle_authority grant sets
                        requires_reason=true.
  --task-class {advancement_task,continuous_monitor,user_gate,user_action,blocker}
                        For todo add/update, explicitly register the routing
                        lane. Use advancement_task for executable delivery
                        work; user_gate for blocking owner/controller
                        decisions; user_action for non-blocking user-visible
                        todos; continuous_monitor and blocker are non-
                        executable lanes.
  --action-kind ACTION_KIND
                        For todo add, optional public-safe action token such
                        as run_eval, rebuild_score, compact_blocker_writeback,
                        or monitor.
  --task-domain TASK_DOMAIN
                        For agent todo add/update, declare the bounded
                        responsibility domain used by adaptive child
                        admission, such as code, docs, or validation.
  --capability-binding-ref CAPABILITY_BINDING_REF
                        For agent todo add, persist the opaque capability
                        admission binding projected by a validated capability
                        packet.
  --task-repository TASK_REPOSITORY
                        For agent todo add/update, declare the credential-free
                        Git repository identity that owns the task, such as
                        git:github.com/owner/repo. This selects workspace
                        isolation; it does not grant write permission.
  --continuation-policy {independent_handoff,same_agent_non_delivery}
                        Closed completion/handoff policy for this todo.
                        action_kind remains an extensible domain token;
                        defaults to independent_handoff.
  --required-write-scope REQUIRED_WRITE_SCOPES
                        For todo add/update, declare a required relative write
                        scope such as src/** or runners/openviking/**. Repeat
                        for multiple scopes.
  --required-capability REQUIRED_CAPABILITIES
                        For todo add/update, declare an execution capability
                        such as shell, filesystem_write, network,
                        benchmark_runner, or external_evidence_poll. Repeat
                        for multiple capabilities.
  --target-capability TARGET_CAPABILITIES
                        For todo add/update, declare a capability this todo is
                        building, repairing, materializing, or parity-
                        checking. On complete, pair it with --capability-gap-
                        status to close that lifecycle. This is not a hard
                        execution prerequisite.
  --capability-gap-status {found,fixed,real_callsite_verified}
                        For agent todo add/update/complete, append an
                        auditable capability-gap lifecycle event. Requires
                        --target-capability; the todo_id is the stable gap id.
  --explore-result-node-ref EXPLORE_RESULT_NODE_REFS
                        For todo add/update, link an explicit public-safe
                        Explore result node id. Repeat for multiple nodes;
                        analysis resolves only these links.
  --clear-explore-result-node-refs
                        For todo update, remove all explicit Explore result
                        node links.
  --decision-scope DECISION_SCOPE
                        For user_gate add/update, declare the concrete
                        decision as kind:granularity:scope_key, for example
                        direction:action:benchmark_target.
  --required-decision-scope REQUIRED_DECISION_SCOPES
                        For agent todo add/update, declare a required decision
                        scope as kind:granularity:scope_key. Repeat for
                        multiple scopes.
  --decision-outcome {approve,reject,cancel}
                        For todo complete on a user_gate, record the explicit
                        owner decision. Only approve consumes authority and
                        resumes linked work.
  --claimed-by CLAIMED_BY
                        For agent todo add/claim/update, assign the soft
                        execution owner to a registered public-safe agent id
                        such as codex-main-control. This names the assignment
                        target, not the lifecycle actor; multi-agent lifecycle
                        commands still require --agent-id. User todos use
                        --bound-agent or --goal-bound instead.
  --task-lease-idempotency-key TASK_LEASE_IDEMPOTENCY_KEY
                        For todo claim on promoted hard-lease authority,
                        atomically acquire the canonical lease and claim; for
                        complete and supersede, prove the execution instance
                        that owns the active lease.
  --task-lease-expected-version TASK_LEASE_EXPECTED_VERSION
                        For promoted todo claim, optionally compare-and-set
                        the canonical lease version; for complete and
                        supersede, supply the active lease version when it is
                        effective.
  --bound-agent BOUND_AGENT
                        For user todo add/update, bind reminder delivery and
                        post-response continuation to one registered agent
                        lane. This is not a gate.
  --goal-bound          For user todo add/update, explicitly bind the item to
                        the whole goal instead of one agent lane.
  --blocks-agent BLOCKS_AGENT
                        For user_gate add/update, scope the gate to one
                        registered agent.
  --clear-blocks-agent  For todo update, remove the existing blocks_agent
                        field.
  --excluded-agent EXCLUDED_AGENTS
                        For agent todo add/update, exclude one registered peer
                        from claiming or executing the todo. Repeat for
                        multiple peers.
  --clear-excluded-agents
                        For todo update, remove all executor exclusions from
                        the todo.
  --global-gate         For todo add/update on role=user task-class=user_gate,
                        explicitly mark that the gate blocks every registered
                        agent. Prefer --blocks-agent or --agent-id when only
                        one lane is waiting.
  --clear-global-gate   For todo update on a user_gate, remove global_gate. In
                        a multi-agent goal, provide --blocks-agent in the same
                        update so the gate retains an explicit lane scope.
  --unblocks-todo-id UNBLOCKS_TODO_ID
                        For todo add/update, link this todo to the blocked
                        todo it unblocks, for example todo_ab12cd34ef56.
                        Completing an exactly linked user_gate also consumes
                        the target required decision scopes covered by that
                        gate.
  --successor-todo-id SUCCESSOR_TODO_IDS
                        For todo update/complete, link an existing successor
                        todo to the current todo. Repeat for multiple
                        successors.
  --resume-when RESUME_WHEN
                        For deferred todo add/update, or for an open
                        advancement todo update paired with --successor-todo-
                        id, declare a machine-readable resume condition such
                        as todo_done:todo_ab12cd34ef56,
                        monitor_changed:todo_monitor123, pr_merged:#532, or
                        capacity_available:short_pool. monitor_changed binds
                        the monitor's current material-change generation and
                        resumes only after it advances; the waiting
                        advancement todo must remain status=open and pair with
                        an independent runnable --successor-todo-id.
  --clear-resume-when   For todo update, remove the existing resume condition
                        after its successor replan has made the todo runnable.
  --target-key MONITOR_TARGET_KEY, --monitor-target-key MONITOR_TARGET_KEY
                        For agent todo add/update, declare a stable public-
                        safe execution target key. --monitor-target-key
                        remains a compatibility alias.
  --cadence CADENCE     For agent continuous_monitor add/update, declare the
                        monitor cadence, such as 30m, 2h, or 1d.
  --next-due-at NEXT_DUE_AT
                        For agent continuous_monitor add/update, declare the
                        next due ISO timestamp; due monitor scheduling is
                        based on this field.
  --expires-at EXPIRES_AT
                        For agent continuous_monitor add/update, declare the
                        ISO timestamp after which the monitor is no longer due
                        and must not catch up.
  --watch-only          For agent continuous_monitor add/update, declare an
                        intentionally unbounded liveness watch. Watch-only
                        monitors remain schedulable but do not drive
                        autonomous replan or block goal convergence.
  --clear-claim         For todo update, remove the soft claimed_by owner from
                        the todo.
  --no-follow-up        For todo update/complete, record a structured no-
                        follow-up rationale when a completed todo
                        intentionally has no successor.
  --next-agent-todo NEXT_AGENT_TODO
                        For complete/supersede, atomically add or update the
                        next agent todo.
  --next-user-todo NEXT_USER_TODO
                        For complete/supersede, atomically add or update the
                        next user todo.
  --next-user-task-class {user_gate,user_action}
                        Required with --next-user-todo: user_gate for a
                        blocking owner decision or user_action for a visible
                        reminder that must not block the bound agent lane.
  --next-claimed-by NEXT_CLAIMED_BY
                        For complete/supersede with --next-agent-todo, soft-
                        claim the successor todo for a registered agent.
                        Independent handoffs remain unclaimed unless
                        explicitly assigned, while same-agent non-delivery
                        continuations keep the current owner. Use --self-
                        merged with --evidence for an eligible same-agent
                        delivery.
  --self-merged         For todo complete, record that a small validated
                        change was self-merged; requires --evidence.
  --next-task-class {advancement_task,continuous_monitor,blocker}
                        Task class for --next-agent-todo. Defaults to
                        advancement_task.
  --next-action-kind NEXT_ACTION_KIND
                        Action kind for --next-agent-todo.
  --next-task-repository NEXT_TASK_REPOSITORY
                        Credential-free Git repository identity for --next-
                        agent-todo, such as git:github.com/owner/repo.
  --next-required-capability NEXT_REQUIRED_CAPABILITIES
                        Execution capability required by --next-agent-todo.
                        Repeat for multiple capabilities.
  --next-continuation-policy {independent_handoff,same_agent_non_delivery}
                        Continuation policy for --next-agent-todo.
  --next-excluded-agent NEXT_EXCLUDED_AGENTS
                        For complete/supersede with --next-agent-todo, exclude
                        one registered peer from claiming or executing the
                        successor. Repeat for multiple peers.
  --max-active-done MAX_ACTIVE_DONE
                        For archive-completed, keep this many completed todos
                        in the active section. The default leaves a small
                        buffer below the status warning threshold.
  --agent-id AGENT_ID   For user todo add, mark the authoring registered agent
                        and bind the user response continuation to that lane;
                        for user_gate, the gate also blocks this agent when
                        --blocks-agent is omitted. For
                        claim/update/complete/supersede, attribute the
                        lifecycle actor; registered multi-agent goals require
                        it unless an exact linked user_gate decision_scope
                        supplies the typed owner/controller override. For
                        list/suggest, select the project agent lane. Agent
                        todo add intentionally does not accept this option;
                        use --claimed-by to assign execution, or omit both
                        options to leave the todo unclaimed.
  --from {recent-repo,issues-prs,failing-checks,todo-markers,complexity-hotspots,loopx-deferred,docs-smokes}
                        For todo suggest, include a source lane for agent
                        analysis. Repeat for multiple lanes.
  --limit TODO_LIMIT    For todo suggest, maximum candidate count; values
                        above 5 are clamped to 5. For todo list, explicit per-
                        section cold-path cap: keep the top N todos of each
                        role section after filtering; must be an integer >= 1,
                        and the payload discloses the truncation via
                        explicit_limit.
  --thin                For todo list, return the explicit field-only
                        projection and omit detail lanes; returns at most two
                        items per role, and --limit can lower but not expand
                        that bound.
  --trigger {user-requested,post-connect,no-runnable-todo,repo-changed,quality-watch}
                        For todo suggest, why this candidate queue is being
                        requested.
  --project PROJECT     Project root. Defaults to the registry goal repo.
  --state-file STATE_FILE
                        Active goal state path. Defaults to the registry goal
                        state_file.
  --dry-run             Preview the active-state edit without writing.
  --execute             For archive-completed or project-markdown, write the
                        active-state edit.
  --provider-revision PROVIDER_REVISION
                        For project-markdown, exact canonical authority
                        revision rendered into the Todo section markers.


## loopx refresh-state --help

usage: -c refresh-state [-h] [--format {markdown,json}] --goal-id GOAL_ID
                        [--project PROJECT] [--state-file STATE_FILE]
                        [--classification CLASSIFICATION]
                        [--recommended-action RECOMMENDED_ACTION]
                        [--next-action NEXT_ACTION]
                        [--delivery-batch-scale {test_only,single_surface,multi_surface,implementation,single_segment,bounded_segment}]
                        [--delivery-outcome {surface_only,outcome_gap,outcome_progress,primary_goal_outcome}]
                        [--delivery-boundary {in_flight_continuation,semantic_closeout}]
                        [--delivery-workspace-path DELIVERY_WORKSPACE_PATH]
                        [--todo-id TODO_ID]
                        [--replan-obligation-id REPLAN_OBLIGATION_ID]
                        [--turn-instance-id TURN_INSTANCE_ID]
                        [--autonomous-replan-recorded]
                        [--progress-result-class {advanced,unchanged,blocked,exploration_exhausted,no_followup}]
                        [--progress-surface-id PROGRESS_SURFACE_ID]
                        [--progress-hypothesis-id PROGRESS_HYPOTHESIS_ID]
                        [--progress-probe-kind PROGRESS_PROBE_KIND]
                        [--progress-blocker-id PROGRESS_BLOCKER_ID]
                        [--progress-coverage-scope-id PROGRESS_COVERAGE_SCOPE_ID]
                        [--progress-evidence-id PROGRESS_EVIDENCE_IDS]
                        [--progress-coverage-complete]
                        [--repair-delta-kind {effective_action,interaction_contract,runnable_todo_set,user_gate,blocker,successor_or_supersede,capability_gate,monitor_target,active_state_next_action,goal_vision_patch,goal_boundary_projection,no_followup,watch_lane_continuation,exploration_exhausted}]
                        [--agent-vision-json AGENT_VISION_JSON]
                        [--vision-state VISION_STATE]
                        [--vision-summary VISION_SUMMARY]
                        [--vision-role-scope VISION_ROLE_SCOPE]
                        [--vision-acceptance VISION_ACCEPTANCE]
                        [--vision-advancement-policy {as_needed,repeat_until_closed}]
                        [--vision-replan-trigger VISION_REPLAN_TRIGGER]
                        [--vision-dreaming-policy VISION_DREAMING_POLICY]
                        [--vision-last-patch VISION_LAST_PATCH]
                        [--vision-todo-delta VISION_TODO_DELTA]
                        [--vision-unchanged-reason VISION_UNCHANGED_REASON]
                        [--agent-id AGENT_ID]
                        [--available-capability AVAILABLE_CAPABILITIES]
                        [--agent-lane AGENT_LANE]
                        [--progress-scope {goal,agent_lane}]
                        [--usage-codex-session USAGE_CODEX_SESSION]
                        [--usage-json USAGE_JSON] [--dry-run]
                        [--no-global-sync] [--suppress-external-sinks]

options:
  -h, --help            show this help message and exit
  --format {markdown,json}
                        Output format for this subcommand. Equivalent to
                        global --format before the command.
  --goal-id GOAL_ID     Goal id whose active state should be refreshed.
  --project PROJECT     Project root. Defaults to the registry goal repo.
  --state-file STATE_FILE
                        Active goal state path. Defaults to the registry goal
                        state_file.
  --classification CLASSIFICATION
                        Refresh run classification. Defaults to
                        state_refreshed.
  --recommended-action RECOMMENDED_ACTION
                        Local-control next action. Private project refs are
                        allowed; inline secrets are rejected. Defaults to:
                        inspect refreshed active goal state and continue the
                        next bounded progress segment
  --next-action NEXT_ACTION
                        Explicitly update the active state's durable ## Next
                        Action before appending the refresh run. Without this
                        flag, --recommended-action only describes the run
                        record.
  --delivery-batch-scale {test_only,single_surface,multi_surface,implementation,single_segment,bounded_segment}
                        Explicit delivery scale for this refresh run; missing
                        scale stays unknown. Accepts canonical scales plus
                        single_segment/bounded_segment aliases for
                        single_surface.
  --delivery-outcome {surface_only,outcome_gap,outcome_progress,primary_goal_outcome}
                        Optional explicit outcome-floor signal for this
                        refresh run.
  --delivery-boundary {in_flight_continuation,semantic_closeout}
                        Typed semantic boundary for vision checkpointing.
                        Defaults to semantic_closeout; in_flight_continuation
                        is valid only for an open agent-bound Todo reporting
                        outcome_progress.
  --delivery-workspace-path DELIVERY_WORKSPACE_PATH
                        Local git worktree that produced this accountable
                        delivery. Use when refresh-state must run from a
                        separate registry checkout; the local path is
                        validated but is not persisted.
  --todo-id TODO_ID     Selected Todo from the original turn-scoped quota
                        guard. Requires --turn-instance-id and an accountable
                        delivery outcome.
  --replan-obligation-id REPLAN_OBLIGATION_ID
                        Autonomous replan obligation from the original turn-
                        scoped quota guard. Requires --turn-instance-id and an
                        accountable delivery outcome; cannot be combined with
                        --todo-id.
  --turn-instance-id TURN_INSTANCE_ID
                        Stable quota guard turn id for settlement writeback.
                        Reuse the same value on retries.
  --autonomous-replan-recorded
                        Mark this refresh as the explicit autonomous replan
                        ACK. Use only after the agent has performed and
                        written back the bounded replan slice.
  --progress-result-class {advanced,unchanged,blocked,exploration_exhausted,no_followup}
                        Typed result for this bounded work slice. Semantics
                        come only from this enum and stable identifiers, never
                        from classification prose.
  --progress-surface-id PROGRESS_SURFACE_ID
  --progress-hypothesis-id PROGRESS_HYPOTHESIS_ID
  --progress-probe-kind PROGRESS_PROBE_KIND
  --progress-blocker-id PROGRESS_BLOCKER_ID
  --progress-coverage-scope-id PROGRESS_COVERAGE_SCOPE_ID
  --progress-evidence-id PROGRESS_EVIDENCE_IDS
  --progress-coverage-complete
  --repair-delta-kind {effective_action,interaction_contract,runnable_todo_set,user_gate,blocker,successor_or_supersede,capability_gate,monitor_target,active_state_next_action,goal_vision_patch,goal_boundary_projection,no_followup,watch_lane_continuation,exploration_exhausted}
                        Machine-visible frontier changed by this repair/replan
                        ACK. Repeat for multiple deltas. Without a delta,
                        --autonomous-replan-recorded is stored as
                        replan_noop/repair_noop and does not clear the
                        obligation.
  --agent-vision-json AGENT_VISION_JSON
                        Path to a complete generated
                        goal_vision_replan_contract_v0 update. The CLI
                        enforces budgets; any autonomous replan that changes
                        durable mainline fields requires goal_path_delta_v0.
  --vision-state VISION_STATE
                        Optional lower snake_case lifecycle state for an
                        inline goal_vision_replan_contract_v0 patch. Closure
                        aliases such as satisfied and vision_satisfied
                        normalize to vision_closed; custom states remain open
                        until explicitly closed.
  --vision-summary VISION_SUMMARY
                        Inline bounded vision_summary for a field-level patch
                        merged into the current agent's latest active vision.
  --vision-role-scope VISION_ROLE_SCOPE
                        Inline bounded role_scope for the current agent's
                        vision patch.
  --vision-acceptance VISION_ACCEPTANCE
                        Inline bounded acceptance_summary for the current
                        agent's vision patch.
  --vision-advancement-policy {as_needed,repeat_until_closed}
                        Whether open acceptance needs advancement only as
                        needed or must keep a runnable advancement frontier
                        until the vision closes.
  --vision-replan-trigger VISION_REPLAN_TRIGGER
                        Inline bounded replan_trigger_summary that quota can
                        project as an acceptance gap.
  --vision-dreaming-policy VISION_DREAMING_POLICY
                        Inline bounded dreaming_policy for the current agent's
                        vision patch.
  --vision-last-patch VISION_LAST_PATCH
                        Inline bounded last_patch_summary for the current
                        agent's vision patch.
  --vision-todo-delta VISION_TODO_DELTA
                        Compact todo delta for an inline vision patch. Repeat
                        for multiple deltas.
  --vision-unchanged-reason VISION_UNCHANGED_REASON
                        Compact reason why a required vision checkpoint is
                        intentionally unchanged.
  --agent-id AGENT_ID   Registered agent id for agent-lane state refreshes.
                        When set, the refresh is visible in run history but
                        does not replace goal-level status.
  --available-capability AVAILABLE_CAPABILITIES
                        Preserve one observed public-safe runtime capability
                        from the scoped quota decision. Repeatable; this
                        context does not grant authority or change refresh-
                        state write scope.
  --agent-lane AGENT_LANE
                        Public-safe lane label for --agent-id scoped
                        refreshes, such as productization_frontstage.
  --progress-scope {goal,agent_lane}
                        Refresh scope. In multi-agent goals, use agent_lane
                        for per-agent runnable status, or goal with any
                        registered peer for durable goal-level status/Next
                        Action.
  --usage-codex-session USAGE_CODEX_SESSION
                        Path to the local Codex session rollout JSONL that
                        produced this run. Only aggregate token_count totals,
                        the model id, and event timestamps are read; prompts,
                        completions, and tool output never enter run history.
                        The session must be bound explicitly; when the rollout
                        is unknown, omit the flag and usage stays unknown.
                        Cannot be combined with --usage-json.
  --usage-json USAGE_JSON
                        Inline JSON object with a provider-neutral per-run
                        usage measurement: input_tokens, output_tokens,
                        provider, model, source_snapshot_id, plus optional
                        cache_tokens/cost_usd/duration_ms. Must be strict
                        JSON; malformed, negative, or non-finite usage fails
                        the refresh closed. Cannot be combined with --usage-
                        codex-session.
  --dry-run             Print the refresh payload without appending.
  --no-global-sync      Do not refresh the shared global registry after
                        writing the state run.
  --suppress-external-sinks
                        Keep enabled local projections active but suppress
                        configured external sink writes for this refresh.
                        Pending sink digests remain retryable.


## loopx quota --help

usage: -c quota [-h] [--goal-id GOAL_ID] [--agent-id AGENT_ID]
                [--available-capability AVAILABLE_CAPABILITIES]
                [--include-detail {scheduler,agent-todos,user-todos,goal-boundary,vision,decisions,all}]
                [--verbose]
                [--codex-app-current-rrule CODEX_APP_CURRENT_RRULE]
                [--runtime-profile {ark_managed_agent_goal,codex_app_heartbeat,codex_app_ssh_goal,codex_cli,claude_code,kunluncode,generic_cli,outer_controller}]
                [-A]
                [-H {ark_managed_agent,codex_app,codex_app_ssh,codex_cli,generic_cli,claude_code,local_scheduler}]
                [-O {host_automation,agent_cli_loop,goal_runtime,outer_controller,none}]
                [-M {interactive,isolated_headless,hosted_automation}]
                [--turn-envelope] [--turn-instance-id TURN_INSTANCE_ID]
                [--begin-turn] [--replan-obligation-id REPLAN_OBLIGATION_ID]
                [--slots SLOTS]
                [--source {adapter,controller,heartbeat,visible-goal}]
                [--void-generated-at VOID_GENERATED_AT]
                [--reason-summary REASON_SUMMARY] [--todo-id TODO_ID]
                [--target-key TARGET_KEY] [--result-hash RESULT_HASH]
                [--material-change] [--cadence CADENCE]
                [--next-due-at NEXT_DUE_AT]
                [--next-agent-todo NEXT_AGENT_TODO]
                [--next-action-kind NEXT_ACTION_KIND]
                [--next-task-repository NEXT_TASK_REPOSITORY]
                [--next-required-capability NEXT_REQUIRED_CAPABILITIES]
                [--next-continuation-policy {independent_handoff,same_agent_non_delivery}]
                [--next-target-key NEXT_TARGET_KEY]
                [--next-user-todo NEXT_USER_TODO]
                [--next-user-task-class {user_gate,user_action}]
                [--next-claimed-by NEXT_CLAIMED_BY] [--surface SURFACE]
                [--state-key STATE_KEY] [--applied-rrule APPLIED_RRULE]
                [--failed-rrule FAILED_RRULE]
                [--failure-kind {host_tool_failure,timeout,rejected,unavailable}]
                [--reset-token RESET_TOKEN]
                [--identity-signature IDENTITY_SIGNATURE]
                [--host-match-observed] [--use-current-hint] [--dry-run]
                [--execute] [--record-host-poll] [--scan-root SCAN_ROOT]
                [--scan-path SCAN_PATH] [--use-projection-cache]
                [--write-projection-cache]
                [--projection-cache-ttl-seconds PROJECTION_CACHE_TTL_SECONDS]
                [--limit LIMIT]
                [{status,plan,should-run,monitor-poll,scheduler-ack,scheduler-ack-current,scheduler-fail-current,spend-slot,void-slot}]

positional arguments:
  {status,plan,should-run,monitor-poll,scheduler-ack,scheduler-ack-current,scheduler-fail-current,spend-slot,void-slot}
                        Use status for all groups, plan for next-turn groups,
                        should-run for one goal, monitor-poll for no-spend
                        quiet poll evidence, scheduler-ack for successful
                        Codex App RRULE state, scheduler-fail-current to
                        suppress a repeated failed host update pair, spend-
                        slot for accounting, or void-slot for a non-
                        destructive accounting correction.

options:
  -h, --help            show this help message and exit
  --goal-id GOAL_ID     Goal id to check. Required for one-goal quota
                        commands, including should-run, scheduler ACK/failure,
                        spend, and void.
  --agent-id AGENT_ID   Registered agent id for `quota should-run` and scoped
                        quota accounting commands; suppresses identity-upgrade
                        warnings and records the identity on appended
                        monitor/scheduler/spend/void events.
  --available-capability AVAILABLE_CAPABILITIES
                        For `quota should-run`, `quota monitor-poll`, `quota
                        scheduler-ack`, `quota scheduler-ack-current`, and
                        `quota spend-slot`, declare a capability available in
                        this current agent environment. Repeat the same
                        declarations for commands that recompute should-run;
                        basic local shell/filesystem capabilities are assumed.
  --include-detail {scheduler,agent-todos,user-todos,goal-boundary,vision,decisions,all}
                        Include one command-specific cold-path detail section.
                        For `quota should-run`: scheduler, agent-todos, user-
                        todos, goal-boundary, or vision. For `quota monitor-
                        poll`: decisions. Repeat for multiple sections or use
                        `all`.
  --verbose             Include the raw exception detail in failure payloads
                        for maintainer diagnosis. Off by default so the public
                        failure payload stays path-free.
  --codex-app-current-rrule CODEX_APP_CURRENT_RRULE
                        Current RRULE observed from the active Codex App
                        heartbeat. For `quota should-run`, this reconciles
                        host reality with LoopX's last scheduler ACK so a
                        stale ACK cannot suppress a required update.
  --runtime-profile {ark_managed_agent_goal,codex_app_heartbeat,codex_app_ssh_goal,codex_cli,claude_code,kunluncode,generic_cli,outer_controller}
                        Explicit scheduler runtime shortcut for a known host
                        boundary. Cannot be combined with --host-surface,
                        --scheduler-owner, or --execution-mode.
  -A, --codex-app       Compact explicit alias for --runtime-profile
                        codex_app_heartbeat. Cannot be combined with another
                        scheduler runtime or execution context.
  -H {ark_managed_agent,codex_app,codex_app_ssh,codex_cli,generic_cli,claude_code,local_scheduler}, --host-surface {ark_managed_agent,codex_app,codex_app_ssh,codex_cli,generic_cli,claude_code,local_scheduler}
                        Host surface that will consume this scheduler
                        projection.
  -O {host_automation,agent_cli_loop,goal_runtime,outer_controller,none}, --scheduler-owner {host_automation,agent_cli_loop,goal_runtime,outer_controller,none}
                        Runtime that owns the next cadence decision.
  -M {interactive,isolated_headless,hosted_automation}, --execution-mode {interactive,isolated_headless,hosted_automation}
                        Execution mode paired with --host-surface and
                        --scheduler-owner.
  --turn-envelope       For `quota should-run`, return the additive bounded
                        TurnEnvelope view. The default full decision remains
                        unchanged.
  --turn-instance-id TURN_INSTANCE_ID
                        Stable heartbeat settlement id for `quota should-run`,
                        `quota monitor-poll`, scheduler ACK/failure follow-
                        ups, and `quota spend-slot`. The guard persists one
                        idempotent receipt; reuse the same id through monitor
                        writeback, scheduler handoff, refresh-state, spend,
                        and retries.
  --begin-turn          For an initial Codex App `quota should-run`, mint and
                        persist one new Turn identity. Any explicit Todo-
                        selection command returned by the guard reuses the
                        minted identity. Cannot be combined with --turn-
                        instance-id or --todo-id.
  --replan-obligation-id REPLAN_OBLIGATION_ID
                        Typed autonomous replan obligation binding for `quota
                        spend-slot`. Use the exact value projected by the
                        original turn-scoped guard; cannot be combined with
                        --todo-id.
  --slots SLOTS         Slots to account for `quota spend-slot`.
  --source {adapter,controller,heartbeat,visible-goal}
                        Source label for `quota spend-slot`.
  --void-generated-at VOID_GENERATED_AT
                        generated_at timestamp of the quota_slot_spent run to
                        void.
  --reason-summary REASON_SUMMARY
                        Public-safe reason for `quota void-slot`.
  --todo-id TODO_ID     For Codex App `quota should-run`, select one currently
                        projected eligible action through typed same-turn
                        qualification; otherwise name the accountable Todo
                        settlement target.
  --target-key TARGET_KEY
                        Stable monitor target key for `quota monitor-poll`
                        metadata writeback.
  --result-hash RESULT_HASH
                        Public-safe result hash observed by `quota monitor-
                        poll`.
  --material-change     Mark a monitor poll as a material transition instead
                        of unchanged evidence.
  --cadence CADENCE     Monitor cadence used to compute the next due
                        timestamp, e.g. 30m, 2h, or 1d.
  --next-due-at NEXT_DUE_AT
                        Explicit ISO timestamp for the next monitor poll.
  --next-agent-todo NEXT_AGENT_TODO
                        Independent runnable advancement_task emitted when a
                        monitor poll uses --material-change; the
                        continuous_monitor remains observe-only.
  --next-action-kind NEXT_ACTION_KIND
                        Explicit action kind for a material monitor's --next-
                        agent-todo successor.
  --next-task-repository NEXT_TASK_REPOSITORY
                        Credential-free Git repository identity for a material
                        monitor's --next-agent-todo successor.
  --next-required-capability NEXT_REQUIRED_CAPABILITIES
                        Execution capability required by a material monitor's
                        --next-agent-todo successor. Repeat for multiple
                        capabilities.
  --next-continuation-policy {independent_handoff,same_agent_non_delivery}
                        Continuation policy for a material monitor's --next-
                        agent-todo successor. Defaults to independent_handoff.
  --next-target-key NEXT_TARGET_KEY
                        Stable public-safe target key for a material monitor's
                        --next-agent-todo successor. Defaults to a
                        deterministic monitor-transition key.
  --next-user-todo NEXT_USER_TODO
                        User follow-up todo to add when `--material-change` is
                        set.
  --next-user-task-class {user_gate,user_action}
                        Required with monitor-poll `--next-user-todo`:
                        user_gate for a blocking owner decision or user_action
                        for a visible reminder that must not block the bound
                        agent lane.
  --next-claimed-by NEXT_CLAIMED_BY
                        Registered agent id to claim the `--next-agent-todo`
                        follow-up.
  --surface SURFACE     Scheduler surface for scheduler ACK/failure commands;
                        defaults to codex_app.
  --state-key STATE_KEY
                        Scheduler state key for scheduler ACK/failure
                        commands.
  --applied-rrule APPLIED_RRULE
                        RRULE successfully applied by the host before `quota
                        scheduler-ack --execute`.
  --failed-rrule FAILED_RRULE
                        RRULE whose host update failed before `quota
                        scheduler-fail-current --execute`.
  --failure-kind {host_tool_failure,timeout,rejected,unavailable}
                        Bounded public-safe failure category for scheduler-
                        fail-current.
  --reset-token RESET_TOKEN
                        Optional reset token to validate before scheduler ack.
  --identity-signature IDENTITY_SIGNATURE
                        Optional identity signature to validate before
                        scheduler ack.
  --host-match-observed
                        A bound scheduler hint has authoritative host proof
                        from a successful update or matching readback, so
                        persist its exact reset-token/identity binding.
  --use-current-hint    For `quota scheduler-ack`, resolve reset token and
                        identity signature from the latest quota should-run
                        scheduler hint; `scheduler-ack-current` sets this
                        automatically.
  --dry-run             Keep quota accounting or scheduler-state writes as
                        preview-only. This is the default.
  --execute             Execute the quota accounting write or no-spend
                        scheduler-state ack.
  --record-host-poll    For `quota should-run`, record a compact host poll
                        receipt beside the goal state file so stale-loop
                        projections can distinguish a live polling driver from
                        one that died mid-wait.
  --scan-root SCAN_ROOT
                        Public files to scan for obvious private material.
                        Defaults to the LoopX install root.
  --scan-path SCAN_PATH
                        Specific public file or directory to scan. Repeatable.
                        Overrides --scan-root when set.
  --use-projection-cache
                        Read a fresh status_projection_cache_v0 snapshot
                        before building quota decisions. Misses and expired
                        snapshots fall back to full status collection.
  --write-projection-cache
                        Write the status projection cache after a full quota
                        status collection.
  --projection-cache-ttl-seconds PROJECTION_CACHE_TTL_SECONDS
                        Freshness window for --use-projection-cache. Defaults
                        to 120 seconds.
  --limit LIMIT


## loopx issue-fix --help

usage: -c issue-fix [-h]
                    {repository-memory-sync,promote-discovered-issue,workflow-plan,feasibility,pr-lifecycle,pr-gate-reconcile,pr-review-reconcile,pr-review-reconcile-acked,pr-review-ack,outcome,metrics,metrics-supplement,repository-snapshot,reviewer-plan,reviewer-request,reviewer-notification-drain,reviewer-feedback-inbox,acceptance-fixture,repo-branch-fixture,caller-repo-branch}
                    ...

positional arguments:
  {repository-memory-sync,promote-discovered-issue,workflow-plan,feasibility,pr-lifecycle,pr-gate-reconcile,pr-review-reconcile,pr-review-reconcile-acked,pr-review-ack,outcome,metrics,metrics-supplement,repository-snapshot,reviewer-plan,reviewer-request,reviewer-notification-drain,reviewer-feedback-inbox,acceptance-fixture,repo-branch-fixture,caller-repo-branch}
    repository-memory-sync
                        Plan or explicitly execute a bounded public resource
                        sync through the reusable context-provider module.
    promote-discovered-issue
                        Create or reuse a canonical public issue for an agent-
                        discovered defect, verify the PR closing reference,
                        and reconcile placeholder domain state.
    workflow-plan       Plan the full issue-fix workflow from public metadata
                        to ordered LoopX todos, validation, and PR review
                        packet readiness without writes.
    feasibility         Select exactly one fix_pr, comment_only, or
                        triage_only route from compact public-safe agent
                        observations.
    pr-lifecycle        Project a public PR lifecycle observation into a
                        successor, monitor-continuation, user-gate, or no-
                        follow-up transition.
    pr-gate-reconcile   Reconcile a merge-scoped user gate against compact
                        public PR lifecycle state before notifying the owner.
    pr-review-reconcile
                        Complete one exact nonblocking PR review user_action
                        only after owner acknowledgement and a compact
                        terminal PR observation.
    pr-review-reconcile-acked
                        Reconcile current PR review user_actions from
                        persisted exact owner acknowledgement bindings.
    pr-review-ack       Persist one typed owner acknowledgement receipt with
                        an exact goal/todo/agent/GitHub PR binding for later
                        reconciliation.
    outcome             Compose one public-safe issue-fix status/output
                        projection from existing feasibility and optional PR
                        lifecycle state.
    metrics             Compose a read-only baseline, attributable output
                        inventory, repository delta, and missing-data
                        projection from existing issue-fix domain state.
    metrics-supplement  Compose public-safe supplemental counts from existing
                        issue-fix domain state and explicit bounded event or
                        memory evidence.
    repository-snapshot
                        Collect a compact public GitHub repository snapshot
                        for issue-fix metrics and optionally retain one
                        material snapshot per day.
    reviewer-plan       Recommend reviewers from caller-approved repository
                        ownership evidence without requesting external review.
    reviewer-request    Select the top requestable non-author reviewer and,
                        with explicit external-write authority, verify a
                        formal request or its permission-only comment
                        fallback.
    reviewer-notification-drain
                        Drain one bounded batch of due reviewer notifications
                        from the grouped review-required state bucket, one PR
                        per message.
    reviewer-feedback-inbox
                        Drain or acknowledge the generic Lark event inbox
                        bound to a configured issue-fix reviewer group.
    acceptance-fixture  Run a deterministic fix loop: failing repro, minimal
                        patch, focused validation, and PR-review-ready
                        artifact.
    repo-branch-fixture
                        Run the fix loop through a temporary git repo issue
                        branch: branch, repro, patch, validation, and PR
                        evidence.
    caller-repo-branch  Prepare or execute an explicitly approved local repo
                        issue branch workflow without external comments, PR
                        creation, or merge.

options:
  -h, --help            show this help message and exit


## loopx status --help

usage: -c status [-h] [--format {markdown,json}] [--scan-root SCAN_ROOT]
                 [--scan-path SCAN_PATH] [--limit LIMIT] [--goal-id GOAL_ID]
                 [--agent-id AGENT_ID]
                 [--available-capability AVAILABLE_CAPABILITIES]
                 [--include-task-graph] [--use-projection-cache]
                 [--write-projection-cache]
                 [--projection-cache-ttl-seconds PROJECTION_CACHE_TTL_SECONDS]

options:
  -h, --help            show this help message and exit
  --format {markdown,json}
                        Output format for this subcommand. Equivalent to
                        global --format before the command.
  --scan-root SCAN_ROOT
                        Public files to scan for obvious private material.
                        Defaults to the LoopX install root.
  --scan-path SCAN_PATH
                        Specific public file or directory to scan. Repeatable.
                        Overrides --scan-root when set.
  --limit LIMIT
  --goal-id GOAL_ID     Optional goal id to focus the status projection. The
                        default remains the global dashboard/status view.
  --agent-id AGENT_ID   Registered agent id for adding agent-lane next-action
                        projection to matching status queue items.
  --available-capability AVAILABLE_CAPABILITIES
                        Declare a capability available in the current
                        execution envelope. Repeat for multiple capabilities;
                        capability-gated status fields remain absent by
                        default.
  --include-task-graph  Include the optional task_graph_projection_v0 on
                        status items. Default status output keeps this graph
                        on the cold path to stay inside the dashboard hot-path
                        budget.
  --use-projection-cache
                        Read a fresh status_projection_cache_v0 snapshot
                        before running the full status collector. Misses and
                        expired snapshots fall back to the full collector.
  --write-projection-cache
                        Write the collected status projection to the cache
                        after a full collection.
  --projection-cache-ttl-seconds PROJECTION_CACHE_TTL_SECONDS
                        Freshness window for --use-projection-cache. Defaults
                        to 120 seconds.


## loopx start-goal --help

usage: -c start-goal [-h] [--guided] [--project PROJECT] [--goal-id GOAL_ID]
                     [--display-name DISPLAY_NAME] [--agent-id AGENT_ID]
                     [--thread-id THREAD_ID] [--new-peer] [--cli-bin CLI_BIN]
                     [--host-surface {codex-app,codex-app-ssh,codex-ide-plugin,codex-cli-tui,claude-code,opencode,opencode2,traex-cli,pi,gemini-cli,cursor-agent,zcode,agy,deepseek-harness,deepseek-harness-native,ark-managed-agent,shell,other-agent}]
                     [--available-capability AVAILABLE_CAPABILITIES]
                     [--capability-route {issue-fix}] [--fine-grained]
                     (--goal-text GOAL_TEXT | --slash-command-arguments SLASH_COMMAND_ARGUMENTS)
                     [--include-command-pack-detail]

options:
  -h, --help            show this help message and exit
  --guided              Required for now: render the guided dry-run
                        transaction packet.
  --project PROJECT     Project directory to inspect.
  --goal-id GOAL_ID     Goal id. Defaults to <project-name>-goal.
  --display-name DISPLAY_NAME
                        Public display title for the goal. When omitted, a
                        public-safe title is derived from the goal text; the
                        project name only remains as a fallback.
  --agent-id AGENT_ID   Explicit registered LoopX identity for an ongoing
                        session or exact user-requested takeover. When
                        omitted, a bound thread identity is reused when
                        available; otherwise new onboarding defaults to fresh
                        registration.
  --thread-id THREAD_ID
                        Stable opaque host thread id used to reuse the bound
                        agent lane. Codex App defaults to the ambient
                        CODEX_THREAD_ID when available.
  --new-peer            Explicitly request a fresh agent identity for this
                        host thread.
  --cli-bin CLI_BIN     LoopX CLI binary name embedded in generated commands.
  --host-surface {codex-app,codex-app-ssh,codex-ide-plugin,codex-cli-tui,claude-code,opencode,opencode2,traex-cli,pi,gemini-cli,cursor-agent,zcode,agy,deepseek-harness,deepseek-harness-native,ark-managed-agent,shell,other-agent}
                        Exact host surface that will own loop activation after
                        todo writeback. When omitted, start-goal returns a
                        read-only host selection gate.
  --available-capability AVAILABLE_CAPABILITIES
                        Capability available in this host loop. Repeat for
                        multiple capabilities.
  --capability-route {issue-fix}
                        Explicit product capability route for this goal start.
                        Goal text never selects a capability route.
  --fine-grained        Persist fine-grained planning for this goal: small
                        verifiable checkpoint Todos executed in coherent
                        evidence-driven turn slices.
  --goal-text GOAL_TEXT
                        Exact goal text to plan before todo writeback.
  --slash-command-arguments SLASH_COMMAND_ARGUMENTS
                        Complete visible /loopx arguments. The CLI consumes
                        only an optional leading --fine-grained and
                        --capability-route switches and treats the remainder
                        as goal text. Use --slash-command-
                        arguments='<arguments>' when the value begins with --.
  --include-command-pack-detail
                        Include the complete nested bootstrap command pack.
                        The default guided projection keeps the actionable
                        transaction and advertises this cold path.
