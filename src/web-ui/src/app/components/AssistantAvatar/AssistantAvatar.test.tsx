// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import AssistantAvatar from './AssistantAvatar';
import { resolveAssistantAvatarPreset } from './assistantAvatarPresets';
import { parseIdentityDocument, serializeIdentityDocument } from '@/app/scenes/my-agent/identityDocument';
import inkMintAvatar from '@/flow_chat/assets/subagent-avatars/robot-04.svg';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('AssistantAvatar', () => {
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

  it.each([
    'claw', 'claw-orbit', 'signal-pulse', 'signal-wave', 'orbit-nova',
    'orbit-loop', 'mosaic-grid', 'mosaic-stack', 'companion-spark', 'companion-calm',
  ])('renders the black IP for legacy %s identities and preserves their document', (presetId) => {
    const identity = parseIdentityDocument([
      '---', 'name: Existing assistant', `avatar: ${presetId}`, 'emoji: 🧭',
      '---', '', 'Existing persona', '',
    ].join('\n'));
    act(() => {
      root.render(<AssistantAvatar presetId={identity.avatar} emoji={identity.emoji} size={28} />);
    });

    const avatar = container.querySelector('[data-openbitfun-component="assistant-avatar"]');
    const image = container.querySelector('.assistant-avatar__image') as HTMLImageElement;
    expect(avatar?.getAttribute('data-openbitfun-preset')).toBe('joystick-ink-mint');
    expect(avatar?.getAttribute('data-openbitfun-family')).toBe('joystick');
    expect(avatar?.getAttribute('style')).toContain('28px');
    expect(image.getAttribute('src')).toBe(inkMintAvatar);
    expect(parseIdentityDocument(serializeIdentityDocument(identity))).toEqual(identity);
    expect(identity.avatar).toBe(presetId);
  });

  it('keeps the legacy emoji when a preset id is missing or unknown', () => {
    act(() => {
      root.render(<AssistantAvatar presetId="future-avatar" emoji="🧭" stableKey="assistant-1" />);
    });

    const avatar = container.querySelector('[data-openbitfun-component="assistant-avatar"]');
    expect(avatar?.getAttribute('data-openbitfun-family')).toBe('emoji');
    expect(avatar?.textContent).toContain('🧭');
  });

  it.each([undefined, 'assistant-1', 'assistant-2'])('defaults to the black IP for identity %s', (stableKey) => {
    expect(resolveAssistantAvatarPreset(undefined, stableKey).id).toBe('joystick-ink-mint');
  });

  it('maps semantic sizes to shared control-height tokens', () => {
    act(() => {
      root.render(<AssistantAvatar presetId="joystick-ink-mint" size="lg" />);
    });

    const avatar = container.querySelector<HTMLElement>(
      '[data-openbitfun-component="assistant-avatar"]',
    );
    expect(avatar?.dataset.size).toBe('lg');
    expect(avatar?.hasAttribute('style')).toBe(false);
  });

  it('renders the new default avatar without discarding the accessible identity', () => {
    act(() => {
      root.render(
        <AssistantAvatar
          name="Claw"
          decorative={false}
        />,
      );
    });

    const avatar = container.querySelector('[data-openbitfun-component="assistant-avatar"]');
    const image = container.querySelector('.assistant-avatar__image') as HTMLImageElement;
    expect(avatar?.getAttribute('data-openbitfun-family')).toBe('joystick');
    expect(avatar?.getAttribute('data-openbitfun-preset')).toBe('joystick-ink-mint');
    expect(avatar?.getAttribute('aria-label')).toBe('Claw avatar');
    expect(image.getAttribute('src')).toBe(inkMintAvatar);
  });
});
