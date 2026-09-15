use crate::agentic::tools::framework::{PermissionIntent, Tool, ToolResult, ToolUseContext};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use log::{error, info};
use openbitfun_runtime_ports::{WebSearchRequest, WebSearchResult};
use serde_json::{json, Value};

const DEFAULT_RESULTS: u64 = 10;
const MAX_RESULTS: u64 = 20;

pub struct WebSearchTool;

impl Default for WebSearchTool {
    fn default() -> Self {
        Self::new()
    }
}

impl WebSearchTool {
    pub fn new() -> Self {
        Self
    }
}

fn search_result_to_value(result: WebSearchResult) -> Value {
    let mut value = serde_json::Map::from_iter([
        ("title".to_string(), Value::String(result.title)),
        ("url".to_string(), Value::String(result.url)),
    ]);
    if let Some(published) = result.published_at {
        value.insert("published".to_string(), Value::String(published));
    }
    if let Some(author) = result.author {
        value.insert("author".to_string(), Value::String(author));
    }
    Value::Object(value)
}

pub(super) fn build_web_search_tool_result(
    query: &str,
    provider: &str,
    results: Vec<WebSearchResult>,
) -> ToolResult {
    let result_values = results
        .iter()
        .cloned()
        .map(search_result_to_value)
        .collect::<Vec<_>>();
    let formatted_results = results
        .iter()
        .enumerate()
        .map(|(index, result)| {
            let mut lines = vec![
                format!("{}. {}", index + 1, result.title),
                format!("   URL: {}", result.url),
            ];
            if let Some(published) = result.published_at.as_deref() {
                lines.push(format!("   Published: {published}"));
            }
            if let Some(author) = result.author.as_deref() {
                lines.push(format!("   Author: {author}"));
            }
            lines.join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    ToolResult::Result {
        data: json!({
            "query": query,
            "results": result_values,
            "result_count": result_values.len(),
            "provider": provider
        }),
        result_for_assistant: Some(format!(
            "Search query: '{}'\nFound {} results:\n\n{}",
            query,
            result_values.len(),
            formatted_results
        )),
        image_attachments: None,
    }
}

#[async_trait]
impl Tool for WebSearchTool {
    fn name(&self) -> &str {
        "WebSearch"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok("Search the web for up-to-date information and sources.".to_string())
    }

    fn short_description(&self) -> String {
        "Search the web for up-to-date information and sources.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query (recommended max 70 characters)"
                },
                "num_results": {
                    "type": "number",
                    "description": "Number of search results to return (1-20, default: 10)",
                    "default": 10,
                    "minimum": 1,
                    "maximum": 20
                }
            },
            "required": ["query"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    fn permission_intents(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        let query = input
            .get("query")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|query| !query.is_empty())
            .ok_or_else(|| OpenBitFunError::validation("query is required".to_string()))?;
        Ok(vec![PermissionIntent::new(
            "websearch",
            vec![query.to_string()],
        )])
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let query = input
            .get("query")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|query| !query.is_empty())
            .ok_or_else(|| OpenBitFunError::tool("query is required".to_string()))?;
        let num_results = input
            .get("num_results")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_RESULTS)
            .clamp(1, MAX_RESULTS);
        let provider = context
            .runtime_handles
            .web_search_provider()
            .cloned()
            .ok_or_else(|| {
                OpenBitFunError::tool(
                    "WebSearch provider is unavailable in this runtime".to_string(),
                )
            })?;

        info!("WebSearch call started: max_results={num_results}");
        let response = provider
            .search(WebSearchRequest {
                query: query.to_string(),
                max_results: num_results as u32,
            })
            .await
            .map_err(|search_error| {
                error!(
                    "WebSearch provider failed: provider={}, kind={:?}, error={}",
                    search_error.provider, search_error.kind, search_error.message
                );
                OpenBitFunError::tool(search_error.to_string())
            })?;
        info!(
            "WebSearch call completed: provider={}, result_count={}",
            response.provider,
            response.results.len()
        );
        Ok(vec![build_web_search_tool_result(
            query,
            response.provider.as_str(),
            response.results,
        )])
    }
}
