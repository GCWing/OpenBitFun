//! Assembly for the single GenUI source protocol.
//!
//! A generation is an ordered source document followed by optional state
//! values. The former graph protocol was deliberately removed: accepting it
//! here would keep the old renderer and its failure modes alive.
use super::generative_ui::{catalog, safe, validate, validate_generation, validate_state};
use serde_json::{json, Map, Value};

pub fn assemble(input: &Value) -> Result<(Value, Value), String> {
    let messages = input["messages"]
        .as_array()
        .ok_or("generation.messages must be an array")?;
    if messages.iter().any(|message| {
        message.get("updateComponents").is_some() || message.get("updateLogic").is_some()
    }) {
        return Err("GenUI graph messages were removed; send a complete source document in createSurface.source".into());
    }
    validate(&catalog()["generation"], input, "generation")?;
    let first = messages
        .first()
        .ok_or("generation.messages: createSurface is required")?;
    let surface = first
        .get("createSurface")
        .ok_or("generation.messages[0]: createSurface is required and must be first")?;
    if messages
        .iter()
        .skip(1)
        .any(|message| message.get("createSurface").is_some())
    {
        return Err("generation.messages: createSurface may occur only once".into());
    }
    surface["template"]
        .as_str()
        .ok_or("generation.messages[0].createSurface.template is required")?;
    let source = surface
        .get("source")
        .ok_or("generation.messages[0].createSurface.source is required")?;
    if !matches!(
        source["kind"].as_str(),
        Some("openui-lang" | "html-document")
    ) {
        return Err("createSurface.source.kind must be openui-lang or html-document".into());
    }
    let mut document = json!({"schemaVersion": 2, "state": {}});
    document
        .as_object_mut()
        .unwrap()
        .extend(surface.as_object().unwrap().clone());
    let mut values = Map::new();
    for (index, message) in messages.iter().enumerate().skip(1) {
        let update = message.get("updateDataModel").ok_or_else(|| {
            format!("generation.messages[{index}]: only updateDataModel is supported after createSurface")
        })?;
        for field in ["state", "values"] {
            if let Some(fields) = update[field].as_object() {
                if fields.keys().any(|key| !safe(key)) {
                    return Err(format!(
                        "generation.messages[{index}].updateDataModel: reserved state ID"
                    ));
                }
                if field == "state" {
                    document["state"]
                        .as_object_mut()
                        .unwrap()
                        .extend(fields.clone());
                } else {
                    values.extend(fields.clone());
                }
            }
        }
    }
    validate_generation(&document)?;
    let state = Value::Object(values);
    validate_state(&document, Some(&state))?;
    Ok((document, state))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assembles_source_and_values() {
        let input = json!({"protocol":"openbitfun.genui.v1","messages":[
            {"createSurface":{"id":"a","title":"A","template":"openbitfun.app","libraryId":"openbitfun.composable.v1","libraryRevision":2,"designSpec":{"id":"openbitfun.desktop.v1","revision":1},"source":{"kind":"openui-lang","content":"root = Col([])"}}},
            {"updateDataModel":{"values":{"name":"Ada"}}}
        ]});
        let (app, state) = assemble(&input).unwrap();
        assert_eq!(app["source"]["kind"], "openui-lang");
        assert!(app.get("nodes").is_none());
        assert_eq!(state, json!({"name":"Ada"}));
    }

    #[test]
    fn rejects_graph_messages() {
        let input = json!({"protocol":"openbitfun.genui.v1","messages":[
            {"createSurface":{"id":"a","title":"A","template":"openbitfun.app","libraryId":"openbitfun.composable.v1","libraryRevision":2,"designSpec":{"id":"openbitfun.desktop.v1","revision":1},"source":{"kind":"openui-lang","content":"root = Col([])"}}},
            {"updateComponents":{"components":[]}}
        ]});
        let error = assemble(&input).unwrap_err();
        assert!(error.contains("graph messages were removed"));
    }
}
