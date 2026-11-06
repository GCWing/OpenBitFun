//! Font input and schema facts. No host font inventory or viewer assumptions.

use crate::{OfficeError, OfficeResult};
use serde_json::{json, Value};

/// Validate only newly supplied input, never a persisted model. Legacy names
/// must remain readable even when they would not be accepted as a new choice.
pub fn validate_font_input(value: &Value, path: &str) -> OfficeResult<()> {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                let path = format!("{path}.{key}");
                if matches!(
                    key.as_str(),
                    "font"
                        | "font_name"
                        | "heading_font"
                        | "latin_font"
                        | "east_asia_font"
                        | "complex_script_font"
                ) && !value.is_null()
                {
                    let name = value.as_str().ok_or_else(|| {
                        OfficeError::invalid(format!(
                            "{path}: use one font family name as a string; omit it to inherit"
                        ))
                    })?;
                    if name.trim().is_empty() || name.chars().any(char::is_control) {
                        return Err(OfficeError::invalid(format!(
                            "{path}: font family names must be non-empty and contain no control characters; omit the field to inherit or use the guide's font reset operation"
                        )));
                    }
                } else {
                    validate_font_input(value, &path)?;
                }
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                validate_font_input(item, &format!("{path}[{index}]"))?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn family_schema(scope: &str) -> Value {
    json!({"type": ["string", "null"], "description": format!("{scope} One family name; omit to inherit. Not embedded or verified.")})
}

pub(crate) fn run_schema() -> Value {
    json!({"type":"object", "properties": {
        "text":{"type":"string", "description":"Ordinary Unicode, not XML/HTML-escaped text."},
        "font":family_schema("Legacy shorthand: overrides Latin, East Asian and complex-script fonts for this entire run."),
        "latin_font":family_schema("Overrides only Latin text; leaves other scripts inherited."),
        "east_asia_font":family_schema("Overrides only East Asian text."),
        "complex_script_font":family_schema("Overrides only complex-script text."),
        "lang":{"type":"string", "description":"BCP 47 language, not encoding or a font selection. Omit for text-based selection."}
    }, "additionalProperties":true})
}

pub(crate) fn text_object_schema() -> Value {
    let mut schema = run_schema();
    let properties = schema["properties"].as_object_mut().unwrap();
    properties.insert(
        "font".into(),
        family_schema(
            "Legacy all-script default at this scope; more specific paragraph/run overrides win.",
        ),
    );
    properties.insert("size_pt".into(), json!({"type":"number"}));
    properties.insert("color".into(), json!({"type":"string"}));
    properties.insert("runs".into(), json!({"type":"array", "items":run_schema()}));
    properties.insert("type".into(), json!({"type":"string"}));
    properties.insert("index".into(), json!({"type":"integer", "minimum":0}));
    schema["description"] = json!("PPTX element or paragraph defaults. Run overrides win; script-specific fields override font at the same scope. See guide for geometry and content fields.");
    schema
}

pub(crate) fn block_schema() -> Value {
    json!({"type":"object", "properties":{
        "type":{"type":"string"}, "text":{"type":"string"},
        "runs":{"type":"array", "items":run_schema()}
    }, "description":"Word block. Font overrides belong inside runs, not on the block. See guide for tables, lists and other block fields.", "additionalProperties":true})
}

pub(crate) fn element_schema() -> Value {
    let mut schema = text_object_schema();
    for field in ["x", "y", "w", "h"] {
        schema["properties"][field] = json!({"type":"number"});
    }
    let mut paragraph = text_object_schema();
    // Paragraphs also accept plain strings; do not make an object-only schema.
    paragraph.as_object_mut().unwrap().remove("type");
    schema["properties"]["paragraphs"] = json!({"type":"array", "items":paragraph});
    schema
}

pub(crate) fn cell_style_schema() -> Value {
    json!({"type":"object", "description":"XLSX cell formatting; omitted fields keep existing formatting. No language, encoding, or per-script font fields.", "properties":{
        "font_name":family_schema("One cell font. Null/omission preserves an existing override; format_range.reset_font clears it."),
        "font":family_schema("Alias of font_name; do not supply both."),
        "font_size":{"type":"number", "description":"Points."},
        "font_color":{"type":"string"}, "bold":{"type":"boolean"},
        "italic":{"type":"boolean"}, "wrap":{"type":"boolean"},
        "number_format":{"type":"string"}
    }, "additionalProperties":true})
}

pub fn settings_schema() -> Value {
    let fonts = json!({
        "font":family_schema("Default Latin font only. Does not force the East Asian font."),
        "east_asia_font":family_schema("Default East Asian font; omit to keep viewer/theme fallback."),
        "complex_script_font":family_schema("Default complex-script font; omit to inherit."),
        "lang":{"type":"string", "description":"Optional BCP 47 language, not encoding. Does not verify font availability."}
    });
    let mut styles = fonts.clone();
    styles["font"] =
        family_schema("DOCX legacy Latin and complex-script default; East Asian font is separate.");
    styles["heading_font"] = family_schema(
        "DOCX Latin and complex-script heading font; complex_script_font takes precedence.",
    );
    styles["font_size_pt"] = json!({"type":"number"});
    json!({"type":"object", "description":"Create defaults: DOCX page/styles/header/footer/properties; PPTX slide_size/theme/properties; XLSX properties only. Omit font choices unless the user/template requires them.", "properties":{
        "styles":{"type":"object", "description":"DOCX document styles.", "properties":styles, "additionalProperties":true},
        "theme":{"type":"object", "description":"PPTX theme. Element/run font overrides can supersede it.", "properties":fonts, "additionalProperties":true},
        "page":{"type":"object", "additionalProperties":true},
        "properties":{"type":"object", "additionalProperties":true},
        "slide_size":{"type":"string", "enum":["16:9","4:3"]}
    }, "additionalProperties":true})
}
