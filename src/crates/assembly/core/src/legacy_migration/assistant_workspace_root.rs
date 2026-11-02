//! Pre-rename personal-assistant root for records the data migrator left behind.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// `~/.bitfun/personal_assistant/`.
///
/// `BITFUN_HOME` / `BITFUN_E2E_HOME` replace the `.bitfun` data root itself,
/// with the precedence of `MigrationRoots` in `openbitfun-legacy-migration`, so
/// both sides resolve one root. That crate stays an offline dependency, which
/// is why the resolution is repeated here. Returns `None` when no user home
/// directory is available.
pub(crate) fn legacy_assistant_workspace_root() -> Option<PathBuf> {
    resolve_root(
        std::env::var_os("BITFUN_HOME"),
        std::env::var_os("BITFUN_E2E_HOME"),
        dirs::home_dir().as_deref(),
    )
}

fn resolve_root(
    bitfun_home: Option<OsString>,
    bitfun_e2e_home: Option<OsString>,
    user_home: Option<&Path>,
) -> Option<PathBuf> {
    let non_empty =
        |value: Option<OsString>| value.filter(|path| !path.is_empty()).map(PathBuf::from);
    let legacy_home_root = non_empty(bitfun_home)
        .or_else(|| non_empty(bitfun_e2e_home))
        .or_else(|| user_home.map(|home| home.join(".bitfun")))?;
    Some(legacy_home_root.join("personal_assistant"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_follows_the_migrator_data_root_precedence() {
        let home = Path::new("/home/dev");
        let explicit = OsString::from("/custom/legacy");
        let e2e = OsString::from("/e2e/legacy");

        assert_eq!(
            resolve_root(Some(explicit), Some(e2e.clone()), Some(home)),
            Some(PathBuf::from("/custom/legacy/personal_assistant"))
        );
        assert_eq!(
            resolve_root(Some(OsString::new()), Some(e2e), Some(home)),
            Some(PathBuf::from("/e2e/legacy/personal_assistant"))
        );
        assert_eq!(
            resolve_root(None, None, Some(home)),
            Some(PathBuf::from("/home/dev/.bitfun/personal_assistant"))
        );
        assert_eq!(resolve_root(None, None, None), None);
    }
}
