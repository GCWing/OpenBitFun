/**
 * Factory that generates the element-inspector script to be eval()'d inside a
 * Tauri native Webview.
 *
 * When injected, the script:
 *  1. Adds a semi-transparent blue highlight overlay over the hovered element.
 *  2. Shows a small tooltip with the element's tag/id/class info.
 *  3. On click, captures: tagName, CSS path, attributes, textContent, outerHTML.
 *  4. Emits a Tauri event `browser-inspector-element-selected-{label}` with the
 *     captured data so the host React component can receive it.
 *  5. Pressing Escape cancels inspection and emits
 *     `browser-inspector-cancelled-{label}`.
 *  6. Exposes `window.__openbitfun_inspector_cancel` so a second eval call can
 *     programmatically cancel an active session.
 */
import { INSPECTOR_OVERLAY_THEME } from '@/shared/inspector/inspectorOverlayTheme';
import { tokens as designTokens } from '@openbitfun/design-tokens';

const INSPECTOR_MONO_FONT = String(designTokens['font.family.mono']).split("'").join("\\'");

const INSPECTOR_SCRIPT_BODY = /* js */ `
(function () {
  if (window.__openbitfun_inspector_active) {
    window.__openbitfun_inspector_cancel && window.__openbitfun_inspector_cancel();
    return;
  }
  window.__openbitfun_inspector_active = true;

  var LABEL = window.__openbitfun_inspector_label || '';
  var EVENT_SELECTED = 'browser-inspector-element-selected-' + LABEL;
  var EVENT_CANCELLED = 'browser-inspector-cancelled-' + LABEL;

  // ── overlay element ──────────────────────────────────────────────────────
  var overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed',
    'border:2px solid ${INSPECTOR_OVERLAY_THEME.activeBorder}',
    'background:${INSPECTOR_OVERLAY_THEME.activeBackground}',
    'pointer-events:none',
    'z-index:2147483646',
    'box-sizing:border-box',
    'display:none',
    'border-radius:2px',
    'transition:top 0.05s,left 0.05s,width 0.05s,height 0.05s',
  ].join(';');

  // ── tooltip element ──────────────────────────────────────────────────────
  var tooltip = document.createElement('div');
  tooltip.style.cssText = [
    'position:fixed',
    'background:${INSPECTOR_OVERLAY_THEME.browserTooltipBackground}',
    'color:${INSPECTOR_OVERLAY_THEME.tooltipText}',
    'padding:3px 8px',
    'border-radius:4px',
    'font-size:${designTokens['font.size.xs']}',
    'font-family:${INSPECTOR_MONO_FONT}',
    'z-index:2147483647',
    'pointer-events:none',
    'display:none',
    'max-width:480px',
    'white-space:nowrap',
    'box-shadow:0 2px 8px ${INSPECTOR_OVERLAY_THEME.tooltipShadow}',
    'line-height:${designTokens['lineHeight.relaxed']}',
  ].join(';');

  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(tooltip);

  var hoveredEl = null;

  // ── helpers ───────────────────────────────────────────────────────────────
  function cssPath(el) {
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      var seg = cur.tagName.toLowerCase();
      if (cur.id) {
        try { seg += '#' + CSS.escape(cur.id); } catch (e) { seg += '#' + cur.id; }
        parts.unshift(seg);
        break;
      }
      if (cur.parentElement) {
        var siblings = Array.prototype.filter.call(
          cur.parentElement.children,
          function (s) { return s.tagName === cur.tagName; }
        );
        if (siblings.length > 1) {
          seg += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
        }
      }
      var classes = Array.prototype.slice.call(cur.classList, 0, 3).join('.');
      if (classes) seg += '.' + classes;
      parts.unshift(seg);
      cur = cur.parentElement;
    }
    return parts.join(' > ') || 'html';
  }

  function getAttrs(el) {
    var attrs = {};
    for (var i = 0; i < el.attributes.length; i++) {
      attrs[el.attributes[i].name] = el.attributes[i].value;
    }
    return attrs;
  }

  function tooltipText(el) {
    var tag = el.tagName.toLowerCase();
    var id = el.id ? '#' + el.id : '';
    var cls = el.classList.length
      ? '.' + Array.prototype.slice.call(el.classList, 0, 3).join('.')
      : '';
    return tag + id + cls;
  }

  function updateOverlay(el) {
    if (!el) {
      overlay.style.display = 'none';
      tooltip.style.display = 'none';
      return;
    }
    var rect = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.top = rect.top + 'px';
    overlay.style.left = rect.left + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';

    tooltip.textContent = tooltipText(el);
    tooltip.style.display = 'block';
    var ty = rect.top - 26;
    if (ty < 4) ty = rect.bottom + 4;
    var tx = rect.left;
    if (tx + 200 > window.innerWidth) tx = window.innerWidth - 204;
    if (tx < 4) tx = 4;
    tooltip.style.top = ty + 'px';
    tooltip.style.left = tx + 'px';
  }

  function emitTauri(eventName, payload) {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals) return;
    try {
      if (typeof internals.invoke === 'function') {
        internals.invoke('plugin:event|emit', { event: eventName, payload: payload }).catch(function () {});
      }
    } catch (e) {}
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  function cleanup() {
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    try { overlay.parentNode && overlay.parentNode.removeChild(overlay); } catch (e) {}
    try { tooltip.parentNode && tooltip.parentNode.removeChild(tooltip); } catch (e) {}
    delete window.__openbitfun_inspector_active;
    delete window.__openbitfun_inspector_cancel;
    delete window.__openbitfun_inspector_label;
  }

  // ── event handlers ────────────────────────────────────────────────────────
  function onMouseOver(e) {
    var el = e.target;
    if (el === overlay || el === tooltip) return;
    hoveredEl = el;
    updateOverlay(el);
  }

  function onClick(e) {
    if (!hoveredEl) return;
    e.preventDefault();
    e.stopPropagation();

    var data = {
      tagName: hoveredEl.tagName.toLowerCase(),
      path: cssPath(hoveredEl),
      attributes: getAttrs(hoveredEl),
      textContent: (hoveredEl.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
      outerHTML: (hoveredEl.outerHTML || '').slice(0, 2000),
    };

    emitTauri(EVENT_SELECTED, data);

    overlay.style.borderColor = '${INSPECTOR_OVERLAY_THEME.selectedBorder}';
    overlay.style.background = '${INSPECTOR_OVERLAY_THEME.selectedBackground}';
    setTimeout(function () {
      overlay.style.borderColor = '${INSPECTOR_OVERLAY_THEME.activeBorder}';
      overlay.style.background = '${INSPECTOR_OVERLAY_THEME.activeBackground}';
    }, 300);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      emitTauri(EVENT_CANCELLED, null);
      cleanup();
    }
  }

  window.__openbitfun_inspector_cancel = function () {
    emitTauri(EVENT_CANCELLED, null);
    cleanup();
  };

  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
})();
`;

/**
 * Returns the JavaScript string to eval() inside the Tauri embedded webview.
 *
 * @param webviewLabel  The label of the webview whose events should be listened to.
 */
export function createInspectorScript(webviewLabel: string): string {
  // Inject the label as a global before the IIFE runs.
  return `window.__openbitfun_inspector_label = ${JSON.stringify(webviewLabel)};\n${INSPECTOR_SCRIPT_BODY}`;
}

/** Script to cancel an active inspector session without triggering a selection. */
export const CANCEL_INSPECTOR_SCRIPT =
  `if (window.__openbitfun_inspector_cancel) { window.__openbitfun_inspector_cancel(); }`;

/**
 * Script injected into the webview to intercept `target="_blank"` link clicks
 * and navigate in-place instead (Tauri webviews cannot open new windows).
 * Re-injected after every page load since full navigations destroy JS state.
 */
export { default as BLANK_TARGET_INTERCEPT_SCRIPT } from '../../../../../shared/browser/blankTargetIntercept.js?raw';
