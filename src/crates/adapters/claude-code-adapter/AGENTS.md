# Claude Code Adapter Instructions

- This crate may read and normalize Claude Code user Instructions, Command, Subagent, MCP, and Hook configuration but must never invoke Hook handlers, start Claude Code, connect MCP servers, or own product policy.
- Keep handler bodies, commands, prompts, URLs, arguments, environment values, and credentials inside the adapter. Public contracts expose only bounded summaries.
- Preserve native Claude Code event and handler names. Map only reviewed OpenBitFun Hook points; report every other event as native-only.
- Preserve native precedence independently for each capability. Unsupported behavior fields must block or degrade explicitly; never flatten them into a global cross-ecosystem priority.
- Command discovery may inspect only bounded Skill names to honor Claude's Skill-over-command collision. It must not parse Skill bodies or become a second Skill owner.
- Do not depend on another ecosystem adapter. Shared product behavior belongs in contracts or assembly.

`session` reads bounded Claude Code transcript metadata and the selected parent
chain without executing Claude Code, hooks or imported tools. Full-history reads
follow compaction's logical parent while omitting the duplicate summary prompt.
Keep discovery, native persistence and continuation in their existing owners.

Verification: `cargo test -p openbitfun-claude-code-adapter --lib session::tests`

Optional installed-source check (counts only):
`cargo test -p openbitfun-claude-code-adapter --lib inspect_installed_claude_code -- --ignored --nocapture`.
`OPENBITFUN_TEST_CLAUDE_HOME` selects an isolated source home; otherwise use the
normal `CLAUDE_CONFIG_DIR` / `~/.claude` discovery path.
