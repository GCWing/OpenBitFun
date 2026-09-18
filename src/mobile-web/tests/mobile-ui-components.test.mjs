import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceDirectory = path.resolve(testDirectory, '../src');

test('composer menus fit compact, wide and keyboard-reduced viewports', async () => {
  const source = await readFile(path.join(sourceDirectory, 'components/composerMenuPlacement.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
  const { composerMenuPlacement: place } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  for (const width of [320, 390, 600, 768, 1280]) {
    for (const height of [260, 844]) {
      for (const menuWidth of [160, 180, 260, 330]) {
        const viewport = { left: 0, top: 40, width, height };
        const anchor = { left: width - 70, top: height, bottom: height + 32 };
        const result = place(anchor, viewport, menuWidth, 345);
        assert.ok(result.left >= 8);
        assert.ok(result.left + result.width <= width - 8);
        assert.ok(result.top >= viewport.top + 8);
        assert.ok(result.top + result.maxHeight <= viewport.top + height - 8);
        assert.ok(result.maxHeight > 0);
      }
    }
  }
  assert.equal(place({ left: 20, top: 10, bottom: 42 }, { left: 0, top: 0, width: 390, height: 844 }, 180, 200).top, 50);
});

test('model and reasoning menus escape toolbar clipping without collapsing the composer', async () => {
  const menu = await readFile(path.join(sourceDirectory, 'components/ComposerAnchoredMenu.tsx'), 'utf8');
  const controls = await readFile(path.join(sourceDirectory, 'components/ChatModelControls.tsx'), 'utf8');
  const page = await readFile(path.join(sourceDirectory, 'pages/ChatPage.tsx'), 'utf8');
  assert.match(menu, /createPortal\(/);
  assert.match(menu, /document\.body/);
  assert.match(menu, /visualViewport/);
  assert.match(menu, /ResizeObserver/);
  assert.match(menu, /!anchor\.contains\(target\) && !menu\.contains\(target\)/);
  assert.match(menu, /event\.key !== 'Escape'/);
  assert.equal((controls.match(/<ComposerSelectionSurface /g) || []).length, 1);
  assert.match(page, /closest\('\[data-composer-popover\]'\)/);
});
const mobileEntry = path.resolve(
  testDirectory,
  '../../../design-system/packages/ui/src/mobile.ts',
);

async function listTsxFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTsxFiles(absolutePath);
    return entry.isFile() && entry.name.endsWith('.tsx') ? [absolutePath] : [];
  }));
  return nested.flat();
}

async function readProductSources() {
  const files = await listTsxFiles(sourceDirectory);
  const sources = await Promise.all(files.map(async (file) => ({
    file: path.relative(sourceDirectory, file).split(path.sep).join('/'),
    source: await readFile(file, 'utf8'),
  })));
  return sources;
}

test('app reset stays below shared component padding and focus styles', async () => {
  const html = await readFile(path.resolve(testDirectory, '../index.html'), 'utf8');
  const main = await readFile(path.join(sourceDirectory, 'main.tsx'), 'utf8');
  const reset = await readFile(path.join(sourceDirectory, 'styles/reset.scss'), 'utf8');
  const global = await readFile(path.join(sourceDirectory, 'styles/global.scss'), 'utf8');
  const adaptive = await readFile(path.join(sourceDirectory, 'styles/components/adaptive-shell.scss'), 'utf8');
  assert.ok(main.indexOf("'./styles/reset.scss'") < main.indexOf("'@openbitfun/ui/mobile.css'"));
  assert.match(reset, /@layer openbitfun\.reset, openbitfun\.components;/);
  assert.match(reset, /@layer openbitfun\.reset\s*\{[\s\S]*?\*\s*\{[\s\S]*?padding:\s*0;/);
  assert.doesNotMatch(global, /^\*\s*\{/m, 'an unlayered universal reset erases component spacing');
  assert.doesNotMatch(html, /\*\s*\{[^}]*\b(?:padding|margin)\s*:/, 'HTML must not duplicate universal spacing resets');
  assert.doesNotMatch(adaptive, /^input:focus-visible,/m, 'generic focus styles must not override text-field focus ownership');
});

test('settings sheet title stays on the sheet centerline beside the close action', async () => {
  const harmony = await readFile(path.join(sourceDirectory, 'styles/components/harmony-native.scss'), 'utf8');
  const headerRule = harmony.match(/\.harmony-sidebar__settings-sheet\s*>\s*\[data-openbitfun-part='header'\]\s*\{[^}]+\}/)?.[0];
  const headingRule = harmony.match(/\.harmony-sidebar__settings-sheet\s*>\s*\[data-openbitfun-part='header'\]\s*\[data-openbitfun-part='heading'\]\s*\{[^}]+\}/)?.[0];
  const actionRule = harmony.match(/\.harmony-sidebar__settings-sheet\s*>\s*\[data-openbitfun-part='header'\]\s*\[data-openbitfun-part='header-action'\]\s*\{[^}]+\}/)?.[0];
  const titleRule = harmony.match(/\.harmony-sidebar__settings-sheet\s+h2\s*\{[^}]+\}/)?.[0];
  const closeRule = harmony.match(/\.harmony-sidebar__settings-sheet\s*>\s*\[data-openbitfun-part='header'\]\s*\[data-openbitfun-component='mobile-icon-button'\]\s*\{[^}]+\}/)?.[0];

  assert.ok(headerRule, 'missing settings sheet header rule');
  assert.match(headerRule, /display:\s*grid/);
  assert.match(headerRule, /grid-template-columns:\s*var\(--openbitfun-space-12\)\s+minmax\(0,\s*1fr\)\s+var\(--openbitfun-space-12\)/);
  assert.doesNotMatch(headerRule, /padding:\s*0\s+12px\s+0\s+20px/);
  assert.match(headerRule, /padding:\s*0\s+var\(--openbitfun-space-3\)/);
  assert.match(headingRule ?? "", /grid-column:\s*2/);
  assert.match(headingRule ?? "", /text-align:\s*center/);
  assert.match(actionRule ?? "", /grid-column:\s*3/);
  assert.match(actionRule ?? "", /justify-self:\s*end/);
  assert.match(titleRule ?? "", /text-align:\s*center/);
  assert.doesNotMatch(closeRule ?? "", /margin-left:\s*auto/);
});

test('left-aligned sheet headers keep flex after MobileSheet centers by default', async () => {
  const composer = await readFile(path.join(sourceDirectory, 'styles/components/chat-input.scss'), 'utf8');
  const files = await readFile(path.join(sourceDirectory, 'components/WorkspaceFiles.scss'), 'utf8');
  const composerHeader = composer.match(/\.chat-composer-sheet\s*>\s*\[data-openbitfun-part='header'\]\s*\{[^}]+\}/)?.[0];
  const editorHeader = files.match(/\[data-openbitfun-part="header"\]\s*\{[^}]+\}/)?.[0];

  assert.match(composerHeader ?? "", /display:\s*flex/);
  assert.match(composerHeader ?? "", /text-align:\s*left/);
  assert.match(editorHeader ?? "", /display:\s*flex/);
});

test('pairing and settings styles follow component parts instead of obsolete native anatomy', async () => {
  const harmony = await readFile(path.join(sourceDirectory, 'styles/components/harmony-native.scss'), 'utf8');
  const overlays = await readFile(path.join(sourceDirectory, 'components/SessionOverlays.tsx'), 'utf8');
  const questions = await readFile(path.join(sourceDirectory, 'components/ChatAskQuestionCard.tsx'), 'utf8');
  assert.doesNotMatch(harmony, /\.pairing-page(?:__|\s*\{)/, 'pairing layout has one owner in pairing.scss');
  assert.doesNotMatch(harmony, /\.pairing-page__advanced(?:\[open\])?\s+summary/);
  assert.doesNotMatch(harmony, /\.harmony-sidebar__settings-row > span:nth-child/);
  assert.doesNotMatch(harmony, /\.chat-page__(?:back|theme-btn) > svg/);
  assert.doesNotMatch(harmony, /\.pairing-page__relay-field input\s*\{|\.qr-scanner-sheet__manual input\s*\{/);
  assert.doesNotMatch(harmony, /\.pairing-page__password-toggle\s*\{[^}]*position:\s*absolute/);
  assert.match(overlays, /className="session-list__rename-input"/);
  assert.doesNotMatch(overlays, /inputClassName="session-list__rename-input"/);
  assert.match(questions, /className="chat-ask-card__custom-input"/);
  assert.doesNotMatch(questions, /inputClassName="chat-ask-card__custom-input"/);
});

test('visible mobile controls use the shared mobile component entry', async () => {
  const sources = await readProductSources();

  for (const { file, source } of sources) {
    for (const tag of ['a', 'button', 'select', 'details']) {
      assert.doesNotMatch(
        source,
        new RegExp(`<${tag}\\b`),
        `${file} renders a raw <${tag}> instead of an @openbitfun/ui/mobile component`,
      );
    }
    assert.doesNotMatch(
      source,
      /<(?:div|span|section)\b[^>]*\bonClick=/s,
      `${file} uses a non-interactive element as an interaction control`,
    );
    assert.doesNotMatch(
      source,
      /\brole="button"/,
      `${file} emulates a button instead of using a shared mobile control`,
    );
  }

  const nativeInputs = sources.flatMap(({ file, source }) => (
    [...source.matchAll(/<input\b[\s\S]*?\/>/g)].map((match) => ({
      file,
      markup: match[0],
    }))
  ));
  assert.equal(nativeInputs.length, 1, 'only the hidden file-input bridge may stay native');
  assert.equal(nativeInputs[0].file, 'pages/ChatPage.tsx');
  assert.match(nativeInputs[0].markup, /type="file"/);
  assert.match(nativeInputs[0].markup, /display:\s*'none'/);

  const nativeTextareas = sources.flatMap(({ file, source }) => (
    [...source.matchAll(/<textarea\b[\s\S]*?\/>/g)].map((match) => ({
      file,
      markup: match[0],
    }))
  ));
  assert.equal(nativeTextareas.length, 1, 'only the editor slot inside MobileComposer may stay native');
  assert.equal(nativeTextareas[0].file, 'components/ChatComposerBar.tsx');
  assert.match(nativeTextareas[0].markup, /className="chat-page__input"/);
});

test('mobile-web imports only components published by the shared mobile entry', async () => {
  const entrySource = await readFile(mobileEntry, 'utf8');
  const publishedComponentNames = new Set([
    ...entrySource.matchAll(/^\s*(Mobile[A-Za-z]+),$/gm),
  ].map((match) => match[1]));
  const sources = await readProductSources();
  const importedComponentNames = sources.flatMap(({ source }) => (
    [...source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*['"]@openbitfun\/ui\/mobile['"]/g)]
      .flatMap((match) => match[1]
        .split(',')
        .map((name) => name.trim())
        .filter((name) => !name.startsWith('type '))
        .filter((name) => /^Mobile[A-Za-z]+$/.test(name)))
  ));

  assert.ok(publishedComponentNames.size > 0, 'mobile entry did not expose any components');
  for (const componentName of importedComponentNames) {
    assert.ok(
      publishedComponentNames.has(componentName),
      `${componentName} is consumed by mobile-web but is not published by the mobile entry`,
    );
  }
});

test('large mobile pages delegate stable UI regions to app components', async () => {
  const chatPage = await readFile(path.join(sourceDirectory, 'pages/ChatPage.tsx'), 'utf8');
  const chatTranscript = await readFile(path.join(sourceDirectory, 'components/ChatTranscript.tsx'), 'utf8');
  const pairingPage = await readFile(path.join(sourceDirectory, 'pages/PairingPage.tsx'), 'utf8');
  const sessionPage = await readFile(path.join(sourceDirectory, 'pages/SessionListPage.tsx'), 'utf8');

  for (const component of [
    'ChatComposerBar',
    'ChatFeedback',
    'ChatHeader',
    'ChatMessageActions',
    'ChatTranscript',
    'ModelSelectorPill',
  ]) {
    assert.match(chatPage, new RegExp(`\\b${component}\\b`), `ChatPage must delegate ${component}`);
  }
  assert.doesNotMatch(chatPage, /<Mobile(?:Composer|Sheet)\b/, 'ChatPage must not rebuild composer or sheet anatomy');
  assert.doesNotMatch(chatPage, /const (?:ModelSelectorPill|ReasoningPresetPill|AskQuestionCard)\b/);
  assert.doesNotMatch(chatPage, /\b(?:ReactMarkdown|SyntaxHighlighter|renderOrderedItems)\b/);
  assert.match(chatTranscript, /\bChatAskQuestionCard\b/, 'ChatTranscript must delegate the question interaction');
  assert.match(chatTranscript, /\bChatToolApprovalActions\b/, 'ChatTranscript must delegate tool approvals');

  assert.match(pairingPage, /\bPairingForm\b/, 'PairingPage must delegate its visual form contract');
  assert.doesNotMatch(pairingPage, /<MobileTextField\b/, 'PairingPage must keep fields inside PairingForm');

  for (const component of [
    'CompactSettingsSheet',
    'MobileChoiceSheet',
    'SessionHistoryPanel',
    'SessionLaunchPanel',
    'SessionOverlays',
  ]) {
    assert.match(sessionPage, new RegExp(`\\b${component}\\b`), `SessionListPage must delegate ${component}`);
  }
  assert.doesNotMatch(sessionPage, /<MobileSheet\b/, 'SessionListPage must not own low-level sheet anatomy');
  assert.doesNotMatch(sessionPage, /createPortal\b/, 'shared sheets own their portal lifecycle');
});

test('mobile remote control exposes approval commands and responsive composer contracts', async () => {
  const manager = await readFile(path.join(sourceDirectory, 'services/RemoteSessionManager.ts'), 'utf8');
  const chatPage = await readFile(path.join(sourceDirectory, 'pages/ChatPage.tsx'), 'utf8');
  const transcript = await readFile(path.join(sourceDirectory, 'components/ChatTranscript.tsx'), 'utf8');
  const approval = await readFile(path.join(sourceDirectory, 'components/ChatToolApprovalActions.tsx'), 'utf8');
  const composer = await readFile(path.join(sourceDirectory, 'components/ChatComposerBar.tsx'), 'utf8');
  const modelControls = await readFile(path.join(sourceDirectory, 'components/ChatModelControls.tsx'), 'utf8');
  const inputStyles = await readFile(path.join(sourceDirectory, 'styles/components/chat-input.scss'), 'utf8');
  const harmonyStyles = await readFile(path.join(sourceDirectory, 'styles/components/harmony-native.scss'), 'utf8');

  assert.match(manager, /cmd:\s*'confirm_tool'/);
  assert.match(manager, /cmd:\s*'reject_tool'/);
  assert.match(approval, /pending_confirmation/);
  assert.match(approval, /needs_confirmation/);
  assert.match(chatPage, /onApproveTool=\{handleApproveTool\}/);
  assert.match(chatPage, /onRejectTool=\{handleRejectTool\}/);
  assert.match(transcript, /onApproveTool=\{onApproveTool\}/);
  assert.match(transcript, /onRejectTool=\{onRejectTool\}/);
  assert.match(transcript, /reconcileOrderedItemsWithTools\(activeTurn\.items, activeTurn\.tools\)/);

  assert.match(composer, /<MobileComposer\b/);
  assert.match(composer, /<textarea\b/);
  assert.doesNotMatch(composer, /\bMobileTextarea\b/);
  assert.doesNotMatch(modelControls, /chat-model-selector__icon/);
  assert.doesNotMatch(modelControls, /chat-model-selector__effort/);
  assert.match(inputStyles, /\.chat-model-selector__trigger\s*\{[\s\S]*?height:\s*48px;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;/);
  assert.match(harmonyStyles, /\.harmony-sidebar__footer\s*\{[\s\S]*?inline-size:\s*auto;/);
  assert.doesNotMatch(harmonyStyles, /\.chat-page__composer\s*\{/);
  assert.match(inputStyles, /\.chat-page__composer\s*\{/);
  assert.doesNotMatch(inputStyles, /width:\s*(24|28|30)px;[\s]*height:\s*(24|28|30)px;/);
});

test('mobile transcript keeps one user bubble and projects file cards outside markdown links', async () => {
  const transcript = await readFile(path.join(sourceDirectory, 'components/ChatTranscript.tsx'), 'utf8');
  const markdown = await readFile(path.join(sourceDirectory, 'components/ChatMarkdown.tsx'), 'utf8');
  const chatStyles = await readFile(path.join(sourceDirectory, 'styles/components/chat.scss'), 'utf8');
  const adaptiveStyles = await readFile(path.join(sourceDirectory, 'styles/components/adaptive-shell.scss'), 'utf8');
  const harmonyStyles = await readFile(path.join(sourceDirectory, 'styles/components/harmony-native.scss'), 'utf8');
  const markdownStyles = await readFile(path.join(sourceDirectory, 'styles/components/markdown.scss'), 'utf8');
  const messageStyles = await readFile(
    path.resolve(testDirectory, '../../../design-system/packages/ui/src/mobile/MobileMessage/MobileMessage.module.css'),
    'utf8',
  );

  assert.doesNotMatch(transcript, /chat-msg__user-(?:card|avatar)/);
  assert.doesNotMatch(
    `${chatStyles}\n${adaptiveStyles}\n${harmonyStyles}`,
    /chat-msg__user-(?:card|avatar)/,
  );
  for (const themeStyles of [adaptiveStyles, harmonyStyles]) {
    assert.doesNotMatch(themeStyles, /\.chat-msg__user-content\s*\{/);
  }
  assert.match(chatStyles, /\.chat-msg--user\s*\{[\s\S]*?align-items:\s*flex-end;/);
  assert.match(messageStyles, /data-role="user"[\s\S]*?inline-size:\s*fit-content;[\s\S]*?276px/);

  const markdownLinkRenderer = markdown.slice(
    markdown.indexOf('a({ href, children }'),
    markdown.indexOf('table({ children }'),
  );
  assert.match(markdown, /projectFileReferences\(content\)/);
  assert.match(markdown, /className="message-file-cards"/);
  assert.doesNotMatch(markdownLinkRenderer, /<FileCard/);
  assert.match(markdownStyles, /\.message-file-cards\s*\{[\s\S]*?display:\s*grid;/);
  assert.match(markdownStyles, /\.file-card\s*\{[\s\S]*?inline-size:\s*100%;/);
});


test('mobile viewport follows the keyboard, restores insets and leaves pinch zoom alone', async () => {
  const source = await readFile(path.join(sourceDirectory, 'hooks/useMobileViewport.ts'), 'utf8');
  const code = ts.transpileModule(source.replace(/import .* from 'react';/, ''), {
    compilerOptions: { module: ts.ModuleKind.ESNext },
  }).outputText;
  const { mobileViewportInsets: insets } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  assert.deepEqual(insets(844, 844, 0, 1), { height: 844, top: 0, bottom: 0 });
  assert.deepEqual(insets(844, 510, 0, 1), { height: 510, top: 0, bottom: 334 });
  assert.deepEqual(insets(844, 510, 40, 1), { height: 510, top: 40, bottom: 294 });
  assert.deepEqual(insets(510, 510, 0, 1), { height: 510, top: 0, bottom: 0 });
  assert.deepEqual(insets(844, 844, 0, 1), { height: 844, top: 0, bottom: 0 });
  assert.equal(insets(844, 422, 20, 2), null);
});
