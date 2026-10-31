//! Bounded image normalization and content-addressed storage. No workspace selection.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{ImageFormat, ImageReader};
use sha2::{Digest, Sha256};
use std::{
    io::{Cursor, Read, Write},
    path::Path,
};

pub const MAX_ICON_UPLOAD_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_ICON_ASSET_BYTES: usize = 512 * 1024;
const MAX_PIXELS: u64 = 20_000_000;

pub fn valid_asset_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn normalize_icon(encoded: &str) -> Result<Vec<u8>, String> {
    if encoded.len() > MAX_ICON_UPLOAD_BYTES.div_ceil(3) * 4 {
        return Err("Workspace icon image is too large".into());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid workspace icon image encoding")?;
    if bytes.len() > MAX_ICON_UPLOAD_BYTES {
        return Err("Workspace icon image is too large".into());
    }
    let format = image::guess_format(&bytes).map_err(|_| "Invalid workspace icon image")?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) {
        return Err("Workspace icons support PNG, JPEG and WebP".into());
    }
    let (width, height) = ImageReader::with_format(Cursor::new(&bytes), format)
        .into_dimensions()
        .map_err(|_| "Invalid workspace icon dimensions")?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err("Workspace icon exceeds the decoded pixel limit".into());
    }
    let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(128 * 1024 * 1024);
    limits.max_image_width = Some(20_000);
    limits.max_image_height = Some(20_000);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| "Unable to decode workspace icon")?;
    use image::ImageDecoder;
    let orientation = decoder
        .orientation()
        .map_err(|_| "Invalid workspace icon orientation")?;
    let mut picture = image::DynamicImage::from_decoder(decoder)
        .map_err(|_| "Unable to decode workspace icon")?;
    picture.apply_orientation(orientation);
    let mut output = Cursor::new(Vec::new());
    picture
        .thumbnail(256, 256)
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|_| "Unable to encode workspace icon")?;
    let output = output.into_inner();
    if output.len() > MAX_ICON_ASSET_BYTES {
        return Err("Normalized workspace icon is too large".into());
    }
    Ok(output)
}

pub fn store_icon(root: &Path, bytes: &[u8]) -> Result<String, String> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    if std::fs::symlink_metadata(root)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Workspace icon directory must not be a symlink".into());
    }
    let id = format!("{:x}", Sha256::digest(bytes));
    let destination = root.join(format!("{id}.png"));
    if destination.exists() && read_icon(root, &id).is_ok() {
        // Validate rather than trusting a file with the right name.
        return Ok(id);
    }
    // Re-uploading the same normalized content can atomically repair a damaged asset.
    let temporary = root.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&temporary, &destination).map_err(|e| e.to_string())
    })();
    let _ = std::fs::remove_file(&temporary);
    result?;
    Ok(id)
}

pub fn read_icon(root: &Path, id: &str) -> Result<String, String> {
    if !valid_asset_id(id) {
        return Err("Invalid workspace icon asset ID".into());
    }
    let path = root.join(format!("{id}.png"));
    let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_ICON_ASSET_BYTES as u64 {
        return Err("Invalid workspace icon asset".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(MAX_ICON_ASSET_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_ICON_ASSET_BYTES || format!("{:x}", Sha256::digest(&bytes)) != id {
        return Err("Workspace icon asset digest mismatch".into());
    }
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalizes_and_keeps_asset_after_source_is_gone() {
        let mut original = Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(1024, 512)
            .write_to(&mut original, ImageFormat::Png)
            .unwrap();
        let png = normalize_icon(&STANDARD.encode(original.into_inner())).unwrap();
        let decoded = image::load_from_memory(&png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (256, 128));
        let root = tempfile::tempdir().unwrap();
        let id = store_icon(root.path(), &png).unwrap();
        assert!(read_icon(root.path(), &id)
            .unwrap()
            .starts_with("data:image/png;base64,"));
        std::fs::write(root.path().join(format!("{id}.png")), b"damaged").unwrap();
        assert!(read_icon(root.path(), &id).is_err());
        assert_eq!(store_icon(root.path(), &png).unwrap(), id);
        assert!(read_icon(root.path(), &id).is_ok());
    }
    #[test]
    fn rejects_paths_scripts_and_oversized_uploads() {
        assert!(!valid_asset_id("../secret"));
        assert!(normalize_icon(&STANDARD.encode(b"<svg></svg>")).is_err());
        assert!(normalize_icon(&"A".repeat(MAX_ICON_UPLOAD_BYTES.div_ceil(3) * 4 + 1)).is_err());
    }
}
