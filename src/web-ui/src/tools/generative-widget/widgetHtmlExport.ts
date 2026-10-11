import { saveHtmlFile } from '@/infrastructure/file-export/saveHtmlFile';
import { GENERATIVE_WIDGET_SHELL_HTML } from './GenerativeWidgetFrame';
import { readWidgetAppearancePayload, type WidgetAppearancePayload } from './appearancePayload';

interface WidgetHtmlOptions {
  widgetCode: string;
  title: string;
  language: string;
  hostUnavailableMessage: string;
}

export function createGenerativeWidgetHtml({
  widgetCode, title, language, hostUnavailableMessage, appearance,
}: WidgetHtmlOptions & { appearance: WidgetAppearancePayload | null }): string {
  // DOMParser keeps scripts inert while constructing the export. Remove only the
  // host runtime before inserting the widget's own markup and scripts.
  const doc = new DOMParser().parseFromString(GENERATIVE_WIDGET_SHELL_HTML, 'text/html');
  doc.querySelectorAll('script').forEach(script => script.remove());
  doc.title = title;
  doc.documentElement.lang = language;
  if (appearance) {
    doc.documentElement.setAttribute('data-openbitfun-appearance', appearance.id);
    doc.documentElement.setAttribute('data-openbitfun-appearance-mode', appearance.mode);
    Object.entries(appearance.vars).forEach(([name, value]) => {
      doc.documentElement.style.setProperty(name, value);
    });
    if (appearance.mode === 'light' || appearance.mode === 'dark') {
      doc.documentElement.style.colorScheme = appearance.mode;
    }
  }

  const style = doc.createElement('style');
  style.textContent = `
    html, body { min-height: 100%; overflow-y: auto; }
    html { background: var(--openbitfun-color-surface-panel); }
    body {
      background: var(--openbitfun-color-surface-canvas);
      font-family: var(--openbitfun-type-body-sm-font-family);
    }
  `;
  doc.head.appendChild(style);

  const bridge = doc.createElement('script');
  const message = JSON.stringify(hostUnavailableMessage).replace(/</g, '\\u003c');
  bridge.textContent = `
    (function () {
      function unsupported() { window.alert(${message}); }
      window.openbitfunWidget = { send: unsupported };
      window.glimpse = window.openbitfunWidget;
      window.sendPrompt = unsupported;
      document.addEventListener('click', function (event) {
        var target = event.target && event.target.closest
          ? event.target.closest('[data-file-path], [data-openbitfun-open-file]') : null;
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        unsupported();
      }, true);
    })();
  `;
  doc.body.prepend(bridge);
  doc.getElementById('root')!.innerHTML = widgetCode;
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

export async function exportGenerativeWidgetHtml(options: WidgetHtmlOptions & {
  dialogTitle: string;
}): Promise<boolean> {
  const html = createGenerativeWidgetHtml({
    ...options,
    appearance: readWidgetAppearancePayload(),
  });
  return saveHtmlFile({ html, title: options.title, dialogTitle: options.dialogTitle });
}
