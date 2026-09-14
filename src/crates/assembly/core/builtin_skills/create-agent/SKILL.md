---
name: create-agent
description: Create or update OpenBitFun custom modes and subagents. Turn the user's needs into a role prompt and a suitable tool selection, then save an agent definition. Use for reusable roles, not ordinary delegation to an existing subagent.
---

# Create an OpenBitFun Agent

## Understand the role

Determine what work the agent should do, what it should deliver, and whether it may change files. Infer these from the request and ask only about missing choices that would materially change the role.

- Use a **mode** for a main conversation role the user selects directly. Modes are user-wide.
- Use a **subagent** for a specialist that receives work from a parent agent. Choose project scope for project-specific roles and user scope for roles reused across projects.

## Choose tools and write the prompt

Read [the tool catalog](references/tool-catalog.md). Select the tools needed for the requested tasks and write their names into `tools`.

Adapt [the mode example](assets/mode.md) or [the subagent example](assets/subagent.md).

Write a description that makes the role easy to select. In the prompt, explain its responsibilities, useful domain-specific methods, and expected output. For a mode, describe how it collaborates with the user and incorporates feedback. For a subagent, define the delegated input, completion criteria, and what to return to the parent.

Avoid emoji in the prompt, including headings and examples, unless the user explicitly requests them.

Keep the prompt consistent with the tools. An implementation role needs write tools and `readonly: false`; a read-only investigator should not be instructed to edit files.

## Agent file format and save locations

Save one UTF-8 `<id>.md` file directly in the agents directory. Start with YAML frontmatter between `---` lines, followed by the role prompt. The bundled examples show the format.

### Save location

| Scope | Directory | Supported roles |
| --- | --- | --- |
| Project | `<workspace>/.openbitfun/agents/` | Subagent |
| User on Windows | `%APPDATA%/openbitfun/agents/` | Mode or subagent |
| User on macOS | `~/Library/Application Support/openbitfun/agents/` | Mode or subagent |
| User on Linux | `$XDG_CONFIG_HOME/openbitfun/agents/`, or `~/.config/openbitfun/agents/` | Mode or subagent |

If `OPENBITFUN_USER_ROOT` is configured, use its `agents/` subdirectory for user roles. Use the environment where the role will be used. If the user has a custom data location, use that location. A mode cannot be installed at project scope.

### Fields

| Field | What to write |
| --- | --- |
| `schema_version` | `1`. |
| `kind` | `mode` or `subagent`. Always specify it. |
| `id` | A unique name starting with a letter and containing only letters, digits, `-`, or `_`. Prefer lowercase kebab-case and retain it when updating the role. Avoid IDs that differ only by letter case. |
| `name` | A nonempty display name, in the user's language if appropriate. |
| `description` | A short explanation of when to use this role. |
| `tools` | A YAML list of exact names from [the tool catalog](references/tool-catalog.md). |
| `readonly` | `true` for inspection-only work; `false` when the role needs to make changes. Modes default to `false`, subagents to `true`. |
| `model` | Set only for a subagent when the user requests it. Use `primary`/`fast` for the configured primary/fast model, or `inherit` to use the parent session's model. For a specific model, call `ListModels` and use the returned `model_id`, not `model_name`. Omit for modes. |

Write the role prompt in the Markdown body, not in a YAML `prompt` field. Use individual tool names rather than tool-group labels. Skill selections and other application settings are not fields in this file.

### Tool defaults

Prefer an explicit tool list tailored to the role. If `tools` is omitted, these defaults apply:

- Mode: `Read`, `Glob`, `Grep`, `Write`, `Edit`, `Delete`, `ExecCommand`, `WriteStdin`, `ExecControl`, `Task`, `ListModels`, `Skill`, `WebSearch`, `WebFetch`, `get_goal`, `create_goal`, `update_goal`.
- Subagent: `LS`, `Read`, `Glob`, `Grep`.

An explicit `tools: []` gives the role no tools. Setting `readonly: false` alone does not add write tools.

## Save and deliver

Choose a distinct ID and check for an existing file before writing. When updating a role, preserve its ID and unrelated settings. Save the Markdown file in the requested scope; if the user only asked for a proposal, provide the proposed definition.

For a remote environment, save to the intended machine or workspace. If that location cannot be accessed, deliver the file and explain where to place it.

Validate the saved file using the bundled script (paths below are relative to this skill directory):

```bash
python scripts/validate_agent.py /path/to/agent.md --scope user
```

Use `--scope project` for project subagents. The script requires PyYAML; if missing, install it with `python -m pip install PyYAML` in the Python environment used for validation. Fix reported errors and rerun until validation passes.

Check consistency with the requested role. Tell the user what changed, the affected file path, and the resulting capabilities. Mode additions, edits, and removals are reflected when reopening the mode picker; subagent changes are reflected on the next conversation turn. Report only activation or invocation checks actually performed.
