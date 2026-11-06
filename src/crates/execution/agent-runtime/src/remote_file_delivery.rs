use openbitfun_runtime_ports::DialogTriggerSource;
use std::path::Path;

pub const TOOL_CONTEXT_REMOTE_FILE_DELIVERY_KEY: &str = "remote_file_delivery_channel";

/// The submitting desktop UI is on a peer device, not on the execution host.
/// Hosts stamp this per-turn metadata at the Peer HostInvoke boundary. It must
/// not be inferred from attached controllers, which may only observe a local
/// turn. Kept separate from mobile/bot file delivery semantics.
pub const TOOL_CONTEXT_PEER_DEVICE_CONTROL_KEY: &str = "peer_device_control";

pub fn needs_computer_links_for_source(source: DialogTriggerSource) -> bool {
    matches!(
        source,
        DialogTriggerSource::RemoteRelay | DialogTriggerSource::Bot
    )
}

pub fn remote_file_delivery_reminder() -> &'static str {
    r#"The user is messaging through a remote mobile or bot channel.

When referencing a plan, report, presentation, spreadsheet, document, image, or archive, add `computer://` before the file path so the user can click to download it, for example [report.md](computer://artifacts/report.md)."#
}

pub fn workspace_relative_link(path: &Path, workspace_root: Option<&Path>) -> Option<String> {
    workspace_root
        .and_then(|root| path.strip_prefix(root).ok())
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
}

pub fn computer_link(path: &Path, workspace_root: Option<&Path>) -> String {
    workspace_relative_link(path, workspace_root)
        .map(|rel| format!("computer://{rel}"))
        .unwrap_or_else(|| format!("computer://{}", path.to_string_lossy().replace('\\', "/")))
}

pub fn user_file_link(
    path: &Path,
    workspace_root: Option<&Path>,
    use_computer_link: bool,
) -> String {
    if use_computer_link {
        computer_link(path, workspace_root)
    } else {
        workspace_relative_link(path, workspace_root)
            .unwrap_or_else(|| path.to_string_lossy().replace('\\', "/"))
    }
}

pub fn user_workspace_relative_file_link(relative_path: &str, use_computer_link: bool) -> String {
    let normalized = relative_path.replace('\\', "/");
    if use_computer_link {
        format!("computer://{normalized}")
    } else {
        normalized
    }
}

#[cfg(test)]
mod tests {
    use super::{user_file_link, user_workspace_relative_file_link, workspace_relative_link};
    use std::path::Path;

    #[test]
    fn desktop_links_prefer_workspace_relative_paths() {
        let root = Path::new("/repo");
        let report = Path::new("/repo/artifacts/report.md");

        assert_eq!(
            workspace_relative_link(report, Some(root)).as_deref(),
            Some("artifacts/report.md")
        );
        assert_eq!(
            user_file_link(report, Some(root), false),
            "artifacts/report.md"
        );
    }

    #[test]
    fn remote_delivery_links_use_computer_scheme() {
        assert_eq!(
            user_workspace_relative_file_link(r".openbitfun\sessions\s1\research\report.md", true),
            "computer://.openbitfun/sessions/s1/research/report.md"
        );
    }
}
