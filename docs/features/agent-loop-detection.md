# Agent loop detection

A long agent turn can fail without failing: the model keeps emitting tokens, every
tool call succeeds, and the answer still goes nowhere because the model is
repeating itself. Nothing in the existing failure ladders notices — the
failed-tool recovery ladder only counts *failed* rounds, and `max_rounds` is
unlimited by default.

Agent loop detection watches that shape of turn. It observes the text a round
produced — the visible assistant output and the round's completed thinking block —
plus the round's token usage, decides from cheap heuristics whether the text has
degenerated into a repetition loop, and then applies a small intervention ladder:
report, steer, or stop. Detection never rewrites a round, never blocks a round
mid-flight, and never invents a retry.

Calibration is the default. `ai.loop_detection.mode` defaults to `telemetry`,
which detects and reports but never intervenes, so the feature has to earn the
right to change turn behavior with measured false-positive rates before
`enforce` becomes a sensible default.

## Signals and thresholds (L1)

L1 is a pure, offline detector in `openbitfun-agent-stream`
(`loop_detection`). It performs no IO and owns no clock: token deltas, chunk
boundaries, and usage counts are inputs. Both detectors keep a bounded sliding
window (16 KiB of normalized characters by default), prune older text, and report
at most one verdict per analysis pass; the wiring throttles automatic passes to
every 4 KiB of new text and forces one pass at each round boundary.

| Kind | What it means | Stream | Default threshold |
| --- | --- | --- | --- |
| `verbatim_block` | The same 50-character normalized block recurs closely together | output | 4 occurrences, mean spacing ≤ 400 characters |
| `near_repetition` | Two comparable windows are near-identical (character n-gram Jaccard over 512/2048/8192-character scales) | output | 0.85 similarity; 0.90 is "strong" |
| `phrase_stuck` | A connector token run repeats without new content (`wait`, `so`, `but`, `alternatively`, `the`, `yes`) | output and thinking | 8 consecutive repeats within 512 characters |
| `periodic_sequence` | A short unit (period 1–5) repeats with a fixed period | output | 4–16 repeats, unit difference ≤ 6 characters |
| `predictable_drift` | The repetition is a predictable enumeration (counter or letter series) | output | counter-progression classifier over 4+ samples |
| `thinking_stagnation` | Adjacent thinking blocks are near-identical | thinking | 0.70 similarity, 2 consecutive stalled steps |
| `reasoning_runaway` | Opaque reasoning keeps growing while visible output stays empty | usage | 512 reasoning tokens in a round with ≤ 16 visible completion tokens, 2 consecutive rounds |

"Stream" is where the evidence is read: the visible assistant text of a round,
the round's completed thinking block, or the round's token usage. The output
detector covers the five output kinds; the thinking detector covers adjacent
blocks, a connector run inside one thinking block, and the usage bypass.

Compression evidence (an LZ77 proxy redundancy estimate over a 4 KiB span,
threshold 0.60) is computed alongside these kinds as supporting evidence rather
than as its own verdict.

`predictable_drift` is deliberately separate from a loop and is reported with low
confidence: a counter series repeats, but the change is expected, so it may only
nudge and only when the L2 judge confirms it. `reasoning_runaway` is the single
signal available for providers that encrypt reasoning content, so its confidence
is capped and it can never stop a turn on its own.

### Structural exclusions

Repetition inside structures where it is legitimate is dropped before any
analysis, so it cannot form blocks, n-grams, connector runs, or compression
evidence:

| Excluded region | Example |
| --- | --- |
| Fenced code blocks | Repeated lines inside a code fence |
| Tables | Table rows and separator lines |
| Lists | Ordered and unordered item bodies |
| Headings | `## ...` lines |
| Block quotes | `> ...` lines |
| Horizontal rules | `---`, `***` |

Predictable numeric/alphabetic sequences are deliberately *not* in this list —
they are classified as `predictable_drift` instead — and tool-level repetition
(batch calls over different targets, equal-length polling) stays out of the text
detector entirely, because it needs progress evidence rather than text analysis.

### How a threshold is resolved

Three layers apply, in order:

1. an explicit override in `ai.loop_detection.thresholds.*` wins outright;
2. otherwise the context-profile tier scale applies to the detector baseline;
3. the detector baseline is the fallback.

A non-positive override counts as unset, so a stray `0` cannot silently disable a
signal.

The tier comes from `ContextProfilePolicy::loop_detection`
(`openbitfun-agent-runtime`), which is pure data so the detector crate and the
tier table stay independent:

| Context profile | Model capability | Threshold scale |
| --- | --- | --- |
| Long task | Standard | 1.0 |
| Long task | Weak | 1.25 |
| Conversation | Standard | 1.25 |
| Conversation | Weak | 1.5 |

Weak models move in the opposite direction from the context-compaction knobs:
compaction tightens for a weak model because it drifts sooner, while loop
detection asks for *more* evidence because a weak model repeats legitimately more
often, and a false positive costs a good turn. Counts scale upward with `ceil`
and never below one; similarity and ratio thresholds scale in the tolerance
domain (`1 - (1 - baseline) / scale`), which keeps them inside `0.0..=1.0` and
keeps the signal reportable while calibration is still running.

## The intervention ladder

The ladder (`agentic::execution::loop_detection::ladder`) is a pure per-turn
state machine. The engine feeds it the round that just finished, it returns a
decision, and the engine performs the mechanics. One ladder belongs to one dialog
turn, so a loop spanning several rounds is still one loop, and its state never
leaks into the next turn.

| Level | What happens |
| --- | --- |
| L0 — telemetry | Every verdict is logged and reported; nothing acts on it. This is `mode = telemetry`. |
| L1 — steer | A root-cause reminder is injected as a persisted internal reminder at the round boundary (`ThinkingLoopRecovery` / `OutputLoopRecovery`). The turn continues. |
| L2 — hard stop | The turn ends with `finalization_reason = loop_detected`, a final-answer round is requested, and the turn is reported as completed with that reason. |

The ladder mirrors the existing failed-tool recovery pattern: at most
`MAX_LOOP_RECOVERY_ATTEMPTS = 3` steers for a persisting signal, then one hard
fallback. A clean round resets the attempt counter, because the loop it was
watching has ended.

### Asymmetric handling

Kinds are not treated alike, because their false-positive cost is not alike:

| Kind | Steer | Hard stop |
| --- | --- | --- |
| `verbatim_block`, `phrase_stuck`, `periodic_sequence` | yes | yes |
| `thinking_stagnation` | yes | yes |
| `near_repetition` | yes | only when confidence reaches the strong band, or the judge confirms |
| `predictable_drift` | only when the judge confirms | only when the judge confirms |
| `reasoning_runaway` | yes | never, unless the judge confirms |

A capped signal past its steer cap goes quiet and stays in telemetry instead of
nagging a turn that is probably just long.

### Reminder copy

The steer reminder names the signal, the stream it came from, the confidence, and
a bounded numeric description of the pattern. It contains **no excerpt of the
repeated text**: injecting the looped passage back would re-anchor the model on
exactly the text it has to drop, and assistant text can also carry secrets. The
copy is English-only, emoji-free, and per stream — repeated visible output and
repeated internal reasoning need different next actions, and both copies are
root-cause oriented ("stop this line of reasoning and act on your conclusion",
"continue from the last point that was genuinely new, or finish").

## The L2 judge (arbitration)

L1 is a heuristic and is occasionally wrong on text that repeats for a legitimate
reason. Boundary cases get an arbitration layer: a fast model decides whether a
flagged repetition is degenerate, and its answer can suppress a verdict or
upgrade a confidence-capped kind.

**When the judge is consulted.** A verdict goes to arbitration only when the
heuristic cannot decide alone: evidence in the ambiguous band, a kind that may
not act without a classifier verdict, or a capped signal that has spent its soft
attempts and would otherwise go quiet. The judge is only consulted in
`enforce` mode, only when `ai.loop_detection.judge.enabled` is true, and only
within `ai.loop_detection.judge.max_verdicts_per_turn` (default 2) per dialog
turn.

**Judge contract.**

| Aspect | Behaviour |
| --- | --- |
| Model | `ai.default_models.fast`, falling back to `ai.default_models.primary`. No new model selector was added. |
| Avoidance | The judge is never the model whose output is under suspicion — not by model id, and not as a second configuration entry for the same provider model (same provider, model name, and base URL). |
| Input | Summary evidence only: kind, confidence, bounded statistics, and at most three whitespace-collapsed excerpts of at most 80 characters. Full thinking or output text never reaches the judge, and excerpts are framed as untrusted data. |
| Output | One JSON object: `{"verdict":"loop"\|"not_loop"\|"unclear","confidence":…,"reason":…}`. A malformed, empty, or tool-calling reply is a skip, never a guess. |
| Latency | One aggregated provider attempt, capped at 30 seconds. |
| Cost | Each attempt that reaches the provider spends one slot of the per-turn budget; disabled judge and unresolvable model spend nothing. Usage is recorded in the session token ledger. |

**Degradation.** Every unusable outcome — judge disabled, no eligible model,
budget spent, configuration or client unavailable, cancellation, timeout,
provider failure, malformed reply — keeps the heuristic verdict and its caps. A
missing or broken judge can never take L1 detection down with it, and installing
no arbiter at all is a supported configuration.

## Configuration

All settings live under `ai.loop_detection`. The section is omitted from the
persisted document while it stays at its default, so existing configuration files
are unchanged until the user or the calibration phase changes something.

### Modes

| Mode | Behaviour |
| --- | --- |
| `off` | No detection and no telemetry. The detectors are never fed. |
| `telemetry` | Detect, log, and emit the product event; never intervene. Default, and the calibration mode. |
| `enforce` | Full ladder: steer first, hard stop last. |

A mode string written by a newer build that this build does not know degrades to
`telemetry` instead of failing configuration deserialization, so an older build
never turns an unknown stronger mode into a silent hard stop.

### Fields

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | string | `telemetry` | Detection and intervention level. |
| `session_enabled` | boolean | `true` | Default state of the per-session clear-detection escape hatch. Setting it to `false` keeps detection off for every session while preserving `mode`. |
| `thresholds.*` | object | empty | Per-signal overrides; unset keeps the tier-scaled baseline. |
| `judge.enabled` | boolean | `true` | Whether the L2 judge may be consulted at all. |
| `judge.max_verdicts_per_turn` | number | `2` | Hard cap on judge verdicts per dialog turn. |

Threshold overrides (all optional; a non-positive value counts as unset):

| Field | Type | Baseline | Meaning |
| --- | --- | --- | --- |
| `exact_block_hash_chars` | number | 50 | Characters hashed into one repeated block. |
| `exact_block_min_occurrences` | number | 4 | Occurrences of the same block before the signal fires. |
| `exact_block_max_mean_gap_chars` | number | 400 | Maximum mean distance between repeats. Not tier-scaled: it is a distance cap, not a magnitude. |
| `ngram_window_similarity_min` | number | 0.85 | Window similarity that counts as repetition. |
| `ngram_window_strong_similarity` | number | 0.90 | Similarity strong enough to skip the judge. |
| `thinking_block_similarity_min` | number | 0.70 | Adjacent-block similarity that counts as one stalled step. |
| `thinking_stall_steps` | number | 2 | Consecutive stalled steps before the thinking loop is suspicious. |
| `stuck_phrase_min_repeats` | number | 8 | Repeats of a connector run that count as a stuck phrase. |
| `window_compression_ratio_min` | number | 0.60 | Window redundancy that counts as degenerate text. |
| `reasoning_bypass_min_tokens_per_sec` | number | unset | Reasoning-token growth that indicates a bypass loop. Applied as the per-round sample minimum; see the deviations below. |
| `reasoning_bypass_min_rounds` | number | 2 | Rounds a reasoning bypass must persist before it is reported. |
| `judge_verdict_confidence_min` | number | 0.9 | Accepted and round-tripped, but no consumer applies it yet; see the deviations below. |

```json
{
  "ai": {
    "loop_detection": {
      "mode": "enforce",
      "session_enabled": true,
      "thresholds": { "ngram_window_similarity_min": 0.88 },
      "judge": { "enabled": true, "max_verdicts_per_turn": 2 }
    }
  }
}
```

### Per-session escape hatch

A session can switch detection off for itself without rewriting the persisted
mode and without affecting any other session: `ai.loop_detection.session_enabled`
decides the state a new session starts from, and a session override wins over it
for that session. Turning detection off clears the detector window and the attempt
counters, so re-enabling starts from fresh evidence rather than continuing an
escalation the user already decided to ignore. The engine re-reads the flag every
round, so a mid-turn clear takes effect immediately.

Today this is reachable through the engine API
(`set_session_loop_detection_enabled`) and the configuration default; no settings
UI, command, or remote action flips it yet. That gap is listed below.

## Product surfaces

A verdict reaches product surfaces through one event, `AgenticEvent::LoopDetectionNoted`,
emitted once per ladder decision at the round boundary. It carries the session
and turn id, the detector kind, the confidence, the escalation level
(`noted` / `steered` / `stopped`), and whether the L2 judge actually arbitrated.
It carries no excerpt of the repeated text and no session-scoped state, so it can
be forwarded like any other status event.

| Surface | Behaviour |
| --- | --- |
| Web UI | Consumes the event: a non-blocking warning toast for `steered` and `stopped`, silence for report-only `noted` (logged at debug level). A turn that ended with `finish_reason = loop_detected` also gets its own turn-completion notice instead of the generic abnormal one. A hidden subagent's signal resolves its parent session for the log line. |
| CLI (interactive chat) | One transcript status line per intervention: a steer from the event, a hard stop from the turn's `loop_detected` finalization reason, so a stopped turn never prints twice. Report-only decisions stay in the log. |
| CLI (`exec` mode) | One turn-scoped status line on stderr for a steer or a hard stop; another turn's note is ignored. Report-only decisions stay out of the terminal. |
| Relay / remote control | The note is published to connected controllers as a control record (it must still reach them) and is excluded from record synchronization, because it is a live status signal rather than transcript content. Steering or cancelling that turn uses the existing remote turn controls; no loop-specific remote action was added. |
| Mobile web and IM bots | Not consumed yet. See the deviations below. |
| Swarm subagents | A child session's signal is forwarded to its parent card: the CLI writes a title on the parent Task card ("Loop detected (kind); stopped the subagent turn" or "…asked the subagent to change course"). |

## Alignment with the "Agent loop behavior" clause

The repository rule for this area (`AGENTS.md`, "Agent loop behavior") says not to
add hard-coded limits or pattern checks to the agent loop as a first response to
looping behavior, and to investigate the root cause first. Each design choice
below maps to that clause:

- **Soft first, never a gate.** The ladder's first action is a reminder that asks
  the model to change course; detection does not block a tool call, filter a
  round, or drop output. Ending a turn requires either a high-confidence signal
  that ignored three corrections, or a judge-confirmed signal.
- **No hard-coded interception.** The thresholds are not constants in the agent
  loop: the detector owns calibrated baselines behind configurable thresholds, the
  context-profile tier scales them per profile and model capability, and
  `ai.loop_detection.thresholds.*` lets a calibration report move any of them. The
  loop itself keys on no specific repeated string and on no raw repetition count.
- **Telemetry is the default.** The feature ships in report-only mode, so the
  default behavior of every existing install is unchanged and the reported
  verdicts are the evidence used to decide whether intervening is safe.
- **Root-cause-oriented, non-echoing copy.** The steer text names the observed
  signal (reasoning loop vs. output loop) and asks for the concrete next step
  instead of restating the content, which keeps the loop from being re-anchored by
  the correction itself.
- **Reuse of an existing pattern.** The three-attempt cap and the
  `finalization_reason` fallback follow the existing failed-tool recovery
  pipeline rather than adding a second, parallel stop mechanism.

## Deviations and known gaps

Recorded deliberately, so this page can be updated as each closes.

1. **No mid-round preemption.** Detection is round-quantized: the ladder observes
   a finished round, so a steer lands at the next round boundary rather than
   interrupting the round that is repeating. This is what keeps the analysis off
   the stream's per-delta hot path; a mid-round injection path is not implemented.
2. **The DITTO guard is prompt-level only.** The reminder text never echoes the
   repeated passage, but core still replays assistant reasoning content between
   rounds (only display summaries are withheld), so the looped reasoning itself
   *is* present in the next request. Dropping or summarizing looped content on
   the history side is a follow-up.
3. **The reasoning-token bypass only fires where the provider reports reasoning
   tokens.** Today that is Gemini (`thoughts_token_count`); the OpenAI, Responses,
   and Anthropic stream mappings leave `reasoning_token_count` unset, so
   `reasoning_runaway` cannot fire for them. Mapping those usage shapes is a
   follow-up.
4. **Judge usage is not in the turn's live accounting.** Arbitration tokens are
   recorded in the global token ledger (the auxiliary-call path, like
   `analyze_image`), so they appear in session usage reports, but they are not
   emitted through the turn's `TokenUsageUpdated` event. The returned judgement
   carries the usage so a caller can mirror it.
5. **Mobile web and IM bots do not show a loop-stopped turn as a loop.** The
   finalization sets `success = true` (the same convention `max_rounds` uses), and
   no remote surface consumes `LoopDetectionNoted` beyond the relay control
   record, so a bot- or mobile-driven loop ends looking like an ordinary
   completion. Follow-up.
6. **Web subagent bubbling is log-level only.** The web notice is a toast keyed by
   the session that produced it, and the resolved parent session appears in the
   log line; only the CLI writes the intervention onto the parent Task card.
7. **The arbitration port carries no cancellation token.** The port call is
   bounded by the judge's own 30-second timeout instead of the dialog turn's
   token, so a cancelled turn can spend at most one bounded judge call. The judge
   itself refuses to start for an already-cancelled request when a caller supplies
   a token.
8. **Similarity and ratio thresholds are scaled in the tolerance domain.** The
   tier scale is applied to `1 - baseline` rather than to the ratio, because
   multiplying a ratio baseline by 1.25 or 1.5 would leave `0.0..=1.0` and
   effectively mute the signal exactly where calibration needs data from it. The
   distance cap is not tier-scaled at all, because a stricter tier there would mean
   *closer* repeats, which is a different control direction.
9. **`judge_verdict_confidence_min` has no consumer yet.** The field is accepted,
   documented, and round-tripped, but neither the intervention ladder nor the
   arbitration port applies it: the judge's own prompt carries the confidence
   rules, and the ladder applies no judge-confidence gate.
10. **The per-session escape hatch has no product surface.** It is an engine API
    plus the `session_enabled` default; nothing in the settings UI, the CLI, or
    the remote protocol toggles it yet.
11. **Compression evidence is an LZ77 proxy, not zlib.** The plan's wording was
    "zlib ratio"; adding a compression dependency to the dependency-light stream
    crate was not worth it, so the detector uses a deterministic, documented,
    more conservative redundancy estimate.
12. **`reasoning_bypass_min_tokens_per_sec` is applied per round sample.** The
    detector has no clock (deliberate), so the configured rate acts as the
    minimum reasoning-token growth of one round sample. Re-deriving it from
    measured round durations is a calibration-phase task.

## Calibration plan

The feature ships in `telemetry` mode, which produces the data needed to decide
whether `enforce` should become the default.

### What to read

- **Verdict lines** (warning level, one per round observation):
  `Loop detection verdict: session_id=…, turn_id=…, round_index=…, profile=…, source=…, kind=…, confidence=…, verdict_count=…, steer_attempts=…, arbitration=…, escalation=…`.
  `escalation` is `telemetry` while the ladder deliberately did not act, and
  `arbitration` is `confirmed`, `rejected`, `indeterminate`, or `none`.
- **Context-health snapshots** (debug level) carry the same signal per round,
  which is what makes it possible to correlate a verdict with context pressure and
  tool-signature health in one line.
- **Arbitration lines** (debug level) record each delegation and each decision.
  They only appear in `enforce` mode, because that is when the judge is consulted.

### What to tune

The 12 threshold overrides above, plus the tier table in
`ContextProfilePolicy::loop_detection` if a whole profile turns out to be
systematically miscalibrated. Overrides are the expected lever: unset values stay
unset in the persisted document, so a calibration report can tell a tuned knob
from an untouched one. The three knobs to treat carefully are the strong-similarity
band (it is the boundary between "steer" and "steer or stop"), the stuck-phrase
repeat count (chatty but legitimate prose is the main false-positive source), and
the reasoning-token sample minimum (it only applies to providers that report
reasoning tokens).

### Before `enforce` becomes the default

The report needs, per context profile and per model capability, the number of
verdicts per kind, how many decisions a human judged to be false positives, and
the outcome distribution of the arbitrations. A steer is cheap enough to tolerate
occasionally; a hard stop is not, because it ends a turn the user cannot resume
in place. Flips of the default, and any promotion of a capped kind to a hard stop,
are a review decision on that report, not a side effect of this feature shipping.

## Source map

| Concern | Owner |
| --- | --- |
| Detector core, baselines, verdict shape | `openbitfun-agent-stream` (`loop_detection`) |
| Tier table and structural-exclusion policy | `openbitfun-agent-runtime` (`context_profile`) |
| Threshold translation, ladder, reminder copy, arbitration port | `openbitfun-core` (`agentic::execution::loop_detection`) |
| Model-backed judge | `openbitfun-core` (`agentic::execution::loop_arbiter`) |
| Configuration shape | `openbitfun-config-contracts` (`LoopDetectionConfig`) |
| Event contract and frontend projection | `openbitfun-events` (`AgenticEvent::LoopDetectionNoted`) |
| Web, CLI, and relay surfaces | `src/web-ui`, `src/apps/cli`, `services-integrations` remote connect |

Focused test commands live next to the code they cover; the execution crate guide
(`src/crates/assembly/core/src/agentic/execution/AGENTS.md`) lists the
loop-detection and loop-arbiter suites.
