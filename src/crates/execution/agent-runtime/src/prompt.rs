//! Prompt-loop owner facts and reminder ordering.

use openbitfun_core_types::{SessionExecutionTarget, SessionExecutionTargetKind};
use serde::{Deserialize, Serialize};

const SKILL_LISTING_TITLE: &str = "# Skill Listing";
const SKILL_LISTING_GUIDANCE: &str = r#"A skill is a set of instructions provided through a `SKILL.md` source.
If the user names a skill (with `[$SkillName]` or plain text) OR the task clearly matches a skill's description shown below, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.
Below is the list of skills that can be used with the Skill tool. Each entry includes a name and description"#;
const AGENT_LISTING_TITLE: &str = "# Agent Listing";
const AGENT_LISTING_GUIDANCE: &str = "Available agent types for the AgentSpawn tool:";
const TOOL_CALLING_GUIDANCE_TITLE: &str = "# Tool Calling Guide";
const TOOL_CALLING_GUIDANCE: &str = "You can access two types of tools.";
const DIRECT_TOOL_LISTING_TITLE: &str = "## Direct tools";
const DIRECT_TOOL_LISTING_GUIDANCE: &str = r#"Their definitions are already available. You can call them directly.
Each entry below is a directly callable tool name."#;
const DEFERRED_TOOL_LISTING_TITLE: &str = "## Deferred tools";
const DEFERRED_TOOL_LISTING_GUIDANCE: &str = r#"Their definitions are not loaded at the start of the conversation.
Use GetToolSpec to read a deferred tool's full definition before invoking it through CallDeferredTool. Reuse it while the successful GetToolSpec result remains in the current context. If compaction or truncation removed that result, load it again; a summary or a past call does not keep the definition loaded.
Each entry below is a deferred tool name with an optional short description."#;

pub fn render_direct_tool_listing_body<'a>(
    tool_names: impl IntoIterator<Item = &'a str>,
) -> String {
    format!(
        "<direct_tools>\n{}\n</direct_tools>",
        tool_names
            .into_iter()
            .map(|tool_name| format!("- {tool_name}"))
            .collect::<Vec<_>>()
            .join("\n")
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromptEnvironmentFacts<'a> {
    pub host_os: &'a str,
    pub host_family: &'a str,
    pub host_arch: &'a str,
    pub remote_execution_active: bool,
}

pub fn render_prompt_environment_info(facts: PromptEnvironmentFacts<'_>) -> String {
    let computer_use_keys = computer_use_key_chord_guidance(facts.host_os);

    if facts.remote_execution_active {
        format!(
            r#"# Environment Information
<environment_details>
- Local OpenBitFun client OS: {} ({}) — applies to Computer use / UI automation on this machine only.
- Local client architecture: {}
- {}
</environment_details>

"#,
            facts.host_os, facts.host_family, facts.host_arch, computer_use_keys
        )
    } else {
        format!(
            r#"# Environment Information
<environment_details>
- Operating System: {} ({})
- Architecture: {}
- {}
</environment_details>

"#,
            facts.host_os, facts.host_family, facts.host_arch, computer_use_keys
        )
    }
}

/// SSH remote host facts for prompt rendering. Runtime services still own
/// concrete remote probing and IO.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteExecutionHints {
    pub connection_display_name: String,
    pub kernel_name: String,
    pub hostname: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RuntimeContextNeeds {
    pub workspace_tools: bool,
    pub exec_command: bool,
    pub exec_control: bool,
    pub computer_use: bool,
    /// `ControlHub` is available. Distinct from `computer_use` because in remote
    /// workspaces `ControlHub` stays available (browser/terminal on the local
    /// client) while `ComputerUse` is disabled, and the agent should NOT receive
    /// the prominent "Local OpenBitFun client OS" block that belongs to desktop
    /// automation.
    pub control_hub: bool,
}

impl RuntimeContextNeeds {
    pub fn from_tool_names<T, I>(tool_names: I) -> Self
    where
        T: AsRef<str>,
        I: IntoIterator<Item = T>,
    {
        let mut needs = Self::default();
        for tool_name in tool_names {
            let tool_name = tool_name.as_ref();
            match tool_name {
                "Read" | "Write" | "Edit" | "Delete" | "LS" | "Grep" | "Glob" | "ExecCommand"
                | "WriteStdin" | "ExecControl" => {
                    needs.workspace_tools = true;
                    if tool_name == "ExecCommand" {
                        needs.exec_command = true;
                    }
                    if tool_name == "ExecControl" {
                        needs.exec_control = true;
                    }
                }
                "ComputerUse" => {
                    needs.computer_use = true;
                }
                "ControlHub" => {
                    needs.control_hub = true;
                }
                _ => {}
            }
        }
        needs
    }

    pub fn is_empty(self) -> bool {
        !self.workspace_tools
            && !self.exec_command
            && !self.exec_control
            && !self.computer_use
            && !self.control_hub
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeShellFacts {
    pub display_name: String,
    pub shell_type: String,
    pub invocation: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeContextFacts {
    pub needs: RuntimeContextNeeds,
    pub host_os: String,
    pub host_family: String,
    pub host_arch: String,
    pub remote_execution: Option<RemoteExecutionHints>,
    pub local_shell: Option<RuntimeShellFacts>,
    pub supports_image_understanding: Option<bool>,
}

pub fn render_runtime_context_reminder(facts: &RuntimeContextFacts) -> Option<String> {
    if facts.needs.is_empty() {
        return None;
    }

    let mut lines = vec!["# Runtime Context".to_string()];

    if facts.needs.workspace_tools {
        let mut workspace_lines = Vec::new();
        if let Some(remote) = &facts.remote_execution {
            workspace_lines.push(format!(
                "- Workspace file and shell tools operate on remote SSH connection \"{}\".",
                remote.connection_display_name.replace('"', "'")
            ));
            workspace_lines.push(format!(
                "- Remote host: {} (uname/kernel: {})",
                remote.hostname.replace('"', "'"),
                remote.kernel_name.replace('"', "'")
            ));
            workspace_lines.push("- Path conventions for workspace operations: POSIX paths with forward slashes and Unix shell syntax. Do not use PowerShell, `cmd.exe`, or Windows-style paths for remote workspace operations.".to_string());
            workspace_lines.push("- This session operates on the remote SSH host only. Local filesystem, local terminal, and local OS operations are not accessible. For tasks requiring local execution (e.g. editing the local Mac's ~/.ssh/config), provide the user with commands to run on their local machine.".to_string());
        } else {
            workspace_lines.push(
                "- Workspace file and shell tools operate on the local filesystem.".to_string(),
            );
        }
        push_runtime_context_section(&mut lines, "Workspace Execution", workspace_lines);
    }

    if facts.needs.exec_command {
        let mut exec_command_lines = Vec::new();
        if facts.remote_execution.is_some() {
            exec_command_lines.push(
                "- ExecCommand uses the remote user's default POSIX shell, invoked as `<shell> -lc <cmd>`."
                    .to_string(),
            );
        } else if let Some(shell) = &facts.local_shell {
            push_local_exec_shell_runtime_context(
                &mut exec_command_lines,
                &shell.display_name,
                &shell.shell_type,
                &shell.invocation,
            );
        }
        push_runtime_context_section(&mut lines, "ExecCommand Shell", exec_command_lines);
    }

    let exec_control_lines = exec_control_runtime_guidance(
        &facts.host_os,
        facts.remote_execution.is_some(),
        facts.needs.exec_control,
    );
    push_runtime_context_section(&mut lines, "ExecControl", exec_control_lines);

    if facts.needs.computer_use {
        let mut local_client_lines = Vec::new();
        if facts.remote_execution.is_some() && facts.needs.workspace_tools {
            local_client_lines.push(
                "- Computer use and UI automation operate on the local OpenBitFun desktop, even when workspace file and shell tools target a remote host."
                    .to_string(),
            );
        }
        local_client_lines.push(format!(
            "- Local OpenBitFun client OS: {} ({})",
            facts.host_os, facts.host_family
        ));
        local_client_lines.push(format!("- Local client architecture: {}", facts.host_arch));
        local_client_lines
            .push(runtime_computer_use_key_chord_guidance(&facts.host_os).to_string());
        push_runtime_context_section(&mut lines, "Local Client", local_client_lines);
    }

    // Text-only model guidance applies to both ComputerUse (desktop) and
    // ControlHub (browser). In remote workspaces only `control_hub` is true
    // (ComputerUse is disabled), so we emit a browser-scoped variant that does
    // not reference desktop automation actions unavailable in remote mode.
    if facts.supports_image_understanding == Some(false) {
        if facts.needs.computer_use {
            push_runtime_context_section(
                &mut lines,
                "Computer Use Input Strategy",
                computer_use_text_only_model_guidance(),
            );
        } else if facts.needs.control_hub {
            push_runtime_context_section(
                &mut lines,
                "Browser Input Strategy",
                control_hub_browser_text_only_guidance(),
            );
        }
    }

    Some(lines.join("\n"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptRelatedPath {
    pub path: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceContextFacts {
    pub workspace_path: String,
    pub related_paths: Vec<PromptRelatedPath>,
    pub remote_execution: Option<RemoteExecutionHints>,
    pub worktree: Option<WorktreeContextFacts>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeContextFacts {
    pub project_workspace_path: String,
    pub execution_target: SessionExecutionTarget,
}

fn render_worktree_context(facts: Option<&WorktreeContextFacts>) -> String {
    let Some(facts) = facts else {
        return String::new();
    };
    let target = &facts.execution_target;
    let target_label = match target.kind {
        SessionExecutionTargetKind::Local => return String::new(),
        SessionExecutionTargetKind::ManagedWorktree => {
            "Managed Git worktree created for this session"
        }
        SessionExecutionTargetKind::ExistingWorktree => {
            "Existing Git worktree registered for this session"
        }
    };
    let mut lines = vec![
        format!("- Execution target: {}", target_label),
        format!(
            "- Owning project root (session history and worktree management only): {}",
            facts.project_workspace_path.replace('\\', "/")
        ),
    ];
    if let Some(worktree_id) = target.worktree_id.as_deref() {
        lines.push(format!("- Worktree ID: {}", worktree_id));
    }
    if let Some(branch) = target.branch.as_deref() {
        lines.push(format!("- Worktree branch: {}", branch));
    } else {
        lines.push("- Worktree checkout: detached HEAD".to_string());
    }
    if let Some(base_ref) = target.base_ref.as_deref() {
        lines.push(format!("- Worktree base ref: {}", base_ref));
    }
    if let Some(base_commit) = target.base_commit.as_deref() {
        lines.push(format!("- Worktree base commit: {}", base_commit));
    }
    lines.push(
        "- Keep file, shell, and Git operations inside the workspace root above unless the user explicitly requests otherwise."
            .to_string(),
    );
    lines.join("\n")
}

pub fn render_workspace_context(facts: &WorkspaceContextFacts) -> String {
    let related_paths_section = if facts.related_paths.is_empty() {
        String::new()
    } else {
        let items = facts
            .related_paths
            .iter()
            .map(|related_path| {
                let path = related_path.path.replace('\\', "/");
                match related_path.description.as_deref().map(str::trim) {
                    Some(description) if !description.is_empty() => {
                        format!("  - {} — {}", path, description)
                    }
                    _ => format!("  - {}", path),
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "- Related directories (user-specified directories related to this workspace):\n{}",
            items
        )
    };
    let worktree_section = render_worktree_context(facts.worktree.as_ref());

    if let Some(remote) = &facts.remote_execution {
        format!(
            r#"## Workspace Context
<workspace_context>
- Workspace root (file tools, Glob, LS, ExecCommand on workspace): {}
{}{}
- Execution environment: **Remote SSH** — connection "{}".
- Remote host: {} (uname/kernel: {})
</workspace_context>
"#,
            facts.workspace_path,
            if related_paths_section.is_empty() {
                String::new()
            } else {
                format!("{}\n", related_paths_section)
            },
            if worktree_section.is_empty() {
                String::new()
            } else {
                format!("{}\n", worktree_section)
            },
            remote.connection_display_name.replace('"', "'"),
            remote.hostname.replace('"', "'"),
            remote.kernel_name.replace('"', "'"),
        )
    } else {
        format!(
            r#"## Workspace Context
<workspace_context>
- Current Working Directory: {}
{}{}
</workspace_context>
"#,
            facts.workspace_path,
            if related_paths_section.is_empty() {
                String::new()
            } else {
                format!("\n{}", related_paths_section)
            },
            if worktree_section.is_empty() {
                String::new()
            } else {
                format!("\n{}", worktree_section)
            }
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectLayoutFacts {
    pub listing: String,
    pub reached_limit: bool,
    pub max_entries: usize,
    pub remote: bool,
}

pub fn render_project_layout(facts: &ProjectLayoutFacts) -> String {
    let mut project_layout = "## Workspace Layout\n<project_layout>\n".to_string();
    if facts.remote {
        project_layout.push_str(
            "Below is a snapshot of the current workspace's file structure on the **remote** host.\n\n",
        );
    } else if facts.reached_limit {
        project_layout.push_str(&format!(
            "Below is a snapshot of the current workspace's file structure (showing up to {} entries).\n\n",
            facts.max_entries
        ));
    } else {
        project_layout
            .push_str("Below is a snapshot of the current workspace's file structure.\n\n");
    }
    project_layout.push_str(&facts.listing);
    project_layout.push_str("\n</project_layout>\n\n");
    project_layout
}

pub fn render_user_context_reminder(sections: impl IntoIterator<Item = String>) -> Option<String> {
    let sections = sections
        .into_iter()
        .map(|section| section.trim().to_string())
        .filter(|section| !section.is_empty())
        .collect::<Vec<_>>();

    if sections.is_empty() {
        None
    } else {
        Some(format!(
            "# User Context\n{}\n\n{}",
            USER_CONTEXT_PROMPT,
            sections.join("\n\n")
        ))
    }
}

const USER_CONTEXT_PROMPT: &str =
    "As you answer the user's questions, you can use the following context.\nNote: this is a snapshot captured at the start of the conversation and may not reflect real-time changes made afterward.";

fn local_exec_shell_runtime_guidance(shell_type: &str) -> &'static [&'static str] {
    match shell_type {
        "powershell" | "pwsh" => &[
            "- For inline Python or other embedded scripts, prefer PowerShell-friendly forms such as `@'\\nprint(\"Hello\")\\n'@ | python -` instead of heavily nested quoting.",
            "- In PowerShell, the escape character is the backtick (`), not backslash. `\\\"` is not a reliable way to escape a double quote for the shell.",
            "- For environment variables, process filtering, and file traversal, prefer native PowerShell cmdlets and syntax over shell-specific Unix patterns.",
            "- Avoid mixing PowerShell with `cmd.exe` or bash in the same command unless cross-shell behavior is explicitly required.",
        ],
        _ => &[],
    }
}

fn push_local_exec_shell_runtime_context(
    lines: &mut Vec<String>,
    shell_display_name: &str,
    shell_type: &str,
    shell_invocation: &str,
) {
    lines.push(format!(
        "- ExecCommand shell: {shell_display_name} ({shell_type}), invoked as {shell_invocation}."
    ));
    lines.extend(
        local_exec_shell_runtime_guidance(shell_type)
            .iter()
            .map(|line| (*line).to_string()),
    );
}

fn push_runtime_context_section(lines: &mut Vec<String>, title: &str, section_lines: Vec<String>) {
    if section_lines.is_empty() {
        return;
    }

    if !lines.is_empty() {
        lines.push(String::new());
    }
    lines.push(format!("## {title}"));
    lines.extend(section_lines);
}

fn exec_control_runtime_guidance(
    host_os: &str,
    remote_execution: bool,
    exec_control_available: bool,
) -> Vec<String> {
    if !exec_control_available || remote_execution || host_os != "windows" {
        return Vec::new();
    }

    vec![
        "- On local Windows ExecCommand sessions, `ExecControl` `interrupt` is effectively the same as `kill` for non-TTY processes.".to_string(),
    ]
}

fn computer_use_text_only_model_guidance() -> Vec<String> {
    vec![
        "- The configured primary model does not accept image inputs.".to_string(),
        "- For desktop work, do not use `screenshot` or infer coordinates from unseen images. Use `get_app_state` for the selected or bound app, or `describe_screen` for its AX/OCR text. Set `include_image: false` on `get_app_state` and app input calls when AX text is sufficient. Use `list_apps` only when the target is unknown; begin each new user GUI task with `start_control` once, normally in background mode.".to_string(),
        "- Use `app_batch` for already-decided app-scoped inputs to observed `node_idx` or `ocr_text` targets. `app_type_text` with `focus` combines focusing and exact Unicode input, including CJK and emoji. Batch a known search query and its submit key, or several observed form fields; end the batch when new information is needed.".to_string(),
        "- Reuse the returned final observation; do not add a second read or routine delay. Verify the intended result from content, not whether an AX digest changed. Keep the latest `observation_id` with node/index input and never replay completed steps after partial failure.".to_string(),
        "- Sparse AX does not mean the target is unreadable: inspect `ax_tree_status`, `ax_tree_note`, `ocr_text`, `ocr_status`, `ocr_error` and truncation notes. If neither AX nor OCR exposes the needed evidence, report that limitation. Do not replace GUI observation or input with shell capture, analysis, clipboard or keystroke scripts.".to_string(),
        "- Prefer background control and the bound application. For the user's GUI task, use `start_control` with foreground mode when background delivery is unsupported or verified ineffective, unless the user required background-only/no-disruption. Use `activate_app` on a capable native host and its fresh observation before global input; Linux uses the consented portal surface, separately from AT-SPI. Never replay uncertain input. Respect Stop, cancellation and permission denial. Verify recipient and composer content before an authorized send, then check delivery before retrying.".to_string(),
        "- If `ControlHub` is available for browser work, prefer `snapshot` then click by `@e*` ref; do not use its `screenshot` action with this model.".to_string(),
    ]
}

/// Browser-only text-only guidance for remote workspaces where `ComputerUse` is
/// disabled but `ControlHub` browser/terminal domains remain available on the
/// local client. Deliberately omits desktop-automation actions (`key_chord`,
/// `click_element`, AX, OCR) that are unavailable in remote mode.
fn control_hub_browser_text_only_guidance() -> Vec<String> {
    vec![
        "- The configured primary model does not accept image inputs.".to_string(),
        "- When using `ControlHub` with `domain: \"browser\"`, do not use `screenshot` or `domain:\"browser\" action:\"screenshot\"`; image bytes will be unreadable. Use `snapshot` then click by `@e*` ref instead.".to_string(),
    ]
}

fn runtime_computer_use_key_chord_guidance(host_os: &str) -> &'static str {
    match host_os {
        "macos" => "- Computer use / keyboard: macOS app-scoped shortcuts use `app_key_chord` with `command`, `option`, `control`, and `shift` modifier names.",
        "windows" => "- Computer use / keyboard: Windows app-scoped keyboard chords are unavailable. Use supported semantic actions in background mode. Global `key_chord` requires authorized foreground control and uses `meta`/`super`, `alt`, `control`, and `shift`.",
        "linux" => "- Computer use / keyboard: Linux background input uses AT-SPI semantic actions; `app_key_chord` is unavailable. Portal keyboard input requires authorized foreground control and uses `control`, `alt`, `shift`, and `meta`/`super`.",
        _ => "- Computer use / keyboard: match modifier names and app-scoped input capabilities to the execution host OS.",
    }
}

fn computer_use_key_chord_guidance(host_os: &str) -> &'static str {
    match host_os {
        "macos" => "Computer use / keyboard: macOS app-scoped shortcuts use `app_key_chord` with `command`, `option`, `control`, `shift`. Prefer background app-scoped ComputerUse actions; batch already-decided inputs and reuse their final observation.",
        "windows" => "Computer use / keyboard: Windows app-scoped keyboard chords are unavailable. Prefer background semantic ComputerUse actions; batch already-decided inputs and reuse their final observation. Global `key_chord` requires authorized foreground control and uses `meta`/`super`, `alt`, `control`, `shift`.",
        "linux" => "Computer use / keyboard: Linux background input uses AT-SPI semantic actions; `app_key_chord` is unavailable. Batch already-decided supported inputs and reuse their final observation. Portal keyboard input requires authorized foreground control and uses `control`, `alt`, `shift`, `meta`/`super`.",
        _ => "Computer use / keyboard: match modifier names and input capabilities to the execution host OS. Prefer background app-scoped ComputerUse actions; batch already-decided inputs and reuse their final observation.",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UserContextSection {
    WorkspaceContext,
    WorkspaceInstructions,
    ProjectLayout,
    MemorySummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserContextPolicy {
    pub sections: Vec<UserContextSection>,
}

impl UserContextPolicy {
    pub fn empty() -> Self {
        Self {
            sections: Vec::new(),
        }
    }

    pub fn with_section(mut self, section: UserContextSection) -> Self {
        if !self.includes(section) {
            self.sections.push(section);
        }
        self
    }

    pub fn without_section(mut self, section: UserContextSection) -> Self {
        self.sections.retain(|existing| *existing != section);
        self
    }

    pub fn with_workspace_context(self) -> Self {
        self.with_section(UserContextSection::WorkspaceContext)
    }

    pub fn with_workspace_instructions(self) -> Self {
        self.with_section(UserContextSection::WorkspaceInstructions)
    }

    pub fn with_project_layout(self) -> Self {
        self.with_section(UserContextSection::ProjectLayout)
    }

    pub fn with_memory_summary(self) -> Self {
        self.with_section(UserContextSection::MemorySummary)
    }

    pub fn includes(&self, section: UserContextSection) -> bool {
        self.sections.contains(&section)
    }

    pub fn cache_scope_key(&self) -> String {
        if self.sections.is_empty() {
            return "empty".to_string();
        }

        self.sections
            .iter()
            .map(UserContextSection::cache_scope_label)
            .collect::<Vec<_>>()
            .join("|")
    }
}

impl Default for UserContextPolicy {
    fn default() -> Self {
        Self::empty()
    }
}

impl UserContextSection {
    fn cache_scope_label(&self) -> &'static str {
        match self {
            Self::WorkspaceContext => "workspace_context",
            Self::WorkspaceInstructions => "workspace_instructions",
            Self::ProjectLayout => "project_layout",
            Self::MemorySummary => "memory_summary",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolListingSections {
    pub skill_listing: Option<String>,
    pub agent_listing: Option<String>,
    pub direct_tool_listing: Option<String>,
    pub deferred_tool_listing: Option<String>,
    /// PTC's generated TypeScript SDK, rendered as a conversation-start guide.
    pub ptc_tool_calling_guide: Option<String>,
}

impl ToolListingSections {
    pub fn is_empty(&self) -> bool {
        self.skill_listing.is_none()
            && self.agent_listing.is_none()
            && self.direct_tool_listing.is_none()
            && self.deferred_tool_listing.is_none()
            && self.ptc_tool_calling_guide.is_none()
    }

    pub fn render_skill_listing_reminder(&self) -> Option<String> {
        self.skill_listing.as_deref().map(|skill_listing| {
            Self::render_section(
                SKILL_LISTING_TITLE,
                skill_listing,
                Some(SKILL_LISTING_GUIDANCE),
            )
        })
    }

    pub fn render_agent_listing_reminder(&self) -> Option<String> {
        self.agent_listing.as_deref().map(|agent_listing| {
            Self::render_section(
                AGENT_LISTING_TITLE,
                agent_listing,
                Some(AGENT_LISTING_GUIDANCE),
            )
        })
    }

    pub fn render_deferred_tool_listing_reminder(&self) -> Option<String> {
        self.deferred_tool_listing
            .as_deref()
            .map(|deferred_tool_listing| {
                let direct_tool_listing = self.direct_tool_listing.as_deref().unwrap_or_default();
                format!(
                    "{}\n{}\n\n{}\n{}\n\n{}\n\n{}\n{}\n\n{}",
                    TOOL_CALLING_GUIDANCE_TITLE,
                    TOOL_CALLING_GUIDANCE,
                    DIRECT_TOOL_LISTING_TITLE,
                    DIRECT_TOOL_LISTING_GUIDANCE,
                    direct_tool_listing.trim(),
                    DEFERRED_TOOL_LISTING_TITLE,
                    DEFERRED_TOOL_LISTING_GUIDANCE,
                    deferred_tool_listing.trim(),
                )
            })
    }

    fn render_section(title: &str, body: &str, description: Option<&str>) -> String {
        match description {
            Some(description) => format!("{}\n{}\n\n{}", title, description, body.trim()),
            None => format!("{}\n{}", title, body.trim()),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PrependedPromptReminders {
    pub deferred_tool_listing: Option<String>,
    pub ptc_tool_calling_guide: Option<String>,
    pub skill_listing: Option<String>,
    pub agent_listing: Option<String>,
    pub runtime_context: Option<String>,
    pub user_context: Option<String>,
}

impl PrependedPromptReminders {
    pub fn ordered_reminders(&self) -> Vec<&str> {
        let mut reminders = Vec::new();
        if let Some(deferred_tool_listing) = self.deferred_tool_listing.as_deref() {
            reminders.push(deferred_tool_listing);
        }
        if let Some(ptc_tool_calling_guide) = self.ptc_tool_calling_guide.as_deref() {
            reminders.push(ptc_tool_calling_guide);
        }
        if let Some(skill_listing) = self.skill_listing.as_deref() {
            reminders.push(skill_listing);
        }
        if let Some(agent_listing) = self.agent_listing.as_deref() {
            reminders.push(agent_listing);
        }
        if let Some(runtime_context) = self.runtime_context.as_deref() {
            reminders.push(runtime_context);
        }
        if let Some(user_context) = self.user_context.as_deref() {
            reminders.push(user_context);
        }
        reminders
    }
}
