mod core;
mod input;
mod keyboard;
mod pointer;

use serde_json::Value;

use crate::webdriver::FrameId;

pub(crate) fn serialize_frame_context(frame_context: &[FrameId]) -> Value {
    Value::Array(
        frame_context
            .iter()
            .map(|frame_id| match frame_id {
                FrameId::Index(index) => serde_json::json!({
                    "kind": "index",
                    "value": index
                }),
                FrameId::Element(element_id) => serde_json::json!({
                    "kind": "element",
                    "value": element_id
                }),
            })
            .collect(),
    )
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn build_bridge_eval_script(
    request_id: &str,
    script: &str,
    args: &[Value],
    async_mode: bool,
    frame_context: &Value,
) -> String {
    let request_id_json =
        serde_json::to_string(request_id).unwrap_or_else(|_| "\"invalid-request\"".into());
    let script_json = serde_json::to_string(script).unwrap_or_else(|_| "\"\"".into());
    let args_json = serde_json::to_string(args).unwrap_or_else(|_| "[]".into());
    let async_json = if async_mode { "true" } else { "false" };
    let frame_context_json = serde_json::to_string(frame_context).unwrap_or_else(|_| "[]".into());

    format!(
        r#"
(() => {{
  {helper}
  window.__openbitfunWd.run({request_id}, {script}, {args}, {async_mode}, {frame_context});
}})();
"#,
        helper = bridge_helper_script(),
        request_id = request_id_json,
        script = script_json,
        args = args_json,
        async_mode = async_json,
        frame_context = frame_context_json
    )
}

#[cfg(target_os = "macos")]
pub(crate) fn native_eval_script() -> &'static str {
    // Keep the wrapper source identical across calls. WebKit receives the user
    // script and data as native arguments, so changing a value does not compile
    // another copy of the entire bridge. User functions still execute afresh.
    static SCRIPT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SCRIPT.get_or_init(|| {
        format!(
            r#"
return (async () => {{
  {helper}
  const response = await window.__openbitfunWd.execute(
    openbitfunScript,
    JSON.parse(openbitfunArguments),
    openbitfunAsync === "true",
    JSON.parse(openbitfunFrameContext)
  );
  return JSON.stringify({{
    requestId: "__native__",
    ok: response.ok,
    value: response.value,
    error: response.error ?? null
  }});
}})();
"#,
            helper = bridge_helper_script()
        )
    })
}

fn bridge_helper_script() -> String {
    format!(
        r#"
if (!window.__openbitfunWd) {{
  window.__openbitfunWd = (() => {{
{core_head}
{input}
{keyboard}
{pointer}
{core_tail}
  }})();
}}
"#,
        core_head = core::head(),
        input = input::script(),
        keyboard = keyboard::script(),
        pointer = pointer::script(),
        core_tail = core::tail()
    )
}
