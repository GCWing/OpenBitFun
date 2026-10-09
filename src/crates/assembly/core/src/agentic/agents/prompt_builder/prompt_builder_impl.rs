//! System prompts module providing main dialogue and agent dialogue prompts
use crate::agentic::memories::build_memory_read_path_reminder;
use crate::agentic::memories::workspace::memory_root_dir;
use crate::agentic::tools::implementations::ExecCommandTool;
#[cfg(feature = "remote-workspace")]
use crate::agentic::util::remote_workspace_layout::build_remote_workspace_layout_preview;
#[cfg(feature = "remote-workspace")]
use crate::agentic::workspace::WorkspaceBackend;
use crate::agentic::WorkspaceBinding;
use crate::infrastructure::try_get_path_manager_arc;
use crate::service::bootstrap::build_workspace_persona_prompt;
use crate::service::config::{get_app_language_code, get_global_config_service};
use crate::service::filesystem::get_formatted_directory_listing;
use crate::service::i18n::LocaleId;
use crate::service::instruction_context::build_workspace_instruction_files_context;
#[cfg(feature = "remote-workspace")]
use crate::service::remote_ssh::workspace_state::get_remote_workspace_manager;
use crate::service::workspace::get_global_workspace_service;
use crate::service::workspace::RelatedPath;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use log::{debug, info, warn};
use openbitfun_agent_runtime::prompt::{
    render_project_layout, render_runtime_context_reminder, render_user_context_reminder,
    render_workspace_context, PrependedPromptReminders, ProjectLayoutFacts, PromptRelatedPath,
    RemoteExecutionHints, RuntimeContextFacts, RuntimeContextNeeds, RuntimeShellFacts,
    ToolListingSections, UserContextPolicy, UserContextSection, WorkspaceContextFacts,
    WorktreeContextFacts,
};
use openbitfun_agent_runtime::remote_file_delivery::user_workspace_relative_file_link;
use openbitfun_core_types::{product_identity::hidden_data_directory, SessionExecutionTargetKind};
use std::path::Path;

/// Placeholder constants
const PLACEHOLDER_PERSONA: &str = "{PERSONA}";
const PLACEHOLDER_LANGUAGE_PREFERENCE: &str = "{LANGUAGE_PREFERENCE}";
const PLACEHOLDER_SESSION_ID: &str = "{SESSION_ID}";
const PLACEHOLDER_DEEP_RESEARCH_REPORT_LINK: &str = "{DEEP_RESEARCH_REPORT_LINK}";
const PLACEHOLDER_MEMORY_ROOT: &str = "{MEMORY_ROOT}";
const PLACEHOLDER_READ_TERMINAL: &str = "{READ_TERMINAL}";
const PLACEHOLDER_COMPUTER_USE_GUIDANCE: &str = "{COMPUTER_USE_GUIDANCE}";
const PLACEHOLDER_FILE_REFERENCES: &str = "{FILE_REFERENCES}";

const COMPUTER_USE_GUIDANCE: &str = r#"# Direct desktop work

For ComputerUse handoffs, preserve the original user's request and any relevant approval as quotations, separate from your proposed plan. Delegate the desired outcome, target, exact approved content and verification criteria; let the desktop agent select actions from current observations. Default to background app control. Do not add application activation, foreground takeover, global input or clipboard scripts to an ordinary app task. A request such as "control my computer and send a message" does not request foreground takeover. Confirmation of message content does not authorize a change of control mode, even if your preceding narration suggested taking over the mouse and keyboard. An agent-written plan is not evidence of user authorization.

Use `ComputerUse` directly for native application and OS UI tasks when it appears in your current tool list. Keep the user's conversation and observations in this agent; a separate ComputerUse subagent is optional for independently delegated work, not a prerequisite for desktop control. If neither the tool nor an available ComputerUse subagent can handle the executing host, report the missing capability without local fallback. Default to background app control.

For a model that can see images, observe the selected window and act on its attached screenshot, including controls with no AX/OCR text. Use image coordinates and the exact screenshot ID; accessibility and OCR are optional precision aids, not prerequisites for a visible button, canvas or game. Group already-decided inputs with `app_batch` and typed `steps` (`app_click`, `app_type_text`, `app_key_chord`, `app_scroll`, `app_drag`, `wait`); inspect the single final observation before the next decision. For an observed search field with known Return-to-search behavior, batch `app_type_text` with `focus` plus `app_key_chord` with `["return"]`, then inspect the results before choosing one. Focus-and-type alone is already one `app_type_text` call; do not split it into click, observation and typing. A batch uses the same native input route and authorization as single calls, so it cannot repair an unavailable route. Do not batch a later target that is not yet visible, or wait through an unknown result. Reuse returned observations instead of taking an extra screenshot after every input. `app_drag` uses observed `from`/`to` image targets and `duration_ms`."#;

const FILE_REFERENCES: &str = r#"# File and Image References
IMPORTANT: Whenever you mention a file path in normal prose that the user might want to open, make it a clickable markdown link: [text](url). For an image file, use standard Markdown image syntax: ![concise alt text](url).

**Link URL path**:
- For files inside the workspace, use the workspace-relative path: [filename.ts](src/filename.ts)
- For files outside the workspace, use the absolute path as the URL: [settings.json](/absolute/path/to/settings.json)
- For images, use workspace-relative path or absolute path or verified HTTP(S) image URLs

**Line targets**:
- For a specific line, append `#L<line>` to URL: [filename.ts:42](src/filename.ts#L42)
- For a line range, append `#L<start>-L<end>`: [filename.ts:42-51](src/filename.ts#L42-L51)

**Link text and formatting**:
- Link text should be the bare filename, optionally with line numbers; do not include directory prefixes.
- Do not output bare paths as plain text in normal prose. Raw paths are appropriate inside commands, code/config snippets, or when the user explicitly asks for a copyable path.
- Do not wrap link text or the whole markdown link in backticks.

<good-examples>
- Source file: [filename.ts](src/filename.ts)
- Specific line: [filename.ts:42](src/filename.ts#L42)
- External file line: [settings.json:12](/absolute/path/to/settings.json#L12)
</good-examples>
<bad-examples>
- Bare path: src/filename.ts
- Backticks in link text: [`filename.ts:42`](src/filename.ts)
- Whole link wrapped in backticks: `[report.md](deep-research/report.md)`
- Full path in link text: [src/filename.ts](src/filename.ts)
- Absolute path as plain text: /absolute/path/to/deep-research/report.md
</bad-examples>"#;

#[derive(Debug, Clone)]
pub struct PromptBuilderContext {
    pub workspace_path: String,
    pub related_paths: Vec<RelatedPath>,
    pub session_id: Option<String>,
    pub model_name: Option<String>,
    /// When set, file/shell tools target this remote environment; OS and path instructions follow it.
    pub remote_execution: Option<RemoteExecutionHints>,
    /// Explicit worktree identity and owning-project facts shown to the agent.
    pub worktree: Option<WorktreeContextFacts>,
    /// Pre-built tree text for `{PROJECT_LAYOUT}` when the workspace is not on the local disk.
    pub remote_project_layout: Option<String>,
    /// When `Some(false)`, runtime context includes Computer use text-only guidance (no screenshot tool output).
    pub supports_image_understanding: Option<bool>,
    /// Dynamic tool listings injected outside tool descriptions for cache stability.
    pub tool_listing_sections: ToolListingSections,
    /// Runtime facts needed by the current model-visible tool set.
    pub runtime_context_needs: RuntimeContextNeeds,
    /// Remote mobile/bot turns need `computer://` links for file delivery.
    pub remote_file_delivery_channel: bool,
    /// Resolved through the active local or remote workspace filesystem provider.
    pub workspace_instruction_files_context: Option<String>,
    /// Distinguishes a resolved empty result from a caller that has not resolved instructions.
    pub workspace_instruction_files_context_resolved: bool,
}

impl PromptBuilderContext {
    pub fn new(
        workspace_path: impl Into<String>,
        session_id: Option<String>,
        model_name: Option<String>,
    ) -> Self {
        Self {
            workspace_path: workspace_path.into().replace("\\", "/"),
            related_paths: Vec::new(),
            session_id,
            model_name,
            remote_execution: None,
            worktree: None,
            remote_project_layout: None,
            supports_image_understanding: None,
            tool_listing_sections: ToolListingSections::default(),
            runtime_context_needs: RuntimeContextNeeds::default(),
            remote_file_delivery_channel: false,
            workspace_instruction_files_context: None,
            workspace_instruction_files_context_resolved: false,
        }
    }

    pub fn with_supports_image_understanding(mut self, supports: bool) -> Self {
        self.supports_image_understanding = Some(supports);
        self
    }

    pub fn with_tool_listing_sections(mut self, sections: ToolListingSections) -> Self {
        self.tool_listing_sections = sections;
        self
    }

    pub fn with_runtime_context_needs(mut self, needs: RuntimeContextNeeds) -> Self {
        self.runtime_context_needs = needs;
        self
    }

    pub fn with_related_paths(mut self, related_paths: Vec<RelatedPath>) -> Self {
        self.related_paths = related_paths;
        self
    }

    pub fn with_remote_prompt_overlay(
        mut self,
        execution: RemoteExecutionHints,
        project_layout: Option<String>,
    ) -> Self {
        self.remote_execution = Some(execution);
        self.remote_project_layout = project_layout;
        self
    }

    pub fn with_worktree_context(mut self, worktree: WorktreeContextFacts) -> Self {
        self.worktree = Some(worktree);
        self
    }

    pub fn with_remote_file_delivery_channel(mut self, enabled: bool) -> Self {
        self.remote_file_delivery_channel = enabled;
        self
    }

    pub fn with_workspace_instruction_files_context(mut self, context: Option<String>) -> Self {
        self.workspace_instruction_files_context = context;
        self.workspace_instruction_files_context_resolved = true;
        self
    }
}

pub async fn build_prompt_context_for_workspace(
    workspace: &WorkspaceBinding,
    workspace_id: Option<&str>,
    session_id: &str,
    model_name: Option<String>,
    supports_image_understanding: Option<bool>,
    tool_listing_sections: ToolListingSections,
    runtime_context_needs: RuntimeContextNeeds,
) -> Option<PromptBuilderContext> {
    let workspace_path = workspace.root_path_string();

    let related_paths = if let Some(workspace_id) = workspace_id {
        if let Some(workspace_service) = get_global_workspace_service() {
            workspace_service
                .get_workspace(workspace_id)
                .await
                .map(|workspace| workspace.related_paths)
                .unwrap_or_default()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    let mut base = PromptBuilderContext::new(
        workspace_path.clone(),
        Some(session_id.to_string()),
        model_name,
    )
    .with_related_paths(related_paths)
    .with_tool_listing_sections(tool_listing_sections)
    .with_runtime_context_needs(runtime_context_needs);
    if let Some(execution_target) = workspace
        .execution_target
        .as_ref()
        .filter(|target| target.kind != SessionExecutionTargetKind::Local)
    {
        base = base.with_worktree_context(WorktreeContextFacts {
            project_workspace_path: workspace.project_root_path_string(),
            execution_target: execution_target.clone(),
        });
    }
    if let Some(supports_image_understanding) = supports_image_understanding {
        base = base.with_supports_image_understanding(supports_image_understanding);
    }

    if !workspace.is_remote() {
        return Some(base);
    }

    #[cfg(not(feature = "remote-workspace"))]
    {
        Some(base)
    }

    #[cfg(feature = "remote-workspace")]
    {
        let Some(connection_id) = workspace.connection_id() else {
            return Some(base);
        };
        let connection_display_name = match &workspace.backend {
            WorkspaceBackend::Remote {
                connection_name, ..
            } => connection_name.clone(),
            _ => connection_id.to_string(),
        };
        let Some(manager) = get_remote_workspace_manager() else {
            warn!(
            "Remote workspace active but RemoteWorkspaceStateManager is missing; using minimal remote hints"
        );
            return Some(base.with_remote_prompt_overlay(
                RemoteExecutionHints {
                    connection_display_name,
                    kernel_name: "unknown".to_string(),
                    hostname: "unknown".to_string(),
                },
                None,
            ));
        };

        let ssh_manager = manager.get_ssh_manager().await;
        let file_service = manager.get_file_service().await;
        let (kernel_name, hostname) = if let Some(ref ssh) = ssh_manager {
            if let Some(info) = ssh.get_server_info(connection_id).await {
                (info.os_type, info.hostname)
            } else {
                ("Linux".to_string(), "remote".to_string())
            }
        } else {
            ("Linux".to_string(), "remote".to_string())
        };
        let remote_layout = if let Some(ref fs) = file_service {
            match build_remote_workspace_layout_preview(fs, connection_id, &workspace_path, 200)
                .await
            {
                Ok((_, preview)) => Some(preview),
                Err(e) => {
                    warn!("Remote workspace layout for prompt failed: {}", e);
                    None
                }
            }
        } else {
            None
        };

        Some(base.with_remote_prompt_overlay(
            RemoteExecutionHints {
                connection_display_name,
                kernel_name,
                hostname,
            },
            remote_layout,
        ))
    }
}

pub struct PromptBuilder {
    pub context: PromptBuilderContext,
    pub file_tree_max_entries: usize,
}

impl PromptBuilder {
    pub fn new(context: PromptBuilderContext) -> Self {
        Self {
            context,
            file_tree_max_entries: 200,
        }
    }

    /// Build runtime facts that may change independently from the agent's system prompt.
    pub async fn build_runtime_context_reminder(&self) -> Option<String> {
        let needs = self.context.runtime_context_needs;
        let local_shell = if needs.exec_command && self.context.remote_execution.is_none() {
            let shell = ExecCommandTool::local_shell_prompt_info().await;
            Some(RuntimeShellFacts {
                display_name: shell.display_name,
                shell_type: shell.shell_type,
                invocation: shell.invocation,
            })
        } else {
            None
        };

        render_runtime_context_reminder(&RuntimeContextFacts {
            needs,
            host_os: std::env::consts::OS.to_string(),
            host_family: std::env::consts::FAMILY.to_string(),
            host_arch: std::env::consts::ARCH.to_string(),
            remote_execution: self.context.remote_execution.clone(),
            local_shell,
            supports_image_understanding: self.context.supports_image_understanding,
        })
    }

    /// Get workspace context that is intentionally injected outside the system prompt cache.
    pub fn get_workspace_context(&self) -> String {
        render_workspace_context(&WorkspaceContextFacts {
            workspace_path: self.context.workspace_path.clone(),
            related_paths: self
                .context
                .related_paths
                .iter()
                .map(|related_path| PromptRelatedPath {
                    path: related_path.path.clone(),
                    description: related_path.description.clone(),
                })
                .collect(),
            remote_execution: self.context.remote_execution.clone(),
            worktree: self.context.worktree.clone(),
        })
    }

    /// Get workspace file list
    pub fn get_project_layout(&self) -> String {
        if let Some(remote_layout) = &self.context.remote_project_layout {
            return render_project_layout(&ProjectLayoutFacts {
                listing: remote_layout.clone(),
                reached_limit: false,
                max_entries: self.file_tree_max_entries,
                remote: true,
            });
        }

        let formatted_listing = get_formatted_directory_listing(
            &self.context.workspace_path,
            self.file_tree_max_entries,
        )
        .unwrap_or_else(|e| crate::service::filesystem::FormattedDirectoryListing {
            reached_limit: false,
            text: format!("Error listing directory: {}", e),
        });
        render_project_layout(&ProjectLayoutFacts {
            listing: formatted_listing.text,
            reached_limit: formatted_listing.reached_limit,
            max_entries: self.file_tree_max_entries,
            remote: false,
        })
    }

    pub fn build_skill_listing_reminder(&self) -> Option<String> {
        self.context
            .tool_listing_sections
            .render_skill_listing_reminder()
    }

    pub fn build_agent_listing_reminder(&self) -> Option<String> {
        self.context
            .tool_listing_sections
            .render_agent_listing_reminder()
    }

    pub fn build_deferred_tool_listing_reminder(&self) -> Option<String> {
        self.context
            .tool_listing_sections
            .render_deferred_tool_listing_reminder()
    }

    pub async fn build_user_context_reminder(&self, policy: &UserContextPolicy) -> Option<String> {
        let mut additional_sections = Vec::new();

        if policy.includes(UserContextSection::WorkspaceContext) {
            additional_sections.push(self.get_workspace_context());
        }

        if policy.includes(UserContextSection::WorkspaceInstructions) {
            if let Some(prompt) = &self.context.workspace_instruction_files_context {
                additional_sections.push(prompt.clone());
            } else if !self.context.workspace_instruction_files_context_resolved
                && self.context.remote_execution.is_none()
            {
                let workspace = Path::new(&self.context.workspace_path);
                match build_workspace_instruction_files_context(workspace).await {
                    Ok(Some(prompt)) => additional_sections.push(prompt),
                    Ok(None) => {}
                    Err(e) => warn!(
                        "Failed to build workspace instruction context: path={} error={}",
                        workspace.display(),
                        e
                    ),
                }
            }
        }

        let memory_section_allowed = self.context.remote_execution.is_none()
            && policy.includes(UserContextSection::MemorySummary);
        if memory_section_allowed {
            let enabled = memory_summary_enabled().await;
            info!(
                "Memory prompt injection evaluated: session_id={:?}, workspace_path={}, use_memories={}, remote_execution=false",
                self.context.session_id,
                self.context.workspace_path,
                enabled
            );
            if enabled {
                let memory_root = memory_root_dir();
                if let Some(memory_read_path) = build_memory_read_path_reminder(&memory_root).await
                {
                    info!(
                        "Memory prompt injection added: session_id={:?}, memory_root={}, reminder_bytes={}",
                        self.context.session_id,
                        memory_root.display(),
                        memory_read_path.len()
                    );
                    additional_sections.push(memory_read_path);
                } else {
                    info!(
                        "Memory prompt injection skipped because no reminder was available: session_id={:?}, memory_root={}",
                        self.context.session_id,
                        memory_root.display()
                    );
                }
            }
        } else {
            debug!(
                "Memory prompt injection not eligible: session_id={:?}, workspace_path={}, remote_execution={}, policy_includes_memory={}",
                self.context.session_id,
                self.context.workspace_path,
                self.context.remote_execution.is_some(),
                policy.includes(UserContextSection::MemorySummary)
            );
        }

        if policy.includes(UserContextSection::ProjectLayout) {
            additional_sections.push(self.get_project_layout());
        }

        render_user_context_reminder(additional_sections)
    }

    pub async fn build_prepended_reminders(
        &self,
        user_context_policy: &UserContextPolicy,
    ) -> PrependedPromptReminders {
        PrependedPromptReminders {
            deferred_tool_listing: self.build_deferred_tool_listing_reminder(),
            skill_listing: self.build_skill_listing_reminder(),
            agent_listing: self.build_agent_listing_reminder(),
            runtime_context: self.build_runtime_context_reminder().await,
            user_context: self.build_user_context_reminder(user_context_policy).await,
        }
    }

    fn build_terminal_transcript_prompt_guidance(&self) -> String {
        if self.context.remote_execution.is_some() {
            return String::new();
        }

        match try_get_path_manager_arc() {
            Ok(path_manager) => {
                let agents_path = path_manager
                    .user_data_dir()
                    .join("terminals")
                    .join("AGENTS.md");
                format!(
                    "## User terminal history

The user's terminal history may contain execution evidence that is missing from the conversation. Consult it when that evidence could materially affect the task, especially when:

- The user refers to a command, terminal operation, or result they previously ran or observed.
- The user reports a command-line, build, test, script, or process problem without providing the exact command or enough output to diagnose it.

Use the terminal history to recover relevant evidence before guessing or asking the user to repeat information that may already be recorded. Do not inspect it routinely when the request is unrelated to terminal activity or the conversation already contains sufficient command and output context.

For instructions on locating and reading the transcripts, read: `{}`
",
                    agents_path.to_string_lossy().replace('\\', "/"),
                )
            }
            Err(error) => {
                warn!(
                    "Failed to build terminal transcript prompt guidance; omitting it: {}",
                    error
                );
                String::new()
            }
        }
    }

    /// Get user language preference instruction
    ///
    /// Read app.language from global config, generate simple language instruction
    /// Returns empty string if config cannot be read
    /// Returns error if language code is unsupported
    async fn get_language_preference(&self) -> OpenBitFunResult<String> {
        let language_code = get_app_language_code().await;
        Self::format_language_instruction(&language_code)
    }

    /// Format language instruction based on language code
    fn format_language_instruction(lang_code: &str) -> OpenBitFunResult<String> {
        let Some(locale) = LocaleId::from_str(lang_code) else {
            return Err(OpenBitFunError::config(format!(
                "Unknown language code: {}",
                lang_code
            )));
        };
        let language = format!("**{}**", locale.model_language_name());
        Ok(format!("# Language Preference\nYou MUST respond in {} regardless of the user's input language. This is the system language setting and should be followed unless the user explicitly specifies a different language. This is crucial for smooth communication and user experience\n", language))
    }

    /// Build prompt from template, automatically fill content based on placeholders
    ///
    /// Supported placeholders:
    /// - `{PERSONA}` - Workspace persona files (BOOTSTRAP.md, SOUL.md, USER.md, IDENTITY.md)
    /// - `{LANGUAGE_PREFERENCE}` - User language preference (read from global config)
    /// - `{MEMORY_ROOT}` - OpenBitFun memory workspace root, used by internal memory agents
    /// - `{READ_TERMINAL}` - Local user terminal transcript guidance
    /// - `{COMPUTER_USE_GUIDANCE}` - Shared native desktop interaction guidance
    /// - `{FILE_REFERENCES}` - Shared file and image reference guidance
    ///
    /// If a placeholder is not in the template, corresponding content will not be added
    pub async fn build_prompt_from_template(&self, template: &str) -> OpenBitFunResult<String> {
        let mut result = template.to_string();

        // Replace {PERSONA}
        if result.contains(PLACEHOLDER_PERSONA) {
            let persona = if self.context.remote_execution.is_some() {
                "# Workspace persona\nMarkdown persona files (e.g. BOOTSTRAP.md, SOUL.md) live on the **remote** workspace. Use Read or Glob under the workspace root above to load them.\n\n"
                    .to_string()
            } else {
                let workspace = Path::new(&self.context.workspace_path);
                match build_workspace_persona_prompt(workspace).await {
                    Ok(prompt) => prompt.unwrap_or_default(),
                    Err(e) => {
                        warn!(
                            "Failed to build workspace persona prompt: path={} error={}",
                            workspace.display(),
                            e
                        );
                        String::new()
                    }
                }
            };
            result = result.replace(PLACEHOLDER_PERSONA, &persona);
        }

        // Replace {LANGUAGE_PREFERENCE}
        if result.contains(PLACEHOLDER_LANGUAGE_PREFERENCE) {
            let language_preference = self.get_language_preference().await?;
            result = result.replace(PLACEHOLDER_LANGUAGE_PREFERENCE, &language_preference);
        }

        if result.contains(PLACEHOLDER_READ_TERMINAL) {
            let read_terminal = self.build_terminal_transcript_prompt_guidance();
            result = result.replace(PLACEHOLDER_READ_TERMINAL, &read_terminal);
        }

        if result.contains(PLACEHOLDER_COMPUTER_USE_GUIDANCE) {
            result = result.replace(PLACEHOLDER_COMPUTER_USE_GUIDANCE, COMPUTER_USE_GUIDANCE);
        }

        if result.contains(PLACEHOLDER_FILE_REFERENCES) {
            result = result.replace(PLACEHOLDER_FILE_REFERENCES, FILE_REFERENCES);
        }

        // Replace {SESSION_ID} — used by deep-research Pro mode to anchor a per-session
        // work_dir under .openbitfun/sessions/{SESSION_ID}/research/. Falls back to a
        // timestamp slug when no session is bound (e.g. one-shot prompt builds in tests).
        let mut resolved_session_id: Option<String> = None;
        if result.contains(PLACEHOLDER_SESSION_ID)
            || result.contains(PLACEHOLDER_DEEP_RESEARCH_REPORT_LINK)
        {
            let session_id = self.context.session_id.clone().unwrap_or_else(|| {
                format!("unbound-{}", chrono::Local::now().format("%Y%m%d-%H%M%S"))
            });
            resolved_session_id = Some(session_id.clone());
            result = result.replace(PLACEHOLDER_SESSION_ID, &session_id);
        }

        if result.contains(PLACEHOLDER_DEEP_RESEARCH_REPORT_LINK) {
            let session_id = resolved_session_id.unwrap_or_else(|| {
                self.context.session_id.clone().unwrap_or_else(|| {
                    format!("unbound-{}", chrono::Local::now().format("%Y%m%d-%H%M%S"))
                })
            });
            let report_path = format!(
                "{}/sessions/{session_id}/research/report.md",
                hidden_data_directory()
            );
            let report_link = user_workspace_relative_file_link(
                &report_path,
                self.context.remote_file_delivery_channel,
            );
            result = result.replace(PLACEHOLDER_DEEP_RESEARCH_REPORT_LINK, &report_link);
        }

        if result.contains(PLACEHOLDER_MEMORY_ROOT) {
            let memory_root = memory_root_dir();
            result = result.replace(
                PLACEHOLDER_MEMORY_ROOT,
                &memory_root.to_string_lossy().replace('\\', "/"),
            );
        }

        Ok(result.trim().to_string())
    }
}

async fn memory_summary_enabled() -> bool {
    match get_global_config_service().await {
        Ok(service) => service
            .get_config(None)
            .await
            .map(|config: crate::service::config::types::GlobalConfig| config.memories.use_memories)
            .unwrap_or(true),
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::build_prompt_context_for_workspace;
    use super::PromptBuilder;
    use super::PromptBuilderContext;
    use super::RemoteExecutionHints;
    use super::RuntimeContextNeeds;
    use super::ToolListingSections;
    use crate::agentic::agents::UserContextPolicy;
    use crate::agentic::WorkspaceBinding;
    use crate::service::workspace::RelatedPath;
    use openbitfun_core_types::{
        SessionExecutionTarget, SessionExecutionTargetKind, WorktreeLifecycle,
    };
    use std::path::PathBuf;

    #[tokio::test]
    async fn builds_ordered_prepended_reminders_from_tool_listings_and_user_context() {
        let tool_sections = ToolListingSections {
            skill_listing: Some("<available_skills>\n- pdf\n</available_skills>".to_string()),
            agent_listing: Some("<available_agents>\n- Explore\n</available_agents>".to_string()),
            direct_tool_listing: Some(
                "<direct_tools>\n- Read\n- GetToolSpec\n- CallDeferredTool\n</direct_tools>"
                    .to_string(),
            ),
            deferred_tool_listing: Some(
                "<deferred_tools>\n- WebFetch\n</deferred_tools>".to_string(),
            ),
        };
        let context = PromptBuilderContext::new(r"workspace\root", None, None)
            .with_tool_listing_sections(tool_sections)
            .with_runtime_context_needs(RuntimeContextNeeds::from_tool_names(["Read"]));
        let reminders = PromptBuilder::new(context)
            .build_prepended_reminders(
                &UserContextPolicy::empty()
                    .with_workspace_context()
                    .with_workspace_instructions(),
            )
            .await;
        let reminders_for_order = reminders.clone();
        let ordered_reminders = reminders_for_order.ordered_reminders();

        let skill_listing = reminders
            .skill_listing
            .expect("skill listing reminder should build");
        let agent_listing = reminders
            .agent_listing
            .expect("agent listing reminder should build");
        let deferred_tool_listing = reminders
            .deferred_tool_listing
            .expect("deferred tool listing reminder should build");
        let user_context = reminders.user_context.expect("user context should build");
        let runtime_context = reminders
            .runtime_context
            .expect("runtime context should build");

        assert!(skill_listing.contains("# Skill Listing"));
        assert!(skill_listing
            .contains("A skill is a set of instructions provided through a `SKILL.md` source."));
        assert!(skill_listing.contains("<available_skills>"));
        assert!(!skill_listing.contains("# Agent Listing"));
        assert!(agent_listing.contains("# Agent Listing"));
        assert!(agent_listing.contains("<available_agents>"));
        assert!(!agent_listing.contains("# Tool Calling Guide"));
        assert!(deferred_tool_listing.contains("# Tool Calling Guide"));
        assert!(deferred_tool_listing.contains("## Direct tools"));
        assert!(deferred_tool_listing.contains("<direct_tools>"));
        assert!(deferred_tool_listing.contains("## Deferred tools"));
        assert!(deferred_tool_listing.contains("<deferred_tools>"));
        assert!(user_context.contains("# User Context"));
        assert!(user_context.contains("As you answer the user's questions"));
        assert!(user_context.contains("Current Working Directory: workspace/root"));
        assert!(runtime_context.contains("# Runtime Context"));
        assert!(runtime_context.contains("## Workspace Execution"));
        assert!(runtime_context
            .contains("Workspace file and shell tools operate on the local filesystem"));
        assert!(!runtime_context.contains("## ExecCommand Shell"));
        assert!(!runtime_context.contains("## Local Client"));
        assert!(!runtime_context.contains("ExecCommand shell:"));
        assert_eq!(
            ordered_reminders,
            vec![
                deferred_tool_listing.as_str(),
                skill_listing.as_str(),
                agent_listing.as_str(),
                runtime_context.as_str(),
                user_context.as_str(),
            ]
        );
    }

    #[tokio::test]
    async fn prepended_reminders_omit_runtime_context_without_runtime_tool_needs() {
        let context = PromptBuilderContext::new(r"workspace\root", None, None);
        let reminders = PromptBuilder::new(context)
            .build_prepended_reminders(&UserContextPolicy::empty())
            .await;

        assert_eq!(reminders.skill_listing, None);
        assert_eq!(reminders.agent_listing, None);
        assert_eq!(reminders.deferred_tool_listing, None);
        assert_eq!(reminders.user_context, None);
        assert_eq!(reminders.runtime_context, None);
    }

    #[tokio::test]
    async fn runtime_context_includes_workspace_info_for_workspace_tools() {
        let context = PromptBuilderContext::new(r"workspace\root", None, None)
            .with_runtime_context_needs(RuntimeContextNeeds::from_tool_names(["Read"]));
        let runtime_context = PromptBuilder::new(context)
            .build_runtime_context_reminder()
            .await
            .expect("runtime context should build");

        assert!(runtime_context.contains("# Runtime Context"));
        assert!(runtime_context.contains("## Workspace Execution"));
        assert!(runtime_context
            .contains("Workspace file and shell tools operate on the local filesystem"));
        assert!(!runtime_context.contains("## ExecCommand Shell"));
        assert!(!runtime_context.contains("## Local Client"));
        assert!(!runtime_context.contains("ExecCommand shell:"));
    }

    #[tokio::test]
    async fn runtime_context_includes_shell_info_when_exec_command_is_available() {
        let context = PromptBuilderContext::new(r"workspace\root", None, None)
            .with_runtime_context_needs(RuntimeContextNeeds::from_tool_names(["ExecCommand"]));
        let runtime_context = PromptBuilder::new(context)
            .build_runtime_context_reminder()
            .await
            .expect("runtime context should build");

        assert!(runtime_context.contains("# Runtime Context"));
        assert!(runtime_context.contains("## Workspace Execution"));
        assert!(runtime_context.contains("## ExecCommand Shell"));
        assert!(runtime_context.contains("ExecCommand shell:"));
        assert!(runtime_context.contains("invoked as `"));
        assert!(!runtime_context.contains("## Local Client"));
    }

    #[tokio::test]
    async fn runtime_context_includes_computer_use_info_only_when_needed() {
        let context = PromptBuilderContext::new(r"workspace\root", None, None)
            .with_runtime_context_needs(RuntimeContextNeeds::from_tool_names(["ComputerUse"]));
        let runtime_context = PromptBuilder::new(context)
            .build_runtime_context_reminder()
            .await
            .expect("runtime context should build");

        assert!(runtime_context.contains("## Local Client"));
        assert!(runtime_context.contains("Local OpenBitFun client OS:"));
        assert!(runtime_context.contains("Computer use / `key_chord`"));
        assert!(!runtime_context.contains("## Workspace Execution"));
        assert!(!runtime_context.contains("## ExecCommand Shell"));
        assert!(!runtime_context.contains("ExecCommand shell:"));
    }

    #[tokio::test]
    async fn runtime_context_includes_text_only_computer_use_guidance_for_non_visual_models() {
        let context = PromptBuilderContext::new(r"workspace\root", None, None)
            .with_supports_image_understanding(false)
            .with_runtime_context_needs(RuntimeContextNeeds::from_tool_names(["ComputerUse"]));
        let runtime_context = PromptBuilder::new(context)
            .build_runtime_context_reminder()
            .await
            .expect("runtime context should build");

        assert!(runtime_context.contains("## Computer Use Input Strategy"));
        assert!(runtime_context.contains("primary model does not accept image inputs"));
        assert!(runtime_context.contains("do not use `screenshot`"));
        assert!(runtime_context.contains("prefer `snapshot` then click by `@e*` ref"));
    }

    #[tokio::test]
    async fn runtime_context_omits_text_only_computer_use_guidance_for_visual_models() {
        let context = PromptBuilderContext::new(r"workspace\root", None, None)
            .with_supports_image_understanding(true)
            .with_runtime_context_needs(RuntimeContextNeeds::from_tool_names(["ComputerUse"]));
        let runtime_context = PromptBuilder::new(context)
            .build_runtime_context_reminder()
            .await
            .expect("runtime context should build");

        assert!(runtime_context.contains("## Local Client"));
        assert!(!runtime_context.contains("## Computer Use Input Strategy"));
        assert!(!runtime_context.contains("primary model does not accept image inputs"));
    }

    #[tokio::test]
    async fn system_prompt_template_does_not_append_text_only_computer_use_guidance() {
        let context = PromptBuilderContext::new(r"workspace\root", None, None)
            .with_supports_image_understanding(false)
            .with_runtime_context_needs(RuntimeContextNeeds::from_tool_names(["ComputerUse"]));
        let prompt = PromptBuilder::new(context)
            .build_prompt_from_template("Base system prompt")
            .await
            .expect("prompt should build");

        assert_eq!(prompt, "Base system prompt");
        assert!(!prompt.contains("Computer Use Input Strategy"));
        assert!(!prompt.contains("primary model does not accept image inputs"));
    }

    #[tokio::test]
    async fn runtime_context_omits_workspace_root_for_remote_execution() {
        let context = PromptBuilderContext::new("/workspace/project", None, None)
            .with_runtime_context_needs(RuntimeContextNeeds::from_tool_names([
                "Read",
                "ExecCommand",
                "ComputerUse",
            ]))
            .with_remote_prompt_overlay(
                RemoteExecutionHints {
                    connection_display_name: "dev-server".to_string(),
                    kernel_name: "Linux".to_string(),
                    hostname: "devbox".to_string(),
                },
                None,
            );
        let runtime_context = PromptBuilder::new(context)
            .build_runtime_context_reminder()
            .await
            .expect("runtime context should build");

        assert!(runtime_context
            .contains("Workspace file and shell tools operate on remote SSH connection"));
        assert!(runtime_context.contains("## Workspace Execution"));
        assert!(runtime_context.contains("## ExecCommand Shell"));
        assert!(runtime_context.contains("## Local Client"));
        assert!(runtime_context.contains("Local OpenBitFun client OS:"));
        assert!(runtime_context.contains("Computer use and UI automation operate on the local OpenBitFun desktop, even when workspace file and shell tools target a remote host."));
        assert!(runtime_context.contains("ExecCommand uses the remote user's default POSIX shell"));
        assert!(runtime_context.contains("This session operates on the remote SSH host only"));
    }

    #[tokio::test]
    async fn runtime_context_omits_local_client_os_for_remote_with_only_control_hub() {
        // Simulates a remote workspace where ComputerUse is disabled (filtered
        // out by is_available_in_context) but ControlHub remains available.
        // The agent must NOT see "Local OpenBitFun client OS" because that signal
        // causes it to mistake the client OS for the workspace execution OS.
        let context = PromptBuilderContext::new("/workspace/project", None, None)
            .with_runtime_context_needs(RuntimeContextNeeds::from_tool_names([
                "Read",
                "ExecCommand",
                "ControlHub",
            ]))
            .with_remote_prompt_overlay(
                RemoteExecutionHints {
                    connection_display_name: "dev-server".to_string(),
                    kernel_name: "Linux".to_string(),
                    hostname: "devbox".to_string(),
                },
                None,
            );
        let runtime_context = PromptBuilder::new(context)
            .build_runtime_context_reminder()
            .await
            .expect("runtime context should build");

        assert!(runtime_context
            .contains("Workspace file and shell tools operate on remote SSH connection"));
        assert!(runtime_context.contains("## ExecCommand Shell"));
        assert!(!runtime_context.contains("## Local Client"));
        assert!(!runtime_context.contains("Local OpenBitFun client OS:"));
    }

    #[tokio::test]
    async fn remote_user_context_keeps_port_resolved_workspace_instructions() {
        let context = PromptBuilderContext::new("/workspace/project", None, None)
            .with_remote_prompt_overlay(
                RemoteExecutionHints {
                    connection_display_name: "dev-server".to_string(),
                    kernel_name: "Linux".to_string(),
                    hostname: "devbox".to_string(),
                },
                None,
            )
            .with_workspace_instruction_files_context(Some(
                "## Codebase and user instructions\n\n<document name=\"AGENTS.md\">\nremote rules\n</document>"
                    .to_string(),
            ));

        let user_context = PromptBuilder::new(context)
            .build_user_context_reminder(&UserContextPolicy::empty().with_workspace_instructions())
            .await
            .expect("remote instructions should be rendered");

        assert!(user_context.contains("remote rules"));
        assert!(user_context.contains("AGENTS.md"));
    }

    #[tokio::test]
    async fn resolved_empty_instruction_context_does_not_fall_back_to_local_disk() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("AGENTS.md"), "stale direct-disk rules\n")
            .expect("agents file");
        let context =
            PromptBuilderContext::new(temp.path().to_string_lossy().to_string(), None, None)
                .with_workspace_instruction_files_context(None);

        let user_context = PromptBuilder::new(context)
            .build_user_context_reminder(&UserContextPolicy::empty().with_workspace_instructions())
            .await;

        assert!(user_context.is_none());
    }

    #[tokio::test]
    async fn local_terminal_transcript_placeholder_includes_the_agents_path() {
        let context = PromptBuilderContext::new("workspace/root", None, None);
        let prompt = PromptBuilder::new(context)
            .build_prompt_from_template("{READ_TERMINAL}")
            .await
            .expect("prompt should build");
        let expected_path = crate::infrastructure::try_get_path_manager_arc()
            .expect("path manager should initialize")
            .user_data_dir()
            .join("terminals")
            .join("AGENTS.md")
            .to_string_lossy()
            .replace('\\', "/");

        assert!(prompt.contains(&expected_path));
        assert!(prompt.contains(
            "The user refers to a command, terminal operation, or result they previously ran or observed."
        ));
        assert!(prompt
            .contains("The user reports a command-line, build, test, script, or process problem"));
        assert!(prompt.contains("Do not inspect it routinely"));
    }

    #[tokio::test]
    async fn remote_terminal_transcript_placeholder_is_omitted() {
        let context = PromptBuilderContext::new("/workspace/project", None, None)
            .with_remote_prompt_overlay(
                RemoteExecutionHints {
                    connection_display_name: "dev-server".to_string(),
                    kernel_name: "Linux".to_string(),
                    hostname: "devbox".to_string(),
                },
                None,
            );
        let prompt = PromptBuilder::new(context)
            .build_prompt_from_template("before\n{READ_TERMINAL}\nafter")
            .await
            .expect("prompt should build");

        assert!(!prompt.contains("User terminal transcript"));
        assert!(!prompt.contains("{READ_TERMINAL}"));
        assert_eq!(prompt, "before\n\nafter");
    }

    #[tokio::test]
    async fn template_without_terminal_transcript_placeholder_is_unchanged() {
        let context = PromptBuilderContext::new("workspace/root", None, None);
        let prompt = PromptBuilder::new(context)
            .build_prompt_from_template("plain template")
            .await
            .expect("prompt should build");

        assert_eq!(prompt, "plain template");
    }

    #[tokio::test]
    async fn deep_research_report_link_defaults_to_workspace_relative_path() {
        let context =
            PromptBuilderContext::new("workspace/root", Some("session-1".to_string()), None);
        let prompt = PromptBuilder::new(context)
            .build_prompt_from_template("[View full report]({DEEP_RESEARCH_REPORT_LINK})")
            .await
            .expect("prompt should build");

        assert_eq!(
            prompt,
            "[View full report](.openbitfun/sessions/session-1/research/report.md)"
        );
    }

    #[tokio::test]
    async fn deep_research_report_link_uses_computer_scheme_for_remote_delivery() {
        let context =
            PromptBuilderContext::new("workspace/root", Some("session-1".to_string()), None)
                .with_remote_file_delivery_channel(true);
        let prompt = PromptBuilder::new(context)
            .build_prompt_from_template("[View full report]({DEEP_RESEARCH_REPORT_LINK})")
            .await
            .expect("prompt should build");

        assert_eq!(
            prompt,
            "[View full report](computer://.openbitfun/sessions/session-1/research/report.md)"
        );
    }

    #[tokio::test]
    async fn memory_summary_is_skipped_for_remote_workspace() {
        let context = PromptBuilderContext::new("/workspace/project", None, None)
            .with_remote_prompt_overlay(
                RemoteExecutionHints {
                    connection_display_name: "dev-server".to_string(),
                    kernel_name: "Linux".to_string(),
                    hostname: "devbox".to_string(),
                },
                None,
            );
        let reminder = PromptBuilder::new(context)
            .build_user_context_reminder(&UserContextPolicy::empty().with_memory_summary())
            .await;

        assert!(reminder.is_none());
    }

    #[test]
    fn workspace_context_renders_related_directories() {
        let context =
            PromptBuilderContext::new(r"workspace\root", None, None).with_related_paths(vec![
                RelatedPath {
                    path: r"legacy-ts\client".to_string(),
                    description: Some("Legacy TypeScript implementation".to_string()),
                },
                RelatedPath {
                    path: r"monorepo\billing".to_string(),
                    description: Some("Billing package".to_string()),
                },
            ]);

        let workspace_context = PromptBuilder::new(context).get_workspace_context();

        assert!(workspace_context.contains("Related directories"));
        assert!(workspace_context.contains("legacy-ts/client"));
        assert!(workspace_context.contains("Legacy TypeScript implementation"));
        assert!(workspace_context.contains("monorepo/billing"));
    }

    #[test]
    fn workspace_context_renders_related_directories_without_description() {
        let context =
            PromptBuilderContext::new(r"workspace\root", None, None).with_related_paths(vec![
                RelatedPath {
                    path: r"monorepo\packages\payments".to_string(),
                    description: None,
                },
            ]);

        let workspace_context = PromptBuilder::new(context).get_workspace_context();

        assert!(workspace_context.contains("Related directories"));
        assert!(workspace_context.contains("  - monorepo/packages/payments"));
        assert!(!workspace_context.contains("payments —"));
    }

    #[tokio::test]
    async fn workspace_context_identifies_the_managed_worktree_binding() {
        let execution_target = SessionExecutionTarget {
            kind: SessionExecutionTargetKind::ManagedWorktree,
            worktree_id: Some("wt-1".to_string()),
            root_path: "/managed/OpenBitFun-wt-1".to_string(),
            base_ref: Some("HEAD".to_string()),
            base_commit: Some("0123456789abcdef".to_string()),
            branch: None,
            lifecycle: Some(WorktreeLifecycle::Managed),
        };
        let workspace = WorkspaceBinding::new(
            Some("workspace-1".to_string()),
            PathBuf::from("/managed/OpenBitFun-wt-1"),
        )
        .with_project_root_path(PathBuf::from("/projects/OpenBitFun"))
        .with_execution_target(Some(execution_target));
        let context = build_prompt_context_for_workspace(
            &workspace,
            None,
            "session-1",
            Some("primary".to_string()),
            None,
            ToolListingSections::default(),
            RuntimeContextNeeds::default(),
        )
        .await
        .expect("prompt context should build");

        let workspace_context = PromptBuilder::new(context).get_workspace_context();

        assert!(workspace_context.contains("Managed Git worktree created for this session"));
        assert!(workspace_context.contains("Owning project root"));
        assert!(workspace_context.contains("/projects/OpenBitFun"));
        assert!(workspace_context.contains("Worktree ID: wt-1"));
        assert!(workspace_context.contains("Worktree checkout: detached HEAD"));
        assert!(workspace_context.contains("Worktree base commit: 0123456789abcdef"));
    }
}
