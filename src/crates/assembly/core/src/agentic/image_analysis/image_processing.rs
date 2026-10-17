//! Shared image processing utilities used by both API-side image analysis and tool-driven image analysis.

use super::types::{ImageContextData, ImageLimits};
use crate::agentic::tools::framework::ToolUseContext;
use crate::service::config::get_global_config_service;
use crate::service::config::types::{AIConfig as ServiceAIConfig, AIModelConfig};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use crate::util::types::Message;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::imageops::FilterType;
use image::ColorType;
use image::DynamicImage;
use image::ImageEncoder;
use image::ImageFormat;
use serde_json::json;
use std::path::{Path, PathBuf};
use tokio::fs;

#[derive(Debug, Clone)]
pub struct ProcessedImage {
    pub data: Vec<u8>,
    pub mime_type: String,
    /// Width of the image **as sent to the model** — not of the source file.
    /// Downscaling to fit the provider's limits can shrink this a long way
    /// (repeated 0.75× passes, floor 64px).
    pub width: u32,
    /// Height as sent to the model. See [`Self::width`].
    pub height: u32,
    /// Width of the source image, before any resizing.
    ///
    /// Reported separately because callers surface these numbers to a model,
    /// and a resized dimension presented as the file's dimension is silently
    /// wrong: anything the vision model says about position or size is in the
    /// resized frame, and the caller has no way to map it back without knowing
    /// the original.
    pub original_width: u32,
    /// Height of the source image, before any resizing.
    pub original_height: u32,
}

impl ProcessedImage {
    /// Linear factor from source pixels to sent pixels (1.0 when untouched).
    ///
    /// Aspect ratio is preserved by every resize path here, so one factor
    /// describes both axes; it is derived from width to avoid disagreeing with
    /// itself on rounding.
    pub fn scale(&self) -> f64 {
        if self.original_width == 0 {
            return 1.0;
        }
        f64::from(self.width) / f64::from(self.original_width)
    }

    /// Whether the image was downscaled on the way to the model.
    pub fn was_resized(&self) -> bool {
        self.width != self.original_width || self.height != self.original_height
    }
}

pub fn resolve_vision_model_from_ai_config(
    ai_config: &ServiceAIConfig,
) -> OpenBitFunResult<AIModelConfig> {
    let target_model_id = ai_config
        .default_models
        .image_understanding
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());

    let Some(id) = target_model_id else {
        return Err(OpenBitFunError::service(
            "Image understanding model is not configured.\nPlease select a model in Settings."
                .to_string(),
        ));
    };

    let model = ai_config
        .models
        .iter()
        .find(|m| m.id == id)
        .cloned()
        .ok_or_else(|| OpenBitFunError::service(format!("Model not found: {}", id)))?;

    if !model.enabled {
        return Err(OpenBitFunError::service(format!(
            "Model is disabled: {}",
            id
        )));
    }

    if !model.supports_image_understanding() {
        return Err(OpenBitFunError::service(format!(
            "Model does not support image understanding: {}",
            id
        )));
    }

    Ok(model)
}

pub async fn resolve_vision_model_from_global_config() -> OpenBitFunResult<AIModelConfig> {
    let config_service = get_global_config_service().await?;
    let ai_config: ServiceAIConfig = config_service
        .get_config(Some("ai"))
        .await
        .map_err(|e| OpenBitFunError::service(format!("Failed to get AI config: {}", e)))?;

    resolve_vision_model_from_ai_config(&ai_config)
}

/// Per-request image requirements, never persisted as session policy.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum ImageInputRequirement {
    #[default]
    None,
    Native,
    NativeOrAnalysisTool,
}

impl ImageInputRequirement {
    pub(crate) fn validate(self, config: &ServiceAIConfig, model_id: &str) -> OpenBitFunResult<()> {
        if self == Self::None {
            return Ok(());
        }
        validate_image_input_model(config, model_id, self == Self::NativeOrAnalysisTool)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ImageInputRoute {
    Native,
    AnalysisTool,
}

pub(crate) fn validate_image_input_model(
    ai_config: &ServiceAIConfig,
    primary_model_id: &str,
    analysis_tool_available: bool,
) -> OpenBitFunResult<()> {
    resolve_image_input_route(ai_config, primary_model_id, analysis_tool_available).map(|_| ())
}

pub(crate) fn resolve_image_input_route(
    ai_config: &ServiceAIConfig,
    primary_model_id: &str,
    analysis_tool_available: bool,
) -> OpenBitFunResult<ImageInputRoute> {
    let model = ai_config
        .models
        .iter()
        .find(|model| model.id == primary_model_id)
        .ok_or_else(|| {
            OpenBitFunError::validation(format!("Model not found: {primary_model_id}"))
        })?;
    if model.supports_image_understanding() {
        return Ok(ImageInputRoute::Native);
    }
    if !analysis_tool_available {
        return Err(OpenBitFunError::validation(
            "This model cannot read images because analyze_image is unavailable for this request. Select a multimodal model or enable analyze_image and configure an image understanding model.",
        ));
    }
    if !model.capabilities.is_empty()
        && !model
            .capabilities
            .contains(&crate::service::config::types::ModelCapability::FunctionCalling)
    {
        return Err(OpenBitFunError::validation(
            "This model cannot call analyze_image. Select a model with image or tool-call support.",
        ));
    }
    resolve_vision_model_from_ai_config(ai_config).map(|_| ImageInputRoute::AnalysisTool)
}

#[cfg(test)]
mod input_model_tests {
    use super::*;
    use crate::service::config::types::{ModelCapability, ModelCategory};

    #[test]
    fn native_images_do_not_require_a_fallback_model_but_text_models_do() {
        let native = AIModelConfig {
            id: "native".into(),
            category: ModelCategory::Multimodal,
            capabilities: vec![ModelCapability::ImageUnderstanding],
            enabled: true,
            ..Default::default()
        };
        let text = AIModelConfig {
            id: "text".into(),
            category: ModelCategory::GeneralChat,
            capabilities: vec![ModelCapability::TextChat, ModelCapability::FunctionCalling],
            enabled: true,
            ..Default::default()
        };
        let mut config = ServiceAIConfig::default();
        config.models = vec![native, text];
        assert!(validate_image_input_model(&config, "native", false).is_ok());
        assert!(validate_image_input_model(&config, "text", true)
            .unwrap_err()
            .to_string()
            .contains("not configured"));
        config.default_models.image_understanding = Some("native".into());
        assert!(validate_image_input_model(&config, "text", true).is_ok());
        assert!(validate_image_input_model(&config, "text", false).is_err());
        assert_eq!(
            resolve_image_input_route(&config, "native", false).unwrap(),
            ImageInputRoute::Native
        );
        assert_eq!(
            resolve_image_input_route(&config, "text", true).unwrap(),
            ImageInputRoute::AnalysisTool
        );
        config.models[1].capabilities = vec![ModelCapability::TextChat];
        assert!(validate_image_input_model(&config, "text", true)
            .unwrap_err()
            .to_string()
            .contains("cannot call analyze_image"));
        config.models[1]
            .capabilities
            .push(ModelCapability::FunctionCalling);
        config.default_models.image_understanding = Some("missing".into());
        assert!(validate_image_input_model(&config, "text", true)
            .unwrap_err()
            .to_string()
            .contains("Model not found"));
        config.default_models.image_understanding = Some("native".into());
        config.models[0].enabled = false;
        assert!(validate_image_input_model(&config, "text", true)
            .unwrap_err()
            .to_string()
            .contains("disabled"));
        config.default_models.image_understanding = Some("text".into());
        assert!(validate_image_input_model(&config, "text", true)
            .unwrap_err()
            .to_string()
            .contains("does not support"));
    }
}

pub fn resolve_image_path(path: &str, workspace_path: Option<&Path>) -> OpenBitFunResult<PathBuf> {
    let path_buf = PathBuf::from(path);

    if path_buf.is_absolute() {
        Ok(path_buf)
    } else if let Some(workspace) = workspace_path {
        Ok(workspace.join(path_buf))
    } else {
        Ok(path_buf)
    }
}

pub async fn load_image_from_path(
    path: &Path,
    _workspace_path: Option<&Path>,
) -> OpenBitFunResult<Vec<u8>> {
    fs::read(path)
        .await
        .map_err(|e| OpenBitFunError::io(format!("Failed to read image: {}", e)))
}

pub fn decode_data_url(data_url: &str) -> OpenBitFunResult<(Vec<u8>, Option<String>)> {
    if !data_url.starts_with("data:") {
        return Err(OpenBitFunError::validation("Invalid data URL format"));
    }

    let parts: Vec<&str> = data_url.splitn(2, ',').collect();
    if parts.len() != 2 {
        return Err(OpenBitFunError::validation("Data URL format error"));
    }

    let header = parts[0];
    if !header.split(';').any(|part| part == "base64") {
        return Err(OpenBitFunError::validation(
            "Only base64 image data URLs are supported",
        ));
    }
    let mime_type = header
        .strip_prefix("data:")
        .and_then(|s| s.split(';').next())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);

    let base64_data = parts[1];
    let image_data = BASE64
        .decode(base64_data)
        .map_err(|e| OpenBitFunError::parse(format!("Base64 decode failed: {}", e)))?;

    Ok((image_data, mime_type))
}

pub fn detect_mime_type_from_bytes(
    image_data: &[u8],
    fallback_mime: Option<&str>,
) -> OpenBitFunResult<String> {
    if let Ok(format) = image::guess_format(image_data) {
        if let Some(mime) = image_format_to_mime(format) {
            return Ok(mime.to_string());
        }
    }

    if let Some(fallback) = fallback_mime {
        if fallback.starts_with("image/") {
            return Ok(fallback.to_string());
        }
    }

    Err(OpenBitFunError::validation(
        "Unsupported or unrecognized image format",
    ))
}

pub fn optimize_image_for_provider(
    image_data: Vec<u8>,
    provider: &str,
    fallback_mime: Option<&str>,
) -> OpenBitFunResult<ProcessedImage> {
    optimize_image_with_size_limit(image_data, provider, fallback_mime, None)
}

/// Like `optimize_image_for_provider` but allows an explicit size cap.
/// When `max_output_size` is `Some(n)`, the effective limit is
/// `min(provider_limit, n)`.
pub fn optimize_image_with_size_limit(
    image_data: Vec<u8>,
    provider: &str,
    fallback_mime: Option<&str>,
    max_output_size: Option<usize>,
) -> OpenBitFunResult<ProcessedImage> {
    let limits = ImageLimits::for_provider(provider);
    let effective_max = match max_output_size {
        Some(cap) => cap.min(limits.max_size),
        None => limits.max_size,
    };

    let guessed_format = image::guess_format(&image_data).ok();
    let dynamic = image::load_from_memory(&image_data)
        .map_err(|e| OpenBitFunError::validation(format!("Failed to decode image data: {}", e)))?;

    let (orig_width, orig_height) = (dynamic.width(), dynamic.height());
    let needs_resize = orig_width > limits.max_width || orig_height > limits.max_height;

    let provider_accepts_format = matches!(
        guessed_format,
        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP)
    );
    if !needs_resize && image_data.len() <= effective_max && provider_accepts_format {
        let mime_type = detect_mime_type_from_bytes(&image_data, fallback_mime)?;
        return Ok(ProcessedImage {
            data: image_data,
            mime_type,
            width: orig_width,
            height: orig_height,
            original_width: orig_width,
            original_height: orig_height,
        });
    }

    let mut working = if needs_resize {
        dynamic.resize(limits.max_width, limits.max_height, FilterType::Triangle)
    } else {
        dynamic
    };

    let preferred_format = match guessed_format {
        Some(ImageFormat::Jpeg) => ImageFormat::Jpeg,
        _ => ImageFormat::Png,
    };

    let mut encoded = encode_dynamic_image(&working, preferred_format, 85)?;

    if encoded.0.len() > effective_max {
        for quality in [80u8, 65, 50, 35] {
            encoded = encode_dynamic_image(&working, ImageFormat::Jpeg, quality)?;
            if encoded.0.len() <= effective_max {
                break;
            }
        }
    }

    if encoded.0.len() > effective_max {
        for _ in 0..5 {
            let next_w = ((working.width() as f32) * 0.75).round().max(64.0) as u32;
            let next_h = ((working.height() as f32) * 0.75).round().max(64.0) as u32;
            if next_w == working.width() && next_h == working.height() {
                break;
            }

            working = working.resize(next_w, next_h, FilterType::Triangle);

            for quality in [70u8, 55, 40, 25] {
                encoded = encode_dynamic_image(&working, ImageFormat::Jpeg, quality)?;
                if encoded.0.len() <= effective_max {
                    break;
                }
            }

            if encoded.0.len() <= effective_max {
                break;
            }
        }
    }

    if encoded.0.len() > effective_max {
        return Err(OpenBitFunError::validation(
            "Image cannot fit the provider upload limit",
        ));
    }
    Ok(ProcessedImage {
        data: encoded.0,
        mime_type: encoded.1,
        width: working.width(),
        height: working.height(),
        original_width: orig_width,
        original_height: orig_height,
    })
}

pub fn build_multimodal_message(
    prompt: &str,
    image_data: &[u8],
    mime_type: &str,
    provider: &str,
) -> OpenBitFunResult<Vec<Message>> {
    let base64_data = BASE64.encode(image_data);
    let provider_lower = provider.to_lowercase();

    let message = if provider_lower.contains("anthropic") {
        Message {
            role: "user".to_string(),
            content: Some(serde_json::to_string(&json!([
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": mime_type,
                        "data": base64_data
                    }
                },
                {
                    "type": "text",
                    "text": prompt
                }
            ]))?),
            reasoning_content: None,
            thinking_signature: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
            is_error: None,
            tool_image_attachments: None,
            model_response_replay: None,
        }
    } else if provider_lower.contains("gemini") || provider_lower.contains("google") {
        Message {
            role: "user".to_string(),
            content: Some(serde_json::to_string(&json!([
                {
                    "inline_data": {
                        "mime_type": mime_type,
                        "data": base64_data
                    }
                },
                {
                    "text": prompt
                }
            ]))?),
            reasoning_content: None,
            thinking_signature: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
            is_error: None,
            tool_image_attachments: None,
            model_response_replay: None,
        }
    } else {
        // Default to OpenAI-compatible payload shape for OpenAI and most OpenAI-compatible providers.
        Message {
            role: "user".to_string(),
            content: Some(serde_json::to_string(&json!([
                {
                    "type": "image_url",
                    "image_url": {
                        "url": format!("data:{};base64,{}", mime_type, base64_data)
                    }
                },
                {
                    "type": "text",
                    "text": prompt
                }
            ]))?),
            reasoning_content: None,
            thinking_signature: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
            is_error: None,
            tool_image_attachments: None,
            model_response_replay: None,
        }
    };

    Ok(vec![message])
}

pub async fn process_image_contexts_for_provider(
    image_contexts: &[ImageContextData],
    provider: &str,
    workspace_path: Option<&Path>,
) -> OpenBitFunResult<Vec<ProcessedImage>> {
    process_image_contexts(image_contexts, provider, workspace_path, None).await
}

pub(crate) async fn process_image_contexts_in_workspace(
    image_contexts: &[ImageContextData],
    provider: &str,
    context: &ToolUseContext,
) -> OpenBitFunResult<Vec<ProcessedImage>> {
    process_image_contexts(
        image_contexts,
        provider,
        context.workspace_root(),
        Some(context),
    )
    .await
}

async fn process_image_contexts(
    image_contexts: &[ImageContextData],
    provider: &str,
    workspace_path: Option<&Path>,
    context: Option<&ToolUseContext>,
) -> OpenBitFunResult<Vec<ProcessedImage>> {
    let limits = ImageLimits::for_provider(provider);

    if image_contexts.len() > limits.max_images_per_request {
        return Err(OpenBitFunError::validation(format!(
            "Too many images in one request: {} > {}",
            image_contexts.len(),
            limits.max_images_per_request
        )));
    }

    let mut results = Vec::with_capacity(image_contexts.len());

    for ctx in image_contexts {
        let (image_data, fallback_mime) = if let Some(data_url) = &ctx.data_url {
            let (data, data_url_mime) = decode_data_url(data_url)?;
            (data, data_url_mime.or_else(|| Some(ctx.mime_type.clone())))
        } else if let Some(path_str) = &ctx.image_path {
            let data = if let Some(context) = context {
                let resolved = context.resolve_tool_path(path_str)?;
                context
                    .file_system_for_path(&resolved)?
                    .read_file(&resolved.resolved_path)
                    .await
                    .map_err(|error| {
                        OpenBitFunError::io(format!("Failed to read image: {error}"))
                    })?
            } else {
                let path = resolve_image_path(path_str, workspace_path)?;
                load_image_from_path(&path, workspace_path).await?
            };
            let detected_mime = detect_mime_type_from_bytes(&data, Some(&ctx.mime_type)).ok();
            (data, detected_mime.or_else(|| Some(ctx.mime_type.clone())))
        } else {
            return Err(OpenBitFunError::validation(format!(
                "Image context missing image_path/data_url: id={}",
                ctx.id
            )));
        };

        let processed =
            optimize_image_for_provider(image_data, provider, fallback_mime.as_deref())?;
        results.push(processed);
    }

    Ok(results)
}

pub fn build_multimodal_message_with_images(
    prompt: &str,
    images: &[ProcessedImage],
    provider: &str,
) -> OpenBitFunResult<Vec<Message>> {
    if images.is_empty() {
        return Ok(vec![Message::user(prompt.to_string())]);
    }

    let provider_lower = provider.to_lowercase();

    let content_json = if provider_lower.contains("anthropic") {
        let mut blocks = Vec::with_capacity(images.len() + 1);
        for img in images {
            let base64_data = BASE64.encode(&img.data);
            blocks.push(json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": img.mime_type,
                    "data": base64_data
                }
            }));
        }
        blocks.push(json!({
            "type": "text",
            "text": prompt
        }));
        json!(blocks)
    } else if provider_lower.contains("gemini") || provider_lower.contains("google") {
        let mut parts = Vec::with_capacity(images.len() + 1);
        for img in images {
            let base64_data = BASE64.encode(&img.data);
            parts.push(json!({
                "inline_data": {
                    "mime_type": img.mime_type,
                    "data": base64_data
                }
            }));
        }
        parts.push(json!({ "text": prompt }));
        json!(parts)
    } else {
        let mut blocks = Vec::with_capacity(images.len() + 1);
        for img in images {
            let base64_data = BASE64.encode(&img.data);
            blocks.push(json!({
                "type": "image_url",
                "image_url": {
                    "url": format!("data:{};base64,{}", img.mime_type, base64_data)
                }
            }));
        }
        blocks.push(json!({
            "type": "text",
            "text": prompt
        }));
        json!(blocks)
    };

    Ok(vec![Message {
        role: "user".to_string(),
        content: Some(serde_json::to_string(&content_json)?),
        reasoning_content: None,
        thinking_signature: None,
        tool_calls: None,
        tool_call_id: None,
        name: None,
        is_error: None,
        tool_image_attachments: None,
        model_response_replay: None,
    }])
}

fn image_format_to_mime(format: ImageFormat) -> Option<&'static str> {
    match format {
        ImageFormat::Png => Some("image/png"),
        ImageFormat::Jpeg => Some("image/jpeg"),
        ImageFormat::Gif => Some("image/gif"),
        ImageFormat::WebP => Some("image/webp"),
        ImageFormat::Bmp => Some("image/bmp"),
        _ => None,
    }
}

fn encode_dynamic_image(
    image: &DynamicImage,
    format: ImageFormat,
    jpeg_quality: u8,
) -> OpenBitFunResult<(Vec<u8>, String)> {
    let target_format = match format {
        ImageFormat::Jpeg => ImageFormat::Jpeg,
        _ => ImageFormat::Png,
    };

    let mut buffer = Vec::new();

    match target_format {
        ImageFormat::Png => {
            let rgba = image.to_rgba8();
            let encoder = PngEncoder::new(&mut buffer);
            encoder
                .write_image(
                    rgba.as_raw(),
                    image.width(),
                    image.height(),
                    ColorType::Rgba8.into(),
                )
                .map_err(|e| OpenBitFunError::tool(format!("PNG encode failed: {}", e)))?;
        }
        ImageFormat::Jpeg => {
            let mut encoder = JpegEncoder::new_with_quality(&mut buffer, jpeg_quality);
            encoder
                .encode_image(image)
                .map_err(|e| OpenBitFunError::tool(format!("JPEG encode failed: {}", e)))?;
        }
        _ => unreachable!("unsupported target format"),
    }

    let mime = image_format_to_mime(target_format)
        .unwrap_or("image/png")
        .to_string();

    Ok((buffer, mime))
}

#[cfg(test)]
mod resize_reporting_tests {
    use super::*;

    fn png_of(width: u32, height: u32) -> Vec<u8> {
        let img =
            image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(width, height, |x, y| {
                // Non-uniform content so the encoder cannot collapse it to nothing,
                // which would let the size-based resize passes be skipped.
                image::Rgb([(x % 251) as u8, (y % 253) as u8, ((x ^ y) % 247) as u8])
            }));
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, ImageFormat::Png)
            .expect("encode test png");
        out.into_inner()
    }

    /// A Retina screenshot is wider than every provider's limit, so it always
    /// takes the resize path. The source dimensions were being computed and
    /// then dropped, so callers reported the *resized* size as the file's —
    /// silently wrong data, and the reason a caller mapping a reported position
    /// back to the screen would land in the wrong place.
    #[test]
    fn a_resized_screenshot_still_reports_its_source_dimensions() {
        let processed = optimize_image_with_size_limit(
            png_of(3024, 1964),
            "anthropic",
            Some("image/png"),
            Some(1024 * 1024),
        )
        .expect("optimize");

        assert_eq!(processed.original_width, 3024);
        assert_eq!(processed.original_height, 1964);
        assert!(
            processed.was_resized(),
            "3024px exceeds every provider limit"
        );
        assert!(
            processed.width < processed.original_width,
            "sent {}px for a {}px source",
            processed.width,
            processed.original_width
        );

        // The factor has to actually describe the transform, or mapping back
        // through it is worse than not having it.
        let mapped = f64::from(processed.original_width) * processed.scale();
        assert!(
            (mapped - f64::from(processed.width)).abs() <= 1.0,
            "scale {} maps {} to {}, expected ~{}",
            processed.scale(),
            processed.original_width,
            mapped,
            processed.width
        );
    }

    /// An image already within limits must pass through untouched, and say so.
    #[test]
    fn a_small_image_is_not_reported_as_resized() {
        let processed =
            optimize_image_with_size_limit(png_of(80, 60), "anthropic", Some("image/png"), None)
                .expect("optimize");

        assert_eq!((processed.width, processed.height), (80, 60));
        assert_eq!(
            (processed.original_width, processed.original_height),
            (80, 60)
        );
        assert!(!processed.was_resized());
        assert!((processed.scale() - 1.0).abs() < f64::EPSILON);
    }
}

#[cfg(test)]
mod workspace_image_tests {
    use super::*;
    use crate::agentic::workspace::{
        WorkspaceBinding, WorkspaceCommandOptions, WorkspaceCommandResult, WorkspaceDirEntry,
        WorkspaceFileSystem, WorkspaceServices, WorkspaceShell,
    };
    use async_trait::async_trait;
    use std::sync::Arc;

    struct RemoteFiles(Vec<u8>);
    #[async_trait]
    impl WorkspaceFileSystem for RemoteFiles {
        async fn read_file(&self, _path: &str) -> anyhow::Result<Vec<u8>> {
            Ok(self.0.clone())
        }
        async fn read_file_text(&self, _path: &str) -> anyhow::Result<String> {
            anyhow::bail!("not text")
        }
        async fn write_file(&self, _path: &str, _contents: &[u8]) -> anyhow::Result<()> {
            anyhow::bail!("read only")
        }
        async fn exists(&self, _path: &str) -> anyhow::Result<bool> {
            Ok(true)
        }
        async fn is_file(&self, _path: &str) -> anyhow::Result<bool> {
            Ok(true)
        }
        async fn is_dir(&self, _path: &str) -> anyhow::Result<bool> {
            Ok(false)
        }
        async fn read_dir(&self, _path: &str) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
            Ok(vec![])
        }
    }
    struct NoShell;
    #[async_trait]
    impl WorkspaceShell for NoShell {
        async fn exec_with_options(
            &self,
            _command: &str,
            _options: WorkspaceCommandOptions,
        ) -> anyhow::Result<WorkspaceCommandResult> {
            anyhow::bail!("must not execute")
        }
    }

    #[tokio::test]
    async fn image_path_reads_the_remote_host_even_when_the_same_path_exists_locally() {
        let local = tempfile::tempdir().unwrap();
        let path = local.path().join("photo.png");
        std::fs::write(&path, b"local private content must never be read").unwrap();
        let identity = crate::service::remote_ssh::workspace_state::workspace_session_identity(
            local.path().to_str().unwrap(),
            Some("remote-1"),
            Some("host"),
        )
        .unwrap();
        let workspace = WorkspaceBinding::new_remote(
            Some("remote-workspace".into()),
            local.path().to_path_buf(),
            "remote-1".into(),
            "remote-session".into(),
            identity,
        );
        let mut image = crate::agentic::image_analysis::attachments::test_image();
        let bytes = decode_data_url(image.data_url.as_deref().unwrap())
            .unwrap()
            .0;
        image.data_url = None;
        image.image_path = Some(path.to_str().unwrap().to_string());
        let context = ToolUseContext::for_tool_listing(
            Some(workspace.clone()),
            Some(WorkspaceServices {
                fs: Arc::new(RemoteFiles(bytes)),
                shell: Arc::new(NoShell),
            }),
        );
        let processed = process_image_contexts_in_workspace(&[image.clone()], "openai", &context)
            .await
            .unwrap();
        assert_eq!((processed[0].width, processed[0].height), (8, 6));
        let disconnected = ToolUseContext::for_tool_listing(Some(workspace), None);
        assert!(
            process_image_contexts_in_workspace(&[image], "openai", &disconnected)
                .await
                .is_err()
        );
    }
}
