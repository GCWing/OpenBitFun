//! GenerativeUI tool — renders LLM-generated HTML/SVG widgets.

use crate::agentic::tools::framework::{
    Tool, ToolExposure, ToolResult, ToolUseContext, ValidationResult,
};
use crate::agentic::tools::parse_i64_value;
use crate::service::config::get_global_config_service;
use crate::util::errors::OpenBitFunResult;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::OnceLock;

pub struct GenerativeUITool;

const LARGE_WIDGET_CODE_SOFT_LINE_LIMIT: usize = 260;
const LARGE_WIDGET_CODE_SOFT_BYTE_LIMIT: usize = 28 * 1024;
const APPEARANCE_PROMPT_SNAPSHOT_SCHEMA_VERSION: u8 = 1;
const APPEARANCE_PROMPT_SNAPSHOTS_JSON: &str =
    include_str!("generated/appearance_prompt_snapshots.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppearancePromptSnapshotManifest {
    schema_version: u8,
    default_light_appearance_id: String,
    default_dark_appearance_id: String,
    appearances: Vec<AppearancePromptSnapshot>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppearancePromptSnapshot {
    id: String,
    mode: String,
    bg_primary: String,
    bg_secondary: String,
    bg_scene: String,
    text_primary: String,
    text_muted: String,
    accent_500: String,
    accent_600: String,
    border_base: String,
    element_base: String,
    shadow_base: String,
    style_notes: String,
}

impl GenerativeUITool {
    pub fn new() -> Self {
        Self
    }

    fn architecture_widget_reminder() -> &'static str {
        "Architecture/codebase widget reminder: if the widget is a repo map, README architecture view, or module diagram, clickable nodes must carry verified file metadata on the clickable element itself. Use `data-file-path` for a REAL existing file and `data-line` for the exact definition line when the node represents code. Do not attach file metadata to abstract grouping nodes, package containers, or directories. If a node is conceptual or cannot be verified, leave it non-clickable."
    }

    fn openbitfun_design_system_reminder() -> &'static str {
        "OpenBitFun design-system reminder: when the widget should feel native to the host OpenBitFun app, compose the provided `openbitfun-*` scaffold classes first and use host-projected canonical tokens instead of hard-coded design values. Prefer CSS variables such as `var(--openbitfun-color-surface-canvas)`, `var(--openbitfun-color-surface-panel)`, `var(--openbitfun-color-surface-scene)`, `var(--openbitfun-color-surface-raised)`, `var(--openbitfun-color-content-primary)`, `var(--openbitfun-color-content-secondary)`, `var(--openbitfun-color-content-muted)`, `var(--openbitfun-color-accent-default)`, `var(--openbitfun-color-accent-hover)`, `var(--openbitfun-color-border-subtle)`, `var(--openbitfun-color-border-default)`, `var(--openbitfun-color-border-strong)`, `var(--openbitfun-color-action-neutral-surface)`, `var(--openbitfun-color-action-neutral-surface-hover)`, `var(--openbitfun-color-action-quiet-hover)`, `var(--openbitfun-shadow-*)`, `var(--openbitfun-motion-duration-*)`, `var(--openbitfun-motion-easing-*)`, `var(--openbitfun-font-family-sans)`, and `var(--openbitfun-font-family-mono)`. Radius, spacing, font-size, and font-weight variables are iframe-local scaffold values rather than host appearance extension points. Support both `openbitfun-dark` and `openbitfun-light`; do not assume dark-only, purple-only, or landing-page styling. Favor compact desktop workbench layouts, panel/card surfaces, strong information hierarchy, and reusable OpenBitFun component patterns. Avoid hard-coded colors, arbitrary spacing, giant hero sections, fake mobile chrome, and full marketing-page shells; prefer understated, premium UI with layered surfaces, restrained contrast, subtle borders, and do not use thick left-accent emphasis blocks."
    }

    fn openbitfun_widget_scaffold_reminder() -> &'static str {
        "OpenBitFun widget scaffold reminder: the host iframe already provides reusable utility classes. Prefer these host classes before inventing a new visual language: `openbitfun-root`, `openbitfun-stack`, `openbitfun-row`, `openbitfun-row-wrap`, `openbitfun-toolbar`, `openbitfun-section`, `openbitfun-section-header`, `openbitfun-title`, `openbitfun-subtitle`, `openbitfun-eyebrow`, `openbitfun-card`, `openbitfun-panel`, `openbitfun-card-accent`, `openbitfun-grid`, `openbitfun-kpi`, `openbitfun-kpi-label`, `openbitfun-kpi-value`, `openbitfun-kpi-meta`, `openbitfun-badge`, `openbitfun-badge-accent`, `openbitfun-badge-success`, `openbitfun-badge-warning`, `openbitfun-badge-error`, `openbitfun-button`, `openbitfun-button-primary`, `openbitfun-input`, `openbitfun-textarea`, `openbitfun-select`, `openbitfun-list`, `openbitfun-list-item`, `openbitfun-table-wrap`, `openbitfun-table`, `openbitfun-empty`, `openbitfun-divider`, `openbitfun-code`, and `openbitfun-mono`. Generate markup that composes these classes first, and only add small local CSS when the scaffold is insufficient."
    }

    fn combined_reminder() -> String {
        format!(
            "{} {} {}",
            Self::architecture_widget_reminder(),
            Self::openbitfun_design_system_reminder(),
            Self::openbitfun_widget_scaffold_reminder()
        )
    }

    fn appearance_prompt_snapshot_manifest() -> &'static AppearancePromptSnapshotManifest {
        static MANIFEST: OnceLock<AppearancePromptSnapshotManifest> = OnceLock::new();
        MANIFEST.get_or_init(|| {
            let manifest: AppearancePromptSnapshotManifest =
                serde_json::from_str(APPEARANCE_PROMPT_SNAPSHOTS_JSON)
                    .expect("generated appearance prompt snapshot manifest must be valid JSON");
            assert_eq!(
                manifest.schema_version, APPEARANCE_PROMPT_SNAPSHOT_SCHEMA_VERSION,
                "generated appearance prompt snapshot manifest version mismatch"
            );
            manifest
        })
    }

    fn builtin_appearance_snapshot(
        appearance_id: &str,
    ) -> Option<&'static AppearancePromptSnapshot> {
        Self::appearance_prompt_snapshot_manifest()
            .appearances
            .iter()
            .find(|snapshot| snapshot.id == appearance_id)
    }

    fn format_appearance_snapshot(snapshot: &AppearancePromptSnapshot) -> String {
        format!(
            "{} ({}) => bg.primary={}, bg.secondary={}, bg.scene={}, text.primary={}, text.muted={}, accent.500={}, accent.600={}, border.base={}, element.base={}, shadow.base={}, style={}",
            snapshot.id,
            snapshot.mode,
            snapshot.bg_primary,
            snapshot.bg_secondary,
            snapshot.bg_scene,
            snapshot.text_primary,
            snapshot.text_muted,
            snapshot.accent_500,
            snapshot.accent_600,
            snapshot.border_base,
            snapshot.element_base,
            snapshot.shadow_base,
            snapshot.style_notes
        )
    }

    fn baseline_appearance_context() -> String {
        let manifest = Self::appearance_prompt_snapshot_manifest();
        let dark = Self::builtin_appearance_snapshot(&manifest.default_dark_appearance_id)
            .map(Self::format_appearance_snapshot)
            .unwrap_or_default();
        let light = Self::builtin_appearance_snapshot(&manifest.default_light_appearance_id)
            .map(Self::format_appearance_snapshot)
            .unwrap_or_default();
        format!(
            "Cross-appearance baseline: {}. {}. Widgets must remain correct in both appearances by default.",
            dark, light
        )
    }

    async fn build_appearance_prompt_context(&self) -> Option<String> {
        let config_service = get_global_config_service().await.ok()?;
        let selected_appearance_id = config_service
            .get_config::<String>(Some("appearance.selection"))
            .await
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "system".to_string());

        if selected_appearance_id == "system" {
            return Some(format!(
                "OpenBitFun active appearance selection: system. Exact runtime resolution is host-dependent, so do not assume one palette. {}",
                Self::baseline_appearance_context()
            ));
        }

        if let Some(snapshot) = Self::builtin_appearance_snapshot(&selected_appearance_id) {
            return Some(format!(
                "OpenBitFun active appearance snapshot: {}. {}",
                Self::format_appearance_snapshot(snapshot),
                Self::baseline_appearance_context()
            ));
        }

        Some(format!(
            "OpenBitFun active appearance selection: {}. Backend does not have an exact built-in snapshot for this appearance, so use OpenBitFun CSS variables strictly and avoid hard-coded fallback palettes. {}",
            selected_appearance_id,
            Self::baseline_appearance_context()
        ))
    }
}

impl Default for GenerativeUITool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for GenerativeUITool {
    fn name(&self) -> &str {
        "GenerativeUI"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(format!(
            r#"Use GenerativeUI to render visual HTML or SVG content.

Use this when the user asks for visual or interactive output such as:
- charts, dashboards, tables
- explainers with sliders or controls
- diagrams, mockups, or small simulations
- SVG illustrations

Input rules:
1. Put the widget code in `widget_code`.
2. For HTML, provide a raw fragment only. Do NOT include Markdown fences, <!DOCTYPE>, <html>, <head>, or <body>.
3. For SVG, provide raw SVG starting with <svg>.
4. Put CSS first, then HTML, then scripts last so the preview can stream progressively.
5. Keep the first useful content visible early. Avoid giant style blocks.
6. Prefer self-contained widgets. CDN scripts are allowed when needed, but keep them minimal.
6a. Keep `widget_code` compact. The 260-line / 28KB guideline is a soft reliability threshold, not a hard cap. If the widget is larger, reduce repeated static DOM with data-driven loops, shared CSS classes, and simpler markup rather than truncating required behavior.
7. If the user only needs text, do not use this tool.
8. Prefer compact, scroll-light layouts. Avoid large CSS resets, fixed overlays, oversized app chrome, and nested scrolling.
9. IMPORTANT sizing rule: the default target is an inline FlowChat card, not a full browser page. Build responsive widgets that fit a narrow card without horizontal scrolling.
10. Use fluid sizing: `width: 100%`, `max-width: 100%`, responsive grids, wrapped controls, and charts that shrink to their container. Do not rely on fixed pixel widths, `min-width` hacks, wide tables, or page-sized canvases.
11. Keep the widget focused. Prefer one clear visual or one small interactive tool.
12. If the widget needs follow-up reasoning, use `sendPrompt('...')` from inside the widget.
13. Do not invent custom desktop bridge APIs such as `window.app.call(...)` for file opening inside widgets.
14. Do not use `parent.postMessage(...)` or custom `onclick` protocols for file opening when `data-file-path` can be attached directly to the clickable element.
15. CRITICAL for codebase maps, repo overviews, and architecture diagrams: NEVER guess or invent paths. Every clickable `data-file-path` MUST point to a REAL file that exists in the workspace.
16. For clickable file navigation, add `data-file-path` on the clickable element itself, and add `data-line` for the exact definition or anchor line whenever the node represents code.
17. `data-file-path` may be workspace-relative such as `src/crates/assembly/core/src/lib.rs`, or absolute when already verified, but it MUST resolve to a file, not a directory.
18. Do NOT attach `data-file-path` to abstract grouping nodes such as "Core", "Frontend", "Agent System", or module containers unless that node intentionally opens one specific real file.
19. For codebase architecture diagrams, prefer one clickable node per concrete file. If a node represents a broader concept, package, or directory, leave it non-clickable instead of pointing it at a folder.
20. Workflow for architecture widgets: first verify candidate files with Glob or LS, then use Read with line numbers when needed, and only then emit clickable nodes with verified file paths and lines.
21. If you cannot verify the exact file path and line number, do not make that node clickable. Better to have fewer accurate links than many broken ones.
22. If the user asks for click-to-open files, do not build a details-only interaction with `data-key` and `onclick="showDetail(...)"` unless the clickable node also carries its own `data-file-path`.
23. Do not put one `data-file-path` on a large wrapper that contains multiple visual nodes. The actual clickable node must own the path metadata.
24. Make clickable nodes look clickable with visible grouping, spacing, and hover feedback instead of producing a static poster.
25. For charts, give charts a fixed-height wrapper and keep legends or summary numbers outside the canvas when possible.
26. For mockups, use compact spacing and clear hierarchy. Avoid building full app chrome unless the chrome itself is the point.
27. For lightweight generative art, prefer SVG and keep the output deterministic and performant.
28. If the widget is meant to match OpenBitFun's product UI, apply these reminders strictly: {} {}"#,
            Self::openbitfun_design_system_reminder(),
            Self::openbitfun_widget_scaffold_reminder()
        ))
    }

    async fn description_with_context(
        &self,
        _context: Option<&ToolUseContext>,
    ) -> OpenBitFunResult<String> {
        let mut description = self.description().await?;
        if let Some(appearance_context) = self.build_appearance_prompt_context().await {
            description.push_str("\n\n");
            description.push_str(&appearance_context);
        }
        Ok(description)
    }

    fn short_description(&self) -> String {
        "Render visual HTML or SVG widgets in chat. Use when charts, visual structure, or lightweight interaction would communicate information more clearly and efficiently than plain text.".to_string()
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "description": format!(
                "Render a compact HTML/SVG widget. {}",
                Self::combined_reminder()
            ),
            "required": ["title", "widget_code"],
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Short widget title, for example 'compound interest simulator' or 'latency dashboard'."
                },
                "widget_code": {
                    "type": "string",
                    "description": format!(
                        "Raw HTML fragment or raw SVG. No Markdown code fences. For HTML: no <!DOCTYPE>, <html>, <head>, or <body>. The 260-line / 28KB guideline is a soft reliability threshold. For larger widgets, use data-driven loops, shared CSS classes, and simpler markup rather than truncating required behavior. {} If the widget should match OpenBitFun, rely on `openbitfun-*` scaffold classes plus host-projected color, surface, status, border, shadow, motion, and font-family variables instead of hard-coded colors or custom chrome. Treat radius, spacing, font-size, and font-weight variables as iframe-local scaffold values, not host appearance extension points. If the user asked for file navigation, do not finish this field until each clickable node has verified file metadata or is intentionally non-clickable.",
                        Self::combined_reminder()
                    )
                },
                "width": {
                    "type": "integer",
                    "minimum": 240,
                    "maximum": 1600,
                    "description": "Preferred width in pixels for enlarged panel view. Optional. Do not rely on this for inline card layout; the widget itself must remain responsive and fit narrow containers without horizontal scrolling."
                },
                "height": {
                    "type": "integer",
                    "minimum": 160,
                    "maximum": 1600,
                    "description": "Preferred height in pixels for enlarged panel view. Optional."
                },
                "modules": {
                    "type": "array",
                    "description": "Optional guidance tags such as interactive, chart, mockup, art, diagram, architecture, or repo-map. If this includes architecture/repo-map/diagram, apply the architecture widget reminder strictly.",
                    "items": {
                        "type": "string"
                    }
                }
            }
        })
    }

    async fn input_schema_for_model_with_context(
        &self,
        _context: Option<&ToolUseContext>,
    ) -> Value {
        let mut schema = self.input_schema();
        let appearance_context = self.build_appearance_prompt_context().await;
        if let Some(obj) = schema.as_object_mut() {
            obj.insert(
                "x-openbitfun-reminder".to_string(),
                Value::String(Self::combined_reminder()),
            );
            obj.insert(
                "x-openbitfun-design-system".to_string(),
                Value::String(Self::openbitfun_design_system_reminder().to_string()),
            );
            if let Some(appearance_context) = appearance_context {
                obj.insert(
                    "x-openbitfun-appearance-context".to_string(),
                    Value::String(appearance_context.clone()),
                );
                if let Some(description) = obj
                    .get_mut("description")
                    .and_then(|value| value.as_str().map(str::to_string))
                {
                    obj.insert(
                        "description".to_string(),
                        Value::String(format!("{} {}", description, appearance_context)),
                    );
                }
            }
        }
        schema
    }

    fn user_facing_name(&self) -> String {
        "Generative UI".to_string()
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let title = match input.get("title").and_then(|v| v.as_str()) {
            Some(value) if !value.trim().is_empty() => value.trim(),
            _ => {
                return ValidationResult {
                    result: false,
                    message: Some("Missing or empty title".to_string()),
                    error_code: Some(400),
                    meta: None,
                };
            }
        };

        let widget_code = match input.get("widget_code").and_then(|v| v.as_str()) {
            Some(value) if !value.trim().is_empty() => value.trim(),
            _ => {
                return ValidationResult {
                    result: false,
                    message: Some("Missing or empty widget_code".to_string()),
                    error_code: Some(400),
                    meta: None,
                };
            }
        };

        if title.len() > 120 {
            return ValidationResult {
                result: false,
                message: Some("title is too long; keep it under 120 characters".to_string()),
                error_code: Some(400),
                meta: None,
            };
        }

        if widget_code.starts_with("```") {
            return ValidationResult {
                result: false,
                message: Some(
                    "widget_code must be raw HTML or SVG, not Markdown code fences".to_string(),
                ),
                error_code: Some(400),
                meta: None,
            };
        }

        let line_count = widget_code.lines().count();
        let byte_count = widget_code.len();
        if line_count > LARGE_WIDGET_CODE_SOFT_LINE_LIMIT
            || byte_count > LARGE_WIDGET_CODE_SOFT_BYTE_LIMIT
        {
            return ValidationResult {
                result: true,
                message: Some(format!(
                    "Large GenerativeUI widget_code: {} lines, {} bytes. This is allowed when necessary, but prefer a staged design approach: keep the first version compact, use data-driven loops/shared classes, and iterate rather than emitting a huge static widget payload.",
                    line_count, byte_count
                )),
                error_code: None,
                meta: Some(json!({
                    "large_widget_code": true,
                    "line_count": line_count,
                    "byte_count": byte_count,
                    "soft_line_limit": LARGE_WIDGET_CODE_SOFT_LINE_LIMIT,
                    "soft_byte_limit": LARGE_WIDGET_CODE_SOFT_BYTE_LIMIT
                })),
            };
        }

        ValidationResult::default()
    }

    fn render_result_for_assistant(&self, output: &Value) -> String {
        let title = output
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("widget");

        format!("Rendered widget preview '{}'.", title)
    }

    fn render_tool_use_message(
        &self,
        input: &Value,
        _options: &crate::agentic::tools::framework::ToolRenderOptions,
    ) -> String {
        let title = input
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("widget");
        format!("Rendering widget: {}", title)
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let title = input
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Widget");
        let widget_code = input
            .get("widget_code")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let width = input.get("width").and_then(parse_i64_value).unwrap_or(960);
        let height = input.get("height").and_then(parse_i64_value).unwrap_or(640);
        let modules = input
            .get("modules")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let is_svg = widget_code.trim_start().starts_with("<svg");

        let widget_id = context
            .tool_call_id
            .clone()
            .unwrap_or_else(|| format!("widget_{}", chrono::Utc::now().timestamp_millis()));

        Ok(vec![ToolResult::Result {
            data: json!({
                "success": true,
                "widget_id": widget_id,
                "title": title,
                "widget_code": widget_code,
                "width": width,
                "height": height,
                "is_svg": is_svg,
                "modules": modules,
            }),
            result_for_assistant: Some(format!(
                "Rendered widget '{}' inline in the FlowChat tool card.",
                title
            )),
            image_attachments: None,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn generated_appearance_prompt_manifest_covers_defaults() {
        let manifest = GenerativeUITool::appearance_prompt_snapshot_manifest();

        assert_eq!(
            manifest.schema_version,
            APPEARANCE_PROMPT_SNAPSHOT_SCHEMA_VERSION
        );
        assert!(manifest.appearances.len() >= 2);

        let unique_ids = manifest
            .appearances
            .iter()
            .map(|appearance| appearance.id.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(unique_ids.len(), manifest.appearances.len());
        assert!(unique_ids.contains(manifest.default_light_appearance_id.as_str()));
        assert!(unique_ids.contains(manifest.default_dark_appearance_id.as_str()));
    }

    #[test]
    fn generated_appearance_prompt_snapshots_have_required_prompt_fields() {
        for snapshot in &GenerativeUITool::appearance_prompt_snapshot_manifest().appearances {
            assert!(!snapshot.id.trim().is_empty());
            assert!(!snapshot.mode.trim().is_empty());
            assert!(!snapshot.bg_primary.trim().is_empty());
            assert!(!snapshot.bg_secondary.trim().is_empty());
            assert!(!snapshot.bg_scene.trim().is_empty());
            assert!(!snapshot.text_primary.trim().is_empty());
            assert!(!snapshot.text_muted.trim().is_empty());
            assert!(!snapshot.accent_500.trim().is_empty());
            assert!(!snapshot.accent_600.trim().is_empty());
            assert!(!snapshot.border_base.trim().is_empty());
            assert!(!snapshot.element_base.trim().is_empty());
            assert!(!snapshot.shadow_base.trim().is_empty());
            assert!(!snapshot.style_notes.trim().is_empty());
        }
    }

    #[test]
    fn appearance_prompt_snapshot_does_not_surface_iframe_fallback_dimensions() {
        for snapshot in &GenerativeUITool::appearance_prompt_snapshot_manifest().appearances {
            let formatted = GenerativeUITool::format_appearance_snapshot(snapshot);
            assert!(!formatted.contains("radius.base="));
            assert!(!formatted.contains("spacing.4="));
        }

        let context = GenerativeUITool::baseline_appearance_context();
        assert!(!context.contains("radius.base="));
        assert!(!context.contains("spacing.4="));
    }
}
