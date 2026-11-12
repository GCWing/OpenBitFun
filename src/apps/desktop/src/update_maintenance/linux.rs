use openbitfun_services_core::process_manager::create_command;
use std::{fs, io, io::Write, path::Path, process::Stdio};
use tauri::{AppHandle, Manager};

pub(super) fn install(app: &AppHandle, bytes: &[u8], kind: &str) -> io::Result<()> {
    match kind {
        "deb" | "rpm" => install_package(bytes, kind),
        "appimage" => {
            let target = app
                .env()
                .appimage
                .ok_or_else(|| io::Error::other("AppImage path is unavailable"))?;
            install_appimage(bytes, Path::new(&target))
        }
        _ => Err(io::Error::other(
            "This Linux installation format requires a manual update",
        )),
    }
}

fn install_appimage(bytes: &[u8], target: &Path) -> io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::other("AppImage parent is unavailable"))?;
    let name = target
        .file_name()
        .ok_or_else(|| io::Error::other("AppImage name is unavailable"))?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(parent.join(format!(".{}.update.lock", name.to_string_lossy())))?;
    lock.try_lock()
        .map_err(|_| io::Error::other("Another application update is running"))?;
    let stage = tempfile::Builder::new()
        .prefix(".openbitfun-appimage-update-")
        .tempdir_in(parent)?;
    let new = stage.path().join("new.AppImage");
    super::publication::stage_appimage(bytes, &new)?;
    fs::set_permissions(&new, fs::metadata(target)?.permissions())?;
    fs::rename(new, target)?;
    if let Err(error) = stage.close() {
        log::warn!("Application updated; staging cleanup failed: {error}");
    }
    Ok(())
}

fn install_package(bytes: &[u8], kind: &str) -> io::Result<()> {
    if !(kind == "deb" && bytes.starts_with(b"!<arch>\n")
        || kind == "rpm" && bytes.starts_with(&[0xed, 0xab, 0xee, 0xdb]))
    {
        return Err(io::Error::other(
            "Update package does not match the installed package format",
        ));
    }
    let stage = tempfile::Builder::new()
        .prefix("openbitfun-package-update-")
        .tempdir()?;
    let package = stage.path().join(format!("package.{kind}"));
    fs::write(&package, bytes)?;
    let (program, argument) = if kind == "deb" {
        ("dpkg", "-i")
    } else {
        ("rpm", "-U")
    };
    match create_command("pkexec")
        .args([program, argument])
        .arg(&package)
        .output()
    {
        Ok(output) if output.status.success() => return Ok(()),
        // Cancellation/failure must not open a second authorization prompt.
        Ok(output) => {
            return Err(io::Error::other(format!(
                "Package authorization or installation failed: {}",
                String::from_utf8_lossy(&output.stderr)
            )))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let password = match create_command("zenity")
        .args(["--password", "--title=OpenBitFun update"])
        .output()
    {
        Ok(output) => output,
        Err(error) if error.kind() == io::ErrorKind::NotFound => create_command("kdialog")
            .args(["--password", "Authorize the OpenBitFun update"])
            .output()?,
        Err(error) => return Err(error),
    };
    if !password.status.success() {
        return Err(io::Error::other("Package authorization was canceled"));
    }
    let mut child = create_command("sudo")
        .args(["-S", "-p", "", "-k", program, argument])
        .arg(&package)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(mut input) = child.stdin.take() {
        input.write_all(&password.stdout)?;
        if !password.stdout.ends_with(b"\n") {
            input.write_all(b"\n")?;
        }
    }
    // wait_with_output drains both pipes while the package manager runs.
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "Package installation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(())
}
