/**
 * @vitest-environment jsdom
 */

import { act, useEffect, useRef, useState, type ComponentProps } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu, MenuItem, Portal, subscribeOverlayInteraction } from '@openbitfun/ui';

import { ChatInputBoostSubmenu } from './ChatInputBoostSubmenu';
import { HarnessProfileSelector } from './HarnessProfileSelector';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/shared/notification-system', () => ({
  notificationService: { info: vi.fn() },
}));

function ControlledSubmenu(props: Omit<ComponentProps<typeof ChatInputBoostSubmenu>, 'open' | 'onOpenChange'>) {
  const [open, setOpen] = useState(false);
  return <ChatInputBoostSubmenu {...props} open={open} onOpenChange={setOpen} />;
}

function SiblingMenus({ onSelectionComplete }: { onSelectionComplete?: () => void }) {
  const [active, setActive] = useState<string | null>(null);
  const disclosure = (id: string) => ({
    open: active === id,
    onOpenChange: (open: boolean) => setActive(current => open ? id : current === id ? null : current),
  });
  return (
    <Menu>
      <ChatInputBoostSubmenu {...disclosure('modes')} label="Additional modes" icon={null} testId="modes">
        <MenuItem onClick={onSelectionComplete}>Plan</MenuItem>
      </ChatInputBoostSubmenu>
      <ChatInputBoostSubmenu {...disclosure('skills')} label="Skills" icon={null} testId="skills">
        <MenuItem onClick={onSelectionComplete}>Skill A</MenuItem>
      </ChatInputBoostSubmenu>
      <HarnessProfileSelector
        {...disclosure('harness')}
        presentation="menu-item"
        selectedProfile="Minimal"
        otherAgents={[{ id: 'research', name: 'Research' }]}
        onSelectProfile={() => {}}
        onSelectionComplete={onSelectionComplete}
      />
    </Menu>
  );
}

function PortalledAddMenu() {
  const [open, setOpen] = useState(true);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    return subscribeOverlayInteraction(menuRef, 'mousedown', event => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    });
  }, [open]);
  return open ? (
    <Portal>
      <div ref={menuRef} data-testid="add-menu">
        <SiblingMenus onSelectionComplete={() => setOpen(false)} />
      </div>
    </Portal>
  ) : null;
}

function clickWithPointer(target: HTMLElement) {
  // Flush capture-phase dismissal before click, as a real pointer gesture does.
  act(() => target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
  act(() => target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  act(() => { target.focus(); target.click(); });
}

describe('ChatInputBoostSubmenu', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('opens by click or keyboard and closes with the reverse arrow', async () => {
    await act(async () => {
      root.render(
        <ControlledSubmenu label="Additional modes" icon={<span>+</span>}>
          <button type="button" role="menuitem">Plan</button>
        </ControlledSubmenu>,
      );
    });

    const trigger = container.querySelector<HTMLElement>('[role="menuitem"]');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(document.body.querySelector('.openbitfun-chat-input__boost-submenu-panel')).toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.querySelector('.openbitfun-chat-input__boost-submenu-panel')).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
  });

  it.each([
    { label: 'Skills' },
    { label: 'Additional modes' },
  ])('keeps the extracted $label submenu open across pointer movement', ({ label }) => {
    act(() => root.render(
      <ControlledSubmenu label={label} icon={<span>+</span>}>
        <button type="button" role="menuitem">Plan</button>
      </ControlledSubmenu>,
    ));

    const trigger = container.querySelector<HTMLElement>('[aria-haspopup="menu"]')!;
    act(() => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    act(() => document.dispatchEvent(new MouseEvent('pointermove', {
      bubbles: true, clientX: 0, clientY: 0,
    })));
    act(() => vi.advanceTimersByTime(1000));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    act(() => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it.each(['click', 'keyboard'])('keeps one flyout open when switching siblings by %s', (input) => {
    act(() => root.render(<SiblingMenus />));
    const modes = container.querySelector<HTMLButtonElement>('[data-testid="modes"] [aria-haspopup="menu"]')!;
    const skills = container.querySelector<HTMLButtonElement>('[data-testid="skills"] [aria-haspopup="menu"]')!;
    const harness = container.querySelector<HTMLButtonElement>('[data-testid="harness-profile-selector"]')!;
    const triggers = [modes, skills, harness];

    // Exercise both directions, including switching back from the Agent page.
    for (const trigger of [modes, skills, modes, harness, skills, harness, modes]) {
      act(() => {
        if (input === 'click') {
          trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
          trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          trigger.focus();
          trigger.click();
        } else {
          trigger.focus();
          trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        }
      });
      act(() => vi.advanceTimersByTime(20));

      expect(triggers.map(item => item.getAttribute('aria-expanded')))
        .toEqual(triggers.map(item => item === trigger ? 'true' : 'false'));
      const panels = document.querySelectorAll('.openbitfun-chat-input__boost-submenu-panel, .openbitfun-harness-selector__menu');
      expect(panels).toHaveLength(1);
      expect(panels[0].id).toBe(trigger.getAttribute('aria-controls'));
      if (trigger === harness) {
        expect((panels[0] as HTMLElement).dataset.openbitfunPage).toBe('profiles');
        act(() => document.querySelector<HTMLButtonElement>('[data-testid="harness-profile-other"]')!.click());
        expect((panels[0] as HTMLElement).dataset.openbitfunPage).toBe('agents');
      }
    }

    act(() => modes.click());
    expect(modes.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.openbitfun-chat-input__boost-submenu-panel')).toBeNull();
  });

  it.each(['Escape', 'ArrowLeft'])('closes only the active flyout with %s and returns focus', key => {
    act(() => root.render(<SiblingMenus />));
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="skills"] [aria-haspopup="menu"]')!;
    act(() => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    act(() => vi.advanceTimersByTime(20));
    const panel = document.querySelector<HTMLElement>('.openbitfun-chat-input__boost-submenu-panel')!;
    expect(panel.contains(document.activeElement)).toBe(true);
    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
    act(() => vi.advanceTimersByTime(20));
    expect(document.querySelector('.openbitfun-chat-input__boost-submenu-panel')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
  });

  it('removes portalled flyouts when the parent menu unmounts', () => {
    act(() => root.render(<SiblingMenus />));
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="skills"] [aria-haspopup="menu"]')!.click());
    expect(document.querySelector('.openbitfun-chat-input__boost-submenu-panel')).not.toBeNull();
    act(() => root.render(null));
    expect(document.querySelector('.openbitfun-chat-input__boost-submenu-panel')).toBeNull();
    act(() => root.render(<SiblingMenus />));
    expect(container.querySelector('[aria-expanded="true"]')).toBeNull();
  });

  it('keeps the add menu open while navigating to and back from the agent list', () => {
    act(() => root.render(<PortalledAddMenu />));
    clickWithPointer(document.querySelector<HTMLElement>('[data-testid="harness-profile-selector"]')!);
    clickWithPointer(document.querySelector<HTMLElement>('[data-testid="harness-profile-other"]')!);

    expect(document.querySelector('[data-testid="add-menu"]')).not.toBeNull();
    expect(document.querySelector('.openbitfun-harness-selector__menu')?.getAttribute('data-openbitfun-page'))
      .toBe('agents');

    clickWithPointer(document.querySelector<HTMLElement>('[data-testid="harness-agent-back"]')!);
    expect(document.querySelector('.openbitfun-harness-selector__menu')?.getAttribute('data-openbitfun-page'))
      .toBe('profiles');
    clickWithPointer(document.querySelector<HTMLElement>('[data-testid="harness-profile-other"]')!);
    clickWithPointer(document.querySelector<HTMLElement>('[data-testid="harness-agent-research"]')!);
    expect(document.querySelector('[data-testid="add-menu"]')).toBeNull();
    expect(document.querySelector('.openbitfun-harness-selector__menu')).toBeNull();
  });

  it.each(['modes', 'skills'])('keeps the %s flyout mounted until its item receives the click', id => {
    act(() => root.render(<PortalledAddMenu />));
    clickWithPointer(document.querySelector<HTMLElement>(`[data-testid="${id}"] [aria-haspopup="menu"]`)!);
    const item = document.querySelector<HTMLElement>('.openbitfun-chat-input__boost-submenu-panel [role="menuitem"]')!;

    act(() => item.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    act(() => item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(item.isConnected).toBe(true);
    expect(document.querySelector('[data-testid="add-menu"]')).not.toBeNull();
    act(() => item.click());
    expect(document.querySelector('[data-testid="add-menu"]')).toBeNull();
  });

  it.each(['harness', 'modes', 'skills'])('dismisses the %s flyout without cascading through the parent in one gesture', id => {
    act(() => root.render(<PortalledAddMenu />));
    const selector = id === 'harness'
      ? '[data-testid="harness-profile-selector"]'
      : `[data-testid="${id}"] [aria-haspopup="menu"]`;
    const trigger = document.querySelector<HTMLElement>(selector)!;
    clickWithPointer(trigger);

    clickWithPointer(document.body);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-testid="add-menu"]')).not.toBeNull();

    clickWithPointer(document.body);
    expect(document.querySelector('[data-testid="add-menu"]')).toBeNull();
  });

  it('wires all ChatInput flyouts to one owner and clears it when the add menu closes', () => {
    const source = readFileSync(path.join(__dirname, 'ChatInput.tsx'), 'utf8');
    for (const id of ['harness', 'additional-modes', 'skills']) {
      expect(source).toContain(`open={activeBoostSubmenu === '${id}'}`);
      expect(source).toContain(`onOpenChange={open => setBoostSubmenuOpen('${id}', open)}`);
    }
    expect(source).toContain('if (!modeState.dropdownOpen) setActiveBoostSubmenu(null);');
    expect(source).toContain('current => open ? id : current === id ? null : current');
  });
});
