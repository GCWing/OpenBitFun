//! Wire account-backed Pages tools to the account owner on the executing host.

use crate::agentic::tools::page_deploy_host::set_page_deploy_handler;
use crate::agentic::tools::page_manage_host::{set_page_manage_handler, PageManageRequest};
use crate::agentic::tools::page_publish_host::{
    set_page_account_availability, set_page_publish_handler, PageAccountAvailability,
    PagePublishHostRequest,
};
use crate::service::remote_connect::account_runtime::AccountRuntime;
use openbitfun_services_integrations::remote_connect::{
    delete_page_from_relay, delete_page_version_on_relay, deploy_page_version_on_relay,
    join_relay_url, list_page_versions_from_relay, list_pages_from_relay,
    publish_page_content_on_relay, unpublish_page_from_relay, update_page_content_on_relay,
    update_page_on_relay, PageInfo,
};
use serde_json::Value;
use std::sync::Arc;

/// Bind once when assembling the executing Runtime, never on a remote controller.
/// Weak references prevent the tool registry from extending the account lifetime.
pub fn register_account_pages(runtime: &Arc<AccountRuntime>) {
    set_page_account_availability(account_availability(runtime));
    let account = Arc::downgrade(runtime);
    set_page_manage_handler(Arc::new(move |request| {
        let account = account.upgrade();
        Box::pin(async move {
            let account = account.ok_or("Pages account runtime is unavailable")?;
            manage(&account, request).await
        })
    }));
    let account = Arc::downgrade(runtime);
    set_page_publish_handler(Arc::new(move |request| {
        let account = account.upgrade();
        Box::pin(async move {
            let account = account.ok_or("Pages account runtime is unavailable")?;
            publish(&account, request).await
        })
    }));
    let account = Arc::downgrade(runtime);
    set_page_deploy_handler(Arc::new(move |slug, version_id| {
        let account = account.upgrade();
        Box::pin(async move {
            let account = account.ok_or("Pages account runtime is unavailable")?;
            deploy(&account, &slug, &version_id).await
        })
    }));
}

fn page_value(relay_url: &str, page: PageInfo) -> Result<Value, String> {
    let url = join_relay_url(relay_url, &page.url_path);
    let preview_url = page
        .preview_url_path
        .as_deref()
        .map(|path| join_relay_url(relay_url, path));
    let published = page
        .deployed_version_id
        .as_deref()
        .is_some_and(|version| !version.is_empty());
    let mut value = serde_json::to_value(page).map_err(|error| error.to_string())?;
    value["name"] = value["title"].clone();
    value["url"] = serde_json::json!(url);
    value["published"] = serde_json::json!(published);
    if let Some(url) = preview_url {
        value["preview_url"] = serde_json::json!(url);
    }
    Ok(value)
}

pub(crate) async fn manage(
    account: &AccountRuntime,
    request: PageManageRequest,
) -> Result<Value, String> {
    if account.is_token_expired() {
        return Err("Pages account session expired; sign in again".into());
    }
    let generation = account.account_context_generation();
    let (session, relay_url) = account
        .read_account_context_for_generation(generation)
        .await
        .map_err(|error| error.to_string())?;
    manage_with_account_context(&relay_url, &session.token, request, || {
        account.account_context_is_current(generation)
    })
    .await
}

/// Execute against one host-owned account snapshot. Desktop retains its own
/// account lifecycle; CLI uses AccountRuntime. Both supply the same token/Relay
/// pair and a fence that invalidates it when that host changes accounts.
pub async fn manage_with_account_context(
    relay_url: &str,
    token: &str,
    request: PageManageRequest,
    is_current: impl Fn() -> bool + Send + Sync,
) -> Result<Value, String> {
    if !is_current() {
        return Err("account context changed".into());
    }
    let action = request.action();
    if let PageManageRequest::Publish {
        slug,
        visibility,
        title,
        note,
        deploy,
        directory,
        files,
    } = request
    {
        let result = publish_page_content_on_relay(
            relay_url,
            token,
            &slug,
            &visibility,
            title.as_deref(),
            note.as_deref(),
            deploy,
            directory.as_deref(),
            files.as_ref(),
        )
        .await
        .map_err(|error| error.to_string())?;
        if !is_current() {
            return Err("account context changed; publication outcome is unknown, inspect the original account before retrying".into());
        }
        let mut result = serde_json::to_value(result).map_err(|error| error.to_string())?;
        result["action"] = serde_json::json!(action);
        return Ok(result);
    }
    let mut pages = list_pages_from_relay(relay_url, token)
        .await
        .map_err(|error| error.to_string())?;
    if !is_current() {
        return Err("account context changed".into());
    }
    if let PageManageRequest::List { published_only } = request {
        pages.retain(|page| {
            !published_only
                || page
                    .deployed_version_id
                    .as_deref()
                    .is_some_and(|id| !id.is_empty())
        });
        pages.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.slug.cmp(&b.slug))
        });
        let pages = pages
            .into_iter()
            .map(|page| page_value(relay_url, page))
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(serde_json::json!({"action": action, "pages": pages}));
    }
    let slug = request.slug().ok_or("Page slug is required")?;
    let page = pages
        .into_iter()
        .find(|page| page.slug == slug)
        .ok_or("Page not found; use list with published_only=false before retrying")?;
    let readonly = request.is_readonly();
    let mut result = match request {
        PageManageRequest::Update {
            title,
            note,
            deploy,
            files,
            directory,
            ..
        } => {
            if files.is_some() || directory.is_some() {
                let result = update_page_content_on_relay(
                    relay_url,
                    token,
                    &page,
                    title.as_deref(),
                    note.as_deref(),
                    deploy,
                    directory.as_deref(),
                    files.as_ref(),
                )
                .await
                .map_err(|error| error.to_string())?;
                serde_json::to_value(result).map_err(|error| error.to_string())?
            } else {
                let info = update_page_on_relay(
                    relay_url,
                    token,
                    &page.slug,
                    &page.generation,
                    None,
                    title.as_deref(),
                )
                .await
                .map_err(|error| error.to_string())?;
                page_value(relay_url, info)?
            }
        }
        PageManageRequest::Permissions { visibility, .. } => {
            let info = update_page_on_relay(
                relay_url,
                token,
                &page.slug,
                &page.generation,
                Some(&visibility),
                None,
            )
            .await
            .map_err(|error| error.to_string())?;
            page_value(relay_url, info)?
        }
        PageManageRequest::Delete { version_id, .. } => {
            match version_id.as_deref() {
                Some(version) => {
                    delete_page_version_on_relay(
                        relay_url,
                        token,
                        &page.slug,
                        version,
                        &page.generation,
                    )
                    .await
                }
                None => {
                    delete_page_from_relay(relay_url, token, &page.slug, &page.generation).await
                }
            }
            .map_err(|error| error.to_string())?;
            let mut value = serde_json::json!({"slug": page.slug, "deleted": true});
            if let Some(version_id) = version_id {
                value["version_id"] = serde_json::json!(version_id);
            }
            value
        }
        PageManageRequest::Unpublish { .. } => {
            unpublish_page_from_relay(relay_url, token, &page.slug, &page.generation)
                .await
                .map_err(|error| error.to_string())?;
            serde_json::json!({"slug": page.slug, "unpublished": true})
        }
        PageManageRequest::Versions { .. } => {
            let versions =
                list_page_versions_from_relay(relay_url, token, &page.slug, &page.generation)
                    .await
                    .map_err(|error| error.to_string())?;
            let versions = versions
                .into_iter()
                .map(|version| {
                    let preview_url = join_relay_url(relay_url, &version.preview_url_path);
                    let mut value =
                        serde_json::to_value(version).map_err(|error| error.to_string())?;
                    value["preview_url"] = serde_json::json!(preview_url);
                    Ok(value)
                })
                .collect::<Result<Vec<Value>, String>>()?;
            serde_json::json!({"slug": page.slug, "visibility": page.visibility, "versions": versions})
        }
        PageManageRequest::Deploy { version_id, .. } => {
            let info = deploy_page_version_on_relay(
                relay_url,
                token,
                &page.slug,
                &version_id,
                &page.generation,
            )
            .await
            .map_err(|error| error.to_string())?;
            let mut value = page_value(relay_url, info)?;
            value["version_id"] = serde_json::json!(version_id);
            value["deployed"] = serde_json::json!(true);
            value
        }
        PageManageRequest::List { .. } | PageManageRequest::Publish { .. } => unreachable!(),
    };
    if !is_current() {
        return Err(if readonly { "account context changed" } else {
            "account context changed; Page operation outcome is unknown, inspect the original account before retrying"
        }.into());
    }
    result["action"] = serde_json::json!(action);
    Ok(result)
}

pub(crate) async fn publish(
    account: &AccountRuntime,
    request: PagePublishHostRequest,
) -> Result<Value, String> {
    if account.is_token_expired() {
        return Err("Pages account session expired; sign in again".into());
    }
    let generation = account.account_context_generation();
    let (session, relay_url) = account
        .read_account_context_for_generation(generation)
        .await
        .map_err(|error| error.to_string())?;
    let result = publish_page_content_on_relay(
        &relay_url,
        &session.token,
        &request.slug,
        &request.visibility,
        request.title.as_deref(),
        request.note.as_deref(),
        request.deploy,
        request.directory.as_deref(),
        request.files.as_ref(),
    )
    .await
    .map_err(|error| error.to_string())?;
    if !account.account_context_is_current(generation) {
        return Err("account context changed; publication outcome is unknown, inspect the original account before retrying".into());
    }
    serde_json::to_value(result).map_err(|error| error.to_string())
}

pub(crate) async fn deploy(
    account: &AccountRuntime,
    slug: &str,
    version_id: &str,
) -> Result<Value, String> {
    if account.is_token_expired() {
        return Err("Pages account session expired; sign in again".into());
    }
    let generation = account.account_context_generation();
    let (session, relay_url) = account
        .read_account_context_for_generation(generation)
        .await
        .map_err(|error| error.to_string())?;
    let page = list_pages_from_relay(&relay_url, &session.token)
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|page| page.slug == slug)
        .ok_or("Page not found; refresh the Page list before deploying")?;
    if !account.account_context_is_current(generation) {
        return Err("account context changed".into());
    }
    let info = deploy_page_version_on_relay(
        &relay_url,
        &session.token,
        slug,
        version_id,
        &page.generation,
    )
    .await
    .map_err(|error| error.to_string())?;
    if !account.account_context_is_current(generation) {
        return Err("account context changed; deployment outcome is unknown, inspect the original account before retrying".into());
    }
    let url = join_relay_url(&relay_url, &info.url_path);
    let preview_url = info
        .preview_url_path
        .as_deref()
        .filter(|path| !path.is_empty())
        .map(|path| join_relay_url(&relay_url, path));
    let mut value = serde_json::to_value(info).map_err(|error| error.to_string())?;
    value["url"] = Value::String(url);
    if let Some(preview_url) = preview_url {
        value["preview_url"] = Value::String(preview_url);
    }
    Ok(value)
}

pub(crate) fn account_availability(runtime: &Arc<AccountRuntime>) -> PageAccountAvailability {
    let account = Arc::downgrade(runtime);
    Arc::new(move || {
        let account = account.upgrade();
        Box::pin(async move {
            match account {
                Some(account) => account.is_logged_in().await && !account.is_token_expired(),
                None => false,
            }
        })
    })
}
