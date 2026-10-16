use openbitfun_product_domains::miniapp::market::{
    MarketPackageMeta, MARKET_MAX_PACKAGE_BYTES, MARKET_MAX_UNCOMPRESSED_BYTES,
};
use openbitfun_product_domains::miniapp::types::MiniApp;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::io::{Cursor, Read, Write};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const REQUIRED_ENTRIES: &[&str] = &[
    "meta.json",
    "source/index.html",
    "source/style.css",
    "source/ui.js",
    "source/worker.js",
    "source/esm_dependencies.json",
];

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct MarketPackageError {
    pub code: &'static str,
    pub message: String,
}

impl MarketPackageError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ValidatedMarketPackage {
    pub sha256: String,
    pub size: u64,
    pub meta: MarketPackageMeta,
    pub source_files: BTreeMap<String, String>,
}

pub fn validate_market_package(bytes: &[u8]) -> Result<ValidatedMarketPackage, MarketPackageError> {
    if bytes.is_empty() {
        return Err(MarketPackageError::new(
            "empty_package",
            "The MiniApp package is empty.",
        ));
    }
    if bytes.len() as u64 > MARKET_MAX_PACKAGE_BYTES {
        return Err(MarketPackageError::new(
            "package_too_large",
            "The compressed MiniApp package exceeds 20 MiB.",
        ));
    }

    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|error| {
        MarketPackageError::new("invalid_package", format!("Invalid ZIP archive: {error}"))
    })?;
    let mut seen = HashSet::new();
    let mut files = BTreeMap::new();
    let mut total_uncompressed = 0_u64;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| {
            MarketPackageError::new("invalid_package", format!("Invalid ZIP entry: {error}"))
        })?;
        if entry.is_dir() {
            return Err(MarketPackageError::new(
                "forbidden_package_entry",
                "Marketplace packages cannot contain directory entries.",
            ));
        }
        let Some(enclosed_name) = entry.enclosed_name() else {
            return Err(MarketPackageError::new(
                "unsafe_package_path",
                "The package contains an unsafe path.",
            ));
        };
        let name = enclosed_name
            .to_str()
            .ok_or_else(|| {
                MarketPackageError::new("invalid_package_path", "Package paths must use UTF-8.")
            })?
            .replace('\\', "/");
        let normalized = name.to_ascii_lowercase();
        if !seen.insert(normalized) {
            return Err(MarketPackageError::new(
                "duplicate_package_path",
                format!("The package contains a duplicate path: {name}"),
            ));
        }
        if !REQUIRED_ENTRIES.contains(&name.as_str()) {
            return Err(MarketPackageError::new(
                "forbidden_package_entry",
                format!("The package contains a forbidden entry: {name}"),
            ));
        }
        if entry.unix_mode().is_some_and(|mode| {
            let file_type = mode & 0o170000;
            file_type != 0 && file_type != 0o100000
        }) {
            return Err(MarketPackageError::new(
                "package_link_forbidden",
                "Symbolic and hard links are not allowed in MiniApp packages.",
            ));
        }
        total_uncompressed = total_uncompressed.saturating_add(entry.size());
        if total_uncompressed > MARKET_MAX_UNCOMPRESSED_BYTES {
            return Err(MarketPackageError::new(
                "package_expansion_too_large",
                "The uncompressed MiniApp package exceeds 64 MiB.",
            ));
        }
        let mut content = String::new();
        entry.read_to_string(&mut content).map_err(|_| {
            MarketPackageError::new(
                "invalid_package_text",
                format!("{name} must be valid UTF-8 text."),
            )
        })?;
        files.insert(name, content);
    }

    for required in REQUIRED_ENTRIES {
        if !files.contains_key(*required) {
            return Err(MarketPackageError::new(
                "missing_package_entry",
                format!("The package is missing {required}."),
            ));
        }
    }

    validate_worker(
        files
            .get("source/worker.js")
            .map(String::as_str)
            .unwrap_or(""),
    )?;
    validate_esm_dependencies(
        files
            .get("source/esm_dependencies.json")
            .map(String::as_str)
            .unwrap_or(""),
    )?;
    validate_no_remote_executable_content(&files)?;

    let raw_meta: serde_json::Value = serde_json::from_str(
        files
            .get("meta.json")
            .map(String::as_str)
            .unwrap_or_default(),
    )
    .map_err(|error| {
        MarketPackageError::new("invalid_meta", format!("Invalid meta.json: {error}"))
    })?;
    if raw_meta.pointer("/permissions/node/enabled") != Some(&serde_json::Value::Bool(false)) {
        return Err(MarketPackageError::new(
            "node_forbidden",
            "Marketplace packages must explicitly set permissions.node.enabled to false.",
        ));
    }
    let meta: MarketPackageMeta = serde_json::from_value(raw_meta).map_err(|error| {
        MarketPackageError::new(
            "invalid_meta",
            format!("Invalid marketplace metadata: {error}"),
        )
    })?;
    validate_package_meta(&meta)?;

    Ok(ValidatedMarketPackage {
        sha256: hex::encode(Sha256::digest(bytes)),
        size: bytes.len() as u64,
        meta,
        source_files: files,
    })
}

pub fn build_market_package(app: &MiniApp) -> Result<Vec<u8>, MarketPackageError> {
    let meta = MarketPackageMeta {
        chrome: app.chrome.clone(),
        name: app.name.clone(),
        description: app.description.clone(),
        icon: app.icon.clone(),
        category: app.category.clone(),
        tags: app.tags.clone(),
        version: app.version,
        permissions: app.permissions.clone(),
        i18n: app.i18n.clone(),
    };
    validate_package_meta(&meta)?;

    let meta_json = serde_json::to_string_pretty(&meta).map_err(|error| {
        MarketPackageError::new(
            "invalid_meta",
            format!("Could not serialize meta.json: {error}"),
        )
    })?;
    let cursor = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(cursor);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);
    for (name, content) in [
        ("meta.json", meta_json.as_str()),
        ("source/index.html", app.source.html.as_str()),
        ("source/style.css", app.source.css.as_str()),
        ("source/ui.js", app.source.ui_js.as_str()),
        ("source/worker.js", app.source.worker_js.as_str()),
        ("source/esm_dependencies.json", "[]"),
    ] {
        writer
            .start_file(name, options)
            .map_err(|error| MarketPackageError::new("package_write_failed", error.to_string()))?;
        writer
            .write_all(content.as_bytes())
            .map_err(|error| MarketPackageError::new("package_write_failed", error.to_string()))?;
    }
    let bytes = writer
        .finish()
        .map_err(|error| MarketPackageError::new("package_write_failed", error.to_string()))?
        .into_inner();
    validate_market_package(&bytes)?;
    Ok(bytes)
}

fn validate_worker(worker: &str) -> Result<(), MarketPackageError> {
    let compact = worker
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<String>()
        .replace(char::is_whitespace, "");
    if compact.is_empty()
        || matches!(
            compact.as_str(),
            "module.exports={};" | "module.exports={}" | "export{};" | "export{}"
        )
    {
        return Ok(());
    }
    Err(MarketPackageError::new(
        "worker_forbidden",
        "Marketplace v1 only accepts an empty or no-op worker.js.",
    ))
}

fn validate_esm_dependencies(content: &str) -> Result<(), MarketPackageError> {
    let dependencies: Vec<serde_json::Value> = serde_json::from_str(content).map_err(|error| {
        MarketPackageError::new(
            "invalid_esm_dependencies",
            format!("Invalid esm_dependencies.json: {error}"),
        )
    })?;
    if !dependencies.is_empty() {
        return Err(MarketPackageError::new(
            "esm_dependencies_forbidden",
            "Marketplace v1 does not accept runtime ESM dependencies.",
        ));
    }
    Ok(())
}

fn validate_no_remote_executable_content(
    files: &BTreeMap<String, String>,
) -> Result<(), MarketPackageError> {
    let html = files
        .get("source/index.html")
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    let forbidden_html = [
        "<script src=",
        "<iframe",
        "<object",
        "<embed",
        "javascript:",
        "http-equiv=\"refresh\"",
        "http-equiv='refresh'",
    ];
    if forbidden_html.iter().any(|needle| html.contains(needle)) {
        return Err(MarketPackageError::new(
            "remote_executable_content_forbidden",
            "The MiniApp HTML contains a forbidden executable or navigation element.",
        ));
    }
    let ui_js = files
        .get("source/ui.js")
        .map(String::as_str)
        .unwrap_or_default();
    let compact = ui_js.replace(char::is_whitespace, "");
    if compact.contains("import(\"http")
        || compact.contains("import('http")
        || compact.contains("import(`http")
        || compact.contains("eval(")
        || compact.contains("newFunction(")
    {
        return Err(MarketPackageError::new(
            "dynamic_code_forbidden",
            "Remote imports and dynamic code evaluation are not allowed.",
        ));
    }
    Ok(())
}

fn validate_package_meta(meta: &MarketPackageMeta) -> Result<(), MarketPackageError> {
    if let Some(chrome) = &meta.chrome {
        chrome
            .validate()
            .map_err(|error| MarketPackageError::new("invalid_chrome", error))?;
    }
    if meta.name.trim().is_empty() || meta.name.chars().count() > 80 {
        return Err(MarketPackageError::new(
            "invalid_name",
            "MiniApp names must contain between 1 and 80 characters.",
        ));
    }
    if meta.description.trim().is_empty() || meta.description.chars().count() > 500 {
        return Err(MarketPackageError::new(
            "invalid_description",
            "MiniApp descriptions must contain between 1 and 500 characters.",
        ));
    }
    if !openbitfun_product_domains::miniapp::market::validate_market_category(&meta.category) {
        return Err(MarketPackageError::new(
            "invalid_category",
            "The MiniApp category is not supported.",
        ));
    }
    if meta.tags.len() > 10 || meta.tags.iter().any(|tag| tag.chars().count() > 32) {
        return Err(MarketPackageError::new(
            "invalid_tags",
            "MiniApps may declare at most 10 tags of up to 32 characters.",
        ));
    }
    if meta
        .permissions
        .node
        .as_ref()
        .is_none_or(|node| node.enabled)
    {
        return Err(MarketPackageError::new(
            "node_forbidden",
            "Marketplace packages cannot enable Node.",
        ));
    }
    if meta
        .permissions
        .fs
        .as_ref()
        .into_iter()
        .flat_map(|fs| {
            fs.read
                .iter()
                .chain(fs.write.iter())
                .flat_map(|values| values.iter())
        })
        .any(|scope| scope == "{home}" || scope.starts_with('/') || scope.contains(":\\"))
    {
        return Err(MarketPackageError::new(
            "broad_filesystem_scope_forbidden",
            "Marketplace packages may use appdata, workspace, or user-selected paths only.",
        ));
    }
    if meta
        .permissions
        .shell
        .as_ref()
        .and_then(|shell| shell.allow.as_ref())
        .is_some_and(|commands| {
            commands
                .iter()
                .any(|command| is_forbidden_interpreter(command))
        })
    {
        return Err(MarketPackageError::new(
            "shell_interpreter_forbidden",
            "Shells and general-purpose interpreters cannot be allowlisted.",
        ));
    }
    Ok(())
}

fn is_forbidden_interpreter(command: &str) -> bool {
    matches!(
        command.trim().to_ascii_lowercase().as_str(),
        "sh" | "bash"
            | "zsh"
            | "fish"
            | "cmd"
            | "cmd.exe"
            | "powershell"
            | "powershell.exe"
            | "pwsh"
            | "python"
            | "python3"
            | "node"
            | "bun"
            | "deno"
            | "ruby"
            | "perl"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_product_domains::miniapp::types::{MiniAppPermissions, NodePermissions};

    #[test]
    fn generated_package_roundtrips_through_strict_validator() {
        let app = MiniApp {
            chrome: Some(
                serde_json::from_value(serde_json::json!({"titlebar":{"title":"Packaged window"}}))
                    .unwrap(),
            ),
            id: "local-id".to_string(),
            name: "Safe App".to_string(),
            description: "A safe application".to_string(),
            icon: "sparkles".to_string(),
            category: "developer".to_string(),
            tags: vec!["safe".to_string()],
            version: 8,
            created_at: 1,
            updated_at: 2,
            source: openbitfun_product_domains::miniapp::types::MiniAppSource {
                html: "<main>Safe</main>".to_string(),
                css: String::new(),
                ui_js: "document.body.dataset.ready = '1';".to_string(),
                esm_dependencies: vec![],
                worker_js: String::new(),
                npm_dependencies: vec![],
            },
            compiled_html: String::new(),
            permissions: MiniAppPermissions {
                node: Some(NodePermissions {
                    enabled: false,
                    ..Default::default()
                }),
                ..Default::default()
            },
            ai_context: None,
            runtime: Default::default(),
            runtime_profile: Default::default(),
            i18n: None,
        };

        let bytes = build_market_package(&app).unwrap();
        let validated = validate_market_package(&bytes).unwrap();
        assert_eq!(validated.meta.name, "Safe App");
        assert_eq!(validated.meta.chrome, app.chrome);
        assert!(!validated.sha256.is_empty());
    }

    #[test]
    fn desktop_revalidation_rejects_unsafe_and_extra_paths() {
        let unsafe_path = test_package(&[("../secret", "value")]);
        assert_eq!(
            validate_market_package(&unsafe_path).unwrap_err().code,
            "unsafe_package_path"
        );

        let forbidden = test_package(&[("package.json", "{}")]);
        assert_eq!(
            validate_market_package(&forbidden).unwrap_err().code,
            "forbidden_package_entry"
        );

        let collision = test_package(&[("META.JSON", "{}")]);
        assert_eq!(
            validate_market_package(&collision).unwrap_err().code,
            "duplicate_package_path"
        );
    }

    #[test]
    fn desktop_revalidation_rejects_remote_scripts_and_dynamic_code() {
        let remote_script = test_package_with_sources(
            "<main>Safe</main><script src=\"https://example.com/payload.js\"></script>",
            "document.body.dataset.ready = '1';",
        );
        assert_eq!(
            validate_market_package(&remote_script).unwrap_err().code,
            "remote_executable_content_forbidden"
        );

        let dynamic_code = test_package_with_sources("<main>Safe</main>", "eval('payload')");
        assert_eq!(
            validate_market_package(&dynamic_code).unwrap_err().code,
            "dynamic_code_forbidden"
        );
    }

    fn test_package(extra: &[(&str, &str)]) -> Vec<u8> {
        test_package_inner(
            "<main>Safe</main>",
            "document.body.dataset.ready = '1';",
            extra,
        )
    }

    fn test_package_with_sources(html: &str, ui_js: &str) -> Vec<u8> {
        test_package_inner(html, ui_js, &[])
    }

    fn test_package_inner(html: &str, ui_js: &str, extra: &[(&str, &str)]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(cursor);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);
        let meta = r#"{
          "name":"Safe App",
          "description":"A safe application",
          "icon":"box",
          "category":"developer",
          "tags":[],
          "version":1,
          "permissions":{"node":{"enabled":false}}
        }"#;
        for (name, content) in [
            ("meta.json", meta),
            ("source/index.html", html),
            ("source/style.css", ""),
            ("source/ui.js", ui_js),
            ("source/worker.js", ""),
            ("source/esm_dependencies.json", "[]"),
        ] {
            writer.start_file(name, options).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        for (name, content) in extra {
            writer.start_file(*name, options).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }
}
