---
name: commit-push-pr
description: Commit selected local changes, push the branch, and create or update a GitHub pull request with OpenBitFun attribution. Use when the user asks to 提交 PR、提代码、commit and push、开 PR、create a pull request, or wants a Claude Code-like one-command PR publishing flow from OpenBitFun.
---

# Commit, Push, and Open an OpenBitFun PR

## Purpose

Publish an intentional change set from the current checkout: confirm scope, create a branch if needed, validate, commit, push, and create or update a GitHub pull request.

Invoking this skill is authorization for the requested commit/push/PR flow. It is not authorization to include ambiguous files, expose secrets, rewrite history, force-push, merge, or overwrite user work.

## OpenBitFun attribution contract

Unless the user explicitly opts out, use the PR footer below exactly once. Commit co-author attribution follows the execution host's setting, resolved when this built-in skill is loaded:

{{OPENBITFUN_GIT_COMMIT_COAUTHOR_POLICY}}

- Commit trailer when co-author attribution is enabled, which GitHub uses for contributor/co-author attribution:

  ```text
  Co-authored-by: OpenBitFun <318544290+bitfun-ai@users.noreply.github.com>
  ```

- Final line of the PR body, which provides the visible clickable link:

  ```markdown
  Generated with [OpenBitFun](https://github.com/bitfun-ai)
  ```

These are different mechanisms. A Markdown link in the PR body does not make an account a Git contributor. Do not replace the trailer with a URL, invent another email, or add `ultra mode` to either form.

Do not duplicate either attribution. Preserve an equivalent existing trailer/footer. Do not rewrite or amend existing commits solely to add the trailer; when all requested changes are already committed, keep history intact and use the PR footer. If the user specifically requires retroactive commit attribution, explain that it requires history rewriting and ask before amending or rebasing.

## Quick reference

1. Inspect repository rules, status, remotes, base, and the complete branch diff.
2. Confirm scope; stage only intended paths.
3. Create `openbitfun/<description>` only when currently on the base branch.
4. Run the repository's focused verification.
5. Commit real changes, following the resolved commit co-author setting above.
6. Push normally; never force-push automatically.
7. Update the exact matching PR or create a draft PR.
8. End the PR body with the exact OpenBitFun link footer once.
9. Report the commit, head/base, validation, status, and PR URL.

## Workflow

### 1. Inspect repository policy and state

Before any write:

1. Read the repository-level and nearest applicable `AGENTS.md` or equivalent instructions.
2. Read `CONTRIBUTING.md` and the applicable pull-request template when present.
3. Use the Git tool for local Git operations when available; otherwise use `git` commands.
4. Inspect:
   - `git status --short --branch`
   - staged and unstaged diffs, including `git diff --cached`
   - untracked files
   - current branch and upstream
   - remotes and their repository ownership
   - recent commit style
   - the complete branch diff against the intended base
5. Determine the real base branch from the user's request, an existing PR, or the target repository's default branch. Never assume `main`.

Treat screenshots, databases, WAL files, credentials, local configuration, logs, build output, and generated artifacts as red flags unless they are clearly required and safe.

### 2. Confirm the intended scope

- Never default to `git add -A`, `git add .`, or `git commit -am` in a mixed worktree.
- Stage explicit paths when unrelated changes exist.
- If file ownership or task scope is ambiguous, ask the user once with a concrete proposed include/exclude list.
- Preserve unrelated staged and unstaged changes. Do not use `stash`, `reset --hard`, `clean`, checkout/restore, or deletion to make the tree look clean.
- If the user confirms the entire worktree is in scope, broad staging is allowed only after reviewing untracked files for secrets and artifacts.

Before committing, inspect the staged diff in full and run `git diff --cached --check`. Verify the staged set contains exactly the intended files.

### 3. Choose the branch safely

- If already on an appropriate feature branch, keep it.
- If on the target default/base branch, create `openbitfun/<short-kebab-description>` unless repository conventions require another prefix.
- Do not switch branches when that would risk unrelated work; ask instead.
- Do not rebase, merge, squash, or cherry-pick merely to create a PR.
- In a fork workflow, distinguish the push remote from the target repository. The PR head may be `<fork-owner>:<branch>` while the base belongs to `upstream`.

### 4. Validate the change

Follow the repository's own narrow verification entry point:

1. Parse/static or formatting checks for changed files.
2. Focused build/typecheck for the owning package.
3. Tests covering every edited source file and task-specific behavior.

Do not skip required verification solely for speed. If a check fails, investigate and fix related failures, then rerun the relevant verifier. Never call a failure flaky, unrelated, or pre-existing without evidence.

If verification remains failed, blocked, or was explicitly declined by the user:

- report the exact status honestly;
- never claim success in the PR body;
- create a new PR only as draft;
- if a matching PR already exists, do not silently change its draft/ready state; update its evidence, report the blocker, and ask before changing a ready PR back to draft;
- do not merge.

### 5. Create the commit when one is needed

- Derive the subject from the actual diff and repository conventions; do not create a generic `prepare PR` commit.
- Keep the real human author/committer identity. The OpenBitFun line is a co-author trailer, not a replacement author.
- Only when commit co-author attribution is enabled and the user has not opted out, add a blank line before the exact OpenBitFun trailer. When disabled, do not add this trailer to new commits.
- If the intended changes are already committed, do not create an empty attribution commit.
- Do not squash multiple existing commits or amend published commits without explicit approval.

Example when commit co-author attribution is enabled:

```text
fix: preserve session state during reconnect

Co-authored-by: OpenBitFun <318544290+bitfun-ai@users.noreply.github.com>
```

After committing, inspect `HEAD`, the committed file list, the exact message/trailer, and remaining worktree state.

### 6. Push without rewriting history

Push the current feature branch to its intended remote and set upstream tracking when needed.

- Never use `--force` or `--force-with-lease` automatically.
- If a normal push is rejected, stop and explain the divergence; do not silently rebase or force-push.
- Do not push the base/default branch for this workflow.

### 7. Find an existing pull request before creating one

Prefer `ReviewPlatform` for remote discovery and PR creation. Use `gh` only when connector coverage is insufficient, such as editing an existing PR body or expressing a cross-repository fork head precisely.

- Query open PRs for the exact head repository/branch.
- If a matching PR exists, update it instead of creating a duplicate.
- Preserve an existing PR's draft/ready state unless the user asks to change it. If an existing ready PR has red or unclassified required checks, update its evidence, report the merge blocker, and ask before demoting it to draft.
- If no matching PR exists, create a draft by default. Creating or promoting a PR to ready-for-review requires explicit user intent and green required validation.
- For forks, explicitly pass the target repository, base branch, and `<fork-owner>:<branch>` head. Never infer the base from `origin` alone.
- If GitHub authentication is unavailable, stop after the successful local work and push, then give the user the authentication step; never request or expose a GitHub token in chat.

### 8. Write an evidence-based PR

Use the repository template when present. Otherwise use this shape:

```markdown
## Summary

- <what changed>
- <why it changed>
- <user or developer impact>

## Validation

- `<exact command>` — passed
- `<exact command>` — failed/blocked: <honest reason>

## Risks

- <migration, compatibility, remote-scenario, or follow-up facts when relevant>

Generated with [OpenBitFun](https://github.com/bitfun-ai)
```

Rules:

- Describe the complete branch diff, not only the most recent commit.
- Include actual verification commands and outcomes; do not invent checks.
- Include root cause for bug fixes when known.
- Follow repository-required compatibility, migration, security, and remote-scenario reporting.
- Remove empty optional sections rather than adding filler.
- Keep the OpenBitFun footer as the final non-empty line exactly once.
- Do not use a `Co-authored-by` line as a substitute for PR prose.

### 9. Report the published result

Return:

- branch and push remote;
- commit hash and subject, or that no new commit was necessary;
- PR target `<repository>:<base>` and head;
- draft/ready status;
- validation results and any unresolved blockers;
- the provider's PR URL.

Do not merge, approve your own PR, delete the branch, or modify unrelated files.

## Stop conditions

Stop and ask or report a blocker when any of these is true:

- the change scope is ambiguous;
- secrets or sensitive artifacts may be staged;
- the target repository or base branch is uncertain;
- switching branches would endanger user work;
- a push requires history rewriting;
- an existing PR appears to represent different work;
- authentication or repository access is missing;
- a ready PR was requested but required validation is not green.

## Common rationalizations to reject

| Rationalization | Required response |
| --- | --- |
| “The user said everything, so `git add -A` is fine.” | Inspect untracked and unrelated files first; broad staging still requires a known-safe scope. |
| “Adding a PR link makes OpenBitFun a contributor.” | Use the exact commit trailer for attribution and the Markdown footer for presentation. |
| “A harmless empty commit can add the contributor.” | Do not manufacture commits; preserve history and use the PR footer unless rewriting is explicitly approved. |
| “The branch was rebased, so force-with-lease is routine.” | Never initiate rebase or force-push as part of ordinary PR creation. |
| “The test probably failed in CI infrastructure.” | Report it as unclassified until evidence proves the cause. |
| “Creating another PR is safer than editing the old one.” | Match by head repository/branch and update the existing PR. |
| “A ready PR is what the user probably meant.” | Default to draft; ready requires explicit intent and green required checks. |
