//! Remote shell argument helpers.
//!
//! Keep these helpers internal to the SSH integration owner. The call sites use
//! different legacy bare-value policies, but they must share the same quoting
//! primitive to avoid command-escaping drift.

pub(crate) fn quote_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Keep traversal on the target host, without following a final directory link.
#[cfg(feature = "remote-ssh-concrete")]
pub(crate) fn remove_directory_command(path: &str) -> anyhow::Result<String> {
    // A trailing slash makes some tools follow a directory symlink. Preserve
    // every other byte, including whitespace and POSIX filename backslashes.
    let path = path.trim_end_matches('/');
    if !path.starts_with('/')
        || path.contains('\0')
        || matches!(path.rsplit('/').next(), Some("" | "." | ".."))
    {
        anyhow::bail!("Recursive deletion requires an absolute non-root directory path");
    }
    let script = format!(
        "target={}; \
         if [ -L \"$target\" ] || [ -d \"$target\" ]; then \
             exec rm -rf -- \"$target\"; \
         elif [ -e \"$target\" ]; then \
             printf 'Remote path is not a directory: %s\\n' \"$target\" >&2; \
         else \
             printf 'Remote directory does not exist or cannot be accessed: %s\\n' \"$target\" >&2; \
         fi; exit 1",
        quote_arg(path),
    );
    // The SSH login shell need not itself implement POSIX conditional syntax.
    Ok(format!("sh -c {}", quote_arg(&script)))
}

#[cfg(feature = "remote-ssh-concrete")]
pub(crate) fn escape_terminal_cwd(value: &str) -> String {
    if value
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, '/' | '.' | '-' | '_'))
    {
        value.to_string()
    } else {
        quote_arg(value)
    }
}

#[cfg(feature = "workspace-search")]
pub(crate) fn escape_command_arg(value: &str) -> String {
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '-' | '_' | ':' | '='))
    {
        value.to_string()
    } else {
        quote_arg(value)
    }
}

pub(crate) fn cd_and(workspace_root: &str, command: &str) -> String {
    format!("cd {} && {}", quote_arg(workspace_root), command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_arg_preserves_single_quote_escaping() {
        assert_eq!(
            quote_arg("/tmp/has space/it's"),
            "'/tmp/has space/it'\\''s'"
        );
    }

    #[test]
    #[cfg(feature = "remote-ssh-concrete")]
    fn escape_terminal_cwd_preserves_legacy_bare_path_policy() {
        assert_eq!(escape_terminal_cwd("/home/user/repo"), "/home/user/repo");
        assert_eq!(
            escape_terminal_cwd("/home/user/my repo"),
            "'/home/user/my repo'"
        );
    }

    #[test]
    #[cfg(feature = "workspace-search")]
    fn escape_command_arg_preserves_workspace_search_bare_policy() {
        assert_eq!(
            escape_command_arg("/home/user/repo:key=value"),
            "/home/user/repo:key=value"
        );
        assert_eq!(
            escape_command_arg("/home/user/my repo"),
            "'/home/user/my repo'"
        );
    }

    #[test]
    fn cd_and_preserves_workspace_runtime_wrapping() {
        assert_eq!(
            cd_and("/tmp/has space/it's", "pwd"),
            "cd '/tmp/has space/it'\\''s' && pwd"
        );
    }
}
