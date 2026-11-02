use serde_yaml::{Mapping, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PlanArtifactIssue {
    pub code: &'static str,
    pub message: String,
}

impl PlanArtifactIssue {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub(super) fn is_plan_artifact_path(path: &str) -> bool {
    path.replace('\\', "/")
        .to_ascii_lowercase()
        .ends_with(".plan.md")
}

pub(super) fn diagnose_plan_artifact(content: &str) -> Vec<PlanArtifactIssue> {
    let (frontmatter, body) = match split_frontmatter(content) {
        Ok(parts) => parts,
        Err(issue) => return vec![issue],
    };

    let mut issues = Vec::new();
    match serde_yaml::from_str::<Value>(frontmatter) {
        Ok(Value::Mapping(mapping)) => diagnose_frontmatter(&mapping, &mut issues),
        Ok(_) => issues.push(PlanArtifactIssue::new(
            "invalid_frontmatter_object",
            "Make the YAML frontmatter an object containing `name` and `overview`.",
        )),
        Err(error) => issues.push(PlanArtifactIssue::new(
            "invalid_frontmatter_yaml",
            format!("Fix the YAML frontmatter syntax: {error}"),
        )),
    }

    if body.trim().is_empty() {
        issues.push(PlanArtifactIssue::new(
            "missing_markdown_body",
            "Add a non-empty Markdown body after the YAML frontmatter.",
        ));
    }

    issues
}

fn split_frontmatter(content: &str) -> Result<(&str, &str), PlanArtifactIssue> {
    let rest = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))
        .ok_or_else(|| {
            PlanArtifactIssue::new(
                "missing_frontmatter",
                "Start the plan file with YAML frontmatter delimited by `---` lines.",
            )
        })?;

    let mut offset = 0;
    for segment in rest.split_inclusive('\n') {
        let line = segment.strip_suffix('\n').unwrap_or(segment);
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line == "---" {
            return Ok((&rest[..offset], &rest[offset + segment.len()..]));
        }
        offset += segment.len();
    }

    Err(PlanArtifactIssue::new(
        "unterminated_frontmatter",
        "Close the YAML frontmatter with a second `---` line before the Markdown body.",
    ))
}

fn diagnose_frontmatter(mapping: &Mapping, issues: &mut Vec<PlanArtifactIssue>) {
    diagnose_required_string(mapping, "name", issues);
    diagnose_required_string(mapping, "overview", issues);

    let Some(todos) = mapping_field(mapping, "todos") else {
        return;
    };
    let Value::Sequence(todos) = todos else {
        issues.push(PlanArtifactIssue::new(
            "invalid_todos",
            "Make `todos` a YAML array; use `todos: []` for a simple plan.",
        ));
        return;
    };

    for (index, todo) in todos.iter().enumerate() {
        let Value::Mapping(todo) = todo else {
            issues.push(PlanArtifactIssue::new(
                "invalid_todo",
                format!("Make `todos[{index}]` an object containing non-empty `id` and `content` fields."),
            ));
            continue;
        };

        match non_empty_string_field(todo, "id") {
            Some(id) if !is_kebab_case(id) => issues.push(PlanArtifactIssue::new(
                "invalid_todo_id_format",
                format!("Change `todos[{index}].id` to a kebab-case identifier."),
            )),
            Some(_) => {}
            None => issues.push(PlanArtifactIssue::new(
                "invalid_todo_id",
                format!("Give `todos[{index}].id` a non-empty string value."),
            )),
        }

        if non_empty_string_field(todo, "content").is_none() {
            issues.push(PlanArtifactIssue::new(
                "invalid_todo_content",
                format!("Give `todos[{index}].content` a non-empty string value."),
            ));
        }
    }
}

fn diagnose_required_string(
    mapping: &Mapping,
    field: &'static str,
    issues: &mut Vec<PlanArtifactIssue>,
) {
    if non_empty_string_field(mapping, field).is_none() {
        issues.push(PlanArtifactIssue::new(
            match field {
                "name" => "invalid_name",
                "overview" => "invalid_overview",
                _ => "invalid_required_field",
            },
            format!("Give the frontmatter `{field}` field a non-empty string value."),
        ));
    }
}

fn non_empty_string_field<'a>(mapping: &'a Mapping, field: &str) -> Option<&'a str> {
    mapping_field(mapping, field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn mapping_field<'a>(mapping: &'a Mapping, field: &str) -> Option<&'a Value> {
    mapping.get(&Value::String(field.to_string()))
}

fn is_kebab_case(value: &str) -> bool {
    let mut segment_has_character = false;
    for character in value.chars() {
        if character == '-' {
            if !segment_has_character {
                return false;
            }
            segment_has_character = false;
        } else if character.is_ascii_lowercase() || character.is_ascii_digit() {
            segment_has_character = true;
        } else {
            return false;
        }
    }
    segment_has_character
}

#[cfg(test)]
mod tests {
    use super::{diagnose_plan_artifact, is_plan_artifact_path};

    fn issue_codes(content: &str) -> Vec<&'static str> {
        diagnose_plan_artifact(content)
            .into_iter()
            .map(|issue| issue.code)
            .collect()
    }

    #[test]
    fn recognizes_plan_artifact_paths_case_insensitively() {
        assert!(is_plan_artifact_path(".openbitfun/plans/example.plan.md"));
        assert!(is_plan_artifact_path(
            r"E:\workspace\.openbitfun\plans\EXAMPLE.PLAN.MD"
        ));
        assert!(!is_plan_artifact_path(
            ".openbitfun/plans/example.plan.md.bak"
        ));
    }

    #[test]
    fn reports_missing_or_unterminated_frontmatter_without_cascading_issues() {
        assert_eq!(issue_codes("# Plan\n"), vec!["missing_frontmatter"]);
        assert_eq!(
            issue_codes("---\nname: Plan\n# Body\n"),
            vec!["unterminated_frontmatter"]
        );
    }

    #[test]
    fn reports_invalid_yaml_and_missing_body() {
        assert_eq!(
            issue_codes("---\nname: [\n---\n"),
            vec!["invalid_frontmatter_yaml", "missing_markdown_body"]
        );
    }

    #[test]
    fn reports_required_frontmatter_and_todo_issues() {
        let content = r#"---
name: ""
overview: 42
todos:
  - id: Not Kebab
    content: ""
  - content: Missing id
  - invalid scalar
---

Plan body.
"#;

        assert_eq!(
            issue_codes(content),
            vec![
                "invalid_name",
                "invalid_overview",
                "invalid_todo_id_format",
                "invalid_todo_content",
                "invalid_todo_id",
                "invalid_todo",
            ]
        );
    }

    #[test]
    fn accepts_missing_todos_but_validates_legacy_todos() {
        assert_eq!(
            issue_codes("---\nname: Plan\noverview: Overview\n---\nBody"),
            Vec::<&str>::new()
        );
        assert_eq!(
            issue_codes("---\nname: Plan\noverview: Overview\ntodos: nope\n---\nBody"),
            vec!["invalid_todos"]
        );
    }

    #[test]
    fn accepts_crlf_frontmatter() {
        let content = "---\r\nname: Plan\r\noverview: Overview\r\ntodos: []\r\n---\r\nBody";
        assert!(diagnose_plan_artifact(content).is_empty());
    }
}
