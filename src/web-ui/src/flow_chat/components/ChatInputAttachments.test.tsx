// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { useContextStore } from '@/shared/stores/contextStore';
import type { ContextItem, ConversationExcerptContext, ImageContext } from '@/shared/types/context';
import { sessionComposerStore } from '../store/sessionComposerStore';
import { ConversationExcerptPreview } from '../selection/ConversationExcerptAttachments';
import { withConversationExcerpts } from '../utils/composerPresentation';
import { UserMessagePresentationContent } from './modern/UserMessagePresentationContent';
import { ChatInputAttachments } from './ChatInputAttachments';

const callbacks = vi.hoisted(() => ({ update: vi.fn(), remove: vi.fn(), outerKey: vi.fn(), locate: vi.fn(), warn: vi.fn() }));
vi.mock('../selection/locateConversationExcerpt', () => ({ locateConversationExcerpt: callbacks.locate }));
vi.mock('@/shared/notification-system', () => ({ notificationService: { warning: callbacks.warn } }));
vi.mock('../store/FlowChatStore', () => ({ flowChatStore: {
  getState: () => ({ sessions: new Map([['main', { sessionId: 'main', dialogTurns: [] }]]) }),
} }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({
  formatNumber: (number: number) => String(number),
  t: (key: string, values?: Record<string, string>) => key === 'selection.numbered' ? `Annotation ${values?.number}`
    : key === 'selection.removeNumbered' ? `Remove ${values?.annotation}` : key,
}) }));

const excerpt: ConversationExcerptContext = {
  id: 'annotation-1', type: 'conversation-excerpt', timestamp: 1, annotationNumber: 1,
  source: { surfaceId: 'local', sessionId: 'main', sessionName: 'Source session' },
  fragments: [{ turnId: 'turn', text: 'Original quoted source', start: 0, end: 22, prefix: '', suffix: '' }],
  comment: 'First comment',
};
const second = { ...excerpt, id: 'annotation-2', annotationNumber: 2, comment: 'Second comment' };
const image: ImageContext = {
  id: 'image', type: 'image', timestamp: 1, imageName: 'Photo.png', mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,AA==',
};

function Composer() {
  const [contexts, setContexts] = useState<ContextItem[]>([image, excerpt, second]);
  return <div onKeyDown={callbacks.outerKey}>
    <ChatInputAttachments contexts={contexts} surfaceEpoch={getActiveSurfaceScope().epoch}
      onUpdate={(id, comment) => {
        callbacks.update(id, comment);
        setContexts(current => current.map(item => item.id === id ? { ...item, comment } : item));
      }}
      onRemove={id => { callbacks.remove(id); setContexts(current => current.filter(item => item.id !== id)); }} />
  </div>;
}

function LinkedComposer() {
  const contexts = useContextStore(state => state.contexts);
  return <>
    <ConversationExcerptPreview excerpt={excerpt} superscript origin="source" />
    <ChatInputAttachments contexts={contexts} surfaceEpoch={getActiveSurfaceScope().epoch}
      onRemove={id => useContextStore.getState().removeContext(id)}
      onUpdate={(id, comment) => useContextStore.getState().updateContext(id, { comment })} />
  </>;
}

describe('numbered composer attachments', () => {
  let root: Root;
  let container: HTMLDivElement;
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const flushFrames = () => act(() => {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0));
  });
  const dialog = () => document.querySelector<HTMLDivElement>('[role="dialog"][data-state="open"]');
  const click = (node: HTMLElement) => { act(() => node.click()); flushFrames(); };
  const chip = () => container.querySelector<HTMLButtonElement>('[data-openbitfun-product-part="attachment"]')!;
  const trigger = (number: number) => {
    if (!document.querySelector('[data-openbitfun-product-part="details"]')) click(chip());
    return document.querySelector<HTMLButtonElement>(`[data-openbitfun-product-part="details"] button[aria-label="Annotation ${number}"]`)!;
  };
  const action = (key: string) => [...dialog()!.querySelectorAll('button')].find(button => button.textContent === key)!;
  const typeComment = (value: string) => act(() => {
    const textarea = dialog()!.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    activateSurface('local');
    vi.clearAllMocks();
    sessionComposerStore.setState({ drafts: {} });
    useContextStore.getState().clearContexts();
    frames.clear();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove();
    document.querySelectorAll('[data-openbitfun-overlay-host]').forEach(host => host.remove());
    vi.unstubAllGlobals();
  });

  it('groups annotations in a capsule, previews on hover, and removes only the chosen detail', () => {
    act(() => root.render(<Composer />));
    const strip = container.querySelector('[data-openbitfun-part="imageStrip"]')!;
    expect(strip.querySelector('img')?.alt).toBe('Photo.png');
    expect(strip.contains(chip())).toBe(true);
    expect(document.querySelector('[data-openbitfun-product-part="details"]')).toBeNull();
    act(() => chip().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    flushFrames();
    expect(document.querySelector('[data-openbitfun-product-part="details"]')?.textContent).toContain(excerpt.fragments[0].text);
    expect(document.querySelector('[data-openbitfun-product-part="details"]')?.textContent).toContain('First comment');
    click(document.querySelector<HTMLButtonElement>('[aria-label="Remove Annotation 1"]')!);
    expect(callbacks.remove).toHaveBeenCalledWith('annotation-1');
    expect(trigger(1)).toBeNull();
    expect(trigger(2)).not.toBeNull();
    expect(strip.querySelector('img')).not.toBeNull();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('edits only the selected comment, keeps the number, and contains composer keyboard shortcuts', () => {
    act(() => root.render(<Composer />));
    click(trigger(1));
    const textarea = dialog()!.querySelector('textarea')!;
    expect(textarea.value).toBe('First comment');
    expect(document.activeElement).toBe(textarea);
    const quote = dialog()!.querySelector('[data-openbitfun-product-part="quote"]')!;
    expect(quote.textContent).toBe(excerpt.fragments[0].text);
    const quoteText = quote.querySelector('[data-openbitfun-product-part="quoteText"]')!;
    expect(quoteText.getAttribute('data-overflow-style')).toBe('ellipsis');
    expect(quoteText.getAttribute('data-overflow-behavior')).toBe('fade');
    expect(dialog()!.querySelector('label')).toBeNull();
    expect(textarea.getAttribute('placeholder')).toBeNull();
    expect(textarea.getAttribute('aria-label')).toBe('selection.annotation');
    expect(dialog()!.querySelector('blockquote')).toBeNull();
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '  Revised  ');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(callbacks.outerKey).not.toHaveBeenCalled();
    expect(callbacks.update).not.toHaveBeenCalled();
    act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
    expect(callbacks.update).toHaveBeenCalledExactlyOnceWith(excerpt.id, 'Revised');
    expect(dialog()).toBeNull();
    expect(trigger(1)).not.toBeNull();
    click(trigger(2));
    expect(dialog()!.querySelector('textarea')!.value).toBe('Second comment');
    click([...dialog()!.querySelectorAll('button')].find(button => button.textContent === 'selection.cancel')!);
    expect(callbacks.update).toHaveBeenCalledOnce();
  });

  it('opens details from keyboard focus, dismisses with Escape, and clears annotations without removing images', () => {
    act(() => root.render(<Composer />));
    act(() => chip().focus());
    flushFrames();
    expect(chip().getAttribute('aria-expanded')).toBe('true');
    act(() => chip().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Annotation 1');
    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.activeElement).toBe(chip());
    expect(document.querySelector('[data-openbitfun-product-part="details"]')).toBeNull();
    click(container.querySelector<HTMLButtonElement>('[aria-label="selection.remove"]')!);
    expect(callbacks.remove.mock.calls).toEqual([['annotation-1'], ['annotation-2']]);
    expect(chip()).toBeNull();
    expect(container.querySelector('img')?.alt).toBe('Photo.png');
  });

  it('views stale source previews and sent annotations without editor controls or write shortcuts', () => {
    act(() => root.render(<div onKeyDown={callbacks.outerKey}>
      <ConversationExcerptPreview excerpt={excerpt} superscript origin="source" />
      <ConversationExcerptPreview excerpt={excerpt} />
    </div>));
    const triggers = container.querySelectorAll<HTMLButtonElement>('[aria-label="Annotation 1"]');
    expect([...triggers].map(button => button.textContent)).toEqual(['1', 'Annotation 1']);
    for (const trigger of triggers) {
      click(trigger);
      expect(dialog()!.querySelector('textarea, input, [contenteditable="true"]')).toBeNull();
      const comment = dialog()!.querySelector<HTMLElement>('[data-openbitfun-product-part="comment"]')!;
      expect(comment.textContent).toBe('First comment');
      expect(dialog()!.querySelector('[data-openbitfun-product-part="quote"]')!.textContent).toBe(excerpt.fragments[0].text);
      expect([...dialog()!.querySelectorAll('[data-openbitfun-part="footer"] button')].map(button => button.textContent))
        .toEqual(['selection.locate']);
      act(() => comment.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
      expect(dialog()).not.toBeNull();
      click(action('selection.locate'));
      expect(callbacks.locate).toHaveBeenLastCalledWith(excerpt, expect.any(Function));
    }
    expect(callbacks.update).not.toHaveBeenCalled();
    expect(callbacks.outerKey).not.toHaveBeenCalled();
    expect(useContextStore.getState().contexts).toEqual([]);
  });

  it('keeps the sent snapshot read-only when the input contains an edited copy with the same ID', () => {
    const draft = { ...excerpt, comment: 'Unsent draft revision' };
    useContextStore.getState().replaceContexts([draft]);
    sessionComposerStore.getState().setContexts('main', [draft]);
    act(() => root.render(<>
      <UserMessagePresentationContent presentation={withConversationExcerpts(null, [excerpt])} />
      <ChatInputAttachments contexts={[draft]} surfaceEpoch={getActiveSurfaceScope().epoch}
        onUpdate={callbacks.update} onRemove={callbacks.remove} />
    </>));
    click(container.querySelector<HTMLButtonElement>('button[aria-label="Annotation 1"]')!);
    expect(dialog()!.querySelector('[data-openbitfun-product-part="comment"]')!.textContent).toBe('First comment');
    expect(dialog()!.querySelector('textarea')).toBeNull();
    click(action('selection.locate'));
    expect(callbacks.locate).toHaveBeenCalledExactlyOnceWith(excerpt, expect.any(Function));
    expect(useContextStore.getState().contexts).toEqual([draft]);
    click(container.querySelector<HTMLButtonElement>('[data-openbitfun-product-part="attachment"]')!);
    click(trigger(1));
    expect(dialog()!.querySelector('textarea')!.value).toBe('Unsent draft revision');
    typeComment('Continue editing draft');
    click(action('selection.save'));
    expect(callbacks.update).toHaveBeenCalledExactlyOnceWith(excerpt.id, 'Continue editing draft');
  });

  it('shows only the source quote and locate action for a sent annotation without a comment', () => {
    act(() => root.render(<ConversationExcerptPreview excerpt={{ ...excerpt, comment: undefined }} />));
    click(container.querySelector<HTMLButtonElement>('button[aria-label="Annotation 1"]')!);
    expect(dialog()!.querySelector('textarea, input, [data-openbitfun-product-part="comment"]')).toBeNull();
    expect(dialog()!.querySelector('[data-openbitfun-product-part="quote"]')!.textContent).toBe(excerpt.fragments[0].text);
    expect(action('selection.locate')).toBeDefined();
  });

  it('opens the same editor from source and attachment and reads the latest draft from either entry', () => {
    useContextStore.getState().replaceContexts([excerpt]);
    sessionComposerStore.getState().setContexts('main', [excerpt]);
    act(() => root.render(<LinkedComposer />));
    const source = container.querySelector<HTMLButtonElement>('[data-openbitfun-product-part="superscript"]')!;
    const attachment = () => container.querySelector<HTMLButtonElement>('[data-openbitfun-product-part="attachment"]')!;
    click(source);
    const actions = [...dialog()!.querySelectorAll('button')].map(button => button.textContent);
    expect(dialog()!.dataset.openbitfunProductPart).toBe('dialog');
    typeComment('From the source');
    click(action('selection.save'));
    expect(useContextStore.getState().contexts).toEqual([{ ...excerpt, comment: 'From the source' }]);
    expect(sessionComposerStore.getState().getDraft('main').contexts).toEqual([{ ...excerpt, comment: 'From the source' }]);
    click(attachment());
    click(trigger(1));
    expect(dialog()!.querySelector('textarea')!.value).toBe('From the source');
    expect([...dialog()!.querySelectorAll('button')].map(button => button.textContent)).toEqual(actions);
    typeComment('From the attachment');
    click(action('selection.save'));
    click(source);
    expect(dialog()!.querySelector('textarea')!.value).toBe('From the attachment');
    typeComment('Cancelled change');
    click(action('selection.cancel'));
    expect(useContextStore.getState().contexts).toEqual([{ ...excerpt, comment: 'From the attachment' }]);
  });

  it('locates from an attachment and saves dirty text once before locating', () => {
    act(() => root.render(<Composer />));
    click(trigger(1));
    click(action('selection.locate'));
    expect(callbacks.update).not.toHaveBeenCalled();
    expect(callbacks.locate).toHaveBeenCalledExactlyOnceWith(excerpt, expect.any(Function));
    click(trigger(1));
    typeComment('  Save before navigating  ');
    click(action('selection.saveAndLocate'));
    expect(callbacks.update).toHaveBeenCalledExactlyOnceWith(excerpt.id, 'Save before navigating');
    expect(callbacks.locate).toHaveBeenLastCalledWith({ ...excerpt, comment: 'Save before navigating' }, expect.any(Function));
    expect(dialog()).toBeNull();
  });

  it('removes from a source marker dialog and clears the linked draft and composer attachment', () => {
    useContextStore.getState().replaceContexts([image, excerpt, second]);
    sessionComposerStore.getState().setContexts('main', [image, excerpt, second]);
    act(() => root.render(<LinkedComposer />));
    click(container.querySelector<HTMLButtonElement>('[data-openbitfun-product-part="superscript"]')!);
    typeComment('Do not save this edit');
    click(action('selection.remove'));
    expect(dialog()).toBeNull();
    expect(useContextStore.getState().contexts).toEqual([image, second]);
    expect(sessionComposerStore.getState().getDraft('main').contexts).toEqual([image, second]);
    expect(trigger(1)).toBeNull();
    expect(trigger(2)).not.toBeNull();
    expect(container.querySelector('img')?.alt).toBe('Photo.png');
  });

  it('removes directly from the attachment editor without saving unsent edits', () => {
    act(() => root.render(<Composer />));
    click(trigger(1));
    typeComment('Do not save this edit');
    click(action('selection.remove'));
    expect(dialog()).toBeNull();
    expect(callbacks.remove).toHaveBeenCalledExactlyOnceWith(excerpt.id);
    expect(callbacks.update).not.toHaveBeenCalled();
    expect(trigger(1)).toBeNull();
    expect(trigger(2)).not.toBeNull();
  });

  it('keeps an unavailable editor open and rejects navigation after the surface activation changed', () => {
    act(() => root.render(<Composer />));
    click(trigger(1));
    activateSurface('local');
    click(action('selection.locate'));
    expect(callbacks.locate).not.toHaveBeenCalled();
    expect(callbacks.warn).toHaveBeenCalledWith('selection.editUnavailable');
    expect(dialog()).not.toBeNull();
    click(action('selection.remove'));
    expect(callbacks.remove).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
  });
});
