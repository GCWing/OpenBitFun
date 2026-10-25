//! DesktopCard tool: small always-available cards outside the main window.

use crate::agentic::tools::desktop_card_host::{
    desktop_card_command_shell_label, desktop_card_host_available, desktop_card_template_paths,
    invoke_desktop_card_host, validate_data, validate_data_source, validate_icon, validate_size,
    validate_subtitle, validate_template, validate_title, validate_tone, validate_web_url,
    DesktopCardDataSourceKind, DesktopCardDraft, DesktopCardHostRequest, DesktopCardOrigin,
    DesktopCardPatch, DesktopCardSize, DesktopCardTemplateKind, DESKTOP_CARD_CHART_STYLES,
    DESKTOP_CARD_ICONS,
};
use crate::agentic::tools::framework::{PermissionIntent, Tool, ToolResult, ToolUseContext};
use crate::agentic::tools::implementations::ExecCommandTool;
use crate::service::config::global::GlobalConfigManager;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use chrono::DateTime;
use openbitfun_agent_runtime::remote_file_delivery::TOOL_CONTEXT_REMOTE_FILE_DELIVERY_KEY;
use serde_json::{json, Map, Value};

pub const DESKTOP_CARDS_CONFIG_PATH: &str = "app.ai_experience.enable_desktop_cards";
const MAX_COUNTDOWN_SECONDS: i64 = 366 * 24 * 60 * 60;
const MAX_VALUE_PREVIEW_CHARS: usize = 400;

const TEMPLATE_SHAPES: &[(&str, &str)] = &[
    (
        "countdown",
        r#"{"kind":"countdown","durationSeconds":900,"message":"Join the stand-up"} (or targetAt as ISO-8601 with offset)"#,
    ),
    (
        "checklist",
        r#"{"kind":"checklist","items":[{"id":"tag","text":"Push the tag","done":false}]}"#,
    ),
    ("note", r#"{"kind":"note","text":"Port 5173"}"#),
    (
        "progress",
        r#"{"kind":"progress","valuePath":"/done","maxPath":"/total","statusPath":"/status"}"#,
    ),
    (
        "metrics",
        r#"{"kind":"metrics","layout":"grid","items":[{"label":"Stars","path":"/stars","format":"number"}]}"#,
    ),
    (
        "chart",
        r#"{"kind":"chart","chart":"bar","suffix":" GB","items":[{"label":"npm cache","value":4.12,"hint":"npm cache clean --force"}]} (chart: bar|column|line|donut|stacked; or itemsPath into the card data instead of items)"#,
    ),
    (
        "cronJob",
        r#"{"kind":"cronJob","jobId":"<id returned by Cron>"}"#,
    ),
    (
        "custom",
        r#"{"kind":"custom","html":"<div id=\"v\"></div><script>...</script>"}"#,
    ),
];

const DATA_SOURCE_SHAPES: &str = r#"{"kind":"http","url":"https://...","intervalSeconds":300,"parse":"json"} or {"kind":"command","command":"...","intervalSeconds":300,"timeoutSeconds":30,"parse":"json"}"#;

/// Template-only fields that models sometimes put on the card or in data.
const MISPLACEABLE_TEMPLATE_FIELDS: &[&str] = &[
    "items",
    "layout",
    "durationSeconds",
    "targetAt",
    "targetAtMs",
    "valuePath",
    "maxPath",
    "statusPath",
    "chart",
    "itemsPath",
    "labelsPath",
    "totalPath",
    "remainderLabel",
    "caption",
    "jobId",
    "html",
];

const PULL_REQUEST_STATUS_COMMAND_SH: &str = r#"gh pr view 123 --repo owner/repo --json state,reviewDecision,mergeable,statusCheckRollup --jq '{state, review: (.reviewDecision // "PENDING"), mergeable, failing: ([.statusCheckRollup[]? | select(.conclusion == "FAILURE")] | length), pending: ([.statusCheckRollup[]? | select(.status != "COMPLETED")] | length)}'"#;

/// Windows PowerShell 5.1 strips double quotes inside arguments passed to
/// native programs, so the jq form above breaks there; shape JSON in PowerShell.
const PULL_REQUEST_STATUS_COMMAND_POWERSHELL: &str = r#"gh pr view 123 --repo owner/repo --json state,reviewDecision,mergeable,statusCheckRollup | ConvertFrom-Json | ForEach-Object { [pscustomobject]@{ state = $_.state; review = $(if ($_.reviewDecision) { $_.reviewDecision } else { 'PENDING' }); mergeable = $_.mergeable; failing = @($_.statusCheckRollup | Where-Object { $_.conclusion -eq 'FAILURE' }).Count; pending = @($_.statusCheckRollup | Where-Object { $_.status -ne 'COMPLETED' }).Count } } | ConvertTo-Json -Compress"#;

/// GraphQL variables keep string literals out of the query, so the same
/// command works in /bin/sh and Windows PowerShell.
const REPOSITORY_STATS_COMMAND: &str = r#"gh api graphql -f owner=owner -f name=repo -f query='query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { stargazerCount forkCount issues(states: OPEN) { totalCount } pullRequests(states: OPEN) { totalCount } } }' --jq '.data.repository | {stars: .stargazerCount, forks: .forkCount, openIssues: .issues.totalCount, openPRs: .pullRequests.totalCount}'"#;

/// No double quotes, so the same command works in /bin/sh and Windows PowerShell.
const PULL_REQUEST_LIST_COMMAND: &str =
    "gh pr list --repo owner/repo --state open --limit 10 --json number,title,author,url";

/// Builds rows with textContent so fetched titles are never parsed as HTML.
const PULL_REQUEST_LIST_HTML: &str = r##"<ul class="openbitfun-card-list" id="list"></ul><div class="openbitfun-card-muted" id="empty" hidden>No open pull requests</div><script>openbitfunCard.onData(function (payload) { var list = document.getElementById('list'); var prs = Array.isArray(payload.data) ? payload.data : []; list.replaceChildren(); prs.forEach(function (pr) { var row = document.createElement('li'); row.className = 'openbitfun-card-item'; row.setAttribute('role', 'link'); row.title = pr.title; row.onclick = function () { openbitfunCard.openLink(pr.url); }; var number = document.createElement('span'); number.className = 'openbitfun-card-muted'; number.textContent = '#' + pr.number; var title = document.createElement('span'); title.className = 'openbitfun-card-truncate'; title.textContent = pr.title; var author = document.createElement('span'); author.className = 'openbitfun-card-muted'; author.textContent = pr.author ? pr.author.login : ''; row.append(number, title, author); list.append(row); }); document.getElementById('empty').hidden = prs.length > 0; });</script>"##;

/// Every class and variable named here must exist in the card widget frame;
/// `DesktopCardCustomFrame.test.ts` checks this against the frame's CSS.
const CUSTOM_WIDGET_STYLE_GUIDANCE: &str = "Styling: the widget is transparent over the themed card, which already draws the surface, border, title, refresh time, and fetch errors, so do not set a page or body background, do not repeat the title or update time, and never hard-code colors (they break light, dark, and custom themes). Compose these classes first: openbitfun-card-stack, openbitfun-card-row, openbitfun-card-list with openbitfun-card-item rows (give clickable rows role=\"link\"), openbitfun-card-value, openbitfun-card-muted, openbitfun-card-truncate, openbitfun-card-good, openbitfun-card-warn, openbitfun-card-bad. Extra CSS may use only theme variables: var(--openbitfun-color-content-primary), var(--openbitfun-color-content-secondary), var(--openbitfun-color-content-muted), var(--openbitfun-color-accent-default), var(--openbitfun-color-border-subtle), var(--openbitfun-color-surface-subtle) for inset blocks, var(--openbitfun-color-action-quiet-hover), var(--openbitfun-color-status-success-content), var(--openbitfun-color-status-warning-content), var(--openbitfun-color-status-danger-content), var(--openbitfun-color-status-info-content), var(--openbitfun-space-1) to var(--openbitfun-space-4), var(--openbitfun-radius-sm), var(--openbitfun-radius-md), var(--openbitfun-font-family-mono). Insert fetched text with textContent, not innerHTML. Keep the layout compact for a small window and write visible text in the user's language.";

const WINDOWS_COMMAND_GUIDANCE: &str = "On this Windows computer: `curl` is an alias of Invoke-WebRequest (use curl.exe -sS or Invoke-RestMethod); Windows PowerShell 5.1 strips double quotes inside arguments passed to native programs such as gh, jq, or git, so keep double quotes out of those arguments (use GraphQL variables, or pipe to ConvertFrom-Json and build the result with [pscustomobject]@{...} | ConvertTo-Json -Compress); only the last statement decides the exit code, so a failed earlier call shows up as null values plus a stderr warning instead of an error.";

const POSIX_COMMAND_GUIDANCE: &str = "The command runs without your login profile; prefer absolute paths or CLIs on the system PATH, and use curl -sS so the progress meter stays off stderr.";

async fn command_test_guidance() -> String {
    let shell = ExecCommandTool::local_shell_prompt_info().await;
    command_test_guidance_for(&shell.shell_type, &shell.display_name)
}

/// ExecCommand follows the configured terminal shell, which can differ from
/// the fixed shell of command sources; PowerShell 7 and Git Bash, for example,
/// keep the double quotes that Windows PowerShell 5.1 strips.
fn command_test_guidance_for(exec_shell_type: &str, exec_shell_name: &str) -> String {
    let card_shell_type = if cfg!(windows) { "powershell" } else { "sh" };
    if exec_shell_type == card_shell_type {
        "ExecCommand uses the same shell as card commands.".to_string()
    } else if cfg!(windows) && exec_shell_type == "pwsh" {
        format!(
            "ExecCommand uses {exec_shell_name}, not Windows PowerShell 5.1, so a command can pass there and still fail on the card. Test it through the card's shell instead: run powershell.exe -NoProfile -NonInteractive -Command {{ <command> }} with ExecCommand."
        )
    } else if cfg!(windows) {
        format!(
            "ExecCommand uses {exec_shell_name}, not Windows PowerShell 5.1, so a command can pass there and still fail on the card. Test it through the card's shell instead: write it to a temporary .ps1 file and run powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <file> with ExecCommand."
        )
    } else {
        format!(
            "ExecCommand uses {exec_shell_name}, not /bin/sh, so avoid shell-specific syntax such as arrays, [[ ]], or brace expansion, and test with ExecCommand as /bin/sh -c '<command>'."
        )
    }
}

fn pull_request_status_command() -> &'static str {
    if cfg!(windows) {
        PULL_REQUEST_STATUS_COMMAND_POWERSHELL
    } else {
        PULL_REQUEST_STATUS_COMMAND_SH
    }
}

/// For example `bar up to 12 items | line up to 120 points`.
fn chart_style_summary() -> String {
    DESKTOP_CARD_CHART_STYLES
        .iter()
        .map(|(style, max)| {
            let unit = if *style == "line" { "points" } else { "items" };
            format!("{style} up to {max} {unit}")
        })
        .collect::<Vec<_>>()
        .join(" | ")
}

fn template_shape(kind: &str) -> Option<&'static str> {
    TEMPLATE_SHAPES
        .iter()
        .find(|(candidate, _)| *candidate == kind)
        .map(|(_, shape)| *shape)
}

/// Points at template fields placed on the card/patch or in data, which the
/// schema cannot express as an error by itself.
fn with_misplaced_field_hint(error: String, container: &Map<String, Value>, label: &str) -> String {
    let mut misplaced = MISPLACEABLE_TEMPLATE_FIELDS
        .iter()
        .filter(|field| container.contains_key(**field))
        .map(|field| format!("{label}.{field}"))
        .collect::<Vec<_>>();
    for key in ["data", "dataMerge"] {
        if let Some(Value::Object(data)) = container.get(key) {
            for field in ["items", "layout"] {
                if data.contains_key(field) {
                    misplaced.push(format!("{label}.{key}.{field}"));
                }
            }
        }
    }
    if misplaced.is_empty() {
        error
    } else {
        format!(
            "{error}. Found {} outside the template: template fields such as items and layout belong inside {label}.template.",
            misplaced.join(", ")
        )
    }
}

/// Template fields on the card/patch itself would otherwise be dropped silently.
fn reject_misplaced_template_fields(
    container: &Map<String, Value>,
    label: &str,
) -> Result<(), String> {
    let misplaced = MISPLACEABLE_TEMPLATE_FIELDS
        .iter()
        .filter(|field| container.contains_key(**field))
        .map(|field| format!("{label}.{field}"))
        .collect::<Vec<_>>();
    if misplaced.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{} would be ignored: template fields such as items and layout belong inside {label}.template.",
            misplaced.join(", ")
        ))
    }
}

pub struct DesktopCardTool;

impl DesktopCardTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for DesktopCardTool {
    fn default() -> Self {
        Self::new()
    }
}

fn is_remote_control_context(context: &ToolUseContext) -> bool {
    context
        .custom_data
        .get(TOOL_CONTEXT_REMOTE_FILE_DELIVERY_KEY)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn object_field<'a>(object: &'a Map<String, Value>, field: &str) -> Option<&'a Value> {
    object.get(field)
}

fn optional_str<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<Option<&'a str>, String> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.as_str())),
        Some(_) => Err(format!("{field} must be a string")),
    }
}

/// Countdown input accepts friendlier forms than an epoch timestamp.
fn normalize_template_input(raw: &Value, now: i64) -> Result<DesktopCardTemplateKind, String> {
    let Some(object) = raw.as_object() else {
        return Err("template must be an object with a kind".to_string());
    };
    let mut object = object.clone();
    if object.get("kind").and_then(Value::as_str) == Some("countdown") {
        let duration = object.remove("durationSeconds");
        let target_at = object.remove("targetAt");
        if !object.contains_key("targetAtMs") {
            let target_ms = if let Some(duration) = duration {
                let seconds = duration
                    .as_f64()
                    .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
                    .ok_or("countdown durationSeconds must be a positive number")?;
                if seconds > MAX_COUNTDOWN_SECONDS as f64 {
                    return Err("countdown durationSeconds must be at most one year".to_string());
                }
                now + (seconds * 1000.0).round() as i64
            } else if let Some(target_at) = target_at {
                let text = target_at
                    .as_str()
                    .ok_or("countdown targetAt must be an ISO-8601 string")?;
                DateTime::parse_from_rfc3339(text)
                    .map_err(|error| {
                        format!(
                            "countdown targetAt must be an ISO-8601 timestamp with offset, for example 2026-03-17T15:30:00+08:00: {error}"
                        )
                    })?
                    .timestamp_millis()
            } else {
                return Err(
                    "countdown requires durationSeconds, targetAt (ISO-8601), or targetAtMs"
                        .to_string(),
                );
            };
            object.insert("targetAtMs".to_string(), json!(target_ms));
        }
        if !object.contains_key("startedAtMs") {
            object.insert("startedAtMs".to_string(), json!(now));
        }
    }
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .map(str::to_string);
    let template: DesktopCardTemplateKind =
        serde_json::from_value(Value::Object(object)).map_err(|error| {
            match kind.as_deref().and_then(template_shape) {
                Some(shape) => format!("invalid template: {error}. Expected shape: {shape}"),
                None => format!(
                    "invalid template: {error}. template.kind must be one of: {}",
                    TEMPLATE_SHAPES
                        .iter()
                        .map(|(kind, _)| *kind)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            }
        })?;
    validate_template(template)
}

fn parse_data_source(raw: &Value) -> Result<DesktopCardDataSourceKind, String> {
    let source: DesktopCardDataSourceKind =
        serde_json::from_value(raw.clone()).map_err(|error| {
            format!("invalid dataSource: {error}. Expected shape: {DATA_SOURCE_SHAPES}")
        })?;
    validate_data_source(source)
}

fn parse_size(object: &Map<String, Value>) -> Result<Option<DesktopCardSize>, String> {
    let width = object.get("width").filter(|value| !value.is_null());
    let height = object.get("height").filter(|value| !value.is_null());
    if width.is_none() && height.is_none() {
        return Ok(None);
    }
    let read = |field: &str, value: Option<&Value>| -> Result<Option<f64>, String> {
        value
            .map(|value| value.as_f64().ok_or(format!("{field} must be a number")))
            .transpose()
    };
    let width = read("width", width)?;
    let height = read("height", height)?;
    Ok(Some(DesktopCardSize {
        width: width.unwrap_or(f64::NAN),
        height: height.unwrap_or(f64::NAN),
    }))
}

fn parse_draft(raw: &Value, now: i64) -> Result<DesktopCardDraft, String> {
    let Some(card) = raw.as_object() else {
        return Err("card is required for create and must be an object".to_string());
    };
    let title = validate_title(optional_str(card, "title")?.unwrap_or_default())?;
    let template = object_field(card, "template")
        .ok_or_else(|| "card.template is required".to_string())
        .and_then(|template| normalize_template_input(template, now))
        .map_err(|error| with_misplaced_field_hint(error, card, "card"))?;
    reject_misplaced_template_fields(card, "card")?;
    let data = card.get("data").cloned().unwrap_or(Value::Null);
    validate_data(&data)?;
    let data_source = match card.get("dataSource") {
        None | Some(Value::Null) => None,
        Some(raw) => Some(parse_data_source(raw)?),
    };
    let size = match parse_size(card)? {
        Some(size) => {
            let default = template.default_size();
            Some(validate_size(DesktopCardSize {
                width: if size.width.is_nan() {
                    default.width
                } else {
                    size.width
                },
                height: if size.height.is_nan() {
                    default.height
                } else {
                    size.height
                },
            })?)
        }
        None => None,
    };
    let always_on_top = match card.get("alwaysOnTop") {
        None | Some(Value::Null) => true,
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err("alwaysOnTop must be a boolean".to_string()),
    };
    Ok(DesktopCardDraft {
        title,
        subtitle: validate_subtitle(optional_str(card, "subtitle")?)?,
        icon: validate_icon(optional_str(card, "icon")?)?,
        accent: validate_tone("accent", optional_str(card, "accent")?)?,
        template,
        data,
        data_source,
        link: optional_str(card, "link")?
            .filter(|link| !link.trim().is_empty())
            .map(|link| validate_web_url("link", link))
            .transpose()?,
        size,
        always_on_top,
    })
}

fn nullable_text<T>(
    patch: &Map<String, Value>,
    field: &str,
    validate: impl Fn(Option<&str>) -> Result<Option<T>, String>,
) -> Result<Option<Option<T>>, String> {
    match patch.get(field) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(value)) => Ok(Some(validate(Some(value))?)),
        Some(_) => Err(format!("{field} must be a string or null")),
    }
}

fn parse_patch(raw: &Value, now: i64) -> Result<DesktopCardPatch, String> {
    let Some(patch) = raw.as_object() else {
        return Err("patch is required for update and must be an object".to_string());
    };
    let mut result = DesktopCardPatch {
        title: optional_str(patch, "title")?
            .map(validate_title)
            .transpose()?,
        subtitle: nullable_text(patch, "subtitle", validate_subtitle)?,
        icon: nullable_text(patch, "icon", validate_icon)?,
        accent: nullable_text(patch, "accent", |tone| validate_tone("accent", tone))?,
        link: nullable_text(patch, "link", |link| {
            link.filter(|link| !link.trim().is_empty())
                .map(|link| validate_web_url("link", link))
                .transpose()
        })?,
        ..Default::default()
    };
    if let Some(template) = patch.get("template").filter(|value| !value.is_null()) {
        result.template = Some(
            normalize_template_input(template, now)
                .map_err(|error| with_misplaced_field_hint(error, patch, "patch"))?,
        );
    }
    reject_misplaced_template_fields(patch, "patch")?;
    if let Some(data) = patch.get("data") {
        validate_data(data)?;
        result.data = Some(data.clone());
    }
    match patch.get("dataMerge") {
        None | Some(Value::Null) => {}
        Some(Value::Object(merge)) => {
            validate_data(&Value::Object(merge.clone()))?;
            result.data_merge = Some(merge.clone());
        }
        Some(_) => return Err("dataMerge must be an object".to_string()),
    }
    match patch.get("dataSource") {
        None => {}
        Some(Value::Null) => result.data_source = Some(None),
        Some(raw) => result.data_source = Some(Some(parse_data_source(raw)?)),
    }
    if let Some(size) = parse_size(patch)? {
        if size.width.is_nan() || size.height.is_nan() {
            return Err("update must set width and height together".to_string());
        }
        result.size = Some(validate_size(size)?);
    }
    match patch.get("alwaysOnTop") {
        None | Some(Value::Null) => {}
        Some(Value::Bool(value)) => result.always_on_top = Some(*value),
        Some(_) => return Err("alwaysOnTop must be a boolean".to_string()),
    }
    if result.is_empty() {
        return Err(with_misplaced_field_hint(
            "patch does not change any supported field".to_string(),
            patch,
            "patch",
        ));
    }
    Ok(result)
}

fn command_source(input: &Value) -> Option<&str> {
    let action = input.get("action").and_then(Value::as_str)?;
    let container = match action {
        "create" => input.get("card")?,
        "update" => input.get("patch")?,
        _ => return None,
    };
    let source = container.get("dataSource")?;
    if source.get("kind").and_then(Value::as_str) != Some("command") {
        return None;
    }
    Some(
        source
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("<missing>"),
    )
}

fn required_card_id(input: &Value) -> OpenBitFunResult<String> {
    input
        .get("cardId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(|| OpenBitFunError::validation("cardId is required for this action"))
}

fn presets() -> Value {
    json!([
        {
            "id": "countdown-reminder",
            "useWhen": "The user asks to be reminded after some time, or a wait has a known end (build ETA, meeting, cooldown).",
            "call": {
                "action": "create",
                "card": {
                    "title": "Stand-up meeting",
                    "icon": "alarm",
                    "template": { "kind": "countdown", "durationSeconds": 900, "message": "Join the stand-up" }
                }
            },
            "notes": "When it reaches zero the card highlights and a system notification is sent. Use targetAt with an ISO-8601 offset for wall-clock times."
        },
        {
            "id": "usage-breakdown",
            "useWhen": "You measured how a whole splits into parts and the user benefits from seeing the proportions: disk or quota usage after a scan, a budget, time spent per activity.",
            "call": {
                "action": "create",
                "card": {
                    "title": "C: drive usage",
                    "icon": "hard-drive",
                    "template": {
                        "kind": "chart",
                        "chart": "stacked",
                        "suffix": " GB",
                        "total": 906,
                        "remainderLabel": "Free",
                        "items": [
                            { "label": "WeChat data", "value": 62.7, "tone": "warning", "hint": "Clean up inside WeChat; do not delete the folder" },
                            { "label": "BlueStacks", "value": 20.5, "hint": "Remove unused instances in its multi-instance manager" },
                            { "label": "Caches and temp files", "value": 10.25, "hint": "Temp 4.44 + npm 4.12 + uv/pip 1.69" },
                            { "label": "Other used", "value": 218.55 }
                        ],
                        "caption": "Nothing was deleted. Review the highlighted items first."
                    }
                }
            },
            "notes": "Set total to the capacity and list only the used parts: the uncovered rest is drawn as remainderLabel and the header shows used of total. At most 6 items, so merge small parts into one item and keep their detail in its hint. Write labels, hints, and the caption in the user's language."
        },
        {
            "id": "ranked-breakdown",
            "useWhen": "Several comparable amounts the user will compare or act on: largest folders or caches, cleanup candidates, slowest tests, cost per service, errors per endpoint.",
            "call": {
                "action": "create",
                "card": {
                    "title": "Cleanup candidates",
                    "icon": "chart",
                    "template": {
                        "kind": "chart",
                        "chart": "bar",
                        "suffix": " GB",
                        "items": [
                            { "label": "Temp files", "value": 4.44, "hint": "Safe to clear with Disk Cleanup" },
                            { "label": "npm cache", "value": 4.12, "hint": "npm cache clean --force" },
                            { "label": "uv / pip cache", "value": 1.69, "hint": "uv cache clean; pip cache purge" }
                        ],
                        "caption": "Review each item before deleting anything."
                    }
                }
            },
            "notes": "Order items from largest to smallest. Put one short action per item in hint and one sentence that applies to all in caption; this replaces a note full of numbers. Set total to draw each bar as a share of a whole, such as the disk capacity."
        },
        {
            "id": "result-split",
            "useWhen": "A count splits into a few outcomes or categories: test results, issue states, traffic by source, votes.",
            "call": {
                "action": "create",
                "card": {
                    "title": "Test run",
                    "icon": "pie-chart",
                    "template": {
                        "kind": "chart",
                        "chart": "donut",
                        "items": [
                            { "label": "Passed", "value": 182, "tone": "success" },
                            { "label": "Failed", "value": 3, "tone": "danger" },
                            { "label": "Skipped", "value": 12, "tone": "neutral" }
                        ]
                    }
                }
            },
            "notes": "Donut and stacked charts take at most 6 items. Use tone only where it carries meaning (success, warning, danger); without tone the parts use shades of the card accent."
        },
        {
            "id": "scheduled-job",
            "useWhen": "You created a Cron job and the user benefits from seeing the next run and last result at a glance.",
            "call": {
                "action": "create",
                "card": {
                    "title": "Daily dependency audit",
                    "icon": "calendar",
                    "template": { "kind": "cronJob", "jobId": "<job_id returned by Cron add>" }
                }
            }
        },
        {
            "id": "pull-request-status",
            "useWhen": "The user opened or is waiting on a pull request (review, CI, merge).",
            "call": {
                "action": "create",
                "card": {
                    "title": "PR #123",
                    "subtitle": "owner/repo",
                    "icon": "git-pull-request",
                    "link": "https://github.com/owner/repo/pull/123",
                    "dataSource": {
                        "kind": "command",
                        "command": pull_request_status_command(),
                        "intervalSeconds": 300,
                        "parse": "json"
                    },
                    "template": {
                        "kind": "metrics",
                        "items": [
                            { "label": "State", "path": "/state", "emphasis": true, "toneMap": { "OPEN": "info", "MERGED": "success", "CLOSED": "danger" } },
                            { "label": "Review", "path": "/review", "toneMap": { "APPROVED": "success", "CHANGES_REQUESTED": "danger", "REVIEW_REQUIRED": "warning", "PENDING": "neutral" } },
                            { "label": "Failing checks", "path": "/failing", "format": "number", "toneMap": { "0": "success" }, "tone": "danger" },
                            { "label": "Running checks", "path": "/pending", "format": "number" }
                        ]
                    }
                }
            },
            "notes": "Command sources run locally with existing CLI auth (gh) and require user approval. This command is already written for the shell on this computer; keep its quoting style when you change the PR number or repository."
        },
        {
            "id": "repository-stats",
            "useWhen": "The user watches a repository's stars, forks, open issues, or open pull requests.",
            "call": {
                "action": "create",
                "card": {
                    "title": "owner/repo",
                    "icon": "star",
                    "link": "https://github.com/owner/repo",
                    "dataSource": {
                        "kind": "command",
                        "command": REPOSITORY_STATS_COMMAND,
                        "intervalSeconds": 1800,
                        "parse": "json"
                    },
                    "template": {
                        "kind": "metrics",
                        "layout": "grid",
                        "items": [
                            { "label": "Stars", "path": "/stars", "format": "number", "emphasis": true },
                            { "label": "Forks", "path": "/forks", "format": "number" },
                            { "label": "Open issues", "path": "/openIssues", "format": "number" },
                            { "label": "Open PRs", "path": "/openPRs", "format": "number" }
                        ]
                    }
                }
            },
            "notes": "GraphQL variables (-f owner=... -f name=...) keep double quotes out of the query, so the same command works in /bin/sh and Windows PowerShell. Fetch several numbers in one call like this instead of chaining commands."
        },
        {
            "id": "weather",
            "useWhen": "The user asks about the weather or plans around it.",
            "call": {
                "action": "create",
                "card": {
                    "title": "Shanghai weather",
                    "icon": "sun",
                    "dataSource": {
                        "kind": "http",
                        "url": "https://api.open-meteo.com/v1/forecast?latitude=31.23&longitude=121.47&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1",
                        "intervalSeconds": 1800
                    },
                    "template": {
                        "kind": "metrics",
                        "layout": "grid",
                        "items": [
                            { "label": "Now", "path": "/current/temperature_2m", "format": "number", "digits": 1, "suffix": " °C", "emphasis": true },
                            { "label": "Feels like", "path": "/current/apparent_temperature", "format": "number", "digits": 1, "suffix": " °C" },
                            { "label": "High", "path": "/daily/temperature_2m_max/0", "format": "number", "digits": 0, "suffix": " °C" },
                            { "label": "Low", "path": "/daily/temperature_2m_min/0", "format": "number", "digits": 0, "suffix": " °C" },
                            { "label": "Rain chance", "path": "/daily/precipitation_probability_max/0", "format": "number", "suffix": "%" },
                            { "label": "Wind", "path": "/current/wind_speed_10m", "format": "number", "digits": 0, "suffix": " km/h" }
                        ]
                    }
                }
            },
            "notes": "For the coming days or hours, use the weather-week chart preset instead of listing each value."
        },
        {
            "id": "weather-week",
            "useWhen": "The user plans around the weather over the next days, or another value per day or period should be compared side by side.",
            "call": {
                "action": "create",
                "card": {
                    "title": "Shanghai highs this week",
                    "icon": "sun",
                    "dataSource": {
                        "kind": "http",
                        "url": "https://api.open-meteo.com/v1/forecast?latitude=31.23&longitude=121.47&daily=temperature_2m_max&timezone=auto&forecast_days=7",
                        "intervalSeconds": 3600
                    },
                    "template": {
                        "kind": "chart",
                        "chart": "column",
                        "itemsPath": "/daily/temperature_2m_max",
                        "labelsPath": "/daily/time",
                        "labelFormat": "weekday",
                        "format": "number",
                        "digits": 0,
                        "suffix": "°"
                    }
                }
            },
            "notes": "itemsPath may point at an array of numbers (with labelsPath at a parallel array of labels), an array of [label, value] pairs, or an array of objects read with labelKey, valueKey, and hintKey (default label, value, hint)."
        },
        {
            "id": "stock-quote",
            "useWhen": "The user tracks a stock, index, or currency pair.",
            "call": {
                "action": "create",
                "card": {
                    "title": "AAPL",
                    "icon": "trending-up",
                    "link": "https://finance.yahoo.com/quote/AAPL",
                    "dataSource": {
                        "kind": "http",
                        "url": "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d",
                        "headers": { "User-Agent": "Mozilla/5.0" },
                        "intervalSeconds": 120
                    },
                    "template": {
                        "kind": "metrics",
                        "items": [
                            { "label": "Price", "path": "/chart/result/0/meta/regularMarketPrice", "format": "currency", "currency": "USD", "emphasis": true },
                            { "label": "Previous close", "path": "/chart/result/0/meta/chartPreviousClose", "format": "currency", "currency": "USD" },
                            { "label": "Day high", "path": "/chart/result/0/meta/regularMarketDayHigh", "format": "currency", "currency": "USD" },
                            { "label": "Day low", "path": "/chart/result/0/meta/regularMarketDayLow", "format": "currency", "currency": "USD" }
                        ]
                    }
                }
            },
            "notes": "For derived values such as percent change, use a command source that prints the computed JSON, then bind with signTone: true. For the price history, use the stock-trend chart preset."
        },
        {
            "id": "stock-trend",
            "useWhen": "The user follows how a value moves over time: a price history, response times, build durations, daily signups.",
            "call": {
                "action": "create",
                "card": {
                    "title": "AAPL · 1 month",
                    "icon": "trending-up",
                    "link": "https://finance.yahoo.com/quote/AAPL",
                    "dataSource": {
                        "kind": "http",
                        "url": "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1mo",
                        "headers": { "User-Agent": "Mozilla/5.0" },
                        "intervalSeconds": 900
                    },
                    "template": {
                        "kind": "chart",
                        "chart": "line",
                        "itemsPath": "/chart/result/0/indicators/quote/0/close",
                        "labelsPath": "/chart/result/0/timestamp",
                        "labelFormat": "date",
                        "format": "currency",
                        "currency": "USD"
                    }
                }
            },
            "notes": "A line chart shows the latest value, the change since the first point, and the range. Points whose value is null are skipped; Unix timestamps and ISO-8601 strings both work with labelFormat."
        },
        {
            "id": "task-progress",
            "useWhen": "A long task (migration, batch job, multi-step plan) runs while the user works elsewhere.",
            "call": {
                "action": "create",
                "card": {
                    "title": "Migrating 240 files",
                    "icon": "rocket",
                    "template": { "kind": "progress", "valuePath": "/done", "maxPath": "/total", "statusPath": "/status" },
                    "data": { "done": 0, "total": 240, "status": "Starting" }
                }
            },
            "notes": "Advance it with update + patch.dataMerge, for example {\"done\": 120, \"status\": \"Rewriting imports\"}. Delete or hide it when finished."
        },
        {
            "id": "checklist",
            "useWhen": "The user must do several manual steps themselves (release checklist, setup steps).",
            "call": {
                "action": "create",
                "card": {
                    "title": "Release v2.3",
                    "icon": "list",
                    "template": { "kind": "checklist", "items": [
                        { "id": "notes", "text": "Review release notes" },
                        { "id": "tag", "text": "Push the v2.3.0 tag" },
                        { "id": "announce", "text": "Announce in #releases" }
                    ] }
                }
            },
            "notes": "The user can tick items on the card; read the current state with get."
        },
        {
            "id": "note",
            "useWhen": "Short non-numeric reference info the user will need again soon (credentials location, URL, command to run).",
            "call": {
                "action": "create",
                "card": { "title": "Local dev URLs", "icon": "note", "template": { "kind": "note", "text": "Web: http://localhost:5173\nAPI: http://localhost:8080" } }
            },
            "notes": "Not for summaries of measured amounts: when the text would list sizes, counts, shares, or prices, use a chart (breakdowns, proportions, trends) or metrics (a few separate values) instead."
        },
        {
            "id": "pull-request-list",
            "useWhen": "The user wants a short list of open pull requests (or issues, deployments) that opens each item on click.",
            "call": {
                "action": "create",
                "card": {
                    "title": "Open PRs",
                    "subtitle": "owner/repo",
                    "icon": "git-pull-request",
                    "link": "https://github.com/owner/repo/pulls",
                    "dataSource": {
                        "kind": "command",
                        "command": PULL_REQUEST_LIST_COMMAND,
                        "intervalSeconds": 300,
                        "parse": "json"
                    },
                    "template": { "kind": "custom", "html": PULL_REQUEST_LIST_HTML }
                }
            },
            "notes": "A custom list that follows the app theme: it only composes openbitfun-card-* classes and sets no colors or background. gh prints a JSON array, so payload.data is the array itself. Translate the empty-state text into the user's language."
        },
        {
            "id": "custom-html",
            "useWhen": "No template fits. Write a small self-contained widget.",
            "call": {
                "action": "create",
                "card": {
                    "title": "Build queue",
                    "icon": "server",
                    "dataSource": { "kind": "http", "url": "https://example.com/queue.json", "intervalSeconds": 60 },
                    "template": { "kind": "custom", "html": "<div class=\"openbitfun-card-stack\"><div class=\"openbitfun-card-value\" id=\"count\">-</div><div class=\"openbitfun-card-muted\">jobs waiting</div></div><script>openbitfunCard.onData(function (payload) { document.getElementById('count').textContent = payload.data && payload.data.waiting != null ? payload.data.waiting : '-'; });</script>" }
                }
            },
            "notes": format!("Runs in an isolated sandbox without access to OpenBitFun. openbitfunCard.onData(cb) receives {{data, card, error}}; openbitfunCard.openLink(url) opens an http(s) link. {CUSTOM_WIDGET_STYLE_GUIDANCE}")
        }
    ])
}

#[async_trait]
impl Tool for DesktopCardTool {
    fn name(&self) -> &str {
        "DesktopCard"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(format!(
            r#"Show small persistent cards on the user's desktop, outside the OpenBitFun window (like OS widgets). Cards survive app restarts, keep their position, and can be dragged, hidden, or deleted by the user.

Use a card whenever the user would otherwise have to come back and check on something: a reminder after some time, a scheduled job, a pull request's review/CI state, a deployment or long task's progress, weather, a stock price, a checklist of manual steps, the result of a scan or analysis (disk usage, cleanup candidates, test results, costs), or reference info needed again soon. Create one when the user asks, and also proactively when a task naturally produces something worth glancing at later. Prefer updating an existing card (list first) over creating near-duplicates, and delete cards that are no longer useful.

Choosing a template. A card is read in a second, so let the shape of the information pick the template and show numbers visually instead of as prose:
- Several amounts that compare or add up (sizes, counts, durations, costs, shares, scores): chart. bar ranks a breakdown; stacked or donut shows parts of a whole (set total to the capacity to show used against free); column compares a few periods or categories; line shows a trend over time.
- A few separate values read individually (state, price, temperature, counts of different things): metrics. One value moving toward a goal: progress.
- note only for text without measured amounts (a URL, a command, where something is). Never write a summary of numbers into a note. Put the numbers in a chart or metrics, and keep advice to one short hint per item or one caption sentence.
- When a result has both a whole and its parts (for example disk usage and the largest folders), one stacked chart with total usually covers both.

Actions:
- presets: return ready-to-use recipes (countdown, usage breakdown, ranked breakdown, result split, scheduled job, PR status, PR list, repository stats, weather, weekly forecast chart, stock, price trend, progress, checklist, note, custom HTML). Call it when unsure how to build a card; preset commands are already written for the shell on this computer.
- create: requires card. Shows the card and returns its cardId. With a dataSource, the result already contains the first fetch: the value, any fetch error, stderr output, and template paths that resolved to nothing. Read it instead of calling get or refresh again.
- update: requires cardId and patch. Only provided fields change; null clears optional fields. patch.dataMerge shallow-merges into data (null removes a key). A changed dataSource is fetched before the result returns.
- list / get: inspect cards, including the latest fetched data or fetch error and checklist state.
- show / hide: hiding keeps the card for later. delete: remove permanently.
- refresh: fetch the data source now and return the result.
Data sources are fetched on their interval only while the card is shown.

Card fields: title (required), subtitle, icon ({icons}), accent (neutral|accent|info|success|warning|danger), template (required), data, dataSource, link (http/https opened from the card), width/height (logical px), alwaysOnTop (default true).

Templates (template.kind). Every template field, including items and layout, goes inside the template object; data and dataSource only supply the values that paths read:
- countdown: durationSeconds | targetAt (ISO-8601 with offset) | targetAtMs, optional message, notify (default true: system notification when due).
- checklist: items [{{id, text, done}}]. The user can tick items.
- note: text (plain text, newlines kept). Not for measured amounts; see Choosing a template.
- progress: value/max or valuePath/maxPath, optional status/statusPath.
- metrics: items (1-12) [{{label, value | path, format (text|number|percent|currency|datetime|relativeTime), digits, currency, prefix, suffix, tone, toneMap {{"VALUE": tone}}, signTone, hint | hintPath, emphasis}}], layout list|grid.
- chart: chart ({chart_styles}), then either items [{{label, value, tone, hint}}] or itemsPath (JSON Pointer to an array in the card data: numbers with labelsPath at a parallel label array, [label, value] pairs, or objects read with labelKey/valueKey/hintKey, default label/value/hint). Optional total | totalPath (the whole the items belong to; the uncovered rest is drawn as remainderLabel), format (number|percent|currency), digits, currency, prefix, suffix (units such as " GB"), labelFormat (text|date|time|weekday|datetime) and caption (one short sentence under the chart). Values are non-negative except on line charts. Order bar items largest first. Longer bound arrays keep their first items, except that line charts keep the latest points and donut or stacked charts merge the rest into one Other part.
- cronJob: jobId of a Cron job; shows next run and last result live.
- custom: html (body markup with inline <style> and <script>) for a sandboxed widget; openbitfunCard.onData(cb) receives {{data, card, error}} and openbitfunCard.openLink(url) opens an http(s) link. Use it only when no template above fits (lists of links, small tables): the other templates follow the app theme by themselves, and chart already draws bar, column, line, donut, and stacked charts. {custom_widget_guidance}
Paths are JSON Pointers (e.g. /current/temperature_2m) into the card data. With a dataSource, data is the latest fetched value.

Data sources (dataSource.kind):
- http: url, optional headers, intervalSeconds (30-86400), parse json|text. Fetched from this computer.
- command: shell command run locally on this computer with {shell}, intervalSeconds (30-86400), optional cwd (defaults to the local workspace) and timeoutSeconds (default 20, max 120), parse json|text. Requires user approval; not allowed for remote workspaces. Prefer CLIs that already hold credentials (gh, kubectl) over putting secrets in http headers. {command_guidance}

Workflow for command sources:
1. Run the exact command once with ExecCommand and confirm it prints the JSON you plan to bind (card commands additionally skip shell profiles). {command_test_guidance}
2. Prefer one call that prints one JSON object (for example gh api graphql --jq, or ConvertTo-Json -Compress) over several chained commands.
3. Bind template paths to the keys you saw in that output, then create the card.
4. If the result reports a fetch error or unresolved paths, fix the command or the paths with update instead of creating another card. Reported stderr output alone is often harmless progress text; use it to explain missing values.

Cards are shown only on this desktop. They are unavailable for remote mobile or bot control turns because that user cannot see them."#,
            icons = DESKTOP_CARD_ICONS.join(", "),
            chart_styles = chart_style_summary(),
            shell = desktop_card_command_shell_label(),
            command_test_guidance = command_test_guidance().await,
            custom_widget_guidance = CUSTOM_WIDGET_STYLE_GUIDANCE,
            command_guidance = if cfg!(windows) {
                WINDOWS_COMMAND_GUIDANCE
            } else {
                POSIX_COMMAND_GUIDANCE
            },
        ))
    }

    fn short_description(&self) -> String {
        "Show persistent desktop cards (reminders, PR/CI status, progress, charts of usage or results, weather, prices, checklists) the user can glance at."
            .to_string()
    }

    fn input_schema(&self) -> Value {
        let tones = json!(["neutral", "accent", "info", "success", "warning", "danger"]);
        let template_item = json!({
            "type": "object",
            "description": "checklist item {id, text, done}, metrics item {label, value | path, ...}, or chart item {label, value, tone, hint}.",
            "properties": {
                "id": { "type": "string", "description": "checklist: stable item id." },
                "text": { "type": "string", "description": "checklist: item text." },
                "done": { "type": "boolean", "description": "checklist: ticked state." },
                "label": { "type": "string", "description": "metrics: row label. chart: bar, segment, or point label." },
                "value": { "description": "metrics: static value; use path for fetched data. chart: the number to plot (non-negative except on line charts)." },
                "path": { "type": "string", "description": "metrics: JSON Pointer into the card data, such as /stars." },
                "format": { "type": "string", "enum": ["text", "number", "percent", "currency", "datetime", "relativeTime"] },
                "digits": { "type": "integer", "minimum": 0, "maximum": 8 },
                "currency": { "type": "string", "description": "ISO 4217 code for format currency, such as USD." },
                "prefix": { "type": "string" },
                "suffix": { "type": "string" },
                "tone": { "type": "string", "enum": tones, "description": "metrics: value color. chart: bar or segment color; omit for neutral categories." },
                "toneMap": { "type": "object", "description": "Tone by displayed raw value, such as {\"OPEN\": \"info\", \"0\": \"success\"}.", "additionalProperties": { "type": "string", "enum": tones } },
                "signTone": { "type": "boolean", "description": "Positive numbers success, negative danger." },
                "hint": { "type": "string", "description": "metrics: tooltip. chart: one short line under the bar or legend row, such as the action to take." },
                "hintPath": { "type": "string", "description": "JSON Pointer for a secondary line." },
                "emphasis": { "type": "boolean" }
            }
        });
        let template = json!({
            "type": "object",
            "description": "Template object. All template fields, including items and layout, go here (not in data).",
            "properties": {
                "kind": { "type": "string", "enum": ["countdown", "checklist", "note", "progress", "metrics", "chart", "cronJob", "custom"], "description": "Pick by the shape of the information: chart for amounts that compare, add up, or change over time; metrics for a few separate values; note only for text without measured amounts." },
                "chart": { "type": "string", "enum": DESKTOP_CARD_CHART_STYLES.iter().map(|(style, _)| *style).collect::<Vec<_>>(), "description": format!("chart: bar ranks a breakdown, stacked or donut shows parts of a whole, column compares periods or categories, line shows a trend. Limits: {}.", chart_style_summary()) },
                "itemsPath": { "type": "string", "description": "chart: JSON Pointer to an array in the card data (numbers, [label, value] pairs, or objects); use instead of items for fetched data." },
                "labelsPath": { "type": "string", "description": "chart: JSON Pointer to labels parallel to a numeric itemsPath array." },
                "labelKey": { "type": "string", "description": "chart: label property of each itemsPath object (default label)." },
                "valueKey": { "type": "string", "description": "chart: value property of each itemsPath object (default value)." },
                "hintKey": { "type": "string", "description": "chart: hint property of each itemsPath object (default hint)." },
                "total": { "type": "number", "description": "chart (not line): the whole the items are part of, such as disk capacity; the uncovered rest is drawn as the remainder." },
                "totalPath": { "type": "string", "description": "chart (not line): JSON Pointer to the total." },
                "remainderLabel": { "type": "string", "description": "chart: label of the uncovered rest when total is set, such as Free." },
                "format": { "type": "string", "enum": ["number", "percent", "currency"], "description": "chart: value format; percent expects 0-100." },
                "digits": { "type": "integer", "minimum": 0, "maximum": 8, "description": "chart: fraction digits." },
                "currency": { "type": "string", "description": "chart: ISO 4217 code for format currency." },
                "prefix": { "type": "string", "description": "chart: text before each value." },
                "suffix": { "type": "string", "description": "chart: unit after each value, such as \" GB\" or \" ms\"." },
                "labelFormat": { "type": "string", "enum": ["text", "date", "time", "weekday", "datetime"], "description": "chart: show timestamp labels (ISO-8601 or Unix time) as a date, time, or weekday." },
                "caption": { "type": "string", "description": "chart: one short sentence under the chart, such as the advice that applies to every item." },
                "durationSeconds": { "type": "number", "description": "countdown: seconds from now." },
                "targetAt": { "type": "string", "description": "countdown: ISO-8601 time with offset, such as 2026-03-17T15:30:00+08:00." },
                "targetAtMs": { "type": "integer", "description": "countdown: epoch milliseconds." },
                "message": { "type": "string", "description": "countdown: shown when due." },
                "notify": { "type": "boolean", "description": "countdown: system notification when due (default true)." },
                "items": { "type": "array", "description": "checklist, metrics (1-12), or static chart items.", "items": template_item },
                "layout": { "type": "string", "enum": ["list", "grid"], "description": "metrics layout." },
                "text": { "type": "string", "description": "note: plain text without measured amounts; put sizes, counts, shares, or prices in a chart or metrics instead." },
                "value": { "type": "number", "description": "progress: static value." },
                "max": { "type": "number", "description": "progress: static maximum." },
                "valuePath": { "type": "string", "description": "progress: JSON Pointer to the value." },
                "maxPath": { "type": "string", "description": "progress: JSON Pointer to the maximum." },
                "status": { "type": "string", "description": "progress: static status line." },
                "statusPath": { "type": "string", "description": "progress: JSON Pointer to the status line." },
                "jobId": { "type": "string", "description": "cronJob: id returned by Cron." },
                "html": { "type": "string", "description": "custom: widget body markup with inline <style>/<script>. It sits transparently on the themed card: set no page background or hard-coded colors; use the openbitfun-card-* classes and var(--openbitfun-*) theme variables listed in the tool description." }
            },
            "required": ["kind"]
        });
        let data_source = json!({
            "type": ["object", "null"],
            "description": "Periodic data source; the latest value becomes the card data.",
            "properties": {
                "kind": { "type": "string", "enum": ["http", "command"] },
                "url": { "type": "string", "description": "http: https URL." },
                "headers": { "type": "object", "description": "http: request headers.", "additionalProperties": { "type": "string" } },
                "command": { "type": "string", "description": format!("command: run with {} on this computer; should print one JSON object.", desktop_card_command_shell_label()) },
                "cwd": { "type": "string", "description": "command: working directory (defaults to the local workspace)." },
                "timeoutSeconds": { "type": "integer", "minimum": 1, "maximum": 120, "description": "command: default 20." },
                "intervalSeconds": { "type": "integer", "minimum": 30, "maximum": 86400 },
                "parse": { "type": "string", "enum": ["json", "text"], "description": "Default json." }
            },
            "required": ["kind"]
        });
        let card_properties = json!({
            "title": { "type": "string" },
            "subtitle": { "type": ["string", "null"] },
            "icon": { "type": ["string", "null"], "enum": DESKTOP_CARD_ICONS.iter().map(|icon| Value::String((*icon).to_string())).chain(std::iter::once(Value::Null)).collect::<Vec<_>>() },
            "accent": { "type": ["string", "null"], "enum": ["neutral", "accent", "info", "success", "warning", "danger", null] },
            "template": template,
            "data": { "description": "Static values read by template paths when there is no dataSource, such as {\"done\": 3, \"total\": 10}." },
            "dataSource": data_source,
            "link": { "type": ["string", "null"], "description": "http(s) URL opened from the card." },
            "width": { "type": "number" },
            "height": { "type": "number" },
            "alwaysOnTop": { "type": "boolean" }
        });
        let mut patch_properties = card_properties.clone();
        if let Some(object) = patch_properties.as_object_mut() {
            object.insert(
                "dataMerge".to_string(),
                json!({ "type": "object", "description": "Shallow-merged into data; null removes a key." }),
            );
        }
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["action"],
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["presets", "create", "update", "list", "get", "show", "hide", "delete", "refresh"]
                },
                "cardId": { "type": "string", "description": "Required for update, get, show, hide, delete, and refresh." },
                "card": {
                    "type": "object",
                    "description": "Required for create.",
                    "properties": card_properties,
                    "required": ["title", "template"]
                },
                "patch": {
                    "type": "object",
                    "description": "Required for update.",
                    "properties": patch_properties
                }
            }
        })
    }

    fn output_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "success": {"type": "boolean"},
                "action": {"type": "string", "enum": ["create", "update", "list", "get", "show", "hide", "delete", "refresh", "presets"]},
                "card": {"type": "object", "additionalProperties": true},
                "cards": {"type": "array", "items": {"type": "object", "additionalProperties": true}},
                "presets": {"type": "array", "items": {"type": "object", "additionalProperties": true}},
                "card_id": {"type": "string"},
                "visible": {"type": "boolean"},
                "data": {"type": "object", "additionalProperties": true}
            },
            "additionalProperties": true
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, input: Option<&Value>) -> bool {
        input
            .and_then(|input| input.get("action"))
            .and_then(Value::as_str)
            .is_some_and(|action| matches!(action, "presets" | "list" | "get"))
    }

    async fn is_enabled(&self) -> bool {
        if !desktop_card_host_available() {
            return false;
        }
        let Ok(service) = GlobalConfigManager::get_service().await else {
            return false;
        };
        service
            .get_config::<bool>(Some(DESKTOP_CARDS_CONFIG_PATH))
            .await
            .unwrap_or(true)
    }

    async fn is_available_in_context(&self, context: Option<&ToolUseContext>) -> bool {
        if context.is_some_and(is_remote_control_context) {
            return false;
        }
        self.is_enabled().await
    }

    fn permission_intents(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        let Some(command) = command_source(input) else {
            return Ok(Vec::new());
        };
        let mut intent = PermissionIntent::new(
            "desktop_card_command",
            vec![format!("desktop-card:command:{command}")],
        );
        intent.save_resources.clear();
        intent
            .display_metadata
            .insert("requiresFreshApproval".to_string(), Value::Bool(true));
        intent.display_metadata.insert(
            "description".to_string(),
            Value::String(
                "Run this shell command periodically on this computer to refresh a desktop card"
                    .to_string(),
            ),
        );
        Ok(vec![intent])
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        if is_remote_control_context(context) {
            return Err(OpenBitFunError::tool(
                "DesktopCard cannot run from a remote mobile or bot controller because cards appear only on the host desktop, which that user cannot see. Tell the user in the reply instead, or schedule a Cron job for reminders."
                    .to_string(),
            ));
        }
        let action = input
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| OpenBitFunError::validation("Missing required field: action"))?;

        if action == "presets" {
            return Ok(vec![ToolResult::Result {
                data: json!({ "presets": presets() }),
                result_for_assistant: Some(format!(
                    "Desktop card presets (adapt titles, ids, URLs, and commands to the user's situation; replace placeholders):\n{}",
                    serde_json::to_string_pretty(&presets()).unwrap_or_default()
                )),
                image_attachments: None,
            }]);
        }

        let now = now_ms();
        let request = match action {
            "create" => {
                let mut draft = parse_draft(input.get("card").unwrap_or(&Value::Null), now)
                    .map_err(OpenBitFunError::validation)?;
                self.prepare_command_source(&mut draft.data_source, context)?;
                DesktopCardHostRequest::Create {
                    draft,
                    origin: DesktopCardOrigin {
                        session_id: context.session_id.clone(),
                        agent_type: context.agent_type.clone(),
                        workspace_path: context
                            .workspace
                            .as_ref()
                            .map(|workspace| workspace.root_path_string()),
                    },
                }
            }
            "update" => {
                let card_id = required_card_id(input)?;
                let mut patch = parse_patch(input.get("patch").unwrap_or(&Value::Null), now)
                    .map_err(OpenBitFunError::validation)?;
                if let Some(source) = patch.data_source.as_mut() {
                    self.prepare_command_source(source, context)?;
                }
                DesktopCardHostRequest::Update { card_id, patch }
            }
            "list" => DesktopCardHostRequest::List,
            "get" => DesktopCardHostRequest::Get {
                card_id: required_card_id(input)?,
            },
            "show" => DesktopCardHostRequest::Show {
                card_id: required_card_id(input)?,
            },
            "hide" => DesktopCardHostRequest::Hide {
                card_id: required_card_id(input)?,
            },
            "delete" => DesktopCardHostRequest::Delete {
                card_id: required_card_id(input)?,
            },
            "refresh" => DesktopCardHostRequest::Refresh {
                card_id: required_card_id(input)?,
            },
            other => {
                return Err(OpenBitFunError::validation(format!(
                    "Unsupported DesktopCard action: {other}"
                )))
            }
        };

        let result = invoke_desktop_card_host(request)
            .await
            .map_err(OpenBitFunError::tool)?;
        let assistant = render_result_for_assistant(action, &result);
        Ok(vec![ToolResult::Result {
            data: result,
            result_for_assistant: Some(assistant),
            image_attachments: None,
        }])
    }
}

impl DesktopCardTool {
    fn prepare_command_source(
        &self,
        source: &mut Option<DesktopCardDataSourceKind>,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<()> {
        let Some(DesktopCardDataSourceKind::Command { cwd, .. }) = source.as_mut() else {
            return Ok(());
        };
        if context.is_remote() {
            return Err(OpenBitFunError::tool(
                "Command data sources run on this computer, not on the remote workspace host, so they are not allowed for remote workspaces. Use an http data source, static data updated by you, or a Cron job instead."
                    .to_string(),
            ));
        }
        if cwd.is_none() {
            *cwd = context
                .workspace
                .as_ref()
                .map(|workspace| workspace.root_path_string());
        }
        Ok(())
    }
}

fn card_line(card: &Value) -> String {
    let id = card.get("id").and_then(Value::as_str).unwrap_or("?");
    let title = card.get("title").and_then(Value::as_str).unwrap_or("");
    let kind = card
        .pointer("/template/kind")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let visible = card
        .get("visible")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut line = format!(
        "- {id}: \"{title}\" ({kind}, {})",
        if visible { "shown" } else { "hidden" }
    );
    if let Some(error) = card.pointer("/lastData/error").and_then(Value::as_str) {
        line.push_str(&format!(", last fetch failed: {error}"));
    } else if card
        .pointer("/lastData/warning")
        .is_some_and(Value::is_string)
    {
        line.push_str(", last fetch also wrote to stderr (see get)");
    }
    let unresolved = unresolved_template_paths(card).len();
    if unresolved > 0 {
        line.push_str(&format!(", {unresolved} template path(s) unresolved"));
    }
    line
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut truncated = text.chars().take(max).collect::<String>();
    truncated.push_str("...");
    truncated
}

/// Template paths with no value in the data the card renders. Empty while the
/// first fetch is pending or when the last fetch failed, since the error
/// already explains the placeholders.
fn unresolved_template_paths(card: &Value) -> Vec<String> {
    let Some(template) = card.get("template").and_then(|template| {
        serde_json::from_value::<DesktopCardTemplateKind>(template.clone()).ok()
    }) else {
        return Vec::new();
    };
    let has_source = card
        .get("dataSource")
        .is_some_and(|source| !source.is_null());
    let data = if has_source {
        let Some(snapshot) = card.get("lastData").filter(|snapshot| !snapshot.is_null()) else {
            return Vec::new();
        };
        if snapshot.get("error").is_some_and(Value::is_string) {
            return Vec::new();
        }
        snapshot.get("value").unwrap_or(&Value::Null)
    } else {
        card.get("data").unwrap_or(&Value::Null)
    };
    desktop_card_template_paths(&template)
        .into_iter()
        .filter(|(_, path)| data.pointer(path).is_none_or(Value::is_null))
        .map(|(field, path)| format!("{path} ({field})"))
        .collect()
}

fn data_status(card: &Value) -> Vec<String> {
    let mut lines = Vec::new();
    let has_source = card
        .get("dataSource")
        .is_some_and(|source| !source.is_null());
    if has_source {
        let visible = card
            .get("visible")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        match card.get("lastData").filter(|snapshot| !snapshot.is_null()) {
            None if !visible => lines.push(
                "Data: the card is hidden, so its source is not fetched until it is shown."
                    .to_string(),
            ),
            None => lines.push(
                "Data: the first fetch has not finished yet; call get in a few seconds to see its result."
                    .to_string(),
            ),
            Some(snapshot) => {
                if let Some(error) = snapshot.get("error").and_then(Value::as_str) {
                    lines.push(format!("Data: the last fetch failed: {error}"));
                }
                if let Some(warning) = snapshot.get("warning").and_then(Value::as_str) {
                    lines.push(format!(
                        "Data: the command exited successfully and wrote to stderr (often progress output or notices; if values are missing, it may explain why): {warning}"
                    ));
                }
                if let Some(value) = snapshot.get("value").filter(|value| !value.is_null()) {
                    lines.push(format!(
                        "Data: latest value {}",
                        truncate_chars(
                            &serde_json::to_string(value).unwrap_or_default(),
                            MAX_VALUE_PREVIEW_CHARS
                        )
                    ));
                }
            }
        }
    }
    let unresolved = unresolved_template_paths(card);
    if !unresolved.is_empty() {
        let fix = if has_source {
            "Run the source once with ExecCommand (or open the URL) to see its real output, then fix the command or the paths with update."
        } else {
            "The card has no dataSource, so set these values with update + patch.dataMerge (or card.data on create), or fix the paths."
        };
        lines.push(format!(
            "Data: these template paths are missing or null, so the card shows placeholders: {}. {fix}",
            unresolved.join(", ")
        ));
    }
    lines
}

fn with_data_status(summary: String, card: Option<&Value>) -> String {
    let lines = card.map(data_status).unwrap_or_default();
    if lines.is_empty() {
        summary
    } else {
        format!("{summary}\n{}", lines.join("\n"))
    }
}

fn render_result_for_assistant(action: &str, result: &Value) -> String {
    let card = result.get("card");
    let card_id = card
        .and_then(|card| card.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("?");
    match action {
        "create" => with_data_status(
            format!(
                "Created desktop card {card_id} and showed it on the user's desktop. Use this cardId for later update, hide, or delete."
            ),
            card,
        ),
        "update" => with_data_status(format!("Updated desktop card {card_id}."), card),
        "show" => format!("Desktop card {card_id} is now shown."),
        "hide" => format!("Desktop card {card_id} is hidden; it is kept and can be shown again."),
        "delete" => format!("Deleted desktop card {card_id}."),
        "refresh" => with_data_status(
            format!(
                "Refreshed desktop card {card_id}.\n{}",
                card.map(card_line).unwrap_or_default()
            ),
            card,
        ),
        "get" => with_data_status(
            serde_json::to_string_pretty(result).unwrap_or_default(),
            card,
        ),
        "list" => {
            let cards = result
                .get("cards")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let enabled = result
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            if cards.is_empty() {
                "No desktop cards exist.".to_string()
            } else {
                let mut text = format!(
                    "{} desktop card(s){}:\n",
                    cards.len(),
                    if enabled {
                        ""
                    } else {
                        " (desktop cards are turned off in settings, so none are displayed)"
                    }
                );
                text.push_str(
                    &cards
                        .iter()
                        .map(card_line)
                        .collect::<Vec<_>>()
                        .join("\n"),
                );
                text
            }
        }
        _ => serde_json::to_string_pretty(result).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn context() -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: Some("Standard".to_string()),
            session_id: Some("session-1".to_string()),
            dialog_turn_id: None,
            workspace: None,
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: Default::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: Default::default(),
            runtime_handles: Default::default(),
        }
    }

    fn remote_context() -> ToolUseContext {
        let mut remote = context();
        remote.workspace = Some(crate::agentic::WorkspaceBinding::new_remote(
            None,
            std::path::PathBuf::from("/srv/project"),
            "connection-1".to_string(),
            "Remote".to_string(),
            crate::service::remote_ssh::workspace_state::WorkspaceSessionIdentity {
                workspace_kind: openbitfun_core_types::WorkspaceKind::Remote,
                hostname: "remote.example".to_string(),
                logical_workspace_path: "/srv/project".to_string(),
                remote_connection_id: Some("connection-1".to_string()),
            },
        ));
        remote
    }

    #[test]
    fn countdown_accepts_duration_and_iso_targets() {
        let template =
            normalize_template_input(&json!({"kind": "countdown", "durationSeconds": 60}), 1_000)
                .unwrap();
        assert!(matches!(
            template,
            DesktopCardTemplateKind::Countdown {
                target_at_ms: 61_000,
                started_at_ms: Some(1_000),
                ..
            }
        ));
        let template = normalize_template_input(
            &json!({"kind": "countdown", "targetAt": "2030-01-01T00:00:00+00:00"}),
            1_000,
        )
        .unwrap();
        assert!(matches!(
            template,
            DesktopCardTemplateKind::Countdown {
                target_at_ms: 1_893_456_000_000,
                ..
            }
        ));
        assert!(normalize_template_input(&json!({"kind": "countdown"}), 1_000).is_err());
    }

    #[test]
    fn every_preset_call_is_a_valid_card() {
        for preset in presets().as_array().unwrap() {
            let card = preset.pointer("/call/card").unwrap();
            parse_draft(card, 1_000)
                .unwrap_or_else(|error| panic!("preset {} is invalid: {error}", preset["id"]));
        }
    }

    #[test]
    fn misplaced_template_fields_get_an_actionable_hint() {
        let error = parse_draft(
            &json!({
                "title": "Repo",
                "template": {"kind": "metrics"},
                "data": {"items": [{"label": "Stars", "path": "/stars"}]}
            }),
            0,
        )
        .unwrap_err();
        assert!(error.contains("template.items"), "{error}");
        assert!(error.contains("card.data.items"), "{error}");
        assert!(error.contains("inside card.template"), "{error}");

        let error = parse_draft(
            &json!({"title": "Repo", "items": [], "template": {"kind": "metrics"}}),
            0,
        )
        .unwrap_err();
        assert!(error.contains("card.items"), "{error}");

        let error = parse_patch(&json!({"items": []}), 0).unwrap_err();
        assert!(error.contains("patch.items"), "{error}");

        let error = parse_draft(
            &json!({"title": "N", "layout": "grid", "template": {"kind": "note", "text": "x"}}),
            0,
        )
        .unwrap_err();
        assert!(error.contains("card.layout would be ignored"), "{error}");
        let error = parse_patch(&json!({"title": "N", "valuePath": "/done"}), 0).unwrap_err();
        assert!(
            error.contains("patch.valuePath would be ignored"),
            "{error}"
        );
        assert!(parse_patch(&json!({"dataMerge": {"items": 3}}), 0).is_ok());
    }

    #[test]
    fn invalid_shapes_include_an_example() {
        let error =
            parse_draft(&json!({"title": "N", "template": {"kind": "note"}}), 0).unwrap_err();
        assert!(error.contains(r#"{"kind":"note","text""#), "{error}");
        let error =
            parse_draft(&json!({"title": "N", "template": {"kind": "hologram"}}), 0).unwrap_err();
        assert!(error.contains("must be one of: countdown"), "{error}");
        assert!(error.contains("chart"), "{error}");
        let error =
            parse_draft(&json!({"title": "N", "template": {"kind": "chart"}}), 0).unwrap_err();
        assert!(
            error.contains(r#"{"kind":"chart","chart":"bar""#),
            "{error}"
        );
        let error = parse_draft(
            &json!({"title": "N", "template": {"kind": "chart", "chart": "pie", "items": [{"label": "a", "value": 1}]}}),
            0,
        )
        .unwrap_err();
        assert!(
            error.contains("bar, column, line, donut, stacked"),
            "{error}"
        );
        let error = parse_draft(
            &json!({
                "title": "N",
                "template": {"kind": "note", "text": "x"},
                "dataSource": {"kind": "command"}
            }),
            0,
        )
        .unwrap_err();
        assert!(error.contains(r#""kind":"command","command""#), "{error}");
    }

    #[test]
    fn schema_describes_template_and_data_source_fields() {
        let schema = DesktopCardTool::new().input_schema();
        let card = &schema["properties"]["card"]["properties"];
        for field in [
            "items",
            "layout",
            "valuePath",
            "durationSeconds",
            "jobId",
            "html",
        ] {
            assert!(
                card["template"]["properties"].get(field).is_some(),
                "{field}"
            );
        }
        assert!(
            card["template"]["properties"]["items"]["items"]["properties"]
                .get("toneMap")
                .is_some()
        );
        for field in [
            "url",
            "headers",
            "command",
            "cwd",
            "timeoutSeconds",
            "intervalSeconds",
            "parse",
        ] {
            assert!(
                card["dataSource"]["properties"].get(field).is_some(),
                "{field}"
            );
        }
        let patch = &schema["properties"]["patch"]["properties"];
        assert!(patch["template"]["properties"].get("items").is_some());
        assert!(patch.get("dataMerge").is_some());
    }

    #[test]
    fn schema_describes_chart_templates() {
        let schema = DesktopCardTool::new().input_schema();
        let template = &schema["properties"]["card"]["properties"]["template"]["properties"];
        assert!(template["kind"]["enum"]
            .as_array()
            .unwrap()
            .contains(&json!("chart")));
        assert_eq!(
            template["chart"]["enum"],
            json!(["bar", "column", "line", "donut", "stacked"])
        );
        for field in [
            "itemsPath",
            "labelsPath",
            "labelKey",
            "valueKey",
            "hintKey",
            "total",
            "totalPath",
            "remainderLabel",
            "format",
            "digits",
            "suffix",
            "labelFormat",
            "caption",
        ] {
            assert!(template.get(field).is_some(), "{field}");
        }
        let note = template["text"]["description"].as_str().unwrap();
        assert!(note.contains("chart or metrics"), "{note}");
        let kind = template["kind"]["description"].as_str().unwrap();
        assert!(kind.contains("note only for text"), "{kind}");
    }

    #[tokio::test]
    async fn description_steers_measured_amounts_into_charts() {
        let description = DesktopCardTool::new().description().await.unwrap();
        assert!(description.contains("Choosing a template"), "{description}");
        assert!(
            description.contains("Never write a summary of numbers into a note"),
            "{description}"
        );
        assert!(
            description.contains("chart: chart (bar up to 12 items"),
            "{description}"
        );
        assert!(
            description.contains("line up to 120 points"),
            "{description}"
        );
        assert!(description.contains("usage breakdown"), "{description}");
        assert!(DesktopCardTool::new()
            .short_description()
            .contains("charts"));
    }

    #[test]
    fn chart_presets_cover_every_style() {
        let presets = presets();
        let styles = presets
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|preset| preset.pointer("/call/card/template/chart"))
            .filter_map(Value::as_str)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            styles.into_iter().collect::<Vec<_>>(),
            ["bar", "column", "donut", "line", "stacked"]
        );
        let note = presets
            .as_array()
            .unwrap()
            .iter()
            .find(|preset| preset["id"] == "note")
            .unwrap();
        assert!(note["notes"].as_str().unwrap().contains("use a chart"));
    }

    #[test]
    fn misplaced_chart_fields_get_an_actionable_hint() {
        let error = parse_draft(
            &json!({
                "title": "Disk",
                "itemsPath": "/rows",
                "template": {"kind": "chart", "chart": "bar", "items": [{"label": "a", "value": 1}]}
            }),
            0,
        )
        .unwrap_err();
        assert!(error.contains("card.itemsPath would be ignored"), "{error}");
        let error = parse_draft(
            &json!({
                "title": "Disk",
                "template": {"kind": "chart", "chart": "bar"},
                "data": {"items": [{"label": "a", "value": 1}]}
            }),
            0,
        )
        .unwrap_err();
        assert!(error.contains("card.data.items"), "{error}");
    }

    #[test]
    fn chart_cards_report_unresolved_data_paths() {
        let result = json!({
            "card": {
                "id": "card-3",
                "title": "Highs",
                "visible": true,
                "template": {"kind": "chart", "chart": "column", "itemsPath": "/daily/max", "labelsPath": "/daily/time"},
                "dataSource": {"kind": "http", "url": "https://example.com", "intervalSeconds": 600},
                "lastData": {"fetchedAtMs": 1, "value": {"daily": {"max": [1, 2]}}}
            }
        });
        let text = render_result_for_assistant("create", &result);
        assert!(text.contains("/daily/time (labelsPath)"), "{text}");
        assert!(!text.contains("/daily/max ("), "{text}");
    }

    #[test]
    fn command_test_guidance_flags_a_different_exec_shell() {
        let same = if cfg!(windows) { "powershell" } else { "sh" };
        assert_eq!(
            command_test_guidance_for(same, "Shell"),
            "ExecCommand uses the same shell as card commands."
        );
        let guidance = command_test_guidance_for("pwsh", "My Shell");
        assert!(guidance.contains("ExecCommand uses My Shell"), "{guidance}");
        let bash = command_test_guidance_for("bash", "Git Bash");
        assert!(bash.contains("ExecCommand uses Git Bash"), "{bash}");
        if cfg!(windows) {
            assert!(
                guidance
                    .contains("powershell.exe -NoProfile -NonInteractive -Command { <command> }"),
                "{guidance}"
            );
            assert!(
                bash.contains("-ExecutionPolicy Bypass -File <file>"),
                "{bash}"
            );
        } else {
            assert!(guidance.contains("/bin/sh -c"), "{guidance}");
            assert!(bash.contains("/bin/sh -c"), "{bash}");
        }
    }

    #[test]
    fn custom_widget_presets_follow_the_app_theme() {
        let presets = presets();
        let mut custom = 0;
        for preset in presets.as_array().unwrap() {
            let Some(html) = preset
                .pointer("/call/card/template/html")
                .and_then(Value::as_str)
            else {
                continue;
            };
            custom += 1;
            for forbidden in ["color:", "background", "innerHTML", "<style"] {
                assert!(
                    !html.contains(forbidden),
                    "{} uses {forbidden}",
                    preset["id"]
                );
            }
            assert!(html.contains("openbitfun-card-"), "{}", preset["id"]);
            let notes = preset["notes"].as_str().unwrap_or_default();
            assert!(
                preset["id"] != "custom-html" || notes.contains(CUSTOM_WIDGET_STYLE_GUIDANCE),
                "{notes}"
            );
        }
        assert_eq!(custom, 2);
        let schema = DesktopCardTool::new().input_schema();
        let html = schema["properties"]["card"]["properties"]["template"]["properties"]["html"]
            ["description"]
            .as_str()
            .unwrap();
        assert!(
            html.contains("no page background or hard-coded colors"),
            "{html}"
        );
    }

    #[test]
    fn cross_shell_commands_avoid_double_quotes() {
        assert!(!PULL_REQUEST_LIST_COMMAND.contains('"'));
        assert!(!REPOSITORY_STATS_COMMAND.contains('"'));
        assert!(!PULL_REQUEST_STATUS_COMMAND_POWERSHELL.contains('"'));
        let preset = presets()
            .as_array()
            .unwrap()
            .iter()
            .find(|preset| preset["id"] == "pull-request-status")
            .unwrap()
            .clone();
        let command = preset
            .pointer("/call/card/dataSource/command")
            .and_then(Value::as_str)
            .unwrap();
        if cfg!(windows) {
            assert!(command.contains("ConvertTo-Json -Compress"));
        } else {
            assert!(command.contains("--jq"));
        }
    }

    fn metrics_card(last_data: Value) -> Value {
        json!({
            "card": {
                "id": "card-1",
                "title": "Repo",
                "visible": true,
                "template": {
                    "kind": "metrics",
                    "items": [
                        {"label": "Stars", "path": "/stars"},
                        {"label": "Forks", "path": "/forks"}
                    ]
                },
                "dataSource": {"kind": "command", "command": "gh api", "intervalSeconds": 300},
                "lastData": last_data
            }
        })
    }

    #[test]
    fn create_results_report_the_first_fetch() {
        let pending = render_result_for_assistant("create", &metrics_card(Value::Null));
        assert!(
            pending.contains("first fetch has not finished"),
            "{pending}"
        );
        assert!(!pending.contains("template paths are missing"), "{pending}");

        let partial = render_result_for_assistant(
            "create",
            &metrics_card(json!({
                "fetchedAtMs": 1,
                "value": {"stars": 12, "forks": null},
                "warning": "gh: rate limited"
            })),
        );
        assert!(partial.contains("wrote to stderr"), "{partial}");
        assert!(partial.contains("gh: rate limited"), "{partial}");
        assert!(partial.contains("latest value {"), "{partial}");
        assert!(partial.contains("\"stars\":12"), "{partial}");
        assert!(
            partial.contains("/forks (metric `Forks` path)"),
            "{partial}"
        );
        assert!(!partial.contains("/stars ("), "{partial}");

        let failed = render_result_for_assistant(
            "update",
            &metrics_card(json!({"fetchedAtMs": 1, "error": "Command exited with 1: boom"})),
        );
        assert!(
            failed.contains("last fetch failed: Command exited with 1: boom"),
            "{failed}"
        );
        assert!(!failed.contains("template paths are missing"), "{failed}");

        let healthy = render_result_for_assistant(
            "create",
            &metrics_card(json!({"fetchedAtMs": 1, "value": {"stars": 1, "forks": 2}})),
        );
        assert!(!healthy.contains("missing or null"), "{healthy}");

        let mut hidden = metrics_card(Value::Null);
        hidden["card"]["visible"] = json!(false);
        let hidden = render_result_for_assistant("create", &hidden);
        assert!(hidden.contains("not fetched until it is shown"), "{hidden}");
        assert!(!hidden.contains("first fetch has not finished"), "{hidden}");
    }

    #[test]
    fn static_cards_report_paths_missing_from_data() {
        let result = json!({
            "card": {
                "id": "card-2",
                "title": "Migration",
                "template": {"kind": "progress", "valuePath": "/done", "maxPath": "/total"},
                "data": {"done": 3}
            }
        });
        let text = render_result_for_assistant("create", &result);
        assert!(text.contains("/total (maxPath)"), "{text}");
        assert!(text.contains("patch.dataMerge"), "{text}");
        assert!(!text.contains("ExecCommand"), "{text}");
        assert!(!text.contains("first fetch"), "{text}");
        let list = render_result_for_assistant(
            "list",
            &json!({"enabled": true, "cards": [result["card"].clone()]}),
        );
        assert!(list.contains("1 template path(s) unresolved"), "{list}");
    }

    #[test]
    fn patch_requires_a_change_and_supports_clearing() {
        assert!(parse_patch(&json!({}), 0).is_err());
        let patch = parse_patch(&json!({"subtitle": null, "dataSource": null}), 0).unwrap();
        assert_eq!(patch.subtitle, Some(None));
        assert_eq!(patch.data_source, Some(None));
        assert!(parse_patch(&json!({"width": 300}), 0).is_err());
    }

    #[test]
    fn command_sources_always_require_fresh_approval() {
        let input = json!({
            "action": "create",
            "card": {
                "title": "PR",
                "template": {"kind": "note", "text": "x"},
                "dataSource": {"kind": "command", "command": "gh pr view 1", "intervalSeconds": 60}
            }
        });
        let intents = DesktopCardTool::new()
            .permission_intents(&input, &context())
            .unwrap();
        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].resources, ["desktop-card:command:gh pr view 1"]);
        assert!(intents[0].save_resources.is_empty());
        assert_eq!(intents[0].display_metadata["requiresFreshApproval"], true);

        let static_card = json!({
            "action": "create",
            "card": {"title": "Note", "template": {"kind": "note", "text": "x"}}
        });
        assert!(DesktopCardTool::new()
            .permission_intents(&static_card, &context())
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn remote_control_turns_are_refused() {
        let mut remote_control = context();
        remote_control.custom_data.insert(
            TOOL_CONTEXT_REMOTE_FILE_DELIVERY_KEY.to_string(),
            Value::Bool(true),
        );
        assert!(
            !DesktopCardTool::new()
                .is_available_in_context(Some(&remote_control))
                .await
        );
        let error = DesktopCardTool::new()
            .call_impl(&json!({"action": "list"}), &remote_control)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("remote mobile or bot"));
    }

    #[tokio::test]
    async fn command_sources_are_refused_for_remote_workspaces() {
        let input = json!({
            "action": "create",
            "card": {
                "title": "Disk",
                "template": {"kind": "note", "text": "x"},
                "dataSource": {"kind": "command", "command": "df -h", "intervalSeconds": 60}
            }
        });
        let error = DesktopCardTool::new()
            .call_impl(&input, &remote_context())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("remote workspace"));
    }

    #[tokio::test]
    async fn presets_do_not_need_a_host() {
        let results = DesktopCardTool::new()
            .call_impl(&json!({"action": "presets"}), &context())
            .await
            .unwrap();
        let ToolResult::Result { data, .. } = &results[0] else {
            panic!("result expected");
        };
        assert!(data["presets"].as_array().unwrap().len() >= 8);
    }
}
