//! Compact tool-facing fields and IO-free operation preflight.
//!
//! Keep a flat schema: provider adapters may flatten unions by retaining only
//! the first variant's enum/fields. Format-specific parsing remains with each
//! document owner; this preflight catches missing selectors/content before IO.

use crate::common::{operation_name, unknown_operation};
use crate::{OfficeError, OfficeFormat, OfficeResult};
use serde_json::{json, Value};

/// Common operation fields, with the full field reference supplied by `guide`.
/// Additional properties preserve format-specific fields and accepted aliases.
pub fn operation_schema() -> Value {
    let mut names = Vec::new();
    for format in [OfficeFormat::Docx, OfficeFormat::Xlsx, OfficeFormat::Pptx] {
        for name in format.operations() {
            if !names.contains(name) {
                names.push(*name);
            }
        }
    }
    let chart_schema = json!({"type": "object", "description": "XLSX add_chart/replace_chart: native editable chart. Read the xlsx guide for range references.", "properties": {
                "type": {"type": "string", "enum": ["column", "bar", "line", "pie"]},
                "anchor": {"type": "string", "description": "Top-left cell, e.g. F2."},
                "title": {"type": "string"},
                "width_px": {"type": "integer", "minimum": 1},
                "height_px": {"type": "integer", "minimum": 1},
                "legend": {"type": "boolean"},
                "series": {"type": "array", "minItems": 1, "items": {
                    "type": "object", "properties": {
                        "name": {"type": "string"},
                        "color": {"type": "string"},
                        "categories": {"type": "object", "properties": {
                            "sheet": {"type": "string"}, "range": {"type": "string", "description": "Single row/column, e.g. A2:A5."}
                        }, "required": ["range"], "additionalProperties": true},
                        "values": {"type": "object", "properties": {
                            "sheet": {"type": "string"}, "range": {"type": "string", "description": "Numeric cells; same length as categories, e.g. B2:B5."}
                        }, "required": ["range"], "additionalProperties": true}
                    }, "required": ["categories", "values"], "additionalProperties": true
                }}
            }, "required": ["type", "anchor", "series"], "additionalProperties": true});
    json!({
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": names},
            "index": {"type": "integer", "minimum": 0, "description": "Current 0-based block/slide/chart index. Required for replace/update/delete/move operations that use an index. Optional insertion position for insert_blocks, insert_slides, or add_sheet. Earlier operations in this batch shift indexes."},
            "count": {"type": "integer", "minimum": 1, "description": "Number of items; omit for the operation's default."},
            "to": {"type": "integer", "minimum": 0, "description": "Move destination after removing the source items; required for move operations."},
            "slide": {"type": "object", "description": "replace_slide: complete replacement slide {title?, background?, notes?, elements:[...]}; both index and slide are required.", "properties": {
                "elements": {"type": "array", "items": {"type": "object", "additionalProperties": true}}
            }, "additionalProperties": true},
            "slides": {"type": "array", "minItems": 1, "description": "insert_slides: complete slide objects. Omit index to append.", "items": {"type": "object", "additionalProperties": true}},
            "elements": {"type": "array", "description": "update_slide: replace all elements while keeping slide metadata. Do not combine with update/remove/append_elements.", "items": {"type": "object", "additionalProperties": true}},
            "update_elements": {"type": "array", "description": "update_slide: patches {index, ...changed element fields}. No nested op, patch, or replace field.", "items": {
                "type": "object", "properties": {
                    "index": {"type": "integer", "minimum": 0},
                    "text": {"type": "string"},
                    "x": {"type": "number"}, "y": {"type": "number"},
                    "w": {"type": "number"}, "h": {"type": "number"},
                    "size_pt": {"type": "number"}, "color": {"type": "string"}
                }, "required": ["index"], "additionalProperties": true
            }},
            "remove_elements": {"type": "array", "items": {"type": "integer", "minimum": 0}},
            "append_elements": {"type": "array", "items": {"type": "object", "additionalProperties": true}},
            "markdown": {"type": "string", "description": "Word insert_blocks/replace_blocks content; use this or blocks."},
            "blocks": {"type": "array", "items": {"type": "object", "additionalProperties": true}},
            "sheet": {"description": "Excel sheet name (preferred) or 0-based index; omit only for a one-sheet workbook."},
            "name": {"type": "string", "description": "add_sheet/rename_sheet: sheet name."},
            "start": {"type": "string", "description": "Excel starting cell, e.g. A1."},
            "rows": {"description": "Excel: 2-D array of cell values; for freeze_panes only, a non-negative row count."},
            "row": {"type": "integer", "minimum": 1},
            "column": {"type": "string", "description": "Excel column letters, e.g. A."},
            "range": {"description": "Excel A1 range; set_autofilter also accepts null to clear it."},
            "style": {"type": "object", "additionalProperties": true},
            "chart": chart_schema,
            "include_headers_footers": {"type": "boolean", "description": "DOCX replace_text: also replace header/footer text (default false)."},
            "font": {"type": "string"},
            "east_asia_font": {"type": "string"},
            "lang": {"type": "string", "description": "DOCX set_styles / PPTX set_theme: optional BCP 47 language, e.g. zh-CN or zh-TW. Omit for text-based selection."}
        },
        "required": ["op"],
        "additionalProperties": true
    })
}

/// Required top-level fields. A `|` denotes existing aliases/alternatives.
/// Null optional values still reach the format parser unchanged.
fn required_fields(op: &str) -> &'static [&'static str] {
    match op {
        "insert_blocks" => &["blocks|markdown"],
        "replace_blocks" => &["index", "blocks|markdown"],
        "delete_blocks" | "delete_slides" | "duplicate_slide" | "update_slide" => &["index"],
        "move_blocks" | "move_slides" => &["index", "to"],
        "replace_text" => &["find", "replace"],
        "insert_slides" => &["slides"],
        "replace_slide" => &["index", "slide"],
        "add_sheet" | "rename_sheet" => &["name"],
        "move_sheet" => &["to"],
        "set_cells" | "append_rows" => &["rows|values"],
        "insert_rows" | "delete_rows" => &["row"],
        "insert_columns" | "delete_columns" => &["column"],
        "clear_range" | "merge_cells" | "unmerge_cells" => &["range"],
        "format_range" => &["range", "style"],
        "set_column_widths" => &["widths"],
        "set_row_heights" => &["heights"],
        "add_chart" => &["chart"],
        "replace_chart" => &["index", "chart"],
        "delete_chart" => &["index"],
        _ => &[],
    }
}

/// Checks selectors and required payloads without reading files, images or
/// document state. Bounds and full payload validation run on the working copy.
pub fn validate_operation_headers(format: OfficeFormat, operations: &[Value]) -> OfficeResult<()> {
    for (index, operation) in operations.iter().enumerate() {
        let name = operation_name(operation).map_err(|err| err.at_operation(index, "?"))?;
        let check = || -> OfficeResult<()> {
            if !format.operations().contains(&name) {
                return Err(unknown_operation(name, format.operations()));
            }
            let missing: Vec<_> = required_fields(name)
                .iter()
                .filter(|field| {
                    !field
                        .split('|')
                        .any(|key| operation.get(key).is_some_and(|value| !value.is_null()))
                })
                .copied()
                .collect();
            if !missing.is_empty() {
                return Err(OfficeError::invalid(format!(
                    "{name} requires field(s): {}",
                    missing.join(", ")
                )));
            }
            for field in ["index", "to", "count"] {
                if let Some(value) = operation.get(field).filter(|value| !value.is_null()) {
                    // Workbook operations historically normalize count=0 to 1.
                    let minimum = u64::from(field == "count" && format != OfficeFormat::Xlsx);
                    if !value.as_u64().is_some_and(|number| number >= minimum) {
                        return Err(OfficeError::invalid(format!(
                            "`{field}` must be an integer >= {minimum}"
                        )));
                    }
                }
            }
            if name == "replace_slide" && !operation["slide"].is_object() {
                return Err(OfficeError::invalid(
                    "`slide` must be a complete slide object, not an index or array",
                ));
            }
            if matches!(name, "add_chart" | "replace_chart") {
                let chart = &operation["chart"];
                for field in ["type", "anchor", "series"] {
                    if chart.get(field).is_none_or(Value::is_null) {
                        return Err(OfficeError::invalid(format!("{name} requires chart.{field}; pass a chart object {{type, anchor, series}}")));
                    }
                }
            }
            if name == "update_slide" {
                if let Some(patches) = operation.get("update_elements") {
                    let patches = patches.as_array().ok_or_else(|| {
                        OfficeError::invalid(
                            "`update_elements` must be an array of {index, ...changed fields}",
                        )
                    })?;
                    for (patch_index, patch) in patches.iter().enumerate() {
                        if !patch
                            .get("index")
                            .is_some_and(|value| value.as_u64().is_some())
                        {
                            return Err(OfficeError::invalid(format!("update_elements[{patch_index}] requires a non-negative integer `index`")));
                        }
                        if patch.get("op").is_some() {
                            return Err(OfficeError::invalid(format!("update_elements[{patch_index}].op is not supported; put changed fields beside index, e.g. {{\"index\":0,\"text\":\"Updated text\"}}")));
                        }
                    }
                }
            }
            Ok(())
        };
        check().map_err(|err| err.at_operation(index, name))?;
    }
    Ok(())
}

/// Recovery advice keyed to the actual failed operation, not a loop counter.
pub fn operation_recovery_hint(op: &str) -> &'static str {
    match op {
        "add_chart" | "replace_chart" => "Use chart:{type:\"column\"|\"bar\"|\"line\"|\"pie\",anchor:\"F2\",series:[{categories:{range:\"A2:A4\"},values:{range:\"B2:B4\"}}]}. Source ranges must be single rows/columns of equal length. Read the sheet to check data and existing chart indexes before retrying.",
        "replace_text" => "Use {op:\"replace_text\",find:<literal text>,replace:<new text>}. Matches may span formatted runs within one paragraph, list item or table cell. Set include_headers_footers:true only when those should also change.",
        "replace_slide" => "Use {op:\"replace_slide\",index:<current slide index>,slide:<complete slide object>}. This replaces the slide in place; no insert/delete/move is needed.",
        "update_slide" => "Read the target slide with detail=full. Use {op:\"update_slide\",index:<slide index>,update_elements:[{index:<element index>,...changed fields}]}; patches have no op. Or pass elements to replace the whole element list.",
        "move_slides" => "Indexes use the state after earlier operations in this batch. Inserting or deleting slides shifts subsequent indexes; recalculate selectors against that order. `to` is measured after removing the moved slides. To replace content, use replace_slide with index and slide instead.",
        "move_blocks" => "Indexes use the state after earlier operations in this batch; `to` is measured after removing the moved blocks. To replace content, prefer replace_blocks with index and blocks or markdown.",
        _ => "Use action=guide for the format's exact fields; use action=read when the current target or index is uncertain.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ImageSources, OfficeDocument};

    #[test]
    fn preflight_preserves_legacy_aliases_and_optional_nulls() {
        for (format, operations) in [
            (
                OfficeFormat::Docx,
                vec![
                    json!({"op":"insert_blocks","index":null,"blocks":null,"markdown":"中文"}),
                    json!({"op":"replace_blocks","index":0,"count":null,"markdown":"Updated"}),
                ],
            ),
            (
                OfficeFormat::Xlsx,
                vec![
                    json!({"op":"add_sheet","name":"Data","values":[["中文"]]}),
                    json!({"op":"set_cells","anchor":"B1","values":[[2]]}),
                    json!({"op":"insert_rows","row":2,"count":0}),
                ],
            ),
            (
                OfficeFormat::Pptx,
                vec![
                    json!({"op":"insert_slides","index":null,"slides":[{"elements":[]}]}),
                    json!({"op":"duplicate_slide","index":0,"to":null}),
                    json!({"op":"set_theme","lang":null}),
                ],
            ),
        ] {
            validate_operation_headers(format, &operations).unwrap();
            let mut document = OfficeDocument::new(format, None).unwrap();
            document.apply(&operations, &ImageSources::new()).unwrap();
        }
    }

    #[test]
    fn preflight_reports_the_specific_operation_and_missing_fields() {
        for (operation, expected) in [
            (json!({"op":"replace_slide"}), "index, slide"),
            (
                json!({"op":"replace_slide","index":0,"slide":null}),
                "slide",
            ),
            (
                json!({"op":"update_slide","index":0,"update_elements":[{"text":"x"}]}),
                "update_elements[0]",
            ),
            (json!({"op":"move_slides","index":1.5,"to":0}), "integer"),
            (
                json!({"op":"replace_blocks","index":0,"markdown":"x"}),
                "unknown operation",
            ),
        ] {
            let error = validate_operation_headers(
                OfficeFormat::Pptx,
                &[json!({"op":"set_theme","font":"Arial"}), operation],
            )
            .unwrap_err();
            assert_eq!(error.operation_index, Some(1));
            assert!(error.to_string().contains(expected), "{error}");
        }
    }
}
