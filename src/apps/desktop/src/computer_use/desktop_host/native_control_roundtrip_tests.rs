//! Real Tool -> desktop host -> native capture/input regression, opt-in only.
use super::desktop_host::DesktopComputerUseHost;
use openbitfun_core::agentic::tools::computer_use_host::ComputerUseHost;
use openbitfun_core::agentic::tools::framework::{Tool, ToolResult, ToolUseContext};
use openbitfun_core::agentic::tools::implementations::ComputerUseTool;
use serde_json::{json, Value};
use std::sync::Arc;

#[path = "native_control_probe.rs"]
mod probe;

const OWNER: &str = "native-control-roundtrip-fixture";
async fn select_and_grant_fixture(host: &DesktopComputerUseHost, pid: i32, window: Option<u64>) {
    let pending = crate::computer_use::control_session::request_share(
        OWNER,
        openbitfun_agent_tools::computer_use_control::ControlMode::Background,
    )
    .unwrap();
    assert_eq!(pending.state, "awaiting_share");
    assert!(crate::computer_use::control_session::acquire(OWNER, "app_click").is_err());
    let target = crate::computer_use::share_targets()
        .await
        .unwrap()
        .into_iter()
        .find(|target| {
            target.pid == Some(pid)
                && window.map_or(target.title == "Computer Use Roundtrip Fixture", |id| {
                    target.window_id == Some(id)
                })
        })
        .expect("fixture sharing choice");
    let shared = host
        .share_selected_target(
            pending.generation,
            &target.selection_id,
            openbitfun_agent_tools::computer_use_control::ControlMode::Background,
        )
        .await
        .unwrap();
    assert_eq!(
        shared.mode,
        openbitfun_agent_tools::computer_use_control::ControlMode::Observe
    );
    assert!(crate::computer_use::control_session::acquire(OWNER, "app_click").is_err());
    use crate::computer_use::shared_preview::{self, SharedInputRequest, SharedPreviewRequest};
    let preview_scope = || SharedPreviewRequest {
        generation: shared.generation,
        target_revision: shared.target_revision,
        authorization_revision: shared.sharing.as_ref().unwrap().authorization_revision,
    };
    let preview = shared_preview::observe(preview_scope()).await.unwrap();
    assert!(preview.frame.as_ref().is_some_and(|frame| frame.width > 0
        && frame.height > 0
        && !frame.screenshot_id.is_empty()));
    let denied = shared_preview::input(SharedInputRequest {
        scope: preview_scope(),
        input: openbitfun_core::agentic::tools::computer_use_host::AppInputAction::KeyChord {
            keys: vec!["escape".into()],
            focus_idx: None,
        },
    })
    .await
    .unwrap_err();
    assert!(denied.contains("CONTROL_OBSERVE_ONLY"), "{denied}");
    crate::computer_use::control_session::set_share_control(
        shared.generation,
        shared.target_revision,
        shared.sharing.as_ref().unwrap().authorization_revision,
        true,
    )
    .unwrap();
}
struct StopOnExit;
impl Drop for StopOnExit {
    fn drop(&mut self) {
        let _ = crate::computer_use::control_session::stop(Some(OWNER), "fixture_cleanup");
    }
}

async fn call(tool: &ComputerUseTool, context: &ToolUseContext, input: Value) -> Value {
    call_observation(tool, context, input).await.data
}

struct NativeObservation {
    data: Value,
    image_count: usize,
}

async fn call_observation(
    tool: &ComputerUseTool,
    context: &ToolUseContext,
    input: Value,
) -> NativeObservation {
    let started = std::time::Instant::now();
    eprintln!("TRACE native roundtrip action: {}", input["action"]);
    let results = tool
        .call_impl(&input, context)
        .await
        .unwrap_or_else(|error| panic!("Tool action {} failed: {error}", input["action"]));
    eprintln!(
        "TRACE native roundtrip completed: {} elapsed_ms={}",
        input["action"],
        started.elapsed().as_millis()
    );
    let body = results
        .first()
        .expect("tool returned an observation")
        .content();
    assert_ne!(body.get("ok"), Some(&Value::Bool(false)), "{body}");
    assert_ne!(body.get("success"), Some(&Value::Bool(false)), "{body}");
    let data = if body.get("ok") == Some(&Value::Bool(true)) && body.get("data").is_some() {
        body["data"].clone()
    } else {
        body
    };
    let image_count = results
        .iter()
        .map(|result| match result {
            ToolResult::Result {
                image_attachments, ..
            } => image_attachments.as_ref().map_or(0, Vec::len),
            _ => 0,
        })
        .sum();
    NativeObservation { data, image_count }
}

fn assert_app_observation(
    result: &NativeObservation,
    include_image: bool,
    previous_id: Option<&str>,
) -> String {
    let state = &result.data["app_state"];
    let id = state["observation_id"]
        .as_str()
        .expect("fresh application observation identity");
    assert!(!id.is_empty());
    assert_ne!(
        Some(id),
        previous_id,
        "each read must replace the AX index namespace"
    );
    assert!(state["node_count"].as_u64().is_some_and(|count| count > 0));
    assert_eq!(state["has_screenshot"], include_image);
    assert_eq!(result.image_count, usize::from(include_image));
    if include_image {
        assert!(state["screenshot_meta"]["screenshot_id"]
            .as_str()
            .is_some_and(|id| !id.is_empty()));
    } else {
        assert!(
            state.get("screenshot_meta").is_none(),
            "AX-only observation must not advertise image coordinates"
        );
    }
    id.to_owned()
}

fn observed_node_index(observation: &Value, label: &str) -> u32 {
    let line = observation["app_state"]["tree_text"]
        .as_str()
        .expect("native AX tree")
        .lines()
        .find(|line| line.contains(label))
        .expect("fixture control in native AX tree");
    line.trim()
        .strip_prefix('[')
        .unwrap()
        .split(']')
        .next()
        .unwrap()
        .parse()
        .unwrap()
}

fn assert_session(
    host: &DesktopComputerUseHost,
    generation: u64,
    target: &str,
    foreground: Option<i32>,
) {
    let current = host.control_snapshot();
    assert_eq!(current.state, "active", "{current:?}");
    assert_eq!(
        current.generation, generation,
        "control restarted between actions"
    );
    assert_eq!(
        current.target.as_deref(),
        Some(target),
        "capture retargeted between actions"
    );
    assert_eq!(crate::computer_use::macos_bg_input::frontmost_pid_macos(), foreground,
        "tool pipeline changed the foreground application; human switching also invalidates this assertion");
}

async fn wait_for_observer(path: &str) -> Value {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let ready = std::fs::read_to_string(path)
            .ok()
            .and_then(|data| serde_json::from_str::<Value>(&data).ok());
        if let Some(state) = ready.filter(|state| {
            state["ready"] == true
                && state["active"] == true
                && state["key_window"] == true
                && state["pid"].as_i64().map(|pid| pid as i32)
                    == crate::computer_use::macos_bg_input::frontmost_pid_macos()
        }) {
            return state;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "foreground observer failed to establish the startup baseline"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

pub(crate) async fn run() {
    if std::env::var_os("OPENBITFUN_CUA_PROBE_PID").is_some() {
        probe::run().await;
        return;
    }
    if std::env::var_os("OPENBITFUN_INPUT_FIXTURE_PID").is_some() {
        if let Ok(case) = std::env::var("OPENBITFUN_INPUT_LATENCY_CASE") {
            run_latency_case(&case).await;
        } else {
            run_covered_semantic().await;
        }
        return;
    }
    let pid: i32 = std::env::var("OPENBITFUN_ROUNDTRIP_FIXTURE_PID")
        .unwrap()
        .parse()
        .unwrap();
    let x: f64 = std::env::var("OPENBITFUN_ROUNDTRIP_FIXTURE_X")
        .unwrap()
        .parse()
        .unwrap();
    let y: f64 = std::env::var("OPENBITFUN_ROUNDTRIP_FIXTURE_Y")
        .unwrap()
        .parse()
        .unwrap();
    let result_path = std::env::var("OPENBITFUN_ROUNDTRIP_FIXTURE_RESULT").unwrap();
    if let Ok(observer_path) = std::env::var("OPENBITFUN_INPUT_OBSERVER_RESULT") {
        wait_for_observer(&observer_path).await;
    }
    let foreground = crate::computer_use::macos_bg_input::frontmost_pid_macos();
    assert_ne!(
        foreground,
        Some(pid),
        "fixture must start in the background"
    );
    let host = Arc::new(DesktopComputerUseHost::new());
    let mut context = ToolUseContext::for_tool_listing(None, None);
    context.session_id = Some(OWNER.into());
    context.computer_use_host = Some(host.clone());
    context.primary_model_facts.supports_image_inputs = true;
    context.primary_model_facts.api_format = "anthropic".into();
    let tool = ComputerUseTool::new();
    let _cleanup = StopOnExit;
    // Reproduce ordinary Agent usage: discovery followed by the first app
    // observation starts background control without any UI sharing calls.
    let apps = call(&tool, &context, json!({"action":"list_apps"})).await;
    assert!(
        apps.to_string().contains(&pid.to_string()),
        "fixture missing from real application discovery"
    );
    let before_discovery = host.control_snapshot();
    let windows = call(&tool, &context, json!({"action":"list_windows"})).await;
    assert_eq!(
        host.control_snapshot().generation,
        before_discovery.generation
    );
    assert_eq!(host.control_snapshot().target, before_discovery.target);
    let window = windows["windows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|window| window["pid"] == pid && window["title"] == "Computer Use Roundtrip Fixture")
        .expect("small task window must be discoverable independently of AX and default capture");
    let window_id = window["window_id"].as_u64().unwrap();
    let main = call(
        &tool,
        &context,
        json!({"action":"get_app_state", "app":{"pid":pid}}),
    )
    .await;
    assert_eq!(
        main["app_state"]["window_title"],
        "Computer Use Large Main Fixture"
    );
    let previous_revision = host.control_snapshot().target_revision;
    let observation = call(
        &tool,
        &context,
        json!({"action":"get_app_state", "app":{"pid":pid,"window_id":window_id}}),
    )
    .await;
    assert_eq!(
        observation["app_state"]["window_title"],
        "Computer Use Roundtrip Fixture"
    );
    assert!(host.control_snapshot().target_revision > previous_revision);
    assert_eq!(
        host.control_snapshot().target,
        Some(format!("pid:{pid}/window:{window_id}"))
    );
    // A stale/wrong-owner window request must fail without attaching the old
    // window's AX or pixels, and without destroying its healthy capture.
    let retained = host.control_snapshot();
    let wrong_owner = tool.call_impl(&json!({"action":"get_app_state","app":{"pid":std::process::id(),"window_id":window_id}}), &context).await.unwrap_err();
    assert!(
        wrong_owner
            .to_string()
            .contains("TARGET_WINDOW_UNAVAILABLE"),
        "{wrong_owner}"
    );
    assert_eq!(host.control_snapshot().target, retained.target);
    assert_eq!(
        host.control_snapshot().target_revision,
        retained.target_revision
    );
    let described = call_observation(
        &tool,
        &context,
        json!({"action":"describe_screen","include_image":true}),
    )
    .await;
    assert_eq!(described.image_count, 1);
    assert_eq!(
        described.data["window_title"],
        "Computer Use Roundtrip Fixture"
    );
    assert_eq!(described.data["image_bytes"], true);
    assert!(described.data["screenshot_meta"]["screenshot_id"]
        .as_str()
        .is_some());
    let control = host.control_snapshot();
    assert_eq!(control.state, "active");
    assert!(control.sharing.is_none());
    let generation = control.generation;
    let old_observation_id = observation["app_state"]["observation_id"]
        .as_str()
        .expect("scoped observation identity")
        .to_owned();
    let observation = call(
        &tool,
        &context,
        json!({"action":"get_app_state", "app":{"pid":pid}}),
    )
    .await;
    let observation_id = observation["app_state"]["observation_id"].as_str().unwrap();
    assert_ne!(
        old_observation_id, observation_id,
        "identical trees still have different reference lifetimes"
    );
    let stale = tool
        .call_impl(
            &json!({"action":"app_click", "app":{"pid":pid}, "observation_id":old_observation_id,
        "target":{"kind":"node_idx","idx":0}}),
            &context,
        )
        .await;
    assert!(stale.unwrap_err().to_string().contains("STALE_OBSERVATION"));
    let target = host
        .control_snapshot()
        .target
        .expect("prepare_control_target bound a real window");
    assert_session(&host, generation, &target, foreground);
    let tree = observation["app_state"]["tree_text"]
        .as_str()
        .expect("AX observation");
    let button_line = tree
        .lines()
        .find(|line| line.contains("Fixture semantic action"))
        .expect("fixture button exposed through AX");
    let button_idx: u32 = button_line
        .trim()
        .strip_prefix('[')
        .unwrap()
        .split(']')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    call(
        &tool,
        &context,
        json!({"action":"app_click", "app":{"pid":pid}, "observation_id":observation_id,
        "target":{"kind":"node_idx", "idx":button_idx}}),
    )
    .await;
    assert_session(&host, generation, &target, foreground);

    // Refresh through the full tool after the sharing indicator has appeared.
    // The old implementation would switch to the indicator window here.
    let observation = call(
        &tool,
        &context,
        json!({"action":"get_app_state", "app":{"pid":pid}}),
    )
    .await;
    let meta = &observation["app_state"]["screenshot_meta"];
    let global = &meta["image_global_bounds"];
    let content = &meta["image_content_rect"];
    let image_x = content["left"].as_f64().unwrap()
        + (x - global["left"].as_f64().unwrap()) * content["width"].as_f64().unwrap()
            / global["width"].as_f64().unwrap();
    let image_y = content["top"].as_f64().unwrap()
        + (y - global["top"].as_f64().unwrap()) * content["height"].as_f64().unwrap()
            / global["height"].as_f64().unwrap();
    let batch = call(
        &tool,
        &context,
        json!({"action":"app_batch", "app":{"pid":pid}, "steps":[
            {"action":"app_click", "target":{"kind":"image_xy", "x":image_x.round() as i32, "y":image_y.round() as i32,
                  "screenshot_id":meta["screenshot_id"]}},
            {"action":"app_type_text", "text":"背景"},
            {"action":"app_type_text", "text":"输入"},
            {"action":"app_type_text", "text":" Test"},
            {"action":"app_key_chord", "keys":["return"]}
        ]}),
    )
    .await;
    assert_eq!(batch["completed_steps"], 5, "{batch}");
    assert_eq!(batch["status"], "submitted", "{batch}");
    assert_session(&host, generation, &target, foreground);

    // Exercise text-only observation/OCR against the same bound target.
    context.primary_model_facts.supports_image_inputs = false;
    let description = call(&tool, &context, json!({"action":"describe_screen"})).await;
    assert_eq!(description["target_application"]["pid"], pid);
    assert_eq!(
        description["ocr_status"], "ok",
        "native OCR must read the fixture: {description}"
    );
    assert!(
        description["ocr_text"].to_string().contains("Test"),
        "OCR must read the rendered input, independently of the AX value: {description}"
    );
    assert!(
        description.to_string().contains("背景输入 Test"),
        "final observation must expose the entered text"
    );
    assert_session(&host, generation, &target, foreground);
    let counts: Value =
        serde_json::from_str(&std::fs::read_to_string(result_path).unwrap()).unwrap();
    assert_eq!(
        counts,
        json!({"downs":1,"ups":1,"enters":1,"activations":1,"text":"背景输入 Test"}),
        "each mutation must reach the target exactly once"
    );
    let stop = call(&tool, &context, json!({"action":"stop_control"})).await;
    assert_eq!(stop["state"], "stopped");
    assert_eq!(
        host.control_snapshot().generation,
        generation + 1,
        "stop must revoke the active generation"
    );
    assert_eq!(
        crate::computer_use::macos_bg_input::frontmost_pid_macos(),
        foreground
    );
    eprintln!("PASS native tool pipeline: observation, semantic click, image click, Unicode input, Return, OCR verification and stop; binding/generation/foreground stayed stable");
}

async fn run_covered_semantic() {
    let pid: i32 = std::env::var("OPENBITFUN_INPUT_FIXTURE_PID")
        .unwrap()
        .parse()
        .unwrap();
    let path = std::env::var("OPENBITFUN_INPUT_FIXTURE_RESULT").unwrap();
    let observer_path = std::env::var("OPENBITFUN_INPUT_OBSERVER_RESULT").unwrap();
    let read = |path: &str| -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    };
    wait_for_observer(&observer_path).await;
    let initial = read(&path);
    let initial_observer = read(&observer_path);
    assert_eq!(initial["bundle_id"], "dev.openbitfun.input-fixture.target");
    assert_eq!(
        initial_observer["bundle_id"],
        "dev.openbitfun.input-fixture.observer"
    );
    let baseline_activations = initial_observer["activation_history"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(initial_observer["target_ahead"], false);
    let foreground = crate::computer_use::macos_bg_input::frontmost_pid_macos();
    assert_ne!(foreground, Some(pid));
    assert_eq!(initial["active"], false);
    let host = Arc::new(DesktopComputerUseHost::new());
    let mut context = ToolUseContext::for_tool_listing(None, None);
    context.session_id = Some(OWNER.into());
    context.computer_use_host = Some(host.clone());
    context.primary_model_facts.supports_image_inputs = true;
    context.primary_model_facts.api_format = "anthropic".into();
    let tool = ComputerUseTool::new();
    let _cleanup = StopOnExit;
    if std::env::var_os("OPENBITFUN_INPUT_FOREGROUND").is_some() {
        let app = json!({"pid":pid,"window_id":initial["window_id"]});
        call(&tool, &context, json!({"action":"get_app_state","app":app})).await;
        let background = host.control_snapshot();
        call(
            &tool,
            &context,
            json!({"action":"start_control","mode":"foreground"}),
        )
        .await;
        assert_eq!(host.control_snapshot().target, background.target);
        assert_ne!(host.control_snapshot().generation, background.generation);
        let wrong_focus = tool
            .call_impl(
                &json!({"action":"type_text","text":"must-not-reach-observer","app":app}),
                &context,
            )
            .await
            .unwrap_err();
        assert!(
            wrong_focus
                .to_string()
                .contains("FOREGROUND_TARGET_MISMATCH"),
            "{wrong_focus}"
        );
        let active = call(&tool, &context, json!({"action":"activate_app","app":app})).await;
        assert_eq!(active["activated"], true);
        assert_eq!(
            crate::computer_use::macos_bg_input::frontmost_pid_macos(),
            Some(pid)
        );
        let field = observed_node_index(&active, "fixture-text-field");
        call(&tool, &context, json!({"action":"app_type_text","app":app,"text":"foreground","focus":{"kind":"node_idx","idx":field}})).await;
        call(
            &tool,
            &context,
            json!({"action":"type_text","app":app,"text":"✓"}),
        )
        .await;
        call(
            &tool,
            &context,
            json!({"action":"key_chord","app":app,"keys":["command","shift","k"]}),
        )
        .await;
        let after = call(&tool, &context, json!({"action":"get_app_state","app":app})).await;
        assert!(after["app_state"]["tree_text"]
            .as_str()
            .unwrap()
            .contains("foreground✓"));
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(read(&path)["field_text"], "foreground✓");
        assert_eq!(read(&path)["shortcut_actions"], 1);
        assert_eq!(read(&path)["foreign_actions"], 0);
        assert!(read(&observer_path)["input_events"]
            .as_array()
            .unwrap()
            .is_empty());
        call(&tool, &context, json!({"action":"stop_control"})).await;
        eprintln!("PASS foreground recovery retains exact target, rejects wrong focus, activates once and delivers Unicode/shortcut only to the fixture");
        return;
    }
    call(
        &tool,
        &context,
        json!({"action":"start_control","mode":"background"}),
    )
    .await;
    assert_eq!(host.control_snapshot().state, "active");
    assert!(host.control_snapshot().sharing.is_none());
    let opened = call(
        &tool,
        &context,
        json!({
            "action":"open_app", "app_name":"dev.openbitfun.input-fixture.target"
        }),
    )
    .await;
    assert_eq!(opened["success"], true);
    assert_eq!(opened["process_id"], pid);
    assert_eq!(
        crate::computer_use::macos_bg_input::frontmost_pid_macos(),
        foreground
    );
    let opened_by_path = call(
        &tool,
        &context,
        json!({"action":"open_app", "app_name":std::env::var("OPENBITFUN_INPUT_FIXTURE_APP").unwrap()}),
    )
    .await;
    assert_eq!(opened_by_path["success"], true);
    assert_eq!(opened_by_path["process_id"], pid);
    assert_eq!(opened_by_path["launch_path"], "open_background");
    assert_eq!(
        crate::computer_use::macos_bg_input::frontmost_pid_macos(),
        foreground
    );
    let observation = call(
        &tool,
        &context,
        json!({"action":"get_app_state","app":{"pid":pid}}),
    )
    .await;
    let visual_id = observation["app_state"]["observation_id"].as_str().unwrap();
    let ax_only = call_observation(
        &tool,
        &context,
        json!({"action":"get_app_state","app":{"pid":pid},"include_image":false}),
    )
    .await;
    let ax_id = assert_app_observation(&ax_only, false, Some(visual_id));
    assert!(host.validate_observation(visual_id).is_err());
    let button_idx = observed_node_index(&ax_only.data, "Count one action");
    let ax_click = call_observation(
        &tool,
        &context,
        json!({"action":"app_click","app":{"pid":pid},"include_image":false,
            "observation_id":ax_id,"target":{"kind":"node_idx","idx":button_idx}}),
    )
    .await;
    let ax_click_id = assert_app_observation(&ax_click, false, Some(&ax_id));
    assert_eq!(ax_click.data["completed_steps"], 1);
    assert_eq!(
        read(&path)["button_actions"],
        1,
        "AX-only node must deliver the semantic action exactly once"
    );
    assert_eq!(read(&path)["events"].as_array().unwrap().len(), 0);
    let restored = call_observation(
        &tool,
        &context,
        json!({"action":"get_app_state","app":{"pid":pid}}),
    )
    .await;
    assert_app_observation(&restored, true, Some(&ax_click_id));
    let observation = restored.data;
    eprintln!("PASS AX-only observations retain fresh actionable node identities and default observation restores pixels");
    eprintln!(
        "After initial observation frontmost={:?} observer={}",
        crate::computer_use::macos_bg_input::frontmost_pid_macos(),
        read(&observer_path)
    );
    // Reading an all-window AX snapshot is allowed, but input cannot escape
    // the captured window via a same-pid node or its coordinate fallback.
    {
        let mut lease = crate::computer_use::control_session::acquire(OWNER, "app_click").unwrap();
        let snapshot =
            crate::computer_use::macos_ax_dump::dump_app_ax(pid, Default::default()).unwrap();
        let foreign = snapshot
            .nodes
            .iter()
            .find(|node| node.title.as_deref() == Some("Unbound semantic action"))
            .expect("second-window control missing");
        let target =
            crate::computer_use::macos_ax_dump::retained_cached_target(pid, foreign.idx).unwrap();
        assert!(
            crate::computer_use::macos_ax_dump::validate_bound_target(pid, target.reference())
                .is_err()
        );
        assert!(matches!(
            crate::computer_use::macos_ax_write::try_ax_press(target.reference()),
            crate::computer_use::macos_ax_write::AxWriteOutcome::Unavailable(_)
        ));
        assert_eq!(read(&path)["foreign_actions"], 0);
        lease.complete();
        eprintln!("PASS same-process unbound AX window cannot receive semantic input or a pointer fallback");
    }
    let image_target = |observation: &Value, name: &str| {
        let meta = &observation["app_state"]["screenshot_meta"];
        let global = &meta["image_global_bounds"];
        let content = &meta["image_content_rect"];
        let p = &initial["targets"][name];
        let x = content["left"].as_f64().unwrap()
            + (p[0].as_f64().unwrap() - global["left"].as_f64().unwrap())
                * content["width"].as_f64().unwrap()
                / global["width"].as_f64().unwrap();
        let y = content["top"].as_f64().unwrap()
            + (p[1].as_f64().unwrap() - global["top"].as_f64().unwrap())
                * content["height"].as_f64().unwrap()
                / global["height"].as_f64().unwrap();
        json!({"kind":"image_xy","x":x.round() as i32,"y":y.round() as i32,"screenshot_id":meta["screenshot_id"]})
    };
    if std::env::var_os("OPENBITFUN_INPUT_BUSY_AX").is_some() {
        // Pause only the disposable fixture, after observing its exact window.
        // The real AX IPC must time out; no mock alters the production query.
        // Resume independently even if the tool panics, so cleanup cannot leave
        // a stopped process. A semantic-only result fails the raw-event checks.
        assert_eq!(unsafe { libc::kill(pid, libc::SIGSTOP) }, 0);
        struct ResumeFixture(i32);
        impl Drop for ResumeFixture {
            fn drop(&mut self) {
                unsafe {
                    libc::kill(self.0, libc::SIGCONT);
                }
            }
        }
        let _resume_on_error = ResumeFixture(pid);
        let resumed = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1200));
            unsafe {
                libc::kill(pid, libc::SIGCONT);
            }
        });
        let result = call(
            &tool,
            &context,
            json!({
                "action":"app_click", "app":{"pid":pid},
                "target":image_target(&observation,"button")
            }),
        )
        .await;
        resumed.join().unwrap();
        assert_eq!(result["completed_steps"], 1, "{result}");
        for _ in 0..25 {
            if read(&path)["button_actions"] == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let target = read(&path);
        assert_eq!(
            target["button_actions"], 2,
            "busy-app input must arrive exactly once"
        );
        let events = target["events"].as_array().unwrap();
        let content_events: Vec<_> = events
            .iter()
            .filter(|event| event["outside_frame"] == false)
            .collect();
        assert_eq!(
            content_events.len(),
            2,
            "the timed-out read must select one pointer down/up, never replay AXPress: {target}"
        );
        assert_eq!(content_events[0]["type"], 1);
        assert_eq!(content_events[1]["type"], 2);
        assert_eq!(target["foreign_actions"], 0);
        assert_eq!(
            crate::computer_use::macos_bg_input::frontmost_pid_macos(),
            foreground
        );
        let observer = read(&observer_path);
        assert_eq!(observer["active"], true);
        assert_eq!(observer["key_window"], true);
        assert_eq!(observer["target_ahead"], false);
        assert_eq!(observer["cursor"], initial_observer["cursor"]);
        assert_eq!(
            observer["activation_history"].as_array().unwrap().len(),
            baseline_activations
        );
        call(&tool, &context, json!({"action":"stop_control"})).await;
        eprintln!("PASS real AX messaging timeout retains one window-directed click without foreground takeover or replay");
        return;
    }
    eprintln!(
        "Before image button: observer={} frontmost={:?}",
        read(&observer_path),
        crate::computer_use::macos_bg_input::frontmost_pid_macos()
    );
    let observation = call(&tool, &context, json!({"action":"app_click","app":{"pid":pid},"target":image_target(&observation,"button")})).await;
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    let button_state = read(&path);
    let button_observer = read(&observer_path);
    eprintln!("After image button: target={button_state} observer={button_observer} frontmost={:?} expected={foreground:?}", crate::computer_use::macos_bg_input::frontmost_pid_macos());
    assert_eq!(button_state["button_actions"], 2);
    assert_eq!(
        button_state["events"].as_array().unwrap().len(),
        0,
        "image-coordinate button activation must use AXPress, not a raw mouse event"
    );
    assert_eq!(button_state["active"], false);
    assert_eq!(button_state["key_window"], false);
    assert_eq!(button_observer["active"], true);
    assert_eq!(button_observer["key_window"], true);
    assert_eq!(button_observer["target_ahead"], false);
    assert_eq!(
        crate::computer_use::macos_bg_input::frontmost_pid_macos(),
        foreground
    );
    eprintln!("PASS production ImageXy button activation exactly once without raw pointer events or raising the target");
    let field_target = image_target(&observation, "field");
    let result = call(
        &tool,
        &context,
        json!({"action":"app_batch","app":{"pid":pid},"steps":[
            {"action":"app_type_text","text":"native-control","focus":field_target},
            {"action":"app_type_text","text":"🙂中文","focus":field_target}
        ]}),
    )
    .await;
    assert_eq!(result["completed_steps"], 2, "{result}");
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    let state = read(&path);
    let observer = read(&observer_path);
    eprintln!("TRACE production ImageXy semantic focus: target={state} observer={observer} frontmost={:?}", crate::computer_use::macos_bg_input::frontmost_pid_macos());
    assert_eq!(state["field_text"], "native-control🙂中文");
    assert_eq!(
        state["events"].as_array().unwrap().len(),
        0,
        "semantic focus must send zero pointer events"
    );
    assert_eq!(state["active"], false);
    assert_eq!(state["key_window"], false);
    assert_eq!(observer["active"], true);
    assert_eq!(observer["key_window"], true);
    assert_eq!(observer["target_ahead"], false);
    assert_eq!(
        crate::computer_use::macos_bg_input::frontmost_pid_macos(),
        foreground
    );
    let result = call(&tool, &context, json!({"action":"app_scroll","app":{"pid":pid},"dx":0,"dy":42,"focus":image_target(&result,"canvas")})).await;
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    let scrolled = read(&path);
    let scroll_observer = read(&observer_path);
    eprintln!("TRACE targeted scroll: target={scrolled} observer={scroll_observer}");
    assert_eq!(
        scrolled["canvas_scrolls"], 1,
        "scroll must reach the canvas exactly once"
    );
    assert!(scrolled["canvas_scroll_y"].as_f64().unwrap().abs() > 0.0);
    assert_eq!(scrolled["canvas_downs"], 0);
    assert_eq!(scrolled["button_actions"], 2);
    assert_eq!(scrolled["events"].as_array().unwrap().len(), 0);
    assert_eq!(scrolled["active"], false);
    assert_eq!(scrolled["key_window"], false);
    assert_eq!(scroll_observer["active"], true);
    assert_eq!(scroll_observer["key_window"], true);
    assert_eq!(scroll_observer["target_ahead"], false);
    assert_eq!(
        crate::computer_use::macos_bg_input::frontmost_pid_macos(),
        foreground
    );
    eprintln!("PASS scroll anchor delivers canvas scrolling without a click or foreground change");
    // A canvas has no semantic text node. Explicit image focus must now use
    // the window-addressed input path, never type into the previous editor.
    let canvas_result = call(
        &tool,
        &context,
        json!({"action":"app_batch","app":{"pid":pid},"steps":[
            {"action":"app_click","target":image_target(&result,"canvas")},
            {"action":"app_type_text","text":"canvas"},
            {"action":"app_key_chord","keys":["command","shift","k"]},
            {"action":"app_scroll","dx":0,"dy":8,"focus":image_target(&result,"canvas")},
            {"action":"app_type_text","text":"🙂"}
        ]}),
    )
    .await;
    assert_eq!(canvas_result["completed_steps"], 5, "{canvas_result}");
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    let state = read(&path);
    assert_eq!(state["field_text"], "native-control🙂中文");
    assert_eq!(state["canvas_text"], "canvas🙂");
    assert_eq!(state["shortcut_actions"], 1);
    assert_eq!(state["canvas_scrolls"], 2);
    assert_eq!(state["canvas_downs"], 1);
    assert_eq!(state["canvas_command_downs"], 0);
    assert_eq!(state["button_actions"], 2);
    let events = state["events"].as_array().unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|e| e["hit"] == "OBFPlainCanvas" && e["type"] == 1)
            .count(),
        1
    );
    assert!(events
        .iter()
        .filter(|e| e["outside_frame"] == true)
        .all(|e| e["hit"] == "none" && e["flags"] == 0));
    let before_stop_observer = read(&observer_path);
    eprintln!(
        "TRACE after canvas batch: observer={before_stop_observer} foreground={:?}",
        crate::computer_use::macos_bg_input::frontmost_pid_macos()
    );
    assert_eq!(before_stop_observer["active"], true);
    assert_eq!(before_stop_observer["key_window"], true);
    assert_eq!(before_stop_observer["target_ahead"], false);
    assert_eq!(
        crate::computer_use::macos_bg_input::frontmost_pid_macos(),
        foreground
    );
    eprintln!(
        "PASS non-AX canvas receives one unmodified click and text without foreground change"
    );
    let focus_event_count = |value: &Value| {
        value["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["outside_frame"] == true)
            .count()
    };
    assert_eq!(
        focus_event_count(&state),
        2,
        "one initial focus pair must serve the entire batch"
    );
    // Induce a real target-local deactivation without changing the global
    // foreground. The next ordinary Tool input must notice the stale local
    // focus and prepare it again, preserving the original first responder.
    let identity = crate::computer_use::macos_skylight::process_identity(pid).unwrap();
    assert!(crate::computer_use::macos_skylight::set_local_activation(
        identity,
        initial["window_id"].as_u64().unwrap() as u32,
        false
    ));
    for _ in 0..25 {
        if read(&path)["active"] == false {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(
        read(&path)["active"],
        false,
        "fixture must really lose local focus"
    );
    assert_eq!(
        crate::computer_use::macos_bg_input::frontmost_pid_macos(),
        foreground
    );
    let recovered = call(
        &tool,
        &context,
        json!({"action":"app_type_text","app":{"pid":pid},"text":"recovered"}),
    )
    .await;
    assert_eq!(recovered["completed_steps"], 1, "{recovered}");
    let recovered_state = read(&path);
    assert_eq!(recovered_state["canvas_text"], "canvas🙂recovered");
    assert_eq!(recovered_state["field_text"], "native-control🙂中文");
    assert_eq!(recovered_state["canvas_downs"], 1);
    assert_eq!(focus_event_count(&recovered_state), 4);
    eprintln!("PASS target-local focus loss invalidates cached preparation without global activation or a repeated content click");
    // Human preview input uses a separate host instance but the same native
    // sharing resource, lease and background guard as the Agent.
    // Exercise that optional API separately, after the entire Agent task has
    // completed without a share selection or per-application grant.
    select_and_grant_fixture(&host, pid, initial["window_id"].as_u64()).await;
    use crate::computer_use::shared_preview::{self, SharedInputRequest, SharedPreviewRequest};
    let shared = host.control_snapshot();
    let scope = || SharedPreviewRequest {
        generation: shared.generation,
        target_revision: shared.target_revision,
        authorization_revision: shared.sharing.as_ref().unwrap().authorization_revision,
    };
    shared_preview::observe(scope()).await.unwrap();
    shared_preview::input(SharedInputRequest {
        scope: scope(),
        input: openbitfun_core::agentic::tools::computer_use_host::AppInputAction::KeyChord {
            keys: vec!["escape".into()],
            focus_idx: None,
        },
    })
    .await
    .unwrap();
    shared_preview::observe(scope()).await.unwrap();
    assert_eq!(read(&path)["canvas_escape_presses"], 1);
    crate::computer_use::control_session::set_share_control(
        shared.generation,
        shared.target_revision,
        shared.sharing.as_ref().unwrap().authorization_revision,
        false,
    )
    .unwrap();
    assert!(shared_preview::input(SharedInputRequest {
        scope: scope(),
        input: openbitfun_core::agentic::tools::computer_use_host::AppInputAction::KeyChord {
            keys: vec!["escape".into()],
            focus_idx: None,
        },
    })
    .await
    .unwrap_err()
    .contains("CONTROL_STALE"));
    assert!(!host.control_snapshot().sharing.unwrap().control_enabled);
    eprintln!(
        "PASS native preview input shares the Agent lease; revocation rejects stale preview work"
    );
    call(&tool, &context, json!({"action":"stop_control"})).await;
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    let final_observer = read(&observer_path);
    assert_eq!(
        read(&path)["canvas_escape_presses"],
        1,
        "revoked preview input must not be delivered"
    );
    assert_eq!(
        read(&path)["active"],
        false,
        "Stop must clear target-local activation"
    );
    eprintln!(
        "TRACE after stop: observer={final_observer} target={} foreground={:?}",
        read(&path),
        crate::computer_use::macos_bg_input::frontmost_pid_macos()
    );
    assert_eq!(final_observer["active"], true);
    assert_eq!(final_observer["key_window"], true);
    assert_eq!(final_observer["target_ahead"], false);
    assert_eq!(
        crate::computer_use::macos_bg_input::frontmost_pid_macos(),
        foreground
    );
    assert!(
        final_observer["activation_history"]
            .as_array()
            .unwrap()
            .iter()
            .skip(baseline_activations)
            .all(|event| event["pid"].as_i64().map(|pid| pid as i32) == foreground),
        "foreground must not switch away and back between samples: {final_observer}"
    );
    eprintln!("PASS independent app bundles preserve foreground across all semantic actions and stop: {final_observer}");
}

/// Identical native input sequence in a fresh target/observer process per case.
/// Tool execution and one immediate native-effect check are timed; startup,
/// recovery and cleanup are excluded. No model is invoked by this fixture.
async fn run_latency_case(case: &str) {
    let (batched, include_image) = match case {
        "singles:default" => (false, true),
        "batch:default" => (true, true),
        "singles:ax" => (false, false),
        "batch:ax" => (true, false),
        _ => panic!("Unknown native latency fixture case: {case}"),
    };
    let pid: i32 = std::env::var("OPENBITFUN_INPUT_FIXTURE_PID")
        .unwrap()
        .parse()
        .unwrap();
    let path = std::env::var("OPENBITFUN_INPUT_FIXTURE_RESULT").unwrap();
    let observer_path = std::env::var("OPENBITFUN_INPUT_OBSERVER_RESULT").unwrap();
    let read = |path: &str| -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    };
    let observer = wait_for_observer(&observer_path).await;
    let foreground = crate::computer_use::macos_bg_input::frontmost_pid_macos();
    assert_ne!(foreground, Some(pid));
    assert_eq!(observer["target_ahead"], false);
    assert_eq!(read(&path)["field_text"], "");
    let host = Arc::new(DesktopComputerUseHost::new());
    let mut context = ToolUseContext::for_tool_listing(None, None);
    context.session_id = Some(OWNER.into());
    context.computer_use_host = Some(host.clone());
    context.primary_model_facts.supports_image_inputs = true;
    context.primary_model_facts.api_format = "anthropic".into();
    let tool = ComputerUseTool::new();
    let _cleanup = StopOnExit;
    call(
        &tool,
        &context,
        json!({"action":"start_control","mode":"background"}),
    )
    .await;
    let with_policy = |mut input: Value| {
        // Deliberately omit the field for the compatibility/default cases.
        if !include_image {
            input["include_image"] = json!(false);
        }
        input
    };
    let initial = call_observation(
        &tool,
        &context,
        with_policy(json!({"action":"get_app_state","app":{"pid":pid}})),
    )
    .await;
    let mut observation_id = assert_app_observation(&initial, include_image, None);
    let initial_nodes = initial.data["app_state"]["node_count"].clone();
    let mut current = initial.data;
    let control = host.control_snapshot();
    let target = control.target.as_deref().expect("fixture capture target");
    let make_steps = |observation: &Value| {
        let idx = observed_node_index(observation, "fixture-text-field");
        let text = |value: &str| {
            json!({"action":"app_type_text","text":value,
            "focus":{"kind":"node_idx","idx":idx}})
        };
        vec![
            text("speed"),
            text("✓"),
            json!({"action":"app_key_chord","keys":["command","shift","k"]}),
            text("中文"),
            text("🙂"),
        ]
    };
    let mut returned_observations = Vec::new();
    let mut input_count = 0;
    let started = std::time::Instant::now();
    let calls = if batched { 1 } else { 5 };
    for index in 0..calls {
        let steps = make_steps(&current);
        let mut input = if batched {
            json!({"action":"app_batch","steps":steps})
        } else {
            steps[index].clone()
        };
        input["app"] = json!({"pid":pid});
        input["observation_id"] = json!(observation_id);
        let result = call_observation(&tool, &context, with_policy(input)).await;
        observation_id = assert_app_observation(&result, include_image, Some(&observation_id));
        assert_eq!(result.data["status"], "submitted");
        let completed = result.data["completed_steps"].as_u64().unwrap();
        assert_eq!(completed, if batched { 5 } else { 1 });
        input_count += completed;
        returned_observations.push(json!({
            "observation_id":observation_id,
            "node_count":result.data["app_state"]["node_count"],
            "image_count":result.image_count
        }));
        current = result.data;
    }
    let verification_started = std::time::Instant::now();
    let immediate_native = read(&path);
    assert_eq!(
        immediate_native["shortcut_actions"], 1,
        "the fixture shortcut must already have executed before any recovery read or wait"
    );
    let sidecar_verification_ms = verification_started.elapsed().as_secs_f64() * 1000.0;
    let duration_ms = started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(input_count, 5);
    assert_eq!(returned_observations.len(), calls);
    assert_session(&host, control.generation, target, foreground);
    let final_field = current["app_state"]["tree_text"]
        .as_str()
        .expect("final input response contains its AX tree")
        .lines()
        .find(|line| line.contains("fixture-text-field"))
        .expect("final input response contains the observed text field");
    assert!(
        final_field.contains("value=\"speed✓中文🙂\""),
        "the returned observation itself must expose the completed text before any recovery read or wait: {final_field}"
    );
    // A read-only default request must recover pixels after the AX-only run.
    let recovery = call_observation(
        &tool,
        &context,
        json!({"action":"get_app_state","app":{"pid":pid}}),
    )
    .await;
    assert_app_observation(&recovery, true, Some(&observation_id));
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    let native = read(&path);
    let after = read(&observer_path);
    assert_eq!(native["field_text"], "speed✓中文🙂");
    assert_eq!(native["shortcut_actions"], 1);
    assert_eq!(native["button_actions"], 0);
    assert_eq!(native["canvas_text"], "");
    assert_eq!(native["canvas_downs"], 0);
    assert_eq!(native["foreign_actions"], 0);
    assert!(native["events"]
        .as_array()
        .unwrap()
        .iter()
        .all(|event| event["outside_frame"] == true
            && event["hit"] == "none"
            && event["flags"] == 0));
    assert_eq!(after["active"], true);
    assert_eq!(after["key_window"], true);
    assert_eq!(after["target_ahead"], false);
    assert_eq!(after["cursor"], after["ready_cursor"]);
    call(&tool, &context, json!({"action":"stop_control"})).await;
    // The runner additionally checks transient observer deactivation, exact
    // target window routing, physical cursor and input delivered to the observer.
    eprintln!(
        "CUA_NATIVE_LATENCY {}",
        json!({
            "case":case,"duration_ms":duration_ms,"input_steps":input_count,
            "sidecar_verification_ms":sidecar_verification_ms,
            "tool_calls":calls,"returned_observation_count":returned_observations.len(),
            "returned_image_count":returned_observations.iter().map(|v| v["image_count"].as_u64().unwrap()).sum::<u64>(),
            "initial_node_count":initial_nodes,"observations":returned_observations,
            "verification":"exact native text and shortcut count; foreground and cursor preserved",
            "scope":"local macOS native tool execution plus one immediate fixture JSON check; excludes startup and model inference"
        })
    );
}
