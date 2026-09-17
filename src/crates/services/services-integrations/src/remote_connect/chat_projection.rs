//! Remote chat projection helpers owned by the remote-connect integration.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use image::imageops::FilterType;
use openbitfun_runtime_ports::AgentInputAttachment;

use super::{ChatImageAttachment, RemoteImageContext};

/// Max thumbnail size per remote chat image sent to mobile (100 KB).
const REMOTE_CHAT_MOBILE_IMAGE_MAX_BYTES: usize = 100 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteChatUserProjection {
    pub content: String,
    pub images: Vec<ChatImageAttachment>,
}

/// `read_image_pixels` resolves an attachment path against the runtime host's
/// filesystem. Everything else here is a pure transform over turn metadata, so
/// the one part that needs the host is passed in rather than reached for.
pub fn project_remote_chat_user(
    metadata: Option<&serde_json::Value>,
    prompt_visible_content: &str,
    read_image_pixels: &dyn Fn(&str) -> Option<Vec<u8>>,
) -> RemoteChatUserProjection {
    let original_text = metadata
        .and_then(|metadata| metadata.get("original_text"))
        .and_then(|value| value.as_str());

    RemoteChatUserProjection {
        content: remote_chat_user_display_content(original_text, prompt_visible_content),
        images: remote_chat_user_images_from_metadata(metadata, read_image_pixels),
    }
}

/// Projection for callers with no filesystem of their own to offer: a path-only
/// attachment stays path-only and clients name it instead of drawing it.
pub fn no_host_image_pixels(_image_path: &str) -> Option<Vec<u8>> {
    None
}

/// Compress a base64 data-URL image to a small thumbnail for mobile display.
/// Falls back to the original if decoding/compression fails or the image is
/// already within the mobile thumbnail budget.
fn compress_remote_chat_data_url_for_mobile(data_url: &str) -> String {
    let Some(comma_pos) = data_url.find(',') else {
        return data_url.to_string();
    };
    let b64_data = &data_url[comma_pos + 1..];

    if b64_data.len() * 3 / 4 <= REMOTE_CHAT_MOBILE_IMAGE_MAX_BYTES {
        return data_url.to_string();
    }

    let Ok(raw_bytes) = BASE64.decode(b64_data) else {
        return data_url.to_string();
    };

    compress_image_bytes_for_mobile(&raw_bytes).unwrap_or_else(|| data_url.to_string())
}

/// Shrink raw image bytes into a data URL within the mobile thumbnail budget.
/// `None` means the bytes could not be decoded or re-encoded, so the caller
/// keeps whatever it already had.
fn compress_image_bytes_for_mobile(raw_bytes: &[u8]) -> Option<String> {
    compress_decoded_image_for_mobile(image::load_from_memory(raw_bytes).ok()?)
}

fn compress_decoded_image_for_mobile(img: image::DynamicImage) -> Option<String> {
    const MAX_THUMBNAIL_DIM: u32 = 400;

    let resized = if img.width() > MAX_THUMBNAIL_DIM || img.height() > MAX_THUMBNAIL_DIM {
        img.resize(MAX_THUMBNAIL_DIM, MAX_THUMBNAIL_DIM, FilterType::Triangle)
    } else {
        img
    };

    fn encode_jpeg(img: &image::DynamicImage, quality: u8) -> Option<Vec<u8>> {
        let mut buf = Vec::new();
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
        img.write_with_encoder(encoder).ok()?;
        Some(buf)
    }

    for quality in [75u8, 60, 45, 30] {
        if let Some(buf) = encode_jpeg(&resized, quality) {
            if buf.len() <= REMOTE_CHAT_MOBILE_IMAGE_MAX_BYTES || quality == 30 {
                let b64 = BASE64.encode(&buf);
                return Some(format!("data:image/jpeg;base64,{b64}"));
            }
        }
    }

    None
}

fn remote_chat_user_images_from_metadata(
    metadata: Option<&serde_json::Value>,
    read_image_pixels: &dyn Fn(&str) -> Option<Vec<u8>>,
) -> Vec<ChatImageAttachment> {
    metadata
        .and_then(|metadata| metadata.get("images"))
        .and_then(|value| value.as_array())
        .map(|images| {
            images
                .iter()
                .filter_map(|image| {
                    let name = image.get("name")?.as_str()?.to_string();
                    // An attachment may have been stored as a host path only.
                    // Read it back where the path still resolves; when that
                    // fails, keep the attachment in the timeline anyway so
                    // clients name it instead of drawing a blank frame, which is
                    // the difference between "no image here" and "this image did
                    // not arrive".
                    let data_url = image
                        .get("data_url")
                        .and_then(|value| value.as_str())
                        .filter(|raw_url| !raw_url.is_empty())
                        .map(compress_remote_chat_data_url_for_mobile)
                        .or_else(|| inline_host_path_pixels(image, read_image_pixels))
                        .unwrap_or_default();
                    if name.trim().is_empty() && data_url.is_empty() {
                        return None;
                    }
                    Some(ChatImageAttachment { name, data_url })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Conversations recorded before attachments carried their pixels hold a host
/// path and nothing else. This is the host that wrote that path, so read it and
/// give clients that cannot reach this filesystem the picture rather than a name.
pub(super) fn inline_host_path_pixels(
    image: &serde_json::Value,
    read_image_pixels: &dyn Fn(&str) -> Option<Vec<u8>>,
) -> Option<String> {
    let image_path = image
        .get("image_path")
        .and_then(|value| value.as_str())
        .filter(|path| !path.is_empty())?;
    let raw_bytes = read_image_pixels(image_path).filter(|bytes| !bytes.is_empty())?;

    // An attachment path is data that travelled in from a paired device, and
    // this read is not bounded by the workspace root the way the remote file
    // commands are. Decoding is the proof that the path really points at an
    // image, so a path aimed at a private file cannot come back as base64.
    // It also settles the type from the bytes rather than from a recorded
    // `mime_type` that may not describe them.
    let format = image::guess_format(&raw_bytes).ok()?;
    let decoded = image::load_from_memory_with_format(&raw_bytes, format).ok()?;

    // An image already inside the mobile budget travels as it was recorded, so
    // a screenshot keeps its transparency instead of being flattened to JPEG.
    if raw_bytes.len() <= REMOTE_CHAT_MOBILE_IMAGE_MAX_BYTES {
        return Some(format!(
            "data:{};base64,{}",
            format.to_mime_type(),
            BASE64.encode(&raw_bytes)
        ));
    }

    compress_decoded_image_for_mobile(decoded)
}

fn remote_chat_user_display_content(
    original_text: Option<&str>,
    prompt_visible_content: &str,
) -> String {
    if let Some(original_text) = original_text.filter(|value| !value.trim().is_empty()) {
        return original_text.to_string();
    }

    if prompt_visible_content.starts_with("User uploaded") {
        if let Some(pos) = prompt_visible_content.find("User's question:\n") {
            return prompt_visible_content[pos + "User's question:\n".len()..]
                .trim()
                .to_string();
        }
    }

    prompt_visible_content.to_string()
}

pub fn agent_input_attachment_from_remote_image_context(
    context: RemoteImageContext,
) -> AgentInputAttachment {
    let mut metadata = serde_json::Map::new();
    if let Some(image_path) = context.image_path {
        metadata.insert(
            "imagePath".to_string(),
            serde_json::Value::String(image_path),
        );
    }
    if let Some(data_url) = context.data_url {
        metadata.insert("dataUrl".to_string(), serde_json::Value::String(data_url));
    }
    metadata.insert(
        "mimeType".to_string(),
        serde_json::Value::String(context.mime_type),
    );
    if let Some(context_metadata) = context.metadata {
        metadata.insert("metadata".to_string(), context_metadata);
    }

    AgentInputAttachment {
        kind: "remote_image".to_string(),
        id: context.id,
        metadata,
    }
}
