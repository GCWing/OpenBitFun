# BitFun host extract — LoopX issue-fix JSON payload contract

This file is **authored by the BitFun host**, not copied from LoopX documentation.
It exists because several payload schemas that an issue-fix caller must supply are
documented **only in LoopX source code**, and the BitFun environment boundary forbids
the agent from reading a LoopX source checkout.

Pinned revision: LoopX `v1.0.1`, commit `7f2a020b18d1b5bb00da4044403ae72ddce2d743`.
Every clause below cites the source anchor it was taken from. If the pin is bumped,
re-verify those anchors; a moved line means this extract is stale.

---

## 1. `--candidate-resolution-json` (`issue_fix_candidate_resolution_v0`)

Source: `loopx/capabilities/issue_fix/candidate_preflight.py:14`, `:25-29`, `:282-341`;
worked example in `examples/issue-fix-candidate-preflight-smoke.py:71-84`.

**This flag may only be passed together with `--fetch-candidate-evidence`**
(`loopx/capabilities/issue_fix/cli.py:1008`). LoopX rejects the pair otherwise so that a
stale source binding cannot survive.

### Top-level shape

```json
{
  "schema_version": "issue_fix_candidate_resolution_v0",
  "repo": "<owner>/<name>",
  "issue_ref": "<the same issue_ref the evidence receipts used>",
  "rows": [ ... ],
  "raw_content_captured": false
}
```

- `repo` and `issue_ref` must match the evidence receipts (`candidate_preflight.py:282-285`).
- `raw_content_captured` must be literally `false` (`:286-287`). This is the field the live
  run got wrong first: `candidate_resolution must keep raw_content_captured=false`.

### `rows[]` — required fields

Each row is an object with exactly these four fields (`:299-311`):

| field | rule |
|---|---|
| `kind` | one of the three kinds below (`:299-301`) |
| `ref` | compact public-safe reference, **max 220 chars** (`:302`, `_safe_ref` `:68-72`) |
| `revision` | the source revision this row is bound to (`:309`) |
| `outcome` | must belong to that kind's outcome set (`:303`) |

Duplicate rows are rejected (`:306-308`).

### The `kind` vocabulary and its allowed `outcome` values

This table is the whole point of this file — it appears in **no** LoopX markdown document.
Source: `candidate_preflight.py:25-29`.

| `kind` | allowed `outcome` values | `revision` must equal |
|---|---|---|
| `pr_revision` | `implementation`, `not_implementation` | the **live** source revision of that PR (`:312-319`) |
| `closed_pr` | `retry_new_implementation`, `comment_only`, `skip` | the **closed** source PR revision (`:320-327`) |
| `maintainer_comment` | `non_blocking`, `comment_only`, `skip` | the comment's `updatedAt` revision (`:328-335`) |

Any other `kind` produces `candidate_resolution.rows[N].kind is unsupported`.

### Worked example (verbatim shape from the pinned smoke fixture)

```json
{
  "schema_version": "issue_fix_candidate_resolution_v0",
  "repo": "owner/name",
  "issue_ref": "#3005",
  "rows": [
    {
      "kind": "pr_revision",
      "ref": "pull_2999",
      "revision": "<40-char head revision>",
      "outcome": "implementation"
    }
  ],
  "raw_content_captured": false
}
```

---

## 2. `--candidate-preflight-json` (`issue_fix_candidate_preflight_input_v0`)

Source: `candidate_preflight.py:10-12`, contract emitted by `:32-65`, surfaced in the
`workflow-plan` packet at `:624` as `candidate_preflight.input_contract`.

The contract LoopX itself projects is authoritative and machine-readable — **prefer reading
`candidate_preflight.input_contract` from the live `workflow-plan` packet over hand-writing
this**. It states:

- `required_before_implementation: true`
- `required_evidence_fields`: `numeric_pr_evidence`, `semantic_pr_evidence`,
  `maintainer_comment_evidence` (`_EVIDENCE_QUERY_SCOPES`, `:19-23`)
- each evidence receipt needs `repo`, `issue_ref`, `query_scope`, `complete`, `truncated`, `rows`
- `negative_result_rule`: **rows may be empty only when `complete=true` and `truncated=false`**
- `semantic_evidence_rule`: cross-references require an `issue_fix_candidate_resolution_v0`
  bound to the current revision
- `decision_rule`: only `admitted + proceed` may start a new implementation

Evidence query scopes (`:19-23`):

| evidence field | `query_scope` |
|---|---|
| `numeric_pr_evidence` | `issue_specific_all_states` |
| `semantic_pr_evidence` | `issue_specific_current_revision` |
| `maintainer_comment_evidence` | `issue_specific_comment_metadata` |

---

## 3. `--repository-context-json` (`issue_fix_repository_context_input_v0`)

Source: `loopx/capabilities/issue_fix/repository_context.py:14-16`, `_INPUT_FIELDS` `:44`,
`_SOURCE_FIELDS` `:45-54`, `SOURCE_KINDS` `:19`, enums `:30-40`, contract with a
`minimal_example` at `:62-87`, validation `:117-160`.

- Top-level fields are **exactly** `schema_version`, `repository_revision`, `sources`.
  Unknown fields are rejected (`:117-160`).
- Absolute and home-relative paths are rejected.
- `freshness: current` requires `repository_revision` to be present.
- Sources whose kind is `external_expert` or `memory_retrieval` must stay `advisory`.
- Required support aspects are `change_scope`, `reproduction`, `validation`.

The live `workflow-plan` packet projects this contract as
`repository_context_input_contract` (`workflow_plan.py:714`) — **read that instead of
constructing the shape from memory.**

---

## 4. Practical rules

1. **Read the contract LoopX projects** (`candidate_preflight.input_contract`,
   `repository_context_input_contract`) out of the live packet before authoring anything.
   Those two blocks are self-describing and always current for the pinned build.
2. **Only the `rows[].kind` vocabulary in section 1 is not projected anywhere.** That is
   why this file exists.
3. Do **not** attempt to discover a schema by iterating against CLI refusals: the budget is
   one corrective attempt, and every refusal reveals a single field.
4. If a payload you need is absent from both the live packet contracts and this file, that
   is a host documentation gap — report it as a blocker with the exact CLI error text.
