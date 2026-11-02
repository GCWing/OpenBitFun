/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HarnessProfileSelector } from './HarnessProfileSelector';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; name?: string }) =>
      key === 'chatInput.harness.modeLabel'
        ? `${options?.name} mode`
        : options?.defaultValue ?? key,
  }),
}));

vi.mock('@openbitfun/ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/infrastructure/appearance/runtime/AppearanceOverlayHost', () => ({
  getAppearanceOverlayHost: () => document.body,
}));

const confirmation = vi.hoisted(() => ({ dialog: vi.fn(async () => true) }));

vi.mock('@/infrastructure/confirm-dialog', () => ({
  confirmDialog: confirmation.dialog,
}));

const notify = vi.hoisted(() => ({ info: vi.fn() }));

vi.mock('@/shared/notification-system', () => ({
  notificationService: notify,
}));

function density(scope: ParentNode): number {
  const mark = scope.querySelector<HTMLElement>(
    '.openbitfun-harness-selector__density-mark',
  );
  return Number(mark?.dataset.harnessDensity ?? 0);
}

describe('HarnessProfileSelector', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.querySelector('.openbitfun-harness-selector__menu')?.remove();
    vi.clearAllMocks();
  });

  it('keeps the active Harness icon out of the ChatInput trigger', async () => {
    await act(async () => {
      root.render(
        <HarnessProfileSelector
          selectedProfile='Standard'
          onSelectProfile={vi.fn()}
        />,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="harness-profile-selector"]',
    );
    expect(trigger?.querySelector('.openbitfun-harness-selector__density-mark')).toBeNull();
    expect(trigger?.textContent).toBe('chatInput.harness.profiles.Standard.name mode');
    expect(trigger?.dataset.harnessPending).toBeUndefined();
    expect(
      container.querySelector('[data-testid="harness-profile-pending-dot"]'),
    ).toBeNull();
  });

  it('renders the authoritative selected profile without a pending projection', async () => {
    await act(async () => {
      root.render(<HarnessProfileSelector selectedProfile='Minimal' onSelectProfile={vi.fn()} />);
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="harness-profile-selector"]',
    );
    expect(trigger?.querySelector('.openbitfun-harness-selector__density-mark')).toBeNull();
    expect(trigger?.dataset.harnessPending).toBeUndefined();
    expect(
      container.querySelector('[data-testid="harness-profile-pending-dot"]'),
    ).toBeNull();
  });

  it('preserves an unknown future profile without pretending it is balanced', async () => {
    await act(async () => {
      root.render(
        <HarnessProfileSelector selectedProfile="future-profile" onSelectProfile={vi.fn()} />,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="harness-profile-selector"]',
    );
    expect(trigger?.querySelector('.openbitfun-harness-selector__density-mark')).toBeNull();
    expect(trigger?.textContent).toContain('chatInput.harness.unsupportedProfile');
  });

  it('disables profile selection while the authoritative update is in flight', async () => {
    await act(async () => {
      root.render(
        <HarnessProfileSelector
          disabled
          selectedProfile='Minimal'
          onSelectProfile={vi.fn()}
        />,
      );
    });

    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="harness-profile-selector"]')
        ?.disabled,
    ).toBe(true);
  });

  it('portals the menu-item picker outside its parent scroll boundary and closes it after an Agent choice', async () => {
    const onSelectAgent = vi.fn();
    const onSelectionComplete = vi.fn();
    await act(async () => {
      root.render(
        <div data-testid="parent-add-menu">
          <HarnessProfileSelector
            presentation="menu-item"
            selectedProfile='Standard'
            otherAgents={[{ id: 'DeepResearch', name: 'Deep Research' }]}
            onSelectProfile={vi.fn()}
            onSelectAgent={onSelectAgent}
            onSelectionComplete={onSelectionComplete}
          />
        </div>,
      );
    });

    const selectorRoot = container.querySelector<HTMLElement>(
      '[data-openbitfun-component="harness-selector"][data-openbitfun-part="root"]',
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="harness-profile-selector"]',
    );
    expect(selectorRoot?.dataset.openbitfunPresentation).toBe('menu-item');
    expect(selectorRoot?.dataset.openbitfunProfile).toBe('Standard');
    expect(trigger?.querySelector('.openbitfun-harness-selector__trigger-chevron')).not.toBeNull();
    const triggerMark = trigger?.querySelector<HTMLElement>(
      '.openbitfun-harness-selector__density-mark',
    );
    expect(triggerMark?.dataset.harnessProfile).toBe('Standard');
    expect(triggerMark?.dataset.harnessDensity).toBe('2');
    expect(triggerMark?.querySelector('[data-openbitfun-name="standard"][data-size="md"]')).not.toBeNull();
    expect(
      trigger?.querySelector('[data-openbitfun-part="label"]')?.textContent,
    ).toBe('chatInput.harness.profiles.Standard.name');
    expect(trigger?.textContent).not.toContain('chatInput.harness.menuLabel');
    expect(trigger?.textContent).not.toContain('chatInput.current');
    expect(trigger?.getAttribute('aria-controls')).toBeTruthy();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const menu = document.querySelector<HTMLElement>('.openbitfun-harness-selector__menu');
    expect(menu).not.toBeNull();
    expect(menu?.dataset.openbitfunPlacement).toBe('side');
    expect(menu?.id).toBe(trigger?.getAttribute('aria-controls'));
    expect(menu?.querySelector('[data-testid="harness-new-session-notice"]')).toBeNull();
    expect(container.querySelector('[data-testid="parent-add-menu"]')?.contains(menu ?? null))
      .toBe(false);
    expect(document.body.contains(menu)).toBe(true);

    const parentOutsideMouseDown = vi.fn();
    document.addEventListener('mousedown', parentOutsideMouseDown);
    await act(async () => {
      menu?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    document.removeEventListener('mousedown', parentOutsideMouseDown);
    expect(parentOutsideMouseDown).not.toHaveBeenCalled();

    await act(async () => {
      menu?.querySelector<HTMLButtonElement>('[data-testid="harness-profile-other"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(menu?.dataset.openbitfunPage).toBe('agents');
    expect(
      menu?.querySelector('[data-testid="harness-agent-DeepResearch"] [data-openbitfun-name="user"][data-size="md"]'),
    ).not.toBeNull();
    expect(onSelectionComplete).not.toHaveBeenCalled();

    await act(async () => {
      menu?.querySelector<HTMLButtonElement>('[data-testid="harness-agent-DeepResearch"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelectAgent).toHaveBeenCalledWith('DeepResearch');
    expect(onSelectionComplete).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.openbitfun-harness-selector__menu')).toBeNull();
  });

  it('opens the menu-item picker with Right Arrow and returns focus with Left Arrow', async () => {
    await act(async () => {
      root.render(
        <HarnessProfileSelector
          presentation="menu-item"
          selectedProfile='Standard'
          onSelectProfile={vi.fn()}
        />,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="harness-profile-selector"]',
    );
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    const menu = document.querySelector<HTMLElement>('.openbitfun-harness-selector__menu');
    expect(menu).not.toBeNull();

    await act(async () => {
      menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });
    expect(document.querySelector('.openbitfun-harness-selector__menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('offers three Harness gears, Creative, and the second-level Agents entry', async () => {
    await act(async () => {
      root.render(
        <HarnessProfileSelector
          selectedProfile='Standard'
          otherAgents={[
            { id: 'DeepResearch', name: 'Deep Research' },
            { id: 'Cowork', name: 'Cowork' },
            { id: 'Plan', name: 'Plan' },
          ]}
          onSelectProfile={vi.fn()}
        />,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="harness-profile-selector"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const menu = document.querySelector<HTMLElement>('.openbitfun-harness-selector__menu');
    expect(menu).not.toBeNull();
    const rows = Array.from(menu!.querySelectorAll<HTMLElement>('[data-openbitfun-part="profile"]'));
    expect(rows.map(row => row.dataset.openbitfunProfile)).toEqual([
      'Minimal',
      'Standard',
      'Ultimate',
      'Creative',
      'other',
    ]);
    expect(rows.map(row => density(row))).toEqual([1, 2, 3, 0, 0]);
    expect(rows.slice(0, 4).map(row => row.querySelector<HTMLElement>(
      '.openbitfun-harness-selector__density-mark [data-openbitfun-component="icon"]',
    )?.dataset.openbitfunName)).toEqual(['minimal', 'standard', 'ultimate', 'creative']);
    expect(menu?.querySelector('.openbitfun-harness-selector__density-core')).toBeNull();
    expect(menu?.querySelector('.openbitfun-harness-selector__profile-promise')).toBeNull();
    const creative = rows[3];
    expect(creative?.querySelector('.openbitfun-harness-selector__density-core')).toBeNull();
    expect(creative?.querySelector('[data-openbitfun-name="creative"][data-size="md"]')).not.toBeNull();
    expect(creative?.dataset.openbitfunState).toBe('available');
    const other = rows[4];
    expect(other?.querySelector('.openbitfun-harness-selector__density-core')).toBeNull();
    expect(other?.querySelector('[data-openbitfun-name="user"][data-size="md"]')).not.toBeNull();
    expect(other?.querySelector('.openbitfun-harness-selector__agent-count')?.textContent).toBe('3');
    expect(rows[1]?.dataset.openbitfunState).toBe('current');
  });

  it('opens Agents as a second level and selects a main Agent without a separate chip', async () => {
    const onSelectAgent = vi.fn();
    await act(async () => {
      root.render(
        <HarnessProfileSelector
          selectedProfile='Standard'
          otherAgents={[
            { id: 'DeepResearch', name: 'Deep Research' },
            { id: 'Cowork', name: 'Cowork' },
            { id: 'Plan', name: 'Plan' },
          ]}
          onSelectProfile={vi.fn()}
          onSelectAgent={onSelectAgent}
        />,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="harness-profile-selector"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="harness-profile-other"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const menu = document.querySelector<HTMLElement>('.openbitfun-harness-selector__menu');
    expect(menu?.dataset.openbitfunPage).toBe('agents');
    expect(Array.from(menu!.querySelectorAll<HTMLElement>('[data-openbitfun-part="agent"]')).map(
      row => row.dataset.openbitfunAgentId,
    )).toEqual(['DeepResearch', 'Cowork', 'Plan']);

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="harness-agent-DeepResearch"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelectAgent).toHaveBeenCalledWith('DeepResearch');
    expect(document.querySelector('.openbitfun-harness-selector__menu')).toBeNull();

    await act(async () => {
      root.render(
        <HarnessProfileSelector
          selectedProfile="other"
          selectedAgentId="DeepResearch"
          otherAgents={[{ id: 'DeepResearch', name: 'Deep Research' }]}
          onSelectProfile={vi.fn()}
          onSelectAgent={onSelectAgent}
        />,
      );
    });
    expect(
      container.querySelector('[data-testid="harness-profile-selector"]')?.textContent,
    ).toBe('Deep Research');
  });

  it('activates every implemented profile including Creative', async () => {
    const onSelectProfile = vi.fn();
    await act(async () => {
      root.render(<HarnessProfileSelector selectedProfile='Standard' onSelectProfile={onSelectProfile} />);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="harness-profile-selector"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="harness-profile-Ultimate"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelectProfile).toHaveBeenCalledWith('Ultimate');
    expect(onSelectProfile).toHaveBeenCalledTimes(1);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="harness-profile-selector"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="harness-profile-Creative"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(notify.info).not.toHaveBeenCalled();
    expect(onSelectProfile).toHaveBeenCalledTimes(2);
    expect(onSelectProfile).toHaveBeenLastCalledWith('Creative');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="harness-profile-selector"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="harness-profile-Minimal"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelectProfile).toHaveBeenCalledTimes(3);
    expect(onSelectProfile).toHaveBeenLastCalledWith('Minimal');
    expect(onSelectProfile).toHaveBeenCalledWith('Minimal');
    expect(document.querySelector('.openbitfun-harness-selector__menu')).toBeNull();
  });

  it('confirms a new Session after a profile choice in a started Session', async () => {
    const onSelectProfile = vi.fn();
    const onStartNewSession = vi.fn();
    await act(async () => {
      root.render(
        <HarnessProfileSelector
          sessionStarted
          selectedProfile='Standard'
          otherAgents={[{ id: 'Plan', name: 'Plan' }]}
          onSelectProfile={onSelectProfile}
          onStartNewSession={onStartNewSession}
        />,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="harness-profile-selector"]',
    );
    expect(trigger?.dataset.harnessLocked).toBe('true');
    expect(trigger?.dataset.harnessFixed).toBe('true');
    expect(trigger?.disabled).toBe(false);
    expect(trigger?.textContent).toBe('chatInput.harness.profiles.Standard.name mode');

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const menu = document.querySelector<HTMLElement>('.openbitfun-harness-selector__menu');
    expect(menu).not.toBeNull();
    expect(menu?.dataset.openbitfunPage).toBe('profiles');
    expect(menu?.querySelector('[data-testid="harness-new-session-notice"]')).toBeNull();
    expect(menu?.querySelector('[data-testid="harness-session-summary"]')).toBeNull();
    expect(menu?.querySelector('[data-testid="harness-start-new-session"]')).toBeNull();
    expect(
      menu?.querySelector<HTMLButtonElement>('[data-testid="harness-profile-Minimal"]')
        ?.getAttribute('role'),
    ).toBe('menuitem');
    expect(
      menu?.querySelector<HTMLElement>('[data-testid="harness-profile-Minimal"]')
        ?.dataset.openbitfunState,
    ).toBe('available');

    await act(async () => {
      menu?.querySelector<HTMLButtonElement>('[data-testid="harness-profile-Minimal"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelectProfile).not.toHaveBeenCalled();
    expect(confirmation.dialog).toHaveBeenCalledWith({
      title: 'chatInput.harness.newSessionConfirmation.title',
      message: 'chatInput.harness.newSessionConfirmation.message',
      confirmText: 'chatInput.harness.newSessionConfirmation.confirm',
    });
    expect(onStartNewSession).toHaveBeenCalledWith(
      { kind: 'profile', id: 'Minimal' },
    );
    expect(document.querySelector('.openbitfun-harness-selector__menu')).toBeNull();
  });

  it('creates a new Session from a different main Agent without mutating the current Agent', async () => {
    const onSelectAgent = vi.fn();
    const onStartNewSession = vi.fn();
    await act(async () => {
      root.render(
        <HarnessProfileSelector
          sessionStarted
          selectedProfile="other"
          selectedAgentId="Plan"
          otherAgents={[
            { id: 'Plan', name: 'Plan' },
            { id: 'Cowork', name: 'Cowork' },
          ]}
          onSelectProfile={vi.fn()}
          onSelectAgent={onSelectAgent}
          onStartNewSession={onStartNewSession}
        />,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="harness-profile-selector"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('.openbitfun-harness-selector__menu')?.getAttribute('data-openbitfun-page'))
      .toBe('profiles');
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="harness-profile-other"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      document.querySelector<HTMLElement>('[data-testid="harness-agent-Plan"]')?.dataset.openbitfunState,
    ).toBe('available');
    expect(
      document.querySelector<HTMLElement>('[data-testid="harness-agent-Cowork"]')?.dataset.openbitfunState,
    ).toBe('available');

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="harness-agent-Cowork"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelectAgent).not.toHaveBeenCalled();
    expect(confirmation.dialog).toHaveBeenCalledWith({
      title: 'chatInput.harness.newSessionConfirmation.title',
      message: 'chatInput.harness.newSessionConfirmation.message',
      confirmText: 'chatInput.harness.newSessionConfirmation.confirm',
    });
    expect(onStartNewSession).toHaveBeenCalledWith(
      { kind: 'agent', id: 'Cowork' },
    );
  });

  it('keeps the current Session unchanged when new-Session confirmation is cancelled', async () => {
    confirmation.dialog.mockResolvedValueOnce(false);
    const onStartNewSession = vi.fn();
    await act(async () => {
      root.render(
        <HarnessProfileSelector
          sessionStarted
          selectedProfile='Standard'
          onSelectProfile={vi.fn()}
          onStartNewSession={onStartNewSession}
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="harness-profile-selector"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="harness-profile-Ultimate"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(confirmation.dialog).toHaveBeenCalledTimes(1);
    expect(onStartNewSession).not.toHaveBeenCalled();
    expect(document.querySelector('.openbitfun-harness-selector__menu')).toBeNull();
  });

  it.each(['Creative'] as const)(
    'presents a persisted %s profile as active',
    async (profileId) => {
      await act(async () => {
        root.render(<HarnessProfileSelector selectedProfile={profileId} onSelectProfile={vi.fn()} />);
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="harness-profile-selector"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      const profile = document.querySelector<HTMLButtonElement>(
        `[data-testid="harness-profile-${profileId}"]`,
      );
      expect(profile?.dataset.openbitfunState).toBe('current');
      expect(profile?.getAttribute('aria-checked')).toBe('true');
    },
  );

  it('keeps a legacy Session fixed while offering the same new-Session path', async () => {
    const onSelectProfile = vi.fn();
    const onStartNewSession = vi.fn();
    await act(async () => {
      root.render(
        <HarnessProfileSelector
          legacySession
          selectedProfile='Standard'
          onSelectProfile={onSelectProfile}
          onStartNewSession={onStartNewSession}
        />,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="harness-profile-selector"]',
    );
    expect(trigger?.dataset.harnessLegacy).toBe('true');
    expect(trigger?.dataset.harnessPending).toBeUndefined();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="harness-profile-Standard"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelectProfile).not.toHaveBeenCalled();
    expect(onStartNewSession).toHaveBeenCalledWith(
      { kind: 'profile', id: 'Standard' },
    );
    expect(notify.info).not.toHaveBeenCalled();
  });
});
