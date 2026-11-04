//! Durable GenUI candidates. The caller supplies the owning session artifact
//! directory; this service never chooses a controller filesystem or renderer.
use openbitfun_services_core::json_store::JsonFileStore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub revision: String,
    pub app: Value,
    pub state: Value,
    #[serde(default)]
    pub evidence: Value,
    #[serde(flatten)]
    extra: serde_json::Map<String, Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn app() -> Value {
        json!({"schemaVersion":2,"id":"test","title":"Test","template":"openbitfun.app","libraryId":"openbitfun.composable.v1","libraryRevision":2,"designSpec":{"id":"openbitfun.desktop.v1","revision":1},"source":{"kind":"openui-lang","content":"root = Col([count])\ncount = Text($count + \"\", \"lg\")"},"state":{"count":{"type":"number","default":0}}})
    }
    fn evidence(candidate: &Candidate) -> Value {
        let design_spec_id = candidate.value.app["designSpec"]["id"]
            .as_str()
            .expect("test application has a design specification");
        let applied_acceptance_checks = openbitfun_product_domains::generative_ui::catalog()
            ["designSpecs"][design_spec_id]["acceptance"]["checks"]
            .clone();
        let mut evidence = json!({"revision":candidate.value.revision,"library":{"id":candidate.value.app["libraryId"],"revision":candidate.value.app["libraryRevision"]},"designSpec":candidate.value.app["designSpec"],"preflight":"passed","checks":"passed","render":"passed","reopen":"passed","probeReopen":"passed","layout":"passed","appliedAcceptanceChecks":applied_acceptance_checks,"requirementCoverage":{"status":"passed"}});
        if let Some(kind) = candidate.value.app["source"]["kind"].as_str() {
            evidence["sourceKind"] = json!(kind);
            if kind == "html-document" {
                evidence["htmlRuntime"] =
                    openbitfun_product_domains::generative_ui::catalog()["htmlRuntime"].clone();
            }
        }
        evidence
    }
    #[tokio::test]
    async fn candidate_acceptance_preserves_owner_data_and_rejects_stale_writes() {
        let directory = tempfile::tempdir().unwrap();
        let store = GenUIStore::new(directory.path().to_owned());
        let first = store.begin(app(), None).await.unwrap();
        assert_eq!(
            first.value.app["designSpec"],
            json!({"id":"openbitfun.desktop.v1","revision":1})
        );
        assert!(store.accepted("test").await.unwrap().is_none());
        let accepted = store.accept(&first, evidence(&first)).await.unwrap();
        let saved = store
            .save(
                "test",
                &accepted.revision,
                json!({"count":3,"unknown":false}),
            )
            .await
            .unwrap();
        assert!(store
            .save("test", &accepted.revision, json!({"count":4}))
            .await
            .is_err());
        let candidate = store.begin(app(), Some(json!({"count":99}))).await.unwrap();
        assert_eq!(candidate.value.state, saved.state);
        assert!(!candidate.value.extra.contains_key("baseRevision"));
        assert!(store
            .accept(
                &candidate,
                json!({"revision":candidate.value.revision,"render":"failed"})
            )
            .await
            .is_err());
        assert_eq!(
            store.accepted("test").await.unwrap().unwrap().revision,
            saved.revision
        );
        store
            .save("test", &saved.revision, json!({"count":5}))
            .await
            .unwrap();
        assert!(store
            .accept(&candidate, evidence(&candidate))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn failed_first_candidate_never_becomes_accepted() {
        let directory = tempfile::tempdir().unwrap();
        let store = GenUIStore::new(directory.path().to_owned());
        let candidate = store.begin(app(), None).await.unwrap();
        let mut rejected = evidence(&candidate);
        rejected["render"] = json!("failed");
        assert!(store.accept(&candidate, rejected).await.is_err());
        assert!(store.accepted("test").await.unwrap().is_none());

        // A repair can stage a replacement over the failed candidate and only
        // the replacement that passes acceptance becomes durable owner state.
        let replacement = store.begin(app(), None).await.unwrap();
        assert_ne!(replacement.value.revision, candidate.value.revision);
        assert!(store
            .accept(&replacement, evidence(&replacement))
            .await
            .is_ok());
        assert_eq!(
            store.accepted("test").await.unwrap().unwrap().revision,
            replacement.value.revision
        );
    }
    #[tokio::test]
    async fn accepted_ui_spec_survives_profile_changes_and_legacy_records_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let store = GenUIStore::new(directory.path().to_owned());
        let mut selected = app();
        selected["template"] = json!("openbitfun.harmony.app");
        selected["libraryId"] = json!("openbitfun.harmony.v1");
        selected["libraryRevision"] = json!(3);
        selected["designSpec"] = json!({"id":"harmony.phone.v1","revision":1});
        let first = store.begin(selected.clone(), None).await.unwrap();
        assert_eq!(first.value.app["designSpec"]["id"], "harmony.phone.v1");
        let accepted = store.accept(&first, evidence(&first)).await.unwrap();
        let mut changed_setting = selected;
        changed_setting["designSpec"] = json!({"id":"openbitfun.desktop.v1","revision":1});
        let edit = store.begin(changed_setting, None).await.unwrap();
        assert_eq!(edit.value.app["designSpec"], accepted.app["designSpec"]);

        let legacy_directory = tempfile::tempdir().unwrap();
        let legacy_store = GenUIStore::new(legacy_directory.path().to_owned());
        let path = legacy_store.path("test").unwrap();
        let mut legacy_app = app();
        legacy_app.as_object_mut().unwrap().remove("designSpec");
        let legacy = json!({"accepted":{"revision":"old","app":legacy_app,"state":{"count":1}}});
        JsonFileStore
            .write_atomic_strict(&path, &legacy)
            .await
            .unwrap();
        let error = legacy_store.begin(app(), None).await.unwrap_err();
        assert!(error.contains("missing design specification identity"));
        assert_eq!(
            JsonFileStore
                .read_optional::<Value>(&path)
                .await
                .unwrap()
                .unwrap(),
            legacy
        );
    }
    #[tokio::test]
    async fn superseded_candidates_and_corrupt_records_never_replace_accepted_data() {
        let directory = tempfile::tempdir().unwrap();
        let store = GenUIStore::new(directory.path().to_owned());
        let first = store.begin(app(), None).await.unwrap();
        let second = store.begin(app(), None).await.unwrap();
        assert!(store.accept(&first, evidence(&first)).await.is_err());
        store.accept(&second, evidence(&second)).await.unwrap();
        let path = store.path("test").unwrap();
        std::fs::write(&path, b"unreadable original record").unwrap();
        assert!(store.begin(app(), None).await.is_err());
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "unreadable original record"
        );
    }
    #[tokio::test]
    async fn old_records_future_fields_and_lost_acknowledgements_roundtrip() {
        let directory = tempfile::tempdir().unwrap();
        let store = GenUIStore::new(directory.path().to_owned());
        let path = store.path("test").unwrap();
        let original = json!({"futureRecord":{"keep":true},"accepted":{"revision":"old","app":app(),"state":{"count":2,"futureState":false},"futureRevision":[1,2]}});
        JsonFileStore
            .write_atomic_strict(&path, &original)
            .await
            .unwrap();
        let saved = store.save("test", "old", json!({"count":3})).await.unwrap();
        let retry = store.save("test", "old", json!({"count":3})).await.unwrap();
        assert_eq!(saved.revision, retry.revision);
        assert_eq!(saved.state["futureState"], false);
        assert!(store.save("test", "old", json!({"count":4})).await.is_err());
        let raw: Value = JsonFileStore.read_optional(&path).await.unwrap().unwrap();
        assert_eq!(raw["futureRecord"], original["futureRecord"]);
        assert_eq!(
            raw["accepted"]["futureRevision"],
            original["accepted"]["futureRevision"]
        );
        let candidate = store.begin(app(), None).await.unwrap();
        let mut rejected = evidence(&candidate);
        rejected["requirementCoverage"] = json!({"status":"unverified"});
        assert!(store.accept(&candidate, rejected).await.is_err());
        let mut skipped_review = evidence(&candidate);
        skipped_review["requirementCoverage"] =
            json!({"status":"skipped","method":"coverage_review","reason":"review_timed_out"});
        store.accept(&candidate, skipped_review).await.unwrap();
        assert_eq!(
            store.accepted("test").await.unwrap().unwrap().extra["futureRevision"],
            json!([1, 2])
        );
    }
    #[tokio::test]
    async fn acceptance_rejects_evidence_from_another_target_identity() {
        let directory = tempfile::tempdir().unwrap();
        let store = GenUIStore::new(directory.path().to_owned());
        let candidate = store.begin(app(), None).await.unwrap();

        let mut wrong_spec = evidence(&candidate);
        wrong_spec["designSpec"] = json!({"id":"harmony.phone.v1","revision":1});
        assert!(store
            .accept(&candidate, wrong_spec)
            .await
            .unwrap_err()
            .contains("UI specification"));

        let document_directory = tempfile::tempdir().unwrap();
        let document_store = GenUIStore::new(document_directory.path().to_owned());
        let mut document = app();
        document["template"] = json!("openbitfun.harmony.app");
        document["libraryId"] = json!("openbitfun.harmony.v1");
        document["libraryRevision"] = json!(3);
        document["designSpec"] = json!({"id":"harmony.phone.v1","revision":1});
        document["source"] = json!({"kind":"html-document","html":"<p>Phone</p>"});
        document["state"] = json!({});
        let document_candidate = document_store.begin(document, None).await.unwrap();
        assert_eq!(
            document_candidate.value.app["htmlRuntime"],
            openbitfun_product_domains::generative_ui::catalog()["htmlRuntime"]
        );
        let mut wrong_kind = evidence(&document_candidate);
        wrong_kind["sourceKind"] = json!("openui-lang");
        assert!(document_store
            .accept(&document_candidate, wrong_kind)
            .await
            .unwrap_err()
            .contains("source kind"));
    }

    #[tokio::test]
    async fn acceptance_requires_every_persisted_design_spec_check() {
        let directory = tempfile::tempdir().unwrap();
        let store = GenUIStore::new(directory.path().to_owned());
        let candidate = store.begin(app(), None).await.unwrap();
        let mut incomplete = evidence(&candidate);
        incomplete["appliedAcceptanceChecks"] = json!(["actual-render"]);
        let error = store.accept(&candidate, incomplete).await.unwrap_err();
        assert!(error.contains("declared-interactions"));
        assert!(store.accept(&candidate, evidence(&candidate)).await.is_ok());
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    #[serde(flatten)]
    pub value: Revision,
    pub base_revision: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    #[serde(default)]
    accepted: Option<Revision>,
    #[serde(default)]
    candidate: Option<Candidate>,
    #[serde(flatten)]
    extra: serde_json::Map<String, Value>,
}
pub struct GenUIStore {
    directory: PathBuf,
}
impl GenUIStore {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }
    fn path(&self, id: &str) -> Result<PathBuf, String> {
        if id.is_empty() {
            return Err("Application ID is empty".into());
        }
        // Encode identities instead of interpreting user supplied path syntax.
        let name: String = id
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        if name.len() > 200 {
            return Err("Application ID is too long for durable storage".into());
        }
        Ok(self.directory.join(format!("{name}.json")))
    }
    pub async fn accepted(&self, id: &str) -> Result<Option<Revision>, String> {
        Ok(JsonFileStore
            .read_locked_optional::<Record>(&self.path(id)?)
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_default()
            .accepted)
    }
    pub async fn begin(
        &self,
        mut app: Value,
        supplied_state: Option<Value>,
    ) -> Result<Candidate, String> {
        let path = self.path(app["id"].as_str().ok_or("Missing application ID")?)?;
        let _lock = JsonFileStore
            .acquire_cross_process_lock(&path)
            .await
            .map_err(|e| e.to_string())?;
        let mut record = JsonFileStore
            .read_optional::<Record>(&path)
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        if let Some(accepted) = record.accepted.as_ref() {
            // The accepted application is the owner of its adapter and design
            // specification identity. Global generation settings never rewrite
            // that record. A legacy record without designSpec is retained but
            // cannot be reopened until it is explicitly migrated.
            for field in ["template", "libraryId", "libraryRevision", "htmlRuntime"] {
                if let Some(value) = accepted.app.get(field) {
                    app[field] = value.clone();
                }
            }
            if accepted.app["source"]["kind"] == "html-document"
                && accepted.app.get("htmlRuntime").is_none()
            {
                return Err("Accepted HTML application is missing HTML runtime identity; original data retained".into());
            }
            app["designSpec"] = accepted
                .app
                .get("designSpec")
                .cloned()
                .ok_or("Accepted application is missing design specification identity; original data retained")?;
        }
        if app["source"]["kind"] == "html-document" && app.get("htmlRuntime").is_none() {
            // The model does not choose a host runtime. The owner stamps the
            // installed HTML runtime contract before validation and persistence.
            app["htmlRuntime"] =
                openbitfun_product_domains::generative_ui::catalog()["htmlRuntime"].clone();
        }
        openbitfun_product_domains::generative_ui::validate_generation(&app)?;
        openbitfun_product_domains::generative_ui::validate_design_spec(&app)?;
        let mut state = serde_json::Map::new();
        for (key, value) in app["state"]
            .as_object()
            .ok_or("Missing state declarations")?
        {
            state.insert(key.clone(), value["default"].clone());
        }
        if let Some(supplied) = supplied_state {
            let values = supplied
                .as_object()
                .ok_or("Application state must be an object")?;
            state.extend(values.clone());
        }
        // User data from the accepted owner wins over generated initial values.
        if let Some(accepted) = &record.accepted {
            state.extend(
                accepted
                    .state
                    .as_object()
                    .ok_or("Stored state is invalid; original record retained")?
                    .clone(),
            );
        }
        let state = Value::Object(state);
        openbitfun_product_domains::generative_ui::validate_state(&app, Some(&state))?;
        let candidate = Candidate {
            value: Revision {
                revision: uuid::Uuid::new_v4().to_string(),
                app,
                state,
                evidence: Value::Null,
                extra: record
                    .accepted
                    .as_ref()
                    .map(|accepted| accepted.extra.clone())
                    .unwrap_or_default(),
            },
            base_revision: record.accepted.as_ref().map(|value| value.revision.clone()),
        };
        record.candidate = Some(candidate.clone());
        JsonFileStore
            .write_atomic_strict(&path, &record)
            .await
            .map_err(|e| e.to_string())?;
        let readback: Record = JsonFileStore
            .read_optional(&path)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Candidate readback failed")?;
        readback
            .candidate
            .ok_or_else(|| "Candidate readback is empty".into())
    }
    pub async fn accept(&self, candidate: &Candidate, evidence: Value) -> Result<Revision, String> {
        let id = candidate.value.app["id"]
            .as_str()
            .ok_or("Missing application ID")?;
        let path = self.path(id)?;
        let _lock = JsonFileStore
            .acquire_cross_process_lock(&path)
            .await
            .map_err(|e| e.to_string())?;
        let mut record = JsonFileStore
            .read_optional::<Record>(&path)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Candidate is missing")?;
        let pending = record
            .candidate
            .as_ref()
            .ok_or("Candidate is no longer pending")?;
        if pending.value.revision != candidate.value.revision
            || pending.value.app != candidate.value.app
            || pending.value.state != candidate.value.state
            || record.accepted.as_ref().map(|v| &v.revision) != candidate.base_revision.as_ref()
        {
            return Err("Candidate was superseded or user data changed; previous accepted application retained".into());
        }
        for stage in [
            "preflight",
            "checks",
            "render",
            "reopen",
            "layout",
            "probeReopen",
        ] {
            if evidence[stage] != "passed" {
                return Err(format!("Candidate {stage} has not passed"));
            }
        }
        if evidence["revision"] != candidate.value.revision {
            return Err("Evidence belongs to a different candidate".into());
        }
        let library_identity = serde_json::json!({
            "id": candidate.value.app["libraryId"],
            "revision": candidate.value.app["libraryRevision"],
        });
        if evidence.get("library") != Some(&library_identity) {
            return Err(
                "Evidence component library identity does not match the candidate owner identity"
                    .into(),
            );
        }
        if evidence.get("designSpec") != candidate.value.app.get("designSpec") {
            return Err(
                "Evidence UI specification does not match the candidate owner identity".into(),
            );
        }
        if let Some(source_kind) = candidate.value.app["source"]["kind"].as_str() {
            if evidence["sourceKind"] != source_kind {
                return Err("Evidence source kind does not match the candidate".into());
            }
            if source_kind == "html-document"
                && evidence.get("htmlRuntime")
                    != Some(&openbitfun_product_domains::generative_ui::catalog()["htmlRuntime"])
            {
                return Err(
                    "Evidence HTML runtime identity does not match the installed host contract"
                        .into(),
                );
            }
        }
        if !matches!(
            evidence["requirementCoverage"]["status"].as_str(),
            Some("passed" | "skipped")
        ) {
            return Err("Candidate requirement review has not passed".into());
        }
        let design_spec_id = candidate.value.app["designSpec"]["id"]
            .as_str()
            .ok_or("Candidate UI specification identity is missing")?;
        let required_checks = openbitfun_product_domains::generative_ui::catalog()["designSpecs"]
            [design_spec_id]["acceptance"]["checks"]
            .as_array()
            .ok_or("Candidate UI specification has no acceptance checks")?;
        let applied_checks = evidence["appliedAcceptanceChecks"]
            .as_array()
            .ok_or("Candidate acceptance evidence has no applied acceptance checks")?;
        for check in required_checks {
            if !applied_checks.contains(check) {
                return Err(format!(
                    "Candidate acceptance check {} has no passed evidence",
                    check.as_str().unwrap_or("<unnamed>")
                ));
            }
        }
        let mut accepted = candidate.value.clone();
        accepted.evidence = evidence;
        record.accepted = Some(accepted.clone());
        record.candidate = None;
        JsonFileStore
            .write_atomic_strict(&path, &record)
            .await
            .map_err(|e| e.to_string())?;
        let readback: Record = JsonFileStore
            .read_optional(&path)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Accepted readback is missing")?;
        if readback.accepted.as_ref() != Some(&accepted) {
            return Err("Accepted readback differs from the candidate".into());
        }
        Ok(accepted)
    }
    pub async fn save(&self, id: &str, revision: &str, state: Value) -> Result<Revision, String> {
        let path = self.path(id)?;
        let _lock = JsonFileStore
            .acquire_cross_process_lock(&path)
            .await
            .map_err(|e| e.to_string())?;
        let mut record = JsonFileStore
            .read_optional::<Record>(&path)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Accepted application is missing")?;
        let accepted = record
            .accepted
            .as_mut()
            .ok_or("Application has not been accepted")?;
        let mut merged = accepted
            .state
            .as_object()
            .ok_or("Stored state is invalid")?
            .clone();
        merged.extend(state.as_object().ok_or("State must be an object")?.clone());
        let merged = Value::Object(merged);
        openbitfun_product_domains::generative_ui::validate_state(&accepted.app, Some(&merged))?;
        // A lost acknowledgement may retry an already committed write. Only
        // identical content is idempotent; stale differing state is rejected.
        if accepted.state == merged {
            return Ok(accepted.clone());
        }
        if accepted.revision != revision {
            return Err("Application changed on its owner; reload before saving".into());
        }
        accepted.state = merged;
        accepted.revision = uuid::Uuid::new_v4().to_string();
        let result = accepted.clone();
        JsonFileStore
            .write_atomic_strict(&path, &record)
            .await
            .map_err(|e| e.to_string())?;
        let readback: Record = JsonFileStore
            .read_optional(&path)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Saved readback is missing")?;
        if readback.accepted.as_ref() != Some(&result) {
            return Err("Saved readback differs from the submitted state".into());
        }
        Ok(result)
    }
}
