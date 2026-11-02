// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextResolver } from './core/ContextResolver';
import { ContextType, type TextInputContext } from './types/context.types';

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('@/infrastructure/i18n', () => ({
  i18nService: { t: (key: string) => key, getT: () => (key: string) => key },
}));

vi.mock('@/infrastructure/event-bus', () => ({
  globalEventBus: { emit: mocks.emit },
}));

vi.mock('./commands/CommandExecutor', () => ({
  commandExecutor: { execute: mocks.execute },
}));

import { TextInputMenuProvider } from './providers/TextInputMenuProvider';
import { CopyCommand } from './commands/builtin/CopyCommand';
import { CutCommand } from './commands/builtin/CutCommand';
import { PasteCommand } from './commands/builtin/PasteCommand';
import { SelectAllCommand } from './commands/builtin/SelectAllCommand';

let clipboard: { writeText: ReturnType<typeof vi.fn>; readText: ReturnType<typeof vi.fn> };

function appendTextarea(value: string): HTMLTextAreaElement {
  const element = document.createElement('textarea');
  element.value = value;
  document.body.append(element);
  element.focus();
  return element;
}

function appendComposer(text: string): HTMLElement {
  const host = document.createElement('div');
  host.setAttribute('contenteditable', 'true');
  const span = document.createElement('span');
  span.textContent = text;
  host.append(span);
  document.body.append(host);
  return host;
}

function selectTextNode(node: Text): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function placeCaretAtEnd(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function contextFor(element: HTMLElement): TextInputContext {
  const event = new MouseEvent('contextmenu', { bubbles: true });
  element.dispatchEvent(event);
  return new ContextResolver().resolve(event) as TextInputContext;
}

function contextTypeFor(element: HTMLElement): ContextType {
  const event = new MouseEvent('contextmenu', { bubbles: true });
  element.dispatchEvent(event);
  return new ContextResolver().resolve(event).type;
}

function textInputContext(overrides: Partial<TextInputContext> = {}): TextInputContext {
  const element = document.createElement('textarea');
  document.body.append(element);
  return {
    type: ContextType.TEXT_INPUT,
    event: new MouseEvent('contextmenu'),
    targetElement: element,
    position: { x: 0, y: 0 },
    timestamp: Date.now(),
    element,
    kind: 'textarea',
    isReadOnly: false,
    hasSelection: true,
    selectedText: 'selected',
    ...overrides,
  };
}

beforeEach(() => {
  clipboard = {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(''),
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
  mocks.execute.mockResolvedValue({ success: true });
});

afterEach(() => {
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
  vi.clearAllMocks();
});

describe('text input context resolution', () => {
  it('resolves a textarea selection with copyable text', () => {
    const textarea = appendTextarea('hello world');
    textarea.setSelectionRange(6, 11);

    expect(contextFor(textarea)).toMatchObject({
      type: ContextType.TEXT_INPUT,
      kind: 'textarea',
      selectedText: 'world',
      hasSelection: true,
      isReadOnly: false,
    });
  });

  it('resolves the editing host for a node nested inside a composer', () => {
    const host = appendComposer('compose');
    const context = contextFor(host.firstElementChild as HTMLElement);

    expect(context).toMatchObject({ type: ContextType.TEXT_INPUT, kind: 'contenteditable' });
    expect(context.element).toBe(host);
  });

  it('ignores non-text inputs and surfaces owned by the editor', () => {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    document.body.append(checkbox);
    expect(contextTypeFor(checkbox)).not.toBe(ContextType.TEXT_INPUT);

    const editor = document.createElement('div');
    editor.className = 'monaco-editor';
    const field = document.createElement('textarea');
    editor.append(field);
    document.body.append(editor);
    expect(contextTypeFor(field)).not.toBe(ContextType.TEXT_INPUT);
  });

  it('reports a read-only field as non-writable', () => {
    const textarea = appendTextarea('locked');
    textarea.readOnly = true;

    expect(contextFor(textarea)).toMatchObject({ isReadOnly: true });
  });
});

describe('text input menu items', () => {
  it('offers copy, cut, paste and select-all with shortcut hints', async () => {
    const items = await new TextInputMenuProvider().getMenuItems(textInputContext());
    const actions = items.filter(item => !item.separator);

    expect(actions.map(item => item.id)).toEqual([
      'text-input-copy',
      'text-input-cut',
      'text-input-paste',
      'text-input-select-all',
    ]);
    expect(actions.map(item => item.shortcut)).toEqual(['Ctrl+C', 'Ctrl+X', 'Ctrl+V', 'Ctrl+A']);
    expect(actions.every(item => !item.disabled)).toBe(true);
  });

  it('uses command-key hints on macOS', async () => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });

    const items = await new TextInputMenuProvider().getMenuItems(textInputContext());
    const actions = items.filter(item => !item.separator);

    expect(actions.map(item => item.shortcut)).toEqual(['⌘C', '⌘X', '⌘V', '⌘A']);
  });

  it('disables selection actions without a selection and disables writes when read-only', async () => {
    const withoutSelection = await new TextInputMenuProvider().getMenuItems(
      textInputContext({ hasSelection: false, selectedText: '' }),
    );
    expect(withoutSelection.map(item => [item.id, Boolean(item.disabled)])).toEqual([
      ['text-input-copy', true],
      ['text-input-cut', true],
      ['text-input-paste', false],
      ['text-input-separator-1', false],
      ['text-input-select-all', false],
    ]);

    const readOnly = await new TextInputMenuProvider().getMenuItems(
      textInputContext({ isReadOnly: true }),
    );
    expect(readOnly.map(item => [item.id, Boolean(item.disabled)])).toEqual([
      ['text-input-copy', false],
      ['text-input-cut', true],
      ['text-input-paste', true],
      ['text-input-separator-1', false],
      ['text-input-select-all', false],
    ]);
  });

  it('dispatches the edit command for a clicked entry and reports failures', async () => {
    const context = textInputContext();
    const items = await new TextInputMenuProvider().getMenuItems(context);

    items.find(item => item.id === 'text-input-paste')?.onClick?.(context);
    expect(mocks.execute).toHaveBeenCalledWith('paste', context);

    mocks.execute.mockResolvedValueOnce({ success: false, message: 'errors:contextMenu.pasteFailed' });
    items.find(item => item.id === 'text-input-paste')?.onClick?.(context);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.emit).toHaveBeenCalledWith('toast:error', { message: 'errors:contextMenu.pasteFailed' });
  });
});

describe('text input edit commands', () => {
  it('selects all text of the field', async () => {
    const textarea = appendTextarea('hello');
    const result = await new SelectAllCommand().execute(contextFor(textarea));

    expect(result.success).toBe(true);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 5]);
  });

  it('copies the field selection to the clipboard', async () => {
    const textarea = appendTextarea('hello world');
    textarea.setSelectionRange(0, 5);

    const result = await new CopyCommand().execute(contextFor(textarea));

    expect(result.success).toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith('hello');
  });

  it('cuts the field selection and emits an input event', async () => {
    const textarea = appendTextarea('hello world');
    textarea.setSelectionRange(0, 6);
    const inputSpy = vi.fn();
    textarea.addEventListener('input', inputSpy);

    const result = await new CutCommand().execute(contextFor(textarea));

    expect(result.success).toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith('hello ');
    expect(textarea.value).toBe('world');
    expect(inputSpy).toHaveBeenCalled();
  });

  it('pastes clipboard text at the caret', async () => {
    clipboard.readText.mockResolvedValue('pasted ');
    const textarea = appendTextarea('hello');
    // jsdom moves the caret to the end on focus; the menu must restore the
    // selection captured before the menu opened.
    textarea.setSelectionRange(0, 0);

    const result = await new PasteCommand().execute(contextFor(textarea));

    expect(result.success).toBe(true);
    expect(textarea.value).toBe('pasted hello');
  });

  it('pastes into a contenteditable composer', async () => {
    clipboard.readText.mockResolvedValue('world');
    const host = appendComposer('hello ');
    placeCaretAtEnd(host);

    const result = await new PasteCommand().execute(contextFor(host));

    // jsdom does not model the contenteditable caret, so this asserts delivery
    // into the composer rather than the exact insertion offset.
    expect(result.success).toBe(true);
    expect(host.textContent).toContain('world');
  });

  it('copies the selection of a contenteditable composer', async () => {
    const host = appendComposer('compose');
    selectTextNode(host.firstElementChild?.firstChild as Text);

    const result = await new CopyCommand().execute(contextFor(host));

    expect(result.success).toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith('compose');
  });

  it('refuses to write into a read-only field', async () => {
    clipboard.readText.mockResolvedValue('ignored');
    const textarea = appendTextarea('locked');
    textarea.readOnly = true;

    const result = await new PasteCommand().execute(contextFor(textarea));

    expect(result.success).toBe(false);
    expect(textarea.value).toBe('locked');
  });

  it('reports an unavailable clipboard instead of silently doing nothing', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const textarea = appendTextarea('hello');

    const result = await new PasteCommand().execute(contextFor(textarea));

    expect(result.success).toBe(false);
    expect(result.message).toBe('errors:contextMenu.clipboardUnavailable');
  });
});
