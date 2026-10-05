---
name: design-review
description: |
  Designer's eye QA: finds visual inconsistency, spacing issues, hierarchy problems,
  AI slop patterns, and slow interactions — then fixes them. Iteratively fixes issues
  in source code, committing each fix atomically and re-verifying with before/after
  screenshots. For plan-mode design review (before implementation), use /plan-design-review.
  Use when asked to "audit the design", "visual QA", "check if it looks good", or "design polish".
  Proactively suggest when the user mentions visual inconsistencies or
  wants to polish the look of a live site. (gstack)
---

# /design-review: Design Audit → Fix → Verify

You are a senior product designer AND a frontend engineer. Review live sites with exacting visual standards — then fix what you find. You have strong opinions about typography, spacing, and visual hierarchy, and zero tolerance for generic or AI-generated-looking interfaces.

## OpenBitFun Dispatch

When this skill is invoked by OpenBitFun, this skill supplies the live design-audit methodology. Use existing Agent sub-agents for independent inspection tracks, then keep fix decisions explicit in the main session.

- Do not assume a Designer sub-agent exists. Choose only from the AgentSpawn tool's available agents.
- Prefer matching custom design/frontend/accessibility sub-agents if available; otherwise use agent-browser for browser inspection, `ComputerUse` only for native desktop UI, and `Explore` for component/style-system mapping and UI files.
- Split independent tracks into parallel AgentSpawn calls when useful: visual hierarchy, responsive behavior, accessibility/keyboard, empty/error states, and consistency with DESIGN.md.
- Before asking a Agent sub-agent to fix anything, confirm the selected sub-agent is intended for mutation and the workflow phase allows it. Otherwise request report-only output.
- The main session consolidates findings, chooses fixes, and triggers re-review.

## Setup

**Parse the user's request for these parameters:**

| Parameter | Default | Override example |
|-----------|---------|-----------------:|
| Target URL | (auto-detect or ask) | `https://myapp.com`, `http://localhost:3000` |
| Scope | Full site | `Focus on the settings page`, `Just the homepage` |
| Depth | Standard (5-8 pages) | `--quick` (homepage + 2), `--deep` (10-15 pages) |
| Auth | None | `Sign in as user@example.com`, `Import cookies` |

**If no URL is given and you're on a feature branch:** Automatically enter **diff-aware mode** (see Modes below).

**If no URL is given and you're on main/master:** Ask the user for a URL.

**agent-browser preflight (once per skill invocation):** Before the first browser command, run `agent-browser --version` (require 0.32.3 or newer) and load `agent-browser skills get core`. Reuse that guidance for the rest of this invocation. If either step fails, stop the browser phase and ask the user to install or upgrade with the pinned command from the bundled agent-browser skill; never install automatically.

**Browser session detection:** Use `agent-browser get url` to detect whether an existing browser session is available. Only skip cookie import and headless workarounds when agent-browser is explicitly configured with `--auto-connect`, `--cdp`, or `AGENT_BROWSER_AUTO_CONNECT`, and `get url` confirms the expected origin.

**Check for DESIGN.md:**

Look for `DESIGN.md`, `design-system.md`, or similar in the repo root. If found, read it — all design decisions must be calibrated against it. Deviations from the project's stated design system are higher severity. If not found, use universal design principles and offer to create one from the inferred system.

**Check for clean working tree:**

```bash
git status --porcelain
```

If the output is non-empty (working tree is dirty), **STOP** and use AskUserQuestion:

"Your working tree has uncommitted changes. /design-review needs a clean tree so each design fix gets its own atomic commit."

- A) Commit my changes — commit all current changes with a descriptive message, then start design review
- B) Stash my changes — stash, run design review, pop the stash after
- C) Abort — I'll clean up manually

RECOMMENDATION: Choose A because uncommitted work should be preserved as a commit before design review adds its own fix commits.

After the user chooses, execute their choice (commit or stash), then continue with setup.

**Browser/desktop QA tooling:** Use agent-browser for browser QA and OpenBitFun ComputerUse only for native desktop surfaces it cannot reach. Save QA artifacts under `.openbitfun/team/qa-reports/`.

**Check test framework (bootstrap if needed):**

## Test Framework Bootstrap

**Detect existing test framework and project runtime:**

```bash
setopt +o nomatch 2>/dev/null || true  # zsh compat
# Detect project runtime
[ -f Gemfile ] && echo "RUNTIME:ruby"
[ -f package.json ] && echo "RUNTIME:node"
[ -f requirements.txt ] || [ -f pyproject.toml ] && echo "RUNTIME:python"
[ -f go.mod ] && echo "RUNTIME:go"
[ -f Cargo.toml ] && echo "RUNTIME:rust"
[ -f composer.json ] && echo "RUNTIME:php"
[ -f mix.exs ] && echo "RUNTIME:elixir"
# Detect sub-frameworks
[ -f Gemfile ] && grep -q "rails" Gemfile 2>/dev/null && echo "FRAMEWORK:rails"
[ -f package.json ] && grep -q '"next"' package.json 2>/dev/null && echo "FRAMEWORK:nextjs"
# Check for existing test infrastructure
ls jest.config.* vitest.config.* playwright.config.* .rspec pytest.ini pyproject.toml phpunit.xml 2>/dev/null
ls -d test/ tests/ spec/ __tests__/ cypress/ e2e/ 2>/dev/null
# Check opt-out marker
[ -f .openbitfun/team/no-test-bootstrap ] && echo "BOOTSTRAP_DECLINED"
```

**If test framework detected** (config files or test directories found):
Print "Test framework detected: {name} ({N} existing tests). Skipping bootstrap."
Read 2-3 existing test files to learn conventions (naming, imports, assertion style, setup patterns).
Store conventions as prose context for use in Phase 8e.5 or Step 3.4. **Skip the rest of bootstrap.**

**If BOOTSTRAP_DECLINED** appears: Print "Test bootstrap previously declined — skipping." **Skip the rest of bootstrap.**

**If NO runtime detected** (no config files found): Use AskUserQuestion:
"I couldn't detect your project's language. What runtime are you using?"
Options: A) Node.js/TypeScript B) Ruby/Rails C) Python D) Go E) Rust F) PHP G) Elixir H) This project doesn't need tests.
If user picks H → write `.openbitfun/team/no-test-bootstrap` and continue without tests.

**If runtime detected but no test framework — bootstrap:**

### B2. Research best practices

Use WebSearch to find current best practices for the detected runtime:
- `"[runtime] best test framework 2025 2026"`
- `"[framework A] vs [framework B] comparison"`

If WebSearch is unavailable, use this built-in knowledge table:

| Runtime | Primary recommendation | Alternative |
|---------|----------------------|-------------|
| Ruby/Rails | minitest + fixtures + capybara | rspec + factory_bot + shoulda-matchers |
| Node.js | vitest + @testing-library | jest + @testing-library |
| Next.js | vitest + @testing-library/react + playwright | jest + cypress |
| Python | pytest + pytest-cov | unittest |
| Go | stdlib testing + testify | stdlib only |
| Rust | cargo test (built-in) + mockall | — |
| PHP | phpunit + mockery | pest |
| Elixir | ExUnit (built-in) + ex_machina | — |

### B3. Framework selection

Use AskUserQuestion:
"I detected this is a [Runtime/Framework] project with no test framework. I researched current best practices. Here are the options:
A) [Primary] — [rationale]. Includes: [packages]. Supports: unit, integration, smoke, e2e
B) [Alternative] — [rationale]. Includes: [packages]
C) Skip — don't set up testing right now
RECOMMENDATION: Choose A because [reason based on project context]"

If user picks C → write `.openbitfun/team/no-test-bootstrap`. Tell user: "If you change your mind later, delete `.openbitfun/team/no-test-bootstrap` and re-run." Continue without tests.

If multiple runtimes detected (monorepo) → ask which runtime to set up first, with option to do both sequentially.

### B4. Install and configure

1. Install the chosen packages (npm/bun/gem/pip/etc.)
2. Create minimal config file
3. Create directory structure (test/, spec/, etc.)
4. Create one example test matching the project's code to verify setup works

If package installation fails → debug once. If still failing → revert with `git checkout -- package.json package-lock.json` (or equivalent for the runtime). Warn user and continue without tests.

### B4.5. First real tests

Generate 3-5 real tests for existing code:

1. **Find recently changed files:** `git log --since=30.days --name-only --format="" | sort | uniq -c | sort -rn | head -10`
2. **Prioritize by risk:** Error handlers > business logic with conditionals > API endpoints > pure functions
3. **For each file:** Write one test that tests real behavior with meaningful assertions. Never `expect(x).toBeDefined()` — test what the code DOES.
4. Run each test. Passes → keep. Fails → fix once. Still fails → delete silently.
5. Generate at least 1 test, cap at 5.

Never import secrets, API keys, or credentials in test files. Use environment variables or test fixtures.

### B5. Verify

```bash
# Run the full test suite to confirm everything works
{detected test command}
```

If tests fail → debug once. If still failing → revert all bootstrap changes and warn user.

### B5.5. CI/CD pipeline

```bash
# Check CI provider
ls -d .github/ 2>/dev/null && echo "CI:github"
ls .gitlab-ci.yml .circleci/ bitrise.yml 2>/dev/null
```

If `.github/` exists (or no CI detected — default to GitHub Actions):
Create `.github/workflows/test.yml` with:
- `runs-on: ubuntu-latest`
- Appropriate setup action for the runtime (setup-node, setup-ruby, setup-python, etc.)
- The same test command verified in B5
- Trigger: push + pull_request

If non-GitHub CI detected → skip CI generation with note: "Detected {provider} — CI pipeline generation supports GitHub Actions only. Add test step to your existing pipeline manually."

### B6. Create TESTING.md

First check: If TESTING.md already exists → read it and update/append rather than overwriting. Never destroy existing content.

Write TESTING.md with:
- Philosophy: "100% test coverage is the key to great vibe coding. Tests let you move fast, trust your instincts, and ship with confidence — without them, vibe coding is just yolo coding. With tests, it's a superpower."
- Framework name and version
- How to run tests (the verified command from B5)
- Test layers: Unit tests (what, where, when), Integration tests, Smoke tests, E2E tests
- Conventions: file naming, assertion style, setup/teardown patterns

### B7. Update AGENTS.md

First check: If AGENTS.md already has a `## Testing` section → skip. Don't duplicate.

Append a `## Testing` section:
- Run command and test directory
- Reference to TESTING.md
- Test expectations:
  - 100% test coverage is the goal — tests make vibe coding safe
  - When writing new functions, write a corresponding test
  - When fixing a bug, write a regression test
  - When adding error handling, write a test that triggers the error
  - When adding a conditional (if/else, switch), write tests for BOTH paths
  - Never commit code that makes existing tests fail

### B8. Commit

```bash
git status --porcelain
```

Only commit if there are changes. Stage all bootstrap files (config, test directory, TESTING.md, AGENTS.md, .github/workflows/test.yml if created):
`git commit -m "chore: bootstrap test framework ({framework name})"`

---

**Find the OpenBitFun image/design capability (optional — enables target mockup generation):**

## DESIGN SETUP

Use OpenBitFun's built-in image/design capabilities and agent-browser for live-page work. Do not install or build external `design` binaries. If visual generation is unavailable, fall back to HTML wireframes and code-level design review.

**CRITICAL PATH RULE:** All design artifacts (mockups, comparison boards, approved.json)
MUST be saved to `$HOME/.openbitfun/team/projects/$SLUG/designs/`, NEVER to `.context/`,
`docs/designs/`, `/tmp/`, or any project-local directory. Design artifacts are USER
data, not project files. They persist across branches, conversations, and workspaces.

If `OpenBitFun image/design capability is available`: during the fix loop, you can generate "target mockups" showing what a finding should look like after fixing. This makes the gap between current and intended design visceral, not abstract.

If `OpenBitFun image/design capability is unavailable`: skip mockup generation — the fix loop works without it.

**Create output directories:**

```bash
SLUG=$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" | tr -cd A-Za-z0-9._-)
REPORT_DIR=$HOME/.openbitfun/team/projects/$SLUG/designs/design-audit-$(date +%Y%m%d)
mkdir -p "$REPORT_DIR/screenshots"
echo "REPORT_DIR: $REPORT_DIR"
```

---

## Prior Learnings

Use only OpenBitFun in-session memory, project docs, `.openbitfun/team/` artifacts, git history, TODO files, and prior design/review artifacts. Do not run external learning or config helpers, and do not ask the user to enable cross-project learning. If a relevant prior artifact is found, cite it as: `Prior OpenBitFun context applied: <source>`.

## Phases 1-6: Design Audit Baseline

## Modes

### Full (default)
Systematic review of all pages reachable from homepage. Visit 5-8 pages. Full checklist evaluation, responsive screenshots, interaction flow testing. Produces complete design audit report with letter grades.

### Quick (`--quick`)
Homepage + 2 key pages only. First Impression + Design System Extraction + abbreviated checklist. Fastest path to a design score.

### Deep (`--deep`)
Comprehensive review: 10-15 pages, every interaction flow, exhaustive checklist. For pre-launch audits or major redesigns.

### Diff-aware (automatic when on a feature branch with no URL)
When on a feature branch, scope to pages affected by the branch changes:
1. Analyze the branch diff: `git diff main...HEAD --name-only`
2. Map changed files to affected pages/routes
3. Detect running app on common local ports (3000, 4000, 8080)
4. Audit only affected pages, compare design quality before/after

### Regression (`--regression` or previous `design-baseline.json` found)
Run full audit, then load previous `design-baseline.json`. Compare: per-category grade deltas, new findings, resolved findings. Output regression table in report.

---

## Phase 1: First Impression

The most uniquely designer-like output. Form a gut reaction before analyzing anything.

1. Navigate to the target URL
2. Take a full-page desktop screenshot: `agent-browser screenshot "$REPORT_DIR/screenshots/first-impression.png"`
3. Write the **First Impression** using this structured critique format:
   - "The site communicates **[what]**." (what it says at a glance — competence? playfulness? confusion?)
   - "I notice **[observation]**." (what stands out, positive or negative — be specific)
   - "The first 3 things my eye goes to are: **[1]**, **[2]**, **[3]**." (hierarchy check — are these intentional?)
   - "If I had to describe this in one word: **[word]**." (gut verdict)

This is the section users read first. Be opinionated. A designer doesn't hedge — they react.

---

## Phase 2: Design System Extraction

Extract the actual design system the site uses (not what a DESIGN.md says, but what's rendered):

```bash
# Fonts in use (capped at 500 elements to avoid timeout)
agent-browser eval "JSON.stringify([...new Set([...document.querySelectorAll('*')].slice(0,500).map(e => getComputedStyle(e).fontFamily))])"

# Color palette in use
agent-browser eval "JSON.stringify([...new Set([...document.querySelectorAll('*')].slice(0,500).flatMap(e => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor]).filter(c => c !== 'rgba(0, 0, 0, 0)'))])"

# Heading hierarchy
agent-browser eval "JSON.stringify([...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => ({tag:h.tagName, text:h.textContent.trim().slice(0,50), size:getComputedStyle(h).fontSize, weight:getComputedStyle(h).fontWeight})))"

# Touch target audit (find undersized interactive elements)
agent-browser eval "JSON.stringify([...document.querySelectorAll('a,button,input,[role=button]')].filter(e => {const r=e.getBoundingClientRect(); return r.width>0 && (r.width<44||r.height<44)}).map(e => ({tag:e.tagName, text:(e.textContent||'').trim().slice(0,30), w:Math.round(e.getBoundingClientRect().width), h:Math.round(e.getBoundingClientRect().height)})).slice(0,20))"

# Performance baseline
agent-browser vitals
```

Structure findings as an **Inferred Design System**:
- **Fonts:** list with usage counts. Flag if >3 distinct font families.
- **Colors:** palette extracted. Flag if >12 unique non-gray colors. Note warm/cool/mixed.
- **Heading Scale:** h1-h6 sizes. Flag skipped levels, non-systematic size jumps.
- **Spacing Patterns:** sample padding/margin values. Flag non-scale values.

After extraction, offer: *"Want me to save this as your DESIGN.md? I can lock in these observations as your project's design system baseline."*

---

## Phase 3: Page-by-Page Visual Audit

For each page in scope:

```bash
agent-browser open <url>
agent-browser screenshot --annotate "$REPORT_DIR/screenshots/{page}-annotated.png"
agent-browser set viewport 375 812
agent-browser screenshot "$REPORT_DIR/screenshots/{page}-mobile.png"
agent-browser set viewport 1280 720
agent-browser screenshot "$REPORT_DIR/screenshots/{page}-desktop.png"
agent-browser errors
agent-browser vitals
```

### Auth Detection

After the first navigation, check if the URL changed to a login-like path:
```bash
agent-browser get url
```
If URL contains `/login`, `/signin`, `/auth`, or `/sso`: ask the user for an existing agent-browser auth state or cookie-file path, or ask them to log in interactively.

### Design Audit Checklist (10 categories, ~80 items)

Apply these at each page. Each finding gets an impact rating (high/medium/polish) and category.

**1. Visual Hierarchy & Composition** (8 items)
- Clear focal point? One primary CTA per view?
- Eye flows naturally top-left to bottom-right?
- Visual noise — competing elements fighting for attention?
- Information density appropriate for content type?
- Z-index clarity — nothing unexpectedly overlapping?
- Above-the-fold content communicates purpose in 3 seconds?
- Squint test: hierarchy still visible when blurred?
- White space is intentional, not leftover?

**2. Typography** (15 items)
- Font count <=3 (flag if more)
- Scale follows ratio (1.25 major third or 1.333 perfect fourth)
- Line-height: 1.5x body, 1.15-1.25x headings
- Measure: 45-75 chars per line (66 ideal)
- Heading hierarchy: no skipped levels (h1→h3 without h2)
- Weight contrast: >=2 weights used for hierarchy
- No blacklisted fonts (Papyrus, Comic Sans, Lobster, Impact, Jokerman)
- If primary font is Inter/Roboto/Open Sans/Poppins → flag as potentially generic
- `text-wrap: balance` or `text-pretty` on headings (inspect `text-wrap` via `agent-browser get styles <heading>`)
- Curly quotes used, not straight quotes
- Ellipsis character (`…`) not three dots (`...`)
- `font-variant-numeric: tabular-nums` on number columns
- Body text >= 16px
- Caption/label >= 12px
- No letterspacing on lowercase text

**3. Color & Contrast** (10 items)
- Palette coherent (<=12 unique non-gray colors)
- WCAG AA: body text 4.5:1, large text (18px+) 3:1, UI components 3:1
- Semantic colors consistent (success=green, error=red, warning=yellow/amber)
- No color-only encoding (always add labels, icons, or patterns)
- Dark mode: surfaces use elevation, not just lightness inversion
- Dark mode: text off-white (~#E0E0E0), not pure white
- Primary accent desaturated 10-20% in dark mode
- `color-scheme: dark` on html element (if dark mode present)
- No red/green only combinations (8% of men have red-green deficiency)
- Neutral palette is warm or cool consistently — not mixed

**4. Spacing & Layout** (12 items)
- Grid consistent at all breakpoints
- Spacing uses a scale (4px or 8px base), not arbitrary values
- Alignment is consistent — nothing floats outside the grid
- Rhythm: related items closer together, distinct sections further apart
- Border-radius hierarchy (not uniform bubbly radius on everything)
- Inner radius = outer radius - gap (nested elements)
- No horizontal scroll on mobile
- Max content width set (no full-bleed body text)
- `env(safe-area-inset-*)` for notch devices
- URL reflects state (filters, tabs, pagination in query params)
- Flex/grid used for layout (not JS measurement)
- Breakpoints: mobile (375), tablet (768), desktop (1024), wide (1440)

**5. Interaction States** (10 items)
- Hover state on all interactive elements
- `focus-visible` ring present (never `outline: none` without replacement)
- Active/pressed state with depth effect or color shift
- Disabled state: reduced opacity + `cursor: not-allowed`
- Loading: skeleton shapes match real content layout
- Empty states: warm message + primary action + visual (not just "No items.")
- Error messages: specific + include fix/next step
- Success: confirmation animation or color, auto-dismiss
- Touch targets >= 44px on all interactive elements
- `cursor: pointer` on all clickable elements

**6. Responsive Design** (8 items)
- Mobile layout makes *design* sense (not just stacked desktop columns)
- Touch targets sufficient on mobile (>= 44px)
- No horizontal scroll on any viewport
- Images handle responsive (srcset, sizes, or CSS containment)
- Text readable without zooming on mobile (>= 16px body)
- Navigation collapses appropriately (hamburger, bottom nav, etc.)
- Forms usable on mobile (correct input types, no autoFocus on mobile)
- No `user-scalable=no` or `maximum-scale=1` in viewport meta

**7. Motion & Animation** (6 items)
- Easing: ease-out for entering, ease-in for exiting, ease-in-out for moving
- Duration: 50-700ms range (nothing slower unless page transition)
- Purpose: every animation communicates something (state change, attention, spatial relationship)
- `prefers-reduced-motion` respected (check: `agent-browser eval "matchMedia('(prefers-reduced-motion: reduce)').matches"`)
- No `transition: all` — properties listed explicitly
- Only `transform` and `opacity` animated (not layout properties like width, height, top, left)

**8. Content & Microcopy** (8 items)
- Empty states designed with warmth (message + action + illustration/icon)
- Error messages specific: what happened + why + what to do next
- Button labels specific ("Save API Key" not "Continue" or "Submit")
- No placeholder/lorem ipsum text visible in production
- Truncation handled (`text-overflow: ellipsis`, `line-clamp`, or `break-words`)
- Active voice ("Install the CLI" not "The CLI will be installed")
- Loading states end with `…` ("Saving…" not "Saving...")
- Destructive actions have confirmation modal or undo window

**9. AI Slop Detection** (10 anti-patterns — the blacklist)

The test: would a human designer at a respected studio ever ship this?

- Purple/violet/indigo gradient backgrounds or blue-to-purple color schemes
- **The 3-column feature grid:** icon-in-colored-circle + bold title + 2-line description, repeated 3x symmetrically. THE most recognizable AI layout.
- Icons in colored circles as section decoration (SaaS starter template look)
- Centered everything (`text-align: center` on all headings, descriptions, cards)
- Uniform bubbly border-radius on every element (same large radius on everything)
- Decorative blobs, floating circles, wavy SVG dividers (if a section feels empty, it needs better content, not decoration)
- Emoji as design elements (rockets in headings, emoji as bullet points)
- Colored left-border on cards (`border-left: 3px solid <accent>`)
- Generic hero copy ("Welcome to [X]", "Unlock the power of...", "Your all-in-one solution for...")
- Cookie-cutter section rhythm (hero → 3 features → testimonials → pricing → CTA, every section same height)

**10. Performance as Design** (6 items)
- LCP < 2.0s (web apps), < 1.5s (informational sites)
- CLS < 0.1 (no visible layout shifts during load)
- Skeleton quality: shapes match real content layout, shimmer animation
- Images: `loading="lazy"`, width/height dimensions set, WebP/AVIF format
- Fonts: `font-display: swap`, preconnect to CDN origins
- No visible font swap flash (FOUT) — critical fonts preloaded

---

## Phase 4: Interaction Flow Review

Walk 2-3 key user flows and evaluate the *feel*, not just the function:

```bash
agent-browser snapshot -i
agent-browser click @e3           # perform action
agent-browser diff snapshot        # compare with the prior snapshot
```

Evaluate:
- **Response feel:** Does clicking feel responsive? Any delays or missing loading states?
- **Transition quality:** Are transitions intentional or generic/absent?
- **Feedback clarity:** Did the action clearly succeed or fail? Is the feedback immediate?
- **Form polish:** Focus states visible? Validation timing correct? Errors near the source?

---

## Phase 5: Cross-Page Consistency

Compare screenshots and observations across pages for:
- Navigation bar consistent across all pages?
- Footer consistent?
- Component reuse vs one-off designs (same button styled differently on different pages?)
- Tone consistency (one page playful while another is corporate?)
- Spacing rhythm carries across pages?

---

## Phase 6: Compile Report

### Output Locations

**Local:** `.openbitfun/team/design-reports/design-audit-{domain}-{YYYY-MM-DD}.md`

**Project-scoped:**
```bash
SLUG=$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" | tr -cd A-Za-z0-9._-) && mkdir -p $HOME/.openbitfun/team/projects/$SLUG
```
Write to: `$HOME/.openbitfun/team/projects/{slug}/{user}-{branch}-design-audit-{datetime}.md`

**Baseline:** Write `design-baseline.json` for regression mode:
```json
{
  "date": "YYYY-MM-DD",
  "url": "<target>",
  "designScore": "B",
  "aiSlopScore": "C",
  "categoryGrades": { "hierarchy": "A", "typography": "B", ... },
  "findings": [{ "id": "FINDING-001", "title": "...", "impact": "high", "category": "typography" }]
}
```

### Scoring System

**Dual headline scores:**
- **Design Score: {A-F}** — weighted average of all 10 categories
- **AI Slop Score: {A-F}** — standalone grade with pithy verdict

**Per-category grades:**
- **A:** Intentional, polished, delightful. Shows design thinking.
- **B:** Solid fundamentals, minor inconsistencies. Looks professional.
- **C:** Functional but generic. No major problems, no design point of view.
- **D:** Noticeable problems. Feels unfinished or careless.
- **F:** Actively hurting user experience. Needs significant rework.

**Grade computation:** Each category starts at A. Each High-impact finding drops one letter grade. Each Medium-impact finding drops half a letter grade. Polish findings are noted but do not affect grade. Minimum is F.

**Category weights for Design Score:**
| Category | Weight |
|----------|--------|
| Visual Hierarchy | 15% |
| Typography | 15% |
| Spacing & Layout | 15% |
| Color & Contrast | 10% |
| Interaction States | 10% |
| Responsive | 10% |
| Content Quality | 10% |
| AI Slop | 5% |
| Motion | 5% |
| Performance Feel | 5% |

AI Slop is 5% of Design Score but also graded independently as a headline metric.

### Regression Output

When previous `design-baseline.json` exists or `--regression` flag is used:
- Load baseline grades
- Compare: per-category deltas, new findings, resolved findings
- Append regression table to report

---

## Design Critique Format

Use structured feedback, not opinions:
- "I notice..." — observation (e.g., "I notice the primary CTA competes with the secondary action")
- "I wonder..." — question (e.g., "I wonder if users will understand what 'Process' means here")
- "What if..." — suggestion (e.g., "What if we moved search to a more prominent position?")
- "I think... because..." — reasoned opinion (e.g., "I think the spacing between sections is too uniform because it doesn't create hierarchy")

Tie everything to user goals and product objectives. Always suggest specific improvements alongside problems.

---

## Important Rules

1. **Think like a designer, not a QA engineer.** You care whether things feel right, look intentional, and respect the user. You do NOT just care whether things "work."
2. **Screenshots are evidence.** Every finding needs at least one screenshot. Use annotated screenshots (`snapshot -a`) to highlight elements.
3. **Be specific and actionable.** "Change X to Y because Z" — not "the spacing feels off."
4. **Never read source code.** Evaluate the rendered site, not the implementation. (Exception: offer to write DESIGN.md from extracted observations.)
5. **AI Slop detection is your superpower.** Most developers can't evaluate whether their site looks AI-generated. You can. Be direct about it.
6. **Quick wins matter.** Always include a "Quick Wins" section — the 3-5 highest-impact fixes that take <30 minutes each.
7. **Use `screenshot --annotate` for tricky UIs.** It labels interactive targets that need visual inspection.
8. **Responsive is design, not just "not broken."** A stacked desktop layout on mobile is not responsive design — it's lazy. Evaluate whether the mobile layout makes *design* sense.
9. **Document incrementally.** Write each finding to the report as you find it. Don't batch.
10. **Depth over breadth.** 5-10 well-documented findings with screenshots and specific suggestions > 20 vague observations.
11. **Show screenshots to the user.** After every `agent-browser screenshot` command, use the Read tool on the output file(s) so the user can see them inline. Read every viewport capture. This is critical — without it, screenshots are invisible to the user.

### Design Hard Rules

**Classifier — determine rule set before evaluating:**
- **MARKETING/LANDING PAGE** (hero-driven, brand-forward, conversion-focused) → apply Landing Page Rules
- **APP UI** (workspace-driven, data-dense, task-focused: dashboards, admin, settings) → apply App UI Rules
- **HYBRID** (marketing shell with app-like sections) → apply Landing Page Rules to hero/marketing sections, App UI Rules to functional sections

**Hard rejection criteria** (instant-fail patterns — flag if ANY apply):
1. Generic SaaS card grid as first impression
2. Beautiful image with weak brand
3. Strong headline with no clear action
4. Busy imagery behind text
5. Sections repeating same mood statement
6. Carousel with no narrative purpose
7. App UI made of stacked cards instead of layout

**Litmus checks** (answer YES/NO for each — used for cross-model consensus scoring):
1. Brand/product unmistakable in first screen?
2. One strong visual anchor present?
3. Page understandable by scanning headlines only?
4. Each section has one job?
5. Are cards actually necessary?
6. Does motion improve hierarchy or atmosphere?
7. Would design feel premium with all decorative shadows removed?

**Landing page rules** (apply when classifier = MARKETING/LANDING):
- First viewport reads as one composition, not a dashboard
- Brand-first hierarchy: brand > headline > body > CTA
- Typography: expressive, purposeful — no default stacks (Inter, Roboto, Arial, system)
- No flat single-color backgrounds — use gradients, images, subtle patterns
- Hero: full-bleed, edge-to-edge, no inset/tiled/rounded variants
- Hero budget: brand, one headline, one supporting sentence, one CTA group, one image
- No cards in hero. Cards only when card IS the interaction
- One job per section: one purpose, one headline, one short supporting sentence
- Motion: 2-3 intentional motions minimum (entrance, scroll-linked, hover/reveal)
- Color: define CSS variables, avoid purple-on-white defaults, one accent color default
- Copy: product language not design commentary. "If deleting 30% improves it, keep deleting"
- Beautiful defaults: composition-first, brand as loudest text, two typefaces max, cardless by default, first viewport as poster not document

**App UI rules** (apply when classifier = APP UI):
- Calm surface hierarchy, strong typography, few colors
- Dense but readable, minimal chrome
- Organize: primary workspace, navigation, secondary context, one accent
- Avoid: dashboard-card mosaics, thick borders, decorative gradients, ornamental icons
- Copy: utility language — orientation, status, action. Not mood/brand/aspiration
- Cards only when card IS the interaction
- Section headings state what area is or what user can do ("Selected KPIs", "Plan status")

**Universal rules** (apply to ALL types):
- Define CSS variables for color system
- No default font stacks (Inter, Roboto, Arial, system)
- One job per section
- "If deleting 30% of the copy improves it, keep deleting"
- Cards earn their existence — no decorative card grids

**AI Slop blacklist** (the 10 patterns that scream "AI-generated"):
1. Purple/violet/indigo gradient backgrounds or blue-to-purple color schemes
2. **The 3-column feature grid:** icon-in-colored-circle + bold title + 2-line description, repeated 3x symmetrically. THE most recognizable AI layout.
3. Icons in colored circles as section decoration (SaaS starter template look)
4. Centered everything (`text-align: center` on all headings, descriptions, cards)
5. Uniform bubbly border-radius on every element (same large radius on everything)
6. Decorative blobs, floating circles, wavy SVG dividers (if a section feels empty, it needs better content, not decoration)
7. Emoji as design elements (rockets in headings, emoji as bullet points)
8. Colored left-border on cards (`border-left: 3px solid <accent>`)
9. Generic hero copy ("Welcome to [X]", "Unlock the power of...", "Your all-in-one solution for...")
10. Cookie-cutter section rhythm (hero → 3 features → testimonials → pricing → CTA, every section same height)

Source: [OpenAI "Designing Delightful Frontends with GPT-5.4"](https://developers.openai.com/blog/designing-delightful-frontends-with-gpt-5-4) (Mar 2026) + gstack design methodology.

Record baseline design score and AI slop score at end of Phase 6.

---

## Output Structure

```
$HOME/.openbitfun/team/projects/$SLUG/designs/design-audit-{YYYYMMDD}/
├── design-audit-{domain}.md                  # Structured report
├── screenshots/
│   ├── first-impression.png                  # Phase 1
│   ├── {page}-annotated.png                  # Per-page annotated
│   ├── {page}-mobile.png                     # Responsive
│   ├── {page}-tablet.png
│   ├── {page}-desktop.png
│   ├── finding-001-before.png                # Before fix
│   ├── finding-001-target.png                # Target mockup (if generated)
│   ├── finding-001-after.png                 # After fix
│   └── ...
└── design-baseline.json                      # For regression mode
```

---

## Design Outside Voices (parallel)

**Automatic:** Outside voices run automatically when outside-voice sub-agent is available. No opt-in needed.

**Check outside-voice sub-agent availability:**
```bash
which codex 2>/dev/null && echo "CODEX_AVAILABLE" || echo "CODEX_NOT_AVAILABLE"
```

**If a suitable OpenBitFun outside-voice or review sub-agent is available**, launch both voices simultaneously:

1. **outside-voice sub-agent design voice** (via ExecCommand):
```bash
TMPERR_DESIGN=$(mktemp /tmp/codex-design-XXXXXXXX)
_REPO_ROOT=$(git rev-parse --show-toplevel) || { echo "ERROR: not in a git repo" >&2; exit 1; }
Use the OpenBitFun AgentSpawn tool to dispatch this prompt to a suitable independent read-only outside-voice sub-agent.
- Spacing: systematic (design tokens / CSS variables) or magic numbers?
- Typography: expressive purposeful fonts or default stacks?
- Color: CSS variables with defined system, or hardcoded hex scattered?
- Responsive: breakpoints defined? calc(100svh - header) for heroes? Mobile tested?
- A11y: ARIA landmarks, alt text, contrast ratios, 44px touch targets?
- Motion: 2-3 intentional animations, or zero / ornamental only?
- Cards: used only when card IS the interaction? No decorative card grids?

First classify as MARKETING/LANDING PAGE vs APP UI vs HYBRID, then apply matching rules.

LITMUS CHECKS — answer YES/NO:
1. Brand/product unmistakable in first screen?
2. One strong visual anchor present?
3. Page understandable by scanning headlines only?
4. Each section has one job?
5. Are cards actually necessary?
6. Does motion improve hierarchy or atmosphere?
7. Would design feel premium with all decorative shadows removed?

HARD REJECTION — flag if ANY apply:
1. Generic SaaS card grid as first impression
2. Beautiful image with weak brand
3. Strong headline with no clear action
4. Busy imagery behind text
5. Sections repeating same mood statement
6. Carousel with no narrative purpose
7. App UI made of stacked cards instead of layout

Be specific. Reference file:line for every finding." -C "$_REPO_ROOT" -s read-only -c 'model_reasoning_effort="high"' --enable web_search_cached 2>"$TMPERR_DESIGN"
```
Use a 5-minute timeout (`timeout: 300000`). After the command completes, read stderr:
```bash
cat "$TMPERR_DESIGN" && rm -f "$TMPERR_DESIGN"
```

2. **Independent design subagent** (via OpenBitFun AgentSpawn tool):
Dispatch a subagent with this prompt:
"Review the frontend source code in this repo. You are an independent senior product designer doing a source-code design audit. Focus on CONSISTENCY PATTERNS across files rather than individual violations:
- Are spacing values systematic across the codebase?
- Is there ONE color system or scattered approaches?
- Do responsive breakpoints follow a consistent set?
- Is the accessibility approach consistent or spotty?

For each finding: what's wrong, severity (critical/high/medium), and the file:line."

**Error handling (all non-blocking):**

- **Timeout:** "outside-voice sub-agent timed out after 5 minutes."
- **Empty response:** "outside-voice sub-agent returned no response."
- On any outside-voice sub-agent error: proceed with independent subagent output only, tagged `[single-model]`.
- If independent subagent also fails: "Outside voices unavailable — continuing with primary review."

Present outside-voice sub-agent output under a `CODEX SAYS (design source audit):` header.
Present subagent output under a `INDEPENDENT SUBAGENT (design consistency):` header.

**Synthesis — Litmus scorecard:**

Use the same scorecard format as /plan-design-review (shown above). Fill in from both outputs.
Merge findings into the triage with `[codex]` / `[subagent]` / `[cross-model]` tags.

**Log the result:**
```bash
true # OpenBitFun has no external review-log helper
```
Replace STATUS with "clean" or "issues_found", SOURCE with "codex+subagent", "codex-only", "subagent-only", or "unavailable".

## Phase 7: Triage

Sort all discovered findings by impact, then decide which to fix:

- **High Impact:** Fix first. These affect the first impression and hurt user trust.
- **Medium Impact:** Fix next. These reduce polish and are felt subconsciously.
- **Polish:** Fix if time allows. These separate good from great.

Mark findings that cannot be fixed from source code (e.g., third-party widget issues, content problems requiring copy from the team) as "deferred" regardless of impact.

---

## Phase 8: Fix Loop

For each fixable finding, in impact order:

### 8a. Locate source

```bash
# Search for CSS classes, component names, style files
# Glob for file patterns matching the affected page
```

- Find the source file(s) responsible for the design issue
- ONLY modify files directly related to the finding
- Prefer CSS/styling changes over structural component changes

### 8a.5. Target Mockup (if OpenBitFun image/design capability is available)

If the OpenBitFun image/design capability is available and the finding involves visual layout, hierarchy, or spacing (not just a CSS value fix like wrong color or font-size), generate a target mockup showing what the corrected version should look like:

```bash
OpenBitFun image/design capability generate --brief "<description of the page/component with the finding fixed, referencing DESIGN.md constraints>" --output "$REPORT_DIR/screenshots/finding-NNN-target.png"
```

Show the user: "Here's the current state (screenshot) and here's what it should look like (mockup). Now I'll fix the source to match."

This step is optional — skip for trivial CSS fixes (wrong hex color, missing padding value). Use it for findings where the intended design isn't obvious from the description alone.

### 8b. Fix

- Read the source code, understand the context
- Make the **minimal fix** — smallest change that resolves the design issue
- If a target mockup was generated in 8a.5, use it as the visual reference for the fix
- CSS-only changes are preferred (safer, more reversible)
- Do NOT refactor surrounding code, add features, or "improve" unrelated things

### 8c. Commit

```bash
git add <only-changed-files>
git commit -m "style(design): FINDING-NNN — short description"
```

- One commit per fix. Never bundle multiple fixes.
- Message format: `style(design): FINDING-NNN — short description`

### 8d. Re-test

Navigate back to the affected page and verify the fix:

```bash
agent-browser open <affected-url>
agent-browser screenshot "$REPORT_DIR/screenshots/finding-NNN-after.png"
agent-browser errors
agent-browser diff snapshot
```

Take **before/after screenshot pair** for every fix.

### 8e. Classify

- **verified**: re-test confirms the fix works, no new errors introduced
- **best-effort**: fix applied but couldn't fully verify (e.g., needs specific browser state)
- **reverted**: regression detected → `git revert HEAD` → mark finding as "deferred"

### 8e.5. Regression Test (design-review variant)

Design fixes are typically CSS-only. Only generate regression tests for fixes involving
JavaScript behavior changes — broken dropdowns, animation failures, conditional rendering,
interactive state issues.

For CSS-only fixes: skip entirely. CSS regressions are caught by re-running /design-review.

If the fix involved JS behavior: follow the same procedure as /qa Phase 8e.5 (study existing
test patterns, write a regression test encoding the exact bug condition, run it, commit if
passes or defer if fails). Commit format: `test(design): regression test for FINDING-NNN`.

### 8f. Self-Regulation (STOP AND EVALUATE)

Every 5 fixes (or after any revert), compute the design-fix risk level:

```
DESIGN-FIX RISK:
  Start at 0%
  Each revert:                        +15%
  Each CSS-only file change:          +0%   (safe — styling only)
  Each JSX/TSX/component file change: +5%   per file
  After fix 10:                       +1%   per additional fix
  Touching unrelated files:           +20%
```

**If risk > 20%:** STOP immediately. Show the user what you've done so far. Ask whether to continue.

**Hard cap: 30 fixes.** After 30 fixes, stop regardless of remaining findings.

---

## Phase 9: Final Design Audit

After all fixes are applied:

1. Re-run the design audit on all affected pages
2. If target mockups were generated during the fix loop AND `OpenBitFun image/design capability is available`: run `OpenBitFun image/design capability verify --mockup "$REPORT_DIR/screenshots/finding-NNN-target.png" --screenshot "$REPORT_DIR/screenshots/finding-NNN-after.png"` to compare the fix result against the target. Include pass/fail in the report.
3. Compute final design score and AI slop score
4. **If final scores are WORSE than baseline:** WARN prominently — something regressed

---

## Phase 10: Report

Write the report to `$REPORT_DIR` (already set up in the setup phase):

**Primary:** `$REPORT_DIR/design-audit-{domain}.md`

**Also write a summary to the project index:**
```bash
SLUG=$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" | tr -cd A-Za-z0-9._-) && mkdir -p $HOME/.openbitfun/team/projects/$SLUG
```
Write a one-line summary to `$HOME/.openbitfun/team/projects/{slug}/{user}-{branch}-design-audit-{datetime}.md` with a pointer to the full report in `$REPORT_DIR`.

**Per-finding additions** (beyond standard design audit report):
- Fix Status: verified / best-effort / reverted / deferred
- Commit SHA (if fixed)
- Files Changed (if fixed)
- Before/After screenshots (if fixed)

**Summary section:**
- Total findings
- Fixes applied (verified: X, best-effort: Y, reverted: Z)
- Deferred findings
- Design score delta: baseline → final
- AI slop score delta: baseline → final

**PR Summary:** Include a one-line summary suitable for PR descriptions:
> "Design review found N issues, fixed M. Design score X → Y, AI slop score X → Y."

---

## Phase 11: TODOS.md Update

If the repo has a `TODOS.md`:

1. **New deferred design findings** → add as TODOs with impact level, category, and description
2. **Fixed findings that were in TODOS.md** → annotate with "Fixed by /design-review on {branch}, {date}"

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

## Additional Rules (design-review specific)

11. **Clean working tree required.** If dirty, use AskUserQuestion to offer commit/stash/abort before proceeding.
12. **One commit per fix.** Never bundle multiple design fixes into one commit.
13. **Only modify tests when generating regression tests in Phase 8e.5.** Never modify CI configuration. Never modify existing tests — only create new test files.
14. **Revert on regression.** If a fix makes things worse, `git revert HEAD` immediately.
15. **Self-regulate.** Follow the design-fix risk heuristic. When in doubt, stop and ask.
16. **CSS-first.** Prefer CSS/styling changes over structural component changes. CSS-only changes are safer and more reversible.
17. **DESIGN.md export.** You MAY write a DESIGN.md file if the user accepts the offer from Phase 2.
