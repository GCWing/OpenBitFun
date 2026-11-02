use std::fs;
use std::fs::File;
use std::io::{self, Read, Seek, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const REQUIRED_PAYLOAD_FILES: [&str; 6] = [
    "openbitfun-desktop.exe",
    "frontend/dist/index.html",
    "mobile-web/dist/index.html",
    "resources/ext-host/extension-host.js",
    "resources/worker_host.js",
    "flashgrep/flashgrep-x86_64-pc-windows-msvc.exe",
];

fn main() {
    println!("cargo:rerun-if-env-changed=OPENBITFUN_RELEASE_CHANNEL");
    if let Err(err) = build_embedded_payload() {
        panic!("failed to build embedded payload: {err}");
    }

    tauri_build::build()
}

fn build_embedded_payload() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR")?);
    let payload_dir = manifest_dir.join("payload");
    let out_dir = PathBuf::from(std::env::var("OUT_DIR")?);
    let out_zip = out_dir.join("embedded_payload.zip");
    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());

    println!("cargo:rerun-if-changed={}", payload_dir.display());

    if profile != "debug" {
        validate_release_payload(&payload_dir)?;
    }

    let mut file_count = 0usize;
    if payload_dir.exists() && payload_dir.is_dir() {
        file_count = create_payload_zip(&payload_dir, &out_zip)?;
        if profile != "debug" {
            validate_release_payload_zip(&out_zip)?;
        }
        emit_rerun_for_files(&payload_dir)?;
    } else {
        create_empty_zip(&out_zip)?;
    }

    let available = if file_count > 0 { "1" } else { "0" };
    println!("cargo:rustc-env=EMBEDDED_PAYLOAD_AVAILABLE={available}");
    println!("cargo:warning=embedded payload files: {file_count}");

    Ok(())
}

fn validate_release_payload(payload_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let missing = REQUIRED_PAYLOAD_FILES
        .iter()
        .filter(|relative| !payload_dir.join(relative).is_file())
        .copied()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return Ok(());
    }

    Err(format!(
        "release installer payload is incomplete; run installer:build so these files are staged: {}",
        missing.join(", ")
    )
    .into())
}

fn validate_release_payload_zip(out_zip: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let file = File::open(out_zip)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut available = std::collections::HashSet::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        let name = entry.name()?;
        if !name.ends_with('/') {
            available.insert(name.replace('\\', "/"));
        }
    }

    let missing = REQUIRED_PAYLOAD_FILES
        .iter()
        .filter(|relative| !available.contains(**relative))
        .copied()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return Ok(());
    }

    Err(format!(
        "release installer payload zip is incomplete after archiving; missing entries: {}",
        missing.join(", ")
    )
    .into())
}

fn emit_rerun_for_files(dir: &Path) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        println!("cargo:rerun-if-changed={}", path.display());
        if path.is_dir() {
            emit_rerun_for_files(&path)?;
        }
    }
    Ok(())
}

fn create_empty_zip(out_zip: &Path) -> zip::result::ZipResult<()> {
    let file = File::create(out_zip)?;
    let zip = ZipWriter::new(file);
    zip.finish()?;
    Ok(())
}

fn create_payload_zip(payload_dir: &Path, out_zip: &Path) -> zip::result::ZipResult<usize> {
    let file = File::create(out_zip)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let mut file_count = 0usize;
    add_dir_to_zip(&mut zip, payload_dir, payload_dir, options, &mut file_count)?;

    zip.finish()?;
    Ok(file_count)
}

fn add_dir_to_zip<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    root: &Path,
    current: &Path,
    options: SimpleFileOptions,
    file_count: &mut usize,
) -> zip::result::ZipResult<()> {
    let mut entries = fs::read_dir(current)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(zip::result::ZipError::Io)?;
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .map_err(|_| zip::result::ZipError::FileNotFound)?;
        let rel_name = rel.to_string_lossy().replace('\\', "/");

        if path.is_dir() {
            zip.add_directory(format!("{rel_name}/"), options)?;
            add_dir_to_zip(zip, root, &path, options, file_count)?;
            continue;
        }

        zip.start_file(rel_name, options)?;
        let mut src = File::open(&path)?;
        let mut buf = Vec::new();
        src.read_to_end(&mut buf)?;
        zip.write_all(&buf)?;
        *file_count += 1;
    }

    Ok(())
}
