pub use openbitfun_services_integrations::remote_connect::bot::{
    fmt_count, strings_for, BotLanguage, BotStrings,
};

pub async fn current_bot_language() -> BotLanguage {
    match crate::service::config::get_app_language().await {
        crate::service::LocaleId::ZhCN => BotLanguage::ZhCN,
        crate::service::LocaleId::ZhTW => BotLanguage::ZhTW,
        // fr-FR bot copy is not prepared yet; serve the English strings until
        // BotLanguage gains a French variant.
        crate::service::LocaleId::EnUS | crate::service::LocaleId::FrFr => BotLanguage::EnUS,
    }
}
