use crate::agentic::image_analysis::{optimize_image_for_provider, ImageLimits};
use crate::agentic::tools::framework::{
    Tool, ToolExposure, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use crate::util::types::ToolImageAttachment;
use async_trait::async_trait;
use base64::Engine as _;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tokio::fs;

pub struct ViewImageTool;

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

impl Default for ViewImageTool {
    fn default() -> Self {
        Self::new()
    }
}

impl ViewImageTool {
    pub fn new() -> Self {
        Self
    }

    fn primary_api_format(ctx: &ToolUseContext) -> String {
        ctx.primary_model_facts().api_format.to_lowercase()
    }

    fn require_multimodal_tool_output(ctx: &ToolUseContext) -> OpenBitFunResult<()> {
        if !ctx.primary_model_supports_image_understanding() {
            return Err(OpenBitFunError::tool(
                "view_image is not allowed because the primary model does not accept image inputs"
                    .to_string(),
            ));
        }

        if ctx.primary_model_facts().multimodal_tool_output_supported() {
            return Ok(());
        }

        Err(OpenBitFunError::tool(
            "view_image returns images in tool results; set the primary model to an image-capable model using Anthropic, OpenAI Chat/Responses, or Gemini API format."
                .to_string(),
        ))
    }

    fn supports_multimodal_tool_output(ctx: &ToolUseContext) -> bool {
        ctx.primary_model_supports_image_understanding()
            && ctx.primary_model_facts().multimodal_tool_output_supported()
    }

    fn mime_type_for_image(bytes: &[u8]) -> OpenBitFunResult<&'static str> {
        let format = image::guess_format(bytes).map_err(|_| {
            OpenBitFunError::tool(
                "view_image can only attach supported image files: png, jpeg, gif, webp, or bmp"
                    .to_string(),
            )
        })?;

        match format {
            image::ImageFormat::Png => Ok("image/png"),
            image::ImageFormat::Jpeg => Ok("image/jpeg"),
            image::ImageFormat::Gif => Ok("image/gif"),
            image::ImageFormat::WebP => Ok("image/webp"),
            image::ImageFormat::Bmp => Ok("image/bmp"),
            other => Err(OpenBitFunError::tool(format!(
                "view_image does not support image format {:?}; supported formats are png, jpeg, gif, webp, and bmp",
                other
            ))),
        }
    }

    fn path_from_input(input: &Value) -> OpenBitFunResult<&str> {
        input
            .get("path")
            .and_then(Value::as_str)
            .filter(|path| !path.trim().is_empty())
            .ok_or_else(|| OpenBitFunError::tool("path is required".to_string()))
    }

    fn validate_detail(input: &Value) -> OpenBitFunResult<()> {
        match input.get("detail") {
            None | Some(Value::Null) => Ok(()),
            Some(Value::String(value)) if value == "original" => Ok(()),
            Some(Value::String(value)) => Err(OpenBitFunError::tool(format!(
                "view_image.detail only supports `original`; omit `detail` for default behavior, got `{}`",
                value
            ))),
            Some(_) => Err(OpenBitFunError::tool(
                "view_image.detail must be the string `original` when provided".to_string(),
            )),
        }
    }

    fn resolve_path(
        input_path: &str,
        context: Option<&ToolUseContext>,
    ) -> OpenBitFunResult<ResolvedImagePath> {
        let local_path = Path::new(input_path);
        if !context.is_some_and(|ctx| ctx.is_remote())
            && local_path.is_absolute()
            && !crate::agentic::tools::workspace_paths::is_openbitfun_tool_uri(input_path)
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
                        "view_image cannot read remote workspace images because workspace filesystem services are unavailable"
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
}

#[async_trait]
impl Tool for ViewImageTool {
    fn name(&self) -> &str {
        "view_image"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(
            "View an image from the filesystem. Use only when given an image path and the image is not already attached to the conversation."
                .to_string(),
        )
    }

    fn short_description(&self) -> String {
        "Attach an image file for model vision.".to_string()
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
                    "description": "Path to an image file. Use an absolute local path, a workspace-relative path, or an exact openbitfun:// URI returned by another tool."
                },
                "detail": {
                    "type": "string",
                    "enum": ["original"],
                    "description": "Optional detail override. Supported value: original. OpenBitFun preserves image detail when possible and may optimize bytes to fit the active provider limits."
                }
            },
            "required": ["path"],
            "additionalProperties": false
        })
    }

    fn output_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "width": {"type": "integer"},
                "height": {"type": "integer"},
                "summary": {"type": "string"}
            },
            "required": ["path", "width", "height", "summary"],
            "additionalProperties": true
        })
    }

    async fn is_available_in_context(&self, context: Option<&ToolUseContext>) -> bool {
        context
            .map(Self::supports_multimodal_tool_output)
            .unwrap_or(true)
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
        if let Err(err) = Self::validate_detail(input) {
            return ValidationResult {
                result: false,
                message: Some(err.to_string()),
                error_code: Some(400),
                meta: None,
            };
        }

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

        let path = match Self::resolve_path(input_path, context) {
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

        match &path {
            ResolvedImagePath::Local(local_path) => match std::fs::metadata(local_path) {
                Ok(metadata) if metadata.is_file() => ValidationResult::default(),
                Ok(_) => ValidationResult {
                    result: false,
                    message: Some(format!("image path is not a file: {}", path.display_path())),
                    error_code: Some(400),
                    meta: None,
                },
                Err(err) => ValidationResult {
                    result: false,
                    message: Some(format!(
                        "unable to locate image at {}: {}",
                        path.display_path(),
                        err
                    )),
                    error_code: Some(404),
                    meta: None,
                },
            },
            ResolvedImagePath::RemoteWorkspace {
                path: remote_path, ..
            } => {
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
                match fs.is_file(remote_path).await {
                    Ok(true) => ValidationResult::default(),
                    Ok(false) => ValidationResult {
                        result: false,
                        message: Some(format!("image path is not a file: {}", path.display_path())),
                        error_code: Some(400),
                        meta: None,
                    },
                    Err(err) => ValidationResult {
                        result: false,
                        message: Some(format!(
                            "unable to locate image at {}: {}",
                            path.display_path(),
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
            "Viewing image".to_string()
        } else {
            format!("Viewing image: {}", path)
        }
    }

    fn render_tool_result_message(&self, output: &Value) -> String {
        output
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("Image attached")
            .to_string()
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        Self::require_multimodal_tool_output(context)?;
        Self::validate_detail(input)?;

        let input_path = Self::path_from_input(input)?;
        let path = Self::resolve_path(input_path, Some(context))?;
        let bytes = Self::read_image_bytes(&path, Some(context)).await?;
        let original_mime_type = Self::mime_type_for_image(&bytes)?;
        let provider = Self::primary_api_format(context);
        let processed = optimize_image_for_provider(bytes, &provider, Some(original_mime_type))
            .map_err(|err| {
                OpenBitFunError::tool(format!("unable to prepare image for model vision: {}", err))
            })?;
        let limits = ImageLimits::for_provider(&provider);
        if processed.data.len() > limits.max_size {
            return Err(OpenBitFunError::tool(format!(
                "image is too large for {} after optimization: {} bytes > {} bytes",
                provider,
                processed.data.len(),
                limits.max_size
            )));
        }
        let mime_type = processed.mime_type.clone();
        let data_base64 = base64::engine::general_purpose::STANDARD.encode(&processed.data);
        let summary = format!("Attached image: {}", path.display_path());
        // `width`/`height` describe the attached image, which is downscaled
        // when the source exceeds the provider's limits — so on its own it
        // reads as the file's size and is not. The source dimensions ride
        // alongside so a caller reasoning about the picture knows which frame
        // it is looking at.
        let data = json!({
            "path": path.display_path(),
            "mime_type": mime_type.clone(),
            "width": processed.width,
            "height": processed.height,
            "original_width": processed.original_width,
            "original_height": processed.original_height,
            "was_resized": processed.was_resized(),
            "size": processed.data.len(),
            "summary": summary,
        });

        Ok(vec![ToolResult::ok_with_images(
            data,
            Some("Image attached for model vision.".to_string()),
            vec![ToolImageAttachment {
                mime_type,
                data_base64,
            }],
        )])
    }
}

#[cfg(test)]
mod tests {
    use super::ViewImageTool;
    use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext};
    use crate::agentic::tools::ToolRuntimeRestrictions;
    use crate::agentic::workspace::{
        WorkspaceCommandOptions, WorkspaceCommandResult, WorkspaceDirEntry, WorkspaceFileSystem,
        WorkspaceServices, WorkspaceShell,
    };
    use crate::agentic::WorkspaceBinding;
    use crate::service::remote_ssh::workspace_state::workspace_session_identity;
    use async_trait::async_trait;
    use image::{ImageBuffer, ImageFormat, Rgb};
    use serde_json::json;
    use std::collections::HashMap;
    use std::fs;
    use std::io::Cursor;
    use std::path::PathBuf;
    use std::sync::Arc;
    use tool_runtime::context::PrimaryModelFacts;

    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let image = ImageBuffer::from_pixel(width, height, Rgb([80u8, 120u8, 160u8]));
        let mut encoded = Cursor::new(Vec::new());
        image
            .write_to(&mut encoded, ImageFormat::Png)
            .expect("encode png");
        encoded.into_inner()
    }

    struct FakeRemoteFs;

    #[async_trait]
    impl WorkspaceFileSystem for FakeRemoteFs {
        async fn read_file(&self, path: &str) -> anyhow::Result<Vec<u8>> {
            if path == "/remote/workspace/screenshots/pixel.png" {
                return Ok(png_bytes(1, 1));
            }
            anyhow::bail!("not found: {}", path)
        }

        async fn read_file_text(&self, path: &str) -> anyhow::Result<String> {
            anyhow::bail!("not text: {}", path)
        }

        async fn write_file(&self, _path: &str, _contents: &[u8]) -> anyhow::Result<()> {
            Ok(())
        }

        async fn exists(&self, path: &str) -> anyhow::Result<bool> {
            Ok(path == "/remote/workspace/screenshots/pixel.png")
        }

        async fn is_file(&self, path: &str) -> anyhow::Result<bool> {
            Ok(path == "/remote/workspace/screenshots/pixel.png")
        }

        async fn is_dir(&self, _path: &str) -> anyhow::Result<bool> {
            Ok(false)
        }

        async fn read_dir(&self, _path: &str) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
            Ok(Vec::new())
        }
    }

    struct FakeShell;

    #[async_trait]
    impl WorkspaceShell for FakeShell {
        async fn exec_with_options(
            &self,
            _command: &str,
            _options: WorkspaceCommandOptions,
        ) -> anyhow::Result<WorkspaceCommandResult> {
            Ok(WorkspaceCommandResult {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: 0,
                interrupted: false,
                timed_out: false,
            })
        }
    }

    fn context(provider: &str, supports_images: bool) -> ToolUseContext {
        let primary_model_facts =
            PrimaryModelFacts::new("primary-model", "vision-model", provider, supports_images);
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace: None,
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts,
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    fn local_workspace_context(
        provider: &str,
        supports_images: bool,
        root: PathBuf,
    ) -> ToolUseContext {
        let mut context = context(provider, supports_images);
        context.workspace = Some(WorkspaceBinding::new(
            Some("workspace-local".to_string()),
            root,
        ));
        context
    }

    fn remote_context(provider: &str, supports_images: bool) -> ToolUseContext {
        let mut context = context(provider, supports_images);
        let root = "/remote/workspace";
        let session_identity = workspace_session_identity(root, Some("conn-1"), Some("host"))
            .expect("remote identity");
        context.workspace = Some(WorkspaceBinding::new_remote(
            Some("workspace-remote".to_string()),
            PathBuf::from(root),
            "conn-1".to_string(),
            "remote-session".to_string(),
            session_identity,
        ));
        context.runtime_handles = openbitfun_runtime_ports::ToolRuntimeHandles::new(
            Some(WorkspaceServices {
                fs: Arc::new(FakeRemoteFs),
                shell: Arc::new(FakeShell),
            }),
            None,
        );
        context
    }

    #[tokio::test]
    async fn view_image_attaches_local_image() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("pixel.png");
        fs::write(&path, png_bytes(1, 1)).expect("write png");

        let results = ViewImageTool::new()
            .call_impl(
                &json!({ "path": path }),
                &local_workspace_context("openai", true, dir.path().to_path_buf()),
            )
            .await
            .expect("view image result");

        let ToolResult::Result {
            data,
            image_attachments,
            ..
        } = &results[0]
        else {
            panic!("expected result");
        };
        assert_eq!(data["mime_type"], "image/png");
        let attachments = image_attachments.as_ref().expect("image attachments");
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].mime_type, "image/png");
        assert!(!attachments[0].data_base64.is_empty());
    }

    #[tokio::test]
    async fn view_image_reads_local_absolute_path_without_workspace() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("pixel.png");
        fs::write(&path, png_bytes(1, 1)).expect("write png");

        let results = ViewImageTool::new()
            .call_impl(&json!({ "path": path }), &context("openai", true))
            .await
            .expect("view image result");

        let ToolResult::Result {
            data,
            image_attachments,
            ..
        } = &results[0]
        else {
            panic!("expected result");
        };
        assert_eq!(data["mime_type"], "image/png");
        assert_eq!(
            image_attachments.as_ref().expect("image attachments").len(),
            1
        );
    }

    #[tokio::test]
    async fn view_image_rejects_text_only_model() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("pixel.png");
        fs::write(&path, png_bytes(1, 1)).expect("write png");

        let error = ViewImageTool::new()
            .call_impl(
                &json!({ "path": path }),
                &local_workspace_context("openai", false, dir.path().to_path_buf()),
            )
            .await
            .expect_err("text-only model should be rejected");

        assert!(error.to_string().contains("does not accept image inputs"));
    }

    #[tokio::test]
    async fn view_image_rejects_non_image_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("note.txt");
        fs::write(&path, "not an image").expect("write text");

        let error = ViewImageTool::new()
            .call_impl(
                &json!({ "path": path }),
                &local_workspace_context("openai", true, dir.path().to_path_buf()),
            )
            .await
            .expect_err("non-image should be rejected");

        assert!(error.to_string().contains("supported image files"));
    }

    #[tokio::test]
    async fn view_image_optimizes_image_for_provider_limits() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("large.png");
        fs::write(&path, png_bytes(2400, 2400)).expect("write png");

        let results = ViewImageTool::new()
            .call_impl(
                &json!({ "path": path }),
                &local_workspace_context("anthropic", true, dir.path().to_path_buf()),
            )
            .await
            .expect("view image result");

        let ToolResult::Result {
            data,
            image_attachments,
            ..
        } = &results[0]
        else {
            panic!("expected result");
        };
        assert!(data["width"].as_u64().expect("width") <= 1568);
        assert!(data["height"].as_u64().expect("height") <= 2390);
        assert!(data["size"].as_u64().expect("size") <= 5 * 1024 * 1024);
        let attachments = image_attachments.as_ref().expect("image attachments");
        assert_eq!(
            attachments[0].mime_type,
            data["mime_type"].as_str().expect("mime type")
        );
    }

    #[tokio::test]
    async fn view_image_is_available_only_for_supported_multimodal_tool_output() {
        assert!(
            ViewImageTool::new()
                .is_available_in_context(Some(&remote_context("openai", true)))
                .await
        );
        assert!(
            !ViewImageTool::new()
                .is_available_in_context(Some(&remote_context("openai", false)))
                .await
        );
        assert!(
            ViewImageTool::new()
                .is_available_in_context(Some(&remote_context("gemini", true)))
                .await
        );
    }

    #[test]
    fn gemini_image_admission_agrees_with_tool_availability() {
        assert!(
            ViewImageTool::require_multimodal_tool_output(&remote_context("gemini", true)).is_ok()
        );
        assert!(
            ViewImageTool::require_multimodal_tool_output(&remote_context("gemini", false))
                .is_err()
        );
        assert!(
            ViewImageTool::require_multimodal_tool_output(&remote_context("unknown", true))
                .is_err()
        );
    }

    #[tokio::test]
    async fn view_image_reads_remote_workspace_relative_image() {
        let results = ViewImageTool::new()
            .call_impl(
                &json!({ "path": "screenshots/pixel.png" }),
                &remote_context("openai", true),
            )
            .await
            .expect("remote image result");

        let ToolResult::Result {
            data,
            image_attachments,
            ..
        } = &results[0]
        else {
            panic!("expected result");
        };
        assert_eq!(data["path"], "/remote/workspace/screenshots/pixel.png");
        assert_eq!(data["mime_type"], "image/png");
        let attachments = image_attachments.as_ref().expect("image attachments");
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].mime_type, "image/png");
    }

    #[tokio::test]
    async fn view_image_reads_remote_workspace_absolute_image() {
        let results = ViewImageTool::new()
            .call_impl(
                &json!({ "path": "/remote/workspace/screenshots/pixel.png" }),
                &remote_context("openai", true),
            )
            .await
            .expect("remote image result");

        let ToolResult::Result { data, .. } = &results[0] else {
            panic!("expected result");
        };
        assert_eq!(data["path"], "/remote/workspace/screenshots/pixel.png");
        assert_eq!(data["mime_type"], "image/png");
    }

    #[tokio::test]
    async fn view_image_allows_local_absolute_path_outside_workspace() {
        let workspace = tempfile::tempdir().expect("workspace tempdir");
        let outside = tempfile::tempdir().expect("outside tempdir");
        let path = outside.path().join("pixel.png");
        fs::write(&path, png_bytes(1, 1)).expect("write png");

        let results = ViewImageTool::new()
            .call_impl(
                &json!({ "path": path }),
                &local_workspace_context("openai", true, workspace.path().to_path_buf()),
            )
            .await
            .expect("workspace-external absolute image path should be allowed");

        let ToolResult::Result { data, .. } = &results[0] else {
            panic!("expected result");
        };
        assert_eq!(data["mime_type"], "image/png");
    }
}
