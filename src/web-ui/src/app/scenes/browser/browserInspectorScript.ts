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
const INSPECTOR_COLOR_FALLBACKS = {
  activeBorder: 'Highlight',
  activeBackground: 'color-mix(in srgb, Highlight 16%, transparent)',
  selectedBorder: 'Highlight',
  selectedBackground: 'color-mix(in srgb, Highlight 30%, transparent)',
  browserTooltipBackground: 'Canvas',
  tooltipText: 'CanvasText',
} as const;

const INSPECTOR_SCRIPT_BODY = /* js */ `
(function (LABEL, theme) {
  if (window.__openbitfun_inspector_active) {
    window.__openbitfun_inspector_cancel && window.__openbitfun_inspector_cancel();
    return;
  }
  window.__openbitfun_inspector_active = true;

  var EVENT_SELECTED = 'browser-inspector-element-selected-' + LABEL;
  var EVENT_CANCELLED = 'browser-inspector-cancelled-' + LABEL;

  // A manual popover stays above the page's own dialogs and transforms.
  var surface = document.createElement('div');
  surface.setAttribute('data-openbitfun-picker', '');
  surface.setAttribute('aria-hidden', 'true');
  surface.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;'
    + 'width:100%!important;height:100%!important;pointer-events:none!important;'
    + 'z-index:2147483647!important;overflow:hidden!important;';
  var root = surface.attachShadow({ mode: 'open' });
  var frames = document.createElement('div');
  var tooltip = document.createElement('div');
  tooltip.className = 'tooltip';
  tooltip.style.cssText = [
    'position:absolute',
    'pointer-events:none',
    'padding:3px 8px',
    'border-radius:4px',
    'max-width:calc(100% - 8px)',
    'overflow:hidden',
    'text-overflow:ellipsis',
    'white-space:nowrap',
    'font:${designTokens['font.size.xs']}/${designTokens['lineHeight.relaxed']} ${INSPECTOR_MONO_FONT}'
  ].join(';');
  tooltip.style.backgroundColor = theme.browserTooltipBackground;
  tooltip.style.color = theme.tooltipText;
  tooltip.hidden = true;
  root.append(frames, tooltip);
  document.documentElement.appendChild(surface);
  if (typeof surface.showPopover === 'function') {
    surface.setAttribute('popover', 'manual');
    try { surface.showPopover(); } catch (_) { surface.removeAttribute('popover'); }
  }
  var target = null;
  var selected = false;
  var boxes = [];
  var geometry = '';
  var animation = 0;

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

  function render() {
    animation = 0;
    var rects = target && target.isConnected
      ? Array.from(target.getClientRects()).filter(function (rect) { return rect.width > 0 && rect.height > 0; })
      : [];
    var nextGeometry = rects.map(function (rect) {
      return [rect.left, rect.top, rect.width, rect.height].join(',');
    }).join(';');
    var description = rects.length ? tooltipText(target) : '';
    var next = nextGeometry + '|' + description + '|' + selected;
    if (next !== geometry) {
      geometry = next;
      frames.className = selected ? 'selected' : '';
      while (boxes.length < rects.length) {
        var box = document.createElement('div');
        box.className = 'box';
        box.style.cssText = 'position:absolute;pointer-events:none;box-sizing:border-box;border:2px solid';
        frames.appendChild(box);
        boxes.push(box);
      }
      boxes.forEach(function (box, index) {
        var rect = rects[index];
        box.hidden = !rect;
        if (!rect) return;
        box.style.borderColor = selected ? theme.selectedBorder : theme.activeBorder;
        box.style.backgroundColor = selected ? theme.selectedBackground : theme.activeBackground;
        box.style.left = rect.left + 'px';
        box.style.top = rect.top + 'px';
        box.style.width = rect.width + 'px';
        box.style.height = rect.height + 'px';
      });
      tooltip.hidden = !rects.length;
      tooltip.textContent = description;
      if (rects.length) {
        var anchor = rects[0];
        var width = tooltip.offsetWidth;
        var height = tooltip.offsetHeight;
        var left = Math.max(4, Math.min(anchor.left, window.innerWidth - width - 4));
        var top = anchor.top - height - 4;
        if (top < 4) top = Math.min(anchor.bottom + 4, window.innerHeight - height - 4);
        tooltip.style.left = left + 'px';
        tooltip.style.top = Math.max(4, top) + 'px';
      }
    }
    // Follow scrolling, resize and layout animations even with a stationary pointer.
    if (target && target.isConnected && typeof window.requestAnimationFrame === 'function') {
      animation = window.requestAnimationFrame(render);
    }
  }

  function highlight(element, picked) {
    if (target === element && selected === picked) return;
    target = element;
    selected = picked;
    if (animation) window.cancelAnimationFrame(animation);
    render();
  }

  function eventElement(event) {
    var path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    return path.find(function (node) { return node && node.nodeType === 1 && node !== surface; });
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

  var suppressed = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick', 'contextmenu'];

  function cleanup() {
    if (animation) window.cancelAnimationFrame(animation);
    document.removeEventListener('pointerover', onHover, true);
    document.removeEventListener('pointermove', onHover, true);
    document.removeEventListener('pointerout', onLeave, true);
    suppressed.forEach(function (event) { document.removeEventListener(event, suppress, true); });
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    surface.remove();
    delete window.__openbitfun_inspector_active;
    delete window.__openbitfun_inspector_cancel;
  }

  function onHover(event) {
    var element = eventElement(event);
    if (element && element !== target) highlight(element, false);
  }

  function onLeave(event) {
    if (!event.relatedTarget && !selected) highlight(null, false);
  }

  function suppress(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onClick(event) {
    var element = eventElement(event);
    if (!element) return;
    suppress(event);
    highlight(element, true);
    emitTauri(EVENT_SELECTED, {
      tagName: element.tagName.toLowerCase(),
      path: cssPath(element),
      attributes: getAttrs(element),
      textContent: (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
      outerHTML: (element.outerHTML || '').slice(0, 2000),
    });
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      suppress(event);
      window.__openbitfun_inspector_cancel();
    }
  }

  window.__openbitfun_inspector_cancel = function () {
    emitTauri(EVENT_CANCELLED, null);
    cleanup();
  };

  document.addEventListener('pointerover', onHover, true);
  document.addEventListener('pointermove', onHover, true);
  document.addEventListener('pointerout', onLeave, true);
  suppressed.forEach(function (event) { document.addEventListener(event, suppress, true); });
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
})
`;

/**
 * Returns the JavaScript string to eval() inside the Tauri embedded webview.
 *
 * @param webviewLabel  The label of the webview whose events should be listened to.
 */
export function createInspectorScript(webviewLabel: string): string {
  const styles = window.getComputedStyle(document.documentElement);
  const theme = Object.fromEntries(
    (Object.keys(INSPECTOR_COLOR_FALLBACKS) as (keyof typeof INSPECTOR_COLOR_FALLBACKS)[]).map(key => [
      key,
      styles.getPropertyValue(INSPECTOR_OVERLAY_THEME[key].slice(4, -1)).trim() || INSPECTOR_COLOR_FALLBACKS[key],
    ]),
  );
  return `${INSPECTOR_SCRIPT_BODY.trim()}(${JSON.stringify(webviewLabel)}, ${JSON.stringify(theme)});`;
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
