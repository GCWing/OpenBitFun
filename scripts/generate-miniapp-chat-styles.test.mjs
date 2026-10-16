import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import * as sass from 'sass';
import { buildMiniAppChatStyles } from './generate-miniapp-chat-styles.mjs';

const root = resolve(import.meta.dirname, '..');
const generated = resolve(root, 'src/apps/miniapp-shell/src/generated');
const importer = { findFileUrl: url => url.startsWith('@/') ? pathToFileURL(resolve(root, 'src/web-ui/src', url.slice(2))) : null };
const compile = path => sass.compile(resolve(root, path), { importers: [importer] }).css;
function declarations(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `Missing canonical selector: ${selector}`);
  const body = css.indexOf('{', start);
  return css.slice(body + 1, css.indexOf('}', body)).replace(/\s+/g, ' ').trim();
}

test('the native stylesheet stays identical to its current Hi/FlowChat owners', async () => {
  const output = await buildMiniAppChatStyles();
  for (const [name, content] of Object.entries(output)) assert.equal(readFileSync(resolve(generated, name), 'utf8'), content, `${name} must be regenerated`);
  const css = output['chat-styles.css'];
  for (const [path, selectors] of [
    ['src/web-ui/src/app/layout/FloatingMiniChat.scss', ['.openbitfun-fmc', '.openbitfun-fmc__panel', '.openbitfun-fmc__header', '.openbitfun-fmc__miniapp-suggestion']],
    ['src/web-ui/src/flow_chat/components/FlowTextBlock.scss', ['.flow-text-block', '.flow-text-block--runtime-status']],
    ['src/web-ui/src/flow_chat/components/modern/UserMessageItem.scss', ['.user-message-item', '.user-message-item__content']],
  ]) {
    const owner = compile(path);
    for (const selector of selectors) assert.equal(declarations(css, selector), declarations(owner, selector), `${selector} must reuse its owner`);
  }
  const classes = await import(pathToFileURL(resolve(generated, 'chat-style-classes.js')));
  for (const [owner, map] of [
    ['components/LauncherButton/LauncherButton.module.css', classes.launcher],
    ['flow-chat/composer/ChatComposer.module.css', classes.composer],
    ['components/IconButton/IconButton.module.css', classes.iconButton],
  ]) {
    const source = readFileSync(resolve(root, 'design-system/packages/ui/src', owner), 'utf8');
    const key = owner.includes('IconButton') ? 'button' : 'root';
    assert.equal(declarations(css, `.${map[key]}`), declarations(source, `.${key}`));
  }
  assert.deepEqual(Object.keys(classes).sort(), ['composer', 'iconButton', 'launcher']);
  assert.ok(Object.values(classes).every(map => Object.values(map).every(value => typeof value === 'string')));
  assert.doesNotMatch(output['chat-style-classes.js'], /\b(?:import|function|fetch|React|tauri)\b/);
});
