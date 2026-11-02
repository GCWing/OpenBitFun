use crate::agentic::image_analysis::{
    build_multimodal_message, detect_mime_type_from_bytes, optimize_image_with_size_limit,
    resolve_vision_model_from_global_config,
};
use crate::agentic::tools::framework::{
    Tool, ToolExposure, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::infrastructure::ai::get_global_ai_client_factory;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tokio::fs;

pub struct AnalyzeImageTool;

#[derive(Debug, Clone)]
enum ResolvedImagePath {
    Local(PathBuf),
    RemoteWorkspace { logical_path: String, path: String },
}

impl ResolvedImagePath {
    fn display_path(&self) -> &str {
        match self {
            Self::Local(path) => path.to_str().unwrap_or("<non-utf8-path>"),
            Self::RemoteWorkspace { logical_path, .. } => logical_path,
        }
    }
}

impl Default for AnalyzeImageTool {
    fn default() -> Self {
        Self::new()
    }
}

impl AnalyzeImageTool {
    pub fn new() -> Self {
        Self
    }

    fn path_from_input(input: &Value) -> OpenBitFunResult<&str> {
        input
            .get("path")
            .and_then(Value::as_str)
            .filter(|path| !path.trim().is_empty())
            .ok_or_else(|| OpenBitFunError::tool("path is required".to_string()))
    }

    fn prompt_from_input(input: &Value) -> String {
        input
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|prompt| !prompt.is_empty())
            .unwrap_or("Analyze this image in detail. Describe visible content, text, layout, and any details relevant to the user's task.")
            .to_string()
    }

    fn resolve_path(
        input_path: &str,
        context: Option<&ToolUseContext>,
    ) -> OpenBitFunResult<ResolvedImagePath> {
        let local_path = Path::new(input_path);
        if local_path.is_absolute()
            && !crate::agentic::tools::workspace_paths::is_openbitfun_tool_uri(input_path)
            && !context.is_some_and(|ctx| ctx.is_remote())
        {
            return Ok(ResolvedImagePath::Local(local_path.to_path_buf()));
        }

        match context.map(|ctx| ctx.resolve_tool_path(input_path)) {
            Some(Ok(resolved)) => {
                if resolved.uses_remote_workspace_backend() {
                    return Ok(ResolvedImagePath::RemoteWorkspace {
                        logical_path: resolved.logical_path,
                        path: resolved.resolved_path,
                    });
                }
                Ok(ResolvedImagePath::Local(PathBuf::from(
                    resolved.resolved_path,
                )))
            }
            Some(Err(err)) => Err(err),
            None => {
                let path = Path::new(input_path);
                if !path.is_absolute() {
                    return Err(OpenBitFunError::tool(format!(
                        "path must be an absolute path when no tool context is available, got: {}",
                        input_path
                    )));
                }
                Ok(ResolvedImagePath::Local(path.to_path_buf()))
            }
        }
    }

    async fn read_image_bytes(
        resolved: &ResolvedImagePath,
        context: Option<&ToolUseContext>,
    ) -> OpenBitFunResult<Vec<u8>> {
        match resolved {
            ResolvedImagePath::Local(path) => {
                let metadata = fs::metadata(path).await.map_err(|err| {
                    OpenBitFunError::tool(format!(
                        "unable to locate image at {}: {}",
                        path.display(),
                        err
                    ))
                })?;
                if !metadata.is_file() {
                    return Err(OpenBitFunError::tool(format!(
                        "image path is not a file: {}",
                        path.display()
                    )));
                }

                fs::read(path).await.map_err(|err| {
                    OpenBitFunError::tool(format!(
                        "unable to read image at {}: {}",
                        path.display(),
                        err
                    ))
                })
            }
            ResolvedImagePath::RemoteWorkspace { path, logical_path } => {
                let fs = context.and_then(|ctx| ctx.ws_fs()).ok_or_else(|| {
                    OpenBitFunError::tool(
                        "analyze_image cannot read remote workspace images because workspace filesystem services are unavailable"
                            .to_string(),
                    )
                })?;
                let is_file = fs.is_file(path).await.map_err(|err| {
                    OpenBitFunError::tool(format!(
                        "unable to inspect remote image at {}: {}",
                        logical_path, err
                    ))
                })?;
                if !is_file {
                    return Err(OpenBitFunError::tool(format!(
                        "image path is not a file: {}",
                        logical_path
                    )));
                }

                fs.read_file(path).await.map_err(|err| {
                    OpenBitFunError::tool(format!(
                        "unable to read remote image at {}: {}",
                        logical_path, err
                    ))
                })
            }
        }
    }

    /// Persist the vision model call's token usage.
    ///
    /// The image understanding call goes straight to `AIClient` instead of the
    /// round executor, so it never produces a `TokenUsageUpdated` event. Record
    /// it directly against the global usage store when one is installed.
    async fn record_token_usage(
        vision_model: &crate::service::config::types::AIModelConfig,
        context: &ToolUseContext,
        response: &crate::util::types::ai::GeminiResponse,
    ) {
        let Some(usage) = response.usage.as_ref() else {
            return;
        };
        let Some(service) = crate::service::token_usage::get_global_token_usage_service() else {
            return;
        };
        if let Err(err) = service
            .record_usage(
                vision_model.id.clone(),
                vision_model.model_name.clone(),
                context.session_id.clone().unwrap_or_default(),
                context.dialog_turn_id.clone().unwrap_or_default(),
                usage.prompt_token_count,
                usage.candidates_token_count,
                usage.cached_content_token_count,
                token_details_from_usage(usage),
                false,
            )
            .await
        {
            log::warn!("Failed to record image analysis token usage: {}", err);
        }
    }
}

/// Extract provider token details (reasoning / cache read / cache write) into
/// the same `token_details` shape the round executor persists.
fn token_details_from_usage(usage: &crate::util::types::ai::GeminiUsage) -> Option<Value> {
    let mut details = serde_json::Map::new();
    if let Some(reasoning_tokens) = usage.reasoning_token_count {
        details.insert("reasoningTokenCount".to_string(), json!(reasoning_tokens));
    }
    if let Some(cached_tokens) = usage.cached_content_token_count {
        details.insert("cachedContentTokenCount".to_string(), json!(cached_tokens));
    }
    if let Some(creation_tokens) = usage.cache_creation_token_count {
        details.insert(
            "cacheCreationTokenCount".to_string(),
            json!(creation_tokens),
        );
    }
    (!details.is_empty()).then_some(Value::Object(details))
}

#[async_trait]
impl Tool for AnalyzeImageTool {
    fn name(&self) -> &str {
        "analyze_image"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(
            "Analyze an image file with the configured image understanding model and return a text result. Use this when the primary model cannot inspect images directly, or when an image was pasted into the chat and a path is available in the user context."
                .to_string(),
        )
    }

    fn short_description(&self) -> String {
        "Analyze an image file using the configured vision model.".to_string()
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Direct
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the image file. Use an absolute local path, a workspace-relative path, or an exact openbitfun:// URI."
                },
                "prompt": {
                    "type": "string",
                    "description": "Optional question or instruction for the image understanding model."
                }
            },
            "required": ["path"],
            "additionalProperties": false
        })
    }

    fn output_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {"analysis": {"type": "string"}},
            "required": ["analysis"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let input_path = match Self::path_from_input(input) {
            Ok(path) => path,
            Err(err) => {
                return ValidationResult {
                    result: false,
                    message: Some(err.to_string()),
                    error_code: Some(400),
                    meta: None,
                }
            }
        };

        let resolved = match Self::resolve_path(input_path, context) {
            Ok(path) => path,
            Err(err) => {
                return ValidationResult {
                    result: false,
                    message: Some(err.to_string()),
                    error_code: Some(400),
                    meta: None,
                }
            }
        };

        match &resolved {
            ResolvedImagePath::Local(local_path) => match std::fs::metadata(local_path) {
                Ok(metadata) if metadata.is_file() => ValidationResult::default(),
                Ok(_) => ValidationResult {
                    result: false,
                    message: Some(format!(
                        "image path is not a file: {}",
                        resolved.display_path()
                    )),
                    error_code: Some(400),
                    meta: None,
                },
                Err(err) => ValidationResult {
                    result: false,
                    message: Some(format!(
                        "unable to locate image at {}: {}",
                        resolved.display_path(),
                        err
                    )),
                    error_code: Some(404),
                    meta: None,
                },
            },
            ResolvedImagePath::RemoteWorkspace { path, .. } => {
                let Some(fs) = context.and_then(|ctx| ctx.ws_fs()) else {
                    return ValidationResult {
                        result: false,
                        message: Some(
                            "Workspace filesystem services are required to validate remote image paths"
                                .to_string(),
                        ),
                        error_code: Some(400),
                        meta: None,
                    };
                };
                match fs.is_file(path).await {
                    Ok(true) => ValidationResult::default(),
                    Ok(false) => ValidationResult {
                        result: false,
                        message: Some(format!(
                            "image path is not a file: {}",
                            resolved.display_path()
                        )),
                        error_code: Some(400),
                        meta: None,
                    },
                    Err(err) => ValidationResult {
                        result: false,
                        message: Some(format!(
                            "unable to locate image at {}: {}",
                            resolved.display_path(),
                            err
                        )),
                        error_code: Some(404),
                        meta: None,
                    },
                }
            }
        }
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        let path = input.get("path").and_then(Value::as_str).unwrap_or("");
        if path.is_empty() {
            "Analyzing image".to_string()
        } else {
            format!("Analyzing image: {}", path)
        }
    }

    fn render_tool_result_message(&self, output: &Value) -> String {
        output
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("Image analysis completed")
            .to_string()
    }

    fn render_result_for_assistant(&self, output: &Value) -> String {
        output
            .get("analysis")
            .and_then(Value::as_str)
            .unwrap_or("Image analysis completed")
            .to_string()
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let input_path = Self::path_from_input(input)?;
        let prompt = Self::prompt_from_input(input);
        let resolved = Self::resolve_path(input_path, Some(context))?;
        let bytes = Self::read_image_bytes(&resolved, Some(context)).await?;
        let original_mime_type = detect_mime_type_from_bytes(&bytes, None)
            .map_err(|err| OpenBitFunError::tool(format!("unsupported image file: {}", err)))?;

        let vision_model = resolve_vision_model_from_global_config().await?;
        let processed = optimize_image_with_size_limit(
            bytes,
            &vision_model.provider,
            Some(&original_mime_type),
            Some(1024 * 1024),
        )
        .map_err(|err| OpenBitFunError::tool(format!("unable to prepare image: {}", err)))?;

        let messages = build_multimodal_message(
            &prompt,
            &processed.data,
            &processed.mime_type,
            &vision_model.provider,
        )?;
        let client = get_global_ai_client_factory()
            .await
            .map_err(|err| {
                OpenBitFunError::service(format!("AI client factory unavailable: {err}"))
            })?
            .get_client_by_id(&vision_model.id)
            .await
            .map_err(|err| {
                OpenBitFunError::service(format!(
                    "Failed to create image understanding model client: {err}"
                ))
            })?;
        let response = client
            .send_message(messages, None)
            .await
            .map_err(|err| OpenBitFunError::service(format!("Image analysis failed: {err}")))?;
        let analysis = response.text.trim().to_string();
        // `analyze_image` calls the vision model directly through AIClient,
        // bypassing the round executor's token usage event, so persist the
        // usage here to keep the statistics page complete.
        Self::record_token_usage(&vision_model, context, &response).await;
        let summary = analysis
            .lines()
            .find(|line| !line.trim().is_empty())
            .map(str::trim)
            .unwrap_or("Image analysis completed")
            .chars()
            .take(180)
            .collect::<String>();

        // Coordinate contract. Two separate traps live here:
        //
        // 1. `width`/`height` are the dimensions of the image **the model
        //    saw**, which is often not the file's — large screenshots get
        //    downscaled to fit the provider's limits. Reporting only those, as
        //    this did, silently hands back numbers that do not describe the
        //    file the caller passed in.
        // 2. Any position or size in `analysis` is prose from a vision model:
        //    estimated, not measured, and expressed in the resized frame. It is
        //    not a click target, and treating it as one means compounding a
        //    guess with a scale factor and (on Retina) a device-pixel ratio.
        let mut data = json!({
            "path": resolved.display_path(),
            "model_id": vision_model.id,
            "model_name": vision_model.model_name,
            "mime_type": processed.mime_type,
            "width": processed.width,
            "height": processed.height,
            "original_width": processed.original_width,
            "original_height": processed.original_height,
            "was_resized": processed.was_resized(),
            "summary": summary,
            "analysis": analysis,
            "coordinate_note": "Any position or size mentioned in `analysis` is the vision model's estimate, in the frame of the image it was shown (`width`x`height`). It is not a measurement and not a click target. To act on something on screen, use `ComputerUse` `locate` / `move_to_text` / `describe_screen`, which return real coordinates.",
        });
        if processed.was_resized() {
            if let Some(obj) = data.as_object_mut() {
                obj.insert("scale_from_original".to_string(), json!(processed.scale()));
                obj.insert(
                    "resize_note".to_string(),
                    json!(format!(
                        "The image was downscaled {}x{} -> {}x{} (x{:.4}) to fit the vision model. \
Divide by that factor to map anything in `analysis` back to source pixels — but prefer not to: see `coordinate_note`.",
                        processed.original_width,
                        processed.original_height,
                        processed.width,
                        processed.height,
                        processed.scale(),
                    )),
                );
            }
        }

        Ok(vec![ToolResult::ok(
            data,
            Some(format!(
                "Image analysis for {}:\n{}",
                resolved.display_path(),
                analysis
            )),
        )])
    }
}

#[cfg(test)]
mod image_path_tests {
    use super::*;
    use crate::agentic::workspace::WorkspaceBinding;

    #[tokio::test]
    async fn analyze_image_reads_uploaded_runtime_pixels_in_an_ssh_session() {
        let root = tempfile::tempdir().unwrap();
        let identity = crate::service::remote_ssh::workspace_state::workspace_session_identity(
            "/ssh/workspace",
            Some("remote-1"),
            Some("host"),
        )
        .unwrap();
        let mut context = ToolUseContext::for_tool_listing(
            Some(WorkspaceBinding::new_remote(
                Some("remote-workspace".into()),
                PathBuf::from("/ssh/workspace"),
                "remote-1".into(),
                "remote-session".into(),
                identity,
            )),
            None,
        );
        context
            .custom_data
            .insert("__openbitfun_test_runtime_root".into(), json!(root.path()));
        let mut images = vec![crate::agentic::image_analysis::attachments::test_image()];
        let expected =
            crate::agentic::image_analysis::decode_data_url(images[0].data_url.as_deref().unwrap())
                .unwrap()
                .0;
        crate::agentic::image_analysis::attachments::prepare_inline_image_attachments(
            &mut images,
            &context,
        )
        .await
        .unwrap();
        let reference = images[0].image_path.as_deref().unwrap();
        assert!(reference.starts_with("openbitfun://runtime/remote-workspace/"));
        let resolved = AnalyzeImageTool::resolve_path(reference, Some(&context)).unwrap();
        assert!(matches!(resolved, ResolvedImagePath::Local(_)));
        assert_eq!(
            AnalyzeImageTool::read_image_bytes(&resolved, Some(&context))
                .await
                .unwrap(),
            expected
        );
    }

    #[tokio::test]
    async fn analyze_image_never_falls_back_to_an_existing_controller_file() {
        let local = tempfile::tempdir().unwrap();
        let path = local.path().join("private.png");
        std::fs::write(&path, b"private controller content").unwrap();
        let identity = crate::service::remote_ssh::workspace_state::workspace_session_identity(
            local.path().to_str().unwrap(),
            Some("remote-1"),
            Some("host"),
        )
        .unwrap();
        let context = ToolUseContext::for_tool_listing(
            Some(WorkspaceBinding::new_remote(
                Some("remote-workspace".into()),
                local.path().to_path_buf(),
                "remote-1".into(),
                "remote-session".into(),
                identity,
            )),
            None,
        );
        let resolved =
            AnalyzeImageTool::resolve_path(path.to_str().unwrap(), Some(&context)).unwrap();
        assert!(matches!(
            resolved,
            ResolvedImagePath::RemoteWorkspace { .. }
        ));
        let error = AnalyzeImageTool::read_image_bytes(&resolved, Some(&context))
            .await
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("workspace filesystem services are unavailable"));
    }
}
