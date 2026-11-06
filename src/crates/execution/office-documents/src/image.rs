//! Image sniffing for embedding: format, natural size, and data URLs.

use crate::error::{OfficeError, OfficeErrorKind, OfficeResult};
use base64::Engine;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageKind {
    Png,
    Jpeg,
    Gif,
    Bmp,
}

impl ImageKind {
    pub const fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpeg",
            Self::Gif => "gif",
            Self::Bmp => "bmp",
        }
    }

    pub const fn content_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Bmp => "image/bmp",
        }
    }

    pub fn from_extension(extension: &str) -> Option<Self> {
        match extension.to_ascii_lowercase().as_str() {
            "png" => Some(Self::Png),
            "jpg" | "jpeg" => Some(Self::Jpeg),
            "gif" => Some(Self::Gif),
            "bmp" => Some(Self::Bmp),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageInfo {
    pub kind: ImageKind,
    pub width: u32,
    pub height: u32,
}

fn invalid(message: impl Into<String>) -> OfficeError {
    OfficeError::new(OfficeErrorKind::InvalidImage, message)
}

/// Reads the format and pixel size from the file header.
pub fn sniff(bytes: &[u8]) -> OfficeResult<ImageInfo> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        if bytes.len() < 24 {
            return Err(invalid("truncated PNG header"));
        }
        let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
        return checked(ImageKind::Png, width, height);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        if bytes.len() < 10 {
            return Err(invalid("truncated GIF header"));
        }
        let width = u16::from_le_bytes([bytes[6], bytes[7]]) as u32;
        let height = u16::from_le_bytes([bytes[8], bytes[9]]) as u32;
        return checked(ImageKind::Gif, width, height);
    }
    if bytes.starts_with(b"BM") {
        if bytes.len() < 26 {
            return Err(invalid("truncated BMP header"));
        }
        let width = i32::from_le_bytes([bytes[18], bytes[19], bytes[20], bytes[21]]);
        let height = i32::from_le_bytes([bytes[22], bytes[23], bytes[24], bytes[25]]);
        return checked(ImageKind::Bmp, width.unsigned_abs(), height.unsigned_abs());
    }
    if bytes.starts_with(&[0xFF, 0xD8]) {
        let (width, height) =
            jpeg_size(bytes).ok_or_else(|| invalid("JPEG without a frame header"))?;
        return checked(ImageKind::Jpeg, width, height);
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Err(invalid(
            "WebP images are not supported by Office; convert the picture to PNG or JPEG first",
        ));
    }
    if bytes.starts_with(b"<svg") || bytes.starts_with(b"<?xml") {
        return Err(invalid(
            "SVG images are not supported; convert the picture to PNG first",
        ));
    }
    Err(invalid(
        "unsupported image format; use PNG, JPEG, GIF or BMP",
    ))
}

fn checked(kind: ImageKind, width: u32, height: u32) -> OfficeResult<ImageInfo> {
    if width == 0 || height == 0 {
        return Err(invalid("image has zero width or height"));
    }
    Ok(ImageInfo {
        kind,
        width,
        height,
    })
}

fn jpeg_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut index = 2;
    while index + 4 <= bytes.len() {
        if bytes[index] != 0xFF {
            index += 1;
            continue;
        }
        let marker = bytes[index + 1];
        if marker == 0xFF {
            index += 1;
            continue;
        }
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            index += 2;
            continue;
        }
        let length = u16::from_be_bytes([bytes[index + 2], bytes[index + 3]]) as usize;
        let is_frame = (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if is_frame {
            if index + 9 > bytes.len() {
                return None;
            }
            let height = u16::from_be_bytes([bytes[index + 5], bytes[index + 6]]) as u32;
            let width = u16::from_be_bytes([bytes[index + 7], bytes[index + 8]]) as u32;
            return Some((width, height));
        }
        if length < 2 {
            return None;
        }
        index += 2 + length;
    }
    None
}

/// Decodes `data:image/...;base64,...`; `None` when the source is not a data URL.
pub fn decode_data_url(source: &str) -> Option<OfficeResult<Vec<u8>>> {
    let rest = source.strip_prefix("data:")?;
    let Some((meta, payload)) = rest.split_once(',') else {
        return Some(Err(invalid("malformed data URL")));
    };
    if !meta.ends_with(";base64") {
        return Some(Err(invalid("data URLs must be base64 encoded")));
    }
    let cleaned: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
    Some(
        base64::engine::general_purpose::STANDARD
            .decode(cleaned.as_bytes())
            .map_err(|err| invalid(format!("invalid base64 in data URL: {err}"))),
    )
}

/// Content-addressed asset name: the same picture is stored once.
pub fn asset_name(bytes: &[u8], kind: ImageKind) -> String {
    let digest = Sha256::digest(bytes);
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("img-{hex}.{}", kind.extension())
}

pub fn kind_of_asset(name: &str) -> Option<ImageKind> {
    name.rsplit_once('.')
        .and_then(|(_, extension)| ImageKind::from_extension(extension))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::tiny_png;

    #[test]
    fn sniffs_png_size_and_rejects_webp() {
        let info = sniff(&tiny_png(640, 480)).unwrap();
        assert_eq!(
            (info.kind, info.width, info.height),
            (ImageKind::Png, 640, 480)
        );
        let error = sniff(b"RIFF\0\0\0\0WEBPVP8 ").unwrap_err();
        assert_eq!(error.kind, OfficeErrorKind::InvalidImage);
    }

    #[test]
    fn reads_jpeg_frame_size() {
        let jpeg = [
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00,
            0x20, 0x00, 0x40,
        ];
        let info = sniff(&jpeg).unwrap();
        assert_eq!((info.width, info.height), (64, 32));
    }

    #[test]
    fn decodes_data_urls() {
        let decoded = decode_data_url("data:image/png;base64,aGk=")
            .unwrap()
            .unwrap();
        assert_eq!(decoded, b"hi");
        assert!(decode_data_url("/tmp/a.png").is_none());
    }
}
