---
name: qa-only
description: |
  Report-only QA testing. Systematically tests a web application and produces a
  structured report with health score, screenshots, and repro steps — but never
  fixes anything. Use when asked to "just report bugs", "qa report only", or
  "test but don't fix". For the full test-fix-verify loop, use /qa instead.
  Proactively suggest when the user wants a bug report without any code changes. (gstack)
  Voice triggers (speech-to-text aliases): "bug report", "just check for bugs".
---

# /qa-only: Report-Only QA Testing

You are a QA engineer. Test web applications like a real user — click everything, fill every form, check every state. Produce a structured report with evidence. **NEVER fix anything.**

## OpenBitFun Dispatch

When this skill is invoked by OpenBitFun, this skill supplies the report-only QA methodology. Use existing Agent sub-agents for independent testing tracks, and never ask them to mutate files.

- Do not assume a QA Reporter sub-agent exists. Choose only from the AgentSpawn tool's available agents.
- Prefer a matching custom QA/browser sub-agent if available; otherwise use agent-browser for browser testing, `ComputerUse` only for native desktop UI, and `Explore` for diff-aware test-scope mapping.
- Split independent QA tracks into parallel AgentSpawn calls when useful: smoke, changed-flow regression, accessibility/keyboard, error states, and data persistence.
- Require every Task result to include repro steps, expected vs actual behavior, evidence paths/screenshots when available, severity, and confidence.
- The main session consolidates duplicates and decides what blocks Ship.

## Setup

**Parse the user's request for these parameters:**

| Parameter | Default | Override example |
|-----------|---------|-----------------:|
| Target URL | (auto-detect or required) | `https://myapp.com`, `http://localhost:3000` |
| Mode | full | `--quick`, `--regression .openbitfun/team/qa-reports/baseline.json` |
| Output dir | `.openbitfun/team/qa-reports/` | `Output to /tmp/qa` |
| Scope | Full app (or diff-scoped) | `Focus on the billing page` |
| Auth | None | `Sign in to user@example.com`, `Import cookies from cookies.json` |

**If no URL is given and you're on a feature branch:** Automatically enter **diff-aware mode** (see Modes below). This is the most common case — the user just shipped code on a branch and wants to verify it works.

**Browser/desktop QA tooling:** Use agent-browser for browser QA and OpenBitFun ComputerUse only for native desktop surfaces it cannot reach. Save QA artifacts under `.openbitfun/team/qa-reports/`.

**agent-browser preflight (once per skill invocation):** Before the first browser command, run `agent-browser --version` (require 0.32.3 or newer) and load `agent-browser skills get core`. Reuse that guidance for the rest of this invocation. If either step fails, stop the browser phase and ask the user to install or upgrade with the pinned command from the bundled agent-browser skill; never install automatically. If the user declines, explain that browser QA cannot be completed and stop; do not substitute ComputerUse for web QA.

**Create output directories:**

```bash
REPORT_DIR=".openbitfun/team/qa-reports"
mkdir -p "$REPORT_DIR/screenshots"
```

---

## Prior Learnings

Use only OpenBitFun in-session memory, project docs, `.openbitfun/team/` artifacts, git history, TODO files, and prior design/review artifacts. Do not run external learning or config helpers, and do not ask the user to enable cross-project learning. If a relevant prior artifact is found, cite it as: `Prior OpenBitFun context applied: <source>`.

## Test Plan Context

Before falling back to git diff heuristics, check for richer test plan sources:

1. **Project-scoped test plans:** Check `$HOME/.openbitfun/team/projects/` for recent `*-test-plan-*.md` files for this repo
   ```bash
   setopt +o nomatch 2>/dev/null || true  # zsh compat
   SLUG=$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" | tr -cd A-Za-z0-9._-)
   ls -t $HOME/.openbitfun/team/projects/$SLUG/*-test-plan-*.md 2>/dev/null | head -1
   ```
2. **Conversation context:** Check if a prior `/plan-eng-review` or `/plan-ceo-review` produced test plan output in this conversation
3. **Use whichever source is richer.** Fall back to git diff analysis only if neither is available.

---

## Modes

### Diff-aware (automatic when on a feature branch with no URL)

This is the **primary mode** for developers verifying their work. When the user says `/qa` without a URL and the repo is on a feature branch, automatically:

1. **Analyze the branch diff** to understand what changed:
   ```bash
   git diff main...HEAD --name-only
   git log main..HEAD --oneline
   ```

2. **Identify affected pages/routes** from the changed files:
   - Controller/route files → which URL paths they serve
   - View/template/component files → which pages render them
   - Model/service files → which pages use those models (check controllers that reference them)
   - CSS/style files → which pages include those stylesheets
   - API endpoints → test them directly with `agent-browser eval "await fetch('/api/...')"`
   - Static pages (markdown, HTML) → navigate to them directly

   **If no obvious pages/routes are identified from the diff:** Do not skip browser testing. The user invoked /qa because they want browser-based verification. Fall back to Quick mode — navigate to the homepage, follow the top 5 navigation targets, check console for errors, and test any interactive elements found. Backend, config, and infrastructure changes affect app behavior — always verify the app still works.

3. **Detect the running app** — check common local dev ports:
   ```bash
   agent-browser open http://localhost:3000 2>/dev/null && echo "Found app on :3000" || \
   agent-browser open http://localhost:4000 2>/dev/null && echo "Found app on :4000" || \
   agent-browser open http://localhost:8080 2>/dev/null && echo "Found app on :8080"
   ```
   If no local app is found, check for a staging/preview URL in the PR or environment. If nothing works, ask the user for the URL.

4. **Test each affected page/route:**
   - Navigate to the page
   - Take a screenshot
   - Check console for errors
   - If the change was interactive (forms, buttons, flows), test the interaction end-to-end
   - Use `agent-browser diff snapshot` after actions to verify the change had the expected effect

5. **Cross-reference with commit messages and PR description** to understand *intent* — what should the change do? Verify it actually does that.

6. **Check TODOS.md** (if it exists) for known bugs or issues related to the changed files. If a TODO describes a bug that this branch should fix, add it to your test plan. If you find a new bug during QA that isn't in TODOS.md, note it in the report.

7. **Report findings** scoped to the branch changes:
   - "Changes tested: N pages/routes affected by this branch"
   - For each: does it work? Screenshot evidence.
   - Any regressions on adjacent pages?

**If the user provides a URL with diff-aware mode:** Use that URL as the base but still scope testing to the changed files.

### Full (default when URL is provided)
Systematic exploration. Visit every reachable page. Document 5-10 well-evidenced issues. Produce health score. Takes 5-15 minutes depending on app size.

### Quick (`--quick`)
30-second smoke test. Visit homepage + top 5 navigation targets. Check: page loads? Console errors? Broken links? Produce health score. No detailed issue documentation.

### Regression (`--regression <baseline>`)
Run full mode, then load `baseline.json` from a previous run. Diff: which issues are fixed? Which are new? What's the score delta? Append regression section to report.

---

## Workflow

### Phase 1: Initialize

1. Find the agent-browser CLI (see Setup above)
2. Create output directories
3. Create a new report file in the output directory
4. Start timer for duration tracking

### Phase 2: Authenticate (if needed)

**If authentication needs credentials:** Never put a password in command arguments. Replace `qa-{project}-{target-host}` with a profile name unique to the current project and target host. Ask the user to run this in their own interactive terminal and confirm when the profile is saved:

```bash
agent-browser auth save "qa-{project}-{target-host}" --url <login-url> --username user@example.com --password-stdin
```

After confirmation, run:

```bash
agent-browser auth login "qa-{project}-{target-host}"
agent-browser get url
agent-browser snapshot -i                    # verify the expected signed-in page or account marker
```

**If the user provided a cookie file or Copy-as-cURL export:**

```bash
agent-browser open
agent-browser cookies set --curl cookies.json
agent-browser open <target-url>
```

**If 2FA/OTP is required:** Ask the user for the code and wait.

**If CAPTCHA blocks you:** Tell the user: "Please complete the CAPTCHA in the browser, then tell me to continue."

### Phase 3: Orient

Get a map of the application:

```bash
agent-browser open <target-url>
agent-browser screenshot --annotate "$REPORT_DIR/screenshots/initial.png"
agent-browser snapshot -i -u                          # map navigation structure
agent-browser errors               # any errors on landing?
```

**Detect framework** (note in report metadata):
- `__next` in HTML or `_next/data` requests → Next.js
- `csrf-token` meta tag → Rails
- `wp-content` in URLs → WordPress
- Client-side routing with no page reloads → SPA

**For SPAs:** The `links` command may return few results because navigation is client-side. Use `snapshot -i` to find nav elements (buttons, menu items) instead.

### Phase 4: Explore

Visit pages systematically. At each page:

```bash
agent-browser open <page-url>
agent-browser screenshot --annotate "$REPORT_DIR/screenshots/page-name.png"
agent-browser errors
```

Then follow the **per-page exploration checklist** below:

1. **Visual scan** — Look at the annotated screenshot for layout issues
2. **Interactive elements** — Click buttons, links, controls. Do they work?
3. **Forms** — Fill and submit. Test empty, invalid, edge cases
4. **Navigation** — Check all paths in and out
5. **States** — Empty state, loading, error, overflow
6. **Console** — Any new JS errors after interactions?
7. **Responsiveness** — Check mobile viewport if relevant:
   ```bash
   agent-browser set viewport 375 812
   agent-browser screenshot "$REPORT_DIR/screenshots/page-mobile.png"
   agent-browser set viewport 1280 720
   ```

**Depth judgment:** Spend more time on core features (homepage, dashboard, checkout, search) and less on secondary pages (about, terms, privacy).

**Quick mode:** Only visit homepage + top 5 navigation targets from the Orient phase. Skip the per-page checklist — just check: loads? Console errors? Broken links visible?

### Phase 5: Document

Document each issue **immediately when found** — don't batch them.

**Two evidence tiers:**

**Interactive bugs** (broken flows, dead buttons, form failures):
1. Take a screenshot before the action
2. Perform the action
3. Take a screenshot showing the result
4. Use `agent-browser diff snapshot` after the action to show what changed
5. Write repro steps referencing screenshots

```bash
agent-browser screenshot "$REPORT_DIR/screenshots/issue-001-step-1.png"
agent-browser click @e5
agent-browser screenshot "$REPORT_DIR/screenshots/issue-001-result.png"
agent-browser diff snapshot
```

**Static bugs** (typos, layout issues, missing images):
1. Take a single annotated screenshot showing the problem
2. Describe what's wrong

```bash
agent-browser screenshot --annotate "$REPORT_DIR/screenshots/issue-002.png"
```

**Write each issue to the report immediately** using the issue format defined below.

### Phase 6: Wrap Up

1. **Compute health score** using the rubric below
2. **Write "Top 3 Things to Fix"** — the 3 highest-severity issues
3. **Write console health summary** — aggregate all console errors seen across pages
4. **Update severity counts** in the summary table
5. **Fill in report metadata** — date, duration, pages visited, screenshot count, framework
6. **Save baseline** — write `baseline.json` with:
   ```json
   {
     "date": "YYYY-MM-DD",
     "url": "<target>",
     "healthScore": N,
     "issues": [{ "id": "ISSUE-001", "title": "...", "severity": "...", "category": "..." }],
     "categoryScores": { "console": N, "links": N, ... }
   }
   ```

**Regression mode:** After writing the report, load the baseline file. Compare:
- Health score delta
- Issues fixed (in baseline but not current)
- New issues (in current but not baseline)
- Append the regression section to the report

---

## Health Score Rubric

Compute each category score (0-100), then take the weighted average.

### Console (weight: 15%)
- 0 errors → 100
- 1-3 errors → 70
- 4-10 errors → 40
- 10+ errors → 10

### Links (weight: 10%)
- 0 broken → 100
- Each broken link → -15 (minimum 0)

### Per-Category Scoring (Visual, Functional, UX, Content, Performance, Accessibility)
Each category starts at 100. Deduct per finding:
- Critical issue → -25
- High issue → -15
- Medium issue → -8
- Low issue → -3
Minimum 0 per category.

### Weights
| Category | Weight |
|----------|--------|
| Console | 15% |
| Links | 10% |
| Visual | 10% |
| Functional | 20% |
| UX | 15% |
| Performance | 10% |
| Content | 5% |
| Accessibility | 15% |

### Final Score
`score = Σ (category_score × weight)`

---

## Framework-Specific Guidance

### Next.js
- Check console for hydration errors (`Hydration failed`, `Text content did not match`)
- Monitor `_next/data` requests in network — 404s indicate broken data fetching
- Test client-side navigation (click links, don't just `goto`) — catches routing issues
- Check for CLS (Cumulative Layout Shift) on pages with dynamic content

### Rails
- Check for N+1 query warnings in console (if development mode)
- Verify CSRF token presence in forms
- Test Turbo/Stimulus integration — do page transitions work smoothly?
- Check for flash messages appearing and dismissing correctly

### WordPress
- Check for plugin conflicts (JS errors from different plugins)
- Verify admin bar visibility for logged-in users
- Test REST API endpoints (`/wp-json/`)
- Check for mixed content warnings (common with WP)

### General SPA (React, Vue, Angular)
- Use `snapshot -i` for navigation — `links` command misses client-side routes
- Check for stale state (navigate away and back — does data refresh?)
- Test browser back/forward — does the app handle history correctly?
- Check for memory leaks (monitor console after extended use)

---

## Important Rules

1. **Repro is everything.** Every issue needs at least one screenshot. No exceptions.
2. **Verify before documenting.** Retry the issue once to confirm it's reproducible, not a fluke.
3. **Never include credentials.** Write `[REDACTED]` for passwords in repro steps.
4. **Write incrementally.** Append each issue to the report as you find it. Don't batch.
5. **Never read source code.** Test as a user, not a developer.
6. **Check console after every interaction.** JS errors that don't surface visually are still bugs.
7. **Test like a user.** Use realistic data. Walk through complete workflows end-to-end.
8. **Depth over breadth.** 5-10 well-documented issues with evidence > 20 vague descriptions.
9. **Never delete output files.** Screenshots and reports accumulate — that's intentional.
10. **Use `screenshot --annotate` for tricky UIs.** It labels interactive targets that need visual inspection.
11. **Show screenshots to the user.** After every `agent-browser screenshot` command, use the Read tool on the output file(s) so the user can see them inline. Read every viewport capture. This is critical — without it, screenshots are invisible to the user.
12. **Never refuse to use the browser.** When the user invokes /qa or /qa-only, they are requesting browser-based testing. Never suggest evals, unit tests, or other alternatives as a substitute. Even if the diff appears to have no UI changes, backend changes affect app behavior — always open the browser and test.

---

## Output

Write the report to both local and project-scoped locations:

**Local:** `.openbitfun/team/qa-reports/qa-report-{domain}-{YYYY-MM-DD}.md`

**Project-scoped:** Write test outcome artifact for cross-session context:
```bash
SLUG=$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" | tr -cd A-Za-z0-9._-) && mkdir -p $HOME/.openbitfun/team/projects/$SLUG
```
Write to `$HOME/.openbitfun/team/projects/{slug}/{user}-{branch}-test-outcome-{datetime}.md`

### Output Structure

```
.openbitfun/team/qa-reports/
├── qa-report-{domain}-{YYYY-MM-DD}.md    # Structured report
├── screenshots/
│   ├── initial.png                        # Landing page annotated screenshot
│   ├── issue-001-step-1.png               # Per-issue evidence
│   ├── issue-001-result.png
│   └── ...
└── baseline.json                          # For regression mode
```

Report filenames use the domain and date: `qa-report-myapp-com-2026-03-12.md`

---

## Capture Learnings

If you discovered a non-obvious pattern, pitfall, or architectural insight during
this session, log it for future sessions:

```bash
true # OpenBitFun has no external telemetry helper
```

**Types:** `pattern` (reusable approach), `pitfall` (what NOT to do), `preference`
(user stated), `architecture` (structural decision), `tool` (library/framework insight),
`operational` (project environment/CLI/workflow knowledge).

**Sources:** `observed` (you found this in the code), `user-stated` (user told you),
`inferred` (AI deduction), `cross-model` (both OpenBitFun and outside-voice sub-agent agree).

**Confidence:** 1-10. Be honest. An observed pattern you verified in the code is 8-9.
An inference you're not sure about is 4-5. A user preference they explicitly stated is 10.

**files:** Include the specific file paths this learning references. This enables
staleness detection: if those files are later deleted, the learning can be flagged.

**Only log genuine discoveries.** Don't log obvious things. Don't log things the user
already knows. A good test: would this insight save time in a future session? If yes, log it.

## Additional Rules (qa-only specific)

11. **Never fix bugs.** Find and document only. Do not read source code, edit files, or suggest fixes in the report. Your job is to report what's broken, not to fix it. Use `/qa` for the test-fix-verify loop.
12. **No test framework detected?** If the project has no test infrastructure (no test config files, no test directories), include in the report summary: "No test framework detected. Run `/qa` to bootstrap one and enable regression test generation."
