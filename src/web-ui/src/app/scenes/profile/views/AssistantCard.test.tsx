// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceInfo } from '@/shared/types';
import AssistantCard from './AssistantCard';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/infrastructure/i18n', () => ({ i18nService: { formatNumber: (n: number) => String(n) } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const workspace = {
  id: 'assistant-1',
  name: 'Research assistant',
  rootPath: '/tmp/assistant-1',
  identity: {
    name: 'Mira',
    emoji: '🧭',
    creature: 'Researcher',
    vibe: 'Methodical and concise',
  },
} as WorkspaceInfo;

describe('AssistantCard actions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps configuration and workspace actions distinct', () => {
    const onConfigure = vi.fn();
    const onClose = vi.fn();
    const onDelete = vi.fn();
    const onSetPrimary = vi.fn();

    act(() => {
      root.render(
        <div role="list">
          <AssistantCard
            workspace={workspace}
            onClick={onConfigure}
            onClose={onClose}
            onDelete={onDelete}
            onSetPrimary={onSetPrimary}
          />
        </div>,
      );
    });

    const card = container.querySelector('[role="listitem"]');
    const configure = container.querySelector('.assistant-card__main') as HTMLButtonElement;
    const closeWorkspace = container.querySelector(
      '[data-openbitfun-part="visibility"]',
    ) as HTMLButtonElement;
    const remove = container.querySelector('[data-openbitfun-part="delete"]') as HTMLButtonElement;
    const setPrimary = container.querySelector('[data-openbitfun-part="setPrimary"]') as HTMLButtonElement;

    expect(card?.tagName).toBe('ARTICLE');
    expect(closeWorkspace.getAttribute('aria-label')).toBe('nursery.card.close');
    expect(closeWorkspace.getAttribute('aria-pressed')).toBe('true');
    expect(configure.getAttribute('aria-label')).toContain('Mira');

    act(() => configure.click());
    expect(onConfigure).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    act(() => closeWorkspace.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfigure).toHaveBeenCalledTimes(1);

    act(() => setPrimary.click());
    expect(onSetPrimary).toHaveBeenCalledTimes(1);
    expect(onConfigure).toHaveBeenCalledTimes(1);

    act(() => remove.click());
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onConfigure).toHaveBeenCalledTimes(1);
  });

  it('disables card actions while setting the primary assistant', () => {
    act(() => {
      root.render(
        <div role="list">
          <AssistantCard
            workspace={workspace}
            onClick={vi.fn()}
            onClose={vi.fn()}
            onDelete={vi.fn()}
            onSetPrimary={vi.fn()}
            isSettingPrimary
          />
        </div>,
      );
    });

    const configure = container.querySelector('.assistant-card__main') as HTMLButtonElement;
    const closeWorkspace = container.querySelector(
      '[data-openbitfun-part="visibility"]',
    ) as HTMLButtonElement;
    const setPrimary = container.querySelector('[data-openbitfun-part="setPrimary"]') as HTMLButtonElement;
    const remove = container.querySelector('[data-openbitfun-part="delete"]') as HTMLButtonElement;
    expect(configure.disabled).toBe(true);
    expect(closeWorkspace.disabled).toBe(true);
    expect(setPrimary.disabled).toBe(true);
    expect(setPrimary.getAttribute('aria-busy')).toBe('true');
    expect(remove.disabled).toBe(true);
  });

  it('reopens a hidden assistant without entering its configuration and blocks repeated opens', () => {
    const onConfigure = vi.fn();
    const onOpen = vi.fn();
    const render = (isOpening = false) => act(() => {
      root.render(
        <AssistantCard
          workspace={workspace}
          onClick={onConfigure}
          onOpen={onOpen}
          isOpening={isOpening}
        />,
      );
    });

    render();
    const visibility = container.querySelector('[data-openbitfun-part="visibility"]') as HTMLButtonElement;
    expect(visibility.getAttribute('aria-label')).toBe('nursery.card.open');
    expect(visibility.getAttribute('aria-pressed')).toBe('false');
    act(() => visibility.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onConfigure).not.toHaveBeenCalled();

    render(true);
    expect(visibility.disabled).toBe(true);
    expect(visibility.getAttribute('aria-busy')).toBe('true');
    act(() => visibility.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('keeps an opened assistant visible when its host cannot close it', () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        <AssistantCard
          workspace={workspace}
          onClick={vi.fn()}
          onClose={onClose}
          closeDisabledReason="This peer host does not support closing assistants"
        />,
      );
    });

    const visibility = container.querySelector('[data-openbitfun-part="visibility"]') as HTMLButtonElement;
    expect(visibility.disabled).toBe(true);
    expect(visibility.getAttribute('aria-pressed')).toBe('true');
    act(() => visibility.click());
    expect(onClose).not.toHaveBeenCalled();
  });
});
