//! Canonical AX observation digest shared by the native host adapters.
use openbitfun_agent_tools::computer_use_host::AxNode;
use sha1::{Digest, Sha1};

/// Hash the complete observed payload, including enabled/focus/selection and
/// geometry. Omitting those facts can misclassify a successful action as a no-op
/// and cause a second input dispatch. Digests are opaque observation tokens;
/// an older host's token simply requires a fresh observation after upgrade.
pub(super) fn compute_digest(nodes: &[AxNode]) -> String {
    let bytes = serde_json::to_vec(nodes).expect("AX node DTO serialization");
    format!("{:x}", Sha1::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node() -> AxNode {
        serde_json::from_value(json!({
            "idx":0, "role":"AXButton", "title":"Save", "enabled":true,
            "focused":false, "frame_global":[10.0,20.0,30.0,40.0], "actions":["AXPress"]
        }))
        .unwrap()
    }

    #[test]
    fn state_geometry_and_content_changes_are_observable() {
        let original = node();
        let baseline = compute_digest(&[original.clone()]);
        for (key, value) in [
            ("enabled", json!(false)),
            ("focused", json!(true)),
            ("selected", json!(true)),
            ("expanded", json!(false)),
            ("value", json!("saved")),
            ("url", json!("https://example.test")),
            ("frame_global", json!([50.0, 20.0, 30.0, 40.0])),
            ("actions", json!([])),
            ("role_description", json!("submit button")),
        ] {
            let mut value_json = serde_json::to_value(&original).unwrap();
            value_json[key] = value;
            let changed = serde_json::from_value(value_json).unwrap();
            assert_ne!(compute_digest(&[changed]), baseline, "lost {key} change");
        }
        assert_eq!(compute_digest(&[original]), baseline);
    }

    #[test]
    fn optional_fields_survive_old_payload_round_trip() {
        let original = node();
        let restored: AxNode =
            serde_json::from_value(serde_json::to_value(&original).unwrap()).unwrap();
        assert_eq!(compute_digest(&[original]), compute_digest(&[restored]));
    }
}
