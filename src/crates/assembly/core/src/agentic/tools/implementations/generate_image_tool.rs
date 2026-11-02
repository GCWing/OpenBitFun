use crate::agentic::image_generation::{
    adapter_target, has_enabled_image_service, resolve_image_service, ResolvedImageService,
};
use crate::agentic::tools::framework::{
    Tool, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::service::config::types::{ImageGenerationParams, ImageServiceConfig};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use openbitfun_ai_adapters::client::image_generation::{
    generate, GeneratedImage, ImageGenerationRequest,
};
use openbitfun_core_types::MAX_IMAGES_PER_GENERATION_REQUEST;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tokio::fs;

/// Workspace-relative directory that receives generated images.
const OUTPUT_DIR_COMPONENTS: [&str; 2] = [".openbitfun", "generated-images"];

pub struct GenerateImageTool;

impl Default for GenerateImageTool {
    fn default() -> Self {
        Self::new()
    }
}

/// One image already written to disk.
struct PersistedImage {
    path: String,
    mime: String,
    bytes: usize,
}

impl GenerateImageTool {
    pub fn new() -> Self {
        Self
    }

    fn prompt_from_input(input: &Value) -> OpenBitFunResult<&str> {
        input
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|prompt| !prompt.is_empty())
            .ok_or_else(|| OpenBitFunError::tool("prompt is required".to_string()))
    }

    fn requested_count(input: &Value) -> OpenBitFunResult<Option<u32>> {
        match input.get("n") {
            None | Some(Value::Null) => Ok(None),
            Some(value) => {
                let Some(count) = value.as_u64() else {
                    return Err(OpenBitFunError::tool(
                        "n must be a positive integer".to_string(),
                    ));
                };
                if count == 0 || count > u64::from(MAX_IMAGES_PER_GENERATION_REQUEST) {
                    return Err(OpenBitFunError::tool(format!(
                        "n must be between 1 and {MAX_IMAGES_PER_GENERATION_REQUEST}"
                    )));
                }
                Ok(Some(count as u32))
            }
        }
    }

    /// Service parameters are defaults; a per-call argument overrides them.
    fn build_request(
        service: &ImageServiceConfig,
        input: &Value,
    ) -> OpenBitFunResult<ImageGenerationRequest> {
        let params: &ImageGenerationParams = &service.params;
        let size = input
            .get("size")
            .and_then(Value::as_str)
            .or(params.size.as_deref())
            .map(str::to_string);
        let negative_prompt = input
            .get("negative_prompt")
            .and_then(Value::as_str)
            .or(params.negative_prompt.as_deref())
            .map(str::to_string);

        Ok(ImageGenerationRequest {
            prompt: Self::prompt_from_input(input)?.to_string(),
            negative_prompt,
            size,
            n: Self::requested_count(input)?.or(params.n),
            quality: params.quality.clone(),
            background: params.background.clone(),
            output_format: params.output_format.clone(),
            watermark: params.watermark,
            prompt_extend: params.prompt_extend,
            seed: params.seed,
        })
    }

    fn extension_for(mime: &str) -> &'static str {
        match mime {
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
            _ => "png",
        }
    }

    fn file_name(mime: &str) -> String {
        format!("{}.{}", uuid::Uuid::new_v4(), Self::extension_for(mime))
    }

    /// Write one image into the workspace so the session keeps a real file and
    /// the chat card can preview it. Remote workspaces write through the
    /// workspace port, which owns its own path syntax.
    async fn persist_one(
        context: &ToolUseContext,
        image: &GeneratedImage,
    ) -> OpenBitFunResult<PersistedImage> {
        let file_name = Self::file_name(&image.mime);

        if context.is_remote() {
            let fs = context.ws_fs().ok_or_else(|| {
                OpenBitFunError::tool(
                    "generate_image cannot write to the remote workspace because workspace filesystem services are unavailable"
                        .to_string(),
                )
            })?;
            let root = context
                .workspace_root()
                .map(|root| root.to_string_lossy().into_owned())
                .ok_or_else(|| {
                    OpenBitFunError::tool(
                        "generate_image requires a workspace to store the generated image"
                            .to_string(),
                    )
                })?;
            let directory = fs.join_path(&root, &OUTPUT_DIR_COMPONENTS);
            fs.create_dir_all(&directory).await.map_err(|err| {
                OpenBitFunError::tool(format!(
                    "unable to create the remote image directory {directory}: {err}"
                ))
            })?;
            let path = fs.join_path(&directory, &[file_name.as_str()]);
            fs.write_file(&path, &image.bytes).await.map_err(|err| {
                OpenBitFunError::tool(format!("unable to write the generated image {path}: {err}"))
            })?;
            return Ok(PersistedImage {
                path,
                mime: image.mime.clone(),
                bytes: image.bytes.len(),
            });
        }

        let directory = match context.workspace_root() {
            Some(root) => Self::local_directory(root),
            None => std::env::temp_dir(),
        };
        fs::create_dir_all(&directory).await.map_err(|err| {
            OpenBitFunError::tool(format!(
                "unable to create the image directory {}: {err}",
                directory.display()
            ))
        })?;
        let path = directory.join(&file_name);
        fs::write(&path, &image.bytes).await.map_err(|err| {
            OpenBitFunError::tool(format!(
                "unable to write the generated image {}: {err}",
                path.display()
            ))
        })?;

        Ok(PersistedImage {
            path: path.to_string_lossy().into_owned(),
            mime: image.mime.clone(),
            bytes: image.bytes.len(),
        })
    }

    fn local_directory(root: &Path) -> PathBuf {
        let mut directory = root.to_path_buf();
        for component in OUTPUT_DIR_COMPONENTS {
            directory = directory.join(component);
        }
        directory
    }

    fn result_summary(resolved: &ResolvedImageService, persisted: &[PersistedImage]) -> String {
        let noun = if persisted.len() == 1 {
            "image"
        } else {
            "images"
        };
        format!(
            "Generated {} {noun} with {} ({})",
            persisted.len(),
            resolved.service.name,
            persisted
                .iter()
                .map(|image| image.path.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    }
}

#[async_trait]
impl Tool for GenerateImageTool {
    fn name(&self) -> &str {
        "generate_image"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(
            "Generate images from a text prompt using the image service selected in Settings > Image Generation. Use this whenever the user asks for a picture, illustration, icon, poster or any other generated image. Returns the saved file paths."
                .to_string(),
        )
    }

    fn short_description(&self) -> String {
        "Generate an image from a text prompt.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "What the image should show. Describe subject, style, composition and lighting."
                },
                "size": {
                    "type": "string",
                    "description": "Optional size override in the configured service's own syntax, such as 1024x1024. Omit to use the service default."
                },
                "n": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_IMAGES_PER_GENERATION_REQUEST,
                    "description": "Number of images to generate. Omit to use the service default."
                },
                "negative_prompt": {
                    "type": "string",
                    "description": "Optional content to avoid. Only honored by services that support it."
                },
                "service_id": {
                    "type": "string",
                    "description": "Optional image service id. Omit to use the default service."
                }
            },
            "required": ["prompt"],
            "additionalProperties": false
        })
    }

    async fn is_available_in_context(&self, _context: Option<&ToolUseContext>) -> bool {
        has_enabled_image_service().await
    }

    fn output_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path of the first generated image on the execution host."},
                "paths": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                "count": {"type": "integer", "minimum": 1},
                "service_id": {"type": "string"},
                "service": {"type": "string"},
                "dialect": {"type": "string"},
                "model": {"type": "string"},
                "mime_type": {"type": "string"},
                "bytes": {"type": "integer", "minimum": 0, "description": "Byte length of the first generated image."},
                "summary": {"type": "string"}
            },
            "required": ["path", "paths", "count", "service_id", "service", "dialect", "model", "mime_type", "bytes", "summary"],
            "additionalProperties": true
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        if let Err(err) = Self::prompt_from_input(input) {
            return ValidationResult {
                result: false,
                message: Some(err.to_string()),
                error_code: Some(400),
                meta: None,
            };
        }
        if let Err(err) = Self::requested_count(input) {
            return ValidationResult {
                result: false,
                message: Some(err.to_string()),
                error_code: Some(400),
                meta: None,
            };
        }
        ValidationResult::default()
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        match Self::prompt_from_input(input) {
            Ok(prompt) => {
                let preview: String = prompt.chars().take(80).collect();
                if preview.len() < prompt.len() {
                    format!("Generating image: {preview}...")
                } else {
                    format!("Generating image: {preview}")
                }
            }
            Err(_) => "Generating image".to_string(),
        }
    }

    fn render_tool_result_message(&self, output: &Value) -> String {
        let count = output
            .get("count")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        match count {
            0 => "No image generated".to_string(),
            1 => "Generated 1 image".to_string(),
            other => format!("Generated {other} images"),
        }
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let service_id = input
            .get("service_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty());
        let resolved = resolve_image_service(service_id).await?;
        let request = Self::build_request(&resolved.service, input)?;

        let target = adapter_target(&resolved);
        let response = generate(&target, request)
            .await
            .map_err(|err| OpenBitFunError::tool(format!("Image generation failed: {err}")))?;

        let mut persisted = Vec::with_capacity(response.images.len());
        for image in &response.images {
            persisted.push(Self::persist_one(context, image).await?);
        }
        if persisted.is_empty() {
            return Err(OpenBitFunError::tool(
                "Image generation returned no images".to_string(),
            ));
        }

        let summary = Self::result_summary(&resolved, &persisted);
        let paths: Vec<&str> = persisted.iter().map(|image| image.path.as_str()).collect();
        let data = json!({
            "path": persisted[0].path,
            "paths": paths,
            "count": persisted.len(),
            "service_id": resolved.service.id,
            "service": resolved.service.name,
            "dialect": format!("{:?}", resolved.service.dialect),
            "model": resolved.service.model_name,
            "mime_type": persisted[0].mime,
            "bytes": persisted[0].bytes,
            "summary": summary,
        });

        Ok(vec![ToolResult::ok(data, Some(summary))])
    }
}

#[cfg(test)]
mod tests {
    use super::GenerateImageTool;
    use crate::agentic::tools::framework::Tool;
    use crate::service::config::types::{ImageDialect, ImageGenerationParams, ImageServiceConfig};
    use serde_json::json;

    fn service(params: ImageGenerationParams) -> ImageServiceConfig {
        ImageServiceConfig {
            id: "svc-a".to_string(),
            name: "Test service".to_string(),
            dialect: ImageDialect::DashScopeNative,
            base_url: "https://dashscope.aliyuncs.com/api/v1".to_string(),
            model_name: "qwen-image-2.0".to_string(),
            api_key: "sk-test".to_string(),
            enabled: true,
            params,
            ..ImageServiceConfig::default()
        }
    }

    #[test]
    fn service_parameters_are_the_defaults() {
        let service = service(ImageGenerationParams {
            size: Some("2048*2048".to_string()),
            n: Some(2),
            negative_prompt: Some("blur".to_string()),
            watermark: Some(false),
            ..ImageGenerationParams::default()
        });

        let request =
            GenerateImageTool::build_request(&service, &json!({ "prompt": "a fox" })).unwrap();

        assert_eq!(request.prompt, "a fox");
        assert_eq!(request.size.as_deref(), Some("2048*2048"));
        assert_eq!(request.n, Some(2));
        assert_eq!(request.negative_prompt.as_deref(), Some("blur"));
        assert_eq!(request.watermark, Some(false));
    }

    #[test]
    fn call_arguments_override_service_parameters() {
        let service = service(ImageGenerationParams {
            size: Some("2048*2048".to_string()),
            n: Some(2),
            negative_prompt: Some("blur".to_string()),
            ..ImageGenerationParams::default()
        });

        let request = GenerateImageTool::build_request(
            &service,
            &json!({ "prompt": "a fox", "size": "1024*1024", "n": 1, "negative_prompt": "noise" }),
        )
        .unwrap();

        assert_eq!(request.size.as_deref(), Some("1024*1024"));
        assert_eq!(request.n, Some(1));
        assert_eq!(request.negative_prompt.as_deref(), Some("noise"));
    }

    #[test]
    fn a_missing_prompt_is_rejected() {
        let error = GenerateImageTool::build_request(
            &service(ImageGenerationParams::default()),
            &json!({}),
        )
        .unwrap_err();

        assert!(error.to_string().contains("prompt is required"));
    }

    #[test]
    fn a_blank_prompt_is_rejected() {
        let error = GenerateImageTool::build_request(
            &service(ImageGenerationParams::default()),
            &json!({ "prompt": "   " }),
        )
        .unwrap_err();

        assert!(error.to_string().contains("prompt is required"));
    }

    #[test]
    fn an_out_of_range_count_is_rejected() {
        for value in [json!(0), json!(11)] {
            let error = GenerateImageTool::build_request(
                &service(ImageGenerationParams::default()),
                &json!({ "prompt": "a fox", "n": value }),
            )
            .unwrap_err();
            assert!(error.to_string().contains("n must be between"));
        }
    }

    #[tokio::test]
    async fn validate_input_reports_a_missing_prompt() {
        let validation = GenerateImageTool::new()
            .validate_input(&json!({}), None)
            .await;

        assert!(!validation.result);
        assert_eq!(validation.error_code, Some(400));
    }

    #[test]
    fn file_extension_follows_the_mime_type() {
        assert_eq!(GenerateImageTool::extension_for("image/png"), "png");
        assert_eq!(GenerateImageTool::extension_for("image/jpeg"), "jpg");
        assert_eq!(GenerateImageTool::extension_for("image/webp"), "webp");
        assert_eq!(
            GenerateImageTool::extension_for("application/octet-stream"),
            "png"
        );
    }

    #[test]
    fn generated_files_live_under_the_workspace_openbitfun_directory() {
        let directory = GenerateImageTool::local_directory(std::path::Path::new("/repo"));

        assert_eq!(
            directory,
            std::path::Path::new("/repo")
                .join(".openbitfun")
                .join("generated-images")
        );
    }
}
