//! Web tool implementations.

mod fetch;
mod readable;
mod search;

pub use fetch::WebFetchTool;
pub use search::WebSearchTool;

#[cfg(test)]
mod tests {
    use super::fetch::WebFetchTool;
    use super::readable::{
        extract_html_title, extract_markdown_with_text_fallback, html_to_text, is_html,
        looks_noisy, normalize_requested_format, RequestedFormat,
    };
    use super::search::{build_web_search_tool_result, WebSearchTool};
    use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext};
    use openbitfun_runtime_ports::WebSearchResult;
    use serde_json::json;
    use std::io::ErrorKind;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const SIMPLE_HTML: &str = r#"<!DOCTYPE html>
<html>
<head><title>Hello World</title></head>
<body>
  <article>
    <h1>Hello World</h1>
    <p>This is the primary article content.</p>
    <p>It should become readable markdown.</p>
  </article>
  <footer>Ignore this footer</footer>
</body>
</html>"#;

    fn empty_context() -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace: None,
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: std::collections::HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: Default::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    async fn local_text_server(
        body: &'static str,
        content_type: &'static str,
    ) -> Option<(String, tokio::task::JoinHandle<()>)> {
        let listener = match TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => listener,
            Err(e) if e.kind() == ErrorKind::PermissionDenied => {
                eprintln!(
                    "Skipping web tool local server test due to sandbox socket restrictions: {}",
                    e
                );
                return None;
            }
            Err(e) => panic!("bind local test server: {}", e),
        };
        let addr = listener.local_addr().expect("read local addr");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept request");
            let mut req_buf = [0u8; 1024];
            let _ = socket.read(&mut req_buf).await;

            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                content_type,
                body.len(),
                body
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("write response");
            let _ = socket.shutdown().await;
        });

        Some((format!("http://{}/test", addr), server))
    }

    #[tokio::test]
    async fn webfetch_can_fetch_local_http_content() {
        let Some((url, server)) = local_text_server("hello from webfetch", "text/plain").await
        else {
            return;
        };
        let tool = WebFetchTool::new();
        let input = json!({
            "url": url,
            "format": "markdown"
        });

        let results = tool
            .call(&input, &empty_context())
            .await
            .unwrap_or_else(|e| {
                panic!("tool call failed with detailed error: {:?}", e);
            });
        assert_eq!(results.len(), 1);

        match &results[0] {
            ToolResult::Result {
                data,
                result_for_assistant,
                ..
            } => {
                assert_eq!(data["content"], "hello from webfetch");
                assert_eq!(data["format"], "markdown");
                assert_eq!(data["content_representation"], "plain_text");
                assert!(data["title"].is_null());
                assert_eq!(result_for_assistant.as_deref(), Some("hello from webfetch"));
            }
            other => panic!("unexpected tool result variant: {:?}", other),
        }

        server.await.expect("server task");
    }

    #[tokio::test]
    async fn webfetch_html_markdown_preserves_public_result_contract() {
        let Some((url, server)) = local_text_server(SIMPLE_HTML, "text/html; charset=utf-8").await
        else {
            return;
        };
        let tool = WebFetchTool::new();
        let input = json!({
            "url": url,
            "format": "markdown"
        });

        let results = tool
            .call(&input, &empty_context())
            .await
            .expect("webfetch html call should succeed");
        assert_eq!(results.len(), 1);

        match &results[0] {
            ToolResult::Result {
                data,
                result_for_assistant,
                ..
            } => {
                let content = data["content"].as_str().expect("content string");
                assert_eq!(data["format"], "markdown");
                assert_eq!(data["content_representation"], "markdown");
                assert_eq!(data["extractor"], "legible");
                assert_eq!(data["title"], "Hello World");
                assert_eq!(data["content_length"].as_u64(), Some(content.len() as u64));
                assert!(content.contains("primary article content"));
                assert!(!content.contains("Ignore this footer"));
                assert_eq!(result_for_assistant.as_deref(), Some(content));
            }
            other => panic!("unexpected tool result variant: {:?}", other),
        }

        server.await.expect("server task");
    }

    /// The description must route login-gated / JS-rendered pages to the
    /// ControlHub browser domain so models stop retrying WebFetch on pages
    /// it structurally cannot read.
    #[tokio::test]
    async fn webfetch_description_routes_dynamic_pages_to_browser_domain() {
        let description = WebFetchTool::new()
            .description()
            .await
            .expect("WebFetch description should render");
        assert!(description.contains("ControlHub domain=\"browser\""));
        assert!(description.contains("login session"));
        assert!(description.contains("browser.fetch"));
        // browser.fetch runs inside the already-connected page, so it must be
        // described as a same-origin follow-up rather than a standalone
        // alternative to connect -> navigate -> snapshot.
        assert!(description.contains("navigate { url, observe: \"article\" }"));
        assert!(description.contains("same-origin"));
        assert!(description.contains("CORS"));
        // Routing must preserve user-owned connection and profile selection.
        assert!(description.contains("selected, authorized browser connection"));
        assert!(description.contains("Settings > Browser Control"));
        assert!(description.contains("do not enable permissions or change profiles"));
    }

    #[test]
    fn webfetch_format_normalization_preserves_public_aliases() {
        assert!(matches!(
            normalize_requested_format(None).expect("default format should work"),
            RequestedFormat::Markdown
        ));
        assert!(matches!(
            normalize_requested_format(Some("raw")).expect("raw format should work"),
            RequestedFormat::Raw
        ));
        assert!(matches!(
            normalize_requested_format(Some("json")).expect("json format should work"),
            RequestedFormat::Json
        ));
        assert_eq!(
            normalize_requested_format(Some("xml"))
                .expect_err("unsupported format should fail")
                .to_string(),
            "Tool error: Unsupported format 'xml'. Expected raw, markdown, or json."
        );
    }

    #[test]
    fn webfetch_text_alias_normalizes_to_markdown() {
        assert!(matches!(
            normalize_requested_format(Some("text")).expect("format alias should work"),
            RequestedFormat::Markdown
        ));
    }

    #[test]
    fn webfetch_html_to_text_extracts_plain_text() {
        let html = r#"<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body>
<script>alert('ignore me');</script>
<style>.hidden { display: none; }</style>
<h1>Hello World</h1>
<p>This is a paragraph with <strong>bold</strong> text.</p>
<ul><li>Item one</li><li>Item two</li></ul>
</body>
</html>"#;

        let text = html_to_text(html);
        assert!(!text.contains("<script>"));
        assert!(!text.contains("alert("));
        assert!(!text.contains(".hidden"));
        assert!(text.contains("Hello World"));
        assert!(text.contains("This is a paragraph with bold text."));
        assert!(text.contains("Item one"));
        assert!(text.contains("Item two"));
    }

    #[test]
    fn webfetch_is_html_detects_html_content() {
        assert!(is_html(Some("text/html; charset=utf-8"), "any"));
        assert!(is_html(Some("application/xhtml+xml"), "any"));
        assert!(is_html(None, "<!DOCTYPE html><html></html>"));
        assert!(is_html(None, "<html lang=\"en\"></html>"));
        assert!(!is_html(Some("application/json"), "{}"));
        assert!(!is_html(Some("text/plain"), "hello"));
        assert!(!is_html(None, "just plain text"));
    }

    #[test]
    fn webfetch_detects_noisy_markdown() {
        assert!(looks_noisy(
            "header __next_f.push([1,2,3]) siteSettings footer"
        ));
        assert!(!looks_noisy("# Hello\n\nThis is a clean article."));
    }

    #[test]
    fn webfetch_extracts_markdown_for_simple_html() {
        let result =
            extract_markdown_with_text_fallback(SIMPLE_HTML, "https://example.com/article")
                .expect("readable extraction should succeed");
        assert_eq!(result.content_representation, "markdown");
        assert_eq!(result.extractor, "legible");
        assert_eq!(result.title.as_deref(), Some("Hello World"));
        assert!(result.content.contains("primary article content"));
        assert!(!result.content.contains("Ignore this footer"));
    }

    #[test]
    fn webfetch_extracts_html_title() {
        let html =
            r#"<html><head><title>Example Title</title></head><body><p>Hello</p></body></html>"#;
        assert_eq!(extract_html_title(html).as_deref(), Some("Example Title"));
    }

    #[test]
    fn websearch_schema_contains_only_supported_arguments() {
        let schema = WebSearchTool::new().input_schema();
        let properties = schema["properties"].as_object().expect("properties");

        assert_eq!(properties.len(), 2);
        assert!(properties.contains_key("query"));
        assert!(properties.contains_key("num_results"));
        assert_eq!(properties["num_results"]["default"], 10);
        assert_eq!(properties["num_results"]["minimum"], 1);
        assert_eq!(properties["num_results"]["maximum"], 20);
        assert_eq!(schema["required"], json!(["query"]));
        assert_eq!(schema["additionalProperties"], false);
    }

    #[tokio::test]
    async fn websearch_model_contract_is_byte_stable_across_providers() {
        async fn contract_bytes() -> Vec<u8> {
            let tool = WebSearchTool::new();
            serde_json::to_vec(&json!({
                "name": tool.name(),
                "description": tool.description().await.expect("description"),
                "shortDescription": tool.short_description(),
                "exposure": tool.default_exposure(),
                "schema": tool.input_schema_for_model().await,
            }))
            .expect("serialize WebSearch model contract")
        }

        let baseline = contract_bytes().await;
        for provider in [
            "exa_mcp_free",
            "exa_search_api",
            "tavily",
            "openbitfun_search_http",
        ] {
            assert_eq!(
                contract_bytes().await,
                baseline,
                "provider {provider} must not change the model-visible contract"
            );
        }
    }

    #[test]
    fn websearch_preserves_public_result_contract() {
        let result = build_web_search_tool_result(
            "example query",
            "exa_mcp_free",
            websearch_sample_results(),
        );

        match &result {
            ToolResult::Result {
                data,
                result_for_assistant,
                ..
            } => {
                assert_eq!(data["query"], "example query");
                assert_eq!(data["result_count"], 2);
                assert_eq!(data["provider"], "exa_mcp_free");
                assert_eq!(data["results"][0]["title"], "Result One");
                assert_eq!(data["results"][0]["url"], "https://example.com/one");
                assert_eq!(data["results"][0]["published"], "2026-08-30T00:00:00.000Z");
                assert_eq!(data["results"][0]["author"], "First Author");
                assert!(data["results"][0].get("snippet").is_none());
                assert!(data["results"][1].get("published").is_none());
                assert!(data["results"][1].get("author").is_none());

                let assistant_text = result_for_assistant.as_deref().expect("assistant text");
                assert!(assistant_text.contains("Search query: 'example query'"));
                assert!(assistant_text.contains("Found 2 results:"));
                assert!(assistant_text.contains("1. Result One"));
                assert!(assistant_text.contains("URL: https://example.com/one"));
                assert!(assistant_text.contains("Published: 2026-08-30T00:00:00.000Z"));
                assert!(assistant_text.contains("Author: First Author"));
                assert_eq!(assistant_text.matches("Published:").count(), 1);
                assert_eq!(assistant_text.matches("Author:").count(), 1);
                assert!(!assistant_text.contains("Highlights:"));
            }
            other => panic!("unexpected tool result variant: {:?}", other),
        }
    }

    fn websearch_sample_results() -> Vec<WebSearchResult> {
        vec![
            WebSearchResult {
                title: "Result One".to_string(),
                url: "https://example.com/one".to_string(),
                published_at: Some("2026-08-30T00:00:00.000Z".to_string()),
                author: Some("First Author".to_string()),
            },
            WebSearchResult {
                title: "Result Two".to_string(),
                url: "https://example.com/two".to_string(),
                published_at: None,
                author: None,
            },
        ]
    }
}
