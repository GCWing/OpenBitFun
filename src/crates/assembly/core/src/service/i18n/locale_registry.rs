//! Backend Fluent resource registry.
//!
//! Locale identity, aliases, metadata, and model-facing language instructions
//! come from the generated locale contract. This table only owns backend Fluent
//! resource wiring because Rust `include_str!` paths cannot come from JSON.

use super::types::LocaleId;

#[derive(Debug, Clone, Copy)]
pub struct LocaleResourceEntry {
    pub id: LocaleId,
    pub fluent_source: &'static str,
}

pub const LOCALE_RESOURCE_REGISTRY: &[LocaleResourceEntry] = &[
    LocaleResourceEntry {
        id: LocaleId::ZhCN,
        fluent_source: include_str!("../../../locales/zh-CN.ftl"),
    },
    LocaleResourceEntry {
        id: LocaleId::ZhTW,
        fluent_source: include_str!("../../../locales/zh-TW.ftl"),
    },
    LocaleResourceEntry {
        id: LocaleId::EnUS,
        fluent_source: include_str!("../../../locales/en-US.ftl"),
    },
    LocaleResourceEntry {
        id: LocaleId::FrFr,
        fluent_source: include_str!("../../../locales/fr-FR.ftl"),
    },
];
