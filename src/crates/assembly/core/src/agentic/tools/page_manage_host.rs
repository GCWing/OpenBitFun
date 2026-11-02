//! Typed Pages operations, bound to the account on the executing host.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

fn published_only_default() -> bool {
    true
}

fn private_visibility() -> String {
    "private".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum PageManageRequest {
    List {
        #[serde(default = "published_only_default")]
        published_only: bool,
    },
    Publish {
        slug: String,
        #[serde(default = "private_visibility")]
        visibility: String,
        title: Option<String>,
        note: Option<String>,
        #[serde(default)]
        deploy: bool,
        files: Option<HashMap<String, String>>,
        directory: Option<String>,
    },
    Update {
        slug: String,
        title: Option<String>,
        note: Option<String>,
        #[serde(default)]
        deploy: bool,
        files: Option<HashMap<String, String>>,
        directory: Option<String>,
    },
    Permissions {
        slug: String,
        visibility: String,
    },
    Delete {
        slug: String,
        version_id: Option<String>,
    },
    Versions {
        slug: String,
    },
    Deploy {
        slug: String,
        version_id: String,
    },
    Unpublish {
        slug: String,
    },
}

impl PageManageRequest {
    pub fn action(&self) -> &'static str {
        match self {
            Self::List { .. } => "list",
            Self::Publish { .. } => "publish",
            Self::Update { .. } => "update",
            Self::Permissions { .. } => "permissions",
            Self::Delete { .. } => "delete",
            Self::Versions { .. } => "versions",
            Self::Deploy { .. } => "deploy",
            Self::Unpublish { .. } => "unpublish",
        }
    }

    pub fn slug(&self) -> Option<&str> {
        match self {
            Self::List { .. } => None,
            Self::Publish { slug, .. }
            | Self::Update { slug, .. }
            | Self::Permissions { slug, .. }
            | Self::Delete { slug, .. }
            | Self::Versions { slug }
            | Self::Deploy { slug, .. }
            | Self::Unpublish { slug } => Some(slug),
        }
    }

    pub fn is_readonly(&self) -> bool {
        matches!(self, Self::List { .. } | Self::Versions { .. })
    }
}

pub type PageManageFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>;
pub type PageManageHandler = Arc<dyn Fn(PageManageRequest) -> PageManageFuture + Send + Sync>;
static PAGE_MANAGE_HANDLER: OnceLock<PageManageHandler> = OnceLock::new();

pub fn set_page_manage_handler(handler: PageManageHandler) {
    let _ = PAGE_MANAGE_HANDLER.set(handler);
}

pub async fn invoke_page_manage(request: PageManageRequest) -> Result<Value, String> {
    let handler = PAGE_MANAGE_HANDLER
        .get()
        .ok_or("PageManage host handler is not registered; this is a host initialization error")?;
    handler(request).await
}
