//! PublishMiniApp tool — submit an installed MiniApp to the MiniApp market
//! for human review, deriving the listing metadata from the app manifest.

use crate::agentic::tools::framework::{PermissionIntent, Tool, ToolResult, ToolUseContext};
use crate::infrastructure::events::{emit_global_event, BackendEvent};
use crate::miniapp::try_get_global_miniapp_manager;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use openbitfun_product_domains::miniapp::market::{
    MarketLicense, MarketSubmissionDraftRequest, MARKET_CATEGORIES, MARKET_MAX_SCREENSHOTS,
};
use openbitfun_product_domains::miniapp::types::MiniAppMeta;
use openbitfun_services_integrations::miniapp_market::{
    map_local_category_to_market, resolve_release_target, submit_installed_app,
    suggest_market_slug, DesktopAuthPollRequest, MarketClient, ReleaseTarget,
};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DEFAULT_LICENSE: &str = "MIT";

fn default_min_openbitfun_version() -> &'static str {
    crate::VERSION
}

fn read_string_paths(input: &Value, key: &str) -> Option<Vec<String>> {
    input.get(key).and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    })
}

fn listing_image_paths(input: &Value) -> OpenBitFunResult<Vec<String>> {
    let current = read_string_paths(input, "listing_image_paths");
    let legacy = read_string_paths(input, "screenshot_paths");
    match (current, legacy) {
        (Some(current), Some(legacy)) if current == legacy => Ok(current),
        (Some(_), Some(_)) => Err(OpenBitFunError::validation(
            "listing_image_paths and its deprecated screenshot_paths compatibility alias must not disagree.",
        )),
        (Some(paths), None) | (None, Some(paths)) => Ok(paths),
        (None, None) => Ok(Vec::new()),
    }
}

pub struct PublishMiniAppTool;

impl PublishMiniAppTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for PublishMiniAppTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for PublishMiniAppTool {
    fn name(&self) -> &str {
        "PublishMiniApp"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(r#"Submit an installed MiniApp to the OpenBitFun MiniApp market for human review.

Identify the app by `app_name` — the display name the user used (e.g. "循天问命"), matched against installed apps' manifest names in every locale — or by `app_id` if you already have one. Installed apps are resolved through the running MiniApp manager: do NOT search the filesystem for the app; if the name does not resolve, the error lists every installed app to pick from.

Listing metadata (name, description, icon, category, tags) is derived from the app's manifest; the marketplace slug and release number are derived automatically from the user's submission history. Provide 1-5 `listing_image_paths` (PNG/JPEG/WebP, each <= 5 MiB) for the marketplace gallery. A 16:9 composition is recommended; the first image becomes the listing-card cover. Keep key content clear and away from the edges because marketplace surfaces crop images to 16:9. If no image path is available, ask the user to provide one or have them use 市场 → 我的投稿 → 截取当前画面.

Marketplace administrators may submit a new release for an existing listing even when another user published it originally. The listing keeps its original creator attribution.

If the user is not signed in to the market, the tool returns a GitHub authorization link. Show the link to the user, wait for them to authorize in the browser, then call this tool again with the same arguments.

Publishing is an outward-facing action: only call this when the user explicitly asks to publish/submit the app to the market."#
            .to_string())
    }

    fn short_description(&self) -> String {
        "Submit an installed MiniApp to the market for review.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["listing_image_paths"],
            "properties": {
                "app_name": {
                    "type": "string",
                    "description": "Display name of the installed MiniApp as the user refers to it (matched case-insensitively against manifest names in every locale). Preferred when the user named the app. Provide this or app_id."
                },
                "app_id": {
                    "type": "string",
                    "description": "Installed MiniApp id (e.g. returned by InitMiniApp or an earlier PublishMiniApp error). Provide this or app_name."
                },
                "listing_image_paths": {
                    "type": "array",
                    "items": { "type": "string" },
                    "minItems": 1,
                    "maxItems": 5,
                    "description": "1-5 absolute paths to PNG/JPEG/WebP marketplace images, each <= 5 MiB. A 16:9 composition works best (1920x1080 recommended, 2560x1440 max useful); the first image becomes the listing-card cover. Keep key content clear and away from the edges because the web market and OpenBitFun desktop client crop images to 16:9."
                },
                "changelog": {
                    "type": "string",
                    "description": "What changed in this release. Defaults to a generic note."
                },
                "slug": {
                    "type": "string",
                    "description": "Marketplace slug override (3-63 lowercase letters, digits, hyphens). Immutable after first publish. Defaults to a slug derived from the app name."
                },
                "description": {
                    "type": "string",
                    "description": "Public listing description override (1-500 chars). Defaults to the manifest description."
                },
                "category": {
                    "type": "string",
                    "description": "Market category override: developer, productivity, data, creative, education, utilities, entertainment, other. Defaults to a mapping of the manifest category."
                }
            }
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn permission_intents(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        let identity = input
            .get("app_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                input
                    .get("app_name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            })
            .unwrap_or("unknown");
        Ok(vec![PermissionIntent::new(
            "custom_tool",
            vec![format!("miniapp:PublishMiniApp:{identity}")],
        )])
    }

    async fn call_impl(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let manager = try_get_global_miniapp_manager()
            .ok_or_else(|| OpenBitFunError::tool("MiniAppManager not initialized".to_string()))?;

        let app_id = input
            .get("app_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let app_name = input
            .get("app_name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());

        // Resolve the app through the running MiniApp manager — never via the
        // filesystem. Every failure path carries the installed-app roster so
        // the model can correct itself in the next call instead of going
        // hunting for ids elsewhere.
        let app = if let Some(app_id) = app_id {
            match manager.get(app_id).await {
                Ok(app) => app,
                Err(error) => {
                    let apps = manager.list().await.unwrap_or_default();
                    return Err(OpenBitFunError::validation(format!(
                        "Installed MiniApp '{app_id}' not found: {error}\nInstalled apps (id — name):\n{}",
                        installed_roster(apps.iter())
                    )));
                }
            }
        } else if let Some(app_name) = app_name {
            let apps = manager.list().await.map_err(|e| {
                OpenBitFunError::tool(format!("Could not list installed MiniApps: {e}"))
            })?;
            let matches = find_apps_by_name(&apps, app_name);
            match matches.as_slice() {
                [only] => manager.get(&only.id).await.map_err(|e| {
                    OpenBitFunError::tool(format!("Installed MiniApp not found: {e}"))
                })?,
                [] => {
                    return Err(OpenBitFunError::validation(format!(
                        "No installed MiniApp is named '{app_name}'. Installed apps (id — name):\n{}",
                        installed_roster(apps.iter())
                    )));
                }
                many => {
                    return Err(OpenBitFunError::validation(format!(
                        "'{app_name}' matches several installed MiniApps — call again with the app_id:\n{}",
                        installed_roster(many.iter().copied())
                    )));
                }
            }
        } else {
            let apps = manager.list().await.unwrap_or_default();
            return Err(OpenBitFunError::validation(format!(
                "Provide app_name (the display name the user used) or app_id. Installed apps (id — name):\n{}",
                installed_roster(apps.iter())
            )));
        };

        let listing_image_paths = listing_image_paths(input)?;
        if listing_image_paths.is_empty() || listing_image_paths.len() > MARKET_MAX_SCREENSHOTS {
            return Err(OpenBitFunError::validation(
                "listing_image_paths must contain 1-5 marketplace image paths (PNG/JPEG/WebP). Ask the user to provide an image, or have them add one via 市场 → 我的投稿.",
            ));
        }
        for path in &listing_image_paths {
            if tokio::fs::metadata(path).await.is_err() {
                return Err(OpenBitFunError::validation(format!(
                    "Marketplace image file not found: {path}"
                )));
            }
        }

        let mut client = MarketClient::from_environment()
            .await
            .map_err(|e| OpenBitFunError::tool(format!("MiniApp market unavailable: {e}")))?;

        // Not signed in: hand the GitHub authorization link to the user and
        // keep polling in the background so their browser approval lands in
        // the shared credential vault before the next tool call.
        let me = client.me().await.map_err(|e| {
            OpenBitFunError::tool(format!("MiniApp market sign-in check failed: {e}"))
        })?;
        let Some(me) = me else {
            let start = client.start_desktop_auth().await.map_err(|e| {
                OpenBitFunError::tool(format!("Could not start GitHub sign-in: {e}"))
            })?;
            let authorization_url = start.authorization_url.clone();
            let poll_request = DesktopAuthPollRequest {
                transaction_id: start.transaction_id.clone(),
                transaction_secret: start.transaction_secret.clone(),
            };
            let interval = Duration::from_secs(start.poll_interval_seconds.max(1) as u64);
            let expires_at = start.expires_at;
            tokio::spawn(async move {
                loop {
                    if unix_now() >= expires_at {
                        break;
                    }
                    tokio::time::sleep(interval).await;
                    match client.poll_desktop_auth(&poll_request).await {
                        Ok(response) if response.status == "authorized" => break,
                        Ok(response) if response.status == "expired" => break,
                        Ok(_) => continue,
                        Err(_) => break,
                    }
                }
            });
            let message = format!(
                "The user is not signed in to the MiniApp market. Show this GitHub authorization link to the user and ask them to open it in a browser: {authorization_url}\nOpenBitFun keeps polling in the background; after the user finishes authorizing, call PublishMiniApp again with the same arguments to continue publishing."
            );
            return Ok(vec![ToolResult::Result {
                data: json!({
                    "status": "sign_in_required",
                    "authorization_url": authorization_url,
                    "expires_at": expires_at,
                }),
                result_for_assistant: Some(message),
                image_attachments: None,
            }]);
        };

        // Derive the public listing metadata from the manifest, with explicit
        // overrides taking precedence.
        let description = input
            .get("description")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| app.description.trim().to_string());
        if description.is_empty() {
            return Err(OpenBitFunError::validation(
                "The app has no description. Update meta.json's description (or pass the description parameter) before publishing.",
            ));
        }
        let category = match input
            .get("category")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(value) if MARKET_CATEGORIES.contains(&value) => value.to_string(),
            Some(value) => {
                return Err(OpenBitFunError::validation(format!(
                    "Unknown market category '{value}'. Use one of: {}.",
                    MARKET_CATEGORIES.join(", ")
                )))
            }
            None => map_local_category_to_market(&app.category),
        };
        let slug = input
            .get("slug")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| suggest_market_slug(&app.name, &app.id));

        let submissions = client.list_submissions().await.map_err(|e| {
            OpenBitFunError::tool(format!("Could not load submission history: {e}"))
        })?;
        let release_target = match resolve_release_target(&submissions, &slug) {
            ReleaseTarget::NewListing if me.is_admin => match client.listing(&slug).await {
                Ok(listing) => ReleaseTarget::ExistingListing {
                    listing_id: listing.summary.listing_id,
                    next_release: listing.summary.latest_release + 1,
                },
                Err(error) if error.code == "not_found" => ReleaseTarget::NewListing,
                Err(error) => {
                    return Err(OpenBitFunError::tool(format!(
                        "Could not resolve the administrator release target for '{slug}': {error}"
                    )))
                }
            },
            target => target,
        };
        let (listing_id, release_number) = match release_target {
            ReleaseTarget::NewListing => (None, 1),
            ReleaseTarget::ExistingListing {
                listing_id,
                next_release,
            } => (Some(listing_id), next_release),
            ReleaseTarget::PendingReview {
                submission_id,
                release_number,
            } => {
                let message = format!(
                    "'{slug}' v{release_number} is already under review (submission {submission_id}). Wait for the review to finish, or withdraw it in 市场 → 我的投稿 before publishing a new release."
                );
                return Ok(vec![ToolResult::Result {
                    data: json!({
                        "status": "pending_review",
                        "slug": slug,
                        "submission_id": submission_id,
                        "release_number": release_number,
                    }),
                    result_for_assistant: Some(message),
                    image_attachments: None,
                }]);
            }
        };

        let changelog = input
            .get("changelog")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                if release_number > 1 {
                    "General updates and improvements.".to_string()
                } else {
                    "Initial release.".to_string()
                }
            });

        let mut tags: Vec<String> = app
            .tags
            .iter()
            .map(|tag| tag.trim().to_string())
            .filter(|tag| !tag.is_empty() && tag.chars().count() <= 32)
            .collect();
        tags.truncate(10);

        let draft = MarketSubmissionDraftRequest {
            listing_id,
            slug: slug.clone(),
            release_number,
            name: app.name.trim().to_string(),
            description,
            icon: app.icon.clone(),
            category,
            tags,
            min_openbitfun_version: default_min_openbitfun_version().to_string(),
            changelog,
            license: MarketLicense {
                spdx_expression: Some(DEFAULT_LICENSE.to_string()),
                custom_url: None,
            },
            repository_url: None,
        };

        // Mirror upload progress onto the same event the submissions view
        // already listens to, so an open UI shows the agent-driven upload.
        let (progress_tx, mut progress_rx) =
            tokio::sync::mpsc::unbounded_channel::<(Option<String>, &'static str, u32, u32)>();
        let forwarder = tokio::spawn(async move {
            while let Some((submission_id, phase, completed, total)) = progress_rx.recv().await {
                let _ = emit_global_event(BackendEvent::Custom {
                    event_name: "miniapp-market-upload-progress".to_string(),
                    payload: json!({
                        "submissionId": submission_id,
                        "phase": phase,
                        "completed": completed,
                        "total": total,
                    }),
                })
                .await;
            }
        });
        let mut progress = |submission_id: Option<&str>, phase: &'static str, completed, total| {
            let _ = progress_tx.send((submission_id.map(str::to_string), phase, completed, total));
        };
        let result = submit_installed_app(
            &mut client,
            &app,
            &draft,
            &listing_image_paths,
            &mut progress,
        )
        .await;
        drop(progress_tx);
        let _ = forwarder.await;
        let submission = result.map_err(|error| {
            let hint = match error.code.as_str() {
                "slug_taken" => " Pass a different `slug` parameter and retry.",
                "authentication_required" => " Call PublishMiniApp again to start GitHub sign-in.",
                "invalid_release_number" => {
                    " Retry once; the release number is derived from the latest submission history."
                }
                _ => "",
            };
            OpenBitFunError::tool(format!(
                "Publishing failed ({}): {}{hint}",
                error.code, error
            ))
        })?;

        let message = format!(
            "MiniApp '{}' submitted for review as '{}' v{} (signed in as {}). The user can track review status in 市场 → 我的投稿; published versions stay downloadable while the review runs.",
            submission.name, submission.slug, submission.release_number, me.user.login
        );
        Ok(vec![ToolResult::Result {
            data: json!({
                "status": "submitted",
                "submission_id": submission.submission_id,
                "slug": submission.slug,
                "release_number": submission.release_number,
                "name": submission.name,
                "category": submission.category,
            }),
            result_for_assistant: Some(message),
            image_attachments: None,
        }])
    }
}

/// Every display name an installed app answers to, lower-cased: the manifest
/// name plus each locale's i18n name.
fn display_names(meta: &MiniAppMeta) -> Vec<String> {
    let mut names = vec![meta.name.trim().to_lowercase()];
    if let Some(i18n) = &meta.i18n {
        for strings in i18n.locales.values() {
            if let Some(name) = &strings.name {
                names.push(name.trim().to_lowercase());
            }
        }
    }
    names
}

/// Match a user-supplied display name against installed apps: exact
/// (case-insensitive, any locale) first, substring as a fallback.
fn find_apps_by_name<'a>(apps: &'a [MiniAppMeta], needle: &str) -> Vec<&'a MiniAppMeta> {
    let needle = needle.trim().to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let exact: Vec<&MiniAppMeta> = apps
        .iter()
        .filter(|meta| display_names(meta).iter().any(|name| *name == needle))
        .collect();
    if !exact.is_empty() {
        return exact;
    }
    apps.iter()
        .filter(|meta| {
            display_names(meta)
                .iter()
                .any(|name| name.contains(&needle))
        })
        .collect()
}

/// "id — name" lines for error messages, capped to keep the result readable.
fn installed_roster<'a>(apps: impl Iterator<Item = &'a MiniAppMeta>) -> String {
    let lines: Vec<String> = apps
        .take(40)
        .map(|meta| format!("{} — {}", meta.id, meta.name))
        .collect();
    if lines.is_empty() {
        "(no MiniApps installed)".to_string()
    } else {
        lines.join("\n")
    }
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{
        default_min_openbitfun_version, find_apps_by_name, listing_image_paths, PublishMiniAppTool,
    };
    use crate::agentic::tools::framework::{Tool, ToolExposure, ToolUseContext};
    use openbitfun_product_domains::miniapp::types::MiniAppMeta;
    use serde_json::json;

    #[test]
    fn publish_miniapp_stays_expanded_for_assistant_use() {
        let tool = PublishMiniAppTool::new();
        assert_eq!(tool.default_exposure(), ToolExposure::Direct);
    }

    #[test]
    fn publish_miniapp_defaults_to_current_client_version() {
        assert_eq!(default_min_openbitfun_version(), crate::VERSION);
    }

    #[test]
    fn publish_miniapp_emits_stable_permission_identity() {
        let tool = PublishMiniAppTool::new();
        let context = ToolUseContext::for_tool_listing(None, None);
        let intents = tool
            .permission_intents(&json!({ "app_id": "abc-123" }), &context)
            .expect("permission intent");

        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].action, "custom_tool");
        assert_eq!(
            intents[0].resources,
            ["miniapp:PublishMiniApp:abc-123".to_string()]
        );
    }

    #[test]
    fn publish_miniapp_schema_requires_listing_images() {
        let tool = PublishMiniAppTool::new();
        let schema = tool.input_schema();
        assert_eq!(schema["required"], json!(["listing_image_paths"]));
        assert!(schema["properties"]["listing_image_paths"]["description"]
            .as_str()
            .is_some_and(|description| description.contains("listing-card cover")));
        assert!(schema["properties"].get("screenshot_paths").is_none());
        assert!(schema["properties"]["app_name"].is_object());
        assert!(schema["properties"]["app_id"].is_object());
        assert_eq!(schema["additionalProperties"], json!(false));
    }

    #[test]
    fn publish_miniapp_accepts_legacy_screenshot_paths_for_pending_calls() {
        assert_eq!(
            listing_image_paths(&json!({ "screenshot_paths": ["/tmp/cover.webp"] })).unwrap(),
            vec!["/tmp/cover.webp".to_string()]
        );
        assert_eq!(
            listing_image_paths(&json!({
                "listing_image_paths": ["/tmp/cover.webp"],
                "screenshot_paths": ["/tmp/cover.webp"]
            }))
            .unwrap(),
            vec!["/tmp/cover.webp".to_string()]
        );
        assert!(listing_image_paths(&json!({
            "listing_image_paths": ["/tmp/new.webp"],
            "screenshot_paths": ["/tmp/old.webp"]
        }))
        .is_err());
    }

    #[test]
    fn publish_miniapp_permission_identity_falls_back_to_app_name() {
        let tool = PublishMiniAppTool::new();
        let context = ToolUseContext::for_tool_listing(None, None);
        let intents = tool
            .permission_intents(&json!({ "app_name": "循天问命" }), &context)
            .expect("permission intent");
        assert_eq!(
            intents[0].resources,
            ["miniapp:PublishMiniApp:循天问命".to_string()]
        );
    }

    fn meta(id: &str, name: &str, locale_name: Option<&str>) -> MiniAppMeta {
        use openbitfun_product_domains::miniapp::types::{MiniAppI18n, MiniAppLocaleStrings};
        use std::collections::HashMap;
        MiniAppMeta {
            id: id.to_string(),
            name: name.to_string(),
            description: String::new(),
            icon: String::new(),
            category: String::new(),
            tags: Vec::new(),
            version: 1,
            created_at: 0,
            updated_at: 0,
            permissions: Default::default(),
            ai_context: None,
            runtime: Default::default(),
            runtime_profile: Default::default(),
            i18n: locale_name.map(|value| MiniAppI18n {
                locales: HashMap::from([(
                    "en-US".to_string(),
                    MiniAppLocaleStrings {
                        name: Some(value.to_string()),
                        description: None,
                        tags: None,
                    },
                )]),
            }),
        }
    }

    #[test]
    fn find_apps_by_name_matches_any_locale_exactly() {
        let apps = vec![
            meta("a1", "循天问命", Some("BaZi Chart")),
            meta("a2", "五子棋", None),
        ];
        let by_zh = find_apps_by_name(&apps, "循天问命");
        assert_eq!(by_zh.len(), 1);
        assert_eq!(by_zh[0].id, "a1");
        let by_en = find_apps_by_name(&apps, "bazi chart");
        assert_eq!(by_en.len(), 1);
        assert_eq!(by_en[0].id, "a1");
    }

    #[test]
    fn find_apps_by_name_falls_back_to_substring_and_reports_ambiguity() {
        let apps = vec![meta("a1", "循天问命", None), meta("a2", "问命笺", None)];
        let partial = find_apps_by_name(&apps, "问命");
        assert_eq!(partial.len(), 2);
        assert!(find_apps_by_name(&apps, "不存在").is_empty());
        assert!(find_apps_by_name(&apps, "  ").is_empty());
    }
}
