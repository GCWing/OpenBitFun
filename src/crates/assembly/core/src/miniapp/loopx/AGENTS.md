[中文](AGENTS-CN.md) | **English**

# LoopX Host Subsystem Guide

Scope: the BitFun host adaptation layer for LoopX-controlled work. This spans
two crates:

- `src/crates/assembly/core/src/miniapp/loopx/` — controller (scheduling,
  settlement application, recovery), agent adapter, session lifecycle
- `src/crates/services/services-integrations/src/miniapp/loopx_cli.rs` —
  pinned-CLI adapter: guard/turn/settle command shapes, turn instruction
  composition, settlement evidence verification
- `src/crates/services/services-integrations/src/miniapp/loopx_workspace.rs` —
  worktree lifecycle (prepare/dispose/reset)

Codex runs LoopX with no host-specific logic; this layer is BitFun's product
difference, so its rules are stricter than the generic agent-loop guidance.

## Settlement contract

A LoopX turn settles only on the **two-part receipt**: a durable writeback
(matching the turn's guard binding: selected todo or replan obligation) AND a
quota spend receipt for the same effect id. Prompt guidance asks the agent to
produce both; verification never trusts prose.

## The host-fallback principle

**Prompt hardening reduces the probability of an agent mistake; only host-side
compensation removes the failure class.** Multi-step closing sequences
(writeback → spend → terminal vision) rely on the model executing every step
voluntarily, and live runs show it sometimes does not. The rule for choosing a
fix:

1. **Mechanical, derivable-from-host-state steps belong to the host.** If the
   controller already holds the exact values (guard binding, turn id, recorded
   vision patch, spend command shape), generate or compensate the step
   host-side instead of asking the agent to re-derive it. Example: the settle
   path compensates a missing quota spend itself (`quota_spend_compensation_args`)
   because spend is idempotent bookkeeping, not a semantic claim.
2. **Semantic steps stay with the agent, but the host pre-resolves their
   inputs.** The terminal vision packet must reuse recorded durable fields
   verbatim; the host queries the recorded vision through the CLI's own status
   projection and embeds it in the turn instruction, so the agent copies
   instead of authoring.
3. **Never fabricate evidence.** Host compensation must be auditable and
   idempotent; a compensated spend is logged, and a permanently missing
   receipt degrades loudly (recovery card), never silently.

## Known agent failure modes and their defenses

Observed live (2026-09-10 three-issue experiment) and their current defenses —
keep this list current when a new mode appears:

| Failure mode | Defense |
| --- | --- |
| Terminal vision packet reworded durable fields → unsatisfiable `outcome=replan` vs `no_followup` pair | Host embeds recorded vision verbatim + character-compare instruction (`render_agent_reentry_instruction`) |
| Successor todo created mid-turn and settled with `--todo-id` against a turn bound to the replan obligation | Turn-scoped binding rule in the work clause; CLI rejects, next turn self-heals |
| Writeback validated but quota spend skipped | Host-side spend compensation in `verify_turn_settlement`; prompt marks the spend MANDATORY |
| Workspace root rename fails after stop (lingering handles) | Rename retry with bounded backoff + turn-cancel waits for full drain |

When a new failure mode appears, first ask whether the step is mechanical
(host-compensate) or semantic (host pre-resolves inputs), then fix at that
layer. Do not respond to a repeated agent mistake with more prompt text alone.

## Verification

```bash
cargo test -p openbitfun-services-integrations --no-default-features --features miniapp-loopx --lib -- loopx_cli
cargo test -p openbitfun-services-integrations --no-default-features --features miniapp-loopx --test miniapp_loopx_contracts
```

Add or extend instruction-composition tests when changing turn guidance, and
settlement tests when changing compensation logic.
