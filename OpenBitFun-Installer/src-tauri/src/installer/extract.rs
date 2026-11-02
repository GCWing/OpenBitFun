use anyhow::{Context, Result};
use std::fs;
use std::io;
use std::io::Cursor;
use std::path::{Path, PathBuf};

/// Estimated install size in bytes (~200MB for typical Tauri app with WebView)
pub(super) const ESTIMATED_INSTALL_SIZE: u64 = 200 * 1024 * 1024;

/// Extract a zip archive to the target directory with an entry filter.
pub(super) fn extract_zip_with_filter(
    archive_path: &Path,
    target_dir: &Path,
    should_extract: fn(&Path) -> bool,
) -> Result<()> {
    let file = fs::File::open(archive_path)
        .with_context(|| format!("Failed to open archive: {}", archive_path.display()))?;

    let archive = zip::ZipArchive::new(file).with_context(|| "Failed to read zip archive")?;
    extract_zip_archive(archive, target_dir, should_extract)
}

/// Extract a zip archive from in-memory bytes with an entry filter.
pub(super) fn extract_zip_bytes_with_filter(
    archive_bytes: &[u8],
    target_dir: &Path,
    should_extract: fn(&Path) -> bool,
) -> Result<()> {
    let reader = Cursor::new(archive_bytes);
    let archive = zip::ZipArchive::new(reader).with_context(|| "Failed to read embedded zip")?;
    extract_zip_archive(archive, target_dir, should_extract)
}

fn extract_zip_archive<R: io::Read + io::Seek>(
    mut archive: zip::ZipArchive<R>,
    target_dir: &Path,
    should_extract: fn(&Path) -> bool,
) -> Result<()> {
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let rel_path: PathBuf = file
            .mangled_name()
            .context("Failed to decode zip entry path")?;
        if !should_extract(&rel_path) {
            continue;
        }
        let out_path = target_dir.join(&rel_path);

        if file.is_dir() {
            fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut outfile = fs::File::create(&out_path)?;
            io::copy(&mut file, &mut outfile)?;
        }
    }

    Ok(())
}

/// Copy files from source to target with a relative-path file filter.
pub(super) fn copy_directory_with_filter(
    source: &Path,
    target: &Path,
    should_copy_file: fn(&Path) -> bool,
) -> Result<u64> {
    copy_directory_internal(source, target, Path::new(""), should_copy_file)
}

fn copy_directory_internal(
    source: &Path,
    target: &Path,
    relative_prefix: &Path,
    should_copy_file: fn(&Path) -> bool,
) -> Result<u64> {
    let mut bytes_copied: u64 = 0;

    if !target.exists() {
        fs::create_dir_all(target)?;
    }

    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let name = entry.file_name();
        let rel = relative_prefix.join(&name);
        let dest = target.join(&name);

        if file_type.is_dir() {
            bytes_copied += copy_directory_internal(&entry.path(), &dest, &rel, should_copy_file)?;
        } else {
            if !should_copy_file(&rel) {
                continue;
            }
            let size = entry.metadata()?.len();
            fs::copy(entry.path(), &dest)?;
            bytes_copied += size;
        }
    }

    Ok(bytes_copied)
}

#[cfg(test)]
mod tests {
    use super::{extract_zip_bytes_with_filter, extract_zip_with_filter};
    use std::{fs, path::Path};

    #[test]
    fn reads_legacy_payload_from_file_and_embedded_bytes() {
        // Frozen output from zip 0.6.6: directories, Stored/Deflated entries,
        // and a UTF-8 filename. Keep these bytes independent of the current writer.
        let payload = include_bytes!("fixtures/legacy-payload-zip-0.6.6.zip");
        for embedded in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let target = root.path().join("installed");
            let filter = |path: &Path| path != Path::new("skip.txt");
            if embedded {
                extract_zip_bytes_with_filter(payload, &target, filter).unwrap();
            } else {
                let archive = root.path().join("payload.zip");
                fs::write(&archive, payload).unwrap();
                extract_zip_with_filter(&archive, &target, filter).unwrap();
            }
            assert_eq!(
                fs::read(target.join("frontend/dist/index.html")).unwrap(),
                b"<html>legacy installer payload</html>"
            );
            assert_eq!(
                fs::read(target.join("resources/readme.txt")).unwrap(),
                b"legacy resource"
            );
            assert_eq!(
                fs::read(target.join("resources/\u{7528}\u{6237}.txt")).unwrap(),
                b"legacy unicode path"
            );
            assert!(!target.join("skip.txt").exists());
        }
    }
}
