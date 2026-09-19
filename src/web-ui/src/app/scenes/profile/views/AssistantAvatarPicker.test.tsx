// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AssistantAvatarPicker from './AssistantAvatarPicker';
import { firstAvatarGrapheme } from './assistantAvatar';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
  }) => <button {...props}>{children}</button>,
  IconButton: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
  }) => <button {...props}>{children}</button>,
  Input: ({
    size: _size,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    size?: string;
  }) => <input {...props} />,
}));

describe('AssistantAvatarPicker', () => {
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
    document.querySelector('[data-openbitfun-overlay-host="true"]')?.remove();
  });

  it('keeps a combined emoji sequence as one avatar', () => {
    expect(firstAvatarGrapheme('  🧑‍💻🚀  ')).toBe('🧑‍💻');
  });

  it('opens from the avatar and applies a preset through the shared change callback', () => {
    const onChange = vi.fn();

    act(() => {
      root.render(
        <AssistantAvatarPicker
          value="💼"
          saveStatus="idle"
          onChange={onChange}
        />,
      );
    });

    const trigger = container.querySelector('.acp-avatar-picker__trigger') as HTMLButtonElement;
    act(() => trigger.click());

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const compassOption = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.acp-avatar-picker__option'),
    ).find((option) => option.textContent === '🧭');
    expect(compassOption).toBeTruthy();
    expect(document.querySelector('.acp-avatar-picker__popover')?.closest('[data-openbitfun-overlay-host]')?.getAttribute('data-openbitfun-overlay-host')).toBe('true');

    act(() => compassOption?.click());
    expect(onChange).toHaveBeenCalledWith('🧭');
  });

  it('announces the autosave result while the picker is open', () => {
    act(() => {
      root.render(
        <AssistantAvatarPicker
          value="🧭"
          saveStatus="saved"
          onChange={vi.fn()}
        />,
      );
    });

    const trigger = container.querySelector('.acp-avatar-picker__trigger') as HTMLButtonElement;
    act(() => trigger.click());

    expect(document.querySelector('.acp-avatar-picker__status')?.textContent)
      .toContain('identity.avatarSaved');
  });

  it('selects an official preset without overwriting the legacy emoji fallback', () => {
    const onChange = vi.fn();
    const onPresetChange = vi.fn();

    act(() => {
      root.render(
        <AssistantAvatarPicker
          value="🧭"
          presetValue=""
          saveStatus="idle"
          onChange={onChange}
          onPresetChange={onPresetChange}
        />,
      );
    });

    const trigger = container.querySelector('.acp-avatar-picker__trigger') as HTMLButtonElement;
    act(() => trigger.click());
    const officialOptions = document.querySelectorAll<HTMLButtonElement>('.acp-avatar-picker__option.is-official');
    const officialOption = officialOptions[0];
    act(() => officialOption?.click());

    expect(officialOptions).toHaveLength(2);
    expect(officialOption.querySelector('img')?.getAttribute('src'))
      .toBe('/assets/assistant/claw-avatar.webp');
    expect(onPresetChange).toHaveBeenCalledWith('claw');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows a legacy preset value as its corresponding new Claw avatar', () => {
    act(() => {
      root.render(
        <AssistantAvatarPicker
          value="🧭"
          presetValue="orbit-nova"
          saveStatus="idle"
          onChange={vi.fn()}
          onPresetChange={vi.fn()}
        />,
      );
    });

    const trigger = container.querySelector('.acp-avatar-picker__trigger') as HTMLButtonElement;
    expect(trigger.querySelector('img')?.getAttribute('src'))
      .toBe('/assets/assistant/claw-avatar-alt.webp');
    act(() => trigger.click());

    const selectedOption = document.querySelector<HTMLButtonElement>(
      '.acp-avatar-picker__option.is-official.is-selected',
    );
    expect(selectedOption?.querySelector('img')?.getAttribute('src'))
      .toBe('/assets/assistant/claw-avatar-alt.webp');
  });
});
