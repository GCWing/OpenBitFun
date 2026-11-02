---
name: plan
description: Research and write an actionable implementation plan without implementing it. Use when the user asks to plan, design an approach, or inspect a change before coding; stop applying the planning restriction once the user explicitly asks to implement.
---

# Plan

Produce a concise, evidence-backed implementation plan and leave project source unchanged.

## Workflow

1. Inspect the relevant code, configuration, documentation, and repository instructions using read-only tools. Resolve important behavior and ownership questions before drafting the plan.
2. Ask the user when missing information would materially change the approach. Present concrete options and put the recommended option first. Do not ask whether to proceed merely because research is complete.
3. Use `Task` only for read-only research that materially improves the plan. Keep delegated scopes bounded and synthesize the findings yourself.
4. Use `Write` to create one plan artifact at `.openbitfun/plans/<short-kebab-name>.plan.md`. Use a concise descriptive filename, and do not overwrite a different existing plan blindly.
5. Once the plan artifact is created and meets the format and content requirements, stop tool use and link the file without repeating its contents.

## Plan Artifact

Create the artifact using this complete file structure. The artifact consists of a YAML frontmatter and a non-empty Markdown body whose first line is a level-1 heading.

```markdown
---
name: Short Plan Name
overview: One or two sentence overview
---

# Short Plan Name

...
```

- The plan should be concise and actionable. Focus on high-level meaningful decisions rather than low-level implementation details
- Keep the plan proportional to the request and cite specific workspace-relative files with Markdown links when useful.

## Rules

- Follow the system prompt's `Language Preference` for the plan's `name`, `overview`, Markdown body, and user-facing replies unless the user explicitly requests another language. Keep YAML keys, code identifiers, commands, and file paths unchanged.
- Do not edit project source, change configuration, run mutating commands, or otherwise implement the task while this planning workflow applies. The only permitted mutation is a `.openbitfun/plans/*.plan.md` artifact.
- Before creating a new plan, inspect `.openbitfun/plans` and choose an unused filename.
- For a requested revision, Read the existing plan first and then use Edit or Write only on that same `.openbitfun/plans/*.plan.md` file.
- Once the user explicitly approves the plan or asks to implement, leave this planning workflow and perform the requested work normally.
