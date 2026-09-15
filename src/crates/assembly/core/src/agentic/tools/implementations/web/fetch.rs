use super::readable::{
    extract_html_title, extract_markdown_with_text_fallback, is_html, normalize_requested_format,
    RequestedFormat,
};
use crate::agentic::tools::framework::{
    PermissionIntent, Tool, ToolResult, ToolUseContext, ValidationResult,
};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use openbitfun_services_integrations::web_tools::WebToolNetworkProvider;
use serde_json::{json, Value};

/// WebFetch tool
pub struct WebFetchTool;

impl Default for WebFetchTool {
    fn default() -> Self {
        Self::new()
    }
}

impl WebFetchTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for WebFetchTool {
    fn name(&self) -> &str {
        "WebFetch"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(r#"Fetch content from a URL.

Use this tool to:
- Read documentation from websites
- Fetch API responses
- Download readable content from web pages
- Access online resources

Best for static pages that need no login. For pages requiring the user's login session or JavaScript rendering, use ControlHub domain="browser" instead: connect -> navigate -> snapshot / read_article. Chrome 144+ and Edge can connect to the user's current profile after explicit approval, preserving tabs and login state; other supported Chromium browsers reuse a real-profile endpoint when available and otherwise use OpenBitFun's persistent managed profile. (browser.fetch only works when a session is already connected and the current page is same-origin with the target URL — it runs inside that page and is subject to its CORS policy.)

Supports different output formats:
- raw: Raw response content (original HTML or text)
- markdown: Readable content mode. For HTML pages, OpenBitFun extracts the main content and returns markdown when possible, automatically falling back to plain text when markdown conversion is not reliable.
- json: Parse JSON responses

Example usage:
- Fetch raw HTML: {"url": "https://example.com", "format": "raw"}
- Fetch readable content: {"url": "https://example.com/article", "format": "markdown"}
- Get API data: {"url": "https://api.example.com/data", "format": "json"}"#
            .to_string())
    }

    fn short_description(&self) -> String {
        "Fetch content from a URL in raw, markdown, or JSON format.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The URL to fetch"
                },
                "format": {
                    "type": "string",
                    "enum": ["raw", "markdown", "json"],
                    "description": "Output format. Use 'raw' for the original response, 'markdown' for readable content with automatic plain-text fallback, or 'json' for parsed JSON.",
                    "default": "markdown"
                }
            },
            "required": ["url"]
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
        let url = input
            .get("url")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .ok_or_else(|| OpenBitFunError::validation("url is required".to_string()))?;
        Ok(vec![PermissionIntent::new(
            "webfetch",
            vec![url.to_string()],
        )])
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        if let Some(url) = input.get("url").and_then(|v| v.as_str()) {
            if url.is_empty() {
                return ValidationResult {
                    result: false,
                    message: Some("URL cannot be empty".to_string()),
                    error_code: Some(400),
                    meta: None,
                };
            }

            if !url.starts_with("http://") && !url.starts_with("https://") {
                return ValidationResult {
                    result: false,
                    message: Some("URL must start with http:// or https://".to_string()),
                    error_code: Some(400),
                    meta: None,
                };
            }
        } else {
            return ValidationResult {
                result: false,
                message: Some("url is required".to_string()),
                error_code: Some(400),
                meta: None,
            };
        }

        ValidationResult {
            result: true,
            message: None,
            error_code: None,
            meta: None,
        }
    }

    async fn call_impl(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let url = input
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| OpenBitFunError::tool("url is required".to_string()))?;

        let requested_format =
            normalize_requested_format(input.get("format").and_then(|v| v.as_str()))?;

        let response = WebToolNetworkProvider::fetch_text(url)
            .await
            .map_err(|error| OpenBitFunError::tool(error.to_string()))?;
        let content_type = response.content_type;
        let content = response.content;

        let is_html_response = is_html(content_type.as_deref(), &content);
        let fallback_title = if is_html_response {
            extract_html_title(&content)
        } else {
            None
        };

        let (processed_content, content_representation, extractor, title) = match requested_format {
            RequestedFormat::Raw => (content, "raw", "raw", fallback_title),
            RequestedFormat::Json => {
                serde_json::from_str::<Value>(&content)
                    .map_err(|e| OpenBitFunError::tool(format!("Invalid JSON response: {}", e)))?;
                (content, "json", "json", None)
            }
            RequestedFormat::Markdown => {
                if is_html_response {
                    let readable = extract_markdown_with_text_fallback(&content, url)?;
                    (
                        readable.content,
                        readable.content_representation,
                        readable.extractor,
                        readable.title,
                    )
                } else {
                    (content, "plain_text", "plain_text", None)
                }
            }
        };

        let result = ToolResult::Result {
            data: json!({
                "url": url,
                "title": title,
                "format": match requested_format {
                    RequestedFormat::Raw => "raw",
                    RequestedFormat::Markdown => "markdown",
                    RequestedFormat::Json => "json",
                },
                "content_representation": content_representation,
                "extractor": extractor,
                "content": processed_content,
                "content_length": processed_content.len()
            }),
            result_for_assistant: Some(processed_content),
            image_attachments: None,
        };

        Ok(vec![result])
    }
}
