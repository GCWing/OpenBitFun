//! Built-in MiniApp bundle contracts and pure seed policy.
//!
//! Seed skip requires both a matching content hash and an installed marker version
//! that is at least the bundled version. Do not hardcode bundle version numbers in
//! tests — bumping a MiniApp version should not require shotgun edits across tests.

use crate::miniapp::ports::{MiniAppPortFuture, MiniAppPortResult};
use crate::miniapp::storage::{
    build_package_json, ESM_DEPS_JSON, INDEX_HTML, STYLE_CSS, UI_JS, WORKER_JS,
};
use crate::miniapp::types::{EsmDep, MiniAppMeta, MiniAppSource};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const BUILTIN_INSTALL_MARKER: &str = ".builtin-manifest.json";
pub const BUILTIN_PLACEHOLDER_COMPILED_HTML: &str =
    "<!DOCTYPE html><html><body>Loading...</body></html>";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuiltinInstallMarker {
    pub version: u32,
    pub hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuiltinSeedArtifacts {
    pub content_hash: String,
    pub marker: BuiltinInstallMarker,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BuiltinSeedCheck {
    Skip,
    NeedsSeed(BuiltinSeedArtifacts),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BuiltinSeedAction {
    PreserveLocalOverride(BuiltinSeedArtifacts),
    SeedBundle(BuiltinSeedArtifacts),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuiltinMiniAppSeedBundleRequest {
    pub app: &'static BuiltinMiniAppBundle,
    pub seeded_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BuiltinMiniAppSeedOutcome {
    Skipped,
    Seeded {
        version: u32,
        content_hash: String,
    },
    PreservedLocalOverride {
        version: u32,
        content_hash: String,
        recorded_update: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuiltinMiniAppSeedReport {
    pub app_id: &'static str,
    pub outcome: MiniAppPortResult<BuiltinMiniAppSeedOutcome>,
}

pub trait BuiltinMiniAppSeedHost: Send + Sync {
    fn now_ms(&self) -> i64;
    fn installed_marker(
        &self,
        app_id: &'static str,
    ) -> MiniAppPortFuture<'_, Option<BuiltinInstallMarker>>;
    fn has_local_override(&self, app_id: &'static str) -> MiniAppPortFuture<'_, bool>;
    fn record_available_update(
        &self,
        app_id: &'static str,
        version: u32,
        content_hash: String,
        now_ms: i64,
    ) -> MiniAppPortFuture<'_, bool>;
    fn seed_bundle(&self, request: BuiltinMiniAppSeedBundleRequest) -> MiniAppPortFuture<'_, ()>;
    fn write_seed_markers(
        &self,
        app_id: &'static str,
        artifacts: BuiltinSeedArtifacts,
    ) -> MiniAppPortFuture<'_, ()>;
}

/// Pure built-in MiniApp asset bundle shape. The owning runtime still decides
/// how bundles are seeded, compiled, and persisted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuiltinMiniAppBundle {
    pub id: &'static str,
    pub version: u32,
    pub meta_json: &'static str,
    pub html: &'static str,
    pub css: &'static str,
    pub ui_js: &'static str,
    pub worker_js: &'static str,
    pub esm_dependencies_json: &'static str,
}

/// Built-in MiniApps that ship with the product-domain package.
///
/// The concrete seeding runtime still lives in the app/core integration layer;
/// this list owns only the stable bundle identity and embedded source assets.
pub const BUILTIN_APPS: &[BuiltinMiniAppBundle] = &[
    BuiltinMiniAppBundle {
        id: "builtin-gomoku",
        version: 11,
        meta_json: include_str!("builtin/assets/gomoku/meta.json"),
        html: include_str!("builtin/assets/gomoku/index.html"),
        css: include_str!("builtin/assets/gomoku/style.css"),
        ui_js: include_str!("builtin/assets/gomoku/ui.js"),
        worker_js: include_str!("builtin/assets/gomoku/worker.js"),
        esm_dependencies_json: "[]",
    },
    BuiltinMiniAppBundle {
        id: "builtin-daily-divination",
        version: 22,
        meta_json: include_str!("builtin/assets/divination/meta.json"),
        html: include_str!("builtin/assets/divination/index.html"),
        css: include_str!("builtin/assets/divination/style.css"),
        ui_js: include_str!("builtin/assets/divination/ui.js"),
        worker_js: include_str!("builtin/assets/divination/worker.js"),
        esm_dependencies_json: "[]",
    },
    BuiltinMiniAppBundle {
        id: "builtin-regex-playground",
        version: 16,
        meta_json: include_str!("builtin/assets/regex-playground/meta.json"),
        html: include_str!("builtin/assets/regex-playground/index.html"),
        css: include_str!("builtin/assets/regex-playground/style.css"),
        ui_js: include_str!("builtin/assets/regex-playground/ui.js"),
        worker_js: include_str!("builtin/assets/regex-playground/worker.js"),
        esm_dependencies_json: "[]",
    },
    BuiltinMiniAppBundle {
        id: "builtin-coding-selfie",
        version: 28,
        meta_json: include_str!("builtin/assets/coding-selfie/meta.json"),
        html: include_str!("builtin/assets/coding-selfie/index.html"),
        css: include_str!("builtin/assets/coding-selfie/style.css"),
        ui_js: include_str!("builtin/assets/coding-selfie/ui.js"),
        worker_js: include_str!("builtin/assets/coding-selfie/worker.js"),
        esm_dependencies_json: "[]",
    },
    BuiltinMiniAppBundle {
        id: "builtin-ppt-live",
        version: 260,
        meta_json: include_str!("builtin/assets/ppt-live/meta.json"),
        html: include_str!("builtin/assets/ppt-live/index.html"),
        css: include_str!("builtin/assets/ppt-live/style.css"),
        ui_js: include_str!("builtin/assets/ppt-live/dist/ui.bundle.js"),
        worker_js: include_str!("builtin/assets/ppt-live/worker.js"),
        esm_dependencies_json: include_str!("builtin/assets/ppt-live/esm_dependencies.json"),
    },
    BuiltinMiniAppBundle {
        id: "builtin-bitfun-loopx",
        version: 15,
        meta_json: include_str!("builtin/assets/bitfun-loopx/meta.json"),
        html: include_str!("builtin/assets/bitfun-loopx/index.html"),
        css: include_str!("builtin/assets/bitfun-loopx/style.css"),
        ui_js: include_str!("builtin/assets/bitfun-loopx/ui.js"),
        worker_js: include_str!("builtin/assets/bitfun-loopx/worker.js"),
        esm_dependencies_json: include_str!("builtin/assets/bitfun-loopx/esm_dependencies.json"),
    },
];

pub fn builtin_content_hash(app: &BuiltinMiniAppBundle) -> String {
    let mut hasher = Sha256::new();
    hash_builtin_asset(&mut hasher, "meta.json", app.meta_json);
    hash_builtin_asset(&mut hasher, "index.html", app.html);
    hash_builtin_asset(&mut hasher, "style.css", app.css);
    hash_builtin_asset(&mut hasher, "ui.js", app.ui_js);
    hash_builtin_asset(&mut hasher, "worker.js", app.worker_js);
    hash_builtin_asset(
        &mut hasher,
        "esm_dependencies.json",
        app.esm_dependencies_json,
    );
    format!("sha256:{}", hex_encode(&hasher.finalize()))
}

/// Whether installed source files still match the bundled built-in assets
/// verbatim. Privileged host bridges use this to refuse driving from locally
/// modified built-in content. The meta.json identity/timestamp rewrite performed
/// at seed time is intentionally excluded.
pub fn builtin_source_matches(source: &MiniAppSource, bundle: &BuiltinMiniAppBundle) -> bool {
    let Ok(bundled_esm_deps) = serde_json::from_str::<Vec<EsmDep>>(bundle.esm_dependencies_json)
    else {
        return false;
    };
    source.html == bundle.html
        && source.css == bundle.css
        && source.ui_js == bundle.ui_js
        && source.worker_js == bundle.worker_js
        && source.esm_dependencies == bundled_esm_deps
        && source.npm_dependencies.is_empty()
}

pub fn build_builtin_install_marker(
    app: &BuiltinMiniAppBundle,
    content_hash: &str,
) -> BuiltinInstallMarker {
    BuiltinInstallMarker {
        version: app.version,
        hash: content_hash.to_string(),
    }
}

pub fn build_builtin_seed_artifacts(app: &BuiltinMiniAppBundle) -> BuiltinSeedArtifacts {
    let content_hash = builtin_content_hash(app);
    BuiltinSeedArtifacts {
        marker: build_builtin_install_marker(app, &content_hash),
        content_hash,
    }
}

pub fn preserved_builtin_created_at(existing_meta_json: Option<&str>) -> Option<i64> {
    existing_meta_json
        .and_then(|existing| serde_json::from_str::<MiniAppMeta>(existing).ok())
        .map(|meta| meta.created_at)
}

pub fn build_builtin_seed_meta(
    app: &BuiltinMiniAppBundle,
    preserved_created_at: Option<i64>,
    now: i64,
) -> serde_json::Result<MiniAppMeta> {
    let mut meta: MiniAppMeta = serde_json::from_str(app.meta_json)?;
    meta.id = app.id.to_string();
    meta.created_at = preserved_created_at.unwrap_or(now);
    meta.updated_at = now;
    Ok(meta)
}

pub fn resolve_builtin_seed_check(
    app: &BuiltinMiniAppBundle,
    installed: Option<&BuiltinInstallMarker>,
) -> BuiltinSeedCheck {
    let artifacts = build_builtin_seed_artifacts(app);
    if should_seed_builtin_app(app, &artifacts.content_hash, installed) {
        BuiltinSeedCheck::NeedsSeed(artifacts)
    } else {
        BuiltinSeedCheck::Skip
    }
}

pub fn resolve_builtin_seed_action(
    artifacts: BuiltinSeedArtifacts,
    has_local_override: bool,
) -> BuiltinSeedAction {
    if has_local_override {
        BuiltinSeedAction::PreserveLocalOverride(artifacts)
    } else {
        BuiltinSeedAction::SeedBundle(artifacts)
    }
}

pub async fn seed_builtin_miniapps_with_host(
    host: &dyn BuiltinMiniAppSeedHost,
) -> Vec<BuiltinMiniAppSeedReport> {
    let mut reports = Vec::with_capacity(BUILTIN_APPS.len());
    for app in BUILTIN_APPS {
        reports.push(BuiltinMiniAppSeedReport {
            app_id: app.id,
            outcome: seed_builtin_miniapp_with_host(host, app).await,
        });
    }
    reports
}

pub async fn seed_builtin_miniapp_with_host(
    host: &dyn BuiltinMiniAppSeedHost,
    app: &'static BuiltinMiniAppBundle,
) -> MiniAppPortResult<BuiltinMiniAppSeedOutcome> {
    let installed = host.installed_marker(app.id).await?;
    let artifacts = match resolve_builtin_seed_check(app, installed.as_ref()) {
        BuiltinSeedCheck::Skip => return Ok(BuiltinMiniAppSeedOutcome::Skipped),
        BuiltinSeedCheck::NeedsSeed(artifacts) => artifacts,
    };

    let now_ms = host.now_ms();
    if host.has_local_override(app.id).await? {
        let content_hash = artifacts.content_hash.clone();
        let recorded_update = host
            .record_available_update(app.id, app.version, content_hash.clone(), now_ms)
            .await?;
        host.write_seed_markers(app.id, artifacts).await?;
        return Ok(BuiltinMiniAppSeedOutcome::PreservedLocalOverride {
            version: app.version,
            content_hash,
            recorded_update,
        });
    }

    let content_hash = artifacts.content_hash.clone();
    host.seed_bundle(BuiltinMiniAppSeedBundleRequest {
        app,
        seeded_at_ms: now_ms,
    })
    .await?;
    host.write_seed_markers(app.id, artifacts).await?;
    Ok(BuiltinMiniAppSeedOutcome::Seeded {
        version: app.version,
        content_hash,
    })
}

pub fn serialize_builtin_install_marker(
    marker: &BuiltinInstallMarker,
) -> serde_json::Result<String> {
    serde_json::to_string_pretty(marker)
}

pub fn parse_builtin_install_marker(content: &str) -> serde_json::Result<BuiltinInstallMarker> {
    serde_json::from_str(content)
}

pub fn should_seed_builtin_app(
    app: &BuiltinMiniAppBundle,
    content_hash: &str,
    installed: Option<&BuiltinInstallMarker>,
) -> bool {
    !matches!(
        installed,
        Some(marker) if marker.version >= app.version && marker.hash == content_hash
    )
}

pub fn build_builtin_package_json(app_id: &str) -> serde_json::Value {
    build_package_json(app_id, &[])
}

pub fn builtin_source_files(app: &BuiltinMiniAppBundle) -> [(&'static str, &'static str); 5] {
    [
        (INDEX_HTML, app.html),
        (STYLE_CSS, app.css),
        (UI_JS, app.ui_js),
        (WORKER_JS, app.worker_js),
        (ESM_DEPS_JSON, app.esm_dependencies_json),
    ]
}

fn hash_builtin_asset(hasher: &mut Sha256, name: &str, content: &str) {
    hasher.update(name.as_bytes());
    hasher.update([0u8]);
    hasher.update(content.len().to_le_bytes());
    hasher.update([0u8]);
    hasher.update(content.as_bytes());
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    // Do not assert hardcoded BUILTIN_APPS[i].version or meta["version"] values here.
    // Version bumps should only touch bundle registration and seed runtime, not tests.

    use super::{
        build_builtin_seed_artifacts, builtin_content_hash, builtin_source_matches,
        seed_builtin_miniapp_with_host, BuiltinInstallMarker, BuiltinMiniAppSeedBundleRequest,
        BuiltinMiniAppSeedHost, BuiltinMiniAppSeedOutcome, BuiltinSeedArtifacts, BUILTIN_APPS,
    };
    use crate::miniapp::ports::{MiniAppPortFuture, MiniAppPortResult};
    use std::sync::{Arc, Mutex};

    #[test]
    fn builtin_miniapp_bundles_keep_product_domain_asset_owner_contract() {
        let ids = BUILTIN_APPS.iter().map(|app| app.id).collect::<Vec<_>>();

        assert_eq!(
            ids,
            vec![
                "builtin-gomoku",
                "builtin-daily-divination",
                "builtin-regex-playground",
                "builtin-coding-selfie",
                "builtin-ppt-live",
                "builtin-bitfun-loopx",
            ]
        );

        for app in BUILTIN_APPS {
            assert!(!app.meta_json.trim().is_empty());
            assert!(!app.html.trim().is_empty());
            assert!(!app.css.trim().is_empty());
            assert!(!app.ui_js.trim().is_empty());
            assert!(!app.worker_js.trim().is_empty());
            assert!(builtin_content_hash(app).starts_with("sha256:"));
        }
    }

    #[test]
    fn builtin_miniapp_meta_and_deps_parse_into_product_types() {
        use crate::miniapp::types::{EsmDep, MiniAppMeta};

        for app in BUILTIN_APPS {
            let meta: MiniAppMeta = serde_json::from_str(app.meta_json).unwrap_or_else(|e| {
                panic!(
                    "builtin '{}' meta.json does not parse as MiniAppMeta: {e}",
                    app.id
                )
            });
            assert_eq!(
                meta.id, app.id,
                "builtin '{}' meta id must match the bundle id",
                app.id
            );
            assert!(
                !meta.name.trim().is_empty(),
                "builtin '{}' meta name must not be empty",
                app.id
            );
            assert!(
                !meta.icon.trim().is_empty(),
                "builtin '{}' meta icon must not be empty",
                app.id
            );
            let i18n = meta.i18n.as_ref().unwrap_or_else(|| {
                panic!("builtin '{}' meta.json must carry i18n locales", app.id)
            });
            assert!(
                i18n.locales.contains_key("zh-CN"),
                "builtin '{}' i18n must cover zh-CN",
                app.id
            );
            assert!(
                i18n.locales.contains_key("en-US"),
                "builtin '{}' i18n must cover en-US",
                app.id
            );

            let deps: Vec<EsmDep> =
                serde_json::from_str(app.esm_dependencies_json).unwrap_or_else(|e| {
                    panic!(
                        "builtin '{}' esm_dependencies.json does not parse as an ESM dep list: {e}",
                        app.id
                    )
                });
            for dep in &deps {
                assert!(
                    !dep.name.trim().is_empty(),
                    "builtin '{}' has an ESM dependency without a name",
                    app.id
                );
            }
        }
    }

    #[derive(Default)]
    struct FakeSeedHost {
        now_ms: i64,
        installed_marker: Mutex<Option<BuiltinInstallMarker>>,
        has_override: Mutex<bool>,
        recorded_updates: Mutex<Vec<(&'static str, u32, String, i64)>>,
        seeded_bundles: Mutex<Vec<(&'static str, i64)>>,
        written_markers: Mutex<Vec<(&'static str, BuiltinSeedArtifacts)>>,
    }

    impl FakeSeedHost {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                now_ms: 12345,
                ..Self::default()
            })
        }
    }

    impl BuiltinMiniAppSeedHost for FakeSeedHost {
        fn now_ms(&self) -> i64 {
            self.now_ms
        }

        fn installed_marker(
            &self,
            _app_id: &'static str,
        ) -> MiniAppPortFuture<'_, Option<BuiltinInstallMarker>> {
            Box::pin(async move { Ok(self.installed_marker.lock().unwrap().clone()) })
        }

        fn has_local_override(&self, _app_id: &'static str) -> MiniAppPortFuture<'_, bool> {
            Box::pin(async move { Ok(*self.has_override.lock().unwrap()) })
        }

        fn record_available_update(
            &self,
            app_id: &'static str,
            version: u32,
            content_hash: String,
            now_ms: i64,
        ) -> MiniAppPortFuture<'_, bool> {
            Box::pin(async move {
                self.recorded_updates
                    .lock()
                    .unwrap()
                    .push((app_id, version, content_hash, now_ms));
                Ok(true)
            })
        }

        fn seed_bundle(
            &self,
            request: BuiltinMiniAppSeedBundleRequest,
        ) -> MiniAppPortFuture<'_, ()> {
            Box::pin(async move {
                self.seeded_bundles
                    .lock()
                    .unwrap()
                    .push((request.app.id, request.seeded_at_ms));
                Ok(())
            })
        }

        fn write_seed_markers(
            &self,
            app_id: &'static str,
            artifacts: BuiltinSeedArtifacts,
        ) -> MiniAppPortFuture<'_, ()> {
            Box::pin(async move {
                self.written_markers
                    .lock()
                    .unwrap()
                    .push((app_id, artifacts));
                Ok(())
            })
        }
    }

    fn port_ok<T>(result: MiniAppPortResult<T>) -> T {
        result.expect("seed host should succeed")
    }

    #[tokio::test]
    async fn builtin_seed_host_orchestrator_skips_current_bundle() {
        let app = &BUILTIN_APPS[0];
        let host = FakeSeedHost::new();
        let artifacts = build_builtin_seed_artifacts(app);
        *host.installed_marker.lock().unwrap() = Some(artifacts.marker.clone());

        let outcome = port_ok(seed_builtin_miniapp_with_host(host.as_ref(), app).await);

        assert_eq!(outcome, BuiltinMiniAppSeedOutcome::Skipped);
        assert!(host.seeded_bundles.lock().unwrap().is_empty());
        assert!(host.written_markers.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn builtin_seed_host_orchestrator_preserves_local_override() {
        let app = &BUILTIN_APPS[0];
        let host = FakeSeedHost::new();
        *host.installed_marker.lock().unwrap() = Some(BuiltinInstallMarker {
            version: 0,
            hash: "sha256:old".to_string(),
        });
        *host.has_override.lock().unwrap() = true;

        let outcome = port_ok(seed_builtin_miniapp_with_host(host.as_ref(), app).await);

        let BuiltinMiniAppSeedOutcome::PreservedLocalOverride {
            version,
            content_hash,
            recorded_update,
        } = outcome
        else {
            panic!("expected preserved local override");
        };
        assert_eq!(version, app.version);
        assert!(content_hash.starts_with("sha256:"));
        assert!(recorded_update);
        assert_eq!(host.recorded_updates.lock().unwrap().len(), 1);
        assert!(host.seeded_bundles.lock().unwrap().is_empty());
        assert_eq!(host.written_markers.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn builtin_seed_host_orchestrator_seeds_bundle_without_override() {
        let app = &BUILTIN_APPS[0];
        let host = FakeSeedHost::new();
        *host.installed_marker.lock().unwrap() = Some(BuiltinInstallMarker {
            version: 0,
            hash: "sha256:old".to_string(),
        });

        let outcome = port_ok(seed_builtin_miniapp_with_host(host.as_ref(), app).await);

        let BuiltinMiniAppSeedOutcome::Seeded {
            version,
            content_hash,
        } = outcome
        else {
            panic!("expected seeded bundle");
        };
        assert_eq!(version, app.version);
        assert!(content_hash.starts_with("sha256:"));
        assert_eq!(
            host.seeded_bundles.lock().unwrap().as_slice(),
            &[(app.id, host.now_ms)]
        );
        assert!(host.recorded_updates.lock().unwrap().is_empty());
        assert_eq!(host.written_markers.lock().unwrap().len(), 1);
    }

    #[test]
    fn ppt_live_bundle_uses_openbitfun_host_capabilities() {
        let app = BUILTIN_APPS
            .iter()
            .find(|app| app.id == "builtin-ppt-live")
            .expect("PPT Live should be registered");
        let meta: serde_json::Value =
            serde_json::from_str(app.meta_json).expect("PPT Live metadata should be valid");
        let bundle: serde_json::Value =
            serde_json::from_str(include_str!("builtin/assets/ppt-live/bundle.json"))
                .expect("PPT Live bundle metadata should be valid");

        assert_eq!(meta["version"].as_u64(), Some(u64::from(app.version)));
        assert_eq!(bundle["version"].as_u64(), Some(u64::from(app.version)));
        assert_eq!(meta["permissions"]["node"]["enabled"], false);
        // Model selection belongs to the host's shared ChatInput; PPT Live no
        // longer needs raw AI access merely to duplicate the model catalog.
        assert!(meta["permissions"].get("ai").is_none());
        assert_eq!(meta["permissions"]["agent"]["enabled"], true);
        assert_eq!(meta["permissions"]["agent"]["rate_limit_per_minute"], 120);
        // Research happens inside hidden agent turns (WebSearch/WebFetch via
        // the agent permission); the app itself no longer fetches URLs.
        assert_eq!(
            meta["permissions"]["net"]["allow"].as_array().map(Vec::len),
            Some(0)
        );
        assert!(app.ui_js.contains("Unsupported PPT Live action"));
        // A single cowork agent turn loads the ppt-design skill and produces
        // the whole deck end to end. Prompt construction is isolated from the
        // host adapter so its generated-file contract can be tested directly.
        let adapter_source =
            include_str!("builtin/assets/ppt-live/src/openbitfun-backend-adapter.js");
        let prompt_source = include_str!("builtin/assets/ppt-live/src/agent-prompt.js");
        assert!(adapter_source.contains("sessionId: options.sessionId"));
        assert!(adapter_source.contains("buildAgentPrompt"));
        assert!(prompt_source.contains("user::openbitfun-system::ppt-design"));
        assert!(prompt_source.contains("export function buildAgentPrompt"));
        assert!(!adapter_source.contains("app.ai"));
        assert!(!adapter_source.contains("installFallbackBackend"));
        // The prompt must delegate design rules to the skill, not restate them.
        assert!(!prompt_source.contains("EDITABLE_PPTX_HARD_RULES"));
        assert!(!prompt_source.contains("PPT_DESIGN_REQUIRED_REFERENCES"));
        assert!(!prompt_source.contains("comparisons -> tables/matrices"));
        assert!(!prompt_source.contains("Design quality bar"));
        assert!(!prompt_source.contains("Müller-Brockmann"));
        assert!(app.ui_js.contains("Unknown MiniApp agent session"));
        // Generation follows the ppt-design skill's native file protocol: the
        // agent works inside a deck project directory under the app's appdata
        // storage, writes project.json and slides/slide-NN.html, and ui.js
        // reads the files back instead of parsing giant JSON text.
        assert!(adapter_source.contains("protocol: 'files'"));
        assert!(adapter_source.contains("appDataWorkspace: options.appDataWorkspace"));
        assert!(!adapter_source.contains("model: options.model"));
        assert!(adapter_source.contains("displayText: options.displayText"));
        assert!(app.ui_js.contains("payload?.displayText"));
        assert!(app
            .ui_js
            .contains("displayText: options.displayText || requestInput.instruction"));
        assert!(app.ui_js.contains("continueAfterInterruption: attempt > 1"));
        assert!(app.ui_js.contains("generationRetryDisplayText"));
        assert!(app
            .ui_js
            .contains("return submitInstruction(text2, displayText)"));
        assert!(app.ui_js.contains("project.json"));
        assert!(app.ui_js.contains("slides/slide-"));
        let ui_source = include_str!("builtin/assets/ppt-live/ui.js");
        assert!(ui_source.contains("backendUsesFileProtocol"));
        assert!(ui_source.contains("tryReadDeckSlideFile"));
        assert!(!ui_source.contains("preferredModel"));
        assert!(!ui_source.contains("modelSelect"));
        assert!(!app.html.contains("modelSelect"));
        assert!(meta["permissions"]["fs"]["read"]
            .as_array()
            .is_some_and(|scopes| scopes.iter().any(|scope| scope == "{appdata}")));
        assert!(meta["permissions"]["fs"]["write"]
            .as_array()
            .is_some_and(|scopes| scopes.iter().any(|scope| scope == "{appdata}")));
        assert!(!app.ui_js.contains("Sparo"));
        assert!(include_str!("builtin/assets/ppt-live/ui.js")
            .contains("installOpenBitFunBackendAdapter"));
        // The single cowork agent turn loads the stable ppt-design skill key.
        assert!(prompt_source.contains("user::openbitfun-system::ppt-design"));
        let ppt_live_source = include_str!("builtin/assets/ppt-live/ui.js");
        // PPT Live registers bounded content into the host's standard floating
        // ChatInput. It must not request a private composer layout or panel.
        assert!(ppt_live_source.contains("claimComposer?.({"));
        assert!(ppt_live_source.contains("placeholder: t('bubblePlaceholder')"));
        assert!(!ppt_live_source.contains("panelSize:"));
        assert!(!ppt_live_source.contains("rows: 3"));
        // Single-turn cowork generation: one agent turn produces the whole deck.
        assert!(ppt_live_source.contains("runCoworkDeckGeneration"));
        assert!(ppt_live_source.contains("readDeckFromProjectFiles"));
        assert!(ppt_live_source.contains("pushAgentStreamEntry"));
        assert!(!ppt_live_source.contains("PPT_PARALLEL_SLIDE_WORKERS"));
        assert!(!ppt_live_source.contains("runWithConcurrencyLimit"));
        assert!(!ppt_live_source.contains("enrichSources(state)"));
        // Staged multi-turn protocol was removed.
        assert!(!ppt_live_source.contains("runStagedDeckGeneration"));
        assert!(!ppt_live_source.contains("PPT_PLAN_BATCH_SIZE"));
        assert!(!ppt_live_source.contains("PPT_BACKEND_CONTINUATION_MAX_ATTEMPTS"));
        assert!(app.html.contains("exportPptx"));
        assert!(!app.html.contains("src=\"./ui.js\""));
        assert!(!app.html.contains("href=\"./style.css\""));
        assert!(app.css.contains("--openbitfun-bg"));
    }

    #[test]
    fn builtin_source_matches_detects_modified_source() {
        use crate::miniapp::types::{EsmDep, MiniAppSource};

        let app = &BUILTIN_APPS[0];
        let pristine = MiniAppSource {
            html: app.html.to_string(),
            css: app.css.to_string(),
            ui_js: app.ui_js.to_string(),
            worker_js: app.worker_js.to_string(),
            esm_dependencies: serde_json::from_str(app.esm_dependencies_json).unwrap(),
            npm_dependencies: Vec::new(),
        };
        assert!(builtin_source_matches(&pristine, app));

        let mut modified_ui = pristine.clone();
        modified_ui.ui_js.push_str("\n// tampered");
        assert!(!builtin_source_matches(&modified_ui, app));

        let mut modified_deps = pristine;
        modified_deps.esm_dependencies.push(EsmDep {
            name: "extra".to_string(),
            version: None,
            url: None,
        });
        assert!(!builtin_source_matches(&modified_deps, app));
    }
}
