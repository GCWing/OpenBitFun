//! Core adapters for product-domain function-agent ports.

use std::path::PathBuf;
use std::sync::Arc;

use log::{debug, error, warn};
use openbitfun_product_domains::function_agents::git_func_agent::{
    parse_commit_ai_response, prepare_commit_ai_prompt, AICommitAnalysis, CommitMessageOptions,
    ProjectContext,
};
use openbitfun_product_domains::function_agents::ports::{
    CommitAiAnalysisRequest, FunctionAgentAiPort, FunctionAgentFuture, FunctionAgentGitPort,
    GitCommitSnapshot,
};
use openbitfun_services_integrations::function_agents::FunctionAgentGitService;

use crate::function_agents::common::{AgentError, AgentResult};
use crate::infrastructure::ai::{AIClient, AIClientFactory};
use crate::util::types::Message;

pub struct CoreCommitAiAnalysisService {
    ai_client: Arc<AIClient>,
}

impl CoreCommitAiAnalysisService {
    pub async fn new_with_task_config(factory: Arc<AIClientFactory>) -> AgentResult<Self> {
        let ai_client = match factory.get_git_commit_task_client().await {
            Ok(client) => client,
            Err(e) => {
                error!("Failed to get AI client: {}", e);
                return Err(AgentError::internal_error(format!(
                    "Failed to get AI client: {}",
                    e
                )));
            }
        };

        Ok(Self { ai_client })
    }

    pub async fn generate_commit_message_ai(
        &self,
        diff_content: &str,
        project_context: &ProjectContext,
        options: &CommitMessageOptions,
    ) -> AgentResult<AICommitAnalysis> {
        if diff_content.is_empty() {
            return Err(AgentError::invalid_input("Code changes are empty"));
        }

        let prepared_prompt = prepare_commit_ai_prompt(diff_content, project_context, options);
        if prepared_prompt.truncated {
            warn!(
                "Diff too large ({} chars), truncating to {} chars",
                diff_content.len(),
                50_000
            );
        }

        let ai_response = self.call_ai(&prepared_prompt.prompt).await?;

        self.parse_commit_response(&ai_response)
    }

    async fn call_ai(&self, prompt: &str) -> AgentResult<String> {
        debug!("Sending request to AI: prompt_length={}", prompt.len());

        let messages = vec![Message::user(prompt.to_string())];
        let response = self
            .ai_client
            .send_message(messages, None)
            .await
            .map_err(|e| {
                error!("AI call failed: {}", e);
                AgentError::internal_error(format!("AI call failed: {}", e))
            })?;

        debug!(
            "AI response received: response_length={}",
            response.text.len()
        );

        if response.text.is_empty() {
            error!("AI response is empty");
            Err(AgentError::internal_error(
                "AI response is empty".to_string(),
            ))
        } else {
            Ok(response.text)
        }
    }

    fn parse_commit_response(&self, response: &str) -> AgentResult<AICommitAnalysis> {
        parse_commit_ai_response(response)
    }
}

#[derive(Debug, Default, Clone)]
pub struct CoreFunctionAgentGitAdapter;

impl FunctionAgentGitPort for CoreFunctionAgentGitAdapter {
    fn git_commit_snapshot(
        &self,
        repo_path: PathBuf,
    ) -> FunctionAgentFuture<'_, GitCommitSnapshot> {
        Box::pin(async move { FunctionAgentGitService::git_commit_snapshot(repo_path).await })
    }
}

#[derive(Clone)]
pub struct CoreFunctionAgentAiAdapter {
    factory: Arc<AIClientFactory>,
}

impl CoreFunctionAgentAiAdapter {
    pub fn new(factory: Arc<AIClientFactory>) -> Self {
        Self { factory }
    }
}

impl FunctionAgentAiPort for CoreFunctionAgentAiAdapter {
    fn analyze_commit(
        &self,
        request: CommitAiAnalysisRequest,
    ) -> FunctionAgentFuture<'_, AICommitAnalysis> {
        let factory = self.factory.clone();
        Box::pin(async move {
            let service = CoreCommitAiAnalysisService::new_with_task_config(factory).await?;
            service
                .generate_commit_message_ai(
                    &request.diff_content,
                    &request.project_context,
                    &request.options,
                )
                .await
        })
    }
}

#[cfg(test)]
mod tests {
    use openbitfun_product_domains::function_agents::ports::FunctionAgentGitPort;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use crate::function_agents::common::AgentErrorType;
    use crate::product_domain_runtime::CoreProductDomainRuntime;
    use crate::util::types::AIConfig;

    use super::{CoreCommitAiAnalysisService, CoreFunctionAgentGitAdapter};

    fn test_ai_client() -> Arc<super::AIClient> {
        Arc::new(super::AIClient::new(AIConfig {
            name: "test".to_string(),
            base_url: "http://127.0.0.1".to_string(),
            request_url: "http://127.0.0.1".to_string(),
            api_key: "test".to_string(),
            model: "test-model".to_string(),
            format: "openai".to_string(),
            context_window: 8192,
            max_tokens: None,
            max_images_per_request: None,
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        }))
    }

    #[test]
    fn parse_commit_response_preserves_product_domain_response_policy() {
        let service = CoreCommitAiAnalysisService {
            ai_client: test_ai_client(),
        };
        let parsed = service
            .parse_commit_response(
                r#"The answer is:
```json
{
  "type": "refactor",
  "title": "refactor(product-domains): add runtime baseline",
  "body": "Keep behavior stable.",
  "confidence": 0.91
}
```
"#,
            )
            .unwrap();

        assert_eq!(
            parsed.title,
            "refactor(product-domains): add runtime baseline"
        );
        assert_eq!(parsed.body.as_deref(), Some("Keep behavior stable."));
        assert_eq!(parsed.confidence, 0.91);

        let missing_json = service.parse_commit_response("no json here").unwrap_err();
        assert_eq!(missing_json.error_type, AgentErrorType::AnalysisError);
        assert_eq!(missing_json.message, "Cannot extract JSON from response");

        let missing_title = service
            .parse_commit_response(r#"{"type":"refactor","body":"missing title"}"#)
            .unwrap_err();
        assert_eq!(missing_title.error_type, AgentErrorType::AnalysisError);
        assert_eq!(missing_title.message, "Missing title field");
    }

    struct TestTempDir {
        path: PathBuf,
    }

    impl TestTempDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "openbitfun-function-agent-port-{}-{}",
                label,
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestTempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[tokio::test]
    async fn git_adapter_builds_commit_snapshot_from_existing_core_git_services() {
        let repo = TestTempDir::new("commit-snapshot");
        init_git_repo(repo.path());
        fs::write(
            repo.path().join("Cargo.toml"),
            "[package]\nname = \"demo\"\n",
        )
        .unwrap();
        fs::create_dir_all(repo.path().join("src")).unwrap();
        fs::write(repo.path().join("src/lib.rs"), "pub fn demo() {}\n").unwrap();
        git(repo.path(), &["add", "Cargo.toml", "src/lib.rs"]);

        let adapter = CoreFunctionAgentGitAdapter;
        let snapshot = adapter
            .git_commit_snapshot(repo.path().to_path_buf())
            .await
            .unwrap();

        assert!(snapshot.staged_paths.contains(&"Cargo.toml".to_string()));
        assert!(snapshot.staged_paths.contains(&"src/lib.rs".to_string()));
        assert_eq!(snapshot.staged_count, 2);
        assert_eq!(snapshot.unstaged_count, 0);
        assert!(snapshot.diff_content.contains("pub fn demo()"));
        assert_eq!(snapshot.project_context.project_type, "rust-application");
    }

    #[tokio::test]
    async fn git_adapter_commit_snapshot_keeps_staged_diff_and_unstaged_count_separate() {
        let repo = TestTempDir::new("commit-snapshot-boundary");
        init_git_repo(repo.path());
        fs::write(repo.path().join("tracked.txt"), "base\n").unwrap();
        git(repo.path(), &["add", "tracked.txt"]);
        git(repo.path(), &["commit", "-m", "initial"]);

        fs::write(repo.path().join("tracked.txt"), "base\nunstaged only\n").unwrap();
        fs::write(repo.path().join("staged.txt"), "staged only\n").unwrap();
        git(repo.path(), &["add", "staged.txt"]);

        let adapter = CoreFunctionAgentGitAdapter;
        let snapshot = adapter
            .git_commit_snapshot(repo.path().to_path_buf())
            .await
            .unwrap();

        assert_eq!(snapshot.staged_paths, vec!["staged.txt".to_string()]);
        assert_eq!(snapshot.staged_count, 1);
        assert_eq!(snapshot.unstaged_count, 1);
        assert!(snapshot.diff_content.contains("staged.txt"));
        assert!(snapshot.diff_content.contains("staged only"));
        assert!(!snapshot.diff_content.contains("unstaged only"));
    }

    #[test]
    fn core_product_domain_runtime_owner_constructs_function_agent_git_adapter() {
        let _adapter = CoreProductDomainRuntime::function_agent_git_adapter();
    }

    fn init_git_repo(repo: &std::path::Path) {
        git(repo, &["init", "-b", "main"]);
        git(repo, &["config", "user.email", "test@example.com"]);
        git(repo, &["config", "user.name", "OpenBitFun Test"]);
    }

    fn git(repo: &std::path::Path, args: &[&str]) {
        let output = crate::util::create_test_command("git")
            .args(args)
            .current_dir(repo)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed\nstdout={}\nstderr={}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
