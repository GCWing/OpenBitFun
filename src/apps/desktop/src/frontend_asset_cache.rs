//! Build-output naming shared by the desktop frontend and embedded mobile web host.

use std::path::{Component, Path};

/// Vite emits build output as `assets/<name>-<hash>.<ext>` with an 8-character
/// content hash. Public files copied into `assets/<dir>/` keep their own names
/// and are not covered.
pub(crate) fn is_content_hashed_bundle_asset(relative: &Path) -> bool {
    const HASH_LEN: usize = 8;
    let mut components = relative.components();
    let (Some(Component::Normal(directory)), Some(Component::Normal(file)), None) =
        (components.next(), components.next(), components.next())
    else {
        return false;
    };
    if directory != "assets" {
        return false;
    }
    let Some((stem, extension)) = file.to_str().and_then(|file| file.rsplit_once('.')) else {
        return false;
    };
    let stem = stem.as_bytes();
    !extension.is_empty()
        && stem.len() > HASH_LEN
        && stem[stem.len() - HASH_LEN - 1] == b'-'
        && stem[stem.len() - HASH_LEN..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashed_bundle_asset_names_match_vite_output_only() {
        for name in [
            "assets/index-BSfB8JR0.js",
            "assets/macbook-air-hero--JR023m1.png",
            "assets/pdf.worker.min-wgc6bjNh.mjs",
            "assets/HarmonyOS_Sans_SC-BKicpBgU.ttf",
        ] {
            assert!(is_content_hashed_bundle_asset(Path::new(name)), "{name}");
        }
        for name in [
            "index.html",
            "assets/app.js",
            "assets/README.md",
            "assets/index-BSfB8JR0",
            "assets/appearance/openbitfun-default-preview@4x.png",
            "assets/appearance/preview-12345678.png",
            "monaco-editor/vs/loader-12345678.js",
            "openbitfun-creation.js",
        ] {
            assert!(!is_content_hashed_bundle_asset(Path::new(name)), "{name}");
        }
    }
}
