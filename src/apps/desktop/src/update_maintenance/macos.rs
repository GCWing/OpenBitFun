use openbitfun_services_core::process_manager::create_command;
use std::{fs, io, path::Path};

pub(super) fn install(bytes: &[u8]) -> io::Result<()> {
    let executable = std::env::current_exe()?;
    // The official public helper understands the Contents/MacOS bundle layout.
    let target = tauri_plugin_updater::extract_path_from_executable(&executable)
        .map_err(|error| io::Error::other(error.to_string()))?;
    if !target
        .extension()
        .is_some_and(|extension| extension == "app")
    {
        return Err(io::Error::other(
            "This macOS installation requires a manual update",
        ));
    }
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::other("Application parent is unavailable"))?;
    let (stage, authorize) = match tempfile::Builder::new()
        .prefix(".openbitfun-update-")
        .tempdir_in(parent)
    {
        Ok(stage) => (stage, false),
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            (tempfile::tempdir()?, true)
        }
        Err(error) => return Err(error),
    };
    let unpack = stage.path().join("unpack");
    fs::create_dir(&unpack)?;
    // tar validates traversal and symlink parents during unpack.
    tar::Archive::new(flate2::read::GzDecoder::new(bytes)).unpack(&unpack)?;
    let apps = fs::read_dir(&unpack)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<io::Result<Vec<_>>>()?
        .into_iter()
        .filter(|path| {
            path.extension().is_some_and(|extension| extension == "app")
                && fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir())
        })
        .collect::<Vec<_>>();
    if apps.len() != 1 {
        return Err(io::Error::other(
            "Update archive must contain one application bundle",
        ));
    }
    let new_app = &apps[0];
    let name = executable
        .file_name()
        .ok_or_else(|| io::Error::other("Application binary name is unavailable"))?;
    if !new_app.join("Contents/MacOS").join(name).is_file() {
        return Err(io::Error::other(
            "Update bundle is missing the application executable",
        ));
    }
    if !authorize {
        return super::publication::replace_bundle(&target, new_app, stage);
    }
    // osascript owns its main thread and the native authorization dialog. The
    // Desktop worker receives compile/dispatch/authorization failures normally.
    let shell = authorized_script(parent, new_app, &target);
    let apple = format!(
        "do shell script \"{}\" with administrator privileges",
        shell
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
    );
    let result = create_command("/usr/bin/osascript")
        .args(["-e", &apple])
        .output()?;
    if !result.status.success() {
        return Err(io::Error::other(format!(
            "Authorized application replacement failed: {}",
            String::from_utf8_lossy(&result.stderr)
        )));
    }
    Ok(())
}

fn authorized_script(parent: &Path, new_app: &Path, target: &Path) -> String {
    let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    format!(
        r#"set -eu
stage=$(/usr/bin/mktemp -d {parent}/.openbitfun-update.XXXXXXXX)
/usr/bin/ditto {new} "$stage/new.app"
/bin/mv {old} "$stage/previous.app"
if [ -e {old} ] || [ -L {old} ]; then
  echo "Recovery backup retained at $stage; destination changed" >&2; exit 2
fi
if /bin/mv "$stage/new.app" {old}; then
  if /bin/rm -rf "$stage/previous.app"; then /bin/rmdir "$stage" || true; fi
else
  if [ -e {old} ] || [ -L {old} ]; then
    echo "Recovery backup retained at $stage; destination changed" >&2; exit 2
  fi
  /bin/mv "$stage/previous.app" {old} || {{ echo "Recovery backup retained at $stage" >&2; exit 2; }}
  exit 1
fi"#,
        parent = quote(parent),
        new = quote(new_app),
        old = quote(target)
    )
}
