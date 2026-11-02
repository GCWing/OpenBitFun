//! Action semantics for the MiniAppBrowser tool.
//!
//! This layer decides what each Agent action means: which surface method it
//! maps to, which parameters it needs, and which capability it requires. It
//! holds no transport details (that is the host port) and no envelope shapes
//! (that is [`super::result`]).

use crate::agentic::tools::framework::ToolResult;
use crate::agentic::tools::miniapp_surface::{
    classify_surface_error, close_session, execute_surface, list_installed_apps, miniapp_web_host,
    open_session, parse_find_payload, parse_inspect_payload, refresh_bridge_actions,
    refresh_bridge_capabilities, resolve_target, sessions_snapshot, sessions_snapshot_all,
    MiniAppWebCommand, MiniAppWebOpenRequest, MiniAppWebSessionSnapshot,
};
use openbitfun_product_domains::miniapp::web_surface::{
    match_installed_app, validate_bridge_payload_size, MiniAppWebAppMatch, MiniAppWebAppSummary,
    MiniAppWebCapability, MiniAppWebCapture, MiniAppWebErrorCode, MiniAppWebLocator,
    MINIAPP_WEB_DEFAULT_CAPTURE_EDGE, MINIAPP_WEB_DEFAULT_WAIT_MS, MINIAPP_WEB_DEFAULT_WATCH_MS,
    MINIAPP_WEB_DEFAULT_WATCH_POLL_MS, MINIAPP_WEB_MAX_CAPTURE_EDGE, MINIAPP_WEB_MAX_DEPTH,
    MINIAPP_WEB_MAX_KEY_HOLD_MS, MINIAPP_WEB_MAX_NODES, MINIAPP_WEB_MAX_WAIT_MS,
    MINIAPP_WEB_MAX_WATCH_MS, MINIAPP_WEB_MAX_WATCH_SAMPLES, MINIAPP_WEB_MAX_WATCH_SAMPLE_BYTES,
    MINIAPP_WEB_MIN_WATCH_POLL_MS,
};
use serde_json::{json, Value};
use std::time::Duration;

use super::result::{
    err_response, missing_param, ok_response, ok_response_with_image, render_nodes, surface_error,
    target_error,
};

/// Every action the tool accepts. Parsing lives here so the schema, the
/// dispatcher, and input validation cannot drift apart.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Action {
    Open,
    Close,
    Sessions,
    /// Installed-app discovery: what exists and how it is addressed.
    Apps,
    Inspect,
    Find,
    Read,
    Click,
    Type,
    Key,
    Scroll,
    Wait,
    Screenshot,
    ObserveBridge,
    ActBridge,
    /// Bounded sampling window over the bridge: one call instead of a turn-paced
    /// observe/wait loop, which is what makes following a running app practical.
    WatchState,
}

pub(super) const ACTIONS: &[&str] = &[
    "open",
    "close",
    "sessions",
    "apps",
    "inspect",
    "find",
    "read",
    "click",
    "type",
    "key",
    "scroll",
    "wait",
    "screenshot",
    "observe_bridge",
    "act_bridge",
    "watch_state",
];

impl Action {
    pub(super) fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "open" => Some(Self::Open),
            "close" => Some(Self::Close),
            "sessions" => Some(Self::Sessions),
            "apps" => Some(Self::Apps),
            "inspect" => Some(Self::Inspect),
            "find" => Some(Self::Find),
            "read" => Some(Self::Read),
            "click" => Some(Self::Click),
            "type" => Some(Self::Type),
            "key" => Some(Self::Key),
            "scroll" => Some(Self::Scroll),
            "wait" => Some(Self::Wait),
            "screenshot" => Some(Self::Screenshot),
            "observe_bridge" => Some(Self::ObserveBridge),
            "act_bridge" => Some(Self::ActBridge),
            "watch_state" => Some(Self::WatchState),
            _ => None,
        }
    }

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Close => "close",
            Self::Sessions => "sessions",
            Self::Apps => "apps",
            Self::Inspect => "inspect",
            Self::Find => "find",
            Self::Read => "read",
            Self::Click => "click",
            Self::Type => "type",
            Self::Key => "key",
            Self::Scroll => "scroll",
            Self::Wait => "wait",
            Self::Screenshot => "screenshot",
            Self::ObserveBridge => "observe_bridge",
            Self::ActBridge => "act_bridge",
            Self::WatchState => "watch_state",
        }
    }

    /// Actions that read or write the MiniApp document need a readable frame.
    /// A key is deliberately document-independent: Canvas games and independent
    /// windows can receive it through their authenticated Shell relay.
    pub(super) fn requires_dom(self) -> bool {
        matches!(
            self,
            Self::Inspect
                | Self::Find
                | Self::Read
                | Self::Click
                | Self::Type
                | Self::Scroll
                | Self::Screenshot
        )
    }
}

pub(super) fn action_from_input(input: &Value) -> Option<Action> {
    input
        .get("action")
        .and_then(Value::as_str)
        .and_then(Action::parse)
}

pub(super) async fn dispatch(
    action: Action,
    input: &Value,
    owner_id: Option<&str>,
) -> Vec<ToolResult> {
    match action {
        Action::Sessions => list_sessions(owner_id).await,
        Action::Apps => installed_apps().await,
        Action::Open => open(input, owner_id).await,
        Action::Close => match session_for(input, owner_id).await {
            Ok(session) => close(&session, owner_id).await,
            Err(response) => response,
        },
        action => {
            let session = match session_for(input, owner_id).await {
                Ok(session) => session,
                Err(response) => return response,
            };
            if let Some(response) = dom_gate(action, &session) {
                return response;
            }
            match action {
                Action::Inspect => inspect(&session, input).await,
                Action::Find => find(&session, input).await,
                Action::Read => read(&session, input).await,
                Action::Click => click(&session, input).await,
                Action::Type => type_text(&session, input).await,
                Action::Key => press_key(&session, input).await,
                Action::Scroll => scroll(&session, input).await,
                Action::Wait => wait(&session, input).await,
                Action::Screenshot => screenshot(&session, input).await,
                Action::ObserveBridge => observe_bridge(&session).await,
                Action::ActBridge => act_bridge(&session, input).await,
                Action::WatchState => watch_state(&session, input).await,
                Action::Open | Action::Close | Action::Sessions | Action::Apps => {
                    unreachable!("handled before session resolution")
                }
            }
        }
    }
}

async fn session_for(
    input: &Value,
    owner_id: Option<&str>,
) -> Result<MiniAppWebSessionSnapshot, Vec<ToolResult>> {
    let Some(session_id) = read_string(input, "sessionId") else {
        return Err(missing_param(
            input.get("action").and_then(Value::as_str).unwrap_or("?"),
            "sessionId",
        ));
    };
    sessions_snapshot(&session_id, owner_id)
        .await
        .ok_or_else(|| {
            err_response(
                "session",
                MiniAppWebErrorCode::UnknownSession,
                format!("No MiniApp Web session '{session_id}'."),
                &["Open the MiniApp first, then reuse the returned sessionId."],
            )
        })
}

fn dom_gate(action: Action, session: &MiniAppWebSessionSnapshot) -> Option<Vec<ToolResult>> {
    if !action.requires_dom() || session.has_dom() {
        return None;
    }
    // Two different gaps look identical to a caller that only checks `capabilities`:
    // an app that has no readable document, and an app presented in its own window
    // that cannot expose DOM or pixels. Naming the right one keeps the
    // model from asking the app author for a bridge that already exists.
    let (message, hints): (&str, &[&str]) = match session.is_window_presentation() {
        true => (
            "This MiniApp runs in its own window, which cannot expose DOM structure or pixels.",
            &[
                "observe_bridge, watch_state, act_bridge, and key still reach that window.",
                "Use source-informed semantic actions on this instance. A move to a tab may reopen the document and discard unsaved state.",
            ],
        ),
        false => (
            "This MiniApp surface exposes no readable DOM, so page structure and element targets are unavailable.",
            &[
                "Report the capability gap instead of guessing internal state.",
                "Use observe_bridge and source-informed act_bridge when declared; adding missing controls is an app enhancement, not a routine operation.",
            ],
        ),
    };
    Some(err_response(
        action.as_str(),
        MiniAppWebErrorCode::CapabilityMissing,
        message,
        hints,
    ))
}

/// Forward one request through the host port, turning a typed failure into a
/// model-facing error. Every action goes through this single seam.
async fn surface_call(
    action: Action,
    session: &MiniAppWebSessionSnapshot,
    method: &str,
    params: Option<Value>,
) -> Result<Value, Vec<ToolResult>> {
    execute_surface(MiniAppWebCommand::new(
        &session.app_id,
        session.instance_id.as_deref(),
        method,
        params,
    ))
    .await
    .map_err(|(_code, message)| surface_error(action.as_str(), message))
}

/// Resolve a required `targetId` into the surface-internal node key.
async fn node_key(
    action: Action,
    session: &MiniAppWebSessionSnapshot,
    input: &Value,
) -> Result<(String, String), Vec<ToolResult>> {
    let Some(target_id) = read_string(input, "targetId") else {
        return Err(missing_param(action.as_str(), "targetId"));
    };
    let node_key = resolve_target(&session.session_id, &target_id)
        .await
        .map(|(node_key, _summary)| node_key)
        .map_err(|code| target_error(action.as_str(), code))?;
    Ok((target_id, node_key))
}

async fn list_sessions(owner_id: Option<&str>) -> Vec<ToolResult> {
    let sessions = sessions_snapshot_all(owner_id).await;
    let summary = if sessions.is_empty() {
        "No MiniApp Web sessions are open.".to_string()
    } else {
        sessions
            .iter()
            .map(|session| {
                format!(
                    "{} appId={} capabilities=[{}]",
                    session.session_id,
                    session.app_id,
                    session.capabilities.join(",")
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    ok_response(
        Action::Sessions.as_str(),
        json!({
            "sessions": sessions.iter().map(MiniAppWebSessionSnapshot::to_value).collect::<Vec<_>>(),
        }),
        summary,
    )
}

/// Installed-app discovery.
///
/// The Agent addresses an app by id, but people name apps. Without discovery the
/// model either guesses ids or reaches for host paths, so this lists what the
/// host can present with the id that addresses it.
async fn installed_apps() -> Vec<ToolResult> {
    let action = Action::Apps.as_str();
    let apps = match list_installed_apps().await {
        Ok(apps) => apps,
        Err((code, message)) => {
            return err_response(
                action,
                code,
                message,
                &["Controlling a MiniApp requires an active Desktop product surface."],
            )
        }
    };
    let summary = if apps.is_empty() {
        "No MiniApps are installed in this profile.".to_string()
    } else {
        apps.iter()
            .map(|app| {
                let strict = if app.strict_runtime {
                    " [strict runtime: bridge only]"
                } else {
                    ""
                };
                format!("{} | {} (v{}){}", app.app_id, app.name, app.version, strict)
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    ok_response(
        action,
        json!({
            "apps": apps.iter().map(MiniAppWebAppSummary::to_value).collect::<Vec<_>>(),
        }),
        summary,
    )
}

/// Resolve `appId` or `name` into one installed app id.
///
/// Resolution stays here instead of the model reading host metadata: an exact id
/// or name wins, a unique substring resolves, and anything ambiguous is reported
/// with candidates rather than guessed.
async fn resolve_app_reference(action: &str, input: &Value) -> Result<String, Vec<ToolResult>> {
    let Some(requested) = read_string(input, "appId").or_else(|| read_string(input, "name")) else {
        return Err(missing_param(action, "appId"));
    };
    let apps = match list_installed_apps().await {
        Ok(apps) => apps,
        // A host that cannot enumerate apps still accepts an explicit reference;
        // `open` then reports UNKNOWN_APP itself instead of us inventing a match.
        Err(_) => return Ok(requested),
    };
    match match_installed_app(&apps, &requested) {
        MiniAppWebAppMatch::Single(app_id) => Ok(app_id),
        MiniAppWebAppMatch::Ambiguous(ids) => Err(err_response(
            action,
            MiniAppWebErrorCode::InvalidParams,
            format!(
                "'{requested}' matches {} MiniApps: {}.",
                ids.len(),
                ids.join(", ")
            ),
            &["Pass appId to choose one of those MiniApps."],
        )),
        MiniAppWebAppMatch::Missing => {
            let hints = available_app_hints(&apps);
            let hints = hints.iter().map(String::as_str).collect::<Vec<_>>();
            Err(err_response(
                action,
                MiniAppWebErrorCode::UnknownApp,
                format!("No installed MiniApp matches '{requested}'."),
                &hints,
            ))
        }
    }
}

fn available_app_hints(apps: &[MiniAppWebAppSummary]) -> Vec<String> {
    if apps.is_empty() {
        return vec!["No MiniApps are installed in this profile.".to_string()];
    }
    let listed = apps
        .iter()
        .take(10)
        .map(|app| format!("{} ({})", app.name, app.app_id))
        .collect::<Vec<_>>();
    let mut hint = format!("Installed MiniApps: {}.", listed.join(", "));
    if apps.len() > 10 {
        hint.push_str(&format!(
            " {} more; call apps for the full list.",
            apps.len() - 10
        ));
    }
    vec![hint]
}

async fn open(input: &Value, owner_id: Option<&str>) -> Vec<ToolResult> {
    let action = Action::Open.as_str();
    let app_id = match resolve_app_reference(action, input).await {
        Ok(app_id) => app_id,
        Err(response) => return response,
    };
    let host = match miniapp_web_host() {
        Ok(host) => host,
        Err(error) => {
            return err_response(
                action,
                MiniAppWebErrorCode::SurfaceUnavailable,
                error,
                &["Controlling a MiniApp requires an active Desktop product surface."],
            )
        }
    };
    let surface = match host
        .open(MiniAppWebOpenRequest {
            app_id: app_id.clone(),
        })
        .await
    {
        Ok(surface) => surface,
        Err(error) => {
            let code = classify_surface_error(&error);
            return err_response(action, code, error, &[]);
        }
    };
    let session = open_session(surface, owner_id).await;

    let mut summary = format!(
        "Opened MiniApp '{}' ({}). capabilities=[{}]",
        session.app_id,
        session.session_id,
        session.capabilities.join(",")
    );
    summary.push_str("\nPrefer observe_bridge and source-informed act_bridge on this live instance; do not reload or edit source for routine operation.");
    summary.push_str(&open_next_step(&session));
    if session.bridge_announced() {
        summary.push_str(&format!(
            "\nAgent bridge capabilities=[{}]",
            session.bridge_capabilities.join(",")
        ));
        let declared_state = session.has_bridge_capability("observe");
        let declared_actions = session.has_bridge_capability("act");
        if !declared_state {
            summary.push_str(
                "\nobserve_bridge reports automatic observation only (animation liveness, input echo; Canvas text is unavailable). It still needs the app to declare state before it can report scores or lives by name.",
            );
        }
        if !declared_actions {
            summary.push_str(
                "\nThe app declared no semantic actions. Consult its source and use only input capabilities this surface reports, or explain the gap. Do not rewrite/reload the current app merely to operate it.",
            );
        }
    } else if session.has_dom() {
        summary.push_str("\nNo agent bridge announced yet. Try observe_bridge to resolve readiness; inspect is a fallback on readable surfaces.");
    }
    if session.strict_runtime && !session.has_dom() {
        summary.push_str(
            "\nThis MiniApp runs in the strict runtime: only bridge actions can be observed.",
        );
    }
    if session.presented_from.as_deref() == Some("window") {
        summary.push_str(
            "\nPresentation moved from a window to a tab. The document may have reopened: re-observe business state and do not assume unsaved state survived.",
        );
    }
    if session.is_window_presentation() {
        // Say which transport was attached instead of letting the model discover
        // it through a failing action: the window is the instance the user is
        // watching, and it answers only what the app itself exposes.
        summary.push_str(
            "\nYou are attached to the MiniApp's own window, the instance the user has on screen. observe_bridge, watch_state, act_bridge, and key reach it; inspect, click, type, scroll, and screenshot need a tab and are refused here.",
        );
    }
    ok_response(action, session.to_value(), summary)
}

fn open_next_step(session: &MiniAppWebSessionSnapshot) -> String {
    if session.has_dom() && !session.has_bridge_capability("act") {
        format!(
            "\nNext: call inspect with sessionId='{}', then find/read and use the supported DOM/input controls on this MiniApp. Missing semantic actions alone do not justify ComputerUse. Establish a specific unsupported operation before considering desktop fallback.",
            session.session_id
        )
    } else {
        format!(
            "\nNext: call observe_bridge with sessionId='{}' to resolve live state and bridge readiness, then use declared actions or supported input. Report a specific capability gap if this surface cannot perform the task; do not substitute another device's desktop.",
            session.session_id
        )
    }
}

async fn close(session: &MiniAppWebSessionSnapshot, owner_id: Option<&str>) -> Vec<ToolResult> {
    let action = Action::Close.as_str();
    let released = close_session(&session.session_id, owner_id).await;
    ok_response(
        action,
        json!({ "sessionId": session.session_id, "released": released }),
        format!(
            "Released MiniApp Web session {}. The app stays open for the user.",
            session.session_id
        ),
    )
}

async fn inspect(session: &MiniAppWebSessionSnapshot, _input: &Value) -> Vec<ToolResult> {
    let action = Action::Inspect.as_str();
    let payload = match surface_call(
        Action::Inspect,
        session,
        "inspect",
        Some(json!({
            "maxNodes": MINIAPP_WEB_MAX_NODES,
            "maxDepth": MINIAPP_WEB_MAX_DEPTH,
        })),
    )
    .await
    {
        Ok(payload) => payload,
        Err(response) => return response,
    };

    let (url, title, tree, node_count, truncated) = match parse_inspect_payload(&payload) {
        Ok(parsed) => parsed,
        Err(_) => {
            return err_response(
                action,
                MiniAppWebErrorCode::HostError,
                "The surface returned an unreadable page structure.",
                &["Re-run inspect; if it repeats, the MiniApp frame is not ready."],
            )
        }
    };

    let rendered = render_nodes(&session.session_id, tree).await;
    let mut summary = format!(
        "{} ({}) nodes={} capabilities=[{}]",
        title.as_deref().unwrap_or("MiniApp"),
        url.as_deref().unwrap_or(&session.app_id),
        node_count,
        session.capabilities.join(",")
    );
    if truncated {
        summary.push_str("\nStructure was truncated at the observation limits.");
    }
    if rendered.lines.is_empty() {
        summary.push_str("\nNo actionable nodes were exposed.");
    } else {
        summary.push('\n');
        summary.push_str(&rendered.lines.join("\n"));
    }

    ok_response(
        action,
        json!({
            "sessionId": session.session_id,
            "url": url,
            "title": title,
            "nodeCount": node_count,
            "truncated": truncated,
            "tree": rendered.tree,
        }),
        summary,
    )
}

async fn find(session: &MiniAppWebSessionSnapshot, input: &Value) -> Vec<ToolResult> {
    let action = Action::Find.as_str();
    let locator = input
        .get("locator")
        .cloned()
        .and_then(|value| serde_json::from_value::<MiniAppWebLocator>(value).ok())
        .unwrap_or_default()
        .sanitized();
    if locator.is_empty() {
        return err_response(
            action,
            MiniAppWebErrorCode::InvalidParams,
            "find requires a locator with at least one of testId, role, name, text, or selector.",
            &[],
        );
    }

    let mut warnings = Vec::new();
    if locator.is_selector_fallback() {
        warnings.push(
            "A CSS selector is a compatibility fallback; prefer testId or an accessible name when one exists.",
        );
    }

    let payload = match surface_call(
        Action::Find,
        session,
        "find",
        Some(json!({ "locator": locator.to_value() })),
    )
    .await
    {
        Ok(payload) => payload,
        Err(response) => return response,
    };

    let rendered = render_nodes(&session.session_id, parse_find_payload(&payload)).await;
    let count = rendered
        .tree
        .as_array()
        .map(|matches| matches.len())
        .unwrap_or(0);

    let mut summary = if count == 0 {
        "No node matched the locator.".to_string()
    } else {
        rendered.lines.join("\n")
    };
    for warning in &warnings {
        summary.push_str("\n- ");
        summary.push_str(warning);
    }

    ok_response(
        action,
        json!({
            "sessionId": session.session_id,
            "matches": rendered.tree,
            "warnings": warnings,
        }),
        summary,
    )
}

async fn read(session: &MiniAppWebSessionSnapshot, input: &Value) -> Vec<ToolResult> {
    let action = Action::Read.as_str();
    let (target_id, node_key) = match node_key(Action::Read, session, input).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let payload = match surface_call(
        Action::Read,
        session,
        "read",
        Some(json!({
            "nodeKey": node_key,
            "attribute": read_string(input, "attribute"),
        })),
    )
    .await
    {
        Ok(payload) => payload,
        Err(response) => return response,
    };

    let text = payload.get("text").cloned().unwrap_or(Value::Null);
    let value = payload.get("value").cloned().unwrap_or(Value::Null);
    let summary = format!(
        "text={} value={} attributes={}",
        text.as_str().unwrap_or("null"),
        value.as_str().unwrap_or("null"),
        payload
            .get("attributes")
            .cloned()
            .unwrap_or_else(|| json!({}))
    );
    ok_response(
        action,
        json!({
            "sessionId": session.session_id,
            "targetId": target_id,
            "text": text,
            "value": value,
            "attributes": payload.get("attributes").cloned().unwrap_or_else(|| json!({})),
        }),
        summary,
    )
}

async fn click(session: &MiniAppWebSessionSnapshot, input: &Value) -> Vec<ToolResult> {
    let action = Action::Click.as_str();
    let position = match click_position(session, input) {
        Ok(position) => position,
        Err(response) => return response,
    };
    let (target_id, node_key) = match node_key(Action::Click, session, input).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let mut params = json!({ "nodeKey": node_key });
    if let Some(position) = position {
        params["position"] = position;
    }
    match surface_call(Action::Click, session, "click", Some(params)).await {
        Ok(payload) => ok_response(
            action,
            json!({ "sessionId": session.session_id, "targetId": target_id, "result": payload }),
            format!(
                "Clicked {target_id}. Inspect or wait then inspect to confirm the page updated."
            ),
        ),
        Err(response) => response,
    }
}

fn click_position(
    session: &MiniAppWebSessionSnapshot,
    input: &Value,
) -> Result<Option<Value>, Vec<ToolResult>> {
    let Some(position) = input.get("position") else {
        return Ok(None);
    };
    let valid = position.is_object()
        && ["x", "y"].iter().all(|axis| {
            position
                .get(axis)
                .and_then(Value::as_f64)
                .is_some_and(|value| value.is_finite() && (0.0..1.0).contains(&value))
        });
    if !valid {
        return Err(err_response(
            "click",
            MiniAppWebErrorCode::InvalidParams,
            "position requires numeric x and y fractions in [0, 1).",
            &[],
        ));
    }
    if !session.has_capability(MiniAppWebCapability::ElementPositionClick) {
        return Err(err_response(
            "click", MiniAppWebErrorCode::CapabilityMissing,
            "This MiniApp host does not advertise element-position-click-v1; the positioned click was not sent.",
            &["Use existing element/bridge controls or update the owning host. Do not retry this as a plain click: that changes the intended target position."],
        ));
    }
    Ok(Some(position.clone()))
}

async fn type_text(session: &MiniAppWebSessionSnapshot, input: &Value) -> Vec<ToolResult> {
    let action = Action::Type.as_str();
    let Some(text) = input.get("text").and_then(Value::as_str) else {
        return missing_param(action, "text");
    };
    let (target_id, node_key) = match node_key(Action::Type, session, input).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let clear = input.get("clear").and_then(Value::as_bool).unwrap_or(true);
    match surface_call(
        Action::Type,
        session,
        "type",
        Some(json!({ "nodeKey": node_key, "text": text, "clear": clear })),
    )
    .await
    {
        Ok(payload) => ok_response(
            action,
            json!({ "sessionId": session.session_id, "targetId": target_id, "result": payload }),
            format!(
                "Entered {} characters into {target_id}.",
                text.chars().count()
            ),
        ),
        Err(response) => response,
    }
}

async fn press_key(session: &MiniAppWebSessionSnapshot, input: &Value) -> Vec<ToolResult> {
    let action = Action::Key.as_str();
    let Some(key) = read_string(input, "key") else {
        return missing_param(action, "key");
    };
    let modifiers = input
        .get("modifiers")
        .and_then(Value::as_array)
        .map(|modifiers| {
            modifiers
                .iter()
                .filter_map(Value::as_str)
                .map(|value| value.to_ascii_lowercase())
                .filter(|value| matches!(value.as_str(), "alt" | "control" | "meta" | "shift"))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    // A game reads a held key on its own animation frame, so a zero-length press
    // is invisible to it. `holdMs` keeps the key down long enough to matter.
    let hold_ms = input
        .get("holdMs")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value as u64)
        .unwrap_or(0)
        .min(MINIAPP_WEB_MAX_KEY_HOLD_MS);
    match surface_call(
        Action::Key,
        session,
        "key",
        Some(json!({ "key": key, "modifiers": modifiers, "holdMs": hold_ms })),
    )
    .await
    {
        Ok(payload) => ok_response(
            action,
            json!({ "sessionId": session.session_id, "key": key, "holdMs": hold_ms, "result": payload }),
            match hold_ms {
                0 => format!("Sent key {key}."),
                _ => format!("Held key {key} for {hold_ms}ms."),
            },
        ),
        Err(response) => response,
    }
}

async fn scroll(session: &MiniAppWebSessionSnapshot, input: &Value) -> Vec<ToolResult> {
    let action = Action::Scroll.as_str();
    let delta_x = input.get("deltaX").and_then(Value::as_f64).unwrap_or(0.0);
    let delta_y = input.get("deltaY").and_then(Value::as_f64).unwrap_or(0.0);
    if delta_x == 0.0 && delta_y == 0.0 {
        return err_response(
            action,
            MiniAppWebErrorCode::InvalidParams,
            "scroll requires a non-zero deltaX or deltaY.",
            &[],
        );
    }
    let node_key = match read_string(input, "targetId") {
        Some(target_id) => match resolve_target(&session.session_id, &target_id).await {
            Ok((node_key, _summary)) => Some(node_key),
            Err(code) => return target_error(action, code),
        },
        None => None,
    };
    match surface_call(
        Action::Scroll,
        session,
        "scroll",
        Some(json!({ "nodeKey": node_key, "deltaX": delta_x, "deltaY": delta_y })),
    )
    .await
    {
        Ok(payload) => ok_response(
            action,
            json!({
                "sessionId": session.session_id,
                "scroll": { "deltaX": delta_x, "deltaY": delta_y },
                "result": payload,
            }),
            format!("Scrolled deltaX={delta_x} deltaY={delta_y}."),
        ),
        Err(response) => response,
    }
}

/// `wait` never touches the surface: animations, network calls, and game loops
/// only need an observation interval, and the model re-observes afterwards.
async fn wait(session: &MiniAppWebSessionSnapshot, input: &Value) -> Vec<ToolResult> {
    let requested = input
        .get("durationMs")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value as u64)
        .unwrap_or(MINIAPP_WEB_DEFAULT_WAIT_MS)
        .min(MINIAPP_WEB_MAX_WAIT_MS);
    tokio::time::sleep(Duration::from_millis(requested)).await;
    ok_response(
        Action::Wait.as_str(),
        json!({ "sessionId": session.session_id, "waitedMs": requested }),
        format!("Waited {requested}ms. Re-run inspect to observe the updated page."),
    )
}

/// Capture the MiniApp frame and hand the pixels to the model.
///
/// A canvas or game MiniApp has no readable structure, so this is the only live
/// observation available: the Agent looks at what the app is drawing right now,
/// then acts, then looks again. Sampling is turn-paced, which is the honest
/// ceiling for a tool-using model; anything faster has to be a MiniApp-declared
/// bridge action that runs inside the app.
async fn screenshot(session: &MiniAppWebSessionSnapshot, input: &Value) -> Vec<ToolResult> {
    let action = Action::Screenshot.as_str();
    let max_edge = input
        .get("maxEdge")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value as u32)
        .unwrap_or(MINIAPP_WEB_DEFAULT_CAPTURE_EDGE)
        .clamp(320, MINIAPP_WEB_MAX_CAPTURE_EDGE);
    let payload = match surface_call(
        Action::Screenshot,
        session,
        "capture",
        Some(json!({ "maxEdge": max_edge })),
    )
    .await
    {
        Ok(payload) => payload,
        Err(response) => return response,
    };

    let capture = match MiniAppWebCapture::parse(&payload) {
        Ok(capture) => capture,
        Err(code) => {
            return err_response(
                action,
                code,
                "The surface returned an unusable frame capture.",
                &["Re-run screenshot; if it repeats, this MiniApp paints nothing that can be captured."],
            )
        }
    };

    let summary = format!(
        "Captured {}x{} from {} ({}). This is one frame at capture time; wait, act, then screenshot again to follow the app state.",
        capture.width,
        capture.height,
        capture.label.as_deref().unwrap_or(&capture.source),
        capture.mime_type
    );
    ok_response_with_image(
        action,
        json!({
            "sessionId": session.session_id,
            "width": capture.width,
            "height": capture.height,
            "source": capture.source,
            "label": capture.label,
            "mimeType": capture.mime_type,
            "bytes": capture.decoded_len(),
        }),
        summary,
        crate::util::types::ToolImageAttachment {
            mime_type: capture.mime_type,
            data_base64: capture.data_base64,
        },
    )
}

async fn observe_bridge(session: &MiniAppWebSessionSnapshot) -> Vec<ToolResult> {
    let action = Action::ObserveBridge.as_str();
    // Automatic observation needs no app declaration, so only a frame that
    // announced an older bridge without either capability is refused.
    let can_observe =
        session.has_bridge_capability("observe") || session.has_bridge_capability("auto-observe");
    if session.bridge_announced() && !can_observe {
        return err_response(
            action,
            MiniAppWebErrorCode::BridgeUnavailable,
            "This MiniApp announced no observation capability.",
            &[
                "Only the MiniApp decides which internal state is Agent-visible; the host will not guess variable names.",
                "DOM actions remain available if the surface reports dom.",
            ],
        );
    }
    match surface_call(
        Action::ObserveBridge,
        session,
        "bridge_observe",
        Some(json!({ "requestId": request_id("observe") })),
    )
    .await
    {
        Ok(payload) => {
            store_bridge_capabilities(session, &payload).await;
            let state = payload.get("state").cloned().unwrap_or(Value::Null);
            let auto = payload.get("auto").cloned().unwrap_or(Value::Null);
            let actions = payload
                .get("actions")
                .cloned()
                .unwrap_or_else(|| json!(session.declared_actions));
            let summary = match state.is_null() {
                true => format!(
                    "No declared state ({}). Automatic observation: {}",
                    session.app_id,
                    describe_auto_observation(&auto)
                ),
                false => format!(
                    "Bridge state: {}\nAutomatic observation: {}",
                    state,
                    describe_auto_observation(&auto)
                ),
            };
            let summary = format!("{summary}\n{}", describe_declared_actions(&actions));
            ok_response(
                action,
                json!({
                    "sessionId": session.session_id,
                    "state": state,
                    "auto": auto,
                    "bridgeCapabilities": payload
                        .get("capabilities")
                        .cloned()
                        .unwrap_or_else(|| json!(session.bridge_capabilities)),
                    "declaredActions": actions,
                }),
                summary,
            )
        }
        Err(response) => response,
    }
}

/// Render the declared action vocabulary in the same one-line shape as the rest
/// of an observation, so the Agent never has to guess action names.
fn describe_declared_actions(actions: &Value) -> String {
    let names: Vec<&str> = actions
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if names.is_empty() {
        return "declared actions: unknown; inspect the source for accepted action types and parameters before acting. Do not guess."
            .to_string();
    }
    let mut joined = names.join(", ");
    if joined.chars().count() > 240 {
        joined = joined.chars().take(240).collect::<String>() + " ...";
    }
    format!("declared actions: {joined}")
}

/// Summarize animation activity and input delivery. Legacy canvas text is draw history,
/// never evidence of current screen content.
fn describe_auto_observation(auto: &Value) -> String {
    if auto.is_null() {
        return "none (the MiniApp did not report automatic observation).".to_string();
    }
    let mut parts =
        vec!["Canvas text unavailable as live state; use declared state or screenshot".to_string()];
    match auto.get("frameAgeMs").and_then(Value::as_u64) {
        Some(age) => parts.push(format!("animation frame {age}ms ago")),
        None => parts.push("no animation frames yet (static or paused)".to_string()),
    }
    if let Some(input) = auto.get("input").filter(|value| !value.is_null()) {
        let kind = input.get("type").and_then(Value::as_str).unwrap_or("input");
        let key = input
            .get("key")
            .map(Value::to_string)
            .unwrap_or_else(|| "null".to_string());
        parts.push(format!("last input: {kind} {key}"));
    }
    parts.join(", ")
}

/// Sample the bridge over a bounded window and report the timeline.
///
/// A running app changes faster than a turn can read it, and calling
/// `observe_bridge` in a loop costs one model round per sample. This owns that
/// loop so one action replaces a whole turn-paced conversation, and it samples
/// through `observe` only: whatever presentation is hosting the app — a tab or
/// its own window — stays a transport detail below this line.
async fn watch_state(session: &MiniAppWebSessionSnapshot, input: &Value) -> Vec<ToolResult> {
    let action = Action::WatchState.as_str();
    let can_observe =
        session.has_bridge_capability("observe") || session.has_bridge_capability("auto-observe");
    if session.bridge_announced() && !can_observe {
        return err_response(
            action,
            MiniAppWebErrorCode::BridgeUnavailable,
            "This MiniApp announced no observation capability.",
            &["Without observable state there is nothing to sample; use screenshot for pixels."],
        );
    }
    let duration_ms = read_u64(input, "durationMs")
        .unwrap_or(MINIAPP_WEB_DEFAULT_WATCH_MS)
        .clamp(MINIAPP_WEB_MIN_WATCH_POLL_MS, MINIAPP_WEB_MAX_WATCH_MS);
    let poll_ms = read_u64(input, "pollMs")
        .unwrap_or(MINIAPP_WEB_DEFAULT_WATCH_POLL_MS)
        .clamp(MINIAPP_WEB_MIN_WATCH_POLL_MS, duration_ms);

    let started = std::time::Instant::now();
    let mut samples: Vec<Value> = Vec::new();
    let mut last_key = String::new();
    let mut budget = 0usize;
    let mut declared = false;
    let mut stop_reason = "duration";
    let mut warning: Option<String> = None;
    // The session snapshot predates this call; a sample can announce capabilities
    // the caller did not know yet, and the timeline must report what it observed.
    let mut capabilities = session.bridge_capabilities.clone();

    loop {
        let payload = match surface_call(
            Action::WatchState,
            session,
            "bridge_observe",
            Some(json!({ "requestId": request_id("watch") })),
        )
        .await
        {
            Ok(payload) => payload,
            // A failure before the first sample is the outcome. After that, the
            // timeline already collected is evidence, so keep it and say why the
            // window ended early.
            Err(response) if samples.is_empty() => return response,
            Err(response) => {
                warning = response[0]
                    .content()
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                stop_reason = "error";
                break;
            }
        };
        store_bridge_capabilities(session, &payload).await;
        if let Some(observed) =
            payload
                .get("capabilities")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
        {
            capabilities = observed;
        }
        let auto = payload.get("auto").cloned().unwrap_or(Value::Null);
        declared = auto.get("source").and_then(Value::as_str) == Some("declared");
        // A declared state is authoritative; otherwise the sampled value is the
        // compact form of automatic observation.
        let value = match payload.get("state") {
            Some(state) if !state.is_null() => state.clone(),
            _ => compact_auto(&auto),
        };
        let key = value.to_string();
        // The first sample always lands, so an app that never changes still
        // proves it was observed; later samples only appear when state moved.
        if samples.is_empty() || key != last_key {
            last_key = key;
            budget += value.to_string().len();
            samples.push(json!({ "t": started.elapsed().as_millis() as u64, "state": value }));
            if samples.len() >= MINIAPP_WEB_MAX_WATCH_SAMPLES {
                stop_reason = "cap";
                break;
            }
            if budget >= MINIAPP_WEB_MAX_WATCH_SAMPLE_BYTES {
                stop_reason = "size";
                break;
            }
        }
        let elapsed = started.elapsed().as_millis() as u64;
        if elapsed >= duration_ms {
            break;
        }
        let remaining = duration_ms - elapsed;
        tokio::time::sleep(Duration::from_millis(poll_ms.min(remaining))).await;
    }

    let count = samples.len();
    let mut body = json!({
        "sessionId": session.session_id,
        "durationMs": duration_ms,
        "pollMs": poll_ms,
        "sampleCount": count,
        "stopReason": stop_reason,
        "declared": declared,
        "samples": samples,
        "bridgeCapabilities": capabilities,
    });
    if let Some(warning) = &warning {
        body["warning"] = json!(warning);
    }
    ok_response(
        action,
        body,
        format!(
            "Sampled {} change(s) over {duration_ms}ms at {poll_ms}ms intervals ({stop_reason}). {}",
            count,
            match declared {
                true => "Samples are the app's declared state.",
                false => "Samples are automatic observation; the app declared no state.",
            }
        ),
    )
}

/// Keep one sampled observation small enough that a timeline of them still fits
/// a single tool response: animation activity and the last input.
fn compact_auto(auto: &Value) -> Value {
    json!({
        "source": auto.get("source").cloned().unwrap_or_else(|| json!("auto")),
        "canvasTextUnavailable": true,
        "frames": auto.get("frames").cloned().unwrap_or(Value::Null),
        "frameAgeMs": auto.get("frameAgeMs").cloned().unwrap_or(Value::Null),
        "input": auto.get("input").cloned().unwrap_or(Value::Null),
    })
}

async fn act_bridge(session: &MiniAppWebSessionSnapshot, input: &Value) -> Vec<ToolResult> {
    let action = Action::ActBridge.as_str();
    if session.bridge_announced() && !session.has_bridge_capability("act") {
        return err_response(
            action,
            MiniAppWebErrorCode::BridgeUnavailable,
            "This MiniApp does not declare the 'act' agent bridge capability.",
            &[],
        );
    }
    let Some(bridge_action) = input.get("bridgeAction").cloned() else {
        return missing_param(action, "bridgeAction");
    };
    let has_type = bridge_action
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    if !has_type {
        return err_response(
            action,
            MiniAppWebErrorCode::InvalidParams,
            "act_bridge requires bridgeAction.type.",
            &[],
        );
    }
    if validate_bridge_payload_size(&bridge_action).is_err() {
        return err_response(
            action,
            MiniAppWebErrorCode::InvalidParams,
            "The bridge action payload is too large.",
            &[],
        );
    }
    match surface_call(
        Action::ActBridge,
        session,
        "bridge_act",
        Some(json!({
            "requestId": request_id("act"),
            "action": bridge_action,
        })),
    )
    .await
    {
        Ok(payload) => {
            store_bridge_capabilities(session, &payload).await;
            let result = payload.get("result").cloned().unwrap_or(Value::Null);
            let summary = match result.is_null() {
                true => "Bridge action completed.".to_string(),
                false => format!("Bridge action result: {result}"),
            };
            ok_response(
                action,
                json!({ "sessionId": session.session_id, "result": result }),
                summary,
            )
        }
        Err(response) => response,
    }
}

/// The MiniApp is authoritative for what it declared; keep the session in step
/// so later calls gate on the announcement instead of a stale `open` snapshot.
async fn store_bridge_capabilities(session: &MiniAppWebSessionSnapshot, payload: &Value) {
    if let Some(capabilities) = payload.get("capabilities") {
        if let Ok(capabilities) = serde_json::from_value::<Vec<String>>(capabilities.clone()) {
            refresh_bridge_capabilities(&session.session_id, capabilities).await;
        }
    }
    if let Some(actions) = payload.get("actions") {
        if let Ok(actions) = serde_json::from_value::<Vec<String>>(actions.clone()) {
            refresh_bridge_actions(&session.session_id, actions).await;
        }
    }
}

fn request_id(method: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!(
        "miniapp-{method}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

fn read_string(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn read_u64(input: &Value, key: &str) -> Option<u64> {
    input.get(key).and_then(|value| match value {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opened_legacy_apps_are_directed_to_dom_instead_of_desktop_fallback() {
        let hint = open_next_step(&session(&["dom", "input"], &["auto-observe"]));
        assert!(hint.contains("call inspect with sessionId='miniapp-session-1'"));
        assert!(hint.contains("Missing semantic actions alone do not justify ComputerUse"));
        let bridge = open_next_step(&session(&[], &["observe", "act"]));
        assert!(bridge.contains("call observe_bridge"));
        assert!(!bridge.contains("call inspect"));
        let unavailable = open_next_step(&session(&[], &[]));
        assert!(unavailable.contains("capability gap"));
        assert!(unavailable.contains("another device's desktop"));
    }

    #[test]
    fn positioned_clicks_negotiate_support_and_keep_legacy_clicks_working() {
        let legacy = session(&["dom", "input"], &[]);
        assert_eq!(click_position(&legacy, &json!({})).unwrap(), None);
        let request = json!({ "position": { "x": 0.25, "y": 0.75 } });
        let error = click_position(&legacy, &request).unwrap_err();
        assert_eq!(error[0].content()["error"]["code"], "CAPABILITY_MISSING");
        let current = session(&["dom", "input", "element-position-click-v1"], &[]);
        assert_eq!(
            click_position(&current, &request).unwrap(),
            Some(request["position"].clone())
        );
        for position in [
            json!(null),
            json!({}),
            json!({ "x": "0.5", "y": 0.5 }),
            json!({ "x": -0.1, "y": 0 }),
            json!({ "x": 0.5, "y": 1 }),
        ] {
            let error = click_position(&current, &json!({ "position": position })).unwrap_err();
            assert_eq!(error[0].content()["error"]["code"], "INVALID_PARAMS");
        }
    }

    fn session(capabilities: &[&str], bridge: &[&str]) -> MiniAppWebSessionSnapshot {
        MiniAppWebSessionSnapshot {
            session_id: "miniapp-session-1".to_string(),
            app_id: "demo".to_string(),
            instance_id: None,
            strict_runtime: false,
            width: None,
            height: None,
            capabilities: capabilities.iter().map(|value| value.to_string()).collect(),
            bridge_capabilities: bridge.iter().map(|value| value.to_string()).collect(),
            declared_actions: Vec::new(),
            presented_from: None,
            presentation: None,
            target_count: 0,
        }
    }

    /// A host whose declared state moves on its own, standing in for a running app.
    struct MovingHost {
        calls: std::sync::atomic::AtomicUsize,
    }

    #[async_trait::async_trait]
    impl crate::agentic::tools::miniapp_surface::MiniAppWebHost for MovingHost {
        async fn open(
            &self,
            request: crate::agentic::tools::miniapp_surface::MiniAppWebOpenRequest,
        ) -> Result<openbitfun_product_domains::miniapp::web_surface::MiniAppWebSurfaceInfo, String>
        {
            use openbitfun_product_domains::miniapp::web_surface::MiniAppWebSurfaceInfo;
            Ok(MiniAppWebSurfaceInfo {
                app_id: request.app_id,
                ..Default::default()
            })
        }

        async fn execute(&self, _command: MiniAppWebCommand) -> Result<Value, String> {
            let call = self
                .calls
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            // Every other read repeats the previous value, so deduplication is
            // observable instead of being masked by a fast-changing fake.
            Ok(json!({
                "state": { "score": call / 2 },
                "auto": { "source": "declared" },
                "capabilities": ["observe", "act"],
            }))
        }
    }

    #[tokio::test]
    async fn watch_state_samples_a_timeline_and_drops_repeats() {
        let _guard = crate::agentic::tools::miniapp_surface::HOST_SLOT_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        crate::agentic::tools::miniapp_surface::set_miniapp_web_host(std::sync::Arc::new(
            MovingHost {
                calls: std::sync::atomic::AtomicUsize::new(0),
            },
        ));
        let response = watch_state(
            &session(&[], &[]),
            &json!({ "durationMs": 800, "pollMs": 250 }),
        )
        .await;
        let body = response[0].content();
        assert_eq!(body["ok"], true, "{body}");
        let data = &body["data"];
        assert_eq!(data["stopReason"], "duration");
        assert_eq!(data["declared"], true, "a declared state is authoritative");
        assert_eq!(data["bridgeCapabilities"], json!(["observe", "act"]));
        let samples = data["samples"].as_array().expect("samples");
        assert!(samples.len() >= 2, "the timeline must move: {body}");
        assert_eq!(
            samples[0]["state"]["score"], 0,
            "the first sample always lands"
        );
        assert!(
            samples.len() <= 4,
            "repeats are dropped instead of padding the timeline: {body}"
        );
        let last = samples.last().expect("last sample");
        assert!(last["state"]["score"].as_u64() > samples[0]["state"]["score"].as_u64());
        assert!(last["t"].as_u64().unwrap_or(0) > 0);
    }

    #[test]
    fn action_parsing_matches_the_published_list() {
        for name in ACTIONS {
            assert!(Action::parse(name).is_some(), "{name} must parse");
        }
        assert_eq!(Action::parse("evaluate"), None);
        assert_eq!(
            action_from_input(&json!({ "action": " inspect " })),
            Some(Action::Inspect)
        );
        assert_eq!(action_from_input(&json!({})), None);
    }

    #[test]
    fn dom_gate_only_blocks_document_actions_on_opaque_surfaces() {
        let opaque = session(&[], &["observe"]);
        assert!(dom_gate(Action::Inspect, &opaque).is_some());
        assert!(dom_gate(Action::Click, &opaque).is_some());
        assert!(dom_gate(Action::Wait, &opaque).is_none());
        assert!(dom_gate(Action::ObserveBridge, &opaque).is_none());

        let readable = session(&["dom", "input"], &[]);
        assert!(dom_gate(Action::Inspect, &readable).is_none());
    }

    #[test]
    fn a_window_presentation_reports_the_transport_gap_not_a_missing_bridge() {
        let mut window = session(&[], &["auto-observe"]);
        window.presentation = Some("window".to_string());
        let response = dom_gate(Action::Screenshot, &window).expect("window blocks pixels");
        let body = response[0].content();
        assert_eq!(body["error"]["code"], "CAPABILITY_MISSING");
        let message = body["error"]["message"].as_str().unwrap_or_default();
        assert!(message.contains("own window"), "{message}");
        assert!(body["error"]["hints"][0]
            .as_str()
            .unwrap_or_default()
            .contains("act_bridge"));
        // The bridge actions themselves are never gated by a missing DOM.
        assert!(dom_gate(Action::ObserveBridge, &window).is_none());
        assert!(dom_gate(Action::WatchState, &window).is_none());
        // Key input is relayed by the independent Shell, so Canvas games do not
        // need to be moved into a tab just to receive ArrowRight/Space.
        assert!(dom_gate(Action::Key, &window).is_none());
    }

    #[tokio::test]
    async fn missing_targets_are_reported_before_reaching_the_surface() {
        let response = node_key(Action::Click, &session(&["dom"], &[]), &json!({})).await;
        assert!(response.is_err(), "targetId is required");
        let body = response.err().expect("error response")[0].content();
        assert_eq!(body["error"]["code"], "INVALID_PARAMS");
    }

    #[test]
    fn blank_strings_never_count_as_parameters() {
        assert_eq!(read_string(&json!({ "appId": "   " }), "appId"), None);
        assert_eq!(
            read_string(&json!({ "appId": " demo " }), "appId"),
            Some("demo".to_string())
        );
    }

    #[test]
    fn auto_observation_never_treats_legacy_draw_history_as_live_state() {
        let auto = json!({
            "canvasText": [{ "text": "SCORE 1200", "x": 10, "y": 20 }, { "text": "WAVE 3", "x": 10, "y": 40 }],
            "frameAgeMs": 16,
            "input": { "type": "keydown", "key": "ArrowLeft", "at": 1 },
        });
        let summary = describe_auto_observation(&auto);
        assert!(!summary.contains("SCORE 1200"), "{summary}");
        assert!(summary.contains("Canvas text unavailable"), "{summary}");
        let sampled = compact_auto(&auto);
        assert_eq!(sampled["canvasTextUnavailable"], true);
        assert!(sampled.get("canvasText").is_none());
        assert!(summary.contains("animation frame 16ms ago"), "{summary}");
        assert!(summary.contains("keydown"), "{summary}");

        let idle = json!({ "canvasText": [], "frameAgeMs": null, "input": null });
        let summary = describe_auto_observation(&idle);
        assert!(summary.contains("Canvas text unavailable"), "{summary}");
        assert!(summary.contains("no animation frames yet"), "{summary}");
        assert!(describe_auto_observation(&Value::Null).contains("none"));
    }

    #[test]
    fn automatic_observation_needs_no_declared_capability() {
        // The injected runtime always announces auto-observe, so a session that
        // never declared state must not be treated as unobservable.
        let auto_only = session(&["dom"], &["auto-observe"]);
        assert!(auto_only.has_bridge_capability("auto-observe"));
        assert!(!auto_only.has_bridge_capability("observe"));
        assert!(!auto_only.has_bridge_capability("act"));
        assert!(dom_gate(Action::ObserveBridge, &auto_only).is_none());
        assert!(dom_gate(Action::ActBridge, &auto_only).is_none());
    }

    #[tokio::test]
    async fn watch_state_needs_observation_and_never_needs_a_dom() {
        // A bridge that only exposes actions has nothing to sample, and the refusal
        // must happen before any surface call.
        let actions_only = session(&[], &["act"]);
        let refused = watch_state(&actions_only, &json!({ "durationMs": 1000 })).await;
        let body = refused[0].content();
        assert_eq!(body["error"]["code"], "BRIDGE_UNAVAILABLE");

        // Sampling is state-based, so an opaque frame with automatic observation is
        // allowed through the gate.
        assert!(!Action::WatchState.requires_dom());
        assert!(dom_gate(Action::WatchState, &session(&[], &["auto-observe"])).is_none());
    }

    #[test]
    fn the_declared_action_vocabulary_reaches_the_model() {
        // The app's own words, in announcement order, are what the Agent needs to
        // stop guessing action names.
        let declared = json!(["start", "restart", "autoplay"]);
        let summary = describe_declared_actions(&declared);
        assert!(summary.contains("start, restart, autoplay"), "{summary}");

        // An app that declares nothing is reported as unknown, never as "accepts
        // nothing": undeclared names must stay attemptable.
        let empty = describe_declared_actions(&json!([]));
        assert!(empty.contains("declared actions: unknown"), "{empty}");
        assert!(empty.contains("inspect the source"), "{empty}");
        assert!(describe_declared_actions(&Value::Null).contains("Do not guess"));

        // A verbose app cannot flood the turn with one observation.
        let many = json!((0..40)
            .map(|index| format!("action-{index}"))
            .collect::<Vec<_>>());
        assert!(describe_declared_actions(&many).chars().count() <= 300);
    }

    #[test]
    fn app_hints_stay_bounded_and_actionable() {
        let apps = (0..14)
            .map(|index| MiniAppWebAppSummary {
                app_id: format!("app-{index}"),
                name: format!("App {index}"),
                ..Default::default()
            })
            .collect::<Vec<_>>();
        let hints = available_app_hints(&apps);
        assert_eq!(hints.len(), 1);
        assert!(hints[0].contains("App 0 (app-0)"));
        assert!(hints[0].contains("4 more"), "the tail must be summarized");
        assert_eq!(
            available_app_hints(&[]),
            vec!["No MiniApps are installed in this profile.".to_string()]
        );
    }
}
