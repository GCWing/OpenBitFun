use std::path::PathBuf;

use super::{
    path, shell_display_name, DetectedShell, ShellCandidate, ShellDetector, ShellDiscoverySource,
};
use crate::shell::ShellType;

#[test]
fn configured_shell_preference_accepts_path_and_aliases() {
    assert_eq!(
        ShellDetector::shell_type_from_preference(r"C:\Tools\pwsh.exe"),
        Some(ShellType::PowerShellCore)
    );
    assert_eq!(
        ShellDetector::shell_type_from_preference("WindowsPowerShell"),
        Some(ShellType::PowerShell)
    );
    assert_eq!(
        ShellDetector::shell_type_from_preference("PWSH.EXE"),
        Some(ShellType::PowerShellCore)
    );
    assert_eq!(ShellDetector::shell_type_from_preference(""), None);
    assert_eq!(ShellDetector::shell_type_from_preference("unknown"), None);
}

#[test]
fn candidate_identity_deduplicates_equivalent_paths_per_shell_type() {
    let path = std::env::current_exe().expect("current test executable");
    let pwsh = ShellCandidate::new(
        path.clone(),
        ShellType::PowerShellCore,
        ShellDiscoverySource::Path,
    );
    let powershell = ShellCandidate::new(
        path,
        ShellType::PowerShell,
        ShellDiscoverySource::SystemInstall,
    );
    assert_ne!(
        path::candidate_identity(&pwsh),
        path::candidate_identity(&powershell)
    );
}

#[test]
fn path_entries_trim_quotes_and_ignore_empty_entries() {
    let separator = if cfg!(windows) { ';' } else { ':' };
    let value = format!("\"first path\"{separator}{separator}second");
    assert_eq!(
        path::split_path_entries(&value),
        vec![PathBuf::from("first path"), PathBuf::from("second")]
    );
}

#[test]
fn powershell_display_name_uses_verified_major_version() {
    assert_eq!(
        shell_display_name(&ShellType::PowerShellCore, Some("7.6.0")),
        "PowerShell 7"
    );
    assert_eq!(
        shell_display_name(&ShellType::PowerShellCore, Some("8.0.0-preview.1")),
        "PowerShell 8"
    );
}

#[test]
fn configured_explicit_path_is_preserved_as_the_selection_source() {
    let path = std::env::current_exe().expect("current test executable");
    let shell = ShellDetector::resolve_explicit_shell(path.to_string_lossy().as_ref())
        .expect("current executable should resolve as a custom shell");
    assert_eq!(shell.path, path);
    assert_eq!(shell.discovery_source, ShellDiscoverySource::ExplicitConfig);
}

#[test]
fn detected_shell_id_is_stable_for_the_same_path() {
    let path = std::env::current_exe().expect("current test executable");
    let first = DetectedShell::new(
        ShellType::Custom("test-shell".to_string()),
        path.clone(),
        None,
        ShellDiscoverySource::ExplicitConfig,
    );
    let second = DetectedShell::new(
        ShellType::Custom("test-shell".to_string()),
        path,
        None,
        ShellDiscoverySource::Path,
    );
    assert_eq!(first.id, second.id);
}

#[test]
fn cached_validation_keeps_the_current_discovery_source() {
    let path = std::env::current_exe().expect("current test executable");
    let shell_type = ShellType::Custom("cached-source-test".to_string());
    let from_path = ShellDetector::validate_candidate(ShellCandidate::new(
        path.clone(),
        shell_type.clone(),
        ShellDiscoverySource::Path,
    ))
    .expect("candidate discovered from PATH");
    let from_system = ShellDetector::validate_candidate(ShellCandidate::new(
        path,
        shell_type,
        ShellDiscoverySource::SystemInstall,
    ))
    .expect("candidate discovered from system install");

    assert_eq!(from_path.discovery_source, ShellDiscoverySource::Path);
    assert_eq!(
        from_system.discovery_source,
        ShellDiscoverySource::SystemInstall
    );
    assert_eq!(from_path.id, from_system.id);
}

#[test]
fn powershell_core_candidate_remains_available_when_version_probe_fails() {
    let executable = std::env::current_exe().expect("current test executable");
    let shell = ShellDetector::validate_candidate(ShellCandidate::new(
        executable.clone(),
        ShellType::PowerShellCore,
        ShellDiscoverySource::Path,
    ))
    .expect("a discovered executable remains available if its version probe fails");

    assert_eq!(shell.path, executable);
    assert_eq!(shell.version, None);
}

#[cfg(unix)]
#[test]
fn approval_time_shell_resolution_never_runs_a_version_probe() {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempfile::tempdir().expect("temporary directory");
    let executable = directory.path().join("bash");
    let marker = directory.path().join("probe-ran");
    std::fs::write(
        &executable,
        format!("#!/bin/sh\nprintf probed > '{}'\n", marker.display()),
    )
    .expect("write fake shell");
    let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&executable, permissions).unwrap();

    let resolved = ShellDetector::resolve_configured_shell_without_probe(
        executable.to_string_lossy().as_ref(),
    )
    .expect("regular configured shell should resolve without probing");

    assert_eq!(resolved.path, executable);
    assert_eq!(resolved.version, None);
    assert!(!marker.exists());
}

#[test]
fn normalized_identity_uses_canonical_path_when_available() {
    assert!(!path::normalized_path_identity(
        &std::env::current_exe().expect("current test executable")
    )
    .is_empty());
}

#[test]
fn approval_time_shell_resolution_rejects_relative_paths_with_directories() {
    let relative = if cfg!(windows) {
        r".\repo-shell.exe"
    } else {
        "./repo-shell"
    };
    assert!(ShellDetector::resolve_configured_shell_without_probe(relative).is_none());
}

#[cfg(windows)]
#[test]
fn windows_known_pwsh_locations_cover_user_package_and_both_program_files_views() {
    let candidates = super::platform::windows_pwsh_location_candidates(
        Some(PathBuf::from(r"C:\Users\Ada\AppData\Local")),
        Some(PathBuf::from(r"C:\Users\Ada")),
        Some(PathBuf::from(r"C:\Program Files")),
        Some(PathBuf::from(r"C:\Program Files")),
        Some(PathBuf::from(r"C:\Program Files (x86)")),
    );
    assert_eq!(
        candidates[0].source,
        ShellDiscoverySource::WindowsAppExecutionAlias
    );
    assert_eq!(candidates[1].source, ShellDiscoverySource::UserInstall);
    assert_eq!(candidates[2].source, ShellDiscoverySource::PackageManager);
    assert_eq!(candidates[3].source, ShellDiscoverySource::SystemInstall);
    assert!(candidates.iter().any(|candidate| candidate.path
        == PathBuf::from(r"C:\Program Files (x86)\PowerShell\7\pwsh.exe")));
}

#[cfg(windows)]
#[test]
fn windows_path_lookup_respects_pathext() {
    assert!(path::executable_names("pwsh")
        .iter()
        .any(|name| name.eq_ignore_ascii_case("pwsh.exe")));
    assert_eq!(path::executable_names("pwsh.exe"), ["pwsh.exe"]);
}

#[cfg(not(windows))]
#[test]
fn posix_path_lookup_uses_the_unmodified_executable_name() {
    assert_eq!(path::executable_names("pwsh"), vec!["pwsh"]);
}
