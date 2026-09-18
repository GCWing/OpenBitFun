/** @vitest-environment jsdom */

import React, { useRef, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BranchQuickSwitch } from './BranchQuickSwitch';

const mocks = vi.hoisted(() => ({
  addFiles: vi.fn(),
  checkoutBranch: vi.fn(),
  commit: vi.fn(),
  emit: vi.fn(),
  getBranches: vi.fn(),
  getDiff: vi.fn(),
  getState: vi.fn(),
  notificationError: vi.fn(),
  notificationSuccess: vi.fn(),
  refresh: vi.fn(async () => undefined),
}));

vi.mock('@/infrastructure/appearance/runtime/AppearanceOverlayHost', () => ({
  getAppearanceOverlayHost: () => document.body,
}));

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, string>) => {
      const labels: Record<string, string> = {
        'quickSwitch.conflict.cancel': 'Cancel',
        'quickSwitch.conflict.commitAction': 'Commit and switch',
        'quickSwitch.conflict.commitAndSwitch': 'Commit and switch branch…',
        'quickSwitch.conflict.commitDescription': `Commit all changes before ${options?.branch ?? ''}`,
        'quickSwitch.conflict.commitMessageLabel': 'Commit message',
        'quickSwitch.conflict.commitMessagePlaceholder': 'Enter commit message...',
        'quickSwitch.conflict.commitTitle': `Commit and switch to ${options?.branch ?? ''}`,
        'quickSwitch.conflict.description': 'These files would be overwritten:',
        'quickSwitch.conflict.instruction': 'Please commit to continue.',
        'quickSwitch.conflict.retryFailed': `Retry failed: ${options?.error ?? ''}`,
        'quickSwitch.conflict.retrySwitchAction': 'Retry switch',
        'quickSwitch.conflict.title': 'Commit changes to switch branch',
        'quickSwitch.menuLabel': 'Switch branch',
        'quickSwitch.searchLabel': 'Search branches',
      };
      return labels[key] ?? key;
    },
  }),
}));

vi.mock('@/shared/notification-system/services/NotificationService', () => ({
  notificationService: {
    error: mocks.notificationError,
    success: mocks.notificationSuccess,
  },
}));

vi.mock('@/tools/git/services', () => ({
  gitEventService: { emit: mocks.emit },
  gitService: {
    addFiles: mocks.addFiles,
    checkoutBranch: mocks.checkoutBranch,
    commit: mocks.commit,
    getBranches: mocks.getBranches,
    getDiff: mocks.getDiff,
  },
}));

vi.mock('@/tools/git/state/GitStateManager', () => ({
  gitStateManager: {
    getState: mocks.getState,
    refresh: mocks.refresh,
  },
}));

const branches = [
  { name: 'main', current: true, remote: false, ahead: 0, behind: 0 },
  { name: 'feature', current: false, remote: false, ahead: 0, behind: 0 },
];

function Harness({ onSwitchSuccess, initiallyOpen = true, blockMessagePointer = false }: {
  onSwitchSuccess?: (branch: string) => void;
  initiallyOpen?: boolean;
  blockMessagePointer?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchorRef} type="button" data-testid="branch-trigger"
        aria-expanded={open} onClick={() => setOpen(current => !current)}>branch</button>
      <div data-testid="flowchat-messages" onPointerDownCapture={event => {
        // FlowChat guards the message area during history transitions.
        if (blockMessagePointer) event.stopPropagation();
      }}>
        <div data-testid="message-blank" />
        <input aria-label="Outside input" />
      </div>
      <BranchQuickSwitch
        isOpen={open}
        onClose={() => setOpen(false)}
        repositoryPath={{ workspaceId: 'workspace-1' }}
        currentBranch="main"
        anchorRef={anchorRef}
        onSwitchSuccess={onSwitchSuccess}
      />
    </>
  );
}

describe('BranchQuickSwitch', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    vi.clearAllMocks();
    mocks.getState.mockReturnValue({ branches, staged: [], unstaged: [], untracked: [], conflicts: [] });
    mocks.getBranches.mockResolvedValue(branches);
    mocks.getDiff.mockResolvedValue('');
    mocks.addFiles.mockResolvedValue({ success: true });
    mocks.commit.mockResolvedValue({ success: true });
    const media = new EventTarget();
    Object.defineProperty(media, 'matches', { value: true });
    vi.stubGlobal('matchMedia', () => media);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.querySelectorAll('[data-testid="branch-quick-switch"], [data-testid="branch-switch-conflict-dialog"], [data-testid="branch-switch-commit-dialog"]')
      .forEach(node => node.remove());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the design-system search field as one labeled visual surface', async () => {
    await act(async () => {
      root.render(<Harness onSwitchSuccess={vi.fn()} />);
    });

    const searchField = document.querySelector('[data-openbitfun-component="search-field"]');
    const fieldSurface = searchField?.querySelector('[data-openbitfun-component="input"]');
    const input = searchField?.querySelector<HTMLInputElement>('input[type="search"]');

    expect(searchField).not.toBeNull();
    expect(fieldSurface).not.toBeNull();
    expect(input?.getAttribute('aria-label')).toBe('Search branches');
    expect(input?.classList.contains('branch-quick-switch__input')).toBe(false);
  });

  it('keeps the selected current branch readable instead of applying disabled colors', async () => {
    await act(async () => {
      root.render(<Harness onSwitchSuccess={vi.fn()} />);
    });
    await vi.waitFor(() => expect(
      document.querySelector('[data-testid="branch-quick-switch-option-main"]'),
    ).not.toBeNull());

    const currentBranch = document.querySelector<HTMLButtonElement>(
      '[data-testid="branch-quick-switch-option-main"]',
    );
    expect(currentBranch?.getAttribute('aria-selected')).toBe('true');
    expect(currentBranch?.dataset.openbitfunState).toBe('current');
    expect(currentBranch?.disabled).toBe(false);
  });

  it('dismisses on the first message-area press even when FlowChat stops propagation', async () => {
    await act(async () => root.render(<Harness blockMessagePointer />));
    const blank = container.querySelector('[data-testid="message-blank"]')!;
    act(() => blank.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(container.querySelector('[data-testid="branch-trigger"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-testid="branch-quick-switch"]')).toBeNull();
  });

  it('focuses search when positioned and leaves outside focus and clicks alone', async () => {
    await act(async () => root.render(<Harness />));
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(document.activeElement).toBe(search);
    act(() => search.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(container.querySelector('[data-testid="branch-trigger"]')?.getAttribute('aria-expanded')).toBe('true');

    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="branch-trigger"]')!;
    const focusTrigger = vi.spyOn(trigger, 'focus');
    const outside = container.querySelector('input')!;
    const onClick = vi.fn();
    outside.addEventListener('click', onClick);
    act(() => {
      outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      outside.focus();
      outside.click();
    });
    expect(document.activeElement).toBe(outside);
    expect(focusTrigger).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledOnce();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('preserves IME Escape and restores the branch trigger on ordinary Escape', async () => {
    await act(async () => root.render(<Harness />));
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="branch-trigger"]')!;
    act(() => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    act(() => search.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    const composingEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => search.dispatchEvent(composingEscape));
    expect(composingEscape.defaultPrevented).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    act(() => search.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    act(() => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on Tab without cancelling the page tab sequence', async () => {
    await act(async () => root.render(<Harness />));
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="branch-trigger"]')!;
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => search.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  describe('motion lifecycle', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      const media = new EventTarget();
      Object.defineProperty(media, 'matches', { value: false });
      vi.stubGlobal('matchMedia', () => media);
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
        const anchor = this.getAttribute('data-testid') === 'branch-trigger';
        return { x: 100, y: anchor ? 460 : 100, left: 100, top: anchor ? 460 : 100,
          width: anchor ? 80 : 280, height: anchor ? 18 : 326,
          right: anchor ? 180 : 380, bottom: anchor ? 478 : 426, toJSON: () => ({}) } as DOMRect;
      });
    });
    afterEach(() => vi.useRealTimers());

    async function openPicker(blockMessagePointer = false) {
      await act(async () => root.render(<Harness initiallyOpen={false} blockMessagePointer={blockMessagePointer} />));
      const trigger = container.querySelector<HTMLButtonElement>('[data-testid="branch-trigger"]')!;
      await act(async () => { trigger.focus(); trigger.click(); });
      const panel = document.querySelector<HTMLElement>('[data-testid="branch-quick-switch"]')!;
      const layer = panel.parentElement!;
      expect(layer.dataset.state).toBe('entering');
      act(() => vi.advanceTimersByTime(48));
      expect(layer.dataset.state).toBe('entered');
      return { trigger, panel, layer, search: panel.querySelector('input')! };
    }

    it('keeps exit geometry and filtered content until unmount, with no second press', async () => {
      const { trigger, panel, layer, search } = await openPicker(true);
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'feature');
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const blank = container.querySelector('[data-testid="message-blank"]')!;
      act(() => blank.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(layer.dataset.state).toBe('exiting');
      expect(layer.hasAttribute('inert')).toBe(true);
      expect(layer.getAttribute('aria-hidden')).toBe('true');
      expect(layer.style.visibility).toBe('visible');
      expect(layer.style.bottom).toBe('315px');
      expect(search.value).toBe('feature');
      expect(panel.querySelector('[data-testid="branch-quick-switch-option-main"]')).toBeNull();
      act(() => vi.advanceTimersByTime(99));
      expect(layer.isConnected).toBe(true);
      act(() => vi.advanceTimersByTime(1));
      expect(layer.isConnected).toBe(false);
      await act(async () => trigger.click());
      expect(document.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe('');
    });

    it('treats the trigger as inside and reverses an interrupted exit on the same surface', async () => {
      const { trigger, panel, layer, search } = await openPicker();
      act(() => trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      act(() => trigger.click());
      expect(layer.dataset.state).toBe('exiting');
      act(() => vi.advanceTimersByTime(50));
      await act(async () => trigger.click());
      expect(layer.dataset.state).toBe('entered');
      expect(layer.hasAttribute('inert')).toBe(false);
      expect(document.activeElement).toBe(search);
      act(() => vi.advanceTimersByTime(150));
      expect(document.querySelector('[data-testid="branch-quick-switch"]')).toBe(panel);
      expect(layer.style.bottom).toBe('315px');
    });
  });

  it('checks out a selected branch and publishes the shared branch-change event', async () => {
    const onSwitchSuccess = vi.fn();
    mocks.checkoutBranch.mockResolvedValue({ success: true });

    await act(async () => {
      root.render(<Harness onSwitchSuccess={onSwitchSuccess} />);
    });
    await vi.waitFor(() => expect(
      document.querySelector('[data-testid="branch-quick-switch-option-feature"]'),
    ).not.toBeNull());

    await act(async () => {
      document.querySelector<HTMLButtonElement>(
        '[data-testid="branch-quick-switch-option-feature"]',
      )?.click();
    });

    expect(mocks.checkoutBranch).toHaveBeenCalledWith({ workspaceId: 'workspace-1' }, 'feature');
    expect(mocks.emit).toHaveBeenCalledWith('branch:changed', expect.objectContaining({
      repositoryPath: { workspaceId: 'workspace-1' },
      branch: expect.objectContaining({ name: 'feature', current: true }),
    }));
    expect(onSwitchSuccess).toHaveBeenCalledWith('feature');
    expect(document.querySelector('[data-testid="branch-quick-switch"]')).toBeNull();
  });

  it('shows the blocking files, then commits and retries the intended switch', async () => {
    const onSwitchSuccess = vi.fn();
    mocks.checkoutBranch
      .mockResolvedValueOnce({
        success: false,
        error: [
          'error: Your local changes to the following files would be overwritten by checkout:',
          '\tSECURITY.md',
          'Please commit your changes or stash them before you switch branches.',
          'Aborting',
        ].join('\n'),
      })
      .mockResolvedValueOnce({ success: true });
    mocks.getDiff
      .mockResolvedValueOnce([
        'diff --git a/SECURITY.md b/SECURITY.md',
        '--- a/SECURITY.md',
        '+++ b/SECURITY.md',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n'))
      .mockResolvedValueOnce('');

    await act(async () => {
      root.render(<Harness onSwitchSuccess={onSwitchSuccess} />);
    });
    await vi.waitFor(() => expect(
      document.querySelector('[data-testid="branch-quick-switch-option-feature"]'),
    ).not.toBeNull());

    await act(async () => {
      document.querySelector<HTMLButtonElement>(
        '[data-testid="branch-quick-switch-option-feature"]',
      )?.click();
    });

    await vi.waitFor(() => {
      const dialog = document.querySelector('[data-testid="branch-switch-conflict-dialog"]');
      expect(dialog?.textContent).toContain('SECURITY.md');
      expect(dialog?.textContent).toContain('+1');
      expect(dialog?.textContent).toContain('−1');
    });

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="branch-switch-conflict-confirm"]')?.click();
    });
    expect(document.querySelector('[data-testid="branch-switch-commit-dialog"]')).not.toBeNull();

    const messageInput = document.querySelector<HTMLInputElement>('input[aria-label="Commit message"]');
    await act(async () => {
      if (messageInput) {
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;
        valueSetter?.call(messageInput, 'Save work before branch switch');
        messageInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    await act(async () => {
      document.querySelector<HTMLButtonElement>(
        '[data-testid="branch-switch-commit-confirm"]',
      )?.click();
    });

    expect(mocks.addFiles).toHaveBeenCalledWith({ workspaceId: 'workspace-1' }, { files: [], all: true });
    expect(mocks.commit).toHaveBeenCalledWith({ workspaceId: 'workspace-1' }, {
      message: 'Save work before branch switch',
    });
    expect(mocks.checkoutBranch).toHaveBeenCalledTimes(2);
    expect(mocks.checkoutBranch).toHaveBeenLastCalledWith({ workspaceId: 'workspace-1' }, 'feature');
    expect(onSwitchSuccess).toHaveBeenCalledWith('feature');
    expect(document.querySelector('[data-testid="branch-switch-commit-dialog"]')).toBeNull();
  });

  it('retries checkout without creating a duplicate commit', async () => {
    const onSwitchSuccess = vi.fn();
    mocks.checkoutBranch
      .mockResolvedValueOnce({
        success: false,
        error: [
          'error: Your local changes to the following files would be overwritten by checkout:',
          '\tSECURITY.md',
          'Please commit your changes or stash them before you switch branches.',
          'Aborting',
        ].join('\n'),
      })
      .mockResolvedValueOnce({ success: false, error: 'remote temporarily unavailable' })
      .mockResolvedValueOnce({ success: true });

    await act(async () => {
      root.render(<Harness onSwitchSuccess={onSwitchSuccess} />);
    });
    await vi.waitFor(() => expect(
      document.querySelector('[data-testid="branch-quick-switch-option-feature"]'),
    ).not.toBeNull());

    await act(async () => {
      document.querySelector<HTMLButtonElement>(
        '[data-testid="branch-quick-switch-option-feature"]',
      )?.click();
    });
    await vi.waitFor(() => expect(
      document.querySelector('[data-testid="branch-switch-conflict-dialog"]'),
    ).not.toBeNull());
    await act(async () => {
      document.querySelector<HTMLButtonElement>(
        '[data-testid="branch-switch-conflict-confirm"]',
      )?.click();
    });

    const messageInput = document.querySelector<HTMLInputElement>('input[aria-label="Commit message"]');
    await act(async () => {
      if (messageInput) {
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;
        valueSetter?.call(messageInput, 'Checkpoint before retry');
        messageInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>(
        '[data-testid="branch-switch-commit-confirm"]',
      )?.click();
    });

    await vi.waitFor(() => expect(mocks.checkoutBranch).toHaveBeenCalledTimes(2));
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="branch-switch-commit-dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain('remote temporarily unavailable');

    await act(async () => {
      document.querySelector<HTMLButtonElement>(
        '[data-testid="branch-switch-commit-confirm"]',
      )?.click();
    });

    await vi.waitFor(() => expect(mocks.checkoutBranch).toHaveBeenCalledTimes(3));
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(onSwitchSuccess).toHaveBeenCalledWith('feature');
  });
});
