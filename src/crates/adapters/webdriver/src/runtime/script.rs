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

pub(crate) fn build_native_eval_script(
    script: &str,
    args: &[Value],
    async_mode: bool,
    frame_context: &Value,
) -> String {
    let script_json = serde_json::to_string(script).unwrap_or_else(|_| "\"\"".into());
    let args_json = serde_json::to_string(args).unwrap_or_else(|_| "[]".into());
    let async_json = if async_mode { "true" } else { "false" };
    let frame_context_json = serde_json::to_string(frame_context).unwrap_or_else(|_| "[]".into());

    format!(
        r#"
(async () => {{
  {helper}
  const response = await window.__openbitfunWd.execute({script}, {args}, {async_mode}, {frame_context});
  return {{
    ok: response.ok,
    value: response.value,
    error: response.error ?? null
  }};
}})();
"#,
        helper = bridge_helper_script(),
        script = script_json,
        args = args_json,
        async_mode = async_json,
        frame_context = frame_context_json
    )
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
