//! PublishAppearance tool — submit a local `.openbitfun-appearance` archive to
//! the public Skin market for human review.

use crate::agentic::tools::framework::{PermissionIntent, Tool, ToolResult, ToolUseContext};
use crate::infrastructure::events::{emit_global_event, BackendEvent};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use openbitfun_product_domains::appearance_market::{
    validate_appearance_market_slug, AppearanceMarketLicense,
    AppearanceMarketSubmissionDraftRequest,
};
use openbitfun_services_integrations::appearance_market::{
    resolve_appearance_release_target, submit_appearance_package, suggest_appearance_slug,
    AppearanceMarketClient, AppearanceReleaseTarget,
};
use openbitfun_services_integrations::miniapp_market::DesktopAuthPollRequest;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub struct PublishAppearanceTool;

impl PublishAppearanceTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for PublishAppearanceTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for PublishAppearanceTool {
    fn name(&self) -> &str {
        "PublishAppearance"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(r#"Submit a local `.openbitfun-appearance` package to the OpenBitFun Skin market for human review.

The product calls catalog entries "Skins", but package/runtime identifiers always remain Appearance: `appearance.json`, schema `openbitfun.appearance`, and extension `.openbitfun-appearance`. Pass an absolute local path to a completed archive. The package itself supplies the public name, description, author, version, mode and preview; the tool derives the marketplace slug and next release number from submission history.

The caller must explicitly provide the package's SPDX license expression. If the package is not under a standard SPDX license, provide `custom_license_url` instead. The package is validated locally before upload and validated again by the server. If sign-in is required, the tool returns a GitHub authorization URL; show it to the user and call this tool again after authorization.

This is an outward-facing publication action. Use it only when the user explicitly asks to publish or submit a Skin/Appearance package. It reads files from the local desktop host and is intentionally unavailable for remote SSH workspaces."#.to_string())
    }

    fn short_description(&self) -> String {
        "Submit an Appearance package to the Skin market for review.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["package_path"],
            "properties": {
                "package_path": {
                    "type": "string",
                    "description": "Absolute local path to a `.openbitfun-appearance` archive. Remote SSH workspace paths are not supported."
                },
                "slug": {
                    "type": "string",
                    "description": "Optional marketplace slug (3-63 lowercase ASCII letters, digits and hyphens). Immutable after first approval."
                },
                "changelog": {
                    "type": "string",
                    "description": "What changed in this release. Defaults to Initial release or General updates and improvements."
                },
                "license_spdx": {
                    "type": "string",
                    "description": "SPDX license expression confirmed by the user, for example MIT or Apache-2.0. Provide this or custom_license_url."
                },
                "custom_license_url": {
                    "type": "string",
                    "description": "HTTPS URL to custom license terms confirmed by the user. Provide this only when an SPDX expression is not appropriate."
                },
                "repository_url": {
                    "type": "string",
                    "description": "Optional public HTTPS repository URL for the Skin source."
                },
                "min_openbitfun_version": {
                    "type": "string",
                    "description": "Minimum compatible OpenBitFun semantic version. Defaults to this running client version."
                }
            }
        })
    }

    fn output_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["sign_in_required", "pending_review", "submitted"]},
                "authorization_url": {"type": "string"},
                "slug": {"type": "string"},
                "submission_id": {"type": "string"},
                "release_number": {"type": "integer"},
                "name": {"type": "string"}
            },
            "required": ["status"],
            "additionalProperties": true
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    async fn is_available_in_context(&self, context: Option<&ToolUseContext>) -> bool {
        context.is_none_or(|context| !context.is_remote())
    }

    fn permission_intents(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        let package_path = input
            .get("package_path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("unknown");
        let slug = input
            .get("slug")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("<derived-from-package>");
        let license = input
            .get("license_spdx")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| format!("SPDX: {value}"))
            .or_else(|| {
                input
                    .get("custom_license_url")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| format!("Custom: {value}"))
            })
            .unwrap_or_else(|| "<missing-license>".to_string());
        let repository = input
            .get("repository_url")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("<none>");
        let min_version = input
            .get("min_openbitfun_version")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("<current-client-version>");
        let changelog = input
            .get("changelog")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("<default-release-notes>");
        let resource = format!(
            "appearance:{slug}; release=next; package={package_path}; license={license}; repository={repository}; min-version={min_version}"
        );
        let mut intent = PermissionIntent::new("custom_tool", vec![resource]);
        // Marketplace publication is an outward account mutation. Keep every
        // submission per-call so a remembered grant cannot hide changed release
        // metadata or allow a later resubmission of the same local archive.
        intent.save_resources.clear();
        intent.display_metadata.insert(
            "permissionScope".to_string(),
            Value::String("account".to_string()),
        );
        intent
            .display_metadata
            .insert("requiresFreshApproval".to_string(), Value::Bool(true));
        intent.display_metadata.insert(
            "appearanceOperation".to_string(),
            Value::String("submit-for-review".to_string()),
        );
        intent.display_metadata.insert(
            "appearancePackagePath".to_string(),
            Value::String(package_path.to_string()),
        );
        intent.display_metadata.insert(
            "appearanceSlug".to_string(),
            Value::String(slug.to_string()),
        );
        intent.display_metadata.insert(
            "appearanceRelease".to_string(),
            Value::String("next".to_string()),
        );
        intent
            .display_metadata
            .insert("appearanceLicense".to_string(), Value::String(license));
        intent.display_metadata.insert(
            "appearanceRepository".to_string(),
            Value::String(repository.to_string()),
        );
        intent.display_metadata.insert(
            "appearanceMinOpenBitFunVersion".to_string(),
            Value::String(min_version.to_string()),
        );
        intent.display_metadata.insert(
            "appearanceChangelog".to_string(),
            Value::String(changelog.to_string()),
        );
        Ok(vec![intent])
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        if context.is_remote() {
            return Err(OpenBitFunError::validation(
                "PublishAppearance reads a package from the local desktop host and cannot use a remote SSH workspace path. Export the .openbitfun-appearance package to the local device, switch to a local workspace, and call the tool again.",
            ));
        }
        let package_path = required_local_package_path(input)?;
        let (license, repository_url) = publication_metadata(input)?;
        let fallback_name = package_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("appearance");
        let fallback_seed = package_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("package");
        let slug = input
            .get("slug")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| suggest_appearance_slug(fallback_name, fallback_seed));
        if !validate_appearance_market_slug(&slug) {
            return Err(OpenBitFunError::validation(
                "slug must contain 3-63 lowercase ASCII letters, digits, or hyphens and cannot start with a hyphen.",
            ));
        }

        let mut client = AppearanceMarketClient::from_environment()
            .await
            .map_err(|error| OpenBitFunError::tool(format!("Skin market unavailable: {error}")))?;
        let me = client.me().await.map_err(|error| {
            OpenBitFunError::tool(format!("Skin market sign-in check failed: {error}"))
        })?;
        let Some(me) = me else {
            let start = client.start_desktop_auth().await.map_err(|error| {
                OpenBitFunError::tool(format!(
                    "Could not start Skin market GitHub sign-in: {error}"
                ))
            })?;
            let authorization_url = start.authorization_url.clone();
            let poll_request = DesktopAuthPollRequest {
                transaction_id: start.transaction_id,
                transaction_secret: start.transaction_secret,
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
                        Ok(response)
                            if matches!(response.status.as_str(), "authorized" | "expired") =>
                        {
                            break;
                        }
                        Ok(_) => continue,
                        Err(_) => break,
                    }
                }
            });
            return Ok(vec![ToolResult::Result {
                data: json!({
                    "status": "sign_in_required",
                    "authorization_url": authorization_url,
                    "expires_at": expires_at,
                }),
                result_for_assistant: Some(format!(
                    "The user is not signed in to the Skin market. Show this GitHub authorization link and ask them to open it in a browser: {authorization_url}\nOpenBitFun is polling in the background. After authorization, call PublishAppearance again with the same arguments."
                )),
                image_attachments: None,
            }]);
        };

        let submissions = client.list_submissions().await.map_err(|error| {
            OpenBitFunError::tool(format!("Could not load Skin submission history: {error}"))
        })?;
        let (listing_id, release_number) = match resolve_appearance_release_target(
            &submissions,
            &slug,
        ) {
            AppearanceReleaseTarget::NewListing => (None, 1),
            AppearanceReleaseTarget::ExistingListing {
                listing_id,
                next_release,
            } => (Some(listing_id), next_release),
            AppearanceReleaseTarget::PendingReview {
                submission_id,
                release_number,
            } => {
                return Ok(vec![ToolResult::Result {
                        data: json!({
                            "status": "pending_review",
                            "slug": slug,
                            "submission_id": submission_id,
                            "release_number": release_number,
                        }),
                        result_for_assistant: Some(format!(
                            "Skin '{slug}' release {release_number} is already under review (submission {submission_id}). Wait for review or withdraw that draft before publishing again."
                        )),
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
                if release_number == 1 {
                    "Initial release.".to_string()
                } else {
                    "General updates and improvements.".to_string()
                }
            });
        if changelog.len() > 2_000 {
            return Err(OpenBitFunError::validation(
                "changelog must be no longer than 2,000 bytes.",
            ));
        }
        let min_openbitfun_version = input
            .get("min_openbitfun_version")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(crate::VERSION)
            .to_string();
        semver::Version::parse(&min_openbitfun_version).map_err(|_| {
            OpenBitFunError::validation("min_openbitfun_version must use semantic version syntax.")
        })?;
        let draft = AppearanceMarketSubmissionDraftRequest {
            listing_id,
            slug: slug.clone(),
            release_number,
            min_openbitfun_version,
            changelog,
            license,
            repository_url,
        };

        let (progress_tx, mut progress_rx) =
            tokio::sync::mpsc::unbounded_channel::<(Option<String>, &'static str, u32, u32)>();
        let forwarder = tokio::spawn(async move {
            while let Some((submission_id, phase, completed, total)) = progress_rx.recv().await {
                let _ = emit_global_event(BackendEvent::Custom {
                    event_name: "appearance-market-upload-progress".to_string(),
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
        let result =
            submit_appearance_package(&mut client, &package_path, &draft, &mut progress).await;
        drop(progress_tx);
        let _ = forwarder.await;
        let submission = result.map_err(|error| {
            let hint = match error.code.as_str() {
                "slug_taken" => " Pass a different `slug` and retry.",
                "authentication_required" => {
                    " Call PublishAppearance again to start GitHub sign-in."
                }
                "invalid_release_number" => {
                    " Retry once; the release number is derived from submission history."
                }
                _ => "",
            };
            OpenBitFunError::tool(format!(
                "Publishing Skin failed ({}): {}{hint}",
                error.code, error
            ))
        })?;
        let name = submission
            .name
            .as_deref()
            .unwrap_or(submission.slug.as_str());
        Ok(vec![ToolResult::Result {
            data: json!({
                "status": "submitted",
                "submission_id": submission.submission_id,
                "slug": submission.slug,
                "release_number": submission.release_number,
                "package_id": submission.package_id,
                "name": submission.name,
            }),
            result_for_assistant: Some(format!(
                "Skin '{name}' was submitted for review as '{}' release {} (signed in as {}).",
                submission.slug, submission.release_number, me.user.login
            )),
            image_attachments: None,
        }])
    }
}

fn required_local_package_path(input: &Value) -> OpenBitFunResult<PathBuf> {
    let raw = input
        .get("package_path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| OpenBitFunError::validation("package_path is required."))?;
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(OpenBitFunError::validation(
            "package_path must be an absolute local path.",
        ));
    }
    if !raw.to_ascii_lowercase().ends_with(".openbitfun-appearance") {
        return Err(OpenBitFunError::validation(
            "package_path must end in .openbitfun-appearance.",
        ));
    }
    Ok(path.to_path_buf())
}

fn publication_metadata(
    input: &Value,
) -> OpenBitFunResult<(AppearanceMarketLicense, Option<String>)> {
    let spdx = optional_text(input, "license_spdx");
    let custom_url = optional_https_url(input, "custom_license_url")?;
    if spdx.is_none() == custom_url.is_none() {
        return Err(OpenBitFunError::validation(
            "Provide exactly one of license_spdx or custom_license_url, confirmed by the user.",
        ));
    }
    if spdx.as_ref().is_some_and(|value| {
        value.len() > 120
            || !value.chars().all(|character| {
                character.is_ascii_alphanumeric()
                    || matches!(character, '-' | '.' | '+' | '(' | ')' | ' ' | ':')
            })
    }) {
        return Err(OpenBitFunError::validation(
            "license_spdx is not a supported SPDX expression shape.",
        ));
    }
    let repository_url = optional_https_url(input, "repository_url")?;
    Ok((
        AppearanceMarketLicense {
            spdx_expression: spdx,
            custom_url,
        },
        repository_url,
    ))
}

fn optional_text(input: &Value, field: &str) -> Option<String> {
    input
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn optional_https_url(input: &Value, field: &str) -> OpenBitFunResult<Option<String>> {
    let Some(value) = optional_text(input, field) else {
        return Ok(None);
    };
    let parsed = reqwest::Url::parse(&value)
        .map_err(|_| OpenBitFunError::validation(format!("{field} must be a valid HTTPS URL.")))?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err(OpenBitFunError::validation(format!(
            "{field} must be a valid HTTPS URL."
        )));
    }
    Ok(Some(value))
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::tools::framework::{Tool, ToolExposure, ToolUseContext};

    #[test]
    fn publish_appearance_is_direct_and_requires_a_package() {
        let tool = PublishAppearanceTool::new();
        assert_eq!(tool.default_exposure(), ToolExposure::Direct);
        assert_eq!(tool.input_schema()["required"], json!(["package_path"]));
    }

    #[test]
    fn permission_identity_requires_fresh_approval_for_submission_metadata() {
        let tool = PublishAppearanceTool::new();
        let context = ToolUseContext::for_tool_listing(None, None);
        let intents = tool
            .permission_intents(
                &json!({
                    "package_path": "/tmp/calm.openbitfun-appearance",
                    "slug": "calm-skin",
                    "license_spdx": "MIT",
                    "repository_url": "https://example.com/calm",
                    "min_openbitfun_version": "1.2.3",
                    "changelog": "Initial release"
                }),
                &context,
            )
            .unwrap();
        assert_eq!(
            intents[0].resources,
            ["appearance:calm-skin; release=next; package=/tmp/calm.openbitfun-appearance; license=SPDX: MIT; repository=https://example.com/calm; min-version=1.2.3".to_string()]
        );
        assert!(intents[0].save_resources.is_empty());
        assert_eq!(
            intents[0].display_metadata.get("requiresFreshApproval"),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            intents[0].display_metadata.get("appearanceChangelog"),
            Some(&Value::String("Initial release".to_string()))
        );
    }

    #[test]
    fn publication_requires_exactly_one_license_source() {
        assert!(publication_metadata(&json!({})).is_err());
        assert!(publication_metadata(&json!({
            "license_spdx": "MIT",
            "custom_license_url": "https://example.com/license"
        }))
        .is_err());
        assert!(publication_metadata(&json!({"license_spdx": "MIT"})).is_ok());
    }
}
