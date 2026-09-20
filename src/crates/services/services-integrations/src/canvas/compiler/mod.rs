//! Canvas compiler and runtime HTML assembly.
//!
//! Phase 1 uses a narrow Canvas module contract with OXC for TSX parsing and
//! JSX/TypeScript lowering. Unsupported Canvas policy still returns compile
//! diagnostics so callers can retain the last-known-good payload.

#[cfg(feature = "canvas-runtime")]
mod analysis;
#[cfg(feature = "canvas-runtime")]
mod diagnostics;
mod html;
mod oxc;
#[cfg(feature = "canvas-runtime")]
mod sdk_contract;

#[cfg(test)]
mod tests;

use openbitfun_product_domains::canvas::policy::validate_canvas_source_policy;
use openbitfun_product_domains::canvas::runtime::CanvasCompileResult;
use openbitfun_product_domains::canvas::types::{
    CanvasCompiledPayload, CanvasDiagnostic, CanvasDiagnosticCategory, CanvasDiagnosticSeverity,
    CanvasSource,
};
use openbitfun_product_domains::canvas::{
    OPENBITFUN_CANVAS_RUNTIME_VERSION, OPENBITFUN_CANVAS_SDK_VERSION,
};

pub use html::compile_canvas_html;
use html::stable_content_hash;

pub fn compile_canvas_source(source: &CanvasSource, compiled_at: i64) -> CanvasCompileResult {
    let policy_diagnostics = validate_canvas_source_policy(source);
    if has_error(&policy_diagnostics) {
        return CanvasCompileResult {
            payload: None,
            diagnostics: policy_diagnostics,
            compiled: false,
        };
    }

    match compile_canvas_component_js(&source.source) {
        Ok(component_js) => {
            let html = compile_canvas_html(source, &component_js);
            let diagnostics = policy_diagnostics;
            let payload = CanvasCompiledPayload {
                canvas_id: source.canvas_id.clone(),
                source_revision: source.revision.clone(),
                sdk_version: OPENBITFUN_CANVAS_SDK_VERSION.to_string(),
                runtime_version: OPENBITFUN_CANVAS_RUNTIME_VERSION.to_string(),
                content_hash: stable_content_hash(&html),
                html,
                diagnostics: diagnostics.clone(),
                compiled_at,
            };
            CanvasCompileResult {
                payload: Some(payload),
                diagnostics,
                compiled: true,
            }
        }
        Err(diagnostics) => {
            let mut all_diagnostics = policy_diagnostics;
            all_diagnostics.extend(diagnostics);
            CanvasCompileResult {
                payload: None,
                diagnostics: all_diagnostics,
                compiled: false,
            }
        }
    }
}

pub fn compile_canvas_component_js(source: &str) -> Result<String, Vec<CanvasDiagnostic>> {
    oxc::compile_canvas_component_js_with_oxc(source)
}

fn has_error(diagnostics: &[CanvasDiagnostic]) -> bool {
    diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == CanvasDiagnosticSeverity::Error)
}

fn compile_error(message: impl Into<String>, code: impl Into<String>) -> CanvasDiagnostic {
    CanvasDiagnostic {
        severity: CanvasDiagnosticSeverity::Error,
        category: CanvasDiagnosticCategory::Compile,
        message: message.into(),
        code: Some(code.into()),
        line: None,
        column: None,
        suggested_fix: Some(
            "Use a single default-exported function component with Canvas SDK JSX.".to_string(),
        ),
    }
}

#[cfg(feature = "canvas-runtime")]
pub(super) fn line_column(source: &str, offset: usize) -> (u32, u32) {
    let mut line = 1u32;
    let mut column = 1u32;
    for (index, ch) in source.char_indices() {
        if index >= offset {
            break;
        }
        if ch == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    (line, column)
}
