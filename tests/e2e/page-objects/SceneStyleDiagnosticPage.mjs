import { SceneDiagnosticPage } from './SceneDiagnosticPage.mjs';

/** Isolated cause analysis only; rule removal is never a product optimization. */
export class SceneStyleDiagnosticPage extends SceneDiagnosticPage {
  sessionLayoutState() {
    return this.execute(() => {
      const scene = document.querySelector('[data-testid="scene-viewport-scene"][data-scene-id="session"]');
      const scroller = scene?.querySelector('[data-flowchat-scroller]');
      if (!scene || !scroller) throw new Error('Missing retained conversation');
      const style = getComputedStyle(scene);
      return { display: style.display, contentVisibility: style.contentVisibility,
        inert: scene.hasAttribute('inert'), ariaHidden: scene.getAttribute('aria-hidden'),
        visible: scene.classList.contains('openbitfun-scene-viewport__scene--visible'),
        scrollerHeight: scroller.clientHeight, scrollerWidth: scroller.clientWidth };
    });
  }

  suspendSessionInertness() {
    return this.execute(() => {
      if (window.__sceneStyleDiagnostic) throw new Error('Style diagnostic is already active');
      const selector = '[data-testid="scene-viewport-scene"][data-scene-id="session"]';
      const scene = document.querySelector(selector);
      if (!scene) throw new Error('Missing retained session scene');
      const set = Element.prototype.setAttribute, remove = Element.prototype.removeAttribute;
      let suppressedSets = 0, suppressedRemovals = 0;
      remove.call(scene, 'inert');
      Element.prototype.setAttribute = function (name, value) {
        if (this === scene && name.toLowerCase() === 'inert') { suppressedSets++; return; }
        return set.call(this, name, value);
      };
      Element.prototype.removeAttribute = function (name) {
        if (this === scene && name.toLowerCase() === 'inert') { suppressedRemovals++; return; }
        return remove.call(this, name);
      };
      window.__sceneStyleDiagnostic = { restore: () => {
        Element.prototype.setAttribute = set; Element.prototype.removeAttribute = remove;
        const expectedInert = scene.getAttribute('aria-hidden') === 'true';
        if (expectedInert) set.call(scene, 'inert', ''); else remove.call(scene, 'inert');
        return { exact: scene.hasAttribute('inert') === expectedInert, suppressedSets, suppressedRemovals };
      } };
      return { mode: 'session-inert', selector, affectedScenes: 1 };
    });
  }

  suspendHiddenSessionLayout() {
    return this.execute(() => {
      if (window.__sceneStyleDiagnostic) throw new Error('Style diagnostic is already active');
      const selector = '[data-testid="scene-viewport-scene"][data-scene-id="session"]:not(.openbitfun-scene-viewport__scene--visible)';
      const style = document.createElement('style');
      style.textContent = `${selector} { display: none !important; }`;
      document.head.appendChild(style);
      const sheet = style.sheet;
      window.__sceneStyleDiagnostic = { restore: () => {
        style.remove();
        return { exact: !style.isConnected && ![...document.styleSheets].includes(sheet), removedDiagnosticRules: 1 };
      } };
      return { mode: 'session-display', selector, cssText: sheet.cssRules[0].cssText };
    });
  }

  styleGeometry() {
    return this.execute(() => ['[data-flowchat-scroller]', '[data-scene-bar-part="tabs"]'].map(selector => {
      const node = document.querySelector(selector);
      if (!node) throw new Error(`Missing diagnostic geometry: ${selector}`);
      const rect = node.getBoundingClientRect();
      return { selector, width: rect.width, height: rect.height,
        clientWidth: node.clientWidth, clientHeight: node.clientHeight };
    }));
  }

  suspendSharedScrollbarRules(focusOnly) {
    return this.execute(focusOnly => {
      if (typeof focusOnly !== 'boolean') throw new Error('Style diagnostic mode must be a boolean');
      if (window.__sceneStyleDiagnostic) throw new Error('Style diagnostic is already active');
      const groups = [], removed = [], inaccessible = [];
      const visit = (parent, context) => {
        const rules = [...parent.cssRules];
        const matches = [];
        rules.forEach((rule, index) => {
          if (rule.selectorText?.includes('data-openbitfun-design-system-root')
            && (rule.selectorText.includes('::-webkit-') || rule.style?.getPropertyValue('scrollbar-color')
              || rule.style?.getPropertyValue('scrollbar-width'))
            && (!focusOnly || rule.selectorText.includes(':has(:focus-visible)'))) {
            matches.push({ index, cssText: rule.cssText });
            removed.push({ context, selector: rule.selectorText, declarations: rule.style.cssText });
          } else if (rule.cssRules) visit(rule, [...context, rule.cssText.split('{')[0].trim()]);
        });
        if (!matches.length) return;
        const before = rules.map(rule => rule.cssText).join('\n');
        groups.push({ parent, matches, before });
        for (const match of [...matches].reverse()) parent.deleteRule(match.index);
      };
      const restore = () => {
        let exact = true;
        // Child groups are recorded before parent groups; reverse restoration
        // ensures a parent's snapshot is checked before its children change.
        for (const { parent, matches, before } of [...groups].reverse()) {
          for (const match of matches) parent.insertRule(match.cssText, match.index);
          exact &&= [...parent.cssRules].map(rule => rule.cssText).join('\n') === before;
        }
        return { exact, restoredRules: removed.length };
      };
      try {
        for (const sheet of document.styleSheets) {
          try { void sheet.cssRules; } catch { inaccessible.push(sheet.href); continue; }
          visit(sheet, [sheet.href || 'inline']);
        }
      } catch (error) { restore(); throw error; }
      window.__sceneStyleDiagnostic = { restore };
      return { focusOnly, removed, inaccessible };
    }, focusOnly);
  }

  restoreSharedScrollbarRules() {
    return this.execute(() => {
      const result = window.__sceneStyleDiagnostic?.restore();
      delete window.__sceneStyleDiagnostic;
      return result;
    });
  }
}
