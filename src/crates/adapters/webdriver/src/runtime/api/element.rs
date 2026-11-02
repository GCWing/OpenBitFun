use std::sync::Arc;

use serde_json::Value;

use crate::runtime::run_script;
use crate::server::response::WebDriverErrorResponse;
use crate::server::AppState;

pub(crate) fn find_elements() -> &'static str {
    "(rootId, using, value) => window.__openbitfunWd.findElements(rootId, using, value)"
}

pub(crate) fn active_element() -> &'static str {
    "() => document.activeElement"
}

pub(crate) fn is_selected() -> &'static str {
    "(id) => { const el = window.__openbitfunWd.getElement(id); return !!el && !!(el.selected || el.checked); }"
}

pub(crate) fn is_displayed() -> &'static str {
    "(id) => { const el = window.__openbitfunWd.getElement(id); return window.__openbitfunWd.isDisplayed(el); }"
}

pub(crate) fn get_attribute() -> &'static str {
    "(id, name) => { const el = window.__openbitfunWd.getElement(id); if (!el) { return null; } const attrName = String(name || '').toLowerCase(); const tagName = String(el.tagName || '').toLowerCase(); if (attrName === 'value' && (tagName === 'input' || tagName === 'textarea')) { return el.value; } if (attrName === 'checked' && tagName === 'input' && (el.type === 'checkbox' || el.type === 'radio')) { return el.checked ? 'true' : null; } if (attrName === 'selected' && tagName === 'option') { return el.selected ? 'true' : null; } return el.getAttribute(name); }"
}

pub(crate) fn get_property() -> &'static str {
    "(id, name) => { const el = window.__openbitfunWd.getElement(id); return el ? el[name] : null; }"
}

pub(crate) fn get_css_value() -> &'static str {
    "(id, propertyName) => { const el = window.__openbitfunWd.getElement(id); return el ? window.getComputedStyle(el).getPropertyValue(propertyName) : ''; }"
}

pub(crate) fn get_text() -> &'static str {
    "(id) => { const el = window.__openbitfunWd.getElement(id); return el ? (el.innerText ?? el.textContent ?? '') : ''; }"
}

pub(crate) fn get_computed_role() -> &'static str {
    "(id) => { const el = window.__openbitfunWd.getElement(id); if (!el) { return ''; } const explicitRole = el.getAttribute('role'); if (explicitRole) { return explicitRole; } const tag = String(el.tagName || '').toLowerCase(); if (tag === 'button') return 'button'; if (tag === 'a' && el.hasAttribute('href')) return 'link'; if (tag === 'input') { const type = String(el.getAttribute('type') || 'text').toLowerCase(); if (type === 'checkbox') return 'checkbox'; if (type === 'radio') return 'radio'; if (type === 'submit' || type === 'button' || type === 'reset') return 'button'; return 'textbox'; } if (tag === 'select') return 'combobox'; if (tag === 'textarea') return 'textbox'; return ''; }"
}

pub(crate) fn get_computed_label() -> &'static str {
    "(id) => { const el = window.__openbitfunWd.getElement(id); if (!el) { return ''; } const labelledBy = el.getAttribute('aria-labelledby'); if (labelledBy) { return labelledBy.split(/\\s+/).map((labelId) => document.getElementById(labelId)?.innerText?.trim() || '').filter(Boolean).join(' ').trim(); } const ariaLabel = el.getAttribute('aria-label'); if (ariaLabel) { return ariaLabel; } const htmlFor = el.id ? document.querySelector(`label[for=\"${el.id}\"]`) : null; if (htmlFor) { return (htmlFor.innerText || htmlFor.textContent || '').trim(); } return (el.innerText || el.textContent || el.getAttribute('value') || '').trim(); }"
}

pub(crate) fn get_name() -> &'static str {
    "(id) => { const el = window.__openbitfunWd.getElement(id); return el ? String(el.tagName || '').toLowerCase() : ''; }"
}

pub(crate) fn get_rect() -> &'static str {
    "(id) => { const el = window.__openbitfunWd.getElement(id); if (!el) { return null; } const rect = el.getBoundingClientRect(); return { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height, top: rect.top + window.scrollY, left: rect.left + window.scrollX, right: rect.right + window.scrollX, bottom: rect.bottom + window.scrollY }; }"
}

pub(crate) fn is_enabled() -> &'static str {
    "(id) => { const el = window.__openbitfunWd.getElement(id); return !!el && !el.disabled; }"
}

pub(crate) fn click() -> &'static str {
    "(id) => { const el = window.__openbitfunWd.getElement(id); if (!el) { throw new Error('Element not found'); } window.__openbitfunWd.dispatchPointerClick(el, 0, false); return null; }"
}

pub(crate) fn clear() -> &'static str {
    "(id) => { const el = window.__openbitfunWd.getElement(id); if (!el) { throw new Error('Element not found'); } window.__openbitfunWd.clearElement(el); return null; }"
}

pub(crate) fn send_keys() -> &'static str {
    "(id, text) => { const el = window.__openbitfunWd.getElement(id); if (!el) { throw new Error('Element not found'); } if ('value' in el || el.isContentEditable) { window.__openbitfunWd.scrollElementIntoView(el); window.__openbitfunWd.focusWithoutScroll(el); } window.__openbitfunWd.insertText(el, text); return null; }"
}

pub(crate) fn screenshot_metadata() -> &'static str {
    "(id) => { const el = window.__openbitfunWd.getElement(id); if (!el || !el.isConnected) { throw new Error('stale element reference'); } window.__openbitfunWd.scrollElementIntoView(el); const rect = el.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, devicePixelRatio: window.devicePixelRatio || 1 }; }"
}

pub(crate) fn get_shadow_root() -> &'static str {
    "(elementId) => window.__openbitfunWd.getShadowRoot(elementId)"
}

pub(crate) fn find_elements_from_shadow() -> &'static str {
    "(shadowId, using, value) => window.__openbitfunWd.findElementsFromShadow(shadowId, using, value)"
}

pub(crate) fn validate_frame_index() -> &'static str {
    "(index) => { if (!window.__openbitfunWd.validateFrameByIndex(index)) { throw new Error('Unable to locate frame'); } return true; }"
}

pub(crate) fn validate_frame_element() -> &'static str {
    "(elementId) => { if (!window.__openbitfunWd.validateFrameElement(elementId)) { throw new Error('Unable to locate frame'); } return true; }"
}

pub(crate) async fn exec_find_elements(
    state: Arc<AppState>,
    session_id: &str,
    root_element_id: Option<String>,
    using: &str,
    value: &str,
) -> Result<Vec<Value>, WebDriverErrorResponse> {
    let result = run_script(
        state,
        session_id,
        find_elements(),
        vec![
            root_element_id.map(Value::String).unwrap_or(Value::Null),
            Value::String(using.to_string()),
            Value::String(value.to_string()),
        ],
        false,
    )
    .await?;
    Ok(result.as_array().cloned().unwrap_or_default())
}

pub(crate) async fn exec_active_element(
    state: Arc<AppState>,
    session_id: &str,
) -> Result<Value, WebDriverErrorResponse> {
    run_script(state, session_id, active_element(), Vec::new(), false).await
}

pub(crate) async fn exec_element_flag(
    state: Arc<AppState>,
    session_id: &str,
    script: &str,
    element_id: &str,
) -> Result<Value, WebDriverErrorResponse> {
    run_script(
        state,
        session_id,
        script,
        vec![Value::String(element_id.to_string())],
        false,
    )
    .await
}

pub(crate) async fn exec_element_name_value(
    state: Arc<AppState>,
    session_id: &str,
    script: &str,
    element_id: &str,
    name: &str,
) -> Result<Value, WebDriverErrorResponse> {
    run_script(
        state,
        session_id,
        script,
        vec![
            Value::String(element_id.to_string()),
            Value::String(name.to_string()),
        ],
        false,
    )
    .await
}

pub(crate) async fn exec_element_value(
    state: Arc<AppState>,
    session_id: &str,
    script: &str,
    element_id: &str,
) -> Result<Value, WebDriverErrorResponse> {
    run_script(
        state,
        session_id,
        script,
        vec![Value::String(element_id.to_string())],
        false,
    )
    .await
}

pub(crate) async fn exec_element_action(
    state: Arc<AppState>,
    session_id: &str,
    script: &str,
    element_id: &str,
) -> Result<(), WebDriverErrorResponse> {
    run_script(
        state,
        session_id,
        script,
        vec![Value::String(element_id.to_string())],
        false,
    )
    .await?;
    Ok(())
}

pub(crate) async fn exec_element_text_action(
    state: Arc<AppState>,
    session_id: &str,
    element_id: &str,
    text: &str,
) -> Result<(), WebDriverErrorResponse> {
    run_script(
        state,
        session_id,
        send_keys(),
        vec![
            Value::String(element_id.to_string()),
            Value::String(text.to_string()),
        ],
        false,
    )
    .await?;
    Ok(())
}

pub(crate) async fn exec_screenshot_metadata(
    state: Arc<AppState>,
    session_id: &str,
    element_id: &str,
) -> Result<Value, WebDriverErrorResponse> {
    run_script(
        state,
        session_id,
        screenshot_metadata(),
        vec![Value::String(element_id.to_string())],
        false,
    )
    .await
}

pub(crate) async fn exec_find_elements_from_shadow(
    state: Arc<AppState>,
    session_id: &str,
    shadow_id: &str,
    using: &str,
    value: &str,
) -> Result<Vec<Value>, WebDriverErrorResponse> {
    let result = run_script(
        state,
        session_id,
        find_elements_from_shadow(),
        vec![
            Value::String(shadow_id.to_string()),
            Value::String(using.to_string()),
            Value::String(value.to_string()),
        ],
        false,
    )
    .await?;
    Ok(result.as_array().cloned().unwrap_or_default())
}

pub(crate) async fn exec_validate_frame_index(
    state: Arc<AppState>,
    session_id: &str,
    index: u32,
) -> Result<(), WebDriverErrorResponse> {
    run_script(
        state,
        session_id,
        validate_frame_index(),
        vec![Value::from(index)],
        false,
    )
    .await?;
    Ok(())
}

pub(crate) async fn exec_validate_frame_element(
    state: Arc<AppState>,
    session_id: &str,
    element_id: &str,
) -> Result<(), WebDriverErrorResponse> {
    run_script(
        state,
        session_id,
        validate_frame_element(),
        vec![Value::String(element_id.to_string())],
        false,
    )
    .await?;
    Ok(())
}
