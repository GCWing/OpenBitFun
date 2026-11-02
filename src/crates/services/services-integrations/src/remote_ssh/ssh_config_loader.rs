//! Merged `~/.ssh/config` loading with `Include` expansion, plus an
//! OpenSSH-style per-host resolver over the merged text.
//!
//! The `ssh_config` crate (0.1) parses a single file and has no `Include`
//! support, but ecosystem tooling (Coder's `config-ssh`, AtomGit, devenv) writes
//! Host blocks into separate files pulled in through `Include`. Hosts that only
//! exist behind an `Include` were therefore invisible to both the host list and
//! `get_ssh_config`. This loader inlines the include tree at each `Include`
//! position. OpenSSH evaluates an included file inside the parent's current
//! `Host`/`Match` context and restores that context afterwards, so the loader
//! re-emits the parent's active `Host`/`Match` line (or `Host *` at top level)
//! after every expansion.
//!
//! The crate is also unusable for value lookup: it tokenizes keys and values
//! pairwise (a multi-word `ProxyCommand` shifts every following key), matches
//! `Host` patterns only by string equality, and lets the last value win.
//! [`resolve_host_settings`] replaces it with a line-based resolver that keeps
//! whole-line values and applies OpenSSH's first-obtained-value-wins rule.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// OpenSSH processes nested `Include` directives recursively and caps the
/// depth at 16 (`READCONF_MAX_DEPTH`).
const MAX_INCLUDE_DEPTH: usize = 16;

/// Merge `config_path` with the files pulled in by its `Include` directives.
///
/// Returns `None` when the main file is missing or unreadable, mirroring the
/// previous single-file behavior. Individual includes that fail to expand are
/// skipped with a warning so one broken include cannot hide every other host.
pub(crate) fn load_merged_config(config_path: &Path) -> Option<String> {
    let mut stack = Vec::new();
    let mut merged = String::new();
    expand_file(
        config_path,
        0,
        config_path.parent(),
        &mut stack,
        &mut merged,
    );
    if merged.trim().is_empty() {
        None
    } else {
        Some(merged)
    }
}

/// Async wrapper: include expansion does blocking filesystem and glob IO, so
/// it runs on the blocking pool instead of a runtime worker.
pub(crate) async fn load_merged_config_async(config_path: PathBuf) -> Option<String> {
    match tokio::task::spawn_blocking(move || load_merged_config(&config_path)).await {
        Ok(merged) => merged,
        Err(error) => {
            log::warn!("SSH config loading task failed: {}", error);
            None
        }
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
    stack: &mut Vec<PathBuf>,
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
    // Cycle detection only looks at the current recursion stack: including the
    // same file again from a different Host block is legitimate and must apply
    // its settings in that block's context too.
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
    if stack.contains(&canonical) {
        log::warn!(
            "SSH config include cycle at {}; skipping the repeated file",
            path.display()
        );
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
    stack.push(canonical);

    // The `Host`/`Match` line currently in effect in *this* file; restored
    // after each include so the included file's own blocks do not swallow the
    // parent's following settings.
    let mut current_context: Option<String> = None;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            merged.push_str(line);
            merged.push('\n');
            continue;
        }
        if let Some((keyword, value)) = split_directive(trimmed) {
            if keyword.eq_ignore_ascii_case("include") {
                for target in resolve_include_targets(value, base_dir) {
                    expand_file(&target, depth + 1, base_dir, stack, merged);
                }
                merged.push_str(current_context.as_deref().unwrap_or("Host *"));
                merged.push('\n');
                continue;
            }
            if keyword.eq_ignore_ascii_case("host") || keyword.eq_ignore_ascii_case("match") {
                current_context = Some(trimmed.to_string());
            }
        }
        merged.push_str(line);
        merged.push('\n');
    }
    stack.pop();
}

/// Split one non-comment config line into keyword and value. OpenSSH accepts
/// `Key value`, `Key=value`, and `Key = value`.
pub(crate) fn split_directive(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    let keyword_end = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let keyword = &line[..keyword_end];
    if keyword.is_empty() {
        return None;
    }
    let rest = line[keyword_end..].trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest).trim();
    Some((keyword, rest))
}

/// Settings OpenSSH would apply to `host`, keyed by lowercase keyword.
///
/// Values are the raw remainder of the directive line (trimmed), so
/// multi-word values such as `ProxyCommand` survive intact; callers pick the
/// first token where a directive takes a single argument. The first value
/// obtained for a keyword wins, exactly like OpenSSH. Lines before the first
/// `Host`/`Match` apply to every host. `Match all` applies; any other `Match`
/// criteria cannot be evaluated here and are treated as not matching.
pub(crate) fn resolve_host_settings(content: &str, host: &str) -> HashMap<String, String> {
    let mut settings = HashMap::new();
    let mut active = true;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((keyword, value)) = split_directive(trimmed) else {
            continue;
        };
        if keyword.eq_ignore_ascii_case("host") {
            active = host_patterns_match(value, host);
            continue;
        }
        if keyword.eq_ignore_ascii_case("match") {
            active = value
                .split_whitespace()
                .next()
                .is_some_and(|criterion| criterion.eq_ignore_ascii_case("all"));
            continue;
        }
        if active && !value.is_empty() {
            settings
                .entry(keyword.to_ascii_lowercase())
                .or_insert_with(|| value.to_string());
        }
    }
    settings
}

/// OpenSSH `Host` matching: the line matches when any positive pattern
/// matches and no negated (`!`) pattern does. Patterns support `*` and `?`,
/// compared case-insensitively, and may be comma- or whitespace-separated.
pub(crate) fn host_patterns_match(patterns: &str, host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    let mut matched = false;
    for pattern in patterns
        .split(|c: char| c.is_whitespace() || c == ',')
        .map(|pattern| pattern.trim_matches('"'))
        .filter(|pattern| !pattern.is_empty())
    {
        let (negated, pattern) = match pattern.strip_prefix('!') {
            Some(rest) => (true, rest),
            None => (false, pattern),
        };
        if wildcard_match(&pattern.to_ascii_lowercase(), &host) {
            if negated {
                return false;
            }
            matched = true;
        }
    }
    matched
}

/// Whether a `Host` pattern token is a wildcard/negation rather than a
/// connectable alias.
pub(crate) fn is_host_pattern(token: &str) -> bool {
    token.starts_with('!') || token.contains(['*', '?'])
}

fn wildcard_match(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    let (mut p, mut t) = (0usize, 0usize);
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some((p, t));
            p += 1;
        } else if let Some((star_p, star_t)) = star {
            p = star_p + 1;
            t = star_t + 1;
            star = Some((star_p, star_t + 1));
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
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
        // The cycle is cut on the recursion stack: a -> b -> (a skipped).
        assert_eq!(merged.matches("Host a\n").count(), 1);
        assert_eq!(merged.matches("Host b\n").count(), 1);

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
    fn split_directive_accepts_keyword_forms() {
        assert_eq!(
            split_directive("Include coder.conf"),
            Some(("Include", "coder.conf"))
        );
        assert_eq!(
            split_directive("include=parts/*.conf"),
            Some(("include", "parts/*.conf"))
        );
        assert_eq!(
            split_directive("Include = parts/*.conf"),
            Some(("Include", "parts/*.conf"))
        );
        assert_eq!(
            split_directive("INCLUDE  \"path with spaces.conf\" "),
            Some(("INCLUDE", "\"path with spaces.conf\""))
        );
        assert_eq!(split_directive("Host=example"), Some(("Host", "example")));
        assert_eq!(split_directive("Lonely"), None);
    }

    #[test]
    fn include_forms_with_equals_are_expanded() {
        let dir = unique_temp_dir("equals");
        let ssh_dir = dir.join(".ssh");
        write(&ssh_dir.join("a.conf"), "Host from-a\n");
        write(&ssh_dir.join("b.conf"), "Host from-b\n");
        write(
            &ssh_dir.join("config"),
            "Include = a.conf\nInclude=b.conf\n",
        );

        let merged = load_merged_config(&ssh_dir.join("config")).unwrap();
        assert!(merged.contains("Host from-a"));
        assert!(merged.contains("Host from-b"));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn restores_the_parent_host_context_after_an_include() {
        let dir = unique_temp_dir("context");
        let ssh_dir = dir.join(".ssh");
        write(
            &ssh_dir.join("config"),
            "Host parent\n  Include inner.conf\n  User parent-user\n",
        );
        write(
            &ssh_dir.join("inner.conf"),
            "HostName parent.example\nHost inner\n  User inner-user\n",
        );

        let merged = load_merged_config(&ssh_dir.join("config")).unwrap();
        let parent = resolve_host_settings(&merged, "parent");
        assert_eq!(
            parent.get("hostname").map(String::as_str),
            Some("parent.example")
        );
        // Without context restoration `User parent-user` would land in `Host inner`.
        assert_eq!(parent.get("user").map(String::as_str), Some("parent-user"));
        let inner = resolve_host_settings(&merged, "inner");
        assert_eq!(inner.get("user").map(String::as_str), Some("inner-user"));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn top_level_include_restores_global_context() {
        let dir = unique_temp_dir("global-context");
        let ssh_dir = dir.join(".ssh");
        write(
            &ssh_dir.join("config"),
            "Include hosts.conf\nServerAliveInterval 30\n",
        );
        write(&ssh_dir.join("hosts.conf"), "Host only-one\n  User one\n");

        let merged = load_merged_config(&ssh_dir.join("config")).unwrap();
        let other = resolve_host_settings(&merged, "anything");
        assert_eq!(
            other.get("serveraliveinterval").map(String::as_str),
            Some("30")
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn same_file_may_be_included_from_different_blocks() {
        let dir = unique_temp_dir("reinclude");
        let ssh_dir = dir.join(".ssh");
        write(&ssh_dir.join("common.conf"), "User shared\n");
        write(
            &ssh_dir.join("config"),
            "Host one\n  Include common.conf\nHost two\n  Include common.conf\n",
        );

        let merged = load_merged_config(&ssh_dir.join("config")).unwrap();
        for host in ["one", "two"] {
            let settings = resolve_host_settings(&merged, host);
            assert_eq!(settings.get("user").map(String::as_str), Some("shared"));
        }

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn resolver_keeps_whole_line_values_and_first_value_wins() {
        let content = "Host coder.*\n  ProxyCommand /usr/bin/coder --global-config \"/x y\" ssh --stdio --ssh-host-prefix coder. %h\n  User coder\n  StrictHostKeyChecking no\nHost *\n  User fallback\n  ProxyCommand other %h\n";
        let settings = resolve_host_settings(content, "coder.workspace");
        assert_eq!(
            settings.get("proxycommand").map(String::as_str),
            Some("/usr/bin/coder --global-config \"/x y\" ssh --stdio --ssh-host-prefix coder. %h")
        );
        assert_eq!(settings.get("user").map(String::as_str), Some("coder"));
        assert_eq!(
            settings.get("stricthostkeychecking").map(String::as_str),
            Some("no")
        );
        let fallback = resolve_host_settings(content, "plain");
        assert_eq!(fallback.get("user").map(String::as_str), Some("fallback"));
    }

    #[test]
    fn host_patterns_support_wildcards_and_negation() {
        assert!(host_patterns_match("*.example.com", "a.example.com"));
        assert!(host_patterns_match("A?C", "abc"));
        assert!(!host_patterns_match("*.example.com", "example.org"));
        assert!(host_patterns_match("* !bastion", "web"));
        assert!(!host_patterns_match("* !bastion", "bastion"));
        assert!(host_patterns_match("one,two", "two"));
        assert!(!host_patterns_match("!only", "other"));
        assert!(is_host_pattern("*"));
        assert!(is_host_pattern("!x"));
        assert!(!is_host_pattern("coder.ws"));
    }

    #[test]
    fn match_all_applies_and_other_match_blocks_do_not() {
        let content = "Match host foo\n  User from-match\nMatch all\n  Port 2200\n";
        let settings = resolve_host_settings(content, "foo");
        assert_eq!(settings.get("user"), None);
        assert_eq!(settings.get("port").map(String::as_str), Some("2200"));
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
