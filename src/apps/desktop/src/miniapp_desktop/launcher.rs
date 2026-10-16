//! Native launcher adapters. Launch records resolve the installed app by stable identity.
use super::ipc;
use image::{imageops, Rgba, RgbaImage};
use openbitfun_services_core::process_manager::create_command;
use sha2::{Digest, Sha256};
use std::io::Cursor;
use std::path::{Path, PathBuf};

pub(crate) use openbitfun_miniapp_ipc::launcher::{read_record, write_record, LaunchRecord};

fn png(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut out = Cursor::new(Vec::new());
    image
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

/// Composite the owned brand asset last; callers cannot cover or remove it.
pub(crate) fn icon_pixels(app_id: &str, svg: Option<&str>) -> Result<RgbaImage, String> {
    let hash = Sha256::digest(app_id.as_bytes());
    let mut base =
        RgbaImage::from_pixel(512, 512, Rgba([hash[0] / 2, hash[1] / 2, hash[2] / 2, 255]));
    if let Some(svg) = svg {
        let lower = svg.to_ascii_lowercase();
        if svg.len() > 65536
            || ["href", "url(", "<!doctype", "<image", "<text"]
                .iter()
                .any(|part| lower.contains(part))
        {
            return Err("MiniApp icon must contain only bounded SVG shapes".into());
        }
        let tree = resvg::usvg::Tree::from_str(svg, &resvg::usvg::Options::default())
            .map_err(|e| e.to_string())?;
        let mut pixels =
            resvg::tiny_skia::Pixmap::new(320, 320).ok_or("Invalid icon dimensions")?;
        let size = tree.size();
        resvg::render(
            &tree,
            resvg::tiny_skia::Transform::from_scale(320.0 / size.width(), 320.0 / size.height()),
            &mut pixels.as_mut(),
        );
        let glyph = image::load_from_memory(&pixels.encode_png().map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
            .to_rgba8();
        imageops::overlay(&mut base, &glyph, 80, 80);
    } else {
        // Deterministic identity for launchers installed without a rendered catalog glyph.
        for y in 0..5u32 {
            for x in 0..5u32 {
                if hash[(y * 3 + x.min(4 - x)) as usize] & 1 == 0 {
                    continue;
                }
                for py in 80 + y * 60..120 + y * 60 {
                    for px in 80 + x * 60..120 + x * 60 {
                        base.put_pixel(px, py, Rgba([235, 235, 235, 255]));
                    }
                }
            }
        }
    }
    let mark = image::load_from_memory(include_bytes!(
        "../../../../../assets/brand/exports/openbitfun-app-icon-256.png"
    ))
    .map_err(|e| e.to_string())?
    .to_rgba8();
    let mark = imageops::resize(&mark, 164, 164, imageops::FilterType::Lanczos3);
    imageops::overlay(&mut base, &mark, 338, 338);
    Ok(base)
}

pub(crate) fn write_icons(dir: &Path, app_id: &str, svg: Option<&str>) -> Result<(), String> {
    let base = icon_pixels(app_id, svg)?;
    let mut frames = Vec::new();
    for size in [16, 24, 32, 48, 64, 128, 256, 512, 1024] {
        let image = imageops::resize(&base, size, size, imageops::FilterType::Lanczos3);
        let bytes = png(&image)?;
        std::fs::write(dir.join(format!("icon-{size}.png")), &bytes).map_err(|e| e.to_string())?;
        frames.push((size, bytes));
    }
    let ico_frames: Vec<_> = frames.iter().filter(|(size, _)| *size <= 256).collect();
    let mut ico = vec![0, 0, 1, 0];
    ico.extend_from_slice(&(ico_frames.len() as u16).to_le_bytes());
    let mut offset = 6 + 16 * ico_frames.len();
    for (size, bytes) in &ico_frames {
        ico.extend_from_slice(&[*size as u8, *size as u8, 0, 0, 1, 0, 32, 0]);
        ico.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        ico.extend_from_slice(&(offset as u32).to_le_bytes());
        offset += bytes.len();
    }
    for (_, bytes) in ico_frames {
        ico.extend_from_slice(bytes);
    }
    std::fs::write(dir.join("icon.ico"), ico).map_err(|e| e.to_string())?;
    ensure_macos_icon(dir)?;
    ipc::private_json(&dir.join("icon-source.json"), &icon_source(app_id, svg))
}

fn icon_source(app_id: &str, svg: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "rendererVersion": 1,
        "appId": app_id,
        "svgHash": svg.map(|value| format!("{:x}", Sha256::digest(value.as_bytes()))),
    })
}

/// Native legacy artwork follows the brand's 824/1024 body-to-canvas ratio.
/// This is our authored layout, not OS-version-dependent scaling. Keep the
/// shared PNG/ICO artwork intact; only macOS ICNS gets the transparent inset.
fn macos_icon_pixels(base: &RgbaImage) -> RgbaImage {
    let mut body = imageops::resize(base, 412, 412, imageops::FilterType::Lanczos3);
    let radius = 92.0_f32;
    for (x, y, pixel) in body.enumerate_pixels_mut() {
        let dx = (x as f32 + 0.5 - 206.0).abs() - (206.0 - radius);
        let dy = (y as f32 + 0.5 - 206.0).abs() - (206.0 - radius);
        let distance = dx.max(0.0).hypot(dy.max(0.0)) + dx.max(dy).min(0.0) - radius;
        let coverage = (0.5 - distance).clamp(0.0, 1.0);
        pixel.0[3] = (pixel.0[3] as f32 * coverage).round() as u8;
    }
    let mut canvas = RgbaImage::new(512, 512);
    imageops::overlay(&mut canvas, &body, 50, 50);
    canvas
}

/// Older launchers retain the original full-canvas PNG, so changing the native
/// layout can migrate their ICNS without losing the app glyph or its watermark.
fn ensure_macos_icon(dir: &Path) -> Result<(), String> {
    let source = std::fs::read(dir.join("icon-512.png")).map_err(|e| e.to_string())?;
    let fingerprint = serde_json::json!({
        "layoutVersion": 1,
        "sourceHash": format!("{:x}", Sha256::digest(&source)),
    });
    let stamp = dir.join("icon-macos.json");
    if dir.join("icon.icns").is_file()
        && std::fs::read(&stamp)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            == Some(fingerprint.clone())
    {
        return Ok(());
    }
    let base = image::load_from_memory(&source)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let base = macos_icon_pixels(&base);
    let mut chunks = Vec::new();
    for size in [16, 32, 64, 128, 256, 512, 1024] {
        let bytes = png(&imageops::resize(
            &base,
            size,
            size,
            imageops::FilterType::Lanczos3,
        ))?;
        let code = match size {
            16 => "icp4",
            32 => "icp5",
            64 => "icp6",
            128 => "ic07",
            256 => "ic08",
            512 => "ic09",
            1024 => "ic10",
            _ => continue,
        };
        chunks.extend_from_slice(code.as_bytes());
        chunks.extend_from_slice(&((bytes.len() + 8) as u32).to_be_bytes());
        chunks.extend_from_slice(&bytes);
    }
    let mut icns = b"icns".to_vec();
    icns.extend_from_slice(&((chunks.len() + 8) as u32).to_be_bytes());
    icns.extend_from_slice(&chunks);
    std::fs::write(dir.join("icon.icns"), icns).map_err(|e| e.to_string())?;
    ipc::private_json(&stamp, &fingerprint)?;
    Ok(())
}

pub(crate) fn prepare_icons(record: &LaunchRecord, svg: Option<&str>) -> Result<(), String> {
    let path = write_record(record)?;
    let dir = path.parent().ok_or("Missing launcher directory")?;
    let source_changed = svg.is_some()
        && std::fs::read(dir.join("icon-source.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            != Some(icon_source(&record.app_id, svg));
    if source_changed || !dir.join("icon-512.png").is_file() {
        write_icons(dir, &record.app_id, svg)
    } else {
        ensure_macos_icon(dir)
    }
}

fn native_name(record: &LaunchRecord) -> String {
    let safe: String = record
        .name
        .chars()
        .filter(|c| !c.is_control() && !"/\\:\"<>|?*".contains(*c))
        .take(80)
        .collect();
    if safe.trim().is_empty() {
        "MiniApp".into()
    } else {
        safe.trim().into()
    }
}

/// Identity belongs in launcher metadata, never in the user-visible filename.
/// Keep established paths across title changes, except for the old generated ID
/// suffix. Rename owned entries in place so the existing launcher stays usable.
#[cfg(any(target_os = "macos", target_os = "windows", test))]
fn launcher_destination(
    record: &LaunchRecord,
    applications: &Path,
    extension: &str,
    mut is_owned: impl FnMut(&Path) -> bool,
) -> Result<PathBuf, String> {
    let target = applications.join(format!("{}.{}", native_name(record), extension));
    let legacy_suffix = format!(
        " — {}",
        record.launch_id.chars().take(8).collect::<String>()
    );
    for entry in std::fs::read_dir(applications).map_err(|e| e.to_string())? {
        let candidate = entry.map_err(|e| e.to_string())?.path();
        if !candidate
            .extension()
            .is_some_and(|value| value == extension)
            || !is_owned(&candidate)
        {
            continue;
        }
        if !candidate
            .file_stem()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(&legacy_suffix))
        {
            return Ok(candidate);
        }
        if target.try_exists().map_err(|e| e.to_string())? {
            return Err("An application with this name already exists; rename the MiniApp before adding it again".into());
        }
        std::fs::rename(&candidate, &target).map_err(|e| e.to_string())?;
        return Ok(target);
    }
    if target.try_exists().map_err(|e| e.to_string())? {
        return Err("An application with this name already exists; rename the MiniApp before adding it again".into());
    }
    Ok(target)
}
fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn desktop_value(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn desktop_exec_arg(path: &Path) -> Result<String, String> {
    let value = path.to_str().ok_or("MiniApp launcher path is not UTF-8")?;
    if value.chars().any(char::is_control) {
        return Err("MiniApp launcher paths cannot contain control characters".into());
    }
    Ok(format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('`', "\\`")
            .replace('$', "\\$")
            .replace('%', "%%")
    ))
}

/// Bundled as a sibling executable by Tauri on every desktop platform. Missing
/// resources are an explicit packaging error; never copy the full Desktop host.
pub(crate) fn shell_executable(host: &Path) -> Result<PathBuf, String> {
    let name = if cfg!(windows) {
        "openbitfun-miniapp-shell.exe"
    } else {
        "openbitfun-miniapp-shell"
    };
    let path = host
        .parent()
        .ok_or("Missing OpenBitFun application directory")?
        .join(name);
    if !path.is_file() {
        return Err("The lightweight MiniApp shell is missing. Reinstall OpenBitFun, or run pnpm run prepare:miniapp-shell for a source build.".into());
    }
    Ok(path)
}

pub(crate) fn install(record: &LaunchRecord, svg: Option<&str>) -> Result<PathBuf, String> {
    let shell = shell_executable(&record.host_executable)?;
    let path = write_record(record)?;
    let dir = path.parent().ok_or("Missing launcher directory")?;
    prepare_icons(record, svg)?;
    #[cfg(target_os = "macos")]
    {
        let applications = super::system_install::applications_directory()?;
        return install_macos(record, dir, &applications, &shell);
    }
    #[cfg(target_os = "linux")]
    {
        let applications = super::system_install::applications_directory()?;
        std::fs::create_dir_all(&applications).map_err(|e| e.to_string())?;
        let target = applications.join(format!(
            "com.openbitfun.miniapp.{}.desktop",
            record.launch_id
        ));
        let exec = format!(
            "{} --miniapp-launch {}",
            desktop_exec_arg(&shell)?,
            desktop_exec_arg(&path)?
        );
        let icon = dir.join("icon-256.png");
        std::fs::write(&target, format!("[Desktop Entry]\nType=Application\nName={}\nExec={}\nIcon={}\nTerminal=false\nStartupWMClass=com.openbitfun.miniapp.{}\nCategories=Utility;\n", desktop_value(&native_name(record)), desktop_value(&exec), desktop_value(&icon.to_string_lossy()), record.launch_id)).map_err(|e| e.to_string())?;
        return Ok(target);
    }
    #[cfg(target_os = "windows")]
    {
        return install_windows(record, &path, dir, &shell);
    }
    #[allow(unreachable_code)]
    Err("System MiniApp launchers are unsupported on this platform".into())
}

/// Internal windows keep their bundle in managed data; publishing a system
/// application is a separate explicit operation.
#[cfg(target_os = "macos")]
pub(crate) fn runtime_bundle(record: &LaunchRecord) -> Result<PathBuf, String> {
    let shell = shell_executable(&record.host_executable)?;
    let path = write_record(record)?;
    let dir = path.parent().ok_or("Missing launcher directory")?;
    prepare_icons(record, None)?;
    install_macos(record, dir, &dir.join("runtime"), &shell)
}

#[cfg(target_os = "macos")]
fn install_macos(
    record: &LaunchRecord,
    dir: &Path,
    applications: &Path,
    shell: &Path,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(&applications).map_err(|e| e.to_string())?;
    let bundle = launcher_destination(record, applications, "app", |candidate| {
        read_record(&candidate.join("Contents/Resources/openbitfun-miniapp.json"))
            .is_ok_and(|previous| previous.launch_id == record.launch_id)
    })?;
    let metadata = std::fs::metadata(shell).map_err(|e| e.to_string())?;
    let fingerprint = serde_json::json!({
        "format": 2, "record": record, "shellBytes": metadata.len(),
        "shellHash": format!("{:x}", Sha256::digest(std::fs::read(shell).map_err(|e| e.to_string())?)),
        "executableModified": metadata.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|time| time.as_nanos().to_string()),
        "iconHash": format!("{:x}", Sha256::digest(std::fs::read(dir.join("icon.icns")).map_err(|e| e.to_string())?))
    });
    let fingerprint_path = bundle.join("Contents/Resources/build.json");
    if std::fs::read(&fingerprint_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        == Some(fingerprint.clone())
        && bundle.join("Contents/MacOS/MiniApp").is_file()
    {
        return Ok(bundle);
    }
    let staging = tempfile::tempdir_in(&applications).map_err(|e| e.to_string())?;
    let staged_bundle = staging.path().join("MiniApp.app");
    let contents = staged_bundle.join("Contents");
    std::fs::create_dir_all(contents.join("MacOS")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(contents.join("Resources")).map_err(|e| e.to_string())?;
    std::fs::copy(shell, contents.join("MacOS/MiniApp")).map_err(|e| e.to_string())?;
    std::fs::copy(dir.join("icon.icns"), contents.join("Resources/icon.icns"))
        .map_err(|e| e.to_string())?;
    std::fs::copy(
        dir.join("icon-256.png"),
        contents.join("Resources/icon-256.png"),
    )
    .map_err(|e| e.to_string())?;
    ipc::private_json(&contents.join("Resources/openbitfun-miniapp.json"), record)?;
    ipc::private_json(&contents.join("Resources/build.json"), &fingerprint)?;
    std::fs::write(contents.join("Info.plist"), format!(r#"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>MiniApp</string><key>CFBundleIdentifier</key><string>com.openbitfun.miniapp.{}</string><key>CFBundleName</key><string>{}</string><key>CFBundleDisplayName</key><string>{}</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>CFBundleIconFile</key><string>icon.icns</string><key>NSHighResolutionCapable</key><true/></dict></plist>"#, record.launch_id, xml(&record.name), xml(&record.name))).map_err(|e| e.to_string())?;
    let status = create_command("/usr/bin/codesign")
        .args(["--force", "--sign", "-"])
        .arg(&staged_bundle)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Could not sign the local MiniApp launcher".into());
    }
    // Replace only our own recorded bundle; never remove an unrelated app.
    if bundle.exists() {
        let previous = read_record(&bundle.join("Contents/Resources/openbitfun-miniapp.json"))?;
        if previous.launch_id != record.launch_id {
            return Err("Launcher destination belongs to another application".into());
        }
        let backup = applications.join(format!(".{}.previous", record.launch_id));
        if backup.exists() {
            return Err("A previous launcher update needs recovery".into());
        }
        std::fs::rename(&bundle, &backup).map_err(|e| e.to_string())?;
        if let Err(error) = std::fs::rename(&staged_bundle, &bundle) {
            let _ = std::fs::rename(&backup, &bundle);
            return Err(error.to_string());
        }
        let _ = std::fs::remove_dir_all(backup);
    } else {
        std::fs::rename(&staged_bundle, &bundle).map_err(|e| e.to_string())?;
    }
    Ok(bundle)
}

#[cfg(target_os = "windows")]
fn app_user_model_id_property(
    launch_id: &str,
) -> windows::core::Result<windows::Win32::System::Com::StructuredStorage::PROPVARIANT> {
    use std::mem::ManuallyDrop;
    use windows::Win32::System::Com::StructuredStorage::{
        PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
    };
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::SHStrDupW;

    let app_id = windows::core::HSTRING::from(format!("com.openbitfun.miniapp.{launch_id}"));
    // SAFETY: SHStrDupW copies the live UTF-16 string with the COM allocator.
    // PROPVARIANT owns that allocation and frees it through PropVariantClear.
    let owned = unsafe { SHStrDupW(&app_id)? };
    Ok(PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_LPWSTR,
                Anonymous: PROPVARIANT_0_0_0 { pwszVal: owned },
                ..Default::default()
            }),
        },
    })
}

#[cfg(target_os = "windows")]
fn install_windows(
    record: &LaunchRecord,
    manifest: &Path,
    dir: &Path,
    shell: &Path,
) -> Result<PathBuf, String> {
    use windows::core::{Interface, HSTRING, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    let target = super::system_install::applications_directory()?;
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    // SAFETY: COM is initialized on this blocking worker thread; all interface
    // calls and borrowed UTF-16 buffers remain on it until persistence completes.
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| e.to_string())?;
        let result = (|| -> Result<PathBuf, String> {
            let arguments = format!("--miniapp-launch \"{}\"", manifest.display());
            let target = launcher_destination(record, &target, "lnk", |candidate| {
                // Inspect the persisted target before migrating or replacing a
                // shortcut. Matching its filename alone does not establish ownership.
                (|| -> windows::core::Result<bool> {
                    let link: IShellLinkW =
                        CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
                    let persist: IPersistFile = link.cast()?;
                    persist.Load(&HSTRING::from(candidate.as_os_str()), STGM_READ)?;
                    let mut buffer = vec![0u16; 32768];
                    link.GetArguments(&mut buffer)?;
                    let end = buffer
                        .iter()
                        .position(|value| *value == 0)
                        .unwrap_or(buffer.len());
                    Ok(String::from_utf16_lossy(&buffer[..end]) == arguments)
                })()
                .unwrap_or(false)
            })?;
            (|| -> windows::core::Result<()> {
                let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
                link.SetPath(&HSTRING::from(shell.as_os_str()))?;
                link.SetArguments(&HSTRING::from(arguments))?;
                link.SetIconLocation(&HSTRING::from(dir.join("icon.ico").as_os_str()), 0)?;
                use windows::Win32::Foundation::PROPERTYKEY;
                use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
                let properties: IPropertyStore = link.cast()?;
                let key = PROPERTYKEY {
                    fmtid: windows::core::GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
                    pid: 5,
                };
                let value = app_user_model_id_property(&record.launch_id)?;
                properties.SetValue(&key, &value)?;
                properties.Commit()?;
                let persist: IPersistFile = link.cast()?;
                let wide: Vec<u16> = target
                    .as_os_str()
                    .to_string_lossy()
                    .encode_utf16()
                    .chain(Some(0))
                    .collect();
                persist.Save(PCWSTR(wide.as_ptr()), true)?;
                Ok(())
            })()
            .map_err(|e| e.to_string())?;
            Ok(target)
        })();
        CoUninitialize();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_app_user_model_id_owns_a_wide_property_value() {
        let value = app_user_model_id_property("notes").unwrap();
        assert_eq!(value.vt(), windows::Win32::System::Variant::VT_LPWSTR);
        // SAFETY: the helper returns an owning VT_LPWSTR value, which remains
        // alive while its null-terminated string is read, then frees it on Drop.
        let app_id = unsafe { value.Anonymous.Anonymous.Anonymous.pwszVal.to_string() }.unwrap();
        assert_eq!(app_id, "com.openbitfun.miniapp.notes");
    }

    fn fixture(root: &Path) -> LaunchRecord {
        LaunchRecord {
            protocol_version: 1,
            launch_id: uuid::Uuid::new_v4().to_string(),
            app_id: "notes".into(),
            workspace_path: None,
            data_dir: root.join("data"),
            user_root: root.to_path_buf(),
            host_executable: PathBuf::from("/usr/bin/true"),
            name: "Notes & Files".into(),
            extra: Default::default(),
        }
    }

    #[test]
    fn visible_launcher_names_do_not_include_internal_identity() {
        let mut record = fixture(Path::new("/tmp"));
        assert_eq!(native_name(&record), "Notes & Files");
        record.launch_id = uuid::Uuid::new_v4().to_string();
        assert_eq!(native_name(&record), "Notes & Files");
        record.name = " /\\\n ".into();
        assert_eq!(native_name(&record), "MiniApp");
    }

    #[test]
    fn missing_shell_never_resolves_to_the_full_host() {
        let root = tempfile::tempdir().unwrap();
        let host = root.path().join("OpenBitFun");
        std::fs::write(&host, "full host executable").unwrap();
        assert!(shell_executable(&host)
            .unwrap_err()
            .contains("lightweight MiniApp shell is missing"));
        let name = if cfg!(windows) {
            "openbitfun-miniapp-shell.exe"
        } else {
            "openbitfun-miniapp-shell"
        };
        let shell = root.path().join(name);
        std::fs::write(&shell, "window-only executable").unwrap();
        assert_eq!(shell_executable(&host).unwrap(), shell);
    }

    #[test]
    fn launcher_name_migration_preserves_unrelated_entries_and_legacy_source_on_collision() {
        let root = tempfile::tempdir().unwrap();
        let mut record = fixture(root.path());
        let legacy = root
            .path()
            .join(format!("Notes & Files — {}.lnk", &record.launch_id[..8]));
        let target = root.path().join("Notes & Files.lnk");
        std::fs::write(&legacy, &record.launch_id).unwrap();
        std::fs::write(&target, "unrelated shortcut").unwrap();
        let owned = |candidate: &Path| {
            std::fs::read_to_string(candidate).is_ok_and(|value| value == record.launch_id)
        };
        assert!(launcher_destination(&record, root.path(), "lnk", owned).is_err());
        assert_eq!(std::fs::read_to_string(&legacy).unwrap(), record.launch_id);
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "unrelated shortcut"
        );

        // A new title resolves the collision without exposing a generated ID.
        record.name = "Personal Notes".into();
        let migrated = launcher_destination(&record, root.path(), "lnk", |candidate| {
            std::fs::read_to_string(candidate).is_ok_and(|value| value == record.launch_id)
        })
        .unwrap();
        assert_eq!(migrated, root.path().join("Personal Notes.lnk"));
        assert!(!legacy.exists());
        assert_eq!(
            std::fs::read_to_string(&migrated).unwrap(),
            record.launch_id
        );
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "unrelated shortcut"
        );

        let other = fixture(root.path());
        assert!(launcher_destination(&other, root.path(), "lnk", |_| false).is_err());
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "unrelated shortcut"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_bundle_is_signed_cached_and_updates_without_changing_pinned_path() {
        let root = tempfile::tempdir().unwrap();
        let mut record = fixture(root.path());
        // The host is deliberately not a runnable binary. Export must only
        // copy the independently supplied shell and keep this bootstrap pointer.
        record.host_executable = root.path().join("full-host");
        std::fs::write(
            &record.host_executable,
            "full backend must never be exported",
        )
        .unwrap();
        let path = write_record(&record).unwrap();
        let dir = path.parent().unwrap();
        write_icons(dir, &record.app_id, None).unwrap();
        let applications = root.path().join("Applications");
        let bundle =
            install_macos(&record, dir, &applications, Path::new("/usr/bin/true")).unwrap();
        assert_eq!(bundle.file_name().unwrap(), "Notes & Files.app");
        assert!(create_command("/usr/bin/codesign")
            .args(["--verify", "--strict"])
            .arg(&bundle)
            .status()
            .unwrap()
            .success());
        assert!(bundle.join("Contents/Resources/icon-256.png").is_file());
        let before = std::fs::metadata(bundle.join("Contents/MacOS/MiniApp"))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(
            install_macos(&record, dir, &applications, Path::new("/usr/bin/true")).unwrap(),
            bundle
        );
        assert_eq!(
            std::fs::metadata(bundle.join("Contents/MacOS/MiniApp"))
                .unwrap()
                .modified()
                .unwrap(),
            before
        );
        // An existing numbered bundle is renamed without rebuilding its signed
        // contents or changing the launch identity used by instances and pins.
        let legacy = applications.join(format!("Notes & Files — {}.app", &record.launch_id[..8]));
        std::fs::rename(&bundle, &legacy).unwrap();
        assert_eq!(
            install_macos(&record, dir, &applications, Path::new("/usr/bin/true")).unwrap(),
            bundle
        );
        assert!(!legacy.exists());
        assert_eq!(
            std::fs::metadata(bundle.join("Contents/MacOS/MiniApp"))
                .unwrap()
                .modified()
                .unwrap(),
            before
        );
        assert_eq!(
            read_record(&bundle.join("Contents/Resources/openbitfun-miniapp.json"))
                .unwrap()
                .launch_id,
            record.launch_id
        );
        record.name = "Renamed App".into();
        assert_eq!(
            install_macos(&record, dir, &applications, Path::new("/usr/bin/true")).unwrap(),
            bundle
        );
        assert_eq!(
            read_record(&bundle.join("Contents/Resources/openbitfun-miniapp.json"))
                .unwrap()
                .name,
            "Renamed App"
        );
        assert!(std::fs::read_to_string(bundle.join("Contents/Info.plist"))
            .unwrap()
            .contains("Renamed App"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires a separately built lightweight MiniApp shell"]
    fn macos_real_shell_export_is_compact_and_runs_headless_diagnostics() {
        let shell = std::env::var_os("OPENBITFUN_MINIAPP_SHELL_TEST_BINARY")
            .map(PathBuf::from)
            .expect("set OPENBITFUN_MINIAPP_SHELL_TEST_BINARY to the optimized sidecar");
        let root = tempfile::tempdir().unwrap();
        let mut record = fixture(root.path());
        record.host_executable = root.path().join("full-host");
        let host = std::fs::File::create(&record.host_executable).unwrap();
        host.set_len(600 * 1024 * 1024).unwrap();
        let path = write_record(&record).unwrap();
        let dir = path.parent().unwrap();
        write_icons(dir, &record.app_id, None).unwrap();
        let bundle =
            install_macos(&record, dir, &root.path().join("Applications"), &shell).unwrap();
        let binary = bundle.join("Contents/MacOS/MiniApp");
        let bytes = std::fs::metadata(&binary).unwrap().len();
        // Budget leaves room for platform/toolchain growth while catching any
        // accidental return to copying the hundreds-of-MiB host.
        assert!(
            bytes < 16 * 1024 * 1024,
            "MiniApp shell exceeded the 16 MiB artifact budget: {bytes}"
        );
        assert!(create_command("/usr/bin/codesign")
            .args(["--verify", "--strict"])
            .arg(&bundle)
            .status()
            .unwrap()
            .success());
        let output = create_command(&binary)
            .arg("--miniapp-shell-info")
            .output()
            .unwrap();
        assert!(output.status.success());
        let info: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(info["role"], "miniapp-shell");
        assert_eq!(info["protocolVersion"], 1);
        assert_eq!(
            info["tauriDevMode"], false,
            "Tauri dev mode overrides the macOS bundle's Dock icon"
        );
        println!(
            "Exported MiniApp shell: {bytes} bytes ({:.2} MiB)",
            bytes as f64 / 1048576.0
        );
        fn total_bytes(path: &Path) -> u64 {
            std::fs::read_dir(path)
                .unwrap()
                .map(|entry| {
                    let entry = entry.unwrap();
                    if entry.file_type().unwrap().is_dir() {
                        total_bytes(&entry.path())
                    } else {
                        entry.metadata().unwrap().len()
                    }
                })
                .sum()
        }
        let total = total_bytes(&bundle);
        println!(
            "Complete exported .app: {total} bytes ({:.2} MiB)",
            total as f64 / 1048576.0
        );
    }

    #[test]
    fn linux_launcher_quotes_exec_arguments_and_desktop_entry_values_separately() {
        let arg = desktop_exec_arg(Path::new("/tmp/My App/$name%\".bin")).unwrap();
        assert_eq!(arg, "\"/tmp/My App/\\$name%%\\\".bin\"");
        assert_eq!(desktop_value(&arg), "\"/tmp/My App/\\\\$name%%\\\\\".bin\"");
        assert!(desktop_exec_arg(Path::new("/tmp/injected\nExec=other")).is_err());
    }

    #[test]
    fn icons_have_native_headers_and_watermark_is_owned_by_host() {
        let directory = tempfile::tempdir().unwrap();
        write_icons(directory.path(), "demo", None).unwrap();
        assert_eq!(
            &std::fs::read(directory.path().join("icon.ico")).unwrap()[..4],
            &[0, 0, 1, 0]
        );
        assert_eq!(
            &std::fs::read(directory.path().join("icon.icns")).unwrap()[..4],
            b"icns"
        );
        let a = icon_pixels("demo", None).unwrap();
        let b = icon_pixels("demo", Some("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\"><path d=\"M0 0H24V24H0Z\" fill=\"white\"/></svg>")).unwrap();
        assert_eq!(a.get_pixel(450, 450), b.get_pixel(450, 450));
        assert!(icon_pixels("demo", Some("<svg><image href=\"file:///secret\"/></svg>")).is_err());
    }

    #[test]
    fn macos_icon_migration_preserves_the_glyph_and_watermark_with_native_insets() {
        let root = tempfile::tempdir().unwrap();
        let record = fixture(root.path());
        let path = write_record(&record).unwrap();
        let dir = path.parent().unwrap();
        let glyph = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\"><path d=\"M0 0H24V24H0Z\" fill=\"white\"/></svg>";
        write_icons(dir, &record.app_id, Some(glyph)).unwrap();
        let shared = std::fs::read(dir.join("icon-512.png")).unwrap();
        let expected = std::fs::read(dir.join("icon.icns")).unwrap();
        let before = std::fs::metadata(dir.join("icon-512.png"))
            .unwrap()
            .modified()
            .unwrap();
        prepare_icons(&record, Some(glyph)).unwrap();
        assert_eq!(
            std::fs::metadata(dir.join("icon-512.png"))
                .unwrap()
                .modified()
                .unwrap(),
            before
        );
        // Pre-layout-version launchers have only their already-rendered PNGs.
        std::fs::remove_file(dir.join("icon-macos.json")).unwrap();
        std::fs::remove_file(dir.join("icon-source.json")).unwrap();
        std::fs::write(dir.join("icon.icns"), b"legacy").unwrap();
        prepare_icons(&record, None).unwrap();
        assert_eq!(std::fs::read(dir.join("icon-512.png")).unwrap(), shared);
        assert_eq!(std::fs::read(dir.join("icon.icns")).unwrap(), expected);

        // Decode every native representation rather than checking only a header.
        let mut chunks = &expected[8..];
        while !chunks.is_empty() {
            let length = u32::from_be_bytes(chunks[4..8].try_into().unwrap()) as usize;
            let frame = image::load_from_memory(&chunks[8..length])
                .unwrap()
                .to_rgba8();
            assert_eq!(frame.get_pixel(0, 0).0[3], 0);
            assert_eq!(
                frame.get_pixel(frame.width() / 2, frame.height() / 2).0[3],
                255
            );
            if &chunks[..4] == b"ic09" {
                assert_eq!(frame.dimensions(), (512, 512));
                for (x, y, pixel) in frame.enumerate_pixels() {
                    if x < 50 || x >= 462 || y < 50 || y >= 462 {
                        assert_eq!(pixel.0[3], 0);
                    }
                }
                assert_eq!(frame.get_pixel(50, 50).0[3], 0);
                assert_eq!(frame.get_pixel(256, 50).0[3], 255);
                assert_eq!(frame.get_pixel(256, 256), &Rgba([255, 255, 255, 255]));
                let fallback = macos_icon_pixels(&icon_pixels(&record.app_id, None).unwrap());
                assert_eq!(frame.get_pixel(412, 412), fallback.get_pixel(412, 412));
            }
            chunks = &chunks[length..];
        }
        let before = std::fs::metadata(dir.join("icon.icns"))
            .unwrap()
            .modified()
            .unwrap();
        prepare_icons(&record, None).unwrap();
        assert_eq!(
            std::fs::metadata(dir.join("icon.icns"))
                .unwrap()
                .modified()
                .unwrap(),
            before
        );
        prepare_icons(&record, Some(&glyph.replace("white", "red"))).unwrap();
        assert_ne!(std::fs::read(dir.join("icon-512.png")).unwrap(), shared);
    }
}
