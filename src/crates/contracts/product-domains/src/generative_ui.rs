//! Portable GenUI document validation. The product library compiler owns the schema.
use serde_json::Value;
use std::sync::OnceLock;
pub fn catalog() -> &'static Value {
    static CATALOG: OnceLock<Value> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../shared/generative-ui/catalog.json"
        ))
        .expect("embedded GenUI catalog")
    })
}

/// Returns the official OpenUI lang-core prompt for a selectable GenUI profile.
/// Profiles are the product's fixed routing boundary: a turn uses the one
/// library selected in settings, while this prompt supplies shared rules and
/// worked examples without inflating the tool input schema.
pub fn system_prompt_for_profile(profile: &str) -> Option<&'static str> {
    catalog()["genuiSystemPrompts"][profile].as_str()
}
fn resolve(schema: &Value) -> &Value {
    match schema.get("$ref").and_then(Value::as_str) {
        Some(reference) => &catalog()["$defs"][reference.trim_start_matches("#/$defs/")],
        None => schema,
    }
}

/// Preferences restrict new generation, never persisted app rendering.
pub fn generation_schema_for_profile(profile: &str) -> Result<Value, String> {
    let catalog = catalog();
    let selected = catalog["profiles"][profile]["templates"].as_array().ok_or_else(|| {
        format!("Unsupported GenUI component collection: {profile}; select an installed collection in settings")
    })?;
    let design_spec_id = catalog["profiles"][profile]["designSpec"]
        .as_str()
        .ok_or("Selected component collection has no UI design specification")?;
    let design_spec = catalog["designSpecs"][design_spec_id].clone();
    let mut schema = catalog["generation"].clone();
    schema["$defs"] = catalog["$defs"].clone();
    let messages = schema["properties"]["messages"]["items"]["anyOf"]
        .as_array_mut()
        .ok_or("GenUI generation schema has no message branches")?;
    messages.retain(|branch| {
        branch["properties"].get("createSurface").is_some()
            || branch["properties"].get("updateDataModel").is_some()
    });
    if let Some(message) = messages[0].as_object_mut() {
        message.insert(
            "description".into(),
            Value::String(
                "One protocol message object. Keep messages as a JSON array; never serialize this array into a string.".into(),
            ),
        );
    }
    let create = &mut messages[0]["properties"]["createSurface"];
    create["properties"]["template"]["enum"] = Value::Array(selected.clone());
    let selected_library_ids = selected
        .iter()
        .filter_map(Value::as_str)
        .filter_map(|template_id| catalog["templates"][template_id]["library"].as_str())
        .collect::<Vec<_>>();
    let selected_library_id = selected_library_ids
        .first()
        .copied()
        .ok_or("Selected component collection has no library")?;
    let revision = catalog["libraryAdapters"][selected_library_id]["revision"]
        .as_i64()
        .ok_or("Selected component collection has no library revision")?;
    create["properties"]["libraryId"]["enum"] = serde_json::json!([selected_library_id]);
    create["properties"]["libraryRevision"] = serde_json::json!({"const": revision});
    let required = create["required"].as_array_mut().unwrap();
    if !required.iter().any(|field| field == "source") {
        required.push(Value::String("source".into()));
    }
    create["properties"]["designSpec"]["properties"]["id"]["enum"] =
        serde_json::json!([design_spec_id]);
    create["properties"]["designSpec"]["properties"]["revision"] =
        serde_json::json!({"const": design_spec["revision"]});
    schema["description"] = serde_json::json!(format!(
        "Generate the openbitfun.genui.v1 protocol for the selected GenUI profile. The GenerativeUI tool receives a JSON protocol object and messages must remain a JSON array of message objects, never a JSON-encoded string. When createSurface.source.kind is openui-lang, source.content must contain the raw OpenUI Lang program. The profile's official OpenUI lang-core rules, component signatures and worked examples are supplied in the system prompt. Selected adapter collection: {profile}; allowed createSurface.template: {}; selected design specification {design_spec_id}: {}. New applications must send a complete source document in createSurface.source and may send updateDataModel for initial values.",
        selected[0],
        design_spec,
    ));
    Ok(schema)
}

pub fn validate_profile(profile: &str, app: &Value) -> Result<(), String> {
    let selected = catalog()["profiles"][profile]["templates"]
        .as_array()
        .ok_or_else(|| format!("Unsupported GenUI component collection: {profile}"))?;
    if !selected.contains(&app["template"]) {
        return Err(format!("Template {} is outside the selected GenUI collection {profile}. Refresh the tool specification and preserve requested features.", app["template"]));
    }
    let template = app["template"]
        .as_str()
        .ok_or("Application template is missing")?;
    let expected_library = catalog()["templates"][template]["library"]
        .as_str()
        .ok_or("Application template has no library identity")?;
    let library_id = app["libraryId"].as_str().unwrap_or_default();
    let legacy = catalog()["legacyTemplateLibraries"][template]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(library_id)));
    if library_id != expected_library && !legacy {
        return Err(format!(
            "Application library {} does not match template {} ({expected_library})",
            app["libraryId"], template
        ));
    }
    let expected_revision = catalog()["libraryAdapters"][expected_library]["revision"]
        .as_i64()
        .ok_or("Application library has no revision")?;
    if app["libraryRevision"].as_i64() != Some(expected_revision) {
        return Err(format!(
            "Application library revision must be {expected_revision} for {expected_library}"
        ));
    }
    Ok(())
}
pub fn validate_library_identity(app: &Value) -> Result<(), String> {
    let template = app["template"].as_str().ok_or("app.template: missing")?;
    let library_id = app["libraryId"].as_str().ok_or("app.libraryId: missing")?;
    let expected_library = catalog()["templates"][template]["library"]
        .as_str()
        .ok_or("app.template: unavailable library identity")?;
    let legacy = catalog()["legacyTemplateLibraries"][template]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(library_id)));
    if library_id != expected_library && !legacy {
        return Err(format!(
            "app.libraryId: {library_id} does not match template {template} ({expected_library})"
        ));
    }
    let expected_revision = catalog()["libraryAdapters"][library_id]["revision"]
        .as_i64()
        .ok_or("app.libraryRevision: unavailable")?;
    if app["libraryRevision"].as_i64() != Some(expected_revision) {
        return Err(format!(
            "app.libraryRevision: expected {expected_revision} for {library_id}"
        ));
    }
    Ok(())
}
pub fn design_spec_for_profile(profile: &str) -> Result<Value, String> {
    let catalog = catalog();
    let id = catalog["profiles"][profile]["designSpec"]
        .as_str()
        .ok_or_else(|| format!("Unsupported GenUI UI specification for collection: {profile}"))?;
    Ok(serde_json::json!({"id":id,"revision":catalog["designSpecs"][id]["revision"]}))
}
pub fn validate_design_spec(app: &Value) -> Result<(), String> {
    let identity = app
        .get("designSpec")
        .ok_or("app.designSpec: missing design specification identity; original data retained")?;
    let id = identity["id"]
        .as_str()
        .ok_or("app.designSpec.id: missing design specification identity")?;
    let spec = &catalog()["designSpecs"][id];
    if spec.is_null() || spec["revision"] != identity["revision"] {
        return Err(format!(
            "app.designSpec: unavailable UI specification {id}@{}; original data retained",
            identity["revision"]
        ));
    }
    let library = app["libraryId"].as_str().ok_or("app.libraryId: missing")?;
    let expected_revision = catalog()["libraryAdapters"][library]["revision"]
        .as_i64()
        .ok_or("app.libraryRevision: unavailable")?;
    if app["libraryRevision"].as_i64() != Some(expected_revision) {
        return Err(format!(
            "app.libraryRevision: unavailable library revision for {library}"
        ));
    }
    if !spec["componentLibraries"]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(library)))
    {
        return Err(format!(
            "app.designSpec: {id} does not allow component library {library}"
        ));
    }
    if let Some(kind) = app
        .get("source")
        .and_then(|source| source.get("kind"))
        .and_then(Value::as_str)
    {
        if !spec["sourceKinds"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(kind)))
        {
            return Err(format!(
                "app.source: UI specification {id} does not allow source kind {kind}"
            ));
        }
    }
    Ok(())
}
pub(super) fn safe(key: &str) -> bool {
    !["__proto__", "constructor", "prototype"].contains(&key)
}
pub fn validate_state(app: &Value, state: Option<&Value>) -> Result<(), String> {
    let Some(state) = state else {
        return Ok(());
    };
    if app["schemaVersion"] != 2 || !app["state"].is_object() {
        return Err("Unsupported application version; original data retained".into());
    }
    if !state.is_object() {
        return Err("app_state: expected object".into());
    }
    for (key, declaration) in app["state"].as_object().unwrap() {
        if let Some(value) = state.get(key) {
            validate(
                &serde_json::json!({"type":declaration["type"]}),
                value,
                &format!("app_state.{key}"),
            )?;
        }
    }
    Ok(())
}
pub fn validate_app(app: &Value) -> Result<(), String> {
    validate(&catalog()["app"], app, "app")?;
    for field in ["nodes", "flows", "derived", "checks"] {
        if app.get(field).is_some() {
            return Err(format!(
                "app.{field}: retired graph field is unsupported; original data retained"
            ));
        }
    }
    validate_library_identity(app)?;
    validate_design_spec(app)?;
    let source = app
        .get("source")
        .ok_or("app.source: source document is required")?;
    let kind = source["kind"]
        .as_str()
        .ok_or("app.source.kind: source kind is required")?;
    let (field, label) = match kind {
        "html-document" => ("html", "HTML document"),
        "openui-lang" => ("content", "OpenUI document"),
        other => return Err(format!("app.source.kind: unsupported source kind {other}")),
    };
    if kind == "html-document" {
        if let Some(runtime) = app.get("htmlRuntime") {
            if runtime != &catalog()["htmlRuntime"] {
                return Err(
                    "app.htmlRuntime: unsupported HTML runtime identity; original data retained"
                        .into(),
                );
            }
        }
    }
    if source[field]
        .as_str()
        .is_none_or(|content| content.trim().is_empty())
    {
        return Err(format!("app.source.{field}: {label} must not be empty"));
    }
    Ok(())
}

/// Admission for newly generated candidates. GenUI has one representation:
/// a complete OpenUI Lang or isolated HTML source document.
pub fn validate_generation(app: &Value) -> Result<(), String> {
    validate_app(app)
}

pub(super) fn validate(schema: &Value, value: &Value, path: &str) -> Result<(), String> {
    let schema = resolve(schema);
    if !schema.is_object() {
        return Err(format!("{path}: unresolved schema reference"));
    }
    if let Some(branches) = schema.get("allOf").and_then(Value::as_array) {
        for branch in branches {
            validate(branch, value, path)?;
        }
    }
    if let Some(branches) = schema.get("anyOf").and_then(Value::as_array) {
        let mut rest = schema.clone();
        rest.as_object_mut().unwrap().remove("anyOf");
        validate(&rest, value, path)?;
        let discriminator = ["kind", "component", "type", "template"]
            .into_iter()
            .find(|key| {
                value.get(key).is_some()
                    && branches
                        .iter()
                        .any(|branch| resolve(branch)["properties"][key].get("const").is_some())
            });
        if let Some(selected) = discriminator.and_then(|key| {
            branches
                .iter()
                .find(|branch| resolve(branch)["properties"][key].get("const") == value.get(key))
        }) {
            return validate(selected, value, path);
        }
        if let Some(object) = value.as_object().filter(|object| object.len() == 1) {
            let key = object.keys().next().unwrap();
            let envelopes: Vec<_> = branches
                .iter()
                .filter(|branch| {
                    let branch = resolve(branch);
                    branch["properties"]
                        .as_object()
                        .is_some_and(|props| props.len() == 1 && props.contains_key(key))
                        && branch["required"].as_array().is_some_and(|required| {
                            required
                                .iter()
                                .any(|field| field.as_str() == Some(key.as_str()))
                        })
                })
                .collect();
            if envelopes.len() == 1 {
                return validate(envelopes[0], value, path);
            }
        }
        return if branches
            .iter()
            .any(|branch| validate(branch, value, path).is_ok())
        {
            Ok(())
        } else {
            if branches
                .iter()
                .any(|branch| resolve(branch)["properties"]["kind"].get("const").is_some())
            {
                Err(format!(
                    "{path}: value does not match the selected source contract"
                ))
            } else {
                Err(format!("{path}: value does not match a supported shape"))
            }
        };
    }
    if let Some(kind) = schema.get("type").and_then(Value::as_str) {
        let matches = match kind {
            "null" => value.is_null(),
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "number" => value.is_number(),
            "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
            "boolean" => value.is_boolean(),
            _ => false,
        };
        if !matches {
            return Err(format!("{path}: expected {kind}"));
        }
    }
    if let Some(expected) = schema.get("const") {
        if value != expected {
            return Err(format!("{path}: expected {expected}"));
        }
    }
    if let Some(choices) = schema.get("enum").and_then(Value::as_array) {
        if !choices.contains(value) {
            return Err(format!(
                "{path}: expected one of {}",
                Value::Array(choices.clone())
            ));
        }
    }
    if let Some(text) = value.as_str() {
        if schema
            .get("minLength")
            .and_then(Value::as_u64)
            .is_some_and(|min| (text.trim().chars().count() as u64) < min)
        {
            return Err(format!("{path}: text must not be empty"));
        }
    }
    if let Some(items) = value.as_array() {
        if schema
            .get("minItems")
            .and_then(Value::as_u64)
            .is_some_and(|min| (items.len() as u64) < min)
        {
            return Err(format!(
                "{path}: array needs at least {} item(s)",
                schema["minItems"]
            ));
        }
        if let Some(item_schema) = schema.get("items") {
            for (index, item) in items.iter().enumerate() {
                validate(item_schema, item, &format!("{path}[{index}]"))?;
            }
        }
    }
    if let Some(object) = value.as_object() {
        let properties = schema.get("properties").and_then(Value::as_object);
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for key in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(key) {
                    return Err(format!("{path}.{key}: required field is missing"));
                }
            }
        }
        for (key, entry) in object {
            let next = format!("{path}.{key}");
            if let Some(property) = properties.and_then(|props| props.get(key)) {
                validate(property, entry, &next)?;
            } else if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                return Err(format!("{next}: unsupported property; repair the configuration without removing requested features"));
            } else if let Some(extra) = schema
                .get("additionalProperties")
                .filter(|schema| schema.is_object())
            {
                validate(extra, entry, &next)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generation_rejects_removed_graph_operations() {
        let input =
            serde_json::json!({"protocol":"openbitfun.genui.v1","messages":[{"updateLogic":{}}]});
        let error = validate(&catalog()["generation"], &input, "generation").unwrap_err();
        assert!(
            error.contains("value does not match") || error.contains("createSurface"),
            "{error}"
        );
    }
    #[test]
    fn collection_schema_restricts_generation_but_keeps_saved_apps_readable() {
        for (id, profile) in catalog()["profiles"].as_object().unwrap() {
            let schema = generation_schema_for_profile(id).unwrap();
            assert_eq!(
                schema["properties"]["messages"]["items"]["anyOf"][0]["properties"]
                    ["createSurface"]["properties"]["template"]["enum"],
                Value::Array(
                    profile["templates"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .cloned()
                        .collect()
                )
            );
            assert!(
                schema["properties"]["messages"]["items"]["anyOf"][0]["properties"]
                    ["createSurface"]["required"]
                    .as_array()
                    .unwrap()
                    .contains(&Value::String("source".into()))
            );
            assert_eq!(
                schema["properties"]["messages"]["items"]["anyOf"]
                    .as_array()
                    .unwrap()
                    .len(),
                2,
                "new generation exposes only source creation and initial state updates"
            );
            for template in profile["templates"].as_array().unwrap() {
                let template_id = template.as_str().unwrap();
                let library_id = catalog()["templates"][template_id]["library"].clone();
                let revision =
                    catalog()["libraryAdapters"][library_id.as_str().unwrap()]["revision"].clone();
                assert!(validate_profile(id, &serde_json::json!({"template": template, "libraryId": library_id, "libraryRevision": revision})).is_ok());
            }
            let schema_text = schema["description"].as_str().unwrap();
            assert!(schema_text.contains("raw OpenUI Lang program"));
            assert!(schema_text.contains("messages must remain a JSON array"));
            assert!(
                schema["properties"]["messages"]["items"]["anyOf"][0]["description"]
                    .as_str()
                    .is_some_and(|text| text.contains("never serialize this array into a string"))
            );
            assert!(schema_text.contains("official OpenUI lang-core rules"));
            assert!(schema_text.contains("complete source document"));
            assert!(!schema_text.contains("updateComponents"));
            assert!(!schema_text.contains("updateLogic"));
            let selected_template = profile["templates"][0].as_str().unwrap();
            assert!(schema_text.contains(selected_template));
            for (other_id, other_profile) in catalog()["profiles"].as_object().unwrap() {
                if other_id != id {
                    for template in other_profile["templates"].as_array().unwrap() {
                        assert!(!schema_text.contains(template.as_str().unwrap()));
                    }
                }
            }
            assert_eq!(
                schema_text.contains("fixed 360 CSS-pixel-wide phone screen"),
                id == "harmony"
            );
            assert!(schema_text.contains(&format!("Selected adapter collection: {id}")));
            assert!(schema_text.contains(
                catalog()["designSpecs"][profile["designSpec"].as_str().unwrap()]["label"]
                    .as_str()
                    .unwrap()
            ));
            let official_prompt = system_prompt_for_profile(id).unwrap();
            assert!(
                official_prompt.contains("You are an AI assistant that responds using openui-lang")
            );
            assert!(official_prompt.contains("## Examples"));
            assert!(official_prompt.contains("## Important Rules"));
            assert!(
                !schema_text.contains("You are an AI assistant that responds using openui-lang")
            );
        }
        assert!(generation_schema_for_profile("future.collection").is_err());
        let examples: Value = serde_json::from_str(include_str!(
            "../../../../shared/generative-ui/examples.json"
        ))
        .unwrap();
        assert!(validate_app(&examples["ledger"]).is_ok());
    }

    #[test]
    fn versioned_design_specs_bind_libraries_and_harmony_phone_contract() {
        let harmony = design_spec_for_profile("harmony").unwrap();
        assert_eq!(
            harmony,
            serde_json::json!({"id":"harmony.phone.v1","revision":1})
        );
        let mut app = serde_json::json!({"template":"openbitfun.harmony.app","libraryId":"openbitfun.harmony.v1","libraryRevision":3,"designSpec":harmony});
        assert!(validate_design_spec(&app).is_ok());
        app["libraryRevision"] = Value::from(2);
        assert!(validate_design_spec(&app)
            .unwrap_err()
            .contains("unavailable library revision for openbitfun.harmony.v1"));
        app["libraryRevision"] = Value::from(3);
        app["template"] = Value::String("openbitfun.app".into());
        app["libraryId"] = Value::String("openbitfun.composable.v1".into());
        app["libraryRevision"] = Value::from(2);
        assert!(validate_design_spec(&app)
            .unwrap_err()
            .contains("does not allow component library"));
        let spec = &catalog()["designSpecs"]["harmony.phone.v1"];
        assert_eq!(
            spec["viewport"],
            serde_json::json!({"mode":"fixed","width":360,"height":764,"unit":"css-px"})
        );
        assert_eq!(spec["shell"]["statusBarHeight"], 36);
        assert_eq!(spec["shell"]["contentInsets"]["left"], 16);
        for check in [
            "fixed-viewport",
            "host-shell",
            "content-boundary",
            "no-horizontal-overflow",
        ] {
            assert!(spec["acceptance"]["checks"]
                .as_array()
                .unwrap()
                .contains(&Value::String(check.into())));
        }
    }

    #[test]
    fn missing_design_spec_is_not_inferred_or_accepted() {
        let app = serde_json::json!({
            "schemaVersion": 2,
            "id": "missing-spec",
            "title": "Missing spec",
            "template": "openbitfun.app",
            "libraryId": "openbitfun.composable.v1",
            "libraryRevision": 2,
            "source": {"kind": "openui-lang", "content": "root = Text(\"Hello\")"},
            "state": {}
        });
        let error = validate_design_spec(&app).unwrap_err();
        assert!(error.contains("missing design specification identity"));
        assert!(validate_app(&app).unwrap_err().contains("designSpec"));
    }

    #[test]
    fn html_documents_use_the_same_versioned_design_spec_contract() {
        let mut app = serde_json::json!({
            "schemaVersion": 2,
            "id": "phone-html",
            "title": "Phone HTML",
            "template": "openbitfun.harmony.app",
            "libraryId": "openbitfun.harmony.v1",
            "libraryRevision": 3,
            "designSpec": {"id": "harmony.phone.v1", "revision": 1},
            "source": {"kind": "html-document", "html": "<section><svg viewBox=\"0 0 10 10\"></svg></section>", "css": "section { width: 100%; }"},
            "state": {}
        });
        assert!(validate_app(&app).is_ok());
        assert!(validate_generation(&app).is_ok());
        app["futureRuntime"] = serde_json::json!({"revision":2});
        assert!(validate_app(&app).is_ok());
        let mut invalid = app.clone();
        invalid["source"]["html"] = Value::String("".into());
        assert!(validate_app(&invalid)
            .unwrap_err()
            .contains("must not be empty"));
        invalid["source"]["html"] = Value::String("<div />".into());
        invalid["template"] = Value::String("openbitfun.app".into());
        invalid["libraryId"] = Value::String("openbitfun.composable.v1".into());
        invalid["libraryRevision"] = Value::from(2);
        invalid["designSpec"] = serde_json::json!({"id":"openbitfun.desktop.v1","revision":1});
        assert!(validate_app(&invalid).is_ok());
    }

    #[test]
    fn openui_documents_use_the_bound_library() {
        let app = serde_json::json!({
            "schemaVersion": 2,
            "id": "openui-phone",
            "title": "OpenUI phone",
            "template": "openbitfun.harmony.app",
            "libraryId": "openbitfun.harmony.v1",
            "libraryRevision": 3,
            "designSpec": {"id": "harmony.phone.v1", "revision": 1},
            "source": {"kind": "openui-lang", "content": "root = Col([Text(\"Hello\")])"},
            "state": {}
        });
        assert!(validate_app(&app).is_ok());
        assert!(validate_generation(&app).is_ok());
        let mut invalid = app.clone();
        invalid["source"]["content"] = Value::String("".into());
        assert!(validate_app(&invalid)
            .unwrap_err()
            .contains("must not be empty"));
        invalid["source"]["content"] = Value::String("root = Col([])".into());
        invalid["nodes"] = serde_json::json!([]);
        assert!(validate_app(&invalid).is_err());
    }

    #[test]
    fn legacy_openui_template_keeps_the_saved_bitfun_library_identity() {
        let app = serde_json::json!({
            "schemaVersion": 2,
            "id": "legacy-openui",
            "title": "Legacy OpenUI",
            "template": "openui.app",
            "libraryId": "openbitfun.composable.v1",
            "libraryRevision": 2,
            "designSpec": {"id": "openbitfun.desktop.v1", "revision": 1},
            "source": {"kind": "openui-lang", "content": "root = Col([])"},
            "state": {}
        });
        assert!(validate_app(&app).is_ok());
    }

    #[test]
    fn generated_examples_are_source_documents() {
        let examples: Value = serde_json::from_str(include_str!(
            "../../../../shared/generative-ui/examples.json"
        ))
        .unwrap();
        for (name, app) in examples.as_object().unwrap() {
            assert!(
                validate_generation(app).is_ok(),
                "{name}: {:?}",
                validate_generation(app)
            );
            assert!(app.get("source").is_some());
            assert!(app.get("nodes").is_none());
            assert!(app.get("flows").is_none());
        }
    }

    #[test]
    fn source_generation_rejects_graph_fields() {
        let app = serde_json::json!({
            "schemaVersion": 2,
            "id": "graph",
            "title": "Graph",
            "template": "openbitfun.app",
            "libraryId": "openbitfun.composable.v1",
            "libraryRevision": 2,
            "source": {"kind": "openui-lang", "content": "root = Col([])"},
            "nodes": [],
            "state": {}
        });
        assert!(validate_generation(&app).is_err());
    }

    #[test]
    fn shared_contract_fixtures() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../../shared/generative-ui/contract-fixtures.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let result = validate_app(&case["app"]);
            assert_eq!(
                result.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}: {:?}",
                case["name"],
                result
            );
        }
    }
    #[test]
    fn saved_state_preserves_unknown_fields_without_rendering_legacy_documents() {
        let app =
            serde_json::json!({"schemaVersion":2,"state":{"count":{"type":"number","default":1}}});
        let state = serde_json::json!({"count":0,"future":{"value":false}});
        assert!(validate_state(&app, Some(&state)).is_ok());
        assert_eq!(
            serde_json::from_str::<Value>(&state.to_string()).unwrap(),
            state
        );
        assert!(validate_state(&app, Some(&serde_json::json!({"count":"wrong"}))).is_err());
        assert!(validate_state(
            &serde_json::json!({"schemaVersion":1,"parts":[]}),
            Some(&state)
        )
        .is_err());
    }
}
