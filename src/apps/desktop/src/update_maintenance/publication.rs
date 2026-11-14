use std::{fs, io, path::Path};

/// Retain the only backup if either publication or its rollback fails.
pub(super) fn replace_bundle(
    target: &Path,
    staged: &Path,
    stage: tempfile::TempDir,
) -> io::Result<()> {
    replace_bundle_with(target, staged, stage, |source, destination| {
        fs::rename(source, destination)
    })
}

fn replace_bundle_with(
    target: &Path,
    staged: &Path,
    stage: tempfile::TempDir,
    mut rename: impl FnMut(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    let backup = stage.path().join("previous.app");
    rename(target, &backup)?;
    if let Err(error) = rename(staged, target) {
        if let Err(recovery) = rename(&backup, target) {
            let retained = stage.keep();
            return Err(io::Error::other(format!(
                "App replacement failed: {error}; recovery failed: {recovery}; backup retained at {}",
                retained.display()
            )));
        }
        return Err(error);
    }
    if let Err(error) = stage.close() {
        log::warn!("Application updated; staging cleanup failed: {error}");
    }
    Ok(())
}

/// Validate before touching the installed image, including archived packages.
pub(super) fn stage_appimage(bytes: &[u8], output: &Path) -> io::Result<()> {
    use std::io::{Read, Write};
    let mut file = fs::File::create(output)?;
    if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
        let mut found = false;
        for entry in archive.entries()? {
            let mut entry = entry?;
            if entry
                .path()?
                .extension()
                .is_some_and(|extension| extension == "AppImage")
            {
                if found || !entry.header().entry_type().is_file() {
                    return Err(io::Error::other(
                        "Update archive has ambiguous AppImage entries",
                    ));
                }
                io::copy(&mut entry, &mut file)?;
                found = true;
            }
        }
        if !found {
            return Err(io::Error::other("Update archive contains no AppImage"));
        }
    } else {
        file.write_all(bytes)?;
    }
    file.sync_all()?;
    drop(file);
    let mut magic = [0_u8; 11];
    fs::File::open(output)?.read_exact(&mut magic)?;
    if !magic.starts_with(b"\x7fELF") || !matches!(&magic[8..], b"AI\x01" | b"AI\x02") {
        return Err(io::Error::other("Update package is not a valid AppImage"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_bundle_publication_restores_the_original() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("original.app");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("user.txt"), "old").unwrap();
        let stage = tempfile::tempdir_in(root.path()).unwrap();
        let missing = stage.path().join("missing.app");
        assert!(replace_bundle(&target, &missing, stage).is_err());
        assert_eq!(fs::read_to_string(target.join("user.txt")).unwrap(), "old");
    }

    #[test]
    fn invalid_appimage_never_changes_the_installed_file() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("installed.AppImage");
        fs::write(&target, "old").unwrap();
        assert!(stage_appimage(b"invalid", &root.path().join("new")).is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "old");
        let mut valid = b"\x7fELF\0\0\0\0AI\x02".to_vec();
        valid.extend_from_slice(b"fixture");
        stage_appimage(&valid, &root.path().join("new")).unwrap();
        assert_eq!(fs::read(root.path().join("new")).unwrap(), valid);
    }

    #[test]
    fn failed_rollback_preserves_the_only_recovery_copy() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("original.app");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("original.txt"), "old").unwrap();
        let stage = tempfile::tempdir_in(root.path()).unwrap();
        let retained = stage.path().to_owned();
        let staged = stage.path().join("new.app");
        fs::create_dir(&staged).unwrap();
        let mut calls = 0;
        let error = replace_bundle_with(&target, &staged, stage, |source, destination| {
            calls += 1;
            if calls > 1 {
                return Err(io::Error::other("Injected publication/restore failure"));
            }
            fs::rename(source, destination)
        })
        .unwrap_err();
        assert!(error.to_string().contains("backup retained"));
        assert_eq!(
            fs::read_to_string(retained.join("previous.app/original.txt")).unwrap(),
            "old"
        );
    }

    #[test]
    fn archived_appimages_reject_duplicate_candidates_before_publication() {
        let root = tempfile::tempdir().unwrap();
        let valid = b"\x7fELF\0\0\0\0AI\x02fixture";
        let archive = |names: &[&str]| {
            let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            let mut tar = tar::Builder::new(gzip);
            for name in names {
                let mut header = tar::Header::new_gnu();
                header.set_size(valid.len() as u64);
                header.set_mode(0o755);
                header.set_cksum();
                tar.append_data(&mut header, name, valid.as_slice())
                    .unwrap();
            }
            tar.into_inner().unwrap().finish().unwrap()
        };
        let output = root.path().join("new.AppImage");
        stage_appimage(&archive(&["nested/app.AppImage"]), &output).unwrap();
        assert_eq!(fs::read(&output).unwrap(), valid);
        assert!(stage_appimage(&archive(&["one.AppImage", "two.AppImage"]), &output).is_err());
    }
}
