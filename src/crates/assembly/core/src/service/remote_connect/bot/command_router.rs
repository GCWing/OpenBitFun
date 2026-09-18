//! Shared command router for IM-bot connections (Telegram / Feishu / WeChat).
//!
//! All user-facing menu/command logic lives here.  Platform adapters only
//! handle message I/O and render the platform-agnostic [`HandleResult`] /
//! [`crate::service::remote_connect::bot::menu::MenuView`] returned from
//! [`handle_command`].
//!
//! Public surface kept stable so existing adapters keep compiling:
//!   - Types: `BotChatState`, `BotCommand`, `BotAction`, `BotActionStyle`,
//!     `BotInteractiveRequest`, `BotInteractionHandler`, `BotMessageSender`,
//!     `BotQuestion`, `BotQuestionOption`, `BotDisplayMode`, `BotLanguage`,
//!     `HandleResult`, `ForwardRequest`, `ForwardedTurnResult`, `PendingAction`.
//!   - Functions: `parse_command`, `handle_command`, `welcome_message`,
//!     `complete_im_bot_pairing`, `current_bot_language`,
//!     `execute_forwarded_turn`, `apply_interactive_request`.

use crate::service_agent_runtime::{
    remote_opened_workspace_catalog, remote_workspace_display_name, remote_workspace_metadata,
};
use log::{error, info};
use serde_json::Value;
use std::sync::{Arc, OnceLock};

pub use super::locale::{current_bot_language, BotLanguage};
use super::locale::{fmt_count, strings_for, BotStrings};
use super::menu::{MenuItem, MenuView};
pub use openbitfun_services_integrations::remote_connect::bot::{
    parse_command, BotAction, BotActionStyle, BotChatState, BotCommand, BotDisplayMode,
    BotInteractionHandler, BotInteractiveRequest, BotMessageSender, BotQuestion, BotQuestionOption,
    BotWorkspaceChoice, BotWorkspaceRef, PendingAction, RemoteBotTarget, RemoteDeviceTarget,
};

// ── Constants ──────────────────────────────────────────────────────

/// How many invalid replies are tolerated before pending state is auto-cleared.
const PENDING_INVALID_LIMIT: u8 = 3;

// ── Global delegated identity provider (set by desktop layer) ─────

/// Returns `(relay_url, token, master_key)` if the desktop is logged into an
/// account. Set by the desktop layer via `set_delegated_identity_provider` so
/// the bot can inherit the account identity when pairing succeeds, enabling
/// multi-device control without going through the room channel.
type DelegateFn = Arc<
    dyn Fn() -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Option<(String, String, Vec<u8>)>> + Send>,
        > + Send
        + Sync,
>;

static DELEGATE_PROVIDER: OnceLock<DelegateFn> = OnceLock::new();

/// Called by the desktop layer after account login. Installs a closure that
/// returns `(relay_url, delegated_token, master_key_bytes)` on demand.
pub fn set_delegated_identity_provider<F, Fut>(f: F)
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Option<(String, String, Vec<u8>)>> + Send + 'static,
{
    let _ = DELEGATE_PROVIDER.set(Arc::new(move || Box::pin(f())));
}

/// Try to obtain the delegated identity from the global provider. Returns
/// `None` if the desktop is not logged in or the provider is not set.
async fn try_get_delegated_identity() -> Option<(String, String, Vec<u8>)> {
    let provider = DELEGATE_PROVIDER.get()?;
    provider().await
}

// ── Per-chat state ─────────────────────────────────────────────────

pub struct HandleResult {
    pub reply: String,
    pub actions: Vec<BotAction>,
    pub forward_to_session: Option<ForwardRequest>,
    /// Same content as [`MenuView`] — adapters that want to render a richer
    /// view (Telegram inline keyboard, Feishu card, WeChat numbered text)
    /// can read this directly instead of `actions`.
    pub menu: MenuView,
}

pub struct ForwardRequest {
    pub remote_target: Option<RemoteBotTarget>,
    pub session_id: String,
    pub content: String,
    pub agent_type: String,
    pub turn_id: String,
    pub image_contexts: Vec<crate::agentic::image_analysis::ImageContextData>,
}

pub struct ForwardedTurnResult {
    pub completed_remote_tools: Vec<String>,
    pub display_text: String,
    pub full_text: String,
}

// ── BotCommand ─────────────────────────────────────────────────────

pub fn welcome_message(language: BotLanguage) -> &'static str {
    strings_for(language).welcome
}

// ── MenuView -> HandleResult helpers ───────────────────────────────

fn result_from_menu(state: &mut BotChatState, view: MenuView) -> HandleResult {
    let actions: Vec<BotAction> = view.items.iter().cloned().map(BotAction::from).collect();
    state.last_menu_commands = view.numeric_commands();
    HandleResult {
        reply: view.render_text_block(),
        actions,
        forward_to_session: None,
        menu: view,
    }
}

fn result_from_menu_with_forward(
    state: &mut BotChatState,
    view: MenuView,
    forward: Option<ForwardRequest>,
) -> HandleResult {
    let mut r = result_from_menu(state, view);
    r.forward_to_session = forward;
    r
}

// ── Menu builders ──────────────────────────────────────────────────

fn welcome_view(s: &'static BotStrings) -> MenuView {
    MenuView::plain(s.welcome_title)
        .with_body(s.welcome)
        .with_footer(s.welcome_body)
}

fn ready_to_chat_body(state: &BotChatState, s: &'static BotStrings) -> Option<String> {
    // When switched to a remote device, show the device name instead of
    // workspace/assistant — the remote device has its own workspace context.
    if let Some(ref dev) = state.active_remote_device {
        return Some(format!("{}: {}", s.devices_remote_prefix, dev.device_name));
    }
    // Always show the workspace / assistant name (a human-meaningful
    // identifier) regardless of whether a session is active. We deliberately
    // do NOT surface `current_session_id` — the random UUID tail (e.g.
    // "5cff6a1") is opaque to the user and adds nothing useful. If the
    // user wants to manage sessions they can use /resume which renders
    // proper session names.
    if state.display_mode == BotDisplayMode::Pro {
        match state.current_workspace_path() {
            Some(p) => Some(format!(
                "{}: {}",
                s.current_workspace_label,
                short_path_name(p)
            )),
            None => Some(s.no_workspace.to_string()),
        }
    } else {
        // Assistant mode: prefer the cached assistant display name (set by
        // pairing / switch / resume flows from workspace identity facts). The
        // workspace path's directory name is meaningless here — the actual
        // assistant folder is usually `workspace` or `workspace-<uuid>`,
        // both of which look like noise to the user.
        match &state.current_assistant {
            Some(p) => {
                let label = state
                    .current_assistant_name
                    .as_deref()
                    .filter(|n| !n.trim().is_empty())
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| short_path_name(p));
                Some(format!("{}: {}", s.current_assistant_label, label))
            }
            None => Some(s.no_assistant.to_string()),
        }
    }
}

/// Refresh the selected assistant label from current identity facts, including
/// states that already cached an obsolete directory name. Peer control must
/// never resolve a peer path against this host's workspace service.
async fn refresh_assistant_name(state: &mut BotChatState) {
    use crate::service::workspace::get_global_workspace_service;
    if state.active_remote_device.is_some() || state.assistant_workspace_ref().is_none() {
        return;
    }
    let Some(service) = get_global_workspace_service() else {
        return;
    };
    refresh_assistant_name_from_workspaces(state, &service.get_assistant_workspaces().await);
}

fn refresh_assistant_name_from_workspaces(
    state: &mut BotChatState,
    workspaces: &[crate::service::workspace::WorkspaceInfo],
) {
    let Some(reference) = state.assistant_workspace_ref() else {
        return;
    };
    // Upgrade-only ingress. Explicit IDs never fall back to a legacy path.
    match crate::service::workspace::legacy_compat::resolve_legacy_workspace_reference(
        workspaces,
        reference.workspace_id.as_deref(),
        &reference.path,
        None,
        None,
    ) {
        Ok(Some(workspace)) => {
            state.current_assistant_id = Some(workspace.id.clone());
            state.current_assistant = Some(workspace.root_path.to_string_lossy().into_owned());
            state.current_assistant_name =
                Some(remote_workspace_display_name(&workspace).to_string());
        }
        Ok(None) => {}
        Err(error) => log::warn!("Failed to upgrade bot assistant workspace identity: {error}"),
    }
}

fn short_path_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| path.to_string())
}

fn main_menu_view(state: &BotChatState, s: &'static BotStrings) -> MenuView {
    let title = if state.display_mode == BotDisplayMode::Pro {
        s.main_title_expert
    } else {
        s.main_title_assistant
    };
    let body = ready_to_chat_body(state, s);
    let mut items: Vec<MenuItem> = Vec::new();
    if state.display_mode == BotDisplayMode::Pro {
        items.push(MenuItem::primary(
            s.item_new_code_session,
            "/new_code_session",
        ));
        items.push(MenuItem::default(
            s.item_new_cowork_session,
            "/new_cowork_session",
        ));
        items.push(MenuItem::default(s.item_resume_session, "/resume"));
        items.push(MenuItem::default(s.item_switch_workspace, "/switch"));
    } else {
        items.push(MenuItem::primary(s.item_new_session, "/new"));
        items.push(MenuItem::default(s.item_resume_session, "/resume"));
        items.push(MenuItem::default(s.item_switch_assistant, "/switch"));
    }
    items.push(MenuItem::default(s.item_devices, "/devices"));
    items.push(MenuItem::default(s.item_settings, "/settings"));
    let mut view = MenuView::plain(title).with_items(items);
    if let Some(b) = body {
        view = view.with_body(b);
    }
    view
}

fn settings_menu_view(verbose: bool, state: &BotChatState, s: &'static BotStrings) -> MenuView {
    let mut items: Vec<MenuItem> = Vec::new();
    if state.display_mode == BotDisplayMode::Pro {
        items.push(MenuItem::default(s.item_switch_to_assistant, "/assistant"));
    } else {
        items.push(MenuItem::default(s.item_switch_to_expert, "/expert"));
    }
    if verbose {
        items.push(MenuItem::default(s.item_verbose_off, "/concise"));
    } else {
        items.push(MenuItem::default(s.item_verbose_on, "/verbose"));
    }
    items.push(MenuItem::default(s.item_switch_model, "/model"));
    items.push(MenuItem::default(s.item_help, "/help"));
    items.push(MenuItem::default(s.item_back, "/menu"));
    let body = format!(
        "{} · {}: {}",
        if state.display_mode == BotDisplayMode::Pro {
            s.mode_expert
        } else {
            s.mode_assistant
        },
        s.verbose_label,
        if verbose {
            s.verbose_status_on
        } else {
            s.verbose_status_off
        },
    );
    MenuView::plain(s.settings_title)
        .with_body(body)
        .with_items(items)
}

fn need_session_view(state: &BotChatState, s: &'static BotStrings) -> MenuView {
    let mut items = Vec::new();
    if state.display_mode == BotDisplayMode::Pro {
        items.push(MenuItem::primary(
            s.item_new_code_session,
            "/new_code_session",
        ));
        items.push(MenuItem::default(
            s.item_new_cowork_session,
            "/new_cowork_session",
        ));
    } else {
        items.push(MenuItem::primary(s.item_new_session, "/new"));
    }
    items.push(MenuItem::default(s.item_resume_session, "/resume"));
    items.push(MenuItem::default(s.item_back, "/menu"));
    MenuView::plain(s.need_session_title).with_items(items)
}

fn confirm_mode_switch_view(target_mode: BotDisplayMode, s: &'static BotStrings) -> MenuView {
    let target_label = if target_mode == BotDisplayMode::Pro {
        s.mode_expert
    } else {
        s.mode_assistant
    };
    let body = format!(
        "{} → {}\n\n1. {}",
        s.mode_confirm_switch_prefix, target_label, s.item_confirm_switch
    );
    MenuView::plain(s.settings_title)
        .with_numbered_body(body)
        .with_items(vec![
            MenuItem::primary(s.item_confirm_switch, "1"),
            MenuItem::default(s.item_back, "/menu"),
        ])
        .with_footer(s.pending_back_hint)
}

// ── Model switching ────────────────────────────────────────────────

fn model_selection_view(
    current_model_id: &Option<String>,
    options: &[(String, String)],
    s: &'static BotStrings,
) -> MenuView {
    let mut items = Vec::new();
    let mut body = String::new();

    // Option 1: configured primary model.
    let primary_is_current = current_model_id
        .as_deref()
        .map(|m| m.is_empty() || m == "primary")
        .unwrap_or(true);
    let primary_marker = if primary_is_current {
        s.current_marker
    } else {
        ""
    };
    body.push_str(&format!(
        "1. {}{}\n",
        s.switch_model_primary, primary_marker
    ));
    items.push(MenuItem::default(s.switch_model_primary, "primary"));

    // Remaining options: each enabled model.
    for (i, (model_id, model_name)) in options.iter().enumerate() {
        let is_current = current_model_id
            .as_deref()
            .is_some_and(|m| m == model_id.as_str());
        let marker = if is_current { s.current_marker } else { "" };
        body.push_str(&format!("{}. {}{}\n", i + 2, model_name, marker));
        items.push(MenuItem::default(
            truncate_label(model_name, 24),
            model_id.clone(),
        ));
    }

    items.push(MenuItem::default(s.item_back, "/menu"));
    MenuView::plain(s.switch_model_title)
        .with_numbered_body(body.trim_end().to_string())
        .with_items(items)
        .with_footer(s.footer_reply_model)
}

async fn start_switch_model(state: &mut BotChatState, s: &'static BotStrings) -> HandleResult {
    use crate::service_agent_runtime::CoreServiceAgentRuntime;
    let session_id = match state.current_session_id.clone() {
        Some(id) => id,
        None => {
            return result_from_menu(
                state,
                MenuView::plain(s.switch_model_no_session)
                    .with_items(vec![MenuItem::default(s.item_back, "/menu")]),
            );
        }
    };

    let catalog = match CoreServiceAgentRuntime::load_remote_model_catalog(Some(&session_id)).await
    {
        Ok(c) => c,
        Err(e) => {
            return result_from_menu(
                state,
                MenuView::plain(format!("{}{e}", s.switch_model_failed_prefix))
                    .with_items(vec![MenuItem::default(s.item_back, "/menu")]),
            );
        }
    };

    // Collect enabled models as (id, "name · provider") for the selection list.
    let options: Vec<(String, String)> = catalog
        .models
        .iter()
        .filter(|m| m.enabled)
        .map(|m| (m.id.clone(), format!("{} · {}", m.model_name, m.name)))
        .collect();

    if options.is_empty() {
        return result_from_menu(
            state,
            MenuView::plain(s.switch_model_no_models)
                .with_items(vec![MenuItem::default(s.item_back, "/menu")]),
        );
    }

    let view = model_selection_view(&catalog.session_model_id, &options, s);
    state.set_pending(PendingAction::SelectModel { options });
    result_from_menu(state, view)
}

async fn select_model(
    state: &mut BotChatState,
    model_id: &str,
    model_name: &str,
    s: &'static BotStrings,
) -> HandleResult {
    use crate::service_agent_runtime::CoreServiceAgentRuntime;
    let session_id = match state.current_session_id.clone() {
        Some(id) => id,
        None => {
            return result_from_menu(state, MenuView::plain(s.switch_model_no_session));
        }
    };

    let coordinator = match crate::agentic::coordination::get_global_coordinator() {
        Some(c) => c,
        None => {
            return result_from_menu(
                state,
                MenuView::plain(format!(
                    "{}{}",
                    s.switch_model_failed_prefix, s.session_system_unavailable,
                )),
            );
        }
    };
    let runtime = match CoreServiceAgentRuntime::agent_runtime(coordinator.clone()) {
        Ok(runtime) => runtime,
        Err(error) => {
            return result_from_menu(
                state,
                MenuView::plain(format!("{}{error}", s.switch_model_failed_prefix,)),
            );
        }
    };

    match CoreServiceAgentRuntime::update_remote_session_model(
        coordinator.as_ref(),
        &runtime,
        &session_id,
        model_id,
        None,
    )
    .await
    {
        Ok(_) => {
            let body = format!("{}{}", s.switch_model_applied_prefix, model_name);
            let mut view = main_menu_view(state, s);
            view = view.with_body(body);
            result_from_menu(state, view)
        }
        Err(e) => result_from_menu(
            state,
            MenuView::plain(format!("{}{e}", s.switch_model_failed_prefix))
                .with_items(vec![MenuItem::default(s.item_back, "/menu")]),
        ),
    }
}

// ── Public entry points ────────────────────────────────────────────

async fn open_bot_workspace(
    workspace_service: &crate::service::workspace::WorkspaceService,
    workspace_id: &str,
) -> Result<crate::service::workspace::WorkspaceInfo, String> {
    let coordinator = crate::agentic::coordination::get_global_coordinator()
        .ok_or_else(|| "Conversation coordinator not initialized".to_string())?;
    coordinator
        .select_workspace_with_runtime_ownership(workspace_service, workspace_id)
        .await
        .map_err(|error| error.to_string())
}

/// IM pairing bootstrap: assistant mode + default assistant workspace + new
/// Claw session.  Mutates `state.display_mode/current_assistant/
/// current_session_id` on success.
pub async fn bootstrap_im_chat_after_pairing(state: &mut BotChatState) -> String {
    use crate::service::workspace::get_global_workspace_service;

    state.display_mode = BotDisplayMode::Assistant;
    let language = current_bot_language().await;
    let s = strings_for(language);

    let ws_service = match get_global_workspace_service() {
        Some(s) => s,
        None => return s.bootstrap_workspace_unavailable.to_string(),
    };

    let mut assistants = ws_service.get_assistant_workspaces().await;
    if assistants.is_empty() {
        match ws_service.create_assistant_workspace(None).await {
            Ok(w) => assistants.push(w),
            Err(e) => return format!("{}{e}", s.assistant_create_failed_prefix),
        }
    }

    let picked = ws_service
        .get_primary_assistant_workspace()
        .await
        .or_else(|| assistants.first().cloned());

    let Some(ws_info) = picked else {
        return s.bootstrap_workspace_unavailable.to_string();
    };

    if let Err(e) = open_bot_workspace(ws_service.as_ref(), &ws_info.id).await {
        return format!("{}{e}", s.workspace_open_failed_prefix);
    }

    state.current_assistant_id = Some(ws_info.id.clone());
    state.current_assistant = Some(ws_info.root_path.to_string_lossy().to_string());
    state.current_assistant_name = Some(remote_workspace_display_name(&ws_info).to_string());
    state.current_session_id = None;

    let create_res = create_session(state, "Claw").await;
    if state.current_session_id.is_none() {
        let detail = create_res.reply.lines().next().unwrap_or("").to_string();
        return format!("{}{detail}", s.bootstrap_session_failed_prefix);
    }

    s.bootstrap_ready.to_string()
}

/// Mark chat paired, run assistant/session bootstrap, return main menu.
pub async fn complete_im_bot_pairing(state: &mut BotChatState) -> HandleResult {
    state.paired = true;
    let language = current_bot_language().await;
    let s = strings_for(language);

    // If the desktop is logged into an account, inject the delegated
    // identity + relay_url so the bot can use /devices and remote RPC.
    if state.relay_url.is_none() || state.delegated_token.is_none() {
        if let Some((relay_url, token, master_key)) = try_get_delegated_identity().await {
            state.relay_url = Some(relay_url);
            state.set_delegated_identity(token, master_key);
            info!("Bot inherited account identity for multi-device control");
        }
    }

    let note = bootstrap_im_chat_after_pairing(state).await;

    let mut view = main_menu_view(state, s);
    let combined_body = match view.body.take() {
        Some(b) => format!("{}\n\n{}\n\n{}", s.paired_success, note, b),
        None => format!("{}\n\n{}", s.paired_success, note),
    };
    view = view.with_body(combined_body);
    result_from_menu(state, view)
}

/// Public adapter helper: install an interactive request received from the
/// session executor onto the chat state and refresh its TTL.
fn interaction_tool(action: &PendingAction) -> Option<&str> {
    match action {
        PendingAction::AskUserQuestion { tool_id, .. }
        | PendingAction::ConfirmRemoteTool { tool_id, .. } => Some(tool_id),
        _ => None,
    }
}

fn same_interaction(
    a: &PendingAction,
    a_target: Option<&RemoteBotTarget>,
    b: &PendingAction,
    b_target: Option<&RemoteBotTarget>,
) -> bool {
    interaction_tool(a) == interaction_tool(b)
        && a_target.map(|t| (&t.device_id, &t.session_id))
            == b_target.map(|t| (&t.device_id, &t.session_id))
}

pub fn apply_interactive_request(state: &mut BotChatState, req: &BotInteractiveRequest) -> bool {
    if state.pending_expired() {
        state.clear_pending();
    }
    if let Some(current) = state
        .pending_action
        .as_ref()
        .filter(|action| interaction_tool(action).is_some())
    {
        if same_interaction(
            current,
            state.pending_remote_target.as_ref(),
            &req.pending_action,
            req.remote_target.as_ref(),
        ) {
            // Keep a remotely blocked interaction answerable while preserving
            // its partially collected answers and original button token.
            state.set_pending(current.clone());
            return false;
        }
        if !state.pending_interactions.iter().any(|queued| {
            same_interaction(
                &queued.pending_action,
                queued.remote_target.as_ref(),
                &req.pending_action,
                req.remote_target.as_ref(),
            )
        }) {
            state.pending_interactions.push_back(req.clone());
        }
        return false;
    }
    state.set_pending(req.pending_action.clone());
    state.pending_remote_target = req.remote_target.clone();
    state.last_menu_commands = req.menu.items.iter().map(|i| i.command.clone()).collect();
    true
}

/// Return the next still-pending prompt for the adapter to install and display.
pub(super) fn retire_completed_remote_tools(
    state: &mut BotChatState,
    target: &RemoteBotTarget,
    tool_ids: &[String],
) -> Option<BotInteractiveRequest> {
    let completed = |action: &PendingAction, origin: Option<&RemoteBotTarget>| {
        origin.is_some_and(|origin| {
            origin.relay_url == target.relay_url
                && origin.device_id == target.device_id
                && origin.session_id == target.session_id
        }) && interaction_tool(action).is_some_and(|id| tool_ids.iter().any(|tool| tool == id))
    };
    state
        .pending_interactions
        .retain(|request| !completed(&request.pending_action, request.remote_target.as_ref()));
    if state
        .pending_action
        .as_ref()
        .is_some_and(|action| completed(action, state.pending_remote_target.as_ref()))
    {
        let mut queued = std::mem::take(&mut state.pending_interactions);
        state.clear_pending();
        state.last_menu_commands.clear();
        let next = queued.pop_front();
        state.pending_interactions = queued;
        next
    } else {
        None
    }
}

fn finish_bot_interaction(state: &mut BotChatState, s: &'static BotStrings) -> HandleResult {
    let mut queued = std::mem::take(&mut state.pending_interactions);
    state.clear_pending();
    if let Some(next) = queued.pop_front() {
        apply_interactive_request(state, &next);
        state.pending_interactions = queued;
        let mut view = next.menu;
        view.body = Some(format!(
            "{}\n\n{}",
            s.answers_submitted,
            view.body.unwrap_or_default()
        ));
        result_from_menu(state, view)
    } else {
        result_from_menu(state, MenuView::plain(s.answers_submitted))
    }
}

// ── Dispatch ───────────────────────────────────────────────────────

pub async fn handle_command(
    state: &mut BotChatState,
    cmd: BotCommand,
    images: Vec<super::super::remote_server::ImageAttachment>,
) -> HandleResult {
    if state.active_remote_device.is_none()
        && !state.account_remote_context
        && state.current_workspace.as_ref().is_some_and(|workspace| {
            workspace.remote_ssh_host.as_deref().map(str::trim) == Some("localhost")
                && workspace
                    .remote_connection_id
                    .as_deref()
                    .is_none_or(|id| id.trim().is_empty())
        })
    {
        if let Some(service) = crate::service::workspace::get_global_workspace_service() {
            repair_local_bot_workspace_state(state, &service.list_workspace_infos().await);
        }
    }

    let image_contexts: Vec<crate::agentic::image_analysis::ImageContextData> =
        super::super::remote_server::images_to_contexts(if images.is_empty() {
            None
        } else {
            Some(&images)
        });
    dispatch(state, cmd, image_contexts).await
}

async fn dispatch(
    state: &mut BotChatState,
    cmd: BotCommand,
    image_contexts: Vec<crate::agentic::image_analysis::ImageContextData>,
) -> HandleResult {
    let language = current_bot_language().await;
    let s = strings_for(language);

    // Auto-expire pending actions before any branch.
    if state.pending_expired() {
        state.clear_pending();
        let mut view = main_menu_view(state, s);
        view = view.with_body(s.pending_expired);
        return result_from_menu(state, view);
    }

    // Universal escape hatches: /menu and /start always return the main menu
    // and clear any pending action.
    if matches!(cmd, BotCommand::Menu) {
        state.clear_pending();
        return menu_or_welcome(state, s);
    }

    // Pairing-code submitted after pairing already completed → just nudge.
    if let BotCommand::PairingCode(_) = &cmd {
        if state.paired {
            let view = MenuView::plain(s.main_title_assistant)
                .with_body(s.paired_success)
                .with_items(main_menu_view(state, s).items);
            return result_from_menu(state, view);
        }
        // Not paired path is handled by the platform wait_for_pairing loop.
    }

    if !state.paired {
        return result_from_menu(state, welcome_view(s));
    }

    // Refresh both legacy missing labels and cached names after identity edits.
    refresh_assistant_name(state).await;

    // Handle /cancel as task cancellation when an active session exists.
    if let BotCommand::CancelTask(turn_id) = &cmd {
        return handle_cancel_task(state, turn_id.as_deref(), s).await;
    }

    // Numeric replies: when there is a pending action, route to it.  When
    // there isn't, treat the number as an index into `last_menu_commands`.
    if let BotCommand::NumberSelection(n) = cmd {
        return handle_number(state, n, s).await;
    }

    match cmd {
        BotCommand::Help => {
            let mut items: Vec<MenuItem> = Vec::new();
            if state.display_mode == BotDisplayMode::Pro {
                items.push(MenuItem::primary(
                    s.item_new_code_session,
                    "/new_code_session",
                ));
                items.push(MenuItem::default(
                    s.item_new_cowork_session,
                    "/new_cowork_session",
                ));
                items.push(MenuItem::default(s.item_switch_workspace, "/switch"));
            } else {
                items.push(MenuItem::primary(s.item_new_session, "/new"));
                items.push(MenuItem::default(s.item_switch_assistant, "/switch"));
            }
            items.push(MenuItem::default(s.item_resume_session, "/resume"));
            items.push(MenuItem::default(s.item_switch_model, "/model"));
            items.push(MenuItem::default(s.item_devices, "/devices"));
            items.push(MenuItem::default(s.item_settings, "/settings"));
            result_from_menu(
                state,
                MenuView::plain(s.welcome_title)
                    .with_body(s.help_body)
                    .with_items(items),
            )
        }
        BotCommand::Settings => {
            let verbose = super::load_bot_persistence().verbose_mode;
            result_from_menu(state, settings_menu_view(verbose, state, s))
        }
        BotCommand::SwitchMode(target) => switch_mode(state, target, s).await,
        BotCommand::SetVerbose(on) => set_verbose(state, on, s).await,
        BotCommand::SwitchContext => start_switch(state, s).await,
        BotCommand::NewSession => new_session_for_mode(state, s).await,
        BotCommand::NewCodeSession => guarded_new(state, "Standard", s).await,
        BotCommand::NewCoworkSession => guarded_new(state, "Cowork", s).await,
        BotCommand::NewClawSession => guarded_new(state, "Claw", s).await,
        BotCommand::ResumeSession => start_resume(state, 0, s).await,
        BotCommand::SwitchModel => start_switch_model(state, s).await,
        BotCommand::ChatMessage(msg) => handle_chat(state, &msg, image_contexts, s).await,
        BotCommand::Menu
        | BotCommand::CancelTask(_)
        | BotCommand::NumberSelection(_)
        | BotCommand::PairingCode(_) => menu_or_welcome(state, s), // already handled
        BotCommand::ListDevices => list_devices(state, s).await,
    }
}

// ── Multi-device control ──────────────────────────────────────────
//
// The bot drives the relay's HTTP device-control API directly using a
// delegated account identity (token + master key) that the desktop layer
// installs on `BotChatState` after pairing + account login. We reuse the
// existing `AccountClient` (which wraps reqwest + AES-256-GCM) rather than
// re-implementing the encryption/request envelope inline.

fn devices_unavailable_view(s: &'static BotStrings) -> MenuView {
    MenuView::plain(s.devices_title)
        .with_body(s.devices_account_required)
        .with_items(vec![MenuItem::default(s.item_back, "/menu")])
}

/// Build a temporary `AccountSession` from the delegated identity so the
/// existing `AccountClient` methods (list_devices / device_rpc) can be reused
/// without duplicating the relay/encryption envelope.
fn delegated_session(
    state: &BotChatState,
) -> Option<crate::service::remote_connect::AccountSession> {
    use crate::service::remote_connect::account::MASTER_KEY_LEN;
    let token = state.delegated_token.clone()?;
    let key_vec = state.delegated_master_key.clone()?;
    if key_vec.len() != MASTER_KEY_LEN {
        log::warn!(
            "delegated master key has wrong length {} (expected {MASTER_KEY_LEN})",
            key_vec.len()
        );
        return None;
    }
    let mut master_key = [0u8; 32];
    master_key.copy_from_slice(&key_vec);
    Some(crate::service::remote_connect::AccountSession::new(
        token,
        String::new(),
        master_key,
    ))
}

async fn list_devices(state: &mut BotChatState, s: &'static BotStrings) -> HandleResult {
    // Lazy-inject delegated identity if not yet set (e.g. after restart restore).
    if state.relay_url.is_none() {
        if let Some((relay_url, token, master_key)) = try_get_delegated_identity().await {
            state.relay_url = Some(relay_url);
            state.set_delegated_identity(token, master_key);
        }
    }
    let Some(relay_url) = state.relay_url.clone() else {
        return result_from_menu(state, devices_unavailable_view(s));
    };
    let Some(session) = delegated_session(state) else {
        return result_from_menu(state, devices_unavailable_view(s));
    };

    let client = crate::service::remote_connect::AccountClient::new();
    let devices = match client.list_devices(&relay_url, &session).await {
        Ok(d) => d,
        Err(e) => {
            error!("Bot list_devices failed: {e}");
            return result_from_menu(
                state,
                MenuView::plain(format!("{}{e}", s.devices_list_failed_prefix))
                    .with_items(vec![MenuItem::default(s.item_back, "/menu")]),
            );
        }
    };

    // Build a selectable list: "0. Local" + each online device.
    let online: Vec<_> = devices.into_iter().filter(|d| d.online).collect();

    let mut options: Vec<(String, String)> =
        vec![("local".to_string(), s.devices_local.to_string())];

    for d in &online {
        options.push((d.device_id.clone(), d.device_name.clone()));
    }

    let view = device_selection_view(state, &options, s);
    state.set_pending(PendingAction::SelectDevice { options });
    result_from_menu(state, view)
}

fn device_selection_view(
    state: &BotChatState,
    options: &[(String, String)],
    s: &'static BotStrings,
) -> MenuView {
    let mut body = String::new();
    let mut items = Vec::new();
    for (i, (device_id, device_name)) in options.iter().enumerate() {
        let is_current = if device_id == "local" {
            state.active_remote_device.is_none()
        } else {
            state
                .active_remote_device
                .as_ref()
                .is_some_and(|active| active.device_id == *device_id)
        };
        let marker = if is_current { s.current_marker } else { "" };
        body.push_str(&format!("{}. {}{}\n", i + 1, device_name, marker));
        items.push(MenuItem::default(
            truncate_label(device_name, 24),
            (i + 1).to_string(),
        ));
    }
    items.push(MenuItem::default(s.item_back, "/menu"));

    MenuView::plain(s.devices_title)
        .with_numbered_body(body.trim_end().to_string())
        .with_items(items)
        .with_footer(s.devices_pick_to_switch)
}

// ── Remote device RPC helpers ────────────────────────────────────

/// Execute a RemoteCommand on the active remote device via HTTP RPC.
/// Returns the decrypted response JSON string.
/// Caller must check `state.active_remote_device.is_some()` first.
async fn exec_remote_rpc(state: &BotChatState, command_json: &str) -> Result<String, String> {
    let device = state
        .active_remote_device
        .as_ref()
        .ok_or("no active remote device")?;
    let relay_url = state.relay_url.as_ref().ok_or("no relay_url")?;
    let session = delegated_session(state).ok_or("no delegated identity")?;
    let client = crate::service::remote_connect::AccountClient::new();
    client
        .device_rpc(relay_url, &session, &device.device_id, command_json)
        .await
        .map_err(|e| format!("{e}"))
}

fn menu_or_welcome(state: &mut BotChatState, s: &'static BotStrings) -> HandleResult {
    if state.paired {
        result_from_menu(state, main_menu_view(state, s))
    } else {
        result_from_menu(state, welcome_view(s))
    }
}

// ── Mode switching ─────────────────────────────────────────────────

async fn switch_mode(
    state: &mut BotChatState,
    target: BotDisplayMode,
    s: &'static BotStrings,
) -> HandleResult {
    if state.display_mode == target {
        let body = if target == BotDisplayMode::Pro {
            s.mode_already_expert
        } else {
            s.mode_already_assistant
        };
        let mut view = main_menu_view(state, s);
        view = view.with_body(body);
        return result_from_menu(state, view);
    }
    state.display_mode = target;
    let body = if target == BotDisplayMode::Pro {
        s.mode_switched_to_expert
    } else {
        s.mode_switched_to_assistant
    };
    let mut view = main_menu_view(state, s);
    view = view.with_body(body);
    result_from_menu(state, view)
}

async fn confirm_then_run(
    state: &mut BotChatState,
    target: BotDisplayMode,
    target_cmd: String,
    s: &'static BotStrings,
) -> HandleResult {
    state.set_pending(PendingAction::ConfirmModeSwitch {
        target_mode: target,
        target_cmd,
    });
    result_from_menu(state, confirm_mode_switch_view(target, s))
}

async fn set_verbose(state: &mut BotChatState, on: bool, s: &'static BotStrings) -> HandleResult {
    super::update_bot_persistence(|data| data.verbose_mode = on);

    let body = if on {
        s.verbose_enabled
    } else {
        s.verbose_disabled
    };
    let mut view = settings_menu_view(on, state, s);
    view = view.with_body(body);
    result_from_menu(state, view)
}

// ── Switch context (workspace or assistant) ────────────────────────

fn remote_workspace_choices(response: &str) -> Result<Vec<BotWorkspaceChoice>, String> {
    let value: Value = serde_json::from_str(response).map_err(|error| error.to_string())?;
    if value.get("resp").and_then(Value::as_str) == Some("error") {
        return Err(value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Remote workspace service unavailable")
            .to_string());
    }
    if value.get("resp").and_then(Value::as_str) != Some("recent_workspaces") {
        return Err("Unexpected remote workspace catalog response".to_string());
    }
    // Field presence negotiates the authoritative catalog. In particular an
    // empty opened list must not resurrect entries from recent history.
    let rows = match value.get("opened_workspaces") {
        Some(Value::Array(rows)) => rows,
        None | Some(Value::Null) => value
            .get("workspaces")
            .and_then(Value::as_array)
            .ok_or_else(|| "Invalid legacy workspace catalog response".to_string())?,
        _ => return Err("Invalid opened workspace catalog response".to_string()),
    };
    Ok(rows
        .iter()
        .filter_map(|workspace| {
            // The bot keeps its existing Pro/Assistant picker separation.
            if workspace.get("workspace_kind").and_then(Value::as_str) == Some("assistant") {
                return None;
            }
            let text = |key| {
                workspace
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            };
            let path = text("path")?;
            let local = matches!(text("workspace_kind"), Some("normal" | "assistant"));
            Some(
                BotWorkspaceChoice::new(
                    path,
                    text("name").unwrap_or(path),
                    text("remote_connection_id")
                        .filter(|_| !local)
                        .map(str::to_string),
                    text("remote_ssh_host")
                        .filter(|_| !local)
                        .map(str::to_string),
                )
                .with_workspace_id(text("workspace_id").map(str::to_string)),
            )
        })
        .collect())
}

async fn load_remote_workspace_choices(
    state: &BotChatState,
) -> Result<Vec<BotWorkspaceChoice>, String> {
    let response = exec_remote_rpc(state, r#"{"cmd":"list_recent_workspaces"}"#).await?;
    remote_workspace_choices(&response)
}

fn show_workspace_choices(
    state: &mut BotChatState,
    options: Vec<BotWorkspaceChoice>,
    s: &'static BotStrings,
) -> HandleResult {
    state.clear_pending();
    if options.is_empty() {
        return result_from_menu(
            state,
            MenuView::plain(s.switch_no_workspaces)
                .with_items(vec![MenuItem::default(s.item_back, "/menu")]),
        );
    }
    let view = workspace_selection_view(state, &options, s);
    state.set_pending(PendingAction::SelectWorkspace { options });
    result_from_menu(state, view)
}

fn local_pro_workspace_choices(
    workspaces: Vec<openbitfun_runtime_ports::RemoteRecentWorkspaceFacts>,
) -> Vec<BotWorkspaceChoice> {
    workspaces
        .into_iter()
        .filter(|workspace| {
            workspace.kind != openbitfun_runtime_ports::RemoteWorkspaceKind::Assistant
        })
        .map(|workspace| {
            BotWorkspaceChoice::new(
                workspace.path,
                workspace.name,
                workspace.remote_connection_id,
                workspace.remote_ssh_host,
            )
            .with_workspace_id(Some(workspace.workspace_id))
        })
        .collect()
}

fn current_workspace_choice<'a>(
    options: &'a [BotWorkspaceChoice],
    selected: &BotWorkspaceChoice,
) -> Option<&'a BotWorkspaceChoice> {
    options.iter().find(|option| {
        if let Some(id) = selected.workspace_id.as_deref() {
            return option.workspace_id.as_deref() == Some(id);
        }
        option.path == selected.path
            && option.remote_connection_id == selected.remote_connection_id
            && option.remote_ssh_host == selected.remote_ssh_host
    })
}

fn workspace_list_changed_result(
    state: &mut BotChatState,
    result: HandleResult,
    s: &'static BotStrings,
) -> HandleResult {
    let mut view = result.menu;
    view.title = format!("{}\n{}", s.workspace_list_changed, view.title);
    result_from_menu(state, view)
}

async fn start_local_switch(
    state: &mut BotChatState,
    service: &crate::service::workspace::WorkspaceService,
    s: &'static BotStrings,
) -> HandleResult {
    let workspaces = remote_opened_workspace_catalog(service).await;
    state.clear_pending();
    if state.display_mode == BotDisplayMode::Pro {
        show_workspace_choices(state, local_pro_workspace_choices(workspaces), s)
    } else {
        let options: Vec<_> = workspaces
            .into_iter()
            .filter(|workspace| {
                workspace.kind == openbitfun_runtime_ports::RemoteWorkspaceKind::Assistant
            })
            .map(|workspace| (workspace.workspace_id, workspace.name))
            .collect();
        if options.is_empty() {
            return result_from_menu(
                state,
                MenuView::plain(s.switch_no_assistants)
                    .with_items(vec![MenuItem::default(s.item_back, "/menu")]),
            );
        }
        let view = assistant_selection_view(state, &options, s);
        state.set_pending(PendingAction::SelectAssistant { options });
        result_from_menu(state, view)
    }
}

async fn start_switch(state: &mut BotChatState, s: &'static BotStrings) -> HandleResult {
    state.clear_pending();
    // Remote device catalogs never fall back to this host's workspaces.
    if state.active_remote_device.is_some() {
        if state.display_mode != BotDisplayMode::Pro {
            return result_from_menu(
                state,
                MenuView::plain(s.switch_no_assistants)
                    .with_items(vec![MenuItem::default(s.item_back, "/menu")]),
            );
        }
        return match load_remote_workspace_choices(state).await {
            Ok(options) => show_workspace_choices(state, options, s),
            Err(error) => result_from_menu(
                state,
                MenuView::plain(format!("{}{error}", s.workspace_open_failed_prefix))
                    .with_items(vec![MenuItem::default(s.item_back, "/menu")]),
            ),
        };
    }
    let Some(service) = crate::service::workspace::get_global_workspace_service() else {
        return result_from_menu(
            state,
            MenuView::plain(s.workspace_service_unavailable)
                .with_items(vec![MenuItem::default(s.item_back, "/menu")]),
        );
    };
    start_local_switch(state, &service, s).await
}

fn workspace_selection_view(
    state: &BotChatState,
    options: &[BotWorkspaceChoice],
    s: &'static BotStrings,
) -> MenuView {
    let mut items = Vec::new();
    let mut body = String::new();
    for (i, choice) in options.iter().enumerate() {
        // The ID decides the current item whenever both sides carry one; the
        // legacy triple is only for rows a pre-ID host could not label.
        let is_current = state.current_workspace.as_ref().is_some_and(|current| {
            match (
                current.workspace_id.as_deref(),
                choice.workspace_id.as_deref(),
            ) {
                (Some(current_id), Some(choice_id)) => current_id == choice_id,
                _ => {
                    current.path == choice.path
                        && current.remote_connection_id == choice.remote_connection_id
                        && current.remote_ssh_host == choice.remote_ssh_host
                }
            }
        });
        let marker = if is_current { s.current_marker } else { "" };
        let host_hint = choice
            .remote_ssh_host
            .as_deref()
            .filter(|host| !host.is_empty())
            .map(|host| format!(" ({host})"))
            .unwrap_or_default();
        body.push_str(&format!(
            "{}. {}{}{}\n",
            i + 1,
            choice.name,
            host_hint,
            marker
        ));
        items.push(MenuItem::default(
            truncate_label(&choice.name, 24),
            (i + 1).to_string(),
        ));
    }
    items.push(MenuItem::default(s.item_back, "/menu"));
    MenuView::plain(s.switch_pick_workspace)
        .with_numbered_body(body.trim_end().to_string())
        .with_items(items)
        .with_footer(s.footer_reply_workspace)
}

fn assistant_selection_view(
    state: &BotChatState,
    options: &[(String, String)],
    s: &'static BotStrings,
) -> MenuView {
    let mut items = Vec::new();
    let mut body = String::new();
    for (i, (workspace_id, name)) in options.iter().enumerate() {
        let is_current = state.current_assistant_id.as_deref() == Some(workspace_id.as_str());
        let marker = if is_current { s.current_marker } else { "" };
        body.push_str(&format!("{}. {}{}\n", i + 1, name, marker));
        items.push(MenuItem::default(
            truncate_label(name, 24),
            (i + 1).to_string(),
        ));
    }
    items.push(MenuItem::default(s.item_back, "/menu"));
    MenuView::plain(s.switch_pick_assistant)
        .with_numbered_body(body.trim_end().to_string())
        .with_items(items)
        .with_footer(s.footer_reply_assistant)
}

fn session_selection_view(
    state: &BotChatState,
    options: &[(String, String)],
    page: usize,
    has_more: bool,
    s: &'static BotStrings,
) -> MenuView {
    let mut items = Vec::new();
    let mut body = String::new();
    for (i, (id, name)) in options.iter().enumerate() {
        let is_current = state.current_session_id.as_deref() == Some(id.as_str());
        let marker = if is_current { s.current_marker } else { "" };
        body.push_str(&format!("{}. {}{}\n", i + 1, name, marker));
        items.push(MenuItem::default(
            truncate_label(name, 26),
            (i + 1).to_string(),
        ));
    }
    if has_more {
        items.push(MenuItem::default(s.item_next_page, "0"));
    }
    items.push(MenuItem::default(s.item_back, "/menu"));
    let footer = if has_more {
        s.footer_reply_session_or_next
    } else {
        s.footer_reply_session
    };
    MenuView::plain(format!("{} · #{}", s.resume_page_label, page + 1))
        .with_numbered_body(body.trim_end().to_string())
        .with_items(items)
        .with_footer(footer)
}

async fn select_workspace(
    state: &mut BotChatState,
    choice: &BotWorkspaceChoice,
    s: &'static BotStrings,
) -> HandleResult {
    if state.active_remote_device.is_some() {
        let options = match load_remote_workspace_choices(state).await {
            Ok(options) => options,
            Err(error) => {
                return result_from_menu(
                    state,
                    MenuView::plain(format!("{}{error}", s.workspace_open_failed_prefix))
                        .with_items(vec![MenuItem::default(s.item_back, "/menu")]),
                )
            }
        };
        let Some(choice) = current_workspace_choice(&options, choice) else {
            let result = show_workspace_choices(state, options, s);
            return workspace_list_changed_result(state, result, s);
        };
        // A choice the device labelled with an ID is selected by that ID
        // alone, so an ID-aware host can never fall back to the path. Rows
        // from a pre-ID host carry no ID and get the legacy projection.
        let cmd = match choice.workspace_id.as_deref() {
            Some(workspace_id) => serde_json::json!({
                "cmd": "set_workspace",
                "workspace_id": workspace_id,
            }),
            None => serde_json::json!({
                "cmd": "set_workspace",
                "path": choice.path,
                "remote_connection_id": choice.remote_connection_id,
                "remote_ssh_host": choice.remote_ssh_host,
            }),
        };
        let cmd_json = serde_json::to_string(&cmd).unwrap_or_default();
        return match exec_remote_rpc(state, &cmd_json).await {
            Ok(resp) => {
                let val: serde_json::Value = match serde_json::from_str(&resp) {
                    Ok(v) => v,
                    Err(e) => {
                        return result_from_menu(
                            state,
                            MenuView::plain(format!("{}{e}", s.workspace_open_failed_prefix)),
                        );
                    }
                };
                if val.get("success").and_then(|value| value.as_bool()) != Some(true) {
                    let message = val
                        .get("error")
                        .and_then(|value| value.as_str())
                        .or_else(|| val.get("message").and_then(|value| value.as_str()))
                        .unwrap_or(s.workspace_open_failed_prefix);
                    return result_from_menu(
                        state,
                        MenuView::plain(message.to_string())
                            .with_items(vec![MenuItem::default(s.item_back, "/menu")]),
                    );
                }
                let workspace_path = val
                    .get("path")
                    .and_then(|value| value.as_str())
                    .unwrap_or(&choice.path)
                    .to_string();
                let workspace_ref = BotWorkspaceRef::with_identity(
                    workspace_path.clone(),
                    val.get("remote_connection_id")
                        .and_then(|value| value.as_str())
                        .map(str::to_string)
                        .or_else(|| choice.remote_connection_id.clone()),
                    val.get("remote_ssh_host")
                        .and_then(|value| value.as_str())
                        .map(str::to_string)
                        .or_else(|| choice.remote_ssh_host.clone()),
                )
                .with_workspace_id(
                    val.get("workspace_id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .or_else(|| choice.workspace_id.clone()),
                );
                state.current_workspace = Some(workspace_ref);
                state.current_session_id = None;
                let body = format!(
                    "{}: {}\n{}: {}",
                    s.devices_remote_prefix,
                    state
                        .active_remote_device
                        .as_ref()
                        .map(|device| device.device_name.as_str())
                        .unwrap_or("remote"),
                    s.current_workspace_label,
                    choice.name,
                );
                let mut view = main_menu_view(state, s);
                view = view.with_body(body);
                result_from_menu(state, view)
            }
            Err(error) => result_from_menu(
                state,
                MenuView::plain(format!("{}{error}", s.workspace_open_failed_prefix))
                    .with_items(vec![MenuItem::default(s.item_back, "/menu")]),
            ),
        };
    }

    use crate::service::workspace::get_global_workspace_service;

    let ws_service = match get_global_workspace_service() {
        Some(svc) => svc,
        None => {
            return result_from_menu(state, MenuView::plain(s.workspace_service_unavailable));
        }
    };
    select_local_workspace(state, &ws_service, choice, s).await
}

fn bot_workspace_ref(workspace: &crate::service::workspace::WorkspaceInfo) -> BotWorkspaceRef {
    BotWorkspaceRef::with_identity(
        workspace.root_path.to_string_lossy().to_string(),
        remote_workspace_metadata(
            &workspace.workspace_kind,
            &workspace.metadata,
            "connectionId",
        ),
        remote_workspace_metadata(&workspace.workspace_kind, &workspace.metadata, "sshHost"),
    )
    .with_workspace_id(Some(workspace.id.clone()))
}

/// Repair the host-only local marker emitted by older bot versions using this
/// host's registry. Never reinterpret another device's paths or an explicit SSH
/// connection, and preserve ambiguous local/remote roots.
fn repair_local_bot_workspace_state(
    state: &mut BotChatState,
    workspaces: &[crate::service::workspace::WorkspaceInfo],
) {
    if state.active_remote_device.is_some() || state.account_remote_context {
        return;
    }
    let Some(current) = state.current_workspace.as_mut() else {
        return;
    };
    if let Ok(Some(record)) =
        crate::service::workspace::legacy_compat::resolve_legacy_workspace_reference(
            workspaces,
            current.workspace_id.as_deref(),
            &current.path,
            current.remote_connection_id.as_deref(),
            current.remote_ssh_host.as_deref(),
        )
    {
        *current = bot_workspace_ref(&record);
    }
}

async fn select_local_workspace(
    state: &mut BotChatState,
    ws_service: &crate::service::workspace::WorkspaceService,
    choice: &BotWorkspaceChoice,
    s: &'static BotStrings,
) -> HandleResult {
    let options = local_pro_workspace_choices(remote_opened_workspace_catalog(ws_service).await);
    let Some(choice) = current_workspace_choice(&options, choice) else {
        let result = show_workspace_choices(state, options, s);
        return workspace_list_changed_result(state, result, s);
    };
    let result = async {
        let id = choice
            .workspace_id
            .as_deref()
            .ok_or_else(|| "Workspace catalog is missing its ID".to_string())?;
        let coordinator = crate::agentic::coordination::get_global_coordinator()
            .ok_or_else(|| "Conversation coordinator not initialized".to_string())?;
        coordinator
            .select_workspace_with_runtime_ownership(ws_service, id)
            .await
            .map_err(|error| error.to_string())
    }
    .await;
    match result {
        Ok(info) => {
            let workspace_path = info.root_path.to_string_lossy().to_string();
            let workspace_ref = bot_workspace_ref(&info);
            state.current_workspace = Some(workspace_ref.clone());
            state.current_session_id = None;
            info!(
                "Bot switched workspace to: {workspace_path} (connection_id={:?}, ssh_host={:?})",
                workspace_ref.remote_connection_id, workspace_ref.remote_ssh_host
            );

            let session_count = count_workspace_sessions_for_ref(&workspace_ref).await;
            let body = format!(
                "{}: {} · {}",
                s.current_workspace_label,
                choice.name,
                fmt_count(s.workspace_session_count_fmt, session_count),
            );
            let mut view = main_menu_view(state, s);
            view = view.with_body(body);
            result_from_menu(state, view)
        }
        Err(e) => result_from_menu(
            state,
            MenuView::plain(format!("{}{e}", s.workspace_open_failed_prefix)),
        ),
    }
}

async fn select_assistant(
    state: &mut BotChatState,
    workspace_id: &str,
    s: &'static BotStrings,
) -> HandleResult {
    use crate::service::workspace::get_global_workspace_service;

    let ws_service = match get_global_workspace_service() {
        Some(svc) => svc,
        None => {
            return result_from_menu(state, MenuView::plain(s.workspace_service_unavailable));
        }
    };
    select_local_assistant(state, &ws_service, workspace_id, s).await
}

async fn select_local_assistant(
    state: &mut BotChatState,
    ws_service: &crate::service::workspace::WorkspaceService,
    workspace_id: &str,
    s: &'static BotStrings,
) -> HandleResult {
    let workspaces = remote_opened_workspace_catalog(ws_service).await;
    let Some(workspace) = workspaces.iter().find(|workspace| {
        workspace.kind == openbitfun_runtime_ports::RemoteWorkspaceKind::Assistant
            && workspace.workspace_id == workspace_id
    }) else {
        let result = start_local_switch(state, ws_service, s).await;
        return workspace_list_changed_result(state, result, s);
    };
    let name = &workspace.name;
    match open_bot_workspace(ws_service, &workspace.workspace_id).await {
        Ok(_info) => {
            state.current_assistant = Some(workspace.path.clone());
            state.current_assistant_id = Some(workspace_id.to_string());
            state.current_assistant_name = Some(name.to_string());
            state.current_session_id = None;
            info!("Bot switched assistant to workspace: {workspace_id}");

            let reference = state.assistant_workspace_ref().expect("selected assistant");
            let session_count = count_workspace_sessions_for_ref(&reference).await;
            let body = format!(
                "{}: {} · {}",
                s.current_assistant_label,
                name,
                fmt_count(s.workspace_session_count_fmt, session_count),
            );
            let mut view = main_menu_view(state, s);
            view = view.with_body(body);
            result_from_menu(state, view)
        }
        Err(e) => result_from_menu(
            state,
            MenuView::plain(format!("{}{e}", s.workspace_open_failed_prefix)),
        ),
    }
}

/// Upgrade-only conversion of persisted bot state; all operations below use ID.
async fn resolve_bot_workspace(
    workspace: &BotWorkspaceRef,
) -> Result<crate::service::workspace::WorkspaceInfo, String> {
    let service = crate::service::workspace::get_global_workspace_service()
        .ok_or_else(|| "Workspace service is unavailable".to_string())?;
    if let Some(id) = workspace.workspace_id.as_deref() {
        return service
            .require_workspace(id)
            .await
            .map_err(|error| error.to_string());
    }
    service
        .resolve_legacy_workspace_reference(
            None,
            &workspace.path,
            workspace.remote_connection_id.as_deref(),
            workspace.remote_ssh_host.as_deref(),
        )
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Workspace ID is unavailable; select a saved workspace".to_string())
}

async fn resolve_bot_session_storage_path_for_ref(
    workspace: &BotWorkspaceRef,
) -> Option<std::path::PathBuf> {
    use crate::agentic::session::CoreSessionStorePort;
    use openbitfun_runtime_ports::SessionStorePort;
    let record = resolve_bot_workspace(workspace).await.ok()?;
    CoreSessionStorePort::default()
        .resolve_workspace_storage(&record.id)
        .await
        .ok()
        .map(|resolution| resolution.effective_storage_path)
}

async fn count_workspace_sessions_for_ref(workspace: &BotWorkspaceRef) -> usize {
    use crate::agentic::persistence::PersistenceManager;
    use crate::infrastructure::PathManager;

    let storage_path = match resolve_bot_session_storage_path_for_ref(workspace).await {
        Some(path) => path,
        None => return 0,
    };
    let pm = match PathManager::new() {
        Ok(pm) => std::sync::Arc::new(pm),
        Err(_) => return 0,
    };
    let store = match PersistenceManager::new(pm) {
        Ok(store) => store,
        Err(_) => return 0,
    };
    store
        .list_session_metadata(&storage_path)
        .await
        .map(|v| v.len())
        .unwrap_or(0)
}

fn truncate_label(label: &str, max_chars: usize) -> String {
    let trimmed = label.trim();
    if trimmed.chars().count() <= max_chars {
        trimmed.to_string()
    } else {
        let truncated: String = trimmed.chars().take(max_chars.saturating_sub(1)).collect();
        format!("{truncated}…")
    }
}

// ── Resume / new session ──────────────────────────────────────────

#[derive(Debug, Clone)]
struct RemoteDeviceWorkspaceFacts {
    /// Record ID reported by the device. A device that reports it accepts
    /// ID-only workspace references; a device that does not is a pre-ID host.
    workspace_id: Option<String>,
    path: String,
    remote_connection_id: Option<String>,
    remote_ssh_host: Option<String>,
}

impl RemoteDeviceWorkspaceFacts {
    /// Workspace fields for a session-level RPC to this device. An ID-aware
    /// device gets only the ID so it can never fall back to the path; a
    /// pre-ID device gets the legacy projection it still understands.
    fn apply_to_command(&self, command: &mut serde_json::Value) {
        let Some(fields) = command.as_object_mut() else {
            return;
        };
        match self.workspace_id.as_deref() {
            Some(workspace_id) => {
                fields.insert(
                    "workspace_id".into(),
                    Value::String(workspace_id.to_string()),
                );
            }
            None => {
                fields.insert("workspace_path".into(), Value::String(self.path.clone()));
                fields.insert(
                    "remote_connection_id".into(),
                    serde_json::to_value(&self.remote_connection_id).unwrap_or(Value::Null),
                );
                fields.insert(
                    "remote_ssh_host".into(),
                    serde_json::to_value(&self.remote_ssh_host).unwrap_or(Value::Null),
                );
            }
        }
    }
}

async fn query_remote_device_workspace(
    state: &BotChatState,
) -> Result<RemoteDeviceWorkspaceFacts, String> {
    let cmd = serde_json::json!({ "cmd": "device_query_info" });
    let cmd_json = serde_json::to_string(&cmd).unwrap_or_default();
    let resp = exec_remote_rpc(state, &cmd_json).await?;
    let val: serde_json::Value = serde_json::from_str(&resp).map_err(|error| error.to_string())?;
    if val.get("resp").and_then(|value| value.as_str()) == Some("error") {
        return Err(val
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("Failed to query remote device workspace")
            .to_string());
    }
    let path = val
        .get("workspace_path")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "No workspace is open on the remote device; select a recent workspace or create one first"
                .to_string()
        })?;
    Ok(RemoteDeviceWorkspaceFacts {
        workspace_id: val
            .get("workspace_id")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        path: path.to_string(),
        remote_connection_id: val
            .get("remote_connection_id")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        remote_ssh_host: val
            .get("remote_ssh_host")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    })
}

async fn start_resume(
    state: &mut BotChatState,
    page: usize,
    s: &'static BotStrings,
) -> HandleResult {
    // ── Remote device branch ──
    if state.active_remote_device.is_some() {
        let workspace = match query_remote_device_workspace(state).await {
            Ok(workspace) => workspace,
            Err(error) => {
                return result_from_menu(
                    state,
                    MenuView::plain(format!("{}{error}", s.session_create_failed_prefix))
                        .with_items(vec![MenuItem::default(s.item_back, "/menu")]),
                );
            }
        };
        let mut cmd = serde_json::json!({
            "cmd": "list_sessions",
            "limit": 10,
            "offset": page * 10,
        });
        workspace.apply_to_command(&mut cmd);
        let cmd_json = serde_json::to_string(&cmd).unwrap_or_default();
        match exec_remote_rpc(state, &cmd_json).await {
            Ok(resp) => {
                let val: serde_json::Value = match serde_json::from_str(&resp) {
                    Ok(v) => v,
                    Err(e) => {
                        return result_from_menu(
                            state,
                            MenuView::plain(format!("{}{e}", s.session_create_failed_prefix)),
                        );
                    }
                };
                if val.get("resp").and_then(|value| value.as_str()) == Some("error") {
                    let message = val
                        .get("message")
                        .and_then(|value| value.as_str())
                        .unwrap_or(s.session_create_failed_prefix);
                    return result_from_menu(
                        state,
                        MenuView::plain(message.to_string())
                            .with_items(vec![MenuItem::default(s.item_back, "/menu")]),
                    );
                }
                let sessions = val
                    .get("sessions")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                let has_more = val
                    .get("has_more")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if sessions.is_empty() {
                    return result_from_menu(state, need_session_view(state, s));
                }
                let mut options: Vec<(String, String)> = Vec::new();
                let mut body = String::new();
                let mut items = Vec::new();
                for (i, sess) in sessions.iter().enumerate() {
                    let sid = sess
                        .get("session_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let name = sess
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or(s.resume_untitled);
                    let agent = sess
                        .get("agent_type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let count = sess
                        .get("message_count")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let msg_hint = match count {
                        0 => s.resume_msg_count_zero.to_string(),
                        1 => s.resume_msg_count_one.to_string(),
                        n => fmt_count(s.resume_msg_count_many_fmt, n as usize),
                    };
                    let is_current = state.current_session_id.as_deref() == Some(sid);
                    let marker = if is_current { s.current_marker } else { "" };
                    body.push_str(&format!(
                        "{}. {}{}\n   {} · {}\n",
                        i + 1,
                        name,
                        marker,
                        agent,
                        msg_hint
                    ));
                    items.push(MenuItem::default(
                        truncate_label(name, 26),
                        (i + 1).to_string(),
                    ));
                    options.push((sid.to_string(), name.to_string()));
                }
                if has_more {
                    items.push(MenuItem::default(s.item_next_page, "0"));
                }
                items.push(MenuItem::default(s.item_back, "/menu"));
                state.set_pending(PendingAction::SelectSession {
                    options,
                    page,
                    has_more,
                });
                let footer = if has_more {
                    s.footer_reply_session_or_next
                } else {
                    s.footer_reply_session
                };
                let dev = state.active_remote_device.as_ref().unwrap();
                let view = MenuView::plain(format!(
                    "{} · {} · #{}",
                    s.resume_page_label,
                    dev.device_name,
                    page + 1
                ))
                .with_numbered_body(body.trim_end().to_string())
                .with_items(items)
                .with_footer(footer);
                return result_from_menu(state, view);
            }
            Err(e) => {
                return result_from_menu(
                    state,
                    MenuView::plain(format!("{}{e}", s.session_create_failed_prefix))
                        .with_items(vec![MenuItem::default(s.item_back, "/menu")]),
                );
            }
        }
    }

    // ── Local branch (original logic) ──
    use crate::agentic::persistence::PersistenceManager;
    use crate::infrastructure::PathManager;

    let workspace_ref = if state.display_mode == BotDisplayMode::Pro {
        match state.current_workspace.clone() {
            Some(workspace) => workspace,
            None => {
                return result_from_menu(
                    state,
                    MenuView::plain(s.no_workspace).with_items(vec![
                        MenuItem::primary(s.item_switch_workspace, "/switch"),
                        MenuItem::default(s.item_back, "/menu"),
                    ]),
                );
            }
        }
    } else {
        match state.assistant_workspace_ref() {
            Some(reference) => reference,
            None => {
                return result_from_menu(
                    state,
                    MenuView::plain(s.no_assistant).with_items(vec![
                        MenuItem::primary(s.item_switch_assistant, "/switch"),
                        MenuItem::default(s.item_back, "/menu"),
                    ]),
                );
            }
        }
    };

    let Some(storage_path) = resolve_bot_session_storage_path_for_ref(&workspace_ref).await else {
        return result_from_menu(
            state,
            MenuView::plain(format!(
                "{}{}",
                s.session_create_failed_prefix,
                "Failed to resolve session storage for the current workspace"
            )),
        );
    };

    let page_size = 10usize;
    let offset = page * page_size;

    let pm = match PathManager::new() {
        Ok(pm) => std::sync::Arc::new(pm),
        Err(e) => {
            return result_from_menu(
                state,
                MenuView::plain(format!("{}{e}", s.session_create_failed_prefix)),
            );
        }
    };
    let store = match PersistenceManager::new(pm) {
        Ok(store) => store,
        Err(e) => {
            return result_from_menu(
                state,
                MenuView::plain(format!("{}{e}", s.session_create_failed_prefix)),
            );
        }
    };
    let all_meta = match store.list_session_metadata(&storage_path).await {
        Ok(m) => m,
        Err(e) => {
            return result_from_menu(
                state,
                MenuView::plain(format!("{}{e}", s.session_create_failed_prefix)),
            );
        }
    };

    if all_meta.is_empty() {
        return result_from_menu(state, need_session_view(state, s));
    }

    let total = all_meta.len();
    let has_more = offset + page_size < total;
    let sessions: Vec<_> = all_meta.into_iter().skip(offset).take(page_size).collect();

    let mut body = String::new();
    let mut items = Vec::new();
    let mut options = Vec::new();
    for (i, sess) in sessions.iter().enumerate() {
        let is_current = state.current_session_id.as_deref() == Some(&sess.session_id);
        let marker = if is_current { s.current_marker } else { "" };
        let ts = chrono::DateTime::from_timestamp(sess.last_active_at as i64 / 1000, 0)
            .map(|dt| dt.format("%m-%d %H:%M").to_string())
            .unwrap_or_default();
        let msg_hint = match sess.turn_count {
            0 => s.resume_msg_count_zero.to_string(),
            1 => s.resume_msg_count_one.to_string(),
            n => fmt_count(s.resume_msg_count_many_fmt, n),
        };
        body.push_str(&format!(
            "{}. [{}] {}{}\n   {} · {}\n",
            i + 1,
            sess.agent_type,
            sess.session_name,
            marker,
            ts,
            msg_hint,
        ));
        items.push(MenuItem::default(
            truncate_label(&format!("[{}] {}", sess.agent_type, sess.session_name), 26),
            (i + 1).to_string(),
        ));
        options.push((sess.session_id.clone(), sess.session_name.clone()));
    }
    if has_more {
        items.push(MenuItem::default(s.item_next_page, "0"));
    }
    items.push(MenuItem::default(s.item_back, "/menu"));

    state.set_pending(PendingAction::SelectSession {
        options,
        page,
        has_more,
    });

    let footer = if has_more {
        s.footer_reply_session_or_next
    } else {
        s.footer_reply_session
    };
    let view = MenuView::plain(format!("{} · #{}", s.resume_page_label, page + 1))
        .with_numbered_body(body.trim_end().to_string())
        .with_items(items)
        .with_footer(footer);
    result_from_menu(state, view)
}

async fn select_session(
    state: &mut BotChatState,
    session_id: &str,
    session_name: &str,
    s: &'static BotStrings,
) -> HandleResult {
    state.current_session_id = Some(session_id.to_string());
    info!("Bot resumed session: {session_id}");

    let last_pair =
        load_last_dialog_pair_from_turns(state.current_workspace.as_ref(), session_id).await;
    let mut body = format!("{}{}\n", s.resume_resumed_prefix, session_name);
    if let Some((user_text, ai_text)) = last_pair {
        body.push('\n');
        body.push_str(s.resume_last_dialog_header);
        body.push('\n');
        body.push_str(&format!("{}: {}\n\n", s.resume_you_label, user_text));
        body.push_str(&format!("AI: {}\n\n", ai_text));
        body.push_str(s.resume_continue_hint);
    } else {
        body.push('\n');
        body.push_str(s.resume_first_message_hint);
    }

    // Resumed session leaves the user ready to chat — show no menu so the
    // chat surface stays uncluttered.
    let view = MenuView::plain("").with_body(body);
    result_from_menu(state, view)
}

async fn load_last_dialog_pair_from_turns(
    workspace: Option<&BotWorkspaceRef>,
    session_id: &str,
) -> Option<(String, String)> {
    const MAX_USER_LEN: usize = 200;
    const MAX_AI_LEN: usize = 400;

    let workspace = workspace?;
    let storage_path = resolve_bot_session_storage_path_for_ref(workspace).await?;
    let coordinator = crate::agentic::coordination::get_global_coordinator()?;
    let turns = coordinator
        .load_visible_persisted_session_turns(&storage_path, session_id)
        .await
        .ok()?;
    let turn = turns.last()?;

    let user_text = strip_user_message_tags(&turn.user_message.content);
    if user_text.is_empty() {
        return None;
    }

    let mut ai_text = String::new();
    for round in &turn.model_rounds {
        for t in &round.text_items {
            if t.is_subagent_item.unwrap_or(false) {
                continue;
            }
            if !t.content.is_empty() {
                if !ai_text.is_empty() {
                    ai_text.push('\n');
                }
                ai_text.push_str(&t.content);
            }
        }
    }
    if ai_text.is_empty() {
        return None;
    }
    Some((
        truncate_text(&user_text, MAX_USER_LEN),
        truncate_text(&ai_text, MAX_AI_LEN),
    ))
}

fn strip_user_message_tags(raw: &str) -> String {
    crate::agentic::core::strip_prompt_markup(raw)
}

fn truncate_text(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        trimmed.to_string()
    } else {
        let truncated: String = trimmed.chars().take(max_chars).collect();
        format!("{truncated}…")
    }
}

async fn new_session_for_mode(state: &mut BotChatState, s: &'static BotStrings) -> HandleResult {
    let agent_type = if state.display_mode == BotDisplayMode::Pro {
        "Standard"
    } else {
        "Claw"
    };
    guarded_new(state, agent_type, s).await
}

async fn guarded_new(
    state: &mut BotChatState,
    agent_type: &str,
    s: &'static BotStrings,
) -> HandleResult {
    let needs_pro = matches!(agent_type, "Standard" | "Cowork");
    let needs_assistant = matches!(agent_type, "Claw");

    if needs_pro && state.display_mode != BotDisplayMode::Pro {
        let target_cmd = match agent_type {
            "Standard" => "/new_code_session",
            "Cowork" => "/new_cowork_session",
            _ => "/new_code_session",
        };
        return confirm_then_run(state, BotDisplayMode::Pro, target_cmd.to_string(), s).await;
    }
    if needs_assistant && state.display_mode != BotDisplayMode::Assistant {
        return confirm_then_run(
            state,
            BotDisplayMode::Assistant,
            "/new_claw_session".to_string(),
            s,
        )
        .await;
    }
    if needs_pro && state.current_workspace.is_none() && state.active_remote_device.is_none() {
        return result_from_menu(
            state,
            MenuView::plain(s.no_workspace).with_items(vec![
                MenuItem::primary(s.item_switch_workspace, "/switch"),
                MenuItem::default(s.item_back, "/menu"),
            ]),
        );
    }
    create_session(state, agent_type).await
}

async fn create_session(state: &mut BotChatState, agent_type: &str) -> HandleResult {
    let language = current_bot_language().await;
    let s = strings_for(language);

    // ── Remote device branch ──
    // When switched to a remote device, create the session there via RPC.
    if state.active_remote_device.is_some() {
        let session_name = if language.is_chinese() {
            "远程会话"
        } else {
            "Remote Session"
        };
        let workspace = match query_remote_device_workspace(state).await {
            Ok(workspace) => workspace,
            Err(error) => {
                return result_from_menu(
                    state,
                    MenuView::plain(format!("{}{error}", s.session_create_failed_prefix))
                        .with_items(vec![MenuItem::default(s.item_back, "/menu")]),
                );
            }
        };
        let mut cmd = serde_json::json!({
            "cmd": "create_session",
            "agent_type": agent_type,
            "session_name": session_name,
        });
        workspace.apply_to_command(&mut cmd);
        let cmd_json = serde_json::to_string(&cmd).unwrap_or_default();
        match exec_remote_rpc(state, &cmd_json).await {
            Ok(resp) => {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&resp) {
                    if val.get("resp").and_then(|value| value.as_str()) == Some("error") {
                        let message = val
                            .get("message")
                            .and_then(|value| value.as_str())
                            .unwrap_or(s.session_create_failed_prefix);
                        return result_from_menu(
                            state,
                            MenuView::plain(message.to_string())
                                .with_items(vec![MenuItem::default(s.item_back, "/menu")]),
                        );
                    }
                    if let Some(sid) = val.get("session_id").and_then(|v| v.as_str()) {
                        state.current_session_id = Some(sid.to_string());
                        let body = format!(
                            "{}{}\n\n{}",
                            s.session_created_prefix, session_name, s.session_start_hint
                        );
                        let dev = state.active_remote_device.as_ref().unwrap();
                        let view = MenuView::plain("").with_body(format!(
                            "{}: {}\n{}",
                            s.devices_remote_prefix, dev.device_name, body
                        ));
                        return result_from_menu(state, view);
                    }
                }
                return result_from_menu(state, MenuView::plain(s.session_create_failed_prefix));
            }
            Err(e) => {
                return result_from_menu(
                    state,
                    MenuView::plain(format!("{}{e}", s.session_create_failed_prefix))
                        .with_items(vec![MenuItem::default(s.item_back, "/menu")]),
                );
            }
        }
    }

    // ── Local branch (original logic) ──
    use crate::agentic::coordination::get_global_coordinator;
    use crate::service::workspace::get_global_workspace_service;
    use crate::service_agent_runtime::CoreServiceAgentRuntime;
    use openbitfun_runtime_ports::RemoteSessionWorkspaceIdentity;
    use openbitfun_services_integrations::remote_connect::{
        build_remote_session_create_request, RemoteConnectSubmissionSource,
    };

    let is_claw = agent_type == "Claw";

    let coordinator = match get_global_coordinator() {
        Some(c) => c,
        None => {
            return result_from_menu(state, MenuView::plain(s.session_system_unavailable));
        }
    };

    let workspace_ref = if is_claw {
        if let Some(reference) = state.assistant_workspace_ref() {
            Some(reference)
        } else {
            let ws_service = match get_global_workspace_service() {
                Some(s) => s,
                None => {
                    return result_from_menu(
                        state,
                        MenuView::plain(s.workspace_service_unavailable),
                    );
                }
            };
            let resolved: Option<(String, String, String)> =
                if let Some(primary_ws) = ws_service.get_primary_assistant_workspace().await {
                    Some((
                        primary_ws.id.clone(),
                        primary_ws.root_path.to_string_lossy().to_string(),
                        remote_workspace_display_name(&primary_ws).to_string(),
                    ))
                } else {
                    match ws_service.create_assistant_workspace(None).await {
                        Ok(ws_info) => Some((
                            ws_info.id.clone(),
                            ws_info.root_path.to_string_lossy().to_string(),
                            remote_workspace_display_name(&ws_info).to_string(),
                        )),
                        Err(e) => {
                            return result_from_menu(
                                state,
                                MenuView::plain(format!("{}{e}", s.assistant_create_failed_prefix)),
                            );
                        }
                    }
                };
            if let Some((ref id, ref path, ref name)) = resolved {
                state.current_assistant_id = Some(id.clone());
                state.current_assistant = Some(path.clone());
                state.current_assistant_name = Some(name.clone());
            }
            resolved.map(|(id, path, _)| {
                let mut reference = BotWorkspaceRef::local(path);
                reference.workspace_id = Some(id);
                reference
            })
        }
    } else {
        state.current_workspace.clone()
    };

    let session_name = match agent_type {
        "Cowork" => {
            if language.is_chinese() {
                "远程协作会话"
            } else {
                "Remote Cowork Session"
            }
        }
        "Claw" => {
            if language.is_chinese() {
                "远程助理会话"
            } else {
                "Remote Claw Session"
            }
        }
        _ => {
            if language.is_chinese() {
                "远程编码会话"
            } else {
                "Remote Code Session"
            }
        }
    };

    let Some(workspace_ref) = workspace_ref else {
        let view = if is_claw {
            MenuView::plain(s.no_assistant).with_items(vec![
                MenuItem::primary(s.item_switch_assistant, "/switch"),
                MenuItem::default(s.item_back, "/menu"),
            ])
        } else {
            MenuView::plain(s.no_workspace).with_items(vec![
                MenuItem::primary(s.item_switch_workspace, "/switch"),
                MenuItem::default(s.item_back, "/menu"),
            ])
        };
        return result_from_menu(state, view);
    };

    let record = match resolve_bot_workspace(&workspace_ref).await {
        Ok(record) => record,
        Err(error) => {
            return result_from_menu(
                state,
                MenuView::plain(format!("{}{}", s.session_create_failed_prefix, error)),
            )
        }
    };
    let identity = bot_workspace_ref(&record);
    let request = build_remote_session_create_request(
        session_name,
        agent_type,
        Some(record.root_path.to_string_lossy().into_owned()),
        RemoteSessionWorkspaceIdentity::new(
            identity.remote_connection_id,
            identity.remote_ssh_host,
        )
        .with_workspace_id(Some(record.id)),
        RemoteConnectSubmissionSource::Bot,
    );
    let runtime = match CoreServiceAgentRuntime::agent_runtime(coordinator.clone()) {
        Ok(runtime) => runtime,
        Err(error) => {
            return result_from_menu(
                state,
                MenuView::plain(format!("{}{}", s.session_create_failed_prefix, error)),
            );
        }
    };
    match runtime.create_session(request).await {
        Ok(session) => {
            state.current_session_id = Some(session.session_id.clone());
            let body = format!(
                "{}{}\n{}{}\n\n{}",
                s.session_created_prefix,
                session_name,
                s.session_workspace_label,
                if is_claw {
                    state
                        .current_assistant_name
                        .clone()
                        .unwrap_or_else(|| short_path_name(&workspace_ref.path))
                } else {
                    short_path_name(&workspace_ref.path)
                },
                s.session_start_hint,
            );
            let view = MenuView::plain("").with_body(body);
            result_from_menu(state, view)
        }
        Err(e) => result_from_menu(
            state,
            MenuView::plain(format!(
                "{}{}",
                s.session_create_failed_prefix,
                CoreServiceAgentRuntime::runtime_error_message(e)
            )),
        ),
    }
}

// ── Cancel ─────────────────────────────────────────────────────────

async fn handle_cancel_task(
    state: &mut BotChatState,
    requested_turn_id: Option<&str>,
    s: &'static BotStrings,
) -> HandleResult {
    use crate::service::remote_connect::remote_server::get_or_init_global_dispatcher;

    let session_id = match state.current_session_id.clone() {
        Some(id) => id,
        None => {
            return result_from_menu(state, MenuView::plain(s.task_no_active));
        }
    };
    if state.active_remote_device.is_some() {
        let command = serde_json::json!({"cmd":"cancel_task","session_id":session_id,"turn_id":requested_turn_id});
        return match exec_remote_rpc(state, &command.to_string()).await {
            Ok(reply)
                if serde_json::from_str::<Value>(&reply)
                    .ok()
                    .is_some_and(|v| v["resp"] == "task_cancelled") =>
            {
                state.clear_pending();
                result_from_menu(state, MenuView::plain(s.task_cancel_requested))
            }
            result => result_from_menu(
                state,
                MenuView::plain(format!(
                    "{}{}",
                    s.task_cancel_failed_prefix,
                    result
                        .err()
                        .unwrap_or_else(|| "Remote cancellation was not accepted".into())
                )),
            ),
        };
    }
    let dispatcher = get_or_init_global_dispatcher();
    match dispatcher.cancel_task(&session_id, requested_turn_id).await {
        Ok(_) => {
            state.clear_pending();
            result_from_menu(state, MenuView::plain(s.task_cancel_requested))
        }
        Err(e) => result_from_menu(
            state,
            MenuView::plain(format!("{}{e}", s.task_cancel_failed_prefix)),
        ),
    }
}

// ── Numeric reply routing ─────────────────────────────────────────

async fn handle_number(state: &mut BotChatState, n: usize, s: &'static BotStrings) -> HandleResult {
    if let Some(pending) = state.pending_action.clone() {
        return route_pending(state, pending, &n.to_string(), s).await;
    }
    // No pending action: 0 always returns to main menu.
    if n == 0 {
        return menu_or_welcome(state, s);
    }
    if n >= 1 && n <= state.last_menu_commands.len() {
        let cmd_str = state.last_menu_commands[n - 1].clone();
        let next_cmd = parse_command(&cmd_str);
        return Box::pin(dispatch(state, next_cmd, vec![])).await;
    }
    handle_chat(state, &n.to_string(), vec![], s).await
}

async fn route_pending(
    state: &mut BotChatState,
    pending: PendingAction,
    raw_input: &str,
    s: &'static BotStrings,
) -> HandleResult {
    match pending {
        PendingAction::ConfirmRemoteTool {
            tool_id,
            action_token,
            description: _,
        } => {
            let command = match raw_input.trim() {
                input if input == "1" || input == format!("approve-tool:{action_token}") => {
                    serde_json::json!({"cmd":"confirm_tool","tool_id":tool_id})
                }
                input if input == "2" || input == format!("reject-tool:{action_token}") => {
                    serde_json::json!({"cmd":"reject_tool","tool_id":tool_id,"reason":"Rejected by bot user"})
                }
                _ => return Box::pin(pending_invalid(state, s)).await,
            };
            let Some(target) = state.pending_remote_target.clone() else {
                state.clear_pending();
                return result_from_menu(state, MenuView::plain(s.devices_account_required));
            };
            match target.rpc(command).await {
                Ok(reply) if reply["resp"] == "interaction_accepted" => {
                    finish_bot_interaction(state, s)
                }
                result => result_from_menu(
                    state,
                    MenuView::plain(format!(
                        "{}{}",
                        s.answers_submit_failed_prefix,
                        result
                            .err()
                            .unwrap_or_else(|| "Invalid remote interaction response".into())
                    )),
                ),
            }
        }
        PendingAction::SelectWorkspace { options } => {
            let parsed: Option<usize> = raw_input.parse().ok();
            match parsed {
                Some(0) => {
                    state.clear_pending();
                    menu_or_welcome(state, s)
                }
                Some(n) if n >= 1 && n <= options.len() => {
                    state.clear_pending();
                    let choice = options[n - 1].clone();
                    select_workspace(state, &choice, s).await
                }
                _ => {
                    state.set_pending(PendingAction::SelectWorkspace { options });
                    Box::pin(pending_invalid(state, s)).await
                }
            }
        }
        PendingAction::SelectAssistant { options } => {
            let parsed: Option<usize> = raw_input.parse().ok();
            match parsed {
                Some(0) => {
                    state.clear_pending();
                    menu_or_welcome(state, s)
                }
                Some(n) if n >= 1 && n <= options.len() => {
                    state.clear_pending();
                    let (path, _) = &options[n - 1];
                    select_assistant(state, path, s).await
                }
                _ => {
                    state.set_pending(PendingAction::SelectAssistant { options });
                    Box::pin(pending_invalid(state, s)).await
                }
            }
        }
        PendingAction::SelectSession {
            options,
            page,
            has_more,
        } => {
            let parsed: Option<usize> = raw_input.parse().ok();
            match parsed {
                Some(0) if has_more => {
                    state.clear_pending();
                    start_resume(state, page + 1, s).await
                }
                Some(0) => {
                    state.clear_pending();
                    menu_or_welcome(state, s)
                }
                Some(n) if n >= 1 && n <= options.len() => {
                    state.clear_pending();
                    let (id, name) = options[n - 1].clone();
                    select_session(state, &id, &name, s).await
                }
                _ => {
                    state.set_pending(PendingAction::SelectSession {
                        options,
                        page,
                        has_more,
                    });
                    Box::pin(pending_invalid(state, s)).await
                }
            }
        }
        PendingAction::AskUserQuestion {
            tool_id,
            questions,
            current_index,
            answers,
            awaiting_custom_text,
            pending_answer,
        } => {
            handle_question_reply(
                state,
                tool_id,
                questions,
                current_index,
                answers,
                awaiting_custom_text,
                pending_answer,
                raw_input,
                s,
            )
            .await
        }
        PendingAction::SelectModel { options } => {
            let parsed: Option<usize> = raw_input.parse().ok();
            match parsed {
                Some(0) => {
                    state.clear_pending();
                    menu_or_welcome(state, s)
                }
                Some(1) => {
                    state.clear_pending();
                    select_model(state, "primary", s.switch_model_primary, s).await
                }
                Some(n) if n >= 2 && n <= options.len() + 1 => {
                    state.clear_pending();
                    let (model_id, model_name) = options[n - 2].clone();
                    select_model(state, &model_id, &model_name, s).await
                }
                _ => {
                    state.set_pending(PendingAction::SelectModel { options });
                    Box::pin(pending_invalid(state, s)).await
                }
            }
        }
        PendingAction::ConfirmModeSwitch {
            target_mode,
            target_cmd,
        } => {
            let parsed: Option<usize> = raw_input.parse().ok();
            match parsed {
                Some(1) => {
                    state.clear_pending();
                    state.display_mode = target_mode;
                    let next_cmd = parse_command(&target_cmd);
                    Box::pin(dispatch(state, next_cmd, vec![])).await
                }
                Some(0) => {
                    state.clear_pending();
                    menu_or_welcome(state, s)
                }
                _ => {
                    state.set_pending(PendingAction::ConfirmModeSwitch {
                        target_mode,
                        target_cmd,
                    });
                    Box::pin(pending_invalid(state, s)).await
                }
            }
        }
        PendingAction::SelectDevice { options } => {
            let parsed: Option<usize> = raw_input.parse().ok();
            match parsed {
                Some(n) if n >= 1 && n <= options.len() => {
                    state.clear_pending();
                    let (device_id, device_name) = options[n - 1].clone();
                    if device_id == "local" {
                        // Switch back to local
                        state.select_local_device();
                        let body = s.devices_switched_local.to_string();
                        let mut view = main_menu_view(state, s);
                        view = view.with_body(body);
                        result_from_menu(state, view)
                    } else {
                        // Switch to remote device
                        state.select_remote_device(
                            crate::service::remote_connect::bot::RemoteDeviceTarget {
                                device_id: device_id.clone(),
                                device_name: device_name.clone(),
                            },
                        );
                        let body = format!("{}: {}", s.devices_switched_to, device_name);
                        let mut view = main_menu_view(state, s);
                        view = view.with_body(body);
                        result_from_menu(state, view)
                    }
                }
                Some(0) | None => {
                    state.clear_pending();
                    menu_or_welcome(state, s)
                }
                _ => {
                    state.set_pending(PendingAction::SelectDevice { options });
                    Box::pin(pending_invalid(state, s)).await
                }
            }
        }
    }
}

/// Re-show the current pending view with an "invalid input" prefix so the
/// user retains context.  After [`PENDING_INVALID_LIMIT`] consecutive invalid
/// replies the pending state is cleared and the user is returned to the main
/// menu.
async fn pending_invalid(state: &mut BotChatState, s: &'static BotStrings) -> HandleResult {
    state.pending_invalid_count = state.pending_invalid_count.saturating_add(1);
    if state.pending_invalid_count >= PENDING_INVALID_LIMIT {
        state.clear_pending();
        let mut view = main_menu_view(state, s);
        view = view.with_body(s.pending_invalid_after_retries);
        return result_from_menu(state, view);
    }
    // Re-render the pending prompt with an invalid-input notice so the user
    // sees the option list again instead of just an opaque error.
    let pending = match state.pending_action.clone() {
        Some(p) => p,
        None => {
            return result_from_menu(state, main_menu_view(state, s));
        }
    };
    let mut view = match &pending {
        PendingAction::ConfirmRemoteTool {
            action_token,
            description,
            ..
        } => remote_tool_view(action_token, description, s),
        PendingAction::SelectWorkspace { options } => workspace_selection_view(state, options, s),
        PendingAction::SelectAssistant { options } => assistant_selection_view(state, options, s),
        PendingAction::SelectSession {
            options,
            page,
            has_more,
        } => session_selection_view(state, options, *page, *has_more, s),
        PendingAction::AskUserQuestion {
            questions,
            current_index,
            awaiting_custom_text,
            ..
        } => build_question_view(s, questions, *current_index, *awaiting_custom_text),
        PendingAction::SelectModel { options } => model_selection_view(&None, options, s),
        PendingAction::ConfirmModeSwitch { target_mode, .. } => {
            confirm_mode_switch_view(*target_mode, s)
        }
        PendingAction::SelectDevice { options } => device_selection_view(state, options, s),
    };
    let original_body = view.body.take().unwrap_or_default();
    let new_body = if original_body.is_empty() {
        s.pending_invalid_input.to_string()
    } else {
        format!("{}\n\n{}", s.pending_invalid_input, original_body)
    };
    view = view.with_body(new_body);
    result_from_menu(state, view)
}

// ── Question handling ─────────────────────────────────────────────

fn question_option_line(index: usize, option: &BotQuestionOption) -> String {
    if option.description.is_empty() {
        format!("{}. {}", index + 1, option.label)
    } else {
        format!("{}. {} - {}", index + 1, option.label, option.description)
    }
}

fn build_question_view(
    s: &'static BotStrings,
    questions: &[BotQuestion],
    current_index: usize,
    awaiting_custom_text: bool,
) -> MenuView {
    let question = &questions[current_index];
    let title = format!(
        "{} {}/{}",
        s.question_title,
        current_index + 1,
        questions.len()
    );

    let mut body = String::new();
    if !question.header.is_empty() {
        body.push_str(&question.header);
        body.push('\n');
    }
    body.push_str(&question.question);
    body.push_str("\n\n");
    for (idx, option) in question.options.iter().enumerate() {
        body.push_str(&question_option_line(idx, option));
        body.push('\n');
    }
    body.push_str(&format!(
        "{}. {}\n",
        question.options.len() + 1,
        s.item_other,
    ));

    let footer = if awaiting_custom_text {
        s.footer_question_custom
    } else if question.multi_select {
        s.footer_question_multi
    } else {
        s.footer_question_single
    };

    let mut items: Vec<MenuItem> = Vec::new();
    if !awaiting_custom_text && !question.multi_select {
        for (idx, option) in question.options.iter().enumerate() {
            items.push(MenuItem::default(
                truncate_label(&option.label, 24),
                (idx + 1).to_string(),
            ));
        }
        items.push(MenuItem::default(
            s.item_other,
            (question.options.len() + 1).to_string(),
        ));
    }
    items.push(MenuItem::default(s.item_back, "/menu"));

    MenuView::plain(title)
        .with_numbered_body(body.trim_end().to_string())
        .with_items(items)
        .with_footer(footer)
}

fn parse_question_numbers(input: &str) -> Option<Vec<usize>> {
    let mut result = Vec::new();
    for part in input.split(',') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value = trimmed.parse::<usize>().ok()?;
        result.push(value);
    }
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_question_reply(
    state: &mut BotChatState,
    tool_id: String,
    questions: Vec<BotQuestion>,
    current_index: usize,
    answers: Vec<Value>,
    awaiting_custom_text: bool,
    pending_answer: Option<Value>,
    message: &str,
    s: &'static BotStrings,
) -> HandleResult {
    let interaction = if let Some(target) = state.pending_remote_target.as_ref() {
        target.start_question_interaction(&tool_id).await
    } else if let Some(session_id) = state.current_session_id.as_deref() {
        crate::agentic::tools::user_input_manager::get_user_input_manager()
            .start_interaction(session_id, &tool_id)
            .map_err(|error| error.to_string())
    } else {
        Err("Question has no associated session".into())
    };
    let mut result = handle_question_reply_after_interaction(
        state,
        tool_id,
        questions,
        current_index,
        answers,
        awaiting_custom_text,
        pending_answer,
        message,
        s,
    )
    .await;
    if let Err(error) = interaction {
        if matches!(
            state.pending_action,
            Some(PendingAction::AskUserQuestion { .. })
        ) {
            let warning = format!("Question timeout could not be stopped: {error}");
            result.reply = format!("{warning}\n\n{}", result.reply);
            result.menu = result.menu.with_body(result.reply.clone());
        }
    }
    result
}

async fn handle_question_reply_after_interaction(
    state: &mut BotChatState,
    tool_id: String,
    questions: Vec<BotQuestion>,
    current_index: usize,
    mut answers: Vec<Value>,
    awaiting_custom_text: bool,
    pending_answer: Option<Value>,
    message: &str,
    s: &'static BotStrings,
) -> HandleResult {
    let Some(question) = questions.get(current_index).cloned() else {
        return result_from_menu(state, MenuView::plain(s.question_invalid_state));
    };

    if awaiting_custom_text {
        let custom_text = message.trim();
        if custom_text.is_empty() {
            state.set_pending(PendingAction::AskUserQuestion {
                tool_id,
                questions,
                current_index,
                answers,
                awaiting_custom_text: true,
                pending_answer,
            });
            return result_from_menu(state, MenuView::plain(s.question_custom_required));
        }
        let final_value = match pending_answer {
            Some(Value::Array(existing)) => {
                let mut values: Vec<Value> = existing
                    .into_iter()
                    .filter(|v| v.as_str() != Some("Other"))
                    .collect();
                values.push(Value::String(custom_text.to_string()));
                Value::Array(values)
            }
            _ => Value::String(custom_text.to_string()),
        };
        answers.push(final_value);
    } else {
        let selections = match parse_question_numbers(message) {
            Some(values) => values,
            None => {
                state.set_pending(PendingAction::AskUserQuestion {
                    tool_id,
                    questions,
                    current_index,
                    answers,
                    awaiting_custom_text: false,
                    pending_answer: None,
                });
                return Box::pin(pending_invalid(state, s)).await;
            }
        };
        if !question.multi_select && selections.len() != 1 {
            state.set_pending(PendingAction::AskUserQuestion {
                tool_id,
                questions,
                current_index,
                answers,
                awaiting_custom_text: false,
                pending_answer: None,
            });
            return Box::pin(pending_invalid(state, s)).await;
        }
        let other_index = question.options.len() + 1;
        let mut labels = Vec::new();
        let mut includes_other = false;
        for selection in selections {
            if selection == other_index {
                includes_other = true;
                labels.push(Value::String(s.item_other.to_string()));
            } else if selection >= 1 && selection <= question.options.len() {
                labels.push(Value::String(question.options[selection - 1].label.clone()));
            } else {
                state.set_pending(PendingAction::AskUserQuestion {
                    tool_id,
                    questions,
                    current_index,
                    answers,
                    awaiting_custom_text: false,
                    pending_answer: None,
                });
                let _ = other_index;
                return Box::pin(pending_invalid(state, s)).await;
            }
        }
        let pending_answer_next = if question.multi_select {
            Some(Value::Array(labels.clone()))
        } else {
            labels.into_iter().next()
        };
        if includes_other {
            state.set_pending(PendingAction::AskUserQuestion {
                tool_id,
                questions,
                current_index,
                answers,
                awaiting_custom_text: true,
                pending_answer: pending_answer_next,
            });
            return result_from_menu(state, MenuView::plain(s.question_custom_for_other_prefix));
        }
        answers.push(if question.multi_select {
            pending_answer_next.unwrap_or_else(|| Value::Array(Vec::new()))
        } else {
            pending_answer_next.unwrap_or_else(|| Value::String(String::new()))
        });
    }

    if current_index + 1 < questions.len() {
        let view = build_question_view(s, &questions, current_index + 1, false);
        state.set_pending(PendingAction::AskUserQuestion {
            tool_id,
            questions,
            current_index: current_index + 1,
            answers,
            awaiting_custom_text: false,
            pending_answer: None,
        });
        return result_from_menu(state, view);
    }

    if let Some(target) = state.pending_remote_target.clone() {
        let payload: serde_json::Map<String, Value> = answers
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect();
        match target
            .rpc(serde_json::json!({"cmd":"answer_question","tool_id":tool_id,"answers":payload}))
            .await
        {
            Ok(reply)
                if reply["resp"] == "answer_accepted"
                    || reply["resp"] == "interaction_accepted" =>
            {
                return finish_bot_interaction(state, s);
            }
            result => {
                return result_from_menu(
                    state,
                    MenuView::plain(format!(
                        "{}{}",
                        s.answers_submit_failed_prefix,
                        result
                            .err()
                            .unwrap_or_else(|| "Invalid remote answer response".into())
                    )),
                )
            }
        }
    }
    let result = submit_question_answers(&tool_id, &answers, s).await;
    if result.reply == s.answers_submitted {
        finish_bot_interaction(state, s)
    } else {
        result
    }
}

async fn submit_question_answers(
    tool_id: &str,
    answers: &[Value],
    s: &'static BotStrings,
) -> HandleResult {
    use crate::agentic::tools::user_input_manager::get_user_input_manager;

    let mut payload = serde_json::Map::new();
    for (idx, value) in answers.iter().enumerate() {
        payload.insert(idx.to_string(), value.clone());
    }
    let manager = get_user_input_manager();
    match manager.send_answer(tool_id, Value::Object(payload)) {
        Ok(_) => HandleResult {
            reply: s.answers_submitted.to_string(),
            actions: vec![],
            forward_to_session: None,
            menu: MenuView::plain(s.answers_submitted),
        },
        Err(e) => HandleResult {
            reply: format!("{}{e}", s.answers_submit_failed_prefix),
            actions: vec![],
            forward_to_session: None,
            menu: MenuView::plain(format!("{}{e}", s.answers_submit_failed_prefix)),
        },
    }
}

// ── Free-form chat handling ───────────────────────────────────────

/// Look up the agent type a session was created with (e.g. "Claw", "Cowork",
/// "Standard").  Returns `None` if the coordinator is unavailable or the
/// session is not currently hot in memory; in that case `send_message` will
/// lazily restore the session from disk and `resolve_agent_type` falls back
/// to the safe default ("Standard"), so chat keeps working.
async fn resolve_session_agent_type(session_id: &str) -> Option<String> {
    use crate::agentic::coordination::get_global_coordinator;
    use crate::service_agent_runtime::CoreServiceAgentRuntime;

    let coordinator = get_global_coordinator()?;
    let runtime = CoreServiceAgentRuntime::agent_runtime(coordinator).ok()?;
    runtime
        .resolve_session_agent_type(session_id)
        .await
        .ok()
        .flatten()
}

async fn handle_chat(
    state: &mut BotChatState,
    message: &str,
    image_contexts: Vec<crate::agentic::image_analysis::ImageContextData>,
    s: &'static BotStrings,
) -> HandleResult {
    if message.starts_with("approve-tool:") || message.starts_with("reject-tool:") {
        let matches_pending = state
            .pending_action
            .as_ref()
            .is_some_and(|pending| match pending {
                PendingAction::ConfirmRemoteTool { action_token, .. } => {
                    message == format!("approve-tool:{action_token}")
                        || message == format!("reject-tool:{action_token}")
                }
                _ => false,
            });
        if !matches_pending {
            return result_from_menu(state, MenuView::plain(s.pending_invalid_input));
        }
    }
    // If there is a pending action, route the message to it (text answer for
    // questions, "ignore" for menu-style pendings).
    if let Some(pending) = state.pending_action.clone() {
        return route_pending(state, pending, message, s).await;
    }

    // ── Remote device branch ──
    // When switched to a remote device, send the message via RPC.
    if state.active_remote_device.is_some() {
        let session_id = match state.current_session_id.clone() {
            Some(id) => id,
            None => return result_from_menu(state, need_session_view(state, s)),
        };
        let Some(account) = delegated_session(state) else {
            return result_from_menu(state, devices_unavailable_view(s));
        };
        let Some(relay_url) = state.relay_url.clone() else {
            return result_from_menu(state, devices_unavailable_view(s));
        };
        let device = state.active_remote_device.as_ref().unwrap();
        let remote_target = RemoteBotTarget {
            relay_url,
            account,
            session_id: session_id.clone(),
            device_id: device.device_id.clone(),
            device_name: device.device_name.clone(),
        };
        let forward = ForwardRequest {
            remote_target: Some(remote_target),
            session_id,
            content: message.to_string(),
            agent_type: String::new(),
            turn_id: format!("turn_{}", uuid::Uuid::new_v4()),
            image_contexts,
        };
        result_from_menu_with_forward(state, MenuView::default(), Some(forward))
    } else {
        // ── Local branch (original logic) ──

        if state.display_mode == BotDisplayMode::Pro && state.current_workspace.is_none() {
            return result_from_menu(
                state,
                MenuView::plain(s.no_workspace).with_items(vec![
                    MenuItem::primary(s.item_switch_workspace, "/switch"),
                    MenuItem::default(s.item_back, "/menu"),
                ]),
            );
        }
        if state.current_session_id.is_none() {
            return result_from_menu(state, need_session_view(state, s));
        }

        let session_id = state.current_session_id.clone().unwrap();
        let turn_id = format!("turn_{}", uuid::Uuid::new_v4());

        // Pick the agent type from the actual session — NOT a hardcoded
        // "Standard" — otherwise every chat message goes through the Code
        // (`agentic`) agent regardless of what kind of session was created.
        // Concretely: the IM pairing bootstrap creates a `Claw` session for
        // assistant mode, but the old hardcoded value caused all subsequent
        // messages to be re-routed to the Code agent and the assistant flow
        // was effectively bypassed.  We mirror the agent type the session was
        // actually created with, falling back to "Standard" only if the session
        // is missing in memory (e.g. needs lazy restore — `send_message` will
        // also normalize via `resolve_agent_type`).
        let agent_type = resolve_session_agent_type(&session_id)
            .await
            .unwrap_or_else(|| "Standard".to_string());

        // Intentionally do NOT send a "Processing..." / "Queued" interstitial
        // message with a Cancel-task menu. The session manager queues new user
        // messages automatically: the user can simply send another message and
        // it will be processed once the current atomic step finishes. Showing
        // a cancel button adds noise (especially on WeChat where every reply
        // costs a context_token slot) without giving the user anything they
        // actually need. The empty `MenuView::default()` here is silently
        // dropped by every adapter's `send_handle_result` (see the
        // empty-text guards in weixin.rs / feishu.rs / telegram.rs).
        let view = MenuView::default();

        let forward = ForwardRequest {
            remote_target: None,
            session_id,
            content: message.to_string(),
            agent_type,
            turn_id,
            image_contexts,
        };

        result_from_menu_with_forward(state, view, Some(forward))
    } // end local branch
}

// ── Forwarded turn execution (largely unchanged) ──────────────────

pub(crate) async fn execute_forwarded_turn(
    forward: ForwardRequest,
    interaction_handler: Option<BotInteractionHandler>,
    message_sender: Option<BotMessageSender>,
    verbose_mode: bool,
    runtime_fence: &super::BotRuntimeFence,
    identity_epoch: u64,
) -> ForwardedTurnResult {
    if !runtime_fence.is_lifecycle_current() || runtime_fence.identity_epoch() != identity_epoch {
        return ForwardedTurnResult {
            completed_remote_tools: Vec::new(),
            display_text: String::new(),
            full_text: String::new(),
        };
    }
    if forward.remote_target.is_some() {
        return execute_remote_forward(forward, interaction_handler, runtime_fence, identity_epoch)
            .await;
    }
    use crate::service::remote_connect::remote_server::{
        get_or_init_global_dispatcher, TrackerEvent,
    };
    use openbitfun_services_integrations::remote_connect::RemoteConnectSubmissionSource;

    let language = current_bot_language().await;
    let s = strings_for(language);

    let dispatcher = get_or_init_global_dispatcher();
    let tracker = dispatcher.ensure_tracker(&forward.session_id);
    let mut event_rx = tracker.subscribe();

    let target_turn_id = forward.turn_id.clone();

    if let Err(e) = dispatcher
        .send_message(
            &forward.session_id,
            forward.content,
            Some(&forward.agent_type),
            forward.image_contexts,
            RemoteConnectSubmissionSource::Bot,
            Some(forward.turn_id.clone()),
        )
        .await
    {
        let msg = format!("{}{e}", s.send_failed_prefix);
        return ForwardedTurnResult {
            completed_remote_tools: Vec::new(),
            display_text: msg.clone(),
            full_text: msg,
        };
    }

    let result = tokio::time::timeout(std::time::Duration::from_secs(3600), async {
        let mut response = String::new();
        let mut thinking_buf = String::new();

        let streams_our_turn = || {
            tracker
                .snapshot_active_turn()
                .map(|st| st.turn_id == target_turn_id)
                .unwrap_or(false)
        };

        loop {
            match event_rx.recv().await {
                Ok(event) => match event {
                    TrackerEvent::ThinkingChunk(chunk) => {
                        if !streams_our_turn() {
                            continue;
                        }
                        thinking_buf.push_str(&chunk);
                    }
                    TrackerEvent::ThinkingEnd => {
                        if !streams_our_turn() {
                            continue;
                        }
                        if verbose_mode && !thinking_buf.trim().is_empty() {
                            if let Some(sender) = message_sender.as_ref() {
                                let content = truncate_at_char_boundary(&thinking_buf, 500);
                                let msg = format!("[{}] {}", s.thinking_label, content);
                                sender(msg).await;
                            }
                        }
                        thinking_buf.clear();
                    }
                    TrackerEvent::TextChunk(t) => {
                        if !streams_our_turn() {
                            continue;
                        }
                        response.push_str(&t);
                    }
                    TrackerEvent::ToolStarted {
                        tool_id,
                        tool_name,
                        params,
                    } => {
                        if !streams_our_turn() {
                            continue;
                        }
                        // Only AskUserQuestion needs an IM-side prompt; every
                        // other tool call is internal and not surfaced to the
                        // user (verbose mode keeps thinking summaries only —
                        // see ToolCompleted handler below).
                        if tool_name == "AskUserQuestion" {
                            if let Some(questions_value) =
                                params.and_then(|p| p.get("questions").cloned())
                            {
                                if let Ok(questions) =
                                    serde_json::from_value::<Vec<BotQuestion>>(questions_value)
                                {
                                    let view = build_question_view(s, &questions, 0, false);
                                    let actions: Vec<BotAction> =
                                        view.items.iter().cloned().map(BotAction::from).collect();
                                    let request = BotInteractiveRequest {
                                        remote_target: None,
                                        reply: view.render_text_block(),
                                        actions,
                                        menu: view,
                                        pending_action: PendingAction::AskUserQuestion {
                                            tool_id,
                                            questions,
                                            current_index: 0,
                                            answers: Vec::new(),
                                            awaiting_custom_text: false,
                                            pending_answer: None,
                                        },
                                    };
                                    if let Some(handler) = interaction_handler.as_ref() {
                                        handler(request).await;
                                    }
                                }
                            }
                        }
                    }
                    TrackerEvent::ToolCompleted { .. } => {
                        // Verbose mode used to push a `[ToolName] params => OK 627ms`
                        // line for every tool call. That is noisy on IM channels
                        // (especially WeChat where each line costs a context_token
                        // slot) and provides little value to the end user — they
                        // only care about the thinking summary and the final
                        // answer. Drop the tool-call notifications entirely while
                        // keeping `ThinkingEnd` summaries for verbose mode.
                    }
                    TrackerEvent::TurnCompleted { turn_id } => {
                        if turn_id == target_turn_id {
                            break;
                        }
                    }
                    TrackerEvent::TurnFailed { turn_id, error } => {
                        if turn_id == target_turn_id {
                            let msg = format!("{}{}", s.error_prefix, error);
                            return ForwardedTurnResult {
                                completed_remote_tools: Vec::new(),
                                display_text: msg.clone(),
                                full_text: msg,
                            };
                        }
                    }
                    TrackerEvent::TurnCancelled { turn_id } => {
                        if turn_id == target_turn_id {
                            return ForwardedTurnResult {
                                completed_remote_tools: Vec::new(),
                                display_text: s.task_cancelled.to_string(),
                                full_text: s.task_cancelled.to_string(),
                            };
                        }
                    }
                },
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    log::warn!("Bot event receiver lagged by {n} events");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }

        // Read the submitted turn by identity. Another controller may already
        // have started the next turn and replaced the tracker's text buffer.
        let poll_host =
            crate::service_agent_runtime::CoreServiceAgentRuntime::remote_poll_host(&dispatcher);
        let poll = openbitfun_services_integrations::remote_connect::handle_remote_poll_command(
            &poll_host,
            &openbitfun_services_integrations::remote_connect::RemoteCommand::PollSession {
                session_id: forward.session_id.clone(),
                since_version: 0,
                known_msg_count: 0,
                known_model_catalog_version: None,
            },
        )
        .await;
        let full_text = serde_json::to_value(poll)
            .ok()
            .and_then(|poll| {
                openbitfun_services_integrations::remote_connect::bot::remote_turn::observe_turn(
                    &poll,
                    &target_turn_id,
                )
            })
            .map(|turn| turn.text)
            .filter(|text| !text.is_empty())
            .unwrap_or(response);

        // Do NOT truncate here. Each IM adapter knows its own per-message
        // size limit and chunks accordingly (e.g. WeChat splits via
        // `chunk_text_for_weixin`, Telegram chunks at 4096 chars). A global
        // 4000-char hard cut here would silently drop the tail of long
        // replies (e.g. PPT outlines, code reviews) and confuse users with
        // a "(truncated)" suffix they cannot recover from.
        let display_text = full_text.clone();

        ForwardedTurnResult {
            completed_remote_tools: Vec::new(),
            display_text: if display_text.is_empty() {
                s.no_response.to_string()
            } else {
                display_text
            },
            full_text,
        }
    })
    .await;

    result.unwrap_or_else(|_| ForwardedTurnResult {
        completed_remote_tools: Vec::new(),
        display_text: s.timeout_one_hour.to_string(),
        full_text: String::new(),
    })
}

async fn execute_remote_forward(
    forward: ForwardRequest,
    interaction_handler: Option<BotInteractionHandler>,
    fence: &super::BotRuntimeFence,
    epoch: u64,
) -> ForwardedTurnResult {
    use openbitfun_services_integrations::remote_connect::bot::remote_turn::observe_turn;
    let s = strings_for(current_bot_language().await);
    let target = forward.remote_target.as_ref().unwrap();
    let current = || fence.is_lifecycle_current() && fence.identity_epoch() == epoch;
    let empty = || ForwardedTurnResult {
        completed_remote_tools: Vec::new(),
        display_text: String::new(),
        full_text: String::new(),
    };
    if !current() {
        return empty();
    }
    // Submission is never retried blindly: older peers need not deduplicate.
    let sent = target
        .rpc(serde_json::json!({
            "cmd":"send_message", "session_id":target.session_id,
            "content":forward.content, "turn_id":forward.turn_id,
            "image_contexts":forward.image_contexts,
        }))
        .await;
    if !current() {
        return empty();
    }
    let turn_id = match sent {
        Ok(reply)
            if reply["resp"] == "message_sent" && reply["session_id"] == target.session_id =>
        {
            match reply["turn_id"].as_str().filter(|id| !id.is_empty()) {
                Some(id) => id.to_string(),
                None => {
                    return ForwardedTurnResult {
                        completed_remote_tools: Vec::new(),
                        display_text: format!("{}Missing remote turn ID", s.send_failed_prefix),
                        full_text: String::new(),
                    }
                }
            }
        }
        result => {
            return ForwardedTurnResult {
                completed_remote_tools: Vec::new(),
                display_text: format!(
                    "{}{}",
                    s.send_failed_prefix,
                    result
                        .err()
                        .unwrap_or_else(|| "Invalid remote submission response".into())
                ),
                full_text: String::new(),
            }
        }
    };
    let result = tokio::time::timeout(std::time::Duration::from_secs(3600), async {
        let mut version = 0;
        let mut shown = std::collections::HashMap::<String, std::time::Instant>::new();
        loop {
            if !current() {
                return empty();
            }
            if shown.values().any(|at| at.elapsed().as_secs() >= 240) {
                version = 0;
            }
            let poll = target.poll(version).await;
            if !current() {
                return empty();
            }
            match poll {
                Ok(poll) if poll["resp"] == "session_poll" => {
                    version = poll["version"].as_u64().unwrap_or(0);
                    if let Some(turn) = observe_turn(&poll, &turn_id) {
                        if turn.terminal() {
                            let display_text = match turn.status.as_str() {
                                "failed" | "error" => {
                                    format!("{}{}", s.error_prefix, turn.error.unwrap_or_default())
                                }
                                "cancelled" => s.task_cancelled.to_string(),
                                _ if turn.text.is_empty() => s.no_response.to_string(),
                                _ => turn.text.clone(),
                            };
                            return ForwardedTurnResult {
                                completed_remote_tools: shown.into_keys().collect(),
                                display_text,
                                full_text: turn.text,
                            };
                        }
                        for tool in turn.tools {
                            // Pending menus expire after five minutes; re-present a
                            // still-blocked interaction so it remains answerable.
                            if shown
                                .get(&tool.id)
                                .is_some_and(|at| at.elapsed().as_secs() < 240)
                            {
                                continue;
                            }
                            let (mut view, pending_action) = if tool.status
                                == "pending_confirmation"
                            {
                                let action_token = uuid::Uuid::new_v4().to_string();
                                let description = format!(
                                    "{}\n{}",
                                    tool.name,
                                    tool.input_preview.unwrap_or_default()
                                );
                                (
                                    remote_tool_view(&action_token, &description, s),
                                    PendingAction::ConfirmRemoteTool {
                                        tool_id: tool.id.clone(),
                                        action_token,
                                        description,
                                    },
                                )
                            } else if tool.name == "AskUserQuestion" && tool.status == "running" {
                                let Some(questions) = tool
                                    .tool_input
                                    .as_ref()
                                    .and_then(|p| p.get("questions"))
                                    .and_then(|v| {
                                        serde_json::from_value::<Vec<BotQuestion>>(v.clone()).ok()
                                    })
                                else {
                                    continue;
                                };
                                (
                                    build_question_view(s, &questions, 0, false),
                                    PendingAction::AskUserQuestion {
                                        tool_id: tool.id.clone(),
                                        questions,
                                        current_index: 0,
                                        answers: vec![],
                                        awaiting_custom_text: false,
                                        pending_answer: None,
                                    },
                                )
                            } else {
                                continue;
                            };
                            view.title = format!(
                                "{} · {} · {}",
                                target.device_name, target.session_id, view.title
                            );
                            if let Some(handler) = &interaction_handler {
                                handler(BotInteractiveRequest {
                                    remote_target: Some(target.clone()),
                                    reply: view.render_text_block(),
                                    actions: view
                                        .items
                                        .iter()
                                        .cloned()
                                        .map(BotAction::from)
                                        .collect(),
                                    menu: view,
                                    pending_action,
                                })
                                .await;
                                shown.insert(tool.id, std::time::Instant::now());
                            }
                        }
                    }
                }
                Ok(reply) => {
                    return ForwardedTurnResult {
                        completed_remote_tools: Vec::new(),
                        display_text: format!(
                            "{}{}",
                            s.error_prefix,
                            reply["message"]
                                .as_str()
                                .unwrap_or("Invalid remote poll response")
                        ),
                        full_text: String::new(),
                    }
                }
                Err(error) => {
                    if crate::service::remote_connect::account::error_indicates_expired_token(
                        &error,
                    ) || error.contains("HTTP 403")
                    {
                        return ForwardedTurnResult {
                            completed_remote_tools: Vec::new(),
                            display_text: format!("{}{error}", s.error_prefix),
                            full_text: String::new(),
                        };
                    }
                    log::warn!("Bot remote turn poll interrupted: {error}");
                    // Read-only replay after a disconnect, without another send.
                    version = 0;
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    })
    .await;
    result.unwrap_or_else(|_| ForwardedTurnResult {
        completed_remote_tools: Vec::new(),
        display_text: s.timeout_one_hour.to_string(),
        full_text: String::new(),
    })
}

fn remote_tool_view(tool_id: &str, description: &str, s: &'static BotStrings) -> MenuView {
    MenuView::plain(s.tool_approval_title)
        .with_body(description)
        .with_items(vec![
            MenuItem::primary(s.tool_approve, format!("approve-tool:{tool_id}")),
            MenuItem::default(s.tool_reject, format!("reject-tool:{tool_id}")),
        ])
}

fn truncate_at_char_boundary(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        return s.to_string();
    }
    let mut end = max_len;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &s[..end])
}

// ── Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod parse_command_tests {
    use super::*;

    #[tokio::test]
    async fn bot_partial_answer_stops_unattended_timeout() {
        use openbitfun_agent_runtime::user_questions::{
            get_user_input_manager, PendingUserQuestion,
        };
        let manager = get_user_input_manager();
        let (sender, mut receiver) = tokio::sync::oneshot::channel();
        let _registration = manager.register_question(
            PendingUserQuestion::new(
                "bot-timeout-question",
                "bot-timeout-session",
                None,
                None,
                serde_json::json!({}),
            ),
            sender,
        );
        let mut state = BotChatState::new("bot-timeout-chat".into());
        state.current_session_id = Some("bot-timeout-session".into());
        let questions = vec![
            BotQuestion {
                question: "Choose".into(),
                header: "Question".into(),
                multi_select: false,
                options: vec![BotQuestionOption {
                    label: "Yes".into(),
                    description: String::new()
                }],
            };
            2
        ];
        let s = strings_for(BotLanguage::EnUS);
        handle_question_reply(
            &mut state,
            "bot-timeout-question".into(),
            questions,
            0,
            vec![],
            false,
            None,
            "1",
            s,
        )
        .await;
        assert!(
            manager
                .pending_question_snapshot("bot-timeout-session")
                .questions[0]
                .interaction_started
        );
        assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        assert!(matches!(
            state.pending_action,
            Some(PendingAction::AskUserQuestion {
                current_index: 1,
                ..
            })
        ));
    }

    #[test]
    fn remote_picker_prefers_opened_workspaces_and_keeps_bot_mode_separation() {
        let response = serde_json::json!({
            "resp": "recent_workspaces",
            "workspaces": [{"path": "/closed", "name": "Closed project"}],
            "opened_workspaces": [
                {"path": "/assistant/workspace", "name": "Mina", "workspace_kind": "assistant"},
                {"path": "/repo", "name": "Project A", "workspace_kind": "remote",
                 "remote_connection_id": "conn-a", "remote_ssh_host": "host-a"},
                {"path": "/repo", "name": "Project B", "workspace_kind": "remote",
                 "remote_connection_id": "conn-b", "remote_ssh_host": "host-b"}
            ]
        });
        let options = remote_workspace_choices(&response.to_string()).unwrap();
        assert_eq!(options.len(), 2);
        assert_eq!(
            options[0],
            BotWorkspaceChoice::new(
                "/repo",
                "Project A",
                Some("conn-a".into()),
                Some("host-a".into())
            )
        );
        assert_eq!(
            options[1],
            BotWorkspaceChoice::new(
                "/repo",
                "Project B",
                Some("conn-b".into()),
                Some("host-b".into())
            )
        );

        let selected = BotWorkspaceChoice::new(
            "/repo",
            "Old label",
            Some("conn-b".into()),
            Some("host-b".into()),
        );
        assert_eq!(
            current_workspace_choice(&options, &selected).unwrap().name,
            "Project B"
        );
        assert!(current_workspace_choice(&options[..1], &selected).is_none());
    }

    #[test]
    fn remote_picker_empty_opened_catalog_clears_stale_options_without_dropping_session() {
        let response = r#"{"resp":"recent_workspaces","workspaces":[{"path":"/closed","name":"Closed"}],"opened_workspaces":[]}"#;
        let options = remote_workspace_choices(response).unwrap();
        assert!(options.is_empty());
        let mut state = BotChatState::new("chat".into());
        state.current_workspace = Some(BotWorkspaceRef::local("/closed"));
        state.current_session_id = Some("retained-session".into());
        state.set_pending(PendingAction::SelectWorkspace {
            options: vec![BotWorkspaceChoice::new("/closed", "Closed", None, None)],
        });
        let strings = strings_for(BotLanguage::EnUS);
        let result = show_workspace_choices(&mut state, options, strings);
        assert_eq!(result.menu.title, strings.switch_no_workspaces);
        assert!(state.pending_action.is_none());
        assert_eq!(state.current_workspace_path(), Some("/closed"));
        assert_eq!(
            state.current_session_id.as_deref(),
            Some("retained-session")
        );
    }

    #[test]
    fn remote_picker_accepts_legacy_catalog_after_wire_round_trip() {
        use openbitfun_services_integrations::remote_connect::RemoteResponse;
        let legacy = serde_json::json!({
            "resp": "recent_workspaces",
            "workspaces": [{"path": "/legacy", "name": "Legacy project", "last_opened": ""}]
        });
        let decoded: RemoteResponse = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(serde_json::to_value(&decoded).unwrap(), legacy);
        let options = remote_workspace_choices(&serde_json::to_string(&decoded).unwrap()).unwrap();
        assert_eq!(
            options,
            vec![BotWorkspaceChoice::new(
                "/legacy",
                "Legacy project",
                None,
                None
            )]
        );

        let mut null_catalog = legacy;
        null_catalog["opened_workspaces"] = Value::Null;
        assert_eq!(
            remote_workspace_choices(&null_catalog.to_string()).unwrap(),
            options
        );
    }

    #[test]
    fn remote_picker_does_not_hide_catalog_failures_as_empty_or_recent_rows() {
        for response in [
            r#"{"resp":"recent_workspaces","workspaces":[{"path":"/closed"}],"opened_workspaces":{}}"#,
            r#"{"resp":"recent_workspaces"}"#,
            r#"{"resp":"workspace_info","workspaces":[]}"#,
            "invalid json",
        ] {
            assert!(remote_workspace_choices(response).is_err(), "{response}");
        }
        assert_eq!(
            remote_workspace_choices(r#"{"resp":"error","message":"Peer offline"}"#).unwrap_err(),
            "Peer offline"
        );
    }

    #[tokio::test]
    async fn local_bot_identity_repairs_legacy_state_without_retargeting_remote_workspaces() {
        use crate::service::workspace::{WorkspaceKind, WorkspaceService};
        use openbitfun_runtime_ports::RemoteSessionWorkspaceIdentity;
        use openbitfun_services_integrations::remote_connect::{
            build_remote_session_create_request, RemoteConnectSubmissionSource,
        };
        let root = tempfile::tempdir().unwrap();
        let paths = Arc::new(
            crate::infrastructure::PathManager::with_user_root_for_tests(
                root.path().join("user-root"),
            ),
        );
        let service = WorkspaceService::new_for_test_path_manager(paths).await;
        let project_root = root.path().join("project");
        std::fs::create_dir_all(&project_root).unwrap();
        let project = service.open_workspace(project_root).await.unwrap();
        assert_eq!(
            project.metadata.get("sshHost").and_then(Value::as_str),
            Some("localhost")
        );
        let path = project.root_path.to_string_lossy().to_string();
        let choices = local_pro_workspace_choices(remote_opened_workspace_catalog(&service).await);
        assert_eq!(choices.len(), 1);
        assert!(choices[0].remote_ssh_host.is_none());
        // The identity captured after a successful open must agree with the picker.
        assert_eq!(
            bot_workspace_ref(&project),
            BotWorkspaceRef::local(&path).with_workspace_id(Some(project.id.clone()))
        );

        let legacy = serde_json::json!({
            "path": path, "remote_connection_id": null, "remote_ssh_host": "localhost"
        });
        let mut state = BotChatState::new("chat".into());
        state.current_workspace = Some(serde_json::from_value(legacy.clone()).unwrap());
        state.current_session_id = Some("keep-session".into());
        repair_local_bot_workspace_state(&mut state, &[project.clone()]);
        assert_eq!(
            state.current_workspace,
            Some(BotWorkspaceRef::local(&path).with_workspace_id(Some(project.id.clone())))
        );
        assert_eq!(state.current_session_id.as_deref(), Some("keep-session"));
        let serialized = serde_json::to_value(state.current_workspace.as_ref().unwrap()).unwrap();
        let restored: BotWorkspaceRef = serde_json::from_value(serialized).unwrap();
        assert_eq!(
            restored,
            BotWorkspaceRef::local(&path).with_workspace_id(Some(project.id.clone()))
        );
        let request = build_remote_session_create_request(
            "test",
            "Code",
            Some(path.clone()),
            RemoteSessionWorkspaceIdentity::new(
                restored.remote_connection_id,
                restored.remote_ssh_host,
            )
            .with_workspace_id(restored.workspace_id),
            RemoteConnectSubmissionSource::Bot,
        );
        assert_eq!(request.workspace_id.as_deref(), Some(project.id.as_str()));
        assert!(request.remote_connection_id.is_none());
        assert!(request.remote_ssh_host.is_none());

        let mut remote = project.clone();
        remote.id = "remote-workspace".into();
        remote.workspace_kind = WorkspaceKind::Remote;
        remote
            .metadata
            .insert("connectionId".into(), serde_json::json!("ssh-localhost"));
        let remote_ref = bot_workspace_ref(&remote);
        assert_eq!(
            remote_ref.remote_connection_id.as_deref(),
            Some("ssh-localhost")
        );
        assert_eq!(remote_ref.remote_ssh_host.as_deref(), Some("localhost"));
        state.current_workspace = Some(remote_ref.clone());
        repair_local_bot_workspace_state(&mut state, &[project.clone()]);
        assert_eq!(state.current_workspace, Some(remote_ref));

        state.current_workspace = Some(serde_json::from_value(legacy).unwrap());
        let before = state.current_workspace.clone();
        repair_local_bot_workspace_state(&mut state, &[project.clone(), remote]);
        assert_eq!(state.current_workspace, before);
        repair_local_bot_workspace_state(&mut state, &[]);
        assert_eq!(state.current_workspace, before);
        state.account_remote_context = true;
        repair_local_bot_workspace_state(&mut state, &[project.clone()]);
        assert_eq!(state.current_workspace, before);
        state.account_remote_context = false;
        state.active_remote_device = Some(RemoteDeviceTarget {
            device_id: "other-device".into(),
            device_name: "Other device".into(),
        });
        repair_local_bot_workspace_state(&mut state, &[project]);
        assert_eq!(state.current_workspace, before);
    }

    #[tokio::test]
    async fn local_bot_pickers_use_opened_rows_and_refresh_assistant_identity() {
        use crate::service::workspace::{WorkspaceCreateOptions, WorkspaceKind, WorkspaceService};
        let root = tempfile::tempdir().unwrap();
        let paths = Arc::new(
            crate::infrastructure::PathManager::with_user_root_for_tests(
                root.path().join("user-root"),
            ),
        );
        let service = WorkspaceService::new_for_test_path_manager(paths).await;
        let project_root = root.path().join("project");
        let assistant_root = root.path().join("workspace");
        std::fs::create_dir_all(&project_root).unwrap();
        std::fs::create_dir_all(&assistant_root).unwrap();
        std::fs::write(assistant_root.join("IDENTITY.md"), "---\nname: Mina\n---\n").unwrap();
        let project = service.open_workspace(project_root).await.unwrap();
        let assistant = service
            .open_workspace_with_options(
                assistant_root.clone(),
                WorkspaceCreateOptions {
                    workspace_kind: WorkspaceKind::Assistant,
                    display_name: Some("workspace".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        // Reproduce legacy records whose name still contains the directory
        // basename even though the identity already has the assistant's name.
        let mut exported = service.export_workspaces().await.unwrap();
        exported
            .workspaces
            .iter_mut()
            .find(|row| row.id == assistant.id)
            .unwrap()
            .name = "workspace".into();
        service.import_workspaces(exported, true).await.unwrap();
        let strings = strings_for(BotLanguage::EnUS);
        let mut state = BotChatState::new("chat".into());
        state.current_session_id = Some("keep-session".into());
        state.display_mode = BotDisplayMode::Pro;
        start_local_switch(&mut state, &service, strings).await;
        let Some(PendingAction::SelectWorkspace { options }) = state.pending_action.clone() else {
            panic!("expected workspace picker")
        };
        assert_eq!(options.len(), 1);
        assert_eq!(options[0].path, project.root_path.to_string_lossy());
        let stale_project = options[0].clone();

        state.display_mode = BotDisplayMode::Assistant;
        state.current_assistant = Some(assistant.root_path.to_string_lossy().to_string());
        state.current_assistant_name = Some("workspace".into());
        let result = start_local_switch(&mut state, &service, strings).await;
        assert!(result.menu.body.as_deref().unwrap().contains("Mina"));
        let Some(PendingAction::SelectAssistant { options }) = state.pending_action.as_ref() else {
            panic!("expected assistant picker")
        };
        assert_eq!(options.len(), 1);
        assert_eq!(options[0].1, "Mina");
        refresh_assistant_name_from_workspaces(
            &mut state,
            &service.get_assistant_workspaces().await,
        );
        assert_eq!(state.current_assistant_name.as_deref(), Some("Mina"));
        assert_eq!(
            state.current_assistant_id.as_deref(),
            Some(assistant.id.as_str())
        );
        let mut stale = state.clone();
        stale.current_assistant_id = Some("missing-assistant-id".into());
        stale.current_assistant_name = Some("Keep old label".into());
        refresh_assistant_name_from_workspaces(
            &mut stale,
            &service.get_assistant_workspaces().await,
        );
        assert_eq!(
            stale.current_assistant_id.as_deref(),
            Some("missing-assistant-id")
        );
        assert_eq!(
            stale.current_assistant_name.as_deref(),
            Some("Keep old label")
        );

        std::fs::write(assistant_root.join("IDENTITY.md"), "---\nname: Kira\n---\n").unwrap();
        service
            .refresh_workspace_identity(&assistant.id)
            .await
            .unwrap();
        refresh_assistant_name_from_workspaces(
            &mut state,
            &service.get_assistant_workspaces().await,
        );
        assert_eq!(state.current_assistant_name.as_deref(), Some("Kira"));
        assert!(ready_to_chat_body(&state, strings)
            .unwrap()
            .contains("Kira"));

        service.close_workspace(&project.id).await.unwrap();
        assert!(service
            .get_recent_workspaces()
            .await
            .iter()
            .any(|row| row.id == project.id));
        state.display_mode = BotDisplayMode::Pro;
        let result = select_local_workspace(&mut state, &service, &stale_project, strings).await;
        assert!(result.menu.title.contains(strings.workspace_list_changed));
        assert!(result.menu.title.contains(strings.switch_no_workspaces));
        assert!(state.pending_action.is_none());
        assert_eq!(
            service.get_opened_workspaces().await.len(),
            1,
            "stale choice must not reopen the project"
        );

        service.close_workspace(&assistant.id).await.unwrap();
        assert_eq!(
            service.get_assistant_workspaces().await.len(),
            1,
            "closed assistants remain tracked"
        );
        state.display_mode = BotDisplayMode::Assistant;
        let result = select_local_assistant(&mut state, &service, &assistant.id, strings).await;
        assert!(result.menu.title.contains(strings.workspace_list_changed));
        assert!(result.menu.title.contains(strings.switch_no_assistants));
        assert!(state.pending_action.is_none());
        assert!(service.get_opened_workspaces().await.is_empty());
        assert_eq!(state.current_session_id.as_deref(), Some("keep-session"));

        let reopened = service.open_workspace(project.root_path).await.unwrap();
        state.display_mode = BotDisplayMode::Pro;
        start_local_switch(&mut state, &service, strings).await;
        service.remove_workspace(&reopened.id).await.unwrap();
        let result = select_local_workspace(&mut state, &service, &stale_project, strings).await;
        assert!(result.menu.title.contains(strings.workspace_list_changed));
        assert!(state.pending_action.is_none());
        assert!(service.get_opened_workspaces().await.is_empty());
        assert_eq!(state.current_session_id.as_deref(), Some("keep-session"));
    }

    #[test]
    fn numeric_menu_with_trailing_dot() {
        assert!(matches!(
            parse_command("1."),
            BotCommand::NumberSelection(1)
        ));
        assert!(matches!(
            parse_command("2。"),
            BotCommand::NumberSelection(2)
        ));
    }

    #[test]
    fn fullwidth_digit_one() {
        assert!(matches!(
            parse_command("１"),
            BotCommand::NumberSelection(1)
        ));
    }

    #[test]
    fn zero_parsed_as_number_selection() {
        // `0` stays as a numeric selection so it can mean "next page" or
        // "back" depending on which pending action is active.  The
        // top-level "no pending" → main-menu fallback is implemented in
        // `handle_number`.
        assert!(matches!(parse_command("0"), BotCommand::NumberSelection(0)));
    }

    #[test]
    fn menu_aliases() {
        assert!(matches!(parse_command("/menu"), BotCommand::Menu));
        assert!(matches!(parse_command("/m"), BotCommand::Menu));
        assert!(matches!(parse_command("菜单"), BotCommand::Menu));
        assert!(matches!(parse_command("/start"), BotCommand::Menu));
    }

    #[test]
    fn settings_aliases() {
        assert!(matches!(parse_command("/settings"), BotCommand::Settings));
        assert!(matches!(parse_command("设置"), BotCommand::Settings));
    }

    #[test]
    fn verbose_concise_real_commands() {
        assert!(matches!(
            parse_command("/verbose"),
            BotCommand::SetVerbose(true)
        ));
        assert!(matches!(
            parse_command("/concise"),
            BotCommand::SetVerbose(false)
        ));
    }

    #[test]
    fn switch_aliases() {
        assert!(matches!(
            parse_command("/switch"),
            BotCommand::SwitchContext
        ));
        assert!(matches!(
            parse_command("/switch_workspace"),
            BotCommand::SwitchContext
        ));
        assert!(matches!(
            parse_command("/switch_assistant"),
            BotCommand::SwitchContext
        ));
        assert!(matches!(parse_command("切换"), BotCommand::SwitchContext));
    }

    #[test]
    fn new_session_aliases() {
        assert!(matches!(parse_command("/new"), BotCommand::NewSession));
        assert!(matches!(
            parse_command("/new_code_session"),
            BotCommand::NewCodeSession
        ));
        assert!(matches!(
            parse_command("/new_cowork_session"),
            BotCommand::NewCoworkSession
        ));
        assert!(matches!(
            parse_command("/new_claw_session"),
            BotCommand::NewClawSession
        ));
    }

    #[test]
    fn resume_aliases() {
        assert!(matches!(
            parse_command("/resume"),
            BotCommand::ResumeSession
        ));
        assert!(matches!(parse_command("/r"), BotCommand::ResumeSession));
        assert!(matches!(
            parse_command("/resume_session"),
            BotCommand::ResumeSession
        ));
    }

    #[test]
    fn cancel_aliases() {
        assert!(matches!(
            parse_command("/cancel"),
            BotCommand::CancelTask(None)
        ));
        match parse_command("/cancel_task turn_abc") {
            BotCommand::CancelTask(Some(id)) => assert_eq!(id, "turn_abc"),
            _ => panic!("expected cancel task with id"),
        }
    }

    #[test]
    fn pairing_code_detected() {
        match parse_command("123456") {
            BotCommand::PairingCode(c) => assert_eq!(c, "123456"),
            _ => panic!("expected pairing code"),
        }
    }

    #[test]
    fn chat_message_fallback() {
        assert!(matches!(
            parse_command("hello world"),
            BotCommand::ChatMessage(_)
        ));
    }
}

#[cfg(test)]
mod state_tests {
    use super::*;

    #[test]
    fn pending_expires_after_ttl() {
        let mut state = BotChatState::new("c".into());
        state.set_pending(PendingAction::SelectWorkspace { options: vec![] });
        assert!(state.pending_action.is_some());
        assert!(!state.pending_expired());
        state.pending_expires_at = 0;
        assert!(state.pending_expired());
    }

    #[test]
    fn active_workspace_path_prefers_pro_workspace_then_assistant() {
        let mut state = BotChatState::new("c".into());
        assert_eq!(state.active_workspace_path(), None);

        state.current_assistant = Some("/tmp/assistant-ws".to_string());
        assert_eq!(
            state.active_workspace_path().as_deref(),
            Some("/tmp/assistant-ws"),
            "assistant path is the fallback when no Pro workspace is set"
        );

        state.current_workspace = Some(BotWorkspaceRef::local("/tmp/pro-ws"));
        assert_eq!(
            state.active_workspace_path().as_deref(),
            Some("/tmp/pro-ws"),
            "Pro workspace wins over the assistant path when both are set"
        );
    }

    #[test]
    fn clear_pending_resets_counters() {
        let mut state = BotChatState::new("c".into());
        state.set_pending(PendingAction::SelectWorkspace { options: vec![] });
        state.pending_invalid_count = 2;
        state.clear_pending();
        assert!(state.pending_action.is_none());
        assert_eq!(state.pending_invalid_count, 0);
        assert_eq!(state.pending_expires_at, 0);
    }
}

#[cfg(test)]
mod menu_tests {
    use super::*;

    #[test]
    fn main_menu_assistant_has_five_items() {
        let state = BotChatState::new("c".into());
        let view = main_menu_view(&state, strings_for(BotLanguage::ZhCN));
        assert_eq!(view.items.len(), 5);
        assert!(view.items.iter().any(|i| i.command == "/new"));
        assert!(view.items.iter().any(|i| i.command == "/resume"));
        assert!(view.items.iter().any(|i| i.command == "/switch"));
        assert!(view.items.iter().any(|i| i.command == "/devices"));
        assert!(view.items.iter().any(|i| i.command == "/settings"));
    }

    #[test]
    fn main_menu_expert_has_six_items() {
        let mut state = BotChatState::new("c".into());
        state.display_mode = BotDisplayMode::Pro;
        let view = main_menu_view(&state, strings_for(BotLanguage::ZhCN));
        assert_eq!(view.items.len(), 6);
        assert!(view.items.iter().any(|i| i.command == "/new_code_session"));
        assert!(view.items.iter().any(|i| i.command == "/devices"));
    }

    /// Main menu must NOT surface the random session UUID tail. The user
    /// only cares about the workspace / assistant name; the session ID is
    /// noise (see /resume for proper session management).
    #[test]
    fn main_menu_body_omits_session_id() {
        let mut state = BotChatState::new("c".into());
        state.current_assistant = Some("/tmp/my-assistant".to_string());
        state.current_assistant_name = Some("我的助理".to_string());
        state.current_session_id = Some("abcdef12-3456-7890-abcd-ef1234567890".to_string());
        let s = strings_for(BotLanguage::ZhCN);
        let view = main_menu_view(&state, s);
        let body = view.body.as_deref().unwrap_or("");
        assert!(
            !body.contains("567890") && !body.contains("ef1234567890"),
            "session UUID tail leaked into body: {body}"
        );
        assert!(body.contains("我的助理"), "assistant name missing: {body}");
    }

    /// Assistant mode must show the assistant's display name rather than
    /// the workspace directory's `file_name`. The directory is usually a
    /// generic "workspace" / "workspace-<uuid>" folder which is meaningless
    /// to the user.
    #[test]
    fn assistant_mode_body_uses_display_name_not_dir_name() {
        let mut state = BotChatState::new("c".into());
        state.current_assistant = Some("/tmp/openbitfun_assistants/workspace-abc123".to_string());
        state.current_assistant_name = Some("默认助理".to_string());
        let s = strings_for(BotLanguage::ZhCN);
        let view = main_menu_view(&state, s);
        let body = view.body.as_deref().unwrap_or("");
        assert!(
            body.contains("默认助理"),
            "expected assistant display name in body, got: {body}"
        );
        assert!(
            !body.contains("workspace-abc123"),
            "workspace directory name leaked into body: {body}"
        );
    }

    /// Expert mode keeps showing the workspace directory name (it IS the
    /// project name, which is what the user expects to see).
    #[test]
    fn expert_mode_body_still_uses_workspace_dir_name() {
        let mut state = BotChatState::new("c".into());
        state.display_mode = BotDisplayMode::Pro;
        state.current_workspace = Some(BotWorkspaceRef::local("/tmp/projects/MyApp"));
        // `current_assistant_name` should not affect Pro mode at all.
        state.current_assistant_name = Some("ignored".to_string());
        let s = strings_for(BotLanguage::ZhCN);
        let view = main_menu_view(&state, s);
        let body = view.body.as_deref().unwrap_or("");
        assert!(body.contains("MyApp"), "workspace name missing: {body}");
        assert!(
            !body.contains("ignored"),
            "assistant name leaked into Pro mode: {body}"
        );
    }

    /// When the cached assistant display name is missing (e.g. legacy
    /// persisted state), fall back to the path's last segment instead of
    /// rendering an empty label or panicking.
    #[test]
    fn assistant_mode_body_falls_back_to_path_when_name_missing() {
        let mut state = BotChatState::new("c".into());
        state.current_assistant = Some("/tmp/my-assistant-folder".to_string());
        state.current_assistant_name = None;
        let s = strings_for(BotLanguage::ZhCN);
        let view = main_menu_view(&state, s);
        let body = view.body.as_deref().unwrap_or("");
        assert!(
            body.contains("my-assistant-folder"),
            "expected fallback to path tail, got: {body}"
        );
    }

    #[test]
    fn main_menu_body_omits_session_label_text() {
        let mut state = BotChatState::new("c".into());
        state.current_assistant = Some("/tmp/my-assistant".to_string());
        state.current_session_id = Some("session-xyz".to_string());
        let s = strings_for(BotLanguage::ZhCN);
        let view = main_menu_view(&state, s);
        let body = view.body.as_deref().unwrap_or("");
        assert!(
            !body.contains(s.current_session_label),
            "current_session_label leaked into body: {body}"
        );
    }

    #[test]
    fn session_menu_plain_text_lists_each_choice_once() {
        let state = BotChatState::new("c".into());
        let s = strings_for(BotLanguage::ZhCN);
        let options = vec![
            ("session-a".to_string(), "会话甲".to_string()),
            ("session-b".to_string(), "会话乙".to_string()),
        ];

        let view = session_selection_view(&state, &options, 0, true, s);
        let text = view.render_plain_text(BotLanguage::ZhCN);

        assert_eq!(text.matches("会话甲").count(), 1, "{text}");
        assert_eq!(text.matches("会话乙").count(), 1, "{text}");
        assert!(!text.contains("3. 下一页"), "{text}");
        assert!(!text.contains("4. 返回"), "{text}");
        assert!(text.contains("发送 0 查看下一页"), "{text}");
        assert!(text.contains("/menu 返回"), "{text}");
    }

    #[test]
    fn question_menu_plain_text_does_not_repeat_button_choices() {
        let s = strings_for(BotLanguage::ZhCN);
        let questions = vec![BotQuestion {
            question: "请选择方案".to_string(),
            header: String::new(),
            options: vec![
                BotQuestionOption {
                    label: "方案甲".to_string(),
                    description: "快速".to_string(),
                },
                BotQuestionOption {
                    label: "方案乙".to_string(),
                    description: "稳妥".to_string(),
                },
            ],
            multi_select: false,
        }];

        let view = build_question_view(s, &questions, 0, false);
        let text = view.render_plain_text(BotLanguage::ZhCN);

        assert_eq!(text.matches("方案甲").count(), 1, "{text}");
        assert_eq!(text.matches("方案乙").count(), 1, "{text}");
        assert_eq!(text.matches("其他").count(), 1, "{text}");
        assert!(!text.contains("4. 返回"), "{text}");
    }

    #[test]
    fn confirmation_plain_text_uses_one_and_zero_semantics() {
        let s = strings_for(BotLanguage::ZhCN);
        let view = confirm_mode_switch_view(BotDisplayMode::Pro, s);
        let text = view.render_plain_text(BotLanguage::ZhCN);

        assert_eq!(text.matches(s.item_confirm_switch).count(), 1, "{text}");
        assert!(!text.contains("2. 返回"), "{text}");
        assert!(text.contains("0"), "{text}");
        assert!(text.contains("/menu"), "{text}");
    }

    #[test]
    fn device_menu_plain_text_is_reconstructable_without_ids_or_duplicates() {
        let mut state = BotChatState::new("c".into());
        state.select_remote_device(RemoteDeviceTarget {
            device_id: "opaque-device-id".to_string(),
            device_name: "办公室电脑".to_string(),
        });
        let s = strings_for(BotLanguage::ZhCN);
        let options = vec![
            ("local".to_string(), s.devices_local.to_string()),
            ("opaque-device-id".to_string(), "办公室电脑".to_string()),
        ];

        let view = device_selection_view(&state, &options, s);
        let text = view.render_plain_text(BotLanguage::ZhCN);

        assert_eq!(text.matches("办公室电脑").count(), 1, "{text}");
        assert!(text.contains(s.current_marker), "{text}");
        assert!(!text.contains("opaque-device-id"), "{text}");
        assert!(!text.contains("3. 返回"), "{text}");
        assert!(text.contains("发送 0 返回"), "{text}");
    }
}

#[cfg(test)]
mod handle_chat_tests {
    use super::*;

    #[tokio::test]
    async fn stale_approval_buttons_do_not_authorize_or_submit_chat_text() {
        let mut state = BotChatState::new("chat".into());
        state.set_pending(PendingAction::ConfirmRemoteTool {
            tool_id: "tool".into(),
            action_token: "new-request".into(),
            description: "render".into(),
        });
        let result = handle_chat(
            &mut state,
            "approve-tool:old-request",
            vec![],
            strings_for(BotLanguage::EnUS),
        )
        .await;
        assert!(result.forward_to_session.is_none());
        assert_eq!(state.pending_invalid_count, 0);
        assert!(state.pending_action.is_some());
    }

    #[tokio::test]
    async fn retired_identity_cannot_submit_a_captured_remote_turn() {
        let fence = super::super::BotRuntimeFence::standalone();
        let target = RemoteBotTarget {
            relay_url: "https://must-not-be-contacted.invalid".into(),
            device_id: "old-device".into(),
            device_name: "Old device".into(),
            session_id: "session".into(),
            account: crate::service::remote_connect::AccountSession::new(
                "old-token".into(),
                String::new(),
                [3; 32],
            ),
        };
        let forward = ForwardRequest {
            remote_target: Some(target),
            session_id: "session".into(),
            content: "must not submit".into(),
            agent_type: String::new(),
            turn_id: "turn".into(),
            image_contexts: vec![],
        };
        let result = execute_forwarded_turn(
            forward,
            None,
            None,
            false,
            &fence,
            fence.identity_epoch() + 1,
        )
        .await;
        assert!(result.display_text.is_empty());
        assert!(result.full_text.is_empty());
    }

    #[test]
    fn interactions_queue_without_overwriting_answers_or_persisting_authority() {
        let s = strings_for(BotLanguage::EnUS);
        let make = |device: &str| {
            let action = PendingAction::ConfirmRemoteTool {
                tool_id: "same-tool-id".into(),
                action_token: device.into(),
                description: "render".into(),
            };
            let view = remote_tool_view(device, "render", s);
            BotInteractiveRequest {
                remote_target: Some(RemoteBotTarget {
                    relay_url: "https://relay.invalid".into(),
                    device_id: device.into(),
                    device_name: device.into(),
                    session_id: "session".into(),
                    account: crate::service::remote_connect::AccountSession::new(
                        "test-secret-token".into(),
                        String::new(),
                        [5; 32],
                    ),
                }),
                reply: view.render_text_block(),
                actions: vec![],
                menu: view,
                pending_action: action,
            }
        };
        let mut state = BotChatState::new("chat".into());
        let first = make("device-a");
        let next = make("device-b");
        assert!(apply_interactive_request(&mut state, &first));
        assert!(!apply_interactive_request(&mut state, &next));
        assert!(!apply_interactive_request(&mut state, &next));
        assert_eq!(state.pending_interactions.len(), 1);
        assert_eq!(
            state.pending_remote_target.as_ref().unwrap().device_id,
            "device-a"
        );
        let persisted = serde_json::to_string(&state).unwrap();
        assert!(!persisted.contains("test-secret-token"));
        assert!(!persisted.contains("device-a"));
        finish_bot_interaction(&mut state, s);
        assert_eq!(
            state.pending_remote_target.as_ref().unwrap().device_id,
            "device-b"
        );
        assert!(state.pending_interactions.is_empty());
        state.clear_delegated_identity();
        assert!(state.pending_remote_target.is_none());
        assert!(state.pending_action.is_none());
    }

    #[test]
    fn completed_remote_tools_retire_only_their_own_prompts_and_promote_the_queue() {
        let make = |device: &str| {
            let menu = remote_tool_view(device, "render", strings_for(BotLanguage::EnUS));
            BotInteractiveRequest {
                remote_target: Some(RemoteBotTarget {
                    relay_url: "https://relay.invalid".into(),
                    device_id: device.into(),
                    device_name: device.into(),
                    session_id: "session".into(),
                    account: crate::service::remote_connect::AccountSession::new(
                        "test".into(),
                        String::new(),
                        [5; 32],
                    ),
                }),
                reply: menu.render_text_block(),
                actions: vec![],
                menu,
                pending_action: PendingAction::ConfirmRemoteTool {
                    tool_id: "same-tool-id".into(),
                    action_token: device.into(),
                    description: "render".into(),
                },
            }
        };
        let mut state = BotChatState::new("chat".into());
        let first = make("device-a");
        let next = make("device-b");
        let ids = vec!["same-tool-id".to_string()];
        assert!(apply_interactive_request(&mut state, &first));
        assert!(!apply_interactive_request(&mut state, &next));
        assert!(retire_completed_remote_tools(
            &mut state,
            next.remote_target.as_ref().unwrap(),
            &ids
        )
        .is_none());
        assert!(state.pending_interactions.is_empty());
        assert_eq!(
            state.pending_remote_target.as_ref().unwrap().device_id,
            "device-a"
        );
        assert!(!apply_interactive_request(&mut state, &next));
        let promoted =
            retire_completed_remote_tools(&mut state, first.remote_target.as_ref().unwrap(), &ids)
                .unwrap();
        assert!(state.pending_action.is_none());
        assert!(state.last_menu_commands.is_empty());
        assert!(apply_interactive_request(&mut state, &promoted));
        assert!(retire_completed_remote_tools(
            &mut state,
            first.remote_target.as_ref().unwrap(),
            &ids
        )
        .is_none());
        assert_eq!(
            state.pending_remote_target.as_ref().unwrap().device_id,
            "device-b"
        );
    }

    #[tokio::test]
    async fn remote_turn_reconnects_delivers_interactions_and_reads_original_device_bytes() {
        for supports_interaction in [true, false] {
            assert_remote_question_round_trip(supports_interaction).await;
        }
    }

    async fn assert_remote_question_round_trip(supports_interaction: bool) {
        use openbitfun_services_integrations::remote_connect::{device_crypto, encryption};
        use std::sync::{Arc, Mutex};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let relay_url = format!("http://{}", listener.local_addr().unwrap());
        let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
        let observed = calls.clone();
        let peer_secret = [11u8; 32];
        let local_secret = [7u8; 32];
        let public = device_crypto::public_key_base64(&peer_secret);
        let key = device_crypto::derive_message_key(
            &peer_secret,
            &device_crypto::public_key(&local_secret),
        )
        .unwrap();
        let server = tokio::spawn(async move {
            use futures::{SinkExt, StreamExt};
            use tokio_tungstenite::tungstenite::{
                handshake::derive_accept_key, protocol::Role, Message,
            };
            let polls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let mut clients = tokio::task::JoinSet::new();
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let public = public.clone();
                let observed = observed.clone();
                let polls = polls.clone();
                clients.spawn(async move {
                    let mut bytes = Vec::new();
                    let header_end = loop {
                        let mut block = [0u8; 4096];
                        let count = socket.read(&mut block).await.unwrap();
                        if count == 0 { return; }
                        bytes.extend_from_slice(&block[..count]);
                        if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") { break end + 4; }
                        assert!(bytes.len() < 128 * 1024);
                    };
                    let header = std::str::from_utf8(&bytes[..header_end]).unwrap();
                    if header.starts_with("GET /api/devices/device-a/key ") {
                        let reply = serde_json::json!({"device_id":"device-a","public_key":public}).to_string();
                        let http = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", reply.len(), reply);
                        socket.write_all(http.as_bytes()).await.unwrap();
                        return;
                    }
                    assert!(header.starts_with("GET /v1/updates/"), "{header}");
                    let websocket_key = header.lines().find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("sec-websocket-key").then_some(value.trim())
                    }).unwrap();
                    let accept = derive_accept_key(websocket_key.as_bytes());
                    socket.write_all(format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n").as_bytes()).await.unwrap();
                    let mut ws = tokio_tungstenite::WebSocketStream::from_partially_read(socket, bytes[header_end..].to_vec(), Role::Server, None).await;
                    ws.send(Message::Text(r#"0{"sid":"fixture","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}"#.into())).await.unwrap();
                    while let Some(frame) = ws.next().await {
                        let Ok(Message::Text(text)) = frame else { break; };
                        if text.starts_with("40") {
                            ws.send(Message::Text(r#"40{"sid":"fixture"}"#.into())).await.unwrap();
                            ws.send(Message::Text(r#"42["auth-ok",{"userId":"test-user","deviceId":"controller"}]"#.into())).await.unwrap();
                            continue;
                        }
                        if text == "3" { continue; }
                        assert!(text.starts_with("42"), "Unexpected Socket.IO frame: {text}");
                        let array_start = text.find('[').unwrap();
                        let ack_id = &text[2..array_start];
                        let event: Value = serde_json::from_str(&text[array_start..]).unwrap();
                        assert_eq!(event[0], "rpc-call");
                        assert_eq!(event[1]["method"], "device-a:invoke");
                        let envelope = &event[1]["params"];
                        let plaintext = encryption::decrypt_from_base64(&key, envelope["encrypted_data"].as_str().unwrap(), envelope["nonce"].as_str().unwrap()).unwrap();
                        let command: Value = serde_json::from_str(&plaintext).unwrap();
                        observed.lock().unwrap().push(command.clone());
                    let response=match command["cmd"].as_str().unwrap() {
                        "send_message" => {
                            assert_eq!(command["session_id"],"session-a");
                            assert_eq!(command["image_contexts"][0]["data_url"],"data:image/png;base64,AP8B");
                            // Legacy hosts may select their own accepted turn ID.
                            serde_json::json!({"resp":"message_sent","session_id":"session-a","turn_id":"accepted-turn"})
                        }
                        "poll_session" => {
                            assert_eq!(command["session_id"],"session-a");
                            let polls = polls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                            if polls == 1 { break; } // Lost connection after submission.
                            let tool = if polls == 2 {
                                serde_json::json!({"id":"question-a","name":"AskUserQuestion","status":"running",
                                    "tool_input":{"questions":[{"question":"Format?","options":[{"label":"PNG"}]}]}})
                            } else {
                                serde_json::json!({"id":"approval-a","name":"Bash","status":"pending_confirmation","input_preview":"render image"})
                            };
                            if polls <= 3 {
                                serde_json::json!({"resp":"session_poll","version":polls,"active_turn":{"turn_id":"accepted-turn","status":"active","text":"","tools":[tool]}})
                            } else {
                                serde_json::json!({"resp":"session_poll","version":polls,
                                    "active_turn":{"turn_id":"next-turn","status":"active","text":"do not send this"},
                                    "new_messages":[{"id":"accepted-turn_assistant","role":"assistant","status":"done","content":"![image](result.png)"}]})
                            }
                        }
                        "get_workspace_info" => serde_json::json!({"resp":"workspace_info", "capabilities":
                            if supports_interaction { vec!["user_question_interaction_v1"] } else { vec![] }
                        }),
                        "start_question_interaction" => {
                            assert!(supports_interaction);
                            assert_eq!(command["session_id"], "session-a");
                            assert_eq!(command["tool_id"], "question-a");
                            serde_json::json!({"resp":"interaction_accepted", "action":"start_question_interaction", "target_id":"question-a"})
                        }
                        "answer_question" => {
                            assert_eq!(command["tool_id"],"question-a");
                            assert_eq!(command["answers"]["0"],"PNG");
                            serde_json::json!({"resp":"answer_accepted"})
                        }
                        "confirm_tool" => {
                            assert_eq!(command["tool_id"],"approval-a");
                            serde_json::json!({"resp":"interaction_accepted","action":"confirm_tool","target_id":"approval-a"})
                        }
                                                "read_file_chunk" => {
                            assert_eq!(command["session_id"],"session-a");
                            assert_eq!(command["path"],"result.png");
                            let offset = command["offset"].as_u64().unwrap();
                            assert!(command["limit"].as_u64().unwrap() <= 3 * 1024 * 1024);
                            let (count, encoded) = match offset {
                                0 => (1, "AA=="),
                                1 => (2, "/wE="),
                                other => panic!("Unexpected file offset: {other}"),
                            };
                            serde_json::json!({"resp":"file_chunk","name":"result.png","total_size":3,"offset":offset,"chunk_size":count,"mime_type":"image/png","chunk_base64":encoded,"revision":"3:1"})
                        }
                        other=>panic!("Unexpected command: {other}"),
                    };
                    let (encrypted_data, nonce) = encryption::encrypt_to_base64(&key, &response.to_string()).unwrap();
                    let response = serde_json::json!([{"ok":true,"result":{"encrypted_data":encrypted_data,"nonce":nonce}}]);
                    ws.send(Message::Text(format!("43{ack_id}{response}").into())).await.unwrap();
                    }
                });
            }
        });
        let mut state = BotChatState::new("chat".into());
        state.paired = true;
        state.relay_url = Some(relay_url);
        state.set_delegated_identity("test-token".into(), local_secret.to_vec());
        state.active_remote_device = Some(RemoteDeviceTarget {
            device_id: "device-a".into(),
            device_name: "Device A".into(),
        });
        state.current_session_id = Some("session-a".into());
        let image = crate::agentic::image_analysis::ImageContextData {
            id: "image".into(),
            image_path: None,
            data_url: Some("data:image/png;base64,AP8B".into()),
            mime_type: "image/png".into(),
            metadata: None,
        };
        let forward = handle_chat(
            &mut state,
            "render",
            vec![image],
            strings_for(BotLanguage::EnUS),
        )
        .await
        .forward_to_session
        .unwrap();
        let target = forward.remote_target.clone().unwrap();
        state.select_local_device();
        state.current_session_id = Some("unrelated-local-session".into());
        let handler: BotInteractionHandler = Arc::new(move |request| {
            Box::pin(async move {
                assert!(request.reply.contains("Device A"));
                let mut state = BotChatState::new("chat".into());
                state.current_session_id = Some("other-session".into());
                apply_interactive_request(&mut state, &request);
                let input = match &request.pending_action {
                    PendingAction::ConfirmRemoteTool { action_token, .. } => {
                        format!("approve-tool:{action_token}")
                    }
                    _ => "1".into(),
                };
                let result = route_pending(
                    &mut state,
                    request.pending_action,
                    &input,
                    strings_for(BotLanguage::EnUS),
                )
                .await;
                assert_eq!(
                    result.reply,
                    strings_for(BotLanguage::EnUS).answers_submitted
                );
                assert!(state.pending_remote_target.is_none());
            })
        });
        let fence = super::super::BotRuntimeFence::standalone();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            execute_forwarded_turn(
                forward,
                Some(handler),
                None,
                false,
                &fence,
                fence.identity_epoch(),
            ),
        )
        .await
        .unwrap();
        assert_eq!(result.full_text, "![image](result.png)");
        assert_eq!(result.completed_remote_tools.len(), 2);
        assert!(result
            .completed_remote_tools
            .contains(&"question-a".to_string()));
        assert!(result
            .completed_remote_tools
            .contains(&"approval-a".to_string()));
        let file =
            super::super::read_output_file("session-a", Some(&target), "result.png", 1024, &|| {
                true
            })
            .await
            .unwrap();
        assert_eq!(file.bytes, vec![0, 255, 1]);
        assert_eq!(
            calls
                .lock()
                .unwrap()
                .iter()
                .filter(|v| v["cmd"] == "send_message")
                .count(),
            1
        );
        let observed = calls.lock().unwrap();
        let activity = observed
            .iter()
            .position(|call| call["cmd"] == "start_question_interaction");
        let answer = observed
            .iter()
            .position(|call| call["cmd"] == "answer_question")
            .unwrap();
        assert_eq!(activity.is_some(), supports_interaction);
        if let Some(activity) = activity {
            assert!(activity < answer);
        }
        server.abort();
    }

    /// `handle_chat` must NOT push a "Processing… [Cancel Task]" interstitial
    /// to the user. The session manager queues new messages automatically;
    /// showing a cancel button just adds noise (and on WeChat costs a
    /// context_token slot per send).
    #[tokio::test]
    async fn chat_message_forwards_silently_without_processing_menu() {
        let mut state = BotChatState::new("peer".into());
        state.paired = true;
        state.current_assistant = Some("/tmp/a".into());
        state.current_session_id = Some("s1".into());
        let s = strings_for(BotLanguage::ZhCN);
        let result = handle_chat(&mut state, "hello openbitfun", vec![], s).await;

        assert!(
            result.forward_to_session.is_some(),
            "chat message must still be forwarded to the session"
        );
        assert!(
            result.menu.title.is_empty()
                && result.menu.items.is_empty()
                && result.menu.body.is_none()
                && result.menu.footer_hint.is_none(),
            "handle_chat must return an empty MenuView so adapters skip the send: {:?}",
            result.menu
        );
        assert!(
            !result.reply.contains(s.processing) && !result.reply.contains(s.queued),
            "processing/queued text must not be sent: {}",
            result.reply
        );
        assert!(
            !result.reply.contains(s.item_cancel_task),
            "cancel-task button must not be sent: {}",
            result.reply
        );
    }
}
