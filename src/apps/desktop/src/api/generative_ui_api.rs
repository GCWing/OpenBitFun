//! Source-bound application state; never accept controller filesystem paths.
use openbitfun_core::agentic::WorkspaceBinding;
use openbitfun_services_integrations::generative_ui::{GenUIStore, Revision};
use serde::Deserialize;
use serde_json::Value;

const WIKIPEDIA_SUMMARY: &str = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const WIKIMEDIA_API: &str = "https://commons.wikimedia.org/w/api.php";
const SO_IMAGE_API: &str = "https://image.so.com/j";
const BAIDU_IMAGE_API: &str = "https://image.baidu.com/search/acjson";
const NOMINATIM_API: &str = "https://nominatim.openstreetmap.org/search";
const OSRM_API: &str = "https://router.project-osrm.org/route/v1/driving/";
const VALHALLA_API: &str = "https://valhalla1.openstreetmap.de/route";
const GENUI_NETWORK_TIMEOUT_SECS: u64 = 12;
const DOMESTIC_IMAGE_TIMEOUT_SECS: u64 = 6;
const OPEN_IMAGE_TIMEOUT_SECS: u64 = 8;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenUIProviderRequest {
    capability: String,
    #[serde(default)]
    args: Value,
}

fn provider_client() -> Result<reqwest::Client, String> {
    provider_client_with_timeout(GENUI_NETWORK_TIMEOUT_SECS)
}

fn provider_client_with_timeout(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("OpenBitFun/1.0 (GenUI host provider)")
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|error| format!("GenUI provider HTTP client unavailable: {error}"))
}

fn query_arg(args: &Value) -> Result<String, String> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if !(2..=200).contains(&query.chars().count()) {
        return Err("GenUI provider query must contain 2 to 200 characters".into());
    }
    Ok(query.to_string())
}

fn push_image_url(images: &mut Vec<String>, value: Option<&Value>) {
    let Some(url) = value.and_then(Value::as_str).map(str::trim) else {
        return;
    };
    if !(url.starts_with("https://") || url.starts_with("http://"))
        || url.to_ascii_lowercase().contains(".svg")
        || url.to_ascii_lowercase().contains("logo")
        || url.to_ascii_lowercase().contains("icon")
        || images.iter().any(|item| item == url)
    {
        return;
    }
    images.push(url.to_string());
}

fn collect_image_urls(value: &Value, images: &mut Vec<String>) {
    match value {
        Value::Array(items) => items
            .iter()
            .for_each(|item| collect_image_urls(item, images)),
        Value::Object(record) => {
            for key in [
                "src",
                "url",
                "thumb",
                "img",
                "link",
                "thumbURL",
                "middleURL",
                "objURL",
                "hoverURL",
            ] {
                push_image_url(images, record.get(key));
            }
            for value in record.values() {
                if images.len() >= 8 {
                    break;
                }
                if value.is_array() || value.is_object() {
                    collect_image_urls(value, images);
                }
            }
        }
        _ => {}
    }
}

async fn so_image_search(query: &str) -> Vec<String> {
    let Ok(client) = provider_client_with_timeout(DOMESTIC_IMAGE_TIMEOUT_SECS) else {
        return Vec::new();
    };
    let Ok(response) = client
        .get(SO_IMAGE_API)
        .query(&[
            ("q", query),
            ("pn", "0"),
            ("sn", "0"),
            ("pd", "1"),
            ("correct", query),
        ])
        .send()
        .await
    else {
        return Vec::new();
    };
    if !response.status().is_success() {
        return Vec::new();
    }
    let Ok(value) = response.json::<Value>().await else {
        return Vec::new();
    };
    let mut images = Vec::new();
    collect_image_urls(&value, &mut images);
    images.truncate(4);
    images
}

async fn baidu_image_search(query: &str) -> Vec<String> {
    let Ok(client) = provider_client_with_timeout(DOMESTIC_IMAGE_TIMEOUT_SECS) else {
        return Vec::new();
    };
    let Ok(response) = client
        .get(BAIDU_IMAGE_API)
        .query(&[
            ("tn", "resultjson_com"),
            ("word", query),
            ("ie", "utf-8"),
            ("pn", "0"),
            ("rn", "10"),
        ])
        .send()
        .await
    else {
        return Vec::new();
    };
    if !response.status().is_success() {
        return Vec::new();
    }
    let Ok(value) = response.json::<Value>().await else {
        return Vec::new();
    };
    let mut images = Vec::new();
    collect_image_urls(&value, &mut images);
    images.truncate(4);
    images
}

async fn open_image_search(query: &str) -> Vec<String> {
    let Ok(client) = provider_client_with_timeout(OPEN_IMAGE_TIMEOUT_SECS) else {
        return Vec::new();
    };
    let mut images = Vec::new();

    // OI uses Wikipedia + Commons because they return stable, openly licensed
    // image URLs. Keep the same ordering and run both requests concurrently.
    let wiki_url = format!("{}{}", WIKIPEDIA_SUMMARY, urlencoding::encode(query));
    let wiki = client.get(wiki_url).send();
    let commons = client
        .get(WIKIMEDIA_API)
        .query(&[
            ("action", "query"),
            ("format", "json"),
            ("formatversion", "2"),
            ("generator", "search"),
            ("gsrsearch", query),
            ("gsrnamespace", "6"),
            ("gsrlimit", "8"),
            ("prop", "imageinfo"),
            ("iiprop", "url|mime"),
            ("iiurlwidth", "960"),
        ])
        .send();
    let (wiki, commons) = tokio::join!(wiki, commons);
    if let Ok(response) = wiki {
        if response.status().is_success() {
            if let Ok(value) = response.json::<Value>().await {
                push_image_url(&mut images, value.pointer("/thumbnail/source"));
            }
        }
    }
    if let Ok(response) = commons {
        if response.status().is_success() {
            if let Ok(value) = response.json::<Value>().await {
                collect_image_urls(&value, &mut images);
            }
        }
    }
    images.truncate(4);
    images
}

async fn native_image_search(query: &str) -> Result<Value, String> {
    // Prefer the domestic endpoint so a mainland host does not wait for an
    // unreachable overseas request. 360 and Baidu are best-effort search
    // sources; the OpenUI-compatible Wikimedia sources remain a second choice
    // for queries that domestic providers cannot answer.
    let mut images = so_image_search(query).await;
    if images.is_empty() {
        images = baidu_image_search(query).await;
    }
    if images.is_empty() {
        images = open_image_search(query).await;
    }
    Ok(serde_json::json!({ "images": images }))
}

async fn native_map_lookup(query: &str) -> Result<Value, String> {
    let client = provider_client()?;
    let response = client
        .get(NOMINATIM_API)
        .query(&[("q", query), ("format", "jsonv2"), ("limit", "8")])
        .header("accept-language", "zh-CN,zh;q=0.9,en;q=0.7")
        .send()
        .await
        .map_err(|error| format!("Map lookup failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Map lookup returned HTTP {}", response.status()));
    }
    let results = response
        .json::<Vec<Value>>()
        .await
        .map_err(|error| format!("Map lookup response was invalid: {error}"))?;
    let markers = results
        .into_iter()
        .filter_map(|item| {
            let lat = item.get("lat")?.as_str()?.parse::<f64>().ok()?;
            let lng = item.get("lon")?.as_str()?.parse::<f64>().ok()?;
            Some(serde_json::json!({
                "label": item.get("display_name").and_then(Value::as_str).unwrap_or("Place"),
                "lat": lat,
                "lng": lng,
                "category": item.get("type").and_then(Value::as_str),
            }))
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({ "markers": markers }))
}

async fn native_map_route(args: &Value) -> Result<Value, String> {
    let markers = args
        .get("markers")
        .and_then(Value::as_array)
        .ok_or("Map route requires a markers array")?;
    if markers.len() < 2 || markers.len() > 100 {
        return Err("Map route requires between 2 and 100 markers".into());
    }
    let mut coordinates = Vec::with_capacity(markers.len());
    for marker in markers {
        let lat = marker
            .get("lat")
            .and_then(Value::as_f64)
            .ok_or("Map marker latitude is invalid")?;
        let lng = marker
            .get("lng")
            .and_then(Value::as_f64)
            .ok_or("Map marker longitude is invalid")?;
        if !lat.is_finite()
            || !lng.is_finite()
            || !(-90.0..=90.0).contains(&lat)
            || !(-180.0..=180.0).contains(&lng)
        {
            return Err("Map marker coordinates are out of range".into());
        }
        coordinates.push(format!("{lng},{lat}"));
    }
    let client = provider_client_with_timeout(8)?;
    let osrm = client
        .get(format!("{}{}", OSRM_API, coordinates.join(";")))
        .query(&[("overview", "full"), ("geometries", "geojson")])
        .send()
        .await;
    if let Ok(response) = osrm {
        if response.status().is_success() {
            if let Ok(value) = response.json::<Value>().await {
                if value
                    .pointer("/routes/0/geometry/coordinates")
                    .and_then(Value::as_array)
                    .is_some_and(|points| points.len() > 1)
                {
                    return Ok(value);
                }
            }
        }
    }

    // The public OSRM endpoint is frequently unreachable from mainland
    // networks. Valhalla's OpenStreetMap deployment is a compatible fallback;
    // normalize its encoded polyline into the same GeoJSON shape consumed by
    // the OpenUI map renderer.
    let locations = markers
        .iter()
        .map(|marker| {
            serde_json::json!({
                "lat": marker.get("lat").and_then(Value::as_f64),
                "lon": marker.get("lng").and_then(Value::as_f64),
            })
        })
        .collect::<Vec<_>>();
    let response = client
        .post(VALHALLA_API)
        .json(&serde_json::json!({
            "locations": locations,
            "costing": "auto",
            "units": "kilometers",
        }))
        .send()
        .await
        .map_err(|error| format!("Street route failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Street route returned HTTP {}", response.status()));
    }
    let value = response
        .json::<Value>()
        .await
        .map_err(|error| format!("Street route response was invalid: {error}"))?;
    let mut coordinates = Vec::<Value>::new();
    if let Some(legs) = value.pointer("/trip/legs").and_then(Value::as_array) {
        for shape in legs
            .iter()
            .filter_map(|leg| leg.get("shape").and_then(Value::as_str))
        {
            coordinates.extend(decode_valhalla_polyline(shape)?);
        }
    }
    if coordinates.len() < 2 {
        return Err("Street route provider returned no usable geometry".into());
    }
    Ok(serde_json::json!({
        "routes": [{ "geometry": { "type": "LineString", "coordinates": coordinates } }]
    }))
}

fn decode_valhalla_polyline(encoded: &str) -> Result<Vec<Value>, String> {
    let bytes = encoded.as_bytes();
    let mut index = 0;
    let mut latitude = 0_i64;
    let mut longitude = 0_i64;
    let mut points = Vec::new();
    while index < bytes.len() {
        let delta_latitude = decode_polyline_value(bytes, &mut index)?;
        let delta_longitude = decode_polyline_value(bytes, &mut index)?;
        latitude += delta_latitude;
        longitude += delta_longitude;
        points.push(serde_json::json!([
            longitude as f64 / 1_000_000.0,
            latitude as f64 / 1_000_000.0,
        ]));
    }
    Ok(points)
}

fn decode_polyline_value(bytes: &[u8], index: &mut usize) -> Result<i64, String> {
    let mut result = 0_i64;
    let mut shift = 0_u32;
    loop {
        let byte = *bytes
            .get(*index)
            .ok_or("Street route geometry was truncated")?;
        *index += 1;
        let value = i64::from(byte.saturating_sub(63));
        result |= (value & 0x1f) << shift;
        if value < 0x20 {
            break;
        }
        shift += 5;
        if shift > 60 {
            return Err("Street route geometry was invalid".into());
        }
    }
    Ok(if result & 1 != 0 {
        !(result >> 1)
    } else {
        result >> 1
    })
}

#[tauri::command]
pub async fn gen_ui_provider_call(request: GenUIProviderRequest) -> Result<Value, String> {
    match request.capability.trim() {
        "image.search" | "SearchImage" => native_image_search(&query_arg(&request.args)?).await,
        "map.lookup" | "Map" => native_map_lookup(&query_arg(&request.args)?).await,
        "map.route" => native_map_route(&request.args).await,
        capability => Err(format!(
            "GenUI capability {capability} is unavailable on this host"
        )),
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenUIAppRequest {
    workspace_id: String,
    session_id: String,
    app_id: String,
    #[serde(default)]
    revision: Option<String>,
    #[serde(default)]
    state: Option<Value>,
    /// Optional identity echo from the active renderer. Older callers may omit
    /// this field; when present the owner rejects a response from another
    /// design specification instead of silently hydrating it.
    #[serde(default)]
    design_spec: Option<Value>,
    #[serde(default)]
    source_kind: Option<String>,
    #[serde(default)]
    library_id: Option<String>,
    #[serde(default)]
    library_revision: Option<i64>,
}

fn validate_owner_identity(
    accepted: &Revision,
    expected_library_id: Option<&str>,
    expected_library_revision: Option<i64>,
    expected_design_spec: Option<&Value>,
    expected_source_kind: Option<&str>,
) -> Result<(), String> {
    if let Some(expected) = accepted.app["libraryId"].as_str() {
        if expected_library_id != Some(expected)
            || expected_library_revision != accepted.app["libraryRevision"].as_i64()
        {
            return Err("GenUI owner returned a different component library identity".into());
        }
    }
    if let Some(expected) = expected_design_spec {
        if accepted.app.get("designSpec") != Some(expected) {
            return Err("GenUI owner returned a different UI specification identity".into());
        }
    }
    if let Some(expected) = expected_source_kind {
        if accepted.app["source"]["kind"].as_str() != Some(expected) {
            return Err("GenUI owner returned a different source kind".into());
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn gen_ui_app(request: GenUIAppRequest) -> Result<Option<Revision>, String> {
    openbitfun_core_types::validate_session_id(&request.session_id)?;
    let workspace = WorkspaceBinding::resolve(&request.workspace_id)
        .await
        .map_err(|e| e.to_string())?;
    let coordinator = openbitfun_core::agentic::coordination::get_global_coordinator()
        .ok_or("GenUI session owner is unavailable")?;
    let metadata = coordinator
        .get_session_manager()
        .load_session_metadata(&workspace.session_storage_dir(), &request.session_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("GenUI owning session does not exist in the requested workspace")?;
    if metadata
        .workspace_id
        .as_ref()
        .is_some_and(|id| id != &request.workspace_id)
    {
        return Err("GenUI session belongs to a different workspace".into());
    }
    let store = GenUIStore::new(
        workspace
            .session_storage_dir()
            .join(&request.session_id)
            .join("artifacts")
            .join("genui"),
    );
    match (request.state, request.revision) {
        (None, None) => {
            let accepted = store.accepted(&request.app_id).await?;
            if let Some(accepted) = accepted.as_ref() {
                validate_owner_identity(
                    accepted,
                    request.library_id.as_deref(),
                    request.library_revision,
                    request.design_spec.as_ref(),
                    request.source_kind.as_deref(),
                )?;
            }
            Ok(accepted)
        }
        (Some(state), Some(revision)) => {
            let accepted = store
                .accepted(&request.app_id)
                .await?
                .ok_or("No accepted GenUI revision exists on the owner")?;
            validate_owner_identity(
                &accepted,
                request.library_id.as_deref(),
                request.library_revision,
                request.design_spec.as_ref(),
                request.source_kind.as_deref(),
            )?;
            store
                .save(&request.app_id, &revision, state)
                .await
                .map(Some)
        }
        _ => Err("Saving GenUI state requires state and its acknowledged owner revision".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn revision() -> Revision {
        serde_json::from_value(json!({
            "revision": "r1",
            "app": {
                "id": "app",
                "template": "openbitfun.app",
                "libraryId": "openbitfun.composable.v1",
                "libraryRevision": 2,
                "designSpec": {"id": "harmony.phone.v1", "revision": 1},
                "source": {"kind": "html-document"}
            },
            "state": {},
            "evidence": null
        }))
        .unwrap()
    }

    #[test]
    fn owner_identity_echo_is_required_for_pinned_library_callers() {
        assert!(validate_owner_identity(&revision(), None, None, None, None).is_err());
        assert!(validate_owner_identity(
            &revision(),
            Some("openbitfun.composable.v1"),
            Some(2),
            None,
            None
        )
        .is_ok());
    }

    #[test]
    fn owner_identity_echo_rejects_cross_target_reads_and_saves() {
        let accepted = revision();
        assert!(validate_owner_identity(
            &accepted,
            Some("openbitfun.composable.v1"),
            Some(2),
            Some(&json!({"id":"openbitfun.desktop.v1","revision":1})),
            Some("html-document"),
        )
        .is_err());
        assert!(validate_owner_identity(
            &accepted,
            Some("openbitfun.composable.v1"),
            Some(2),
            Some(&json!({"id":"harmony.phone.v1","revision":1})),
            Some("openui-lang"),
        )
        .is_err());
        assert!(validate_owner_identity(
            &accepted,
            Some("openbitfun.composable.v1"),
            Some(2),
            Some(&json!({"id":"harmony.phone.v1","revision":1})),
            Some("html-document"),
        )
        .is_ok());
    }

    #[test]
    fn normalizes_domestic_image_search_payloads() {
        let payload = json!({
            "list": [
                {"thumb": "https://images.example/photo.jpg"},
                {"img": "http://images.example/logo-icon.jpg"},
                {"link": "https://images.example/photo.jpg"}
            ]
        });
        let mut images = Vec::new();
        collect_image_urls(&payload, &mut images);
        assert_eq!(images, vec!["https://images.example/photo.jpg"]);
    }

    #[test]
    fn decodes_valhalla_polyline6_to_geojson_coordinates() {
        let points = decode_valhalla_polyline(
            "c{cqz@eidufFsByEuFgMyCyGkKuVy\\}v@uK}XqJuWoGyPsDcJ{Pmb@aHyQgGmQ}E{MaEyLcFyPy@aGsF{_@{Fw\\eBmIs@iEqAwLe@wESaJZkKrAmYzH}o@`EcNlFcBbPoCj^gEzt@kIzLaBtA|JPnAhGnUxE`NbDpKvHdZrHlXzDlM`IzOlG|KhCxDtCzDzRvO`PzKpG`EnDvGbGtRxBhH|Nte@lStp@pGvSbYn~@nBnGhQsF`^}KvUoHpP_G~a@uMdH{BhMkBnm@kFzFa@",
        )
        .unwrap();
        assert!(points.len() > 2);
        let first = points.first().unwrap().as_array().unwrap();
        assert!((first[0].as_f64().unwrap() - 121.4737).abs() < 0.001);
        assert!((first[1].as_f64().unwrap() - 31.2304).abs() < 0.001);
    }
}
