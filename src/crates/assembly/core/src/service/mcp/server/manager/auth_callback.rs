//! Product-owned HTTP callback adapter and localized MCP OAuth result page.

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    response::{Html, IntoResponse},
    routing::get,
    Router,
};
use tokio::sync::{oneshot, Mutex};

use crate::service::i18n::LocaleId;

#[derive(Debug)]
pub(super) struct OAuthCallbackPayload {
    pub(super) code: Option<String>,
    pub(super) state: Option<String>,
    pub(super) error: Option<String>,
    pub(super) error_description: Option<String>,
}

#[derive(Clone, Copy)]
enum OAuthCallbackLocale {
    ZhCN,
    ZhTW,
    EnUS,
}

struct OAuthCallbackPageCopy {
    html_lang: &'static str,
    page_title: &'static str,
    brand_label: &'static str,
    badge_success: &'static str,
    badge_warning: &'static str,
    badge_error: &'static str,
    success_title: &'static str,
    success_message: &'static str,
    success_detail_title: &'static str,
    success_detail_body: &'static str,
    warning_title: &'static str,
    warning_message: &'static str,
    warning_detail_title: &'static str,
    error_title: &'static str,
    error_message: &'static str,
    error_detail_title: &'static str,
    close_hint: &'static str,
}

impl OAuthCallbackLocale {
    fn from_language_code(value: &str) -> Option<Self> {
        match LocaleId::from_str(value)? {
            LocaleId::ZhCN => Some(Self::ZhCN),
            LocaleId::ZhTW => Some(Self::ZhTW),
            // fr-FR callback page copy is not prepared yet; serve the English
            // page until OAuthCallbackLocale gains a French variant.
            LocaleId::EnUS | LocaleId::FrFr => Some(Self::EnUS),
        }
    }

    fn from_accept_language(value: &str) -> Self {
        value
            .split(',')
            .filter_map(|part| part.split(';').next())
            .find_map(|part| Self::from_language_code(part.trim()))
            .unwrap_or(Self::ZhCN)
    }

    fn copy(self) -> OAuthCallbackPageCopy {
        match self {
            Self::ZhCN => OAuthCallbackPageCopy {
                html_lang: "zh-CN",
                page_title: "OpenBitFun OAuth 回调",
                brand_label: "OpenBitFun Desktop",
                badge_success: "已收到授权",
                badge_warning: "回调参数不完整",
                badge_error: "授权失败",
                success_title: "OpenBitFun 已收到 OAuth 回调",
                success_message: "可以返回 OpenBitFun。应用正在交换授权码并重新连接 MCP 服务器。",
                success_detail_title: "接下来会发生什么",
                success_detail_body:
                    "这个页面可以直接关闭。如果 OpenBitFun 没有自动完成重连，请回到 MCP 设置页后重试 OAuth。",
                warning_title: "OpenBitFun 收到的 OAuth 回调缺少必要参数",
                warning_message:
                    "OAuth 提供方已跳转回来，但缺少必须的参数。请返回 OpenBitFun 重新发起登录流程。",
                warning_detail_title: "缺少的参数",
                error_title: "OpenBitFun 未能完成 OAuth 授权",
                error_message:
                    "请返回 OpenBitFun，并根据下面的提供方返回信息检查问题后重新发起 OAuth。",
                error_detail_title: "提供方返回",
                close_hint: "处理完成后，这个页面可以直接关闭。",
            },
            Self::ZhTW => OAuthCallbackPageCopy {
                html_lang: "zh-TW",
                page_title: "OpenBitFun OAuth 回調",
                brand_label: "OpenBitFun Desktop",
                badge_success: "已收到授權",
                badge_warning: "回調參數不完整",
                badge_error: "授權失敗",
                success_title: "OpenBitFun 已收到 OAuth 回調",
                success_message: "可以返回 OpenBitFun。應用正在交換授權碼並重新連接 MCP 服務器。",
                success_detail_title: "接下來會發生什麼",
                success_detail_body:
                    "這個頁面可以直接關閉。如果 OpenBitFun 沒有自動完成重連，請回到 MCP 設置頁後重試 OAuth。",
                warning_title: "OpenBitFun 收到的 OAuth 回調缺少必要參數",
                warning_message:
                    "OAuth 提供方已跳轉回來，但缺少必須的參數。請返回 OpenBitFun 重新發起登錄流程。",
                warning_detail_title: "缺少的參數",
                error_title: "OpenBitFun 未能完成 OAuth 授權",
                error_message:
                    "請返回 OpenBitFun，並根據下面的提供方返回信息檢查問題後重新發起 OAuth。",
                error_detail_title: "提供方返回",
                close_hint: "處理完成後，這個頁面可以直接關閉。",
            },
            Self::EnUS => OAuthCallbackPageCopy {
                html_lang: "en-US",
                page_title: "OpenBitFun OAuth Callback",
                brand_label: "OpenBitFun Desktop",
                badge_success: "Authorization received",
                badge_warning: "Callback incomplete",
                badge_error: "Authorization failed",
                success_title: "OpenBitFun received the OAuth callback",
                success_message:
                    "You can return to OpenBitFun now. The app is exchanging the authorization code and reconnecting the MCP server.",
                success_detail_title: "What happens next",
                success_detail_body:
                    "This page can be closed now. If OpenBitFun does not finish reconnecting automatically, return to MCP settings and retry OAuth.",
                warning_title: "OpenBitFun received an OAuth callback with missing parameters",
                warning_message:
                    "The provider redirected back, but required OAuth parameters were missing. Return to OpenBitFun and start the sign-in flow again.",
                warning_detail_title: "Missing parameters",
                error_title: "OpenBitFun could not finish the OAuth authorization",
                error_message:
                    "Return to OpenBitFun and review the provider response below before retrying OAuth.",
                error_detail_title: "Provider response",
                close_hint: "This page can be closed after you review the status.",
            },
        }
    }
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn resolve_oauth_callback_locale(
    preferred_language: Option<&str>,
    accept_language: Option<&str>,
) -> OAuthCallbackLocale {
    preferred_language
        .and_then(OAuthCallbackLocale::from_language_code)
        .or_else(|| accept_language.map(OAuthCallbackLocale::from_accept_language))
        .unwrap_or(OAuthCallbackLocale::ZhCN)
}

fn render_oauth_callback_page(
    payload: &OAuthCallbackPayload,
    locale: OAuthCallbackLocale,
) -> String {
    let copy = locale.copy();
    let (badge, badge_class, title, message, detail_title, detail_body, icon_label) =
        if let Some(error) = payload.error.as_deref() {
            let description = payload
                .error_description
                .as_deref()
                .unwrap_or(match locale {
                    OAuthCallbackLocale::ZhCN => "OAuth 提供方拒绝了这次授权请求。",
                    OAuthCallbackLocale::ZhTW => "OAuth 提供方拒絕了這次授權請求。",
                    OAuthCallbackLocale::EnUS => "The provider rejected the authorization request.",
                });
            (
                copy.badge_error,
                "is-error",
                copy.error_title,
                copy.error_message,
                copy.error_detail_title,
                format!("{}: {}", escape_html(error), escape_html(description)),
                "!",
            )
        } else if payload.code.is_some() && payload.state.is_some() {
            (
                copy.badge_success,
                "is-success",
                copy.success_title,
                copy.success_message,
                copy.success_detail_title,
                copy.success_detail_body.to_string(),
                match locale {
                    OAuthCallbackLocale::ZhCN => "完成",
                    OAuthCallbackLocale::ZhTW => "完成",
                    OAuthCallbackLocale::EnUS => "Done",
                },
            )
        } else {
            let mut missing = Vec::new();
            if payload.code.is_none() {
                missing.push("code");
            }
            if payload.state.is_none() {
                missing.push("state");
            }
            (
                copy.badge_warning,
                "is-warning",
                copy.warning_title,
                copy.warning_message,
                copy.warning_detail_title,
                escape_html(&missing.join(", ")),
                "?",
            )
        };

    format!(
        r#"<!DOCTYPE html>
<html lang="{html_lang}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{page_title}</title>
    <style>
      :root {{
        color-scheme: light;
        --bg-0: #f3efe5;
        --bg-1: #dbe7ff;
        --bg-2: #f8c98b;
        --panel: rgba(255, 252, 246, 0.88);
        --panel-border: rgba(53, 66, 97, 0.14);
        --text-strong: #172033;
        --text-muted: #5c6474;
        --shadow: 0 24px 80px rgba(23, 32, 51, 0.16);
        --success: #176b52;
        --success-soft: rgba(23, 107, 82, 0.12);
        --warning: #9a5a00;
        --warning-soft: rgba(154, 90, 0, 0.14);
        --error: #a63232;
        --error-soft: rgba(166, 50, 50, 0.12);
      }}

      * {{
        box-sizing: border-box;
      }}

      body {{
        margin: 0;
        min-height: 100vh;
        font-family: "Segoe UI Variable Display", "Aptos", "Trebuchet MS", sans-serif;
        color: var(--text-strong);
        background:
          radial-gradient(circle at top left, rgba(255, 255, 255, 0.72), transparent 34%),
          radial-gradient(circle at bottom right, rgba(255, 230, 202, 0.9), transparent 30%),
          linear-gradient(135deg, var(--bg-0) 0%, var(--bg-1) 52%, var(--bg-2) 100%);
        overflow: hidden;
      }}

      .orb {{
        position: fixed;
        border-radius: 999px;
        filter: blur(12px);
        opacity: 0.56;
        pointer-events: none;
      }}

      .orb-a {{
        width: 320px;
        height: 320px;
        top: -96px;
        right: -48px;
        background: rgba(126, 159, 255, 0.34);
      }}

      .orb-b {{
        width: 260px;
        height: 260px;
        bottom: -84px;
        left: -40px;
        background: rgba(255, 193, 118, 0.38);
      }}

      .shell {{
        position: relative;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 28px;
      }}

      .panel {{
        width: min(100%, 720px);
        padding: 32px;
        border: 1px solid var(--panel-border);
        border-radius: 28px;
        background: var(--panel);
        backdrop-filter: blur(18px);
        box-shadow: var(--shadow);
      }}

      .brand {{
        display: flex;
        align-items: center;
        gap: 16px;
        margin-bottom: 24px;
      }}

      .brand-mark {{
        width: 52px;
        height: 52px;
        border-radius: 16px;
        display: grid;
        place-items: center;
        font-weight: 700;
        letter-spacing: 0.08em;
        color: #fffaf0;
        background: linear-gradient(135deg, #172033 0%, #335c95 100%);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.16);
      }}

      .eyebrow {{
        display: block;
        margin-bottom: 4px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--text-muted);
      }}

      h1 {{
        margin: 0;
        font-size: clamp(28px, 5vw, 44px);
        line-height: 1.04;
        letter-spacing: -0.04em;
      }}

      .badge {{
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 14px;
        border-radius: 999px;
        font-size: 13px;
        font-weight: 700;
      }}

      .badge.is-success {{
        color: var(--success);
        background: var(--success-soft);
      }}

      .badge.is-warning {{
        color: var(--warning);
        background: var(--warning-soft);
      }}

      .badge.is-error {{
        color: var(--error);
        background: var(--error-soft);
      }}

      .content {{
        display: grid;
        gap: 20px;
      }}

      .content > * {{
        min-width: 0;
      }}

      .lead {{
        margin: 0;
        max-width: 58ch;
        font-size: 17px;
        line-height: 1.7;
        color: var(--text-muted);
      }}

      .status-card {{
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 18px;
        padding: 20px;
        border-radius: 22px;
        background: rgba(255, 255, 255, 0.58);
        border: 1px solid rgba(53, 66, 97, 0.08);
      }}

      .status-icon {{
        width: 52px;
        height: 52px;
        border-radius: 18px;
        display: grid;
        place-items: center;
        font-weight: 800;
        font-size: 16px;
        color: var(--text-strong);
        background: linear-gradient(135deg, rgba(255, 255, 255, 0.94), rgba(227, 235, 255, 0.92));
        border: 1px solid rgba(53, 66, 97, 0.08);
      }}

      .status-title {{
        margin: 0 0 8px;
        font-size: 15px;
        font-weight: 700;
        letter-spacing: 0.01em;
      }}

      .status-body {{
        margin: 0;
        font-family: "Cascadia Code", "Consolas", monospace;
        font-size: 13px;
        line-height: 1.7;
        color: var(--text-muted);
        word-break: break-word;
      }}

      .close-note {{
        padding: 16px 18px;
        border-radius: 18px;
        background: rgba(23, 32, 51, 0.06);
        border: 1px solid rgba(53, 66, 97, 0.08);
      }}

      .footnote {{
        margin: 0;
        font-size: 13px;
        line-height: 1.7;
        color: var(--text-muted);
      }}

      @media (max-width: 640px) {{
        .panel {{
          padding: 24px;
          border-radius: 24px;
        }}

        .brand,
        .status-card {{
          grid-template-columns: 1fr;
        }}

        .status-card {{
          gap: 14px;
        }}
      }}
    </style>
  </head>
  <body>
    <div class="orb orb-a"></div>
    <div class="orb orb-b"></div>
    <main class="shell">
      <section class="panel">
        <div class="brand">
          <div class="brand-mark">BF</div>
          <div>
            <span class="eyebrow">{brand_label}</span>
            <h1>{title}</h1>
          </div>
        </div>
        <div class="content">
          <div class="badge {badge_class}">{badge}</div>
          <p class="lead">{message}</p>
          <div class="status-card">
            <div class="status-icon">{icon_label}</div>
            <div>
              <p class="status-title">{detail_title}</p>
              <p class="status-body">{detail_body}</p>
            </div>
          </div>
          <div class="close-note">
            <p class="footnote">{close_hint}</p>
          </div>
        </div>
      </section>
    </main>
  </body>
</html>"#,
        html_lang = copy.html_lang,
        page_title = copy.page_title,
        brand_label = copy.brand_label,
        title = title,
        badge = badge,
        badge_class = badge_class,
        message = message,
        detail_title = detail_title,
        detail_body = detail_body,
        icon_label = icon_label,
        close_hint = copy.close_hint,
    )
}

#[derive(Clone)]
struct OAuthCallbackAppState {
    callback_tx: Arc<Mutex<Option<oneshot::Sender<OAuthCallbackPayload>>>>,
    preferred_language: String,
}

pub(super) fn build_oauth_callback_router(
    callback_path: &str,
    callback_tx: oneshot::Sender<OAuthCallbackPayload>,
    preferred_language: String,
) -> Router {
    let state = OAuthCallbackAppState {
        callback_tx: Arc::new(Mutex::new(Some(callback_tx))),
        preferred_language,
    };
    Router::new()
        .route(callback_path, get(handle_oauth_callback))
        .with_state(state)
}

async fn handle_oauth_callback(
    State(state): State<OAuthCallbackAppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let payload = OAuthCallbackPayload {
        code: params.get("code").cloned(),
        state: params.get("state").cloned(),
        error: params.get("error").cloned(),
        error_description: params.get("error_description").cloned(),
    };
    let accept_language = headers
        .get(axum::http::header::ACCEPT_LANGUAGE)
        .and_then(|value| value.to_str().ok());
    let locale =
        resolve_oauth_callback_locale(Some(state.preferred_language.as_str()), accept_language);
    let page = render_oauth_callback_page(&payload, locale);

    if let Some(callback_tx) = state.callback_tx.lock().await.take() {
        let _ = callback_tx.send(payload);
    }

    Html(page)
}

#[cfg(test)]
mod tests {
    use super::{render_oauth_callback_page, resolve_oauth_callback_locale, OAuthCallbackPayload};

    #[test]
    fn callback_page_prefers_the_product_locale_and_escapes_provider_errors() {
        let locale = resolve_oauth_callback_locale(Some("en-US"), Some("zh-CN,zh;q=0.9"));
        let page = render_oauth_callback_page(
            &OAuthCallbackPayload {
                code: None,
                state: None,
                error: Some("denied<script>".to_string()),
                error_description: Some("bad & unsafe".to_string()),
            },
            locale,
        );

        assert!(page.contains("OpenBitFun could not finish the OAuth authorization"));
        assert!(page.contains("denied&lt;script&gt;: bad &amp; unsafe"));
        assert!(!page.contains("denied<script>"));
    }
}
