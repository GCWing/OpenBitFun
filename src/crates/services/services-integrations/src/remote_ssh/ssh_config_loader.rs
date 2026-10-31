//! Merged `~/.ssh/config` loading with `Include` expansion.
//!
//! The `ssh_config` crate (0.1) parses a single file and has no `Include`
//! support, but ecosystem tooling (Coder's `config-ssh`, AtomGit, devenv) writes
//! Host blocks into separate files pulled in through `Include`. Hosts that only
//! exist behind an `Include` were therefore invisible to both the host list and
//! `get_ssh_config`. This loader merges the main file with its include tree
//! in place, preserving OpenSSH's order semantics (first occurrence of a
//! setting wins).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// OpenSSH processes nested `Include` directives recursively. The cap only
/// exists to turn accidental self-reference into a bounded warning instead of a
/// hang; real-world configs stay a handful of levels deep.
const MAX_INCLUDE_DEPTH: usize = 8;

/// Merge `config_path` with the files pulled in by its `Include` directives.
///
/// Returns `None` when the main file is missing or unreadable, mirroring the
/// previous single-file behavior. Individual includes that fail to expand are
/// skipped with a warning so one broken include cannot hide every other host.
pub(crate) fn load_merged_config(config_path: &Path) -> Option<String> {
    let mut visited = HashSet::new();
    let mut merged = String::new();
    expand_file(
        config_path,
        0,
        config_path.parent(),
        &mut visited,
        &mut merged,
    );
    if merged.trim().is_empty() {
        None
    } else {
        Some(merged)
    }
}

/// Strip a leading UTF-8 BOM if present. Windows editors (and some SSH tooling)
/// still write one.
pub(crate) fn strip_utf8_bom(content: String) -> String {
    content
        .strip_prefix('\u{feff}')
        .unwrap_or(&content)
        .to_string()
}

fn expand_file(
    path: &Path,
    depth: usize,
    base_dir: Option<&Path>,
    visited: &mut HashSet<PathBuf>,
    merged: &mut String,
) {
    if depth > MAX_INCLUDE_DEPTH {
        log::warn!(
            "SSH config include chain deeper than {} levels at {}; skipping the rest",
            MAX_INCLUDE_DEPTH,
            path.display()
        );
        return;
    }
    // Deduplicate on the canonical path so symlink or `..` cycles, plus plain
    // repeated includes, cannot loop forever. Skipping a repeat is harmless:
    // first-occurrence-wins parsing keeps the first copy authoritative anyway.
    let canonical = match path.canonicalize() {
        Ok(canonical) => canonical,
        Err(error) => {
            if depth == 0 {
                log::debug!("SSH config not readable at {}: {}", path.display(), error);
            } else {
                log::warn!(
                    "SSH config include not readable at {}: {}",
                    path.display(),
                    error
                );
            }
            return;
        }
    };
    if !visited.insert(canonical) {
        return;
    }
    let content = match std::fs::read_to_string(path) {
        Ok(content) => strip_utf8_bom(content),
        Err(error) => {
            log::warn!(
                "SSH config include not readable at {}: {}",
                path.display(),
                error
            );
            return;
        }
    };

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            merged.push_str(line);
            merged.push('\n');
            continue;
        }
        match include_value(trimmed) {
            Some(value) => {
                for target in resolve_include_targets(value, base_dir) {
                    expand_file(&target, depth + 1, base_dir, visited, merged);
                }
            }
            None => {
                merged.push_str(line);
                merged.push('\n');
            }
        }
    }
}

/// Extract the value part of an `Include` directive, or `None` for any other
/// line. Accepts both `Include value` and `Include=value`; ssh_config keywords
/// are case-insensitive.
fn include_value(line: &str) -> Option<&str> {
    let (keyword, value) = match line.split_once(char::is_whitespace) {
        Some((keyword, value)) => (keyword, value),
        None => line.split_once('=')?,
    };
    if keyword.eq_ignore_ascii_case("include") {
        Some(value.trim())
    } else {
        None
    }
}

/// Resolve one `Include` value into concrete file paths, in order.
///
/// Tokens may be double-quoted, may start with `~`, and may contain glob
/// patterns. Relative paths resolve against the user config directory
/// (`~/.ssh`), matching OpenSSH. Glob matches are yielded in sorted order by
/// the `glob` crate, which keeps merged output deterministic.
fn resolve_include_targets(value: &str, base_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut targets = Vec::new();
    for token in split_quoted_tokens(value) {
        let expanded = shellexpand::tilde(&token).into_owned();
        let candidate = PathBuf::from(&expanded);
        let absolute = match base_dir {
            Some(base_dir) if candidate.is_relative() => base_dir.join(candidate),
            _ => candidate,
        };
        // The glob crate wants forward slashes even on Windows.
        let pattern = absolute.to_string_lossy().replace('\\', "/");
        if !pattern.contains(['*', '?', '[']) {
            targets.push(absolute);
            continue;
        }
        match glob::glob(&pattern) {
            Ok(paths) => targets.extend(paths.filter_map(Result::ok)),
            Err(error) => log::warn!(
                "SSH config include pattern '{}' is invalid: {}",
                token,
                error
            ),
        }
    }
    targets
}

/// Split on whitespace, keeping double-quoted spans (quote characters
/// themselves are dropped) as single tokens.
fn split_quoted_tokens(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut has_token = false;
    for ch in value.chars() {
        match ch {
            '"' => {
                in_quotes = !in_quotes;
                has_token = true;
            }
            c if c.is_whitespace() && !in_quotes => {
                if has_token {
                    tokens.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            c => {
                current.push(c);
                has_token = true;
            }
        }
    }
    if has_token {
        tokens.push(current);
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn unique_temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "openbitfun-ssh-config-loader-{label}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    #[test]
    fn merges_included_files_at_the_include_position() {
        let dir = unique_temp_dir("position");
        let ssh_dir = dir.join(".ssh");
        write(
            &ssh_dir.join("config"),
            "Host main-only\n  HostName main.example\n\nInclude coder.conf\n\nHost after-include\n  HostName tail.example\n",
        );
        write(
            &ssh_dir.join("coder.conf"),
            "Host coder-workspace\n  ProxyCommand coder ssh --stdio %h\n",
        );

        let merged = load_merged_config(&ssh_dir.join("config")).unwrap();
        let main_pos = merged.find("Host main-only").unwrap();
        let coder_pos = merged.find("Host coder-workspace").unwrap();
        let tail_pos = merged.find("Host after-include").unwrap();
        assert!(main_pos < coder_pos && coder_pos < tail_pos);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn resolves_relative_includes_against_the_ssh_directory() {
        let dir = unique_temp_dir("relative");
        let ssh_dir = dir.join(".ssh");
        write(
            &ssh_dir.join("config"),
            "Include extra/host.conf\nHost base\n  HostName base.example\n",
        );
        write(
            &ssh_dir.join("extra").join("host.conf"),
            "Host nested\n  HostName nested.example\n",
        );

        let merged = load_merged_config(&ssh_dir.join("config")).unwrap();
        assert!(merged.contains("Host nested"));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn expands_globs_in_sorted_order() {
        let dir = unique_temp_dir("glob");
        let ssh_dir = dir.join(".ssh");
        write(&ssh_dir.join("config"), "Include parts/*.conf\n");
        write(&ssh_dir.join("parts").join("b.conf"), "Host from-b\n");
        write(&ssh_dir.join("parts").join("a.conf"), "Host from-a\n");

        let merged = load_merged_config(&ssh_dir.join("config")).unwrap();
        let a_pos = merged.find("Host from-a").unwrap();
        let b_pos = merged.find("Host from-b").unwrap();
        assert!(a_pos < b_pos, "glob matches must be merged in sorted order");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn keeps_parsing_when_an_include_is_missing_or_loops() {
        let dir = unique_temp_dir("cycle");
        let ssh_dir = dir.join(".ssh");
        write(
            &ssh_dir.join("config"),
            "Include missing.conf\nInclude cycle-a.conf\nHost base\n  HostName base.example\n",
        );
        write(
            &ssh_dir.join("cycle-a.conf"),
            "Include cycle-b.conf\nHost a\n",
        );
        write(
            &ssh_dir.join("cycle-b.conf"),
            "Include cycle-a.conf\nHost b\n",
        );

        let merged = load_merged_config(&ssh_dir.join("config")).unwrap();
        assert!(merged.contains("Host a"));
        assert!(merged.contains("Host b"));
        assert_eq!(merged.matches("Host a").count(), 1);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn returns_none_when_the_main_config_is_missing() {
        let dir = unique_temp_dir("missing-main");
        assert!(load_merged_config(&dir.join(".ssh").join("config")).is_none());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn strips_utf8_bom_from_the_main_config() {
        let dir = unique_temp_dir("bom");
        let ssh_dir = dir.join(".ssh");
        write(&ssh_dir.join("config"), "\u{feff}Host bom-host\n");

        let merged = load_merged_config(&ssh_dir.join("config")).unwrap();
        assert!(merged.starts_with("Host bom-host"));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn include_value_accepts_keyword_forms_case_insensitively() {
        assert_eq!(include_value("Include coder.conf"), Some("coder.conf"));
        assert_eq!(include_value("include=parts/*.conf"), Some("parts/*.conf"));
        assert_eq!(
            include_value("INCLUDE  \"path with spaces.conf\" "),
            Some("\"path with spaces.conf\"")
        );
        assert_eq!(include_value("HostName example"), None);
        assert_eq!(include_value("Host=example"), None);
    }

    #[test]
    fn quoted_include_tokens_stay_whole() {
        let dir = unique_temp_dir("quoted");
        let ssh_dir = dir.join(".ssh");
        write(&ssh_dir.join("my hosts.conf"), "Host quoted\n");
        write(
            &ssh_dir.join("config"),
            "Include \"my hosts.conf\"\nHost base\n",
        );

        let merged = load_merged_config(&ssh_dir.join("config")).unwrap();
        assert!(merged.contains("Host quoted"));

        fs::remove_dir_all(&dir).unwrap();
    }
}
