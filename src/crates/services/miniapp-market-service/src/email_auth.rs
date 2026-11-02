//! Passwordless identity. Codes are bound to one browser/device authorization,
//! persisted as keyed digests, and consumed atomically with account creation.
use crate::{
    auth::{random_token, safe_return_to, AuthService, CompletedOAuth, OAuthFlowRecord},
    db::token_hash,
    error::{MarketError, MarketResult},
};
use chrono::Utc;
use hmac::{Hmac, Mac};
use lettre::{
    message::{
        header::{ContentTransferEncoding, ContentType},
        Attachment, Mailbox, MultiPart, SinglePart,
    },
    transport::smtp::authentication::Credentials,
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use rand::{rngs::OsRng, Rng};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use sqlx::Row;

#[derive(Clone)]
pub(crate) struct Mailer {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
}
impl std::fmt::Debug for Mailer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Mailer(<redacted>)")
    }
}
impl Mailer {
    pub(crate) fn from_env() -> MarketResult<Option<Self>> {
        Self::from_settings(|key| std::env::var(key).ok().filter(|s| !s.is_empty()))
    }
    fn from_settings(get: impl Fn(&str) -> Option<String>) -> MarketResult<Option<Self>> {
        let security = get("SMTP_SECURITY").unwrap_or_else(|| "ssl".into());
        let password = get("SMTP_PASSWORD");
        if security != "local" && password.is_none() {
            return Ok(None);
        }
        let username = get("SMTP_USERNAME")
            .ok_or_else(|| MarketError::internal("SMTP_USERNAME is required"))?;
        let host = get("SMTP_HOST").unwrap_or_else(|| "smtp.qiye.aliyun.com".into());
        let builder = match security.as_str() {
            "ssl" => AsyncSmtpTransport::<Tokio1Executor>::relay(&host)
                .map_err(|_| MarketError::internal("Invalid SMTP TLS configuration"))?,
            "starttls" => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host)
                .map_err(|_| MarketError::internal("Invalid SMTP TLS configuration"))?,
            "local" => {
                // Only explicitly configured same-host/isolated private relays may omit TLS.
                let private_address = host.parse::<std::net::IpAddr>().is_ok_and(|ip| match ip {
                    std::net::IpAddr::V4(ip) => ip.is_loopback() || ip.is_private(),
                    std::net::IpAddr::V6(ip) => ip.is_loopback(),
                });
                if !private_address || password.is_some() {
                    return Err(MarketError::internal(
                        "Local SMTP requires a private IP literal and must not send a password",
                    ));
                }
                AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&host)
            }
            _ => {
                return Err(MarketError::internal(
                    "SMTP_SECURITY must be ssl, starttls or local",
                ))
            }
        };
        let port = get("SMTP_PORT")
            .unwrap_or_else(|| {
                match security.as_str() {
                    "ssl" => "465",
                    "local" => "25",
                    _ => "587",
                }
                .into()
            })
            .parse::<u16>()
            .map_err(|_| MarketError::internal("Invalid SMTP_PORT"))?;
        let from = Mailbox::new(
            Some(get("SMTP_FROM_NAME").unwrap_or_else(|| "OpenBitFun".into())),
            username
                .parse()
                .map_err(|_| MarketError::internal("Invalid SMTP_USERNAME"))?,
        );
        let mut transport = builder
            .port(port)
            .timeout(Some(std::time::Duration::from_secs(15)));
        if let Some(password) = password {
            transport = transport.credentials(Credentials::new(username, password));
        }
        Ok(Some(Self {
            transport: transport.build(),
            from,
        }))
    }

    async fn send(&self, email: &str, code: &str, locale: &str) -> MarketResult<()> {
        let message = verification_message(self.from.clone(), email, code, locale)?;
        tokio::time::timeout(
            std::time::Duration::from_secs(20),
            self.transport.send(message),
        )
        .await
        .map_err(|_| delivery_error())?
        .map_err(|_| delivery_error())?;
        Ok(())
    }
}
fn verification_message(
    from: Mailbox,
    email: &str,
    code: &str,
    requested_locale: &str,
) -> MarketResult<Message> {
    static COPY: std::sync::LazyLock<serde_json::Value> = std::sync::LazyLock::new(|| {
        serde_json::from_str(include_str!("email/locales.json")).expect("valid email translations")
    });
    let locale = if COPY.get(requested_locale).is_some() {
        requested_locale
    } else {
        "en-US"
    };
    let copy = COPY[locale].as_object().expect("email locale object");
    let mut html = include_str!("email/sign-in.html").replace("{{locale}}", locale);
    for (key, value) in copy {
        html = html.replace(
            &format!("{{{{{key}}}}}"),
            value.as_str().expect("email translation"),
        );
    }
    let html = html.replace("{{code}}", code);
    let plain = copy["plain"]
        .as_str()
        .expect("plain email translation")
        .replace("{{code}}", code);
    Message::builder()
        .from(from)
        .to(email.parse().map_err(|_| invalid_email())?)
        .subject(copy["subject"].as_str().expect("email subject"))
        .multipart(
            MultiPart::alternative()
                .singlepart(
                    SinglePart::builder()
                        .header(ContentType::TEXT_PLAIN)
                        .header(ContentTransferEncoding::Base64)
                        .body(plain),
                )
                .multipart(
                    MultiPart::related()
                        .singlepart(
                            SinglePart::builder()
                                .header(ContentType::TEXT_HTML)
                                .header(ContentTransferEncoding::Base64)
                                .body(html),
                        )
                        .singlepart(Attachment::new_inline("openbitfun-app-icon".into()).body(
                            include_bytes!("email/app-icon.png").to_vec(),
                            ContentType::parse("image/png").expect("valid PNG MIME type"),
                        )),
                ),
        )
        .map_err(|_| MarketError::internal("Could not compose verification email"))
}

fn delivery_error() -> MarketError {
    MarketError::service_unavailable(
        "email_delivery_failed",
        "Could not send the verification email. Please try again later.",
    )
}
fn invalid_email() -> MarketError {
    MarketError::bad_request("invalid_email", "Enter a valid email address.")
}
fn invalid_code() -> MarketError {
    MarketError::bad_request(
        "invalid_email_code",
        "The verification code is incorrect, expired, or already used.",
    )
}
fn rate_limit() -> MarketError {
    MarketError::new(
        axum::http::StatusCode::TOO_MANY_REQUESTS,
        "email_rate_limit",
        "Too many verification requests. Please try again later.",
    )
}
fn normalize_email(value: &str) -> MarketResult<String> {
    let email = value.trim().to_ascii_lowercase();
    if email.len() > 254
        || !email.is_ascii()
        || email
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
        || !email.contains('@')
        || email.parse::<lettre::Address>().is_err()
    {
        return Err(invalid_email());
    }
    Ok(email)
}
fn code_digest(secret: &str, id: &str, code: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts arbitrary keys");
    mac.update(id.as_bytes());
    mac.update(b":");
    mac.update(code.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoginRequest {
    pub ticket: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmailSendRequest {
    pub ticket: String,
    pub email: String,
    #[serde(default)]
    pub locale: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmailVerifyRequest {
    pub ticket: String,
    pub challenge_id: String,
    pub code: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmailSent {
    pub challenge_id: String,
    pub retry_after_seconds: u32,
}

impl AuthService {
    pub(crate) async fn create_login_flow(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        transaction_id: Option<&str>,
        return_to: &str,
    ) -> MarketResult<String> {
        let ticket = random_token(32);
        let now = Utc::now().timestamp();
        let inserted = sqlx::query("INSERT INTO login_flows(ticket_hash, transaction_id, return_to, expires_at) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM login_flows WHERE expires_at > ?) < 8192")
            .bind(token_hash(&ticket)).bind(transaction_id).bind(safe_return_to(return_to)).bind(now + 600).bind(now).execute(&mut **tx).await.map_err(MarketError::internal)?;
        if inserted.rows_affected() != 1 {
            return Err(rate_limit());
        }
        Ok(ticket)
    }
    pub(crate) async fn start_web_login(&self, return_to: &str) -> MarketResult<String> {
        let mut tx = self
            .db
            .pool()
            .begin()
            .await
            .map_err(MarketError::internal)?;
        let ticket = self.create_login_flow(&mut tx, None, return_to).await?;
        tx.commit().await.map_err(MarketError::internal)?;
        Ok(ticket)
    }
    async fn login_flow(&self, ticket: &str) -> MarketResult<OAuthFlowRecord> {
        let row = sqlx::query("SELECT transaction_id, return_to FROM login_flows WHERE ticket_hash = ? AND expires_at > ? AND consumed_at IS NULL")
            .bind(token_hash(ticket)).bind(Utc::now().timestamp()).fetch_optional(self.db.pool()).await.map_err(MarketError::internal)?.ok_or_else(|| MarketError::bad_request("login_flow_expired", "This sign-in request is no longer active. Start sign-in again from the original app or website."))?;
        let transaction_id: Option<String> = row.get("transaction_id");
        Ok(OAuthFlowRecord {
            flow_kind: if transaction_id.is_some() {
                "desktop"
            } else {
                "web"
            }
            .into(),
            transaction_id,
            return_to: row.get("return_to"),
            code_verifier: String::new(),
        })
    }
    pub(crate) async fn login_github(&self, ticket: &str) -> MarketResult<String> {
        let flow = self.login_flow(ticket).await?;
        self.create_oauth_flow(
            &flow.flow_kind,
            flow.transaction_id.as_deref(),
            &flow.return_to,
        )
        .await
    }
    pub(crate) async fn send_email_code(
        &self,
        request: EmailSendRequest,
    ) -> MarketResult<EmailSent> {
        let mailer = self.mailer.as_ref().ok_or_else(|| {
            MarketError::service_unavailable(
                "email_not_configured",
                "Email sign-in is unavailable on this server.",
            )
        })?;
        let locale = request.locale.clone().unwrap_or_else(|| "en-US".into());
        let (sent, code) = self.prepare_email_code(request).await?;
        // Failure consumes the code; quota remains charged even on delivery failure.
        if let Err(error) = mailer.send(&sent.1, &code, &locale).await {
            sqlx::query("UPDATE email_challenges SET consumed_at = ? WHERE id = ?")
                .bind(Utc::now().timestamp())
                .bind(&sent.0.challenge_id)
                .execute(self.db.pool())
                .await
                .map_err(MarketError::internal)?;
            return Err(error);
        }
        Ok(sent.0)
    }
    async fn prepare_email_code(
        &self,
        request: EmailSendRequest,
    ) -> MarketResult<((EmailSent, String), String)> {
        let email = normalize_email(&request.email)?;
        self.login_flow(&request.ticket).await?;
        let now = Utc::now().timestamp();
        let id = random_token(24);
        let code = format!("{:08}", OsRng.gen_range(0..100_000_000u32));
        let mut tx = self
            .db
            .pool()
            .begin()
            .await
            .map_err(MarketError::internal)?;
        // INSERT is the first statement: serialize competing requests before quota evaluation.
        let inserted = sqlx::query("INSERT INTO email_challenges(id, ticket_hash, email, code_hash, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM email_challenges WHERE email = ? AND created_at > ?) < 2 AND (SELECT COUNT(*) FROM email_challenges WHERE email = ? AND created_at > ?) < 20 AND (SELECT COUNT(*) FROM email_challenges WHERE created_at > ?) < 300")
            .bind(&id).bind(token_hash(&request.ticket)).bind(&email).bind(code_digest(&self.config.session_secret, &id, &code)).bind(now).bind(now + 600)
            .bind(&email).bind(now - 60).bind(&email).bind(now - 86400).bind(now - 60).execute(&mut *tx).await.map_err(MarketError::internal)?;
        if inserted.rows_affected() != 1 {
            return Err(rate_limit());
        }
        sqlx::query("UPDATE email_challenges SET consumed_at = ? WHERE ticket_hash = ? AND id != ? AND consumed_at IS NULL").bind(now).bind(token_hash(&request.ticket)).bind(&id).execute(&mut *tx).await.map_err(MarketError::internal)?;
        tx.commit().await.map_err(MarketError::internal)?;
        Ok((
            (
                EmailSent {
                    challenge_id: id,
                    retry_after_seconds: 60,
                },
                email,
            ),
            code,
        ))
    }
    pub(crate) async fn verify_email_code(
        &self,
        request: EmailVerifyRequest,
    ) -> MarketResult<CompletedOAuth> {
        if request.code.len() != 8 || !request.code.bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid_code());
        }
        let flow = self.login_flow(&request.ticket).await?;
        let now = Utc::now().timestamp();
        let mut tx = self
            .db
            .pool()
            .begin()
            .await
            .map_err(MarketError::internal)?;
        let row = sqlx::query("UPDATE email_challenges SET attempts = attempts + 1 WHERE id = ? AND ticket_hash = ? AND expires_at > ? AND consumed_at IS NULL AND attempts < 5 RETURNING email, code_hash")
            .bind(&request.challenge_id).bind(token_hash(&request.ticket)).bind(now).fetch_optional(&mut *tx).await.map_err(MarketError::internal)?;
        let Some(row) = row else {
            return Err(invalid_code());
        };
        let expected: String = row.get("code_hash");
        let digest = code_digest(
            &self.config.session_secret,
            &request.challenge_id,
            &request.code,
        );
        if expected.len() != digest.len()
            || expected
                .as_bytes()
                .iter()
                .zip(digest.as_bytes())
                .fold(0u8, |acc, (a, b)| acc | (a ^ b))
                != 0
        {
            tx.commit().await.map_err(MarketError::internal)?;
            return Err(invalid_code());
        }
        let consumed = sqlx::query("UPDATE login_flows SET consumed_at = ? WHERE ticket_hash = ? AND consumed_at IS NULL AND expires_at > ?").bind(now).bind(token_hash(&request.ticket)).bind(now).execute(&mut *tx).await.map_err(MarketError::internal)?;
        if consumed.rows_affected() != 1 {
            return Err(invalid_code());
        }
        sqlx::query("UPDATE email_challenges SET consumed_at = ? WHERE id = ?")
            .bind(now)
            .bind(&request.challenge_id)
            .execute(&mut *tx)
            .await
            .map_err(MarketError::internal)?;
        let email: String = row.get("email");
        let existing: Option<(i64,)> =
            sqlx::query_as("SELECT user_id FROM email_identities WHERE email = ?")
                .bind(&email)
                .fetch_optional(&mut *tx)
                .await
                .map_err(MarketError::internal)?;
        let user_id = if let Some((id,)) = existing {
            id
        } else {
            // Never auto-link to GitHub by an unverified/public profile email.
            let user = sqlx::query("INSERT INTO users(github_id, login, avatar_url, created_at, updated_at) VALUES(NULL, ?, '', ?, ?)").bind(format!("user-{}", uuid::Uuid::new_v4().simple())).bind(now).bind(now).execute(&mut *tx).await.map_err(MarketError::internal)?;
            let id = user.last_insert_rowid();
            sqlx::query(
                "INSERT INTO email_identities(email, user_id, verified_at) VALUES(?, ?, ?)",
            )
            .bind(&email)
            .bind(id)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(MarketError::internal)?;
            id
        };
        tx.commit().await.map_err(MarketError::internal)?;
        self.finish_verified_oauth(flow, user_id).await
    }
}

impl AuthService {
    pub(crate) async fn email_browser_redirect(
        &self,
        completed: CompletedOAuth,
    ) -> MarketResult<String> {
        let (session_token, return_to) = match completed {
            CompletedOAuth::Web {
                session_token,
                return_to,
                ..
            } => (session_token, return_to),
            CompletedOAuth::Desktop { session_token, .. } => (
                session_token,
                format!("{}/complete", self.config.auth_base_url()),
            ),
        };
        let grant = random_token(32);
        let now = Utc::now().timestamp();
        let mut tx = self
            .db
            .pool()
            .begin()
            .await
            .map_err(MarketError::internal)?;
        let inserted = sqlx::query("INSERT INTO email_browser_grants(grant_hash, user_id, return_to, expires_at) SELECT ?, user_id, ?, ? FROM web_sessions WHERE token_hash = ? AND expires_at > ?")
            .bind(token_hash(&grant)).bind(return_to).bind(now + 60).bind(token_hash(&session_token)).bind(now).execute(&mut *tx).await.map_err(MarketError::internal)?;
        if inserted.rows_affected() != 1 {
            return Err(invalid_code());
        }
        sqlx::query("DELETE FROM web_sessions WHERE token_hash = ?")
            .bind(token_hash(&session_token))
            .execute(&mut *tx)
            .await
            .map_err(MarketError::internal)?;
        tx.commit().await.map_err(MarketError::internal)?;
        Ok(format!(
            "{}/api/v1/auth/email/complete?grant={grant}",
            self.config.public_base_url
        ))
    }
    pub(crate) async fn complete_email_browser(&self, grant: &str) -> MarketResult<CompletedOAuth> {
        let row = sqlx::query("DELETE FROM email_browser_grants WHERE grant_hash = ? AND expires_at > ? RETURNING user_id, return_to")
            .bind(token_hash(grant)).bind(Utc::now().timestamp()).fetch_optional(self.db.pool()).await.map_err(MarketError::internal)?.ok_or_else(invalid_code)?;
        self.finish_verified_oauth(
            OAuthFlowRecord {
                flow_kind: "web".into(),
                transaction_id: None,
                code_verifier: String::new(),
                return_to: row.get("return_to"),
            },
            row.get("user_id"),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{auth::DesktopAuthPollRequest, config::MarketConfig, db::Database};
    async fn setup() -> (tempfile::TempDir, AuthService) {
        let dir = tempfile::tempdir().unwrap();
        let config = MarketConfig {
            bind: "127.0.0.1:0".parse().unwrap(),
            public_base_url: "https://market.openbitfun.com/miniapp".into(),
            database_path: dir.path().join("db"),
            artifact_dir: dir.path().join("artifacts"),
            web_dir: dir.path().into(),
            github_callback_url: Some(
                "https://auth.openbitfun.com/api/v1/auth/github/callback".into(),
            ),
            github_client_id: Some("id".into()),
            github_client_secret: Some("secret".into()),
            session_secret: "test-only-session-secret-at-least-24".into(),
            admin_github_ids: [42, 0].into_iter().collect(),
            public_browse: true,
            web_submissions_enabled: false,
        };
        let db = Database::open(&config.database_path).await.unwrap();
        (dir, AuthService::new(config, db).unwrap())
    }
    async fn code(service: &AuthService, ticket: &str, email: &str) -> (String, String) {
        let ((sent, _), code) = service
            .prepare_email_code(EmailSendRequest {
                ticket: ticket.into(),
                email: email.into(),
                locale: None,
            })
            .await
            .unwrap();
        (sent.challenge_id, code)
    }
    fn verify(ticket: &str, id: &str, code: &str) -> EmailVerifyRequest {
        EmailVerifyRequest {
            ticket: ticket.into(),
            challenge_id: id.into(),
            code: code.into(),
        }
    }
    #[tokio::test]
    async fn email_is_independent_one_use_and_preserves_device_token_protocol() {
        let (_dir, service) = setup().await;
        let github = service
            .db
            .upsert_github_user(42, "alice", "")
            .await
            .unwrap();
        let start = service.start_desktop_login(true).await.unwrap();
        let ticket = start.authorization_url.split("#ticket=").nth(1).unwrap();
        let (id, code) = code(&service, ticket, "Alice@Example.com").await;
        let stored: (String,) =
            sqlx::query_as("SELECT code_hash FROM email_challenges WHERE id = ?")
                .bind(&id)
                .fetch_one(service.db.pool())
                .await
                .unwrap();
        assert_ne!(stored.0, code);
        assert_eq!(stored.0.len(), 64);
        let completed = service
            .verify_email_code(verify(ticket, &id, &code))
            .await
            .unwrap();
        assert!(service
            .verify_email_code(verify(ticket, &id, &code))
            .await
            .is_err());
        let redirect = service.email_browser_redirect(completed).await.unwrap();
        let grant = url::Url::parse(&redirect)
            .unwrap()
            .query_pairs()
            .find(|(k, _)| k == "grant")
            .unwrap()
            .1
            .into_owned();
        let browser = service.complete_email_browser(&grant).await.unwrap();
        assert!(service.complete_email_browser(&grant).await.is_err());
        let CompletedOAuth::Web { session_token, .. } = browser else {
            panic!("Expected browser session")
        };
        let (user, _, _) = service
            .db
            .web_session_user(&session_token)
            .await
            .unwrap()
            .unwrap();
        assert_ne!(github.internal_id, user.internal_id);
        assert_eq!(user.profile.github_id, 0);
        assert_eq!(user.email.as_deref(), Some("alice@example.com"));
        assert_eq!(github.email, None);
        // Keep the legacy relay profile contract while exposing email separately.
        assert!(user.profile.login.len() <= 100);
        assert!(user
            .profile
            .login
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-'));
        assert!(user.profile.identity_id().unwrap().starts_with("email-"));
        assert!(!service.is_admin(&user));
        let poll = service
            .poll_desktop(DesktopAuthPollRequest {
                transaction_id: start.transaction_id.clone(),
                transaction_secret: start.transaction_secret.clone(),
            })
            .await
            .unwrap();
        assert_eq!(poll.status, "authorized");
        let tokens = poll.tokens.unwrap();
        let (token_user, _) = service
            .db
            .api_token_user(&tokens.access_token, "access")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(token_user.internal_id, user.internal_id);
        assert_eq!(token_user.email, user.email);
        assert!(service
            .poll_desktop(DesktopAuthPollRequest {
                transaction_id: start.transaction_id,
                transaction_secret: start.transaction_secret
            })
            .await
            .unwrap()
            .tokens
            .is_none());
    }
    #[tokio::test]
    async fn wrong_codes_exhaust_budget_and_cannot_cross_flows() {
        let (_dir, service) = setup().await;
        let a = service.start_web_login("/miniapp/").await.unwrap();
        let b = service.start_web_login("/skin/").await.unwrap();
        let (id, code) = code(&service, &a, "alice@example.com").await;
        assert!(service
            .verify_email_code(verify(&b, &id, &code))
            .await
            .is_err());
        let wrong = if code == "00000000" {
            "11111111"
        } else {
            "00000000"
        };
        for _ in 0..5 {
            assert!(service
                .verify_email_code(verify(&a, &id, wrong))
                .await
                .is_err());
        }
        assert!(service
            .verify_email_code(verify(&a, &id, &code))
            .await
            .is_err());
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
            .fetch_one(service.db.pool())
            .await
            .unwrap();
        assert_eq!(count.0, 0);
    }
    #[tokio::test]
    async fn only_eight_digits_are_issued_and_accepted_including_leading_zeroes() {
        let (_dir, service) = setup().await;
        for expected in ["00000000", "01234567", "99999999"] {
            let ticket = service.start_web_login("/miniapp/").await.unwrap();
            let (id, generated) = code(&service, &ticket, &format!("{expected}@example.com")).await;
            assert_eq!(generated.len(), 8);
            assert!(generated.bytes().all(|byte| byte.is_ascii_digit()));
            // Verify edge values without relying on random generation to produce them.
            sqlx::query("UPDATE email_challenges SET code_hash = ? WHERE id = ?")
                .bind(code_digest(&service.config.session_secret, &id, expected))
                .bind(&id)
                .execute(service.db.pool())
                .await
                .unwrap();
            for malformed in [
                "12345",
                "123456",
                "1234567",
                "123456789",
                "abcdefgh",
                "１２３４５６７８",
            ] {
                assert!(service
                    .verify_email_code(verify(&ticket, &id, malformed))
                    .await
                    .is_err());
            }
            // Shorter prefixes are never accepted as an equivalent code.
            if expected.len() > 6 {
                assert!(service
                    .verify_email_code(verify(&ticket, &id, &expected[..6]))
                    .await
                    .is_err());
            }
            service
                .verify_email_code(verify(&ticket, &id, expected))
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn expired_login_requests_report_restart_without_spending_send_quota() {
        let (_dir, service) = setup().await;
        let ticket = service.start_web_login("/miniapp/").await.unwrap();
        let (id, code) = code(&service, &ticket, "alice@example.com").await;
        sqlx::query("UPDATE login_flows SET expires_at = 0 WHERE ticket_hash = ?")
            .bind(token_hash(&ticket))
            .execute(service.db.pool())
            .await
            .unwrap();
        let error = service
            .verify_email_code(verify(&ticket, &id, &code))
            .await
            .unwrap_err();
        assert_eq!(error.code, "login_flow_expired");
        let error = service
            .prepare_email_code(EmailSendRequest {
                ticket,
                email: "another@example.com".into(),
                locale: None,
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, "login_flow_expired");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM email_challenges")
            .fetch_one(service.db.pool())
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn concurrent_wrong_codes_share_a_persistent_attempt_budget() {
        let (dir, service) = setup().await;
        let ticket = service.start_web_login("/miniapp/").await.unwrap();
        let (id, code) = code(&service, &ticket, "alice@example.com").await;
        let wrong = if code == "00000000" {
            "11111111"
        } else {
            "00000000"
        };
        for _ in 0..4 {
            assert_eq!(
                service
                    .verify_email_code(verify(&ticket, &id, wrong))
                    .await
                    .unwrap_err()
                    .code,
                invalid_code().code
            );
        }
        // Reopen the database as a restarted process, then race for the final attempt.
        let restarted = AuthService::new(
            service.config.clone(),
            Database::open(&dir.path().join("db")).await.unwrap(),
        )
        .unwrap();
        let (a, b, c) = tokio::join!(
            service.verify_email_code(verify(&ticket, &id, wrong)),
            restarted.verify_email_code(verify(&ticket, &id, wrong)),
            restarted.verify_email_code(verify(&ticket, &id, wrong)),
        );
        for result in [a, b, c] {
            assert_eq!(result.unwrap_err().code, invalid_code().code);
        }
        let attempts: i64 =
            sqlx::query_scalar("SELECT attempts FROM email_challenges WHERE id = ?")
                .bind(&id)
                .fetch_one(restarted.db.pool())
                .await
                .unwrap();
        assert_eq!(attempts, 5);
        assert!(restarted
            .verify_email_code(verify(&ticket, &id, &code))
            .await
            .is_err());
        let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM web_sessions")
            .fetch_one(restarted.db.pool())
            .await
            .unwrap();
        assert_eq!(sessions, 0);
    }

    #[tokio::test]
    async fn new_flows_and_concurrent_sends_cannot_reset_address_quota() {
        let (_dir, service) = setup().await;
        let a = service.start_web_login("/miniapp/").await.unwrap();
        let b = service.start_web_login("/skin/").await.unwrap();
        let c = service.start_web_login("/miniapp/").await.unwrap();
        let send = |ticket: &str| EmailSendRequest {
            ticket: ticket.into(),
            email: "ALICE@example.com".into(),
            locale: None,
        };
        let (first, second, third) = tokio::join!(
            service.prepare_email_code(send(&a)),
            service.prepare_email_code(send(&b)),
            service.prepare_email_code(send(&c)),
        );
        let results = [first, second, third];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 2);
        assert_eq!(
            results.into_iter().find_map(Result::err).unwrap().code,
            "email_rate_limit"
        );
        for _ in 2..20 {
            sqlx::query("UPDATE email_challenges SET created_at = created_at - 61")
                .execute(service.db.pool())
                .await
                .unwrap();
            let ticket = service.start_web_login("/miniapp/").await.unwrap();
            service.prepare_email_code(send(&ticket)).await.unwrap();
        }
        sqlx::query("UPDATE email_challenges SET created_at = created_at - 61")
            .execute(service.db.pool())
            .await
            .unwrap();
        let ticket = service.start_web_login("/miniapp/").await.unwrap();
        assert_eq!(
            service
                .prepare_email_code(send(&ticket))
                .await
                .unwrap_err()
                .code,
            "email_rate_limit"
        );
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM email_challenges")
            .fetch_one(service.db.pool())
            .await
            .unwrap();
        assert_eq!(count, 20);
    }

    #[tokio::test]
    async fn email_send_quota_reopens_one_slot_when_oldest_send_expires() {
        let (_dir, service) = setup().await;
        let a = service.start_web_login("/miniapp/").await.unwrap();
        let b = service.start_web_login("/skin/").await.unwrap();
        let (oldest, _) = code(&service, &a, "alice@example.com").await;
        code(&service, &b, "ALICE@example.com").await;
        sqlx::query("UPDATE email_challenges SET created_at = created_at - 61 WHERE id = ?")
            .bind(oldest)
            .execute(service.db.pool())
            .await
            .unwrap();
        let c = service.start_web_login("/miniapp/").await.unwrap();
        code(&service, &c, "alice@example.com").await;
        let d = service.start_web_login("/miniapp/").await.unwrap();
        assert_eq!(
            service
                .prepare_email_code(EmailSendRequest {
                    ticket: d,
                    email: "Alice@example.com".into(),
                    locale: None,
                })
                .await
                .unwrap_err()
                .code,
            "email_rate_limit"
        );
    }

    #[tokio::test]
    async fn global_send_quota_allows_300_per_minute_without_a_daily_cap() {
        let (_dir, service) = setup().await;
        let ticket = service.start_web_login("/miniapp/").await.unwrap();
        let now = Utc::now().timestamp();
        // Yesterday's old cap would reject all new sends after these 1,000 records.
        sqlx::query("WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 1000) INSERT INTO email_challenges(id, ticket_hash, email, code_hash, created_at, expires_at) SELECT 'history-' || n, ?, 'history-' || n || '@example.com', 'unused', ?, ? FROM numbers")
            .bind(token_hash(&ticket)).bind(now - 120).bind(now - 1)
            .execute(service.db.pool()).await.unwrap();
        for index in 0..300 {
            service
                .prepare_email_code(EmailSendRequest {
                    ticket: ticket.clone(),
                    email: format!("recipient-{index}@example.com"),
                    locale: None,
                })
                .await
                .unwrap();
        }
        assert_eq!(
            service
                .prepare_email_code(EmailSendRequest {
                    ticket: ticket.clone(),
                    email: "over-minute-limit@example.com".into(),
                    locale: None,
                })
                .await
                .unwrap_err()
                .code,
            "email_rate_limit"
        );
        sqlx::query("UPDATE email_challenges SET created_at = created_at - 61")
            .execute(service.db.pool())
            .await
            .unwrap();
        service
            .prepare_email_code(EmailSendRequest {
                ticket,
                email: "next-minute@example.com".into(),
                locale: None,
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn rate_limits_persist_and_expired_codes_fail() {
        let (dir, service) = setup().await;
        let a = service.start_web_login("/miniapp/").await.unwrap();
        let (id, code) = code(&service, &a, "alice@example.com").await;
        let reopened = AuthService::new(
            service.config.clone(),
            Database::open(&dir.path().join("db")).await.unwrap(),
        )
        .unwrap();
        let b = reopened.start_web_login("/skin/").await.unwrap();
        self::code(&reopened, &b, "ALICE@example.com").await;
        assert_eq!(
            reopened
                .prepare_email_code(EmailSendRequest {
                    ticket: a.clone(),
                    email: "ALICE@example.com".into(),
                    locale: None
                })
                .await
                .unwrap_err()
                .code,
            "email_rate_limit"
        );
        sqlx::query("UPDATE email_challenges SET expires_at = 0 WHERE id = ?")
            .bind(&id)
            .execute(service.db.pool())
            .await
            .unwrap();
        assert!(service
            .verify_email_code(verify(&a, &id, &code))
            .await
            .is_err());
    }
    #[tokio::test]
    async fn concurrent_code_consumption_has_one_winner_and_relogin_reuses_email_account() {
        let (_dir, service) = setup().await;
        let ticket = service.start_web_login("/miniapp/").await.unwrap();
        let (id, code) = code(&service, &ticket, "alice@example.com").await;
        let (a, b) = tokio::join!(
            service.verify_email_code(verify(&ticket, &id, &code)),
            service.verify_email_code(verify(&ticket, &id, &code))
        );
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
        // A second device can sign in immediately after the first consumes its code.
        let ticket = service.start_web_login("/miniapp/").await.unwrap();
        let (id, code) = self::code(&service, &ticket, "Alice@example.com").await;
        service
            .verify_email_code(verify(&ticket, &id, &code))
            .await
            .unwrap();
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
            .fetch_one(service.db.pool())
            .await
            .unwrap();
        assert_eq!(count.0, 1);
    }
    #[tokio::test]
    async fn http_routes_preserve_legacy_start_and_set_scoped_browser_cookies() {
        use axum::{
            body::{to_bytes, Body},
            http::{header, Request, StatusCode},
        };
        use std::sync::Arc;
        use tower::ServiceExt;
        let (_dir, mut auth) = setup().await;
        auth.mailer = None;
        let state = Arc::new(crate::routes::MarketState {
            config: auth.config.clone(),
            db: auth.db.clone(),
            artifacts: crate::artifacts::ArtifactStore::open(auth.config.artifact_dir.clone())
                .await
                .unwrap(),
            auth: auth.clone(),
        });
        let app = crate::routes::api_router(state);
        for (path, expected) in [
            (
                "/auth/desktop/start",
                "https://github.com/login/oauth/authorize?",
            ),
            (
                "/auth/desktop/start?methods=all",
                "https://auth.openbitfun.com/sign-in#ticket=",
            ),
        ] {
            let response = app
                .clone()
                .oneshot(Request::post(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let value: serde_json::Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 16384).await.unwrap())
                    .unwrap();
            assert!(value["authorizationUrl"]
                .as_str()
                .unwrap()
                .starts_with(expected));
        }
        let response = app
            .clone()
            .oneshot(
                Request::post("/auth/email/send")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"ticket":"missing","email":"alice@example.com"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let ticket = auth.start_web_login("/skin/submissions").await.unwrap();
        let (id, code) = code(&auth, &ticket, "alice@example.com").await;
        let completed = auth
            .verify_email_code(verify(&ticket, &id, &code))
            .await
            .unwrap();
        let target =
            url::Url::parse(&auth.email_browser_redirect(completed).await.unwrap()).unwrap();
        let response = app
            .clone()
            .oneshot(
                Request::get(format!("/auth/email/complete?{}", target.query().unwrap()))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(response.status().is_redirection());
        assert_eq!(response.headers()[header::LOCATION], "/skin/submissions");
        let cookies: Vec<_> = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap())
            .collect();
        assert_eq!(cookies.len(), 4);
        assert!(cookies.iter().all(|v| !v.contains("Domain=")));
        assert!(cookies.iter().any(|v| v.contains("Path=/skin")));
        assert!(cookies.iter().any(|v| v.contains("Path=/miniapp")));
        let cookie_header = cookies
            .iter()
            .map(|cookie| cookie.split(';').next().unwrap())
            .collect::<Vec<_>>()
            .join("; ");
        let response = app
            .oneshot(
                Request::get("/me")
                    .header(header::COOKIE, cookie_header)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let profile: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 16384).await.unwrap()).unwrap();
        assert_eq!(profile["email"], "alice@example.com");
        assert!(profile["user"].get("email").is_none());
        assert!(!profile["user"]["login"].as_str().unwrap().contains('@'));
    }

    #[test]
    fn local_smtp_is_explicit_private_and_never_sends_credentials() {
        assert!(Mailer::from_settings(|_| None).unwrap().is_none());
        for host in ["127.0.0.1", "172.19.0.1", "::1"] {
            assert!(Mailer::from_settings(|key| match key {
                "SMTP_SECURITY" => Some("local".into()),
                "SMTP_HOST" => Some(host.into()),
                "SMTP_USERNAME" => Some("hello@example.com".into()),
                _ => None,
            })
            .unwrap()
            .is_some());
        }
        for (host, password) in [
            ("8.8.8.8", None),
            ("smtp.example.com", None),
            ("172.19.0.1", Some("do-not-transmit")),
        ] {
            assert!(Mailer::from_settings(|key| match key {
                "SMTP_SECURITY" => Some("local".into()),
                "SMTP_HOST" => Some(host.into()),
                "SMTP_USERNAME" => Some("hello@example.com".into()),
                "SMTP_PASSWORD" => password.map(str::to_owned),
                _ => None,
            })
            .is_err());
        }
    }

    #[test]
    fn verification_email_has_html_and_plain_text_without_attachments() {
        let message = verification_message(
            "OpenBitFun <hello@example.com>".parse().unwrap(),
            "alice@example.com",
            "123456",
            "en-US",
        )
        .unwrap();
        let raw = String::from_utf8(message.formatted()).unwrap();
        assert!(raw.contains("MIME-Version: 1.0\r\n"));
        assert!(raw.contains("Content-Type: text/plain; charset=utf-8\r\n"));
        assert!(!raw.contains("application/octet-stream"));
        assert!(!raw.contains("Content-Disposition: attachment"));
        use base64::Engine;
        assert!(raw.contains("Content-Transfer-Encoding: base64"));
        assert!(raw.contains("Content-Type: multipart/alternative;"));
        assert!(raw.contains("Content-Type: text/html; charset=utf-8"));
        assert!(raw.contains("Content-Type: multipart/related;"));
        assert!(raw.contains("Content-ID: <openbitfun-app-icon>"));
        assert!(raw.contains("Content-Disposition: inline"));
        let decode_part = |content_type: &str| {
            let part = raw
                .split("Content-Type: ")
                .find(|part| part.starts_with(content_type))
                .unwrap();
            let (_, body) = part.split_once("\r\n\r\n").unwrap();
            let encoded = body.split("\r\n--").next().unwrap();
            base64::engine::general_purpose::STANDARD
                .decode(encoded.split_whitespace().collect::<String>())
                .unwrap()
        };
        let plain = String::from_utf8(decode_part("text/plain;")).unwrap();
        assert!(plain.contains("Your OpenBitFun verification code is: 123456"));
        assert!(plain.is_ascii());
        let html = String::from_utf8(decode_part("text/html;")).unwrap();
        assert!(html.contains("src=\"cid:openbitfun-app-icon\""));
        assert!(!html.contains("src=\"https://"));
        assert_eq!(
            decode_part("image/png"),
            include_bytes!("email/app-icon.png")
        );
        assert!(html.contains(">123456</div>"));
        assert!(!html.contains("{{code}}"));
        assert!(!html.contains("<script"));
    }

    #[test]
    fn email_locale_is_optional_for_older_clients() {
        let legacy: EmailSendRequest =
            serde_json::from_str(r#"{"ticket":"test","email":"a@example.com"}"#).unwrap();
        assert!(legacy.locale.is_none());
        let current: EmailSendRequest =
            serde_json::from_str(r#"{"ticket":"test","email":"a@example.com","locale":"en-US"}"#)
                .unwrap();
        assert_eq!(current.locale.as_deref(), Some("en-US"));
    }

    #[test]
    fn email_translations_have_matching_keys_and_render_every_locale() {
        let translations: serde_json::Value =
            serde_json::from_str(include_str!("email/locales.json")).unwrap();
        let expected: Vec<_> = translations["en-US"].as_object().unwrap().keys().collect();
        for locale in ["en-US", "zh-CN", "zh-TW"] {
            assert_eq!(
                translations[locale]
                    .as_object()
                    .unwrap()
                    .keys()
                    .collect::<Vec<_>>(),
                expected
            );
            let message = verification_message(
                "OpenBitFun <hello@example.com>".parse().unwrap(),
                "a@example.com",
                "654321",
                locale,
            )
            .unwrap();
            let raw = String::from_utf8(message.formatted()).unwrap();
            use base64::Engine;
            let part = raw
                .split("Content-Type: ")
                .find(|p| p.starts_with("text/html;"))
                .unwrap();
            let encoded = part
                .split_once("\r\n\r\n")
                .unwrap()
                .1
                .split("\r\n--")
                .next()
                .unwrap();
            let html = String::from_utf8(
                base64::engine::general_purpose::STANDARD
                    .decode(encoded.split_whitespace().collect::<String>())
                    .unwrap(),
            )
            .unwrap();
            assert!(html.contains(&format!("lang=\"{locale}\"")));
            assert!(html.contains(translations[locale]["heading"].as_str().unwrap()));
            assert!(!html.contains("{{"));
            if locale == "en-US" {
                assert!(!html.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)));
            }
        }
        let unknown = verification_message(
            "OpenBitFun <hello@example.com>".parse().unwrap(),
            "a@example.com",
            "654321",
            "unknown",
        )
        .unwrap();
        assert!(String::from_utf8(unknown.formatted())
            .unwrap()
            .contains("Subject: OpenBitFun sign-in code"));
    }

    #[test]
    fn address_validation_and_keyed_hash() {
        for address in [
            "a@example.com\r\nBcc: x@example.com",
            "",
            "a b@example.com",
            "Name <a@example.com>",
        ] {
            assert!(normalize_email(address).is_err());
        }
        assert_eq!(
            normalize_email(" Alice@Example.com ").unwrap(),
            "alice@example.com"
        );
        assert_ne!(
            code_digest("key", "a", "123456"),
            code_digest("other", "a", "123456")
        );
        assert_ne!(
            code_digest("key", "a", "123456"),
            code_digest("key", "b", "123456")
        );
    }
}
