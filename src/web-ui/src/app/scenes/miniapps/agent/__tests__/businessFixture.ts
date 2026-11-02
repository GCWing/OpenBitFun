import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi } from 'vitest';

export const readSource = (path: string) => readFileSync(resolve(process.cwd(), '..', path), 'utf8');
const builder = readSource('crates/contracts/product-domains/src/miniapp/bridge_builder.rs');
const template = builder.split('r#"')[1].split('"#,')[0];
const values: Record<string, string> = {
  app_id_esc: '"builtin-regex-playground"', app_data_esc: '"/data"', workspace_esc: '"/workspace"',
  appearance_mode_esc: '"light"', platform_esc: '"macos"',
  agent_key_contract: readSource('shared/miniapp-agent/keys.json'),
};
const injectedScript = template.replace(/\{\{|\}\}|\{(\w+)\}/g, (match, name: string) => {
  if (match === '{{') return '{';
  if (match === '}}') return '}';
  if (!(name in values)) throw new Error(`Unknown bridge template parameter: ${name}`);
  return values[name];
});
const regexRoot = 'crates/contracts/product-domains/src/miniapp/builtin/assets/regex-playground';
export const regexHtml = readSource(`${regexRoot}/index.html`);
export const regexSource = readSource(`${regexRoot}/ui.js`);
export const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

/** Execute real SDK/app source. Only transport delivery and storage IO are fixtures. */
export async function bootBusinessApp(
  frame: HTMLIFrameElement,
  source = regexSource,
  html = regexHtml,
  legacy = false,
  saved: unknown = null,
) {
  const win = frame.contentWindow! as Window & typeof globalThis;
  const doc = frame.contentDocument!;
  doc.open(); doc.write(html); doc.close();
  // jsdom does not supply postMessage source identity or layout scrolling.
  const parentPosts = vi.spyOn(win.parent, 'postMessage').mockImplementation(data => {
    window.dispatchEvent(new MessageEvent('message', { source: win, data }));
  });
  vi.spyOn(win, 'postMessage').mockImplementation(data => {
    win.dispatchEvent(new win.MessageEvent('message', { source: win.parent, data }));
  });
  Object.defineProperty(win.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} });
  new Function('window', 'document', 'KeyboardEvent', injectedScript)(win, doc, win.KeyboardEvent);
  const app = (win as unknown as { app: { storage: unknown; agent: { expose?: unknown } } }).app;
  const storage = { get: vi.fn(async () => saved), set: vi.fn(async () => undefined) };
  app.storage = storage;
  if (legacy) delete app.agent.expose;
  new Function('window', 'document', 'app', source)(win, doc, app);
  await flush();
  const input = (id: string, value: string) => {
    const element = doc.getElementById(id) as HTMLInputElement;
    element.value = value;
    element.dispatchEvent(new win.Event('input', { bubbles: true }));
    return element;
  };
  return { frame, win, doc, storage, input, parentPosts };
}
