use super::*;
use crate::agentic::tools::ToolRuntimeRestrictions;
use crate::agentic::WorkspaceBinding;
use std::collections::{HashMap, HashSet};

fn constraint(description: &str, matcher: ConstraintMatcher) -> ExtractedConstraint {
    ExtractedConstraint {
        id: format!("test:{description}"),
        description: description.to_string(),
        operation_scope: ConstraintOperationScope::All,
        matcher,
        source: ConstraintSource::Legacy,
        source_text: None,
    }
}

fn parsed_shell_targets(command: &str) -> Vec<(String, ShellMutationOperation)> {
    explicit_bash_mutation_targets(command)
        .into_iter()
        .map(|target| (target.path, target.operation))
        .collect()
}

#[test]
fn test_files_matcher_covers_common_conventions() {
    let matcher = ConstraintMatcher::TestFiles;
    for path in [
        "report/util_test.go",
        "pkg/foo/test_bar.py",
        "pkg/foo/bar_test.py",
        "src/foo.test.tsx",
        "src/foo.spec.ts",
        "spec/models/user_spec.rb",
        "pkg/foo_test.cc",
        "src/foo-test.js",
        "src/test-widget.ts",
        "test/components/Foo-test.tsx",
        "__tests__/foo.js",
        "TEST/UPPER.spec.ts",
    ] {
        assert!(matcher.matches(path), "expected test path: {path}");
    }
    assert!(!matcher.matches("src/foo.ts"));
    assert!(!matcher.matches("report/util.go"));
}

#[test]
fn deterministic_extractor_recognizes_direct_test_file_restriction() {
    let message = "Do not modify the testing logic or any test files.";
    let extracted = deterministic_test_constraint(message).expect("test constraint");
    assert_eq!(extracted.matcher, ConstraintMatcher::TestFiles);
    assert_eq!(extracted.source, ConstraintSource::Deterministic);
    assert!(extracted.source_text.is_some());
}

#[test]
fn deterministic_extractor_does_not_confuse_do_not_run_tests() {
    assert!(deterministic_test_constraint("Do not run the tests on Windows.").is_none());
}

#[test]
fn deterministic_extractor_rejects_keyword_cooccurrence_false_positives() {
    for message in [
        "You don't have to modify tests.",
        "Do not delete source files because tests fail.",
        "Don't forget to modify tests.",
        "The tests already cover this behavior.",
        "Avoid modifying production behavior just to satisfy tests.",
    ] {
        assert!(
            deterministic_test_constraint(message).is_none(),
            "expected no deterministic constraint for: {message}"
        );
    }
}

#[test]
fn generic_path_restriction_phrases_reach_the_model_prefilter() {
    for message in [
        "Cargo.lock is off limits.",
        "Leave package.json untouched.",
        "Keep generated/schema.rs unchanged.",
    ] {
        assert!(
            has_prohibition_signal(message),
            "expected prohibition signal for: {message}"
        );
    }
}

#[test]
fn deterministic_extractor_recognizes_unchanged_and_non_test_only_wording() {
    for message in [
        "Keep test files unchanged.",
        "Tests must remain unchanged.",
        "Only modify non-test files.",
        "测试文件保持不变。",
    ] {
        assert!(
            deterministic_test_constraint(message).is_some(),
            "expected deterministic constraint for: {message}"
        );
    }
}

#[test]
fn deterministic_extractor_does_not_turn_explicit_relaxation_into_a_prohibition() {
    for message in [
        "You can modify tests now.",
        "Test files are allowed to be modified.",
        "现在可以修改测试文件。",
    ] {
        assert!(
            deterministic_test_constraint(message).is_none(),
            "expected no deterministic prohibition for: {message}"
        );
    }
}

#[test]
fn long_prompt_keeps_both_ends() {
    let input = format!("start{}do not modify tests", "x".repeat(MAX_PROMPT_CHARS));
    let (truncated, was_truncated) = truncate_for_extraction(&input);
    assert!(was_truncated);
    assert!(truncated.starts_with("start"));
    assert!(truncated.ends_with("do not modify tests"));
}

#[test]
fn matchers_cover_paths_extensions_and_unmatched() {
    assert!(ConstraintMatcher::PathContains {
        substrings: vec!["package-lock.json".to_string()]
    }
    .matches("frontend/package-lock.json"));
    assert!(ConstraintMatcher::PathUnderDir {
        dirs: vec!["migrations".to_string()]
    }
    .matches("db/migrations/0002_add_column.sql"));
    assert!(ConstraintMatcher::Extension {
        exts: vec![".lock".to_string()]
    }
    .matches("Cargo.lock"));
    assert!(!ConstraintMatcher::Unmatched.matches("anything.go"));
}

#[test]
fn terminal_preflight_finds_explicit_mutation_targets() {
    assert_eq!(
        parsed_shell_targets("sed -i 's/old/new/' tests/example.rs"),
        vec![(
            "tests/example.rs".to_string(),
            ShellMutationOperation::Write
        )]
    );
    assert_eq!(
        parsed_shell_targets("printf x > test/unit/output.txt && touch src/lib.rs"),
        vec![
            (
                "test/unit/output.txt".to_string(),
                ShellMutationOperation::Write
            ),
            ("src/lib.rs".to_string(), ShellMutationOperation::Write)
        ]
    );
    assert_eq!(
        parsed_shell_targets("cargo test -p core"),
        Vec::<(String, ShellMutationOperation)>::new()
    );
    assert_eq!(
        parsed_shell_targets(
            r#"python3 -c \"open('/app/test/unit/example_test.py', 'w').write('x')\""#
        ),
        vec![(
            "/app/test/unit/example_test.py".to_string(),
            ShellMutationOperation::Write
        )]
    );
    assert_eq!(
        parsed_shell_targets(
            r#"python -c \"from pathlib import Path; Path('tests/repro_test.py').write_text('x')\""#
        ),
        vec![(
            "tests/repro_test.py".to_string(),
            ShellMutationOperation::Write
        )]
    );
    assert_eq!(
        parsed_shell_targets("mv tests/existing_test.py src/existing.py"),
        vec![
            (
                "tests/existing_test.py".to_string(),
                ShellMutationOperation::Delete
            ),
            ("src/existing.py".to_string(), ShellMutationOperation::Write)
        ]
    );
    assert_eq!(
        parsed_shell_targets(
            r#"node -e \"require('fs').writeFileSync('tests/example.test.js', 'x')\""#
        ),
        vec![(
            "tests/example.test.js".to_string(),
            ShellMutationOperation::Write
        )]
    );
    assert_eq!(
        parsed_shell_targets("git mv tests/example.rs src/example.rs"),
        vec![
            (
                "tests/example.rs".to_string(),
                ShellMutationOperation::Delete
            ),
            ("src/example.rs".to_string(), ShellMutationOperation::Write)
        ]
    );
    assert_eq!(
        parsed_shell_targets("git checkout HEAD -- tests/example.rs"),
        vec![(
            "tests/example.rs".to_string(),
            ShellMutationOperation::Write
        )]
    );
    assert_eq!(
        parsed_shell_targets("dd if=/tmp/input of=tests/example.rs"),
        vec![(
            "tests/example.rs".to_string(),
            ShellMutationOperation::Write
        )]
    );
    assert_eq!(
        parsed_shell_targets("rsync -a src/ tests/generated/"),
        vec![(
            "tests/generated/".to_string(),
            ShellMutationOperation::Write
        )]
    );
}

#[test]
fn terminal_preflight_marks_unresolved_mutations() {
    for command in [
        "target=tests/example.rs; printf x > \"$target\"",
        "python -c \"from pathlib import Path; Path(target).write_text('x')\"",
        "bash",
        "find tests -type f -exec rm {} +",
        "git checkout HEAD tests/example.rs",
        "tar -xf generated-tests.tar",
        "unzip generated-tests.zip",
        "patch -p1 < change.patch",
    ] {
        let targets = explicit_bash_mutation_targets(command);
        assert!(
            has_unresolved_bash_mutation(command, &targets),
            "expected unresolved mutation: {command}"
        );
    }

    for command in [
        "cargo test -p core",
        "bash -lc 'cargo test -p core'",
        "git status",
        "git checkout HEAD -- tests/example.rs",
        "dd if=/tmp/input of=tests/example.rs",
        "rsync -a src/ tests/generated/",
        "tar -tf generated-tests.tar",
        "unzip -l generated-tests.zip",
    ] {
        let targets = explicit_bash_mutation_targets(command);
        assert!(
            !has_unresolved_bash_mutation(command, &targets),
            "expected resolved or read-only command: {command}"
        );
    }
}

#[test]
fn shell_delete_targets_apply_delete_only_constraints() {
    let delete_only = ExtractedConstraint {
        id: "test:delete-only".to_string(),
        description: "do not delete tests".to_string(),
        operation_scope: ConstraintOperationScope::DeleteOnly,
        matcher: ConstraintMatcher::TestFiles,
        source: ConstraintSource::Deterministic,
        source_text: Some("Do not delete tests.".to_string()),
    };

    for command in [
        "rm tests/example.rs",
        "git rm tests/example.rs",
        "python -c \"from pathlib import Path; Path('tests/example.rs').unlink()\"",
        "node -e \"require('fs').unlinkSync('tests/example.rs')\"",
    ] {
        let target = explicit_bash_mutation_targets(command)
            .into_iter()
            .find(|target| target.path == "tests/example.rs")
            .unwrap_or_else(|| panic!("missing delete target for {command}"));
        assert_eq!(target.operation, ShellMutationOperation::Delete);
        assert!(find_violation_for_operation(
            std::slice::from_ref(&delete_only),
            &target.path,
            target.operation.guard_operation(),
        )
        .is_some());
    }

    let write = explicit_bash_mutation_targets("touch tests/example.rs")
        .into_iter()
        .next()
        .expect("write target");
    assert_eq!(write.operation, ShellMutationOperation::Write);
    assert!(find_violation_for_operation(
        &[delete_only],
        &write.path,
        write.operation.guard_operation(),
    )
    .is_none());
}

#[test]
fn fast_response_parser_requires_the_observable_update_schema() {
    let valid = r#"{
        "additions": [{
            "description": "do not modify tests",
            "matcher": {"kind": "test_files"}
        }],
        "revocations": [{
            "constraint_id": "deterministic:test_files",
            "description": "tests may now be modified"
        }]
    }"#;
    let parsed: ExtractionResponse = serde_json::from_str(valid).expect("valid schema");
    assert_eq!(parsed.additions.len(), 1);
    assert_eq!(parsed.revocations.len(), 1);

    assert!(serde_json::from_str::<ExtractionResponse>(
        r#"{"constraints": [], "revocations": []}"#
    )
    .is_err());
    assert!(serde_json::from_str::<ExtractionResponse>(r#"{"additions": []}"#).is_err());
}

#[test]
fn state_distinguishes_failed_from_processed_extraction() {
    let mut state = EditConstraintState::default();
    let failed = ConstraintExtractionRecord {
        message_sha256: "hash".to_string(),
        dialog_turn_id: Some("turn-1".to_string()),
        status: ExtractionStatus::Failed,
        constraints: Vec::new(),
        deterministic_constraint_count: 0,
        model_attempts: 2,
        active_constraint_ids: Vec::new(),
        revocation_authorized: true,
        model_status: ModelExtractionStatus::Failed,
        model_constraints: Vec::new(),
        model_revocations: Vec::new(),
        revoked_constraint_ids: Vec::new(),
        unmatched_revocation_ids: Vec::new(),
        input_chars: 10,
        prompt_chars: 10,
        input_truncated: false,
        latency_ms: 1,
        extracted_at_ms: 1,
        failure: Some(ExtractionFailure {
            stage: "schema_validation".to_string(),
            reason: "bad json".to_string(),
        }),
        response_excerpt: None,
    };
    state.merge_extraction(failed);
    assert!(!state.message_processed("turn-1", "hash"));

    let mut completed = state.extractions[0].clone();
    completed.status = ExtractionStatus::NoConstraints;
    completed.failure = None;
    state.merge_extraction(completed);
    assert!(state.message_processed("turn-1", "hash"));
    assert!(!state.message_processed("turn-2", "hash"));
}

#[test]
fn internal_turns_cannot_revoke_a_user_edit_constraint() {
    let protected = constraint("don't touch tests", ConstraintMatcher::TestFiles);
    let revocation = ConstraintRevocation {
        constraint_id: protected.id.clone(),
        description: "tests may be modified now".to_string(),
    };

    let (revoked, unmatched) = validated_revocation_ids(&[revocation], &[protected.clone()], false);

    assert!(revoked.is_empty());
    assert!(unmatched.is_empty());
    let (revoked, unmatched) = validated_revocation_ids(
        &[ConstraintRevocation {
            constraint_id: protected.id.clone(),
            description: "tests may be modified now".to_string(),
        }],
        &[protected],
        true,
    );
    assert_eq!(revoked, vec!["test:don't touch tests".to_string()]);
    assert!(unmatched.is_empty());
}

#[test]
fn state_applies_only_validated_explicit_revocations() {
    let protected = constraint("don't touch tests", ConstraintMatcher::TestFiles);
    let protected_id = protected.id.clone();
    let mut state = EditConstraintState::default();
    state.constraints.push(protected);

    state.merge_extraction(ConstraintExtractionRecord {
        message_sha256: "relaxation-hash".to_string(),
        dialog_turn_id: Some("turn-2".to_string()),
        status: ExtractionStatus::Extracted,
        constraints: Vec::new(),
        deterministic_constraint_count: 0,
        model_attempts: 1,
        active_constraint_ids: vec![protected_id.clone()],
        revocation_authorized: true,
        model_status: ModelExtractionStatus::Parsed,
        model_constraints: Vec::new(),
        model_revocations: vec![ConstraintRevocation {
            constraint_id: protected_id.clone(),
            description: "tests may be modified now".to_string(),
        }],
        revoked_constraint_ids: vec![protected_id],
        unmatched_revocation_ids: Vec::new(),
        input_chars: 24,
        prompt_chars: 24,
        input_truncated: false,
        latency_ms: 1,
        extracted_at_ms: 1,
        failure: None,
        response_excerpt: Some(
            r#"{"additions":[],"revocations":[{"constraint_id":"test:don't touch tests"}]}"#
                .to_string(),
        ),
    });

    assert!(state.constraints.is_empty());
    assert_eq!(state.schema_version, EDIT_CONSTRAINT_SCHEMA_VERSION);
}

#[test]
fn failed_or_unmatched_revocation_keeps_active_constraint() {
    let protected = constraint("don't touch tests", ConstraintMatcher::TestFiles);
    let mut state = EditConstraintState::default();
    state.constraints.push(protected.clone());

    state.merge_extraction(ConstraintExtractionRecord {
        message_sha256: "invalid-relaxation-hash".to_string(),
        dialog_turn_id: Some("turn-2".to_string()),
        status: ExtractionStatus::NoConstraints,
        constraints: Vec::new(),
        deterministic_constraint_count: 0,
        model_attempts: 1,
        active_constraint_ids: vec![protected.id.clone()],
        revocation_authorized: true,
        model_status: ModelExtractionStatus::Parsed,
        model_constraints: Vec::new(),
        model_revocations: vec![ConstraintRevocation {
            constraint_id: "invented-id".to_string(),
            description: "ambiguous relaxation".to_string(),
        }],
        revoked_constraint_ids: Vec::new(),
        unmatched_revocation_ids: vec!["invented-id".to_string()],
        input_chars: 20,
        prompt_chars: 20,
        input_truncated: false,
        latency_ms: 1,
        extracted_at_ms: 1,
        failure: None,
        response_excerpt: None,
    });

    assert_eq!(state.constraints, vec![protected]);
}

#[test]
fn find_violation_returns_first_match() {
    let constraints = vec![
        constraint("don't touch tests", ConstraintMatcher::TestFiles),
        constraint(
            "don't touch lockfiles",
            ConstraintMatcher::Extension {
                exts: vec![".lock".to_string()],
            },
        ),
    ];
    assert_eq!(
        find_violation(&constraints, "report/util_test.go")
            .map(|constraint| constraint.description.as_str()),
        Some("don't touch tests")
    );
    assert_eq!(
        find_violation(&constraints, "Cargo.lock")
            .map(|constraint| constraint.description.as_str()),
        Some("don't touch lockfiles")
    );
}

#[test]
fn guard_rejections_are_non_relaxable_by_input_rewrites() {
    let protected = constraint("don't touch tests", ConstraintMatcher::TestFiles);
    let rejection = decision_result(
        None,
        "Write",
        "write",
        "tests/existing_test.rs",
        "deny",
        false,
        None,
        Some(&protected),
        Some("protected test file".to_string()),
        Some(403),
    )
    .expect("guard rejection");

    assert!(rejection.blocks_input_rewrite());
    assert_eq!(rejection.error_code, Some(403));
}

#[test]
fn new_files_are_exempt_only_from_test_file_constraints() {
    let test_only = EditConstraintState {
        constraints: vec![constraint(
            "don't touch tests",
            ConstraintMatcher::TestFiles,
        )],
        ..Default::default()
    };
    let test_path = vec!["test/repro-test.ts".to_string()];
    assert!(has_only_relaxable_test_file_violations(
        &test_only, &test_path, "write"
    ));

    let stricter = EditConstraintState {
        constraints: vec![
            constraint("don't touch tests", ConstraintMatcher::TestFiles),
            constraint(
                "don't modify generated files",
                ConstraintMatcher::PathUnderDir {
                    dirs: vec!["test".to_string()],
                },
            ),
        ],
        ..Default::default()
    };
    assert!(!has_only_relaxable_test_file_violations(
        &stricter, &test_path, "write"
    ));
}

#[test]
fn agent_created_test_files_can_be_cleaned_up_but_delete_only_rules_remain_strict() {
    let path = vec!["test/repro-test.ts".to_string()];
    let mut state = EditConstraintState {
        constraints: vec![constraint(
            "don't modify tests",
            ConstraintMatcher::TestFiles,
        )],
        ..Default::default()
    };
    state.remember_agent_created_paths(path.clone(), "turn-1");
    assert!(can_mutate_agent_created_test_file(
        Some(&state),
        &path,
        "edit",
        false
    ));
    assert!(can_mutate_agent_created_test_file(
        Some(&state),
        &path,
        "delete",
        false
    ));

    state.constraints.push(ExtractedConstraint {
        id: "test:do-not-delete".to_string(),
        description: "don't delete tests".to_string(),
        operation_scope: ConstraintOperationScope::DeleteOnly,
        matcher: ConstraintMatcher::TestFiles,
        source: ConstraintSource::Deterministic,
        source_text: Some("Do not delete tests.".to_string()),
    });
    assert!(
        find_violation_for_operation(&state.constraints, "test/repro-test.ts", "delete").is_some()
    );
    assert!(
        find_violation_for_operation(&state.constraints, "test/repro-test.ts", "edit").is_some()
    );
    assert!(!can_mutate_agent_created_test_file(
        Some(&state),
        &path,
        "delete",
        false
    ));

    state.forget_agent_created_paths_under(&path);
    assert!(!state.is_agent_created_path(&path));
}

#[test]
fn rollback_discards_future_constraints_and_helper_provenance() {
    let initial_constraint = constraint("don't modify tests", ConstraintMatcher::TestFiles);
    let future_constraint = constraint(
        "don't modify lockfiles",
        ConstraintMatcher::Extension {
            exts: vec![".lock".to_string()],
        },
    );
    let mut state = EditConstraintState::default();
    state.merge_extraction(ConstraintExtractionRecord {
        message_sha256: "turn-1-hash".to_string(),
        dialog_turn_id: Some("turn-1".to_string()),
        status: ExtractionStatus::Extracted,
        constraints: vec![initial_constraint.clone()],
        deterministic_constraint_count: 1,
        model_attempts: 0,
        active_constraint_ids: Vec::new(),
        revocation_authorized: true,
        model_status: ModelExtractionStatus::NotRun,
        model_constraints: Vec::new(),
        model_revocations: Vec::new(),
        revoked_constraint_ids: Vec::new(),
        unmatched_revocation_ids: Vec::new(),
        input_chars: 10,
        prompt_chars: 10,
        input_truncated: false,
        latency_ms: 1,
        extracted_at_ms: 1,
        failure: None,
        response_excerpt: None,
    });
    state.remember_agent_created_paths(vec!["tests/kept_repro.rs".to_string()], "turn-1");
    state.merge_extraction(ConstraintExtractionRecord {
        message_sha256: "turn-2-hash".to_string(),
        dialog_turn_id: Some("turn-2".to_string()),
        status: ExtractionStatus::Extracted,
        constraints: vec![future_constraint],
        deterministic_constraint_count: 0,
        model_attempts: 1,
        active_constraint_ids: vec![initial_constraint.id.clone()],
        revocation_authorized: true,
        model_status: ModelExtractionStatus::Parsed,
        model_constraints: Vec::new(),
        model_revocations: Vec::new(),
        revoked_constraint_ids: vec![initial_constraint.id.clone()],
        unmatched_revocation_ids: Vec::new(),
        input_chars: 10,
        prompt_chars: 10,
        input_truncated: false,
        latency_ms: 1,
        extracted_at_ms: 2,
        failure: None,
        response_excerpt: None,
    });
    state.remember_agent_created_paths(vec!["tests/future_repro.rs".to_string()], "turn-2");

    state.rollback_to_surviving_turns(&HashSet::from(["turn-1".to_string()]));

    assert_eq!(state.constraints, vec![initial_constraint]);
    assert_eq!(state.extractions.len(), 1);
    assert_eq!(
        state.agent_created_paths,
        vec!["tests/kept_repro.rs".to_string()]
    );
    assert_eq!(state.agent_created_path_records.len(), 1);
    assert_eq!(state.agent_created_path_records[0].dialog_turn_id, "turn-1");
}

#[test]
fn fork_baseline_survives_child_rollback_and_replays_child_revocation() {
    let inherited = constraint("don't modify tests", ConstraintMatcher::TestFiles);
    let inherited_id = inherited.id.clone();
    let mut child_state = EditConstraintState {
        constraints: vec![inherited.clone()],
        agent_created_paths: vec!["tests/parent_repro.rs".to_string()],
        ..Default::default()
    };
    child_state.mark_current_state_as_fork_baseline();

    let mut rolled_back_to_fork = child_state.clone();
    rolled_back_to_fork.rollback_to_surviving_turns(&HashSet::new());
    assert_eq!(rolled_back_to_fork.constraints, vec![inherited.clone()]);
    assert_eq!(
        rolled_back_to_fork.agent_created_paths,
        vec!["tests/parent_repro.rs".to_string()]
    );

    child_state.merge_extraction(ConstraintExtractionRecord {
        message_sha256: "child-revocation".to_string(),
        dialog_turn_id: Some("child-turn-1".to_string()),
        status: ExtractionStatus::Extracted,
        constraints: Vec::new(),
        deterministic_constraint_count: 0,
        model_attempts: 1,
        active_constraint_ids: vec![inherited_id.clone()],
        revocation_authorized: true,
        model_status: ModelExtractionStatus::Parsed,
        model_constraints: Vec::new(),
        model_revocations: vec![ConstraintRevocation {
            constraint_id: inherited_id.clone(),
            description: "tests may now be modified".to_string(),
        }],
        revoked_constraint_ids: vec![inherited_id],
        unmatched_revocation_ids: Vec::new(),
        input_chars: 25,
        prompt_chars: 25,
        input_truncated: false,
        latency_ms: 1,
        extracted_at_ms: 2,
        failure: None,
        response_excerpt: None,
    });
    child_state.rollback_to_surviving_turns(&HashSet::from(["child-turn-1".to_string()]));
    assert!(child_state.constraints.is_empty());
}

#[test]
fn deterministic_extractor_marks_explicit_test_deletion_as_delete_only() {
    let constraint = deterministic_test_constraint("Do not delete test files.")
        .expect("explicit test deletion should be extracted");
    assert_eq!(
        constraint.operation_scope,
        ConstraintOperationScope::DeleteOnly
    );
    assert!(constraint.matcher.matches("tests/example.rs"));
}

#[test]
fn force_is_rejected_even_without_runtime_context() {
    let rejection =
        check(None, "Edit", "edit", "tests/example.rs", true).expect("force must be denied");
    assert!(!rejection.result);
    assert_eq!(rejection.error_code, Some(403));
    assert_eq!(
        rejection
            .meta
            .as_ref()
            .and_then(|value| value.get("guard_decision"))
            .and_then(Value::as_str),
        Some("force_denied")
    );
}

#[tokio::test]
async fn blank_input_is_no_constraints_not_failure() {
    let extraction = extract_constraints("   \n  ").await;
    assert_eq!(extraction.status, ExtractionStatus::NoConstraints);
    assert!(extraction.constraints.is_empty());
    assert!(extraction.failure.is_none());
}

#[tokio::test]
async fn irrelevant_follow_up_with_active_constraints_skips_model() {
    let active = constraint("don't touch tests", ConstraintMatcher::TestFiles);
    let extraction =
        extract_instruction("Continue with the implementation.", &[active], true).await;

    assert_eq!(extraction.status, ExtractionStatus::NoConstraints);
    assert_eq!(extraction.model_attempts, 0);
    assert!(extraction.constraints.is_empty());
    assert!(extraction.failure.is_none());
}

#[tokio::test]
async fn no_signal_extraction_does_not_require_session_state() {
    let mut extraction = extract_constraints("Continue with the implementation.").await;
    assert!(!extraction_requires_session_state(&extraction));

    extraction.model_attempts = 1;
    assert!(extraction_requires_session_state(&extraction));

    extraction.model_attempts = 0;
    extraction.status = ExtractionStatus::Failed;
    assert!(extraction_requires_session_state(&extraction));
}

#[test]
fn agent_created_provenance_is_only_needed_for_full_test_constraints() {
    let mut state = EditConstraintState::default();
    state.constraints.push(constraint(
        "don't touch lockfiles",
        ConstraintMatcher::Extension {
            exts: vec![".lock".to_string()],
        },
    ));
    assert!(!state.tracks_agent_created_test_paths());

    state.constraints.push(constraint(
        "don't touch tests",
        ConstraintMatcher::TestFiles,
    ));
    assert!(state.tracks_agent_created_test_paths());
}

#[test]
fn telemetry_requires_explicit_opt_in_value() {
    for value in ["1", "true", "TRUE", "yes", "on", " On "] {
        assert!(
            telemetry_setting_enabled(Some(value)),
            "expected opt-in: {value}"
        );
    }
    for value in ["", "0", "false", "off", "enabled"] {
        assert!(
            !telemetry_setting_enabled(Some(value)),
            "unexpected opt-in: {value}"
        );
    }
    assert!(!telemetry_setting_enabled(None));
}

#[test]
fn successful_mutation_telemetry_is_persisted_as_jsonl() {
    let root = std::env::temp_dir().join(format!(
        "openbitfun-edit-constraint-telemetry-{}",
        Uuid::new_v4()
    ));
    fs::create_dir_all(&root).expect("create temp workspace");
    let event = json!({
        "event": "mutation_applied",
        "tool_call_id": "tool-call-1",
        "requested_path": "tests/example.rs",
    });
    let telemetry_path = root.join(TELEMETRY_RELATIVE_PATH);
    append_jsonl(&telemetry_path, &event).expect("append telemetry event");
    let line = fs::read_to_string(&telemetry_path).expect("read telemetry");
    let event: Value = serde_json::from_str(line.trim()).expect("valid jsonl event");
    assert_eq!(event["event"], "mutation_applied");
    assert_eq!(event["tool_call_id"], "tool-call-1");
    assert_eq!(event["requested_path"], "tests/example.rs");

    let _ = fs::remove_dir_all(root);
}

#[test]
fn local_recursive_delete_fallback_finds_protected_descendant() {
    let root = std::env::temp_dir().join(format!(
        "openbitfun-edit-constraint-recursive-delete-{}",
        Uuid::new_v4()
    ));
    let target = root.join("parent");
    fs::create_dir_all(target.join("tests")).expect("create test directory");
    fs::write(target.join("tests/example.rs"), "test").expect("create test file");
    let context = ToolUseContext {
        tool_call_id: Some("tool-call-1".to_string()),
        agent_type: Some("Standard".to_string()),
        session_id: None,
        dialog_turn_id: Some("turn-1".to_string()),
        workspace: Some(WorkspaceBinding::new(None, root.clone())),
        loaded_deferred_tool_specs: Vec::new(),
        primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
        custom_data: HashMap::new(),
        computer_use_host: None,
        runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
        runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
    };
    let state = EditConstraintState {
        constraints: vec![constraint(
            "don't touch tests",
            ConstraintMatcher::TestFiles,
        )],
        ..Default::default()
    };

    let rejection =
        check_local_recursive_delete(&context, "parent", &target.to_string_lossy(), &state)
            .expect("recursive delete should be denied");
    assert_eq!(rejection.error_code, Some(403));
    assert!(rejection
        .message
        .as_deref()
        .unwrap_or_default()
        .contains("tests"));

    let _ = fs::remove_dir_all(root);
}

/// Opt-in offline replay: command bytes are passed ONLY to the two analyzers.
/// No shell, process port, or referenced script content is accessed.
#[test]
#[ignore = "requires explicit archived input and report paths"]
fn complete_shell_archive_replay() {
    use tool_runtime::shell_analysis::analyze;
    let input = std::env::var("OPENBITFUN_SHELL_REPLAY_INPUT").expect("input JSONL path");
    let output = std::env::var("OPENBITFUN_SHELL_REPLAY_OUTPUT").expect("output report path");
    let source = fs::read_to_string(input).unwrap();
    let mut rows = vec![];
    for line in source.lines() {
        let row: Value = serde_json::from_str(line).unwrap();
        let command = row["command"].as_str().unwrap();
        // Warm regex initialization outside measured samples for both versions.
        let _ = explicit_bash_mutation_targets(command);
        let _ = analyze(command, "bash", "/app");
        let mut old_times = vec![];
        let mut new_times = vec![];
        for _ in 0..11 {
            let start = Instant::now();
            let targets = explicit_bash_mutation_targets(command);
            let unknown = has_unresolved_bash_mutation(command, &targets);
            std::hint::black_box((targets, unknown));
            old_times.push(start.elapsed().as_nanos());
            let start = Instant::now();
            std::hint::black_box(analyze(command, "bash", "/app"));
            new_times.push(start.elapsed().as_nanos());
        }
        old_times.sort_unstable();
        new_times.sort_unstable();
        let targets = explicit_bash_mutation_targets(command);
        let old_unknown = has_unresolved_bash_mutation(command, &targets);
        let new = analyze(command, "bash", "/app");
        rows.push(json!({"id":row["id"],"task_id":row["task_id"],"observed_target":row["observed_target"],"observed_category":row["observed_category"],"command_sha256":message_sha256(command),"bytes":command.len(),"old_targets":targets.iter().map(|t|json!({"path":t.path,"operation":t.operation.guard_operation()})).collect::<Vec<_>>(),"old_unresolved":old_unknown,"new":new,"old_median_ns":old_times[5],"new_median_ns":new_times[5]}));
    }
    assert_eq!(rows.len(), 476);
    let fd_rows = rows.iter().filter(|r| r["observed_target"] == "&1").count();
    let phantom = rows
        .iter()
        .filter(|r| r["observed_target"] == "&1")
        .filter(|r| {
            r["new"]["file_operations"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["path"] == "&1" || t["path"] == "/app/&1")
        })
        .count();
    assert_eq!(fd_rows, 280);
    assert_eq!(phantom, 0);
    let report = json!({"mode":"pure_parser_only","executed_archived_commands":0,"assumed_shell":"bash","assumed_cwd":"/app","full_guard_context_reconstructed":false,"measurement":"median of 11 interleaved warm old/new analyses per input, nanoseconds","rows":rows});
    fs::write(output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
}

#[test]
#[ignore = "requires explicit non-failure sample paths; pure analysis only"]
fn complete_shell_normal_sample_replay() {
    let source =
        fs::read_to_string(std::env::var("OPENBITFUN_SHELL_NORMAL_INPUT").unwrap()).unwrap();
    let output = std::env::var("OPENBITFUN_SHELL_NORMAL_OUTPUT").unwrap();
    let mut rows = vec![];
    for line in source.lines() {
        let row: Value = serde_json::from_str(line).unwrap();
        let cmd = row["command"].as_str().unwrap();
        let analysis = tool_runtime::shell_analysis::analyze(
            cmd,
            row["shell_kind"].as_str().unwrap(),
            row["workdir"].as_str().unwrap(),
        );
        rows.push(json!({"id":row["id"],"group":row["group"],"command_sha256":message_sha256(cmd),"analysis":analysis}));
    }
    assert_eq!(rows.len(), 60);
    fs::write(output, serde_json::to_vec_pretty(&rows).unwrap()).unwrap();
}

#[tokio::test]
async fn disabled_guard_skips_extraction_and_all_tool_entry_points() {
    TEST_ENABLED
        .scope(false, async {
            let record = extract_constraints("Do not modify test files.").await;
            assert_eq!(record.model_attempts, 0);
            assert!(record.constraints.is_empty());
            assert!(!extraction_requires_session_state(&record));
            let context = ToolUseContext::for_tool_listing(None, None);
            assert!(
                check_edit(Some(&context), "Edit", "edit", "tests/a.rs", true)
                    .await
                    .is_none()
            );
            assert!(
                check_write(Some(&context), "Write", "write", "tests/a.rs", true)
                    .await
                    .is_none()
            );
            assert!(
                check_delete(Some(&context), "Delete", "delete", "tests/a.rs", true)
                    .await
                    .is_none()
            );
            assert!(check_recursive_delete(Some(&context), "tests", true)
                .await
                .is_none());
            assert!(check_bash_command(&context, "rm tests/a.rs")
                .await
                .is_none());
            assert!(
                check_exec_command(&context, "Get-Location", "powershell", r"E:\guard-repro")
                    .await
                    .is_none()
            );
            assert!(!has_active_shell_constraints(&context).await);
        })
        .await;
}
