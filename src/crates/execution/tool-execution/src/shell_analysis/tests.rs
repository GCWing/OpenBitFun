use super::*;
#[test]
fn shell_analysis_distinguishes_descriptors_and_data() {
    let a = analyze(
        "printf x>/repo/a 2>&1; printf '%s' 'rm /repo/b > fake'",
        "bash",
        "/repo",
    );
    assert_eq!(a.file_operations.len(), 1);
    assert_eq!(a.file_operations[0].path, "/repo/a");
    assert_eq!(a.descriptor_operations.len(), 1);
    assert!(a.unresolved_effects.is_empty());
}
#[test]
fn shell_analysis_tracks_cd_failure_and_subshell_isolation() {
    let a = analyze(
        "(cd /scratch && printf x > child); cd /scratch; printf x > out",
        "bash",
        "/repo",
    );
    let paths = a
        .file_operations
        .iter()
        .map(|o| o.path.as_str())
        .collect::<Vec<_>>();
    assert_eq!(paths, vec!["/scratch/child", "/scratch/out", "/repo/out"]);
}
#[test]
fn shell_analysis_heredoc_consumers_and_multiple_documents() {
    let data = "cat <<'A' <<-'B' > /answer\n> /repo/decoy\nA\n\t$(rm /repo/decoy)\n\tB";
    let a = analyze(data, "bash", "/repo");
    assert_eq!(a.file_operations.len(), 1);
    assert!(a.unresolved_effects.is_empty());
    let a = analyze("bash <<'EOF'\nprintf x >/repo/a\nEOF", "bash", "/repo");
    assert_eq!(a.file_operations[0].path, "/repo/a");
    assert!(!analyze("cat <<EOF\n$(rm /repo/a)\nEOF", "bash", "/repo")
        .unresolved_effects
        .is_empty());
}
#[test]
fn shell_analysis_failures_are_explicit() {
    for s in ["echo '", "cat <<EOF\nbody", "echo >", "(echo", "echo &&"] {
        assert_ne!(
            analyze(s, "bash", "/repo").parse_status,
            AnalysisStatus::Supported,
            "{s}"
        );
    }
    assert_eq!(
        analyze("echo ok", "fish", "/repo").parse_status,
        AnalysisStatus::Unsupported
    );
    assert_eq!(
        analyze(&"x".repeat(MAX_COMMAND_BYTES + 1), "bash", "/repo").parse_status,
        AnalysisStatus::ResourceLimit
    );
}
#[test]
fn shell_analysis_quoting_changes_expansion_not_path_policy() {
    let a = analyze(
        "printf x > '/scratch/a*b'; printf x > '&1'",
        "bash",
        "/repo",
    );
    assert!(a.unresolved_effects.is_empty());
    assert_eq!(a.file_operations[1].path, "/repo/&1");
    assert!(!analyze("printf x > /scratch/a*", "bash", "/repo")
        .unresolved_effects
        .is_empty());
    assert!(!analyze("echo \"$(touch /repo/a)\"", "bash", "/repo")
        .unresolved_effects
        .is_empty());
}
fn normalize(path: &str) -> String {
    let mut parts = vec![];
    for p in path.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(p),
        }
    }
    format!("/{}", parts.join("/"))
}
#[test]
fn shell_analysis_acceptance_matrix() {
    let cases: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("fixtures/acceptance.json")).unwrap();
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    let mut failures = vec![];
    for c in cases {
        let id = c["id"].as_str().unwrap();
        let cmd = c["command"].as_str().unwrap();
        let ctx = &c["context_overrides"];
        let expected = &c["expected"];
        let a = analyze(
            cmd,
            ctx["shell_kind"].as_str().unwrap_or("bash"),
            ctx["workdir"].as_str().unwrap_or("/app"),
        );
        let paths = a
            .file_operations
            .iter()
            .map(|o| {
                let mut path = o.path.clone();
                if let Some(links) = ctx["filesystem_fixture"]["symlinks"].as_object() {
                    for (from, to) in links {
                        if path.starts_with(&format!("{from}/")) {
                            path = path.replacen(from, to.as_str().unwrap(), 1);
                        }
                    }
                }
                normalize(&path)
            })
            .collect::<Vec<_>>();
        let decision = if ctx["active_constraints"] == false {
            "no_guard_rejection"
        } else if a.parse_status != AnalysisStatus::Supported {
            "invalid_or_unresolved"
        } else if paths.iter().any(|p| p == "/app" || p.starts_with("/app/")) {
            "deny_protected"
        } else if !a.unresolved_effects.is_empty() {
            "deny_unresolved"
        } else {
            "no_guard_rejection"
        };
        *counts.entry(decision.into()).or_default() += 1;
        let decisions = expected["guard_decision"]
            .as_array()
            .cloned()
            .unwrap_or_else(|| vec![expected["guard_decision"].clone()]);
        if !decisions.iter().any(|v| v == decision) {
            failures.push(format!(
                "{id}: expected {decisions:?}, got {decision}: {a:?}"
            ));
        }
        for p in expected["required_resolved_file_targets"]
            .as_array()
            .unwrap()
        {
            if !paths.iter().any(|t| t == p.as_str().unwrap()) {
                failures.push(format!("{id}: missing {p}; {paths:?}"));
            }
        }
        for p in expected["forbidden_file_targets"].as_array().unwrap() {
            if paths.iter().any(|t| t == p.as_str().unwrap())
                || a.file_operations
                    .iter()
                    .any(|o| o.path == p.as_str().unwrap())
            {
                failures.push(format!("{id}: fabricated {p}"));
            }
        }
        for op in expected["required_descriptor_operations"]
            .as_array()
            .unwrap()
        {
            assert!(
                a.descriptor_operations
                    .iter()
                    .any(|o| o.operation == op.as_str().unwrap()),
                "{id}: missing descriptor {op}"
            );
        }
    }
    eprintln!("Acceptance decisions (85 original inputs): {counts:?}");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
#[test]
fn shell_analysis_actual_escaped_newline_and_single_escape() {
    let a = analyze("printf x 2>\\\n&1", "bash", "/app");
    assert!(a.file_operations.is_empty());
    assert_eq!(a.descriptor_operations[0].operation, "copy");
    let a = analyze("printf x\\> /app/file", "bash", "/app");
    assert!(a.file_operations.is_empty());
    assert!(a.unresolved_effects.is_empty());
}
#[test]
fn shell_analysis_resource_and_dialect_boundaries() {
    let text = format!(
        "cat <<'EOF' >/scratch/answer\n{}\nEOF",
        "中文 > 0; `rm decoy`\n".repeat(6000)
    );
    let a = analyze(&text, "bash", "/repo");
    assert_eq!(a.parse_status, AnalysisStatus::Supported);
    assert_eq!(a.file_operations.len(), 1);
    assert!(a.unresolved_effects.is_empty());
    for text in [
        format!("{}true{}", "(".repeat(40), ")".repeat(40)),
        vec!["true"; 100].join(" && "),
        "echo x;".repeat(MAX_NODES),
    ] {
        assert_eq!(
            analyze(&text, "bash", "/repo").parse_status,
            AnalysisStatus::ResourceLimit
        );
    }
    for shell in ["sh", "zsh", "bash"] {
        let a = analyze("printf x 2>&1; printf x>/scratch/out", shell, "/repo");
        assert!(a.unresolved_effects.is_empty());
        assert_eq!(a.file_operations[0].path, "/scratch/out");
    }
    assert_eq!(
        analyze("printf x 2> &1", "bash", "/repo").parse_status,
        AnalysisStatus::Invalid
    );
}
#[test]
fn shell_analysis_keeps_normal_build_and_read_commands_on_existing_policy() {
    for cmd in [
        "go version 2>&1",
        "go test ./...",
        "cargo test -p lib",
        "pytest -q tests",
        "npm test",
        "pnpm build",
        "make check",
        "git status --short",
        "git diff --stat",
        "ls -la",
        "rg -n 'foo > 0' src",
        "sed -n '1,20p' source",
        "psql -c 'SELECT 1 WHERE 2 > 1'",
        "go test ./... | tee /scratch/log",
    ] {
        let a = analyze(cmd, "bash", "/repo");
        assert_eq!(a.parse_status, AnalysisStatus::Supported, "{cmd}");
        assert!(a.unresolved_effects.is_empty(), "{cmd}: {a:?}");
    }
}
#[test]
fn shell_analysis_never_cancels_unknown_effect_with_known_log() {
    for cmd in [
        "env -S 'bash -c bad' >/scratch/log",
        "bash /scratch/script >/scratch/log",
        "python3 -c \"open('/scratch/a','w'); open(destination,'w')\"",
        "git reset --hard >/scratch/log",
        "find . -exec rm '{}' ';' >/scratch/log",
        "eval 'dynamic' >/scratch/log",
    ] {
        assert!(
            !analyze(cmd, "bash", "/repo").unresolved_effects.is_empty(),
            "{cmd}"
        );
    }
}
#[test]
fn shell_analysis_does_not_confuse_logical_cd_with_physical_parent() {
    for cmd in [
        "cd /scratch/link && cd .. && printf x > target",
        "cd /scratch/link/.. && printf x > target",
        "cd relative && printf x > target",
    ] {
        let a = analyze(cmd, "bash", "/repo");
        assert!(!a.unresolved_effects.is_empty(), "{cmd}");
    }
}
#[test]
fn absolute_windows_workdir_is_accepted_as_posix_cwd_is() {
    for workdir in [
        "C:\\Users\\huawei\\.bitfun\\loopx-workspaces\\4400fb652d5c99d56f31",
        "c:/users/test/worktree",
        "\\\\server\\share\\workspace",
        "/home/user/worktree",
    ] {
        let a = analyze("printf hi", "bash", workdir);
        assert_eq!(
            a.parse_status,
            AnalysisStatus::Supported,
            "workdir {workdir:?} was not accepted"
        );
        assert!(
            !a.unresolved_effects
                .iter()
                .any(|i| i.reason.contains("non-POSIX")),
            "workdir {workdir:?} tripped the non-POSIX rejection"
        );
    }
    // Relative workdirs remain unsupported: no host-local inference.
    let relative = analyze("printf hi", "bash", "relative/worktree");
    assert!(
        relative
            .unresolved_effects
            .iter()
            .any(|i| i.reason.contains("non-POSIX")),
        "relative workdir should stay unsupported"
    );
}
