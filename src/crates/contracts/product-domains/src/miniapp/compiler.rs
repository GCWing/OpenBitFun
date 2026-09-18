//! MiniApp compiler — assemble source (html/css/ui_js) + import map + runtime bridge.

use crate::miniapp::bridge_builder::{
    build_bridge_script, build_csp_content, build_import_map, build_market_bridge_script,
    build_market_csp_content, build_miniapp_default_appearance_css, scroll_boundary_script,
};
use crate::miniapp::lifecycle::workspace_dir_string;
use crate::miniapp::types::{MiniAppPermissions, MiniAppSource};
use std::fmt;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MiniAppCompileError {
    message: String,
}

impl MiniAppCompileError {
    pub fn validation(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for MiniAppCompileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for MiniAppCompileError {}

pub type MiniAppCompileResult<T> = Result<T, MiniAppCompileError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MiniAppCompileRequest {
    pub app_id: String,
    pub app_data_dir: String,
    pub workspace_dir: String,
    pub appearance_mode: String,
}

impl MiniAppCompileRequest {
    pub fn from_paths(
        app_id: impl Into<String>,
        app_data_dir: impl AsRef<Path>,
        workspace_root: Option<&Path>,
        appearance_mode: impl Into<String>,
    ) -> Self {
        Self {
            app_id: app_id.into(),
            app_data_dir: app_data_dir.as_ref().to_string_lossy().to_string(),
            workspace_dir: workspace_dir_string(workspace_root),
            appearance_mode: appearance_mode.into(),
        }
    }
}

/// Compile MiniApp source into full HTML with import map, runtime bridge, and CSP injected.
pub fn compile(
    source: &MiniAppSource,
    permissions: &MiniAppPermissions,
    app_id: &str,
    app_data_dir: &str,
    workspace_dir: &str,
    appearance_mode: &str,
) -> MiniAppCompileResult<String> {
    compile_internal(
        source,
        permissions,
        app_id,
        app_data_dir,
        workspace_dir,
        appearance_mode,
        false,
    )
}

fn compile_internal(
    source: &MiniAppSource,
    permissions: &MiniAppPermissions,
    app_id: &str,
    app_data_dir: &str,
    workspace_dir: &str,
    appearance_mode: &str,
    market_strict: bool,
) -> MiniAppCompileResult<String> {
    if market_strict {
        validate_market_runtime_source(source, permissions)?;
    }
    let platform = if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };

    let bridge = if market_strict {
        build_market_bridge_script(
            app_id,
            app_data_dir,
            workspace_dir,
            appearance_mode,
            platform,
        )
    } else {
        build_bridge_script(
            app_id,
            app_data_dir,
            workspace_dir,
            appearance_mode,
            platform,
        )
    };
    let csp = if market_strict {
        build_market_csp_content().to_string()
    } else {
        build_csp_content(permissions)
    };
    let csp_tag = format!(
        "<meta http-equiv=\"Content-Security-Policy\" content=\"{}\">",
        csp.replace('"', "&quot;")
    );
    let scroll = scroll_boundary_script();
    let appearance_default_style = build_miniapp_default_appearance_css();
    let import_map = build_import_map(&source.esm_dependencies);
    let style_tag = if source.css.is_empty() {
        String::new()
    } else {
        format!("<style>\n{}\n</style>", source.css)
    };
    let bridge_script_tag = format!("<script>\n{}\n</script>", bridge);
    let user_script_tag = if source.ui_js.is_empty() {
        String::new()
    } else {
        format!("<script type=\"module\">\n{}\n</script>", source.ui_js)
    };

    let head_content = format!(
        "\n{}\n{}\n{}\n{}\n{}\n{}\n",
        appearance_default_style, csp_tag, scroll, import_map, bridge_script_tag, style_tag,
    );

    let html = if source.html.trim().is_empty() {
        let appearance_attr = format!(
            " data-openbitfun-appearance-mode=\"{}\"",
            escape_html_attr(appearance_mode)
        );
        format!(
            r#"<!DOCTYPE html>
<html{appearance_attr}>
<head>{head}</head>
<body>
{user_script}
</body>
</html>"#,
            appearance_attr = appearance_attr,
            head = head_content,
            user_script = user_script_tag,
        )
    } else {
        let with_appearance = inject_data_appearance_mode(&source.html, appearance_mode);
        let with_head = inject_into_head(&with_appearance, &head_content)?;
        inject_before_body_close(&with_head, &user_script_tag)
    };

    Ok(html)
}

pub fn compile_with_request(
    source: &MiniAppSource,
    permissions: &MiniAppPermissions,
    request: &MiniAppCompileRequest,
) -> MiniAppCompileResult<String> {
    compile(
        source,
        permissions,
        &request.app_id,
        &request.app_data_dir,
        &request.workspace_dir,
        &request.appearance_mode,
    )
}

/// Compile a reviewed marketplace package using the strict runtime profile.
pub fn compile_market_with_request(
    source: &MiniAppSource,
    permissions: &MiniAppPermissions,
    request: &MiniAppCompileRequest,
) -> MiniAppCompileResult<String> {
    compile_internal(
        source,
        permissions,
        &request.app_id,
        &request.app_data_dir,
        &request.workspace_dir,
        &request.appearance_mode,
        true,
    )
}

fn validate_market_runtime_source(
    source: &MiniAppSource,
    permissions: &MiniAppPermissions,
) -> MiniAppCompileResult<()> {
    if permissions.node.as_ref().is_none_or(|node| node.enabled) {
        return Err(MiniAppCompileError::validation(
            "marketplace MiniApps must explicitly disable Node",
        ));
    }
    if !source.esm_dependencies.is_empty() || !source.npm_dependencies.is_empty() {
        return Err(MiniAppCompileError::validation(
            "marketplace MiniApps cannot declare ESM or npm dependencies",
        ));
    }
    let compact_worker = source
        .worker_js
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<String>()
        .replace(char::is_whitespace, "");
    if !compact_worker.is_empty()
        && !matches!(
            compact_worker.as_str(),
            "module.exports={};" | "module.exports={}" | "export{};" | "export{}"
        )
    {
        return Err(MiniAppCompileError::validation(
            "marketplace MiniApps cannot run worker code",
        ));
    }
    Ok(())
}

/// Place content just before </body>. If no </body> found, append before </html> or at end.
fn inject_before_body_close(html: &str, content: &str) -> String {
    if content.is_empty() {
        return html.to_string();
    }
    if let Some(pos) = html.rfind("</body>") {
        let (before, after) = html.split_at(pos);
        return format!("{}\n{}\n{}", before, content, after);
    }
    if let Some(pos) = html.rfind("</html>") {
        let (before, after) = html.split_at(pos);
        return format!("{}\n{}\n{}", before, content, after);
    }
    format!("{}\n{}", html, content)
}

fn escape_html_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Inject data-openbitfun-appearance-mode on the first <html> tag.
fn inject_data_appearance_mode(html: &str, appearance_mode: &str) -> String {
    let safe = escape_html_attr(appearance_mode);
    if let Some(idx) = html.find("<html") {
        let after_html = idx + 5;
        let rest = &html[after_html..];
        if let Some(close) = rest.find('>') {
            let tag = &html[idx..after_html + close + 1];
            if tag.contains("data-openbitfun-appearance-mode=") {
                return html.to_string();
            }
            let insert = format!(" data-openbitfun-appearance-mode=\"{}\"", safe);
            return format!(
                "{}{}>{}",
                &html[..after_html + close],
                insert,
                &html[after_html + close + 1..]
            );
        }
    }
    html.to_string()
}

fn inject_into_head(html: &str, content: &str) -> MiniAppCompileResult<String> {
    if let Some(head_start) = html.find("<head") {
        let after_head_open = if let Some(close_bracket) = html[head_start..].find('>') {
            head_start + close_bracket + 1
        } else {
            return Err(MiniAppCompileError::validation(
                "Invalid HTML: <head> not properly opened".to_string(),
            ));
        };
        let before = &html[..after_head_open];
        let after = &html[after_head_open..];
        return Ok(format!("{}{}{}", before, content, after));
    }

    if let Some(html_open) = html.find("<html") {
        let after_html_open = if let Some(close_bracket) = html[html_open..].find('>') {
            html_open + close_bracket + 1
        } else {
            return Err(MiniAppCompileError::validation(
                "Invalid HTML: <html> not properly opened".to_string(),
            ));
        };
        let before = &html[..after_html_open];
        let after = &html[after_html_open..];
        return Ok(format!("{}\n<head>{}</head>{}", before, content, after));
    }

    Ok(format!(
        r#"<!DOCTYPE html>
<html>
<head>{}</head>
<body>
{}
</body>
</html>"#,
        content, html
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::miniapp::types::{MiniAppPermissions, MiniAppSource};
    use std::path::Path;

    #[test]
    fn inject_into_head_preserves_existing_head_content() {
        let html =
            r#"<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>x</body></html>"#;
        let content = "<!-- injected -->";
        let out = inject_into_head(html, content).unwrap();

        assert!(out.contains("<!-- injected -->"));
        assert!(out.contains("<meta charset"));
    }

    #[test]
    fn compile_request_from_paths_preserves_runtime_paths() {
        let app_data_dir = Path::new("miniapps").join("app-1");
        let workspace_root = Path::new("workspace").join("project");

        let request = MiniAppCompileRequest::from_paths(
            "app-1",
            &app_data_dir,
            Some(&workspace_root),
            "dark",
        );

        assert_eq!(request.app_id, "app-1");
        assert_eq!(request.app_data_dir, app_data_dir.to_string_lossy());
        assert_eq!(request.workspace_dir, workspace_root.to_string_lossy());
        assert_eq!(request.appearance_mode, "dark");
    }

    #[test]
    fn compile_with_request_preserves_legacy_compile_output() {
        let source = MiniAppSource {
            html: "<!DOCTYPE html><html><head></head><body><div id=\"app\"></div></body></html>"
                .to_string(),
            css: "#app { color: red; }".to_string(),
            ui_js: "console.log('ready');".to_string(),
            worker_js: String::new(),
            esm_dependencies: Vec::new(),
            npm_dependencies: Vec::new(),
        };
        let permissions = MiniAppPermissions::default();
        let request = MiniAppCompileRequest {
            app_id: "app-1".to_string(),
            app_data_dir: "/tmp/miniapps/app-1".to_string(),
            workspace_dir: "/tmp/workspace".to_string(),
            appearance_mode: "dark".to_string(),
        };

        let legacy = compile(
            &source,
            &permissions,
            &request.app_id,
            &request.app_data_dir,
            &request.workspace_dir,
            &request.appearance_mode,
        )
        .unwrap();
        let compiled = compile_with_request(&source, &permissions, &request).unwrap();

        assert_eq!(compiled, legacy);
        assert!(compiled.contains("data-openbitfun-appearance-mode=\"dark\""));
        assert!(compiled.contains("console.log('ready');"));
        assert!(compiled.contains("event === 'chat:userMessage'"));
        assert!(compiled.contains("_chatUserMessagePending"));
        assert!(compiled.contains("Promise.all(handlers.map"));
        assert!(compiled.contains("_rpc('chat.completeUserMessage'"));
    }

    #[test]
    fn inject_data_appearance_mode_skips_existing_attribute() {
        let source = MiniAppSource {
            html:
                r#"<!DOCTYPE html><html lang="zh-CN" data-openbitfun-appearance-mode="dark"><body></body></html>"#
                    .to_string(),
            css: String::new(),
            ui_js: String::new(),
            esm_dependencies: vec![],
            worker_js: String::new(),
            npm_dependencies: vec![],
        };
        let permissions = MiniAppPermissions::default();
        let request = MiniAppCompileRequest {
            app_id: "app-1".to_string(),
            app_data_dir: "/tmp/miniapps/app-1".to_string(),
            workspace_dir: "/tmp/workspace".to_string(),
            appearance_mode: "dark".to_string(),
        };

        let compiled = compile_with_request(&source, &permissions, &request).unwrap();
        assert_eq!(
            compiled
                .matches("data-openbitfun-appearance-mode=\"dark\"")
                .count(),
            1
        );
    }

    #[test]
    fn market_compile_uses_strict_csp_and_rejects_dependencies() {
        let mut source = MiniAppSource {
            html: "<!DOCTYPE html><html><head></head><body></body></html>".to_string(),
            css: String::new(),
            ui_js: "window.ready = true;".to_string(),
            esm_dependencies: vec![],
            worker_js: String::new(),
            npm_dependencies: vec![],
        };
        let permissions = MiniAppPermissions {
            node: Some(crate::miniapp::types::NodePermissions {
                enabled: false,
                ..Default::default()
            }),
            ..Default::default()
        };
        let request = MiniAppCompileRequest::from_paths("market-app", "/tmp/app", None, "dark");

        let compiled = compile_market_with_request(&source, &permissions, &request).unwrap();
        assert!(compiled.contains("connect-src 'none'"));
        assert!(compiled.contains("frame-src 'none'"));
        assert!(!compiled.contains("'unsafe-eval'"));
        assert!(!compiled.contains("script-src 'self'"));

        source.esm_dependencies.push(crate::miniapp::types::EsmDep {
            name: "react".to_string(),
            version: None,
            url: None,
        });
        assert!(compile_market_with_request(&source, &permissions, &request).is_err());
    }

    #[test]
    fn market_compile_never_injects_private_builtin_extensions() {
        let source = MiniAppSource {
            html: "<!DOCTYPE html><html><head></head><body></body></html>".to_string(),
            css: String::new(),
            ui_js: String::new(),
            esm_dependencies: vec![],
            worker_js: String::new(),
            npm_dependencies: vec![],
        };
        let permissions = MiniAppPermissions {
            node: Some(crate::miniapp::types::NodePermissions {
                enabled: false,
                ..Default::default()
            }),
            ..Default::default()
        };
        let request =
            MiniAppCompileRequest::from_paths("builtin-bitfun-loopx", "/tmp/app", None, "dark");

        let compiled = compile_market_with_request(&source, &permissions, &request).unwrap();
        assert!(!compiled.contains("loopx.attach"));
    }
}
