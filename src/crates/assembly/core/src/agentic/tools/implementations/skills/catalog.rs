//! Compatibility re-export for skill catalog facts.
//!
//! The provider-neutral owner lives in `openbitfun-agent-runtime`.

pub use openbitfun_agent_runtime::skills::builtin_skill_group_key;

#[cfg(test)]
mod tests {
    use super::builtin_skill_group_key;
    use crate::agentic::tools::implementations::skills::builtin::builtin_skill_dir_names;

    #[test]
    fn builtin_skill_groups_match_expected_sets() {
        assert_eq!(builtin_skill_group_key("ppt-design"), Some("office"));
        for removed in ["docx", "pdf", "pptx", "xlsx"] {
            assert_eq!(builtin_skill_group_key(removed), None);
        }
        assert_eq!(
            builtin_skill_group_key("create-openbitfun-skin"),
            Some("meta")
        );
        assert_eq!(builtin_skill_group_key("commit-push-pr"), Some("meta"));
        assert_eq!(builtin_skill_group_key("find-skills"), Some("meta"));
        assert_eq!(builtin_skill_group_key("debug"), Some("debugging"));
        assert_eq!(builtin_skill_group_key("multitask"), Some("coordination"));
        assert_eq!(builtin_skill_group_key("plan"), Some("planning"));
        assert_eq!(builtin_skill_group_key("miniapp-dev"), Some("miniapp"));
        assert_eq!(
            builtin_skill_group_key("openbitfun-frontend-dev"),
            Some("creation")
        );
        assert_eq!(builtin_skill_group_key("writing-skills"), Some("meta"));
        assert_eq!(
            builtin_skill_group_key("agent-browser"),
            Some("computer-use")
        );
        assert_eq!(builtin_skill_group_key("agent-eval-canvas"), Some("canvas"));
        assert_eq!(builtin_skill_group_key("unknown-skill"), None);
    }

    #[test]
    fn runtime_catalog_covers_all_embedded_builtin_skills() {
        for dir_name in builtin_skill_dir_names() {
            assert!(
                builtin_skill_group_key(dir_name).is_some(),
                "Missing built-in skill catalog entry for '{}'",
                dir_name
            );
        }
    }
}
