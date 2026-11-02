use anyhow::{anyhow, Context};
use std::collections::HashSet;
use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct MarketConfig {
    pub bind: SocketAddr,
    pub public_base_url: String,
    pub database_path: PathBuf,
    pub artifact_dir: PathBuf,
    pub web_dir: PathBuf,
    pub github_callback_url: Option<String>,
    pub github_client_id: Option<String>,
    pub github_client_secret: Option<String>,
    pub session_secret: String,
    pub admin_github_ids: HashSet<i64>,
    pub public_browse: bool,
    pub web_submissions_enabled: bool,
}

impl MarketConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        let bind = env::var("MARKET_BIND")
            .unwrap_or_else(|_| "127.0.0.1:9710".to_string())
            .parse()
            .context("MARKET_BIND must be a socket address")?;
        let public_base_url = env::var("MARKET_PUBLIC_BASE_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:9710/miniapp".to_string())
            .trim_end_matches('/')
            .to_string();
        let data_dir = PathBuf::from(
            env::var("MARKET_DATA_DIR").unwrap_or_else(|_| "./var/miniapp-market/data".to_string()),
        );
        let database_path = env::var("MARKET_DATABASE_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| data_dir.join("market.sqlite"));
        let artifact_dir = PathBuf::from(
            env::var("MARKET_ARTIFACT_DIR")
                .unwrap_or_else(|_| "./var/miniapp-market/artifacts".to_string()),
        );
        let web_dir = PathBuf::from(
            env::var("MARKET_WEB_DIR")
                .unwrap_or_else(|_| "./src/miniapp-market-web/dist".to_string()),
        );
        let session_secret = env::var("MARKET_SESSION_SECRET")
            .unwrap_or_else(|_| "development-only-change-me".to_string());
        if session_secret.len() < 24 && !cfg!(debug_assertions) {
            return Err(anyhow!(
                "MARKET_SESSION_SECRET must contain at least 24 characters"
            ));
        }
        let admin_github_ids =
            parse_admin_github_ids(&env::var("MARKET_ADMIN_GITHUB_IDS").unwrap_or_default());
        let public_browse = env::var("MARKET_PUBLIC_BROWSE")
            .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes"))
            .unwrap_or(true);
        let web_submissions_enabled = env::var("MARKET_WEB_SUBMISSIONS_ENABLED")
            .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes"))
            .unwrap_or(false);

        Ok(Self {
            bind,
            public_base_url,
            database_path,
            artifact_dir,
            web_dir,
            github_callback_url: non_empty_env("MARKET_GITHUB_CALLBACK_URL"),
            github_client_id: non_empty_env("MARKET_GITHUB_CLIENT_ID"),
            github_client_secret: non_empty_env("MARKET_GITHUB_CLIENT_SECRET"),
            session_secret,
            admin_github_ids,
            public_browse,
            web_submissions_enabled,
        })
    }

    pub fn github_configured(&self) -> bool {
        self.github_client_id.is_some() && self.github_client_secret.is_some()
    }

    pub fn github_callback_url(&self) -> String {
        self.github_callback_url
            .clone()
            .unwrap_or_else(|| format!("{}/api/v1/auth/github/callback", self.public_base_url))
    }

    /// Public origin that serves the shared sign-in and completion pages.
    ///
    /// Prefer the callback origin when configured, so a deployment can keep the
    /// auth facade on its own hostname. Otherwise the market origin is used.
    pub fn auth_base_url(&self) -> String {
        self.github_callback_url
            .as_deref()
            .and_then(origin_of)
            .or_else(|| origin_of(&self.public_base_url))
            .unwrap_or_else(|| self.public_base_url.trim_end_matches('/').to_string())
    }
}

fn origin_of(raw: &str) -> Option<String> {
    let mut url = url::Url::parse(raw).ok()?;
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    Some(url.as_str().trim_end_matches('/').to_string())
}

fn parse_admin_github_ids(raw: &str) -> HashSet<i64> {
    raw.split(',')
        .filter_map(|value| value.trim().parse::<i64>().ok())
        .collect()
}

fn non_empty_env(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_ids_are_empty_without_an_explicit_deployment_setting() {
        assert!(parse_admin_github_ids("").is_empty());
        assert!(parse_admin_github_ids(" , ").is_empty());
    }

    #[test]
    fn admin_ids_parse_comma_separated_values() {
        assert_eq!(
            parse_admin_github_ids(" 42, 0,not-a-number,7 "),
            HashSet::from([42, 0, 7])
        );
    }

    #[test]
    fn origin_of_strips_path_query_and_fragment() {
        assert_eq!(
            origin_of("https://auth.example.com/api/v1/auth/github/callback?x=1#frag").as_deref(),
            Some("https://auth.example.com")
        );
        assert_eq!(
            origin_of("http://127.0.0.1:9710/miniapp").as_deref(),
            Some("http://127.0.0.1:9710")
        );
        assert_eq!(origin_of("not a url"), None);
    }
}
