//! Optional byte-literal candidate filtering. Rust still owns Grep semantics.

use crate::util::string::shell_single_quote;

/// These bound one transport request, never the number of files searched.
pub(super) const MAX_GREP_BATCH_PATHS: usize = 128;
pub(super) const MAX_GREP_BATCH_COMMAND_BYTES: usize = 16_384;

const BATCH_END: &str = "\nOPENBITFUN_GREP_BATCH_END\n";

/// Accept only literal branches whose union is a conservative byte prefilter.
/// Escapes, inline flags and all other regex syntax stay with the Rust scanner.
/// Ordinary Unicode literals are UTF-8 bytes; BOM-encoded files are retained
/// separately because the Rust searcher can transcode them before matching.
pub(super) fn literal_alternatives(pattern: &str, case_insensitive: bool) -> Option<Vec<&str>> {
    if case_insensitive {
        return None;
    }
    let alternatives: Vec<_> = pattern.split('|').collect();
    alternatives
        .iter()
        .all(|literal| {
            !literal.is_empty()
                && !literal.chars().any(|character| {
                    character.is_control()
                        || matches!(
                            character,
                            '.' | '^'
                                | '$'
                                | '['
                                | ']'
                                | '('
                                | ')'
                                | '{'
                                | '}'
                                | '*'
                                | '+'
                                | '?'
                                | '\\'
                        )
                })
        })
        .then_some(alternatives)
}

/// Fixed string that every match of an interactive content search must contain.
///
/// A case-sensitive literal is used whole. Under case folding only characters whose
/// every fold is a plain ASCII pair may cross the shell boundary: `LC_ALL=C grep -i`
/// compares other bytes exactly, and `k`/`s` also fold to non-ASCII U+212A/U+017F in
/// the native matcher. Those characters split the literal, and any match must still
/// contain the remaining runs, so selecting on the longest run cannot lose a match.
pub fn content_search_candidate_literal(
    pattern: &str,
    case_sensitive: bool,
    use_regex: bool,
) -> Option<String> {
    if use_regex || pattern.is_empty() || pattern.chars().any(char::is_control) {
        return None;
    }
    if case_sensitive {
        return Some(pattern.to_string());
    }
    pattern
        .split(|character: char| {
            matches!(character.to_ascii_lowercase(), 'k' | 's')
                || (!character.is_ascii()
                    && (character.to_lowercase().next() != Some(character)
                        || character.to_uppercase().next() != Some(character)))
        })
        .max_by_key(|run| run.len())
        .filter(|run| !run.is_empty())
        .map(str::to_string)
}

/// Probe behavior, not a vendor/version string. POSIX does not specify binary
/// grep behavior, so -a, NUL handling and non-UTF-8 BOM patterns need evidence.
/// Only the intentionally invalid probe operand suppresses expected stderr.
pub(super) fn grep_probe_command() -> &'static str {
    r#"command -v grep >/dev/null 2>&1 || exit 127
openbitfun_search_bom_le=$(printf '\377\376') || exit 127
openbitfun_search_bom_be=$(printf '\376\377') || exit 127
if ! printf 'prefix\000ignored\nliteral.marker\n' | LC_ALL=C GREP_OPTIONS= command grep -a -F -q -e 'not-present' -e 'literal.marker' -- >/dev/null; then
    exit 127
fi
if printf 'literalXmarker\n' | LC_ALL=C GREP_OPTIONS= command grep -a -F -q -e 'not-present' -e 'literal.marker' -- >/dev/null; then
    exit 127
else
    openbitfun_search_status=$?
    [ "$openbitfun_search_status" -eq 1 ] || exit 127
fi
if ! printf '\377\376\000\n' | LC_ALL=C GREP_OPTIONS= command grep -a -F -q -e 'not-present' -e "$openbitfun_search_bom_le" -e "$openbitfun_search_bom_be" -- >/dev/null; then
    exit 127
fi
if ! printf '\376\377\000\n' | LC_ALL=C GREP_OPTIONS= command grep -a -F -q -e 'not-present' -e "$openbitfun_search_bom_le" -e "$openbitfun_search_bom_be" -- >/dev/null; then
    exit 127
fi
if LC_ALL=C GREP_OPTIONS= command grep -a -F -q -e 'not-present' -- /dev/null/openbitfun-grep-probe >/dev/null 2>&1; then
    exit 127
else
    openbitfun_search_status=$?
    [ "$openbitfun_search_status" -gt 1 ] || exit 127
fi
exit 0"#
}

/// Caller supplies authorized regular-file paths after shared traversal and
/// filtering. One shell invocation amortizes transport latency; each file still
/// uses its own grep process so status and filename framing remain unambiguous.
pub(super) fn grep_batch_command(literals: &[&str], paths: &[String]) -> String {
    let mut command = String::from(
        r#"openbitfun_search_bom_le=$(printf '\377\376') || exit 2
openbitfun_search_bom_be=$(printf '\376\377') || exit 2
set --"#,
    );
    for path in paths {
        command.push(' ');
        command.push_str(&shell_single_quote(path));
    }
    command.push_str(
        "\nfor openbitfun_search_path do\n    if LC_ALL=C GREP_OPTIONS= command grep -a -F -q",
    );
    for literal in literals {
        command.push_str(" -e ");
        command.push_str(&shell_single_quote(literal));
    }
    // A BOM anywhere conservatively retains the file. This can over-select a
    // binary file but cannot lose a match created by UTF-16 BOM transcoding.
    command.push_str(
        r#" -e "$openbitfun_search_bom_le" -e "$openbitfun_search_bom_be" -- "$openbitfun_search_path" >/dev/null; then
        printf '1'
    else
        openbitfun_search_status=$?
        case "$openbitfun_search_status" in
            1) printf '0' ;;
            *) exit "$openbitfun_search_status" ;;
        esac
    fi
done
printf '\nOPENBITFUN_GREP_BATCH_END\n'"#,
    );
    command
}

/// One-shot candidate listing over a tree, framed like the `rg` candidate command.
///
/// The probe feeds stdin, so it proves NUL-delimited listing and directory exclusion
/// before an empty result can be trusted. A grep without `--null` also fails it, so
/// the caller falls back rather than losing filenames containing a newline. BOM bytes
/// retain files whose match only exists after the native searcher transcodes them.
pub(super) fn recursive_grep_candidate_command(
    literals: &[&str],
    path: &str,
    ignore_case: bool,
    excluded_directories: &[&str],
) -> String {
    let flags = if ignore_case {
        "-a -F -i -l --null"
    } else {
        "-a -F -l --null"
    };
    let probe_literal = if ignore_case {
        "literal.marker"
    } else {
        "Literal.Marker"
    };
    let mut excludes = String::new();
    for directory in excluded_directories {
        excludes.push_str(" --exclude-dir=");
        excludes.push_str(&shell_single_quote(directory));
    }
    let mut patterns = String::new();
    for literal in literals {
        patterns.push_str(" -e ");
        patterns.push_str(&shell_single_quote(literal));
    }
    let path = shell_single_quote(path);
    format!(
        r#"command -v grep >/dev/null 2>&1 || exit 127
openbitfun_search_bom_le=$(printf '\377\376') || exit 127
openbitfun_search_bom_be=$(printf '\376\377') || exit 127
openbitfun_search_probe=$(printf 'prefix\000ignored\nLiteral.Marker\n' | LC_ALL=C GREP_OPTIONS= command grep {flags}{excludes} -e '{probe_literal}' 2>/dev/null | tr '\000' '#')
case "$openbitfun_search_probe" in *'#') ;; *) exit 127 ;; esac
printf 'OPENBITFUN_RG_CANDIDATES_BEGIN\000'
if LC_ALL=C GREP_OPTIONS= command grep -r {flags}{excludes}{patterns} -e "$openbitfun_search_bom_le" -e "$openbitfun_search_bom_be" -- {path} 2>/dev/null; then openbitfun_search_status=0; else openbitfun_search_status=$?; fi
printf 'OPENBITFUN_RG_CANDIDATES_END\000'
exit "$openbitfun_search_status""#
    )
}

/// A completed batch must contain one decision per input path and nothing else.
/// Missing output, extra output and transport truncation never mean "no match".
pub(super) fn parse_grep_batch_output(stdout: &str, expected: usize) -> Result<Vec<bool>, String> {
    let decisions = stdout.strip_suffix(BATCH_END).ok_or_else(|| {
        "Workspace grep candidate output is missing its completion marker".to_string()
    })?;
    if decisions.len() != expected {
        return Err(format!(
            "Workspace grep candidate output contains {} decisions; expected {expected}",
            decisions.len(),
        ));
    }
    decisions
        .bytes()
        .map(|decision| match decision {
            b'0' => Ok(false),
            b'1' => Ok(true),
            _ => Err("Workspace grep candidate output contains an invalid decision".to_string()),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_complete_literal_alternatives_are_eligible() {
        assert_eq!(
            literal_alternatives("all_reduce", false),
            Some(vec!["all_reduce"])
        );
        assert_eq!(
            literal_alternatives("all_reduce|all_gather", false),
            Some(vec!["all_reduce", "all_gather"])
        );
        assert_eq!(
            literal_alternatives("中文字面量|café", false),
            Some(vec!["中文字面量", "café"])
        );
        assert_eq!(
            literal_alternatives("O'Reilly; value", false),
            Some(vec!["O'Reilly; value"])
        );
        assert_eq!(literal_alternatives("needle", true), None);
        for pattern in [
            "", "|foo", "foo|", "foo||bar", "foo\nbar", "foo\tbar", "foo\0bar", "(?i)foo", r"\d+",
            "[a-z]",
        ] {
            assert_eq!(literal_alternatives(pattern, false), None, "{pattern:?}");
        }
        for syntax in ".^$[](){}*+?\\".chars() {
            assert!(
                literal_alternatives(&format!("prefix{syntax}suffix"), false).is_none(),
                "{syntax}"
            );
        }
    }

    #[test]
    fn batch_arguments_keep_quotes_and_shell_syntax_as_data() {
        let command = grep_batch_command(
            &["quote' and ; shell", "$(printf injected)"],
            &[
                "/repo/a'\n\\b".to_string(),
                "/repo/$(touch injected)".to_string(),
            ],
        );
        assert!(command.contains("set -- '/repo/a'\\''\n\\b' '/repo/$(touch injected)'\n"));
        assert!(command.contains(" -e 'quote'\\'' and ; shell' -e '$(printf injected)'"));
        assert!(command.contains("-- \"$openbitfun_search_path\" >/dev/null"));
        assert!(!command.contains("< \"$openbitfun_search_path\""));
        assert!(command.contains("*) exit \"$openbitfun_search_status\""));
        assert_eq!(
            command.matches("$(printf").count(),
            3,
            "two BOM initializers plus the quoted literal, never per-file BOM substitutions"
        );
        assert_eq!(
            command.matches("2>&1").count(),
            0,
            "real file errors must retain stderr"
        );
        assert!(command.contains("LC_ALL=C GREP_OPTIONS= command grep"));
    }

    #[test]
    fn completed_batches_preserve_each_position() {
        assert_eq!(
            parse_grep_batch_output(&format!("1010{BATCH_END}"), 4).unwrap(),
            vec![true, false, true, false]
        );
        assert_eq!(
            parse_grep_batch_output(BATCH_END, 0).unwrap(),
            Vec::<bool>::new()
        );
    }

    #[test]
    fn incomplete_or_malformed_batches_never_become_negative_candidates() {
        for (stdout, expected) in [
            ("01".to_string(), 2),
            (format!("0{BATCH_END}"), 2),
            (format!("010{BATCH_END}"), 2),
            (format!("0x{BATCH_END}"), 2),
            (format!("0\n{BATCH_END}"), 2),
            (format!("é{BATCH_END}"), 2),
            (format!("01{BATCH_END}trailing"), 2),
            (format!("01{BATCH_END}{BATCH_END}"), 2),
        ] {
            assert!(
                parse_grep_batch_output(&stdout, expected).is_err(),
                "{stdout:?}"
            );
        }
    }

    #[test]
    fn probe_covers_binary_and_literal_semantics_and_grep_open_errors() {
        let command = grep_probe_command();
        assert!(command.contains("prefix\\000ignored"));
        assert!(command.contains("literal.marker"));
        assert!(command.contains("literalXmarker"));
        assert!(command.contains("\\377\\376\\000"));
        assert!(command.contains("\\376\\377\\000"));
        assert!(command.contains("-- /dev/null/openbitfun-grep-probe"));
        assert!(command.contains("[ \"$openbitfun_search_status\" -gt 1 ] || exit 127"));
    }
}

#[cfg(test)]
mod candidate_literal_tests {
    use super::{content_search_candidate_literal, recursive_grep_candidate_command};

    #[test]
    fn regex_mode_and_unusable_patterns_have_no_candidate_literal() {
        assert_eq!(content_search_candidate_literal("a.b", true, true), None);
        assert_eq!(content_search_candidate_literal("", true, false), None);
        assert_eq!(content_search_candidate_literal("a\nb", true, false), None);
    }

    #[test]
    fn case_sensitive_literal_is_used_whole_including_metacharacters() {
        assert_eq!(
            content_search_candidate_literal("self.search(", true, false).as_deref(),
            Some("self.search(")
        );
    }

    #[test]
    fn case_folded_literal_excludes_characters_with_non_ascii_folds() {
        // `k` and `s` also fold to U+212A and U+017F, which `LC_ALL=C grep -i` misses.
        assert_eq!(
            content_search_candidate_literal("search", false, false).as_deref(),
            Some("earch")
        );
        assert_eq!(
            content_search_candidate_literal("123", false, false).as_deref(),
            Some("123")
        );
        assert_eq!(content_search_candidate_literal("ss", false, false), None);
        // A cased non-ASCII letter also splits the literal; an uncased one does not.
        assert_eq!(
            content_search_candidate_literal("ab\u{00C9}c", false, false).as_deref(),
            Some("ab")
        );
        assert_eq!(
            content_search_candidate_literal("\u{641C}\u{7D22}", false, false).as_deref(),
            Some("\u{641C}\u{7D22}")
        );
    }

    #[test]
    fn recursive_command_folds_case_only_when_asked_and_excludes_vcs_directories() {
        let folded = recursive_grep_candidate_command(&["it's"], "/srv/my repo", true, &[".git"]);
        assert!(folded.contains("command grep -r -a -F -i -l --null"));
        assert!(folded.contains("--exclude-dir=.git") || folded.contains("--exclude-dir='.git'"));
        assert!(folded.contains("'/srv/my repo'"));
        assert!(folded.contains("OPENBITFUN_RG_CANDIDATES_END"));

        let exact = recursive_grep_candidate_command(&["needle"], "/srv", false, &[]);
        assert!(!exact.contains(" -i "));
        assert!(exact.contains("-e 'Literal.Marker'"));
    }
}
