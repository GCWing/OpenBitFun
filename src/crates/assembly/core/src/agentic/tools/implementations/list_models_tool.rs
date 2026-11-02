//! ListModels tool implementation.

use crate::agentic::tools::framework::{
    Tool, ToolExposure, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::service::config::global::GlobalConfigManager;
use crate::service::config::types::{AIConfig, AIModelConfig};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use serde_json::{json, Value};

/// Lists enabled OpenBitFun model configurations, optionally filtered by a fuzzy query.
pub struct ListModelsTool;

impl Default for ListModelsTool {
    fn default() -> Self {
        Self::new()
    }
}

impl ListModelsTool {
    pub fn new() -> Self {
        Self
    }
}

fn normalized_terms(query: &str) -> Vec<String> {
    query
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| !term.is_empty())
        .map(|term| term.to_lowercase())
        .collect()
}

fn normalized_field(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn fuzzy_match_score(term: &str, field: &str) -> Option<usize> {
    if field == term {
        return Some(0);
    }
    if field.starts_with(term) {
        return Some(100 + field.len().saturating_sub(term.len()));
    }
    if let Some(position) = field.find(term) {
        return Some(1_000 + position);
    }

    let mut next_index = 0;
    let mut gaps = 0;
    for character in term.chars() {
        let Some(found) = field[next_index..].find(character) else {
            return None;
        };
        gaps += found;
        next_index += found + character.len_utf8();
    }

    Some(10_000 + gaps)
}

fn model_match_score(model: &AIModelConfig, terms: &[String]) -> Option<usize> {
    if terms.is_empty() {
        return Some(0);
    }

    let fields = [
        normalized_field(&model.name),
        normalized_field(&model.id),
        normalized_field(&model.model_name),
    ];

    terms.iter().try_fold(0usize, |score, term| {
        fields
            .iter()
            .filter_map(|field| fuzzy_match_score(term, field))
            .min()
            .map(|term_score| score + term_score)
    })
}

fn resolved_default_selector(query: Option<&str>) -> Option<&str> {
    match query.map(str::trim) {
        Some("primary") => Some("primary"),
        Some("fast") => Some("fast"),
        _ => None,
    }
}

fn escape_markdown_table_cell(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace(['\r', '\n'], "<br>")
}

fn build_list_models_result(config: &AIConfig, query: Option<&str>) -> (Value, String) {
    let terms = query.map(normalized_terms).unwrap_or_default();
    let selected_model_id = resolved_default_selector(query)
        .and_then(|selector| config.resolve_model_selection(selector));
    let mut matches = config
        .models
        .iter()
        .enumerate()
        .filter(|(_, model)| model.enabled)
        .filter_map(|(index, model)| {
            let score = match selected_model_id.as_deref() {
                Some(model_id) => (model.id == model_id).then_some(0),
                None => model_match_score(model, &terms),
            }?;
            Some((score, index, model))
        })
        .collect::<Vec<_>>();
    matches.sort_by_key(|(score, index, _)| (*score, *index));

    let models = matches
        .into_iter()
        .map(|(_, _, model)| {
            json!({
                "provider_name": model.name,
                "model_id": model.id,
                "model_name": model.model_name,
            })
        })
        .collect::<Vec<_>>();

    let assistant_result = if models.is_empty() {
        match query.filter(|value| !value.trim().is_empty()) {
            Some(query) => format!("No enabled OpenBitFun models matched '{}'.", query.trim()),
            None => "No enabled OpenBitFun models are configured.".to_string(),
        }
    } else {
        let rows =
            models
                .iter()
                .map(|model| {
                    format!(
                        "| {} | {} | {} |",
                        escape_markdown_table_cell(
                            model["provider_name"].as_str().unwrap_or_default(),
                        ),
                        escape_markdown_table_cell(model["model_id"].as_str().unwrap_or_default()),
                        escape_markdown_table_cell(
                            model["model_name"].as_str().unwrap_or_default()
                        ),
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
        format!("| provider_name | model_id | model_name |\n| --- | --- | --- |\n{rows}")
    };

    (
        json!({
            "success": true,
            "query": query.filter(|value| !value.trim().is_empty()),
            "match_count": models.len(),
            "models": models,
        }),
        assistant_result,
    )
}

#[async_trait]
impl Tool for ListModelsTool {
    fn name(&self) -> &str {
        "ListModels"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok("List enabled OpenBitFun models as provider_name, model_id, and model_name. Use `query` to filter models; exact `primary` or `fast` resolves that default selector.".to_string())
    }

    fn short_description(&self) -> String {
        "List enabled OpenBitFun models.".to_string()
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Optional search term. Omit for all enabled models."
                }
            },
            "additionalProperties": false
        })
    }

    fn output_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "success": {"type": "boolean"},
                "query": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                "match_count": {"type": "integer"},
                "models": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "provider_name": {"type": "string"},
                            "model_id": {"type": "string"},
                            "model_name": {"type": "string"}
                        },
                        "required": ["provider_name", "model_id", "model_name"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["success", "query", "match_count", "models"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        if !input.is_object() {
            return ValidationResult {
                result: false,
                message: Some("Input must be an object.".to_string()),
                error_code: None,
                meta: None,
            };
        }
        if input.get("query").is_some_and(|query| !query.is_string()) {
            return ValidationResult {
                result: false,
                message: Some("query must be a string when provided.".to_string()),
                error_code: None,
                meta: None,
            };
        }

        ValidationResult::default()
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        match input.get("query").and_then(Value::as_str) {
            Some(query) if !query.trim().is_empty() => {
                format!("Find enabled OpenBitFun models matching {}", query.trim())
            }
            _ => "List enabled OpenBitFun models".to_string(),
        }
    }

    fn render_tool_result_message(&self, output: &Value) -> String {
        let count = output
            .get("match_count")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        format!("Found {count} enabled model(s)")
    }

    async fn call_impl(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let service = GlobalConfigManager::get_service().await.map_err(|_| {
            OpenBitFunError::tool("OpenBitFun model configuration is unavailable.".to_string())
        })?;
        let config: AIConfig = service.get_config(Some("ai")).await.map_err(|_| {
            OpenBitFunError::tool("OpenBitFun model configuration could not be loaded.".to_string())
        })?;
        let query = input.get("query").and_then(Value::as_str);
        let (data, result_for_assistant) = build_list_models_result(&config, query);

        Ok(vec![ToolResult::ok(data, Some(result_for_assistant))])
    }
}

#[cfg(test)]
mod tests {
    use super::build_list_models_result;
    use crate::service::config::types::{AIConfig, AIModelConfig};

    fn model(
        id: &str,
        provider: &str,
        model_name: &str,
        provider_name: &str,
        enabled: bool,
    ) -> AIModelConfig {
        AIModelConfig {
            id: id.to_string(),
            provider: provider.to_string(),
            model_name: model_name.to_string(),
            name: provider_name.to_string(),
            enabled,
            ..Default::default()
        }
    }

    fn configured_models() -> AIConfig {
        let mut config = AIConfig::default();
        config.models = vec![
            model("main-gpt", "openai", "gpt-5-mini", "OpenAI", true),
            model(
                "claude-fast",
                "anthropic",
                "claude-3-7-sonnet",
                "Anthropic",
                true,
            ),
            model("disabled-gpt", "openai", "gpt-5", "OpenAI", false),
        ];
        config.default_models.primary = Some("main-gpt".to_string());
        config.default_models.fast = Some("claude-fast".to_string());
        config
    }

    #[test]
    fn filters_to_enabled_fuzzy_matches() {
        let (data, assistant_result) = build_list_models_result(&configured_models(), Some("g5m"));

        let models = data["models"].as_array().expect("models array");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["model_id"], "main-gpt");
        assert_eq!(models[0]["provider_name"], "OpenAI");
        assert_eq!(models[0]["model_name"], "gpt-5-mini");
        assert!(assistant_result.contains("| provider_name | model_id | model_name |"));
        assert!(assistant_result.contains("| OpenAI | main-gpt | gpt-5-mini |"));
    }

    #[test]
    fn resolves_primary_and_fast_only_for_exact_selector_queries() {
        let config = configured_models();

        let (primary, _) = build_list_models_result(&config, Some("primary"));
        let (fast, _) = build_list_models_result(&config, Some("fast"));
        let (non_exact, _) = build_list_models_result(&config, Some("Primary"));

        assert_eq!(primary["models"][0]["model_id"], "main-gpt");
        assert_eq!(fast["models"][0]["model_id"], "claude-fast");
        assert!(non_exact["models"].as_array().is_some_and(Vec::is_empty));
    }

    #[test]
    fn matches_multiple_terms_across_model_fields() {
        let (data, assistant_result) =
            build_list_models_result(&configured_models(), Some("anth sonnet"));

        let models = data["models"].as_array().expect("models array");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["model_id"], "claude-fast");
        assert!(assistant_result.contains("Anthropic"));
        assert!(!assistant_result.contains("GPT-5 Mini"));
    }

    #[test]
    fn empty_query_lists_all_enabled_models_without_disabled_entries() {
        let (data, assistant_result) = build_list_models_result(&configured_models(), None);

        let models = data["models"].as_array().expect("models array");
        assert_eq!(models.len(), 2);
        assert_eq!(data["match_count"], 2);
        assert!(assistant_result.starts_with("| provider_name | model_id | model_name |"));
        assert!(!assistant_result.contains("| OpenAI | disabled-gpt | gpt-5 |"));
    }
}
