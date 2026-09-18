/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceCallTranscript } from '@openbitfun/ui';

import { ConversationModeSurface } from './ConversationModeSurface';
import type { VoiceMiniAppCallTarget } from './voiceClientContext';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  controller: {
    enabled: true,
    phase: 'idle',
    start: vi.fn(),
    end: vi.fn(),
    muted: false,
    toggleMute: vi.fn(),
    openSettings: vi.fn(),
    target: null as VoiceMiniAppCallTarget | null,
  },
}));

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('./RealtimeVoiceCallContext', () => ({
  useRealtimeVoiceCall: () => mocks.controller,
}));

vi.mock('./RealtimeVoiceCallPanel', () => ({
  RealtimeVoiceCallPanel: ({ onClose, onBack }: { onClose?: () => void; onBack?: () => void }) => (
    <div data-testid="voice-panel"><button data-testid="voice-panel-back" onClick={onBack}>Text</button>
      <button type="button" data-testid="voice-panel-close" onClick={onClose}>Close</button>
    </div>
  ),
}));

const miniAppTarget: VoiceMiniAppCallTarget = {
  kind: 'miniapp',
  appId: 'builtin-ppt-live',
  appName: 'PPT Live',
  claimToken: 'builtin-ppt-live#1',
  sessionId: 'ppt-session',
};

describe('ConversationModeSurface', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.controller.enabled = true;
    mocks.controller.phase = 'idle';
    mocks.controller.target = null;
    mocks.controller.start.mockReset();
    mocks.controller.end.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('places the logo control in the host header without a footer and preserves the call back button', async () => {
    const renderHeader = (modeSwitch: React.ReactNode) => <header>{modeSwitch}</header>;
    await act(async () => root.render(<ConversationModeSurface renderHeader={renderHeader} voiceTarget={miniAppTarget}><input /></ConversationModeSurface>));
    expect(container.querySelector('footer')).toBeNull();
    expect(container.querySelector('header .openbitfun-conversation-mode-surface__logo')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('header button')?.click());
    expect(mocks.controller.start).toHaveBeenCalledWith(miniAppTarget);
    mocks.controller.phase = 'live'; mocks.controller.target = miniAppTarget;
    await act(async () => root.render(<ConversationModeSurface renderHeader={renderHeader} voiceTarget={miniAppTarget}><input /></ConversationModeSurface>));
    expect(container.querySelector('[data-testid="voice-panel-back"]')).not.toBeNull();
    expect(container.querySelector('header')).toBeNull();
    await act(async () => (container.querySelector('[data-testid="voice-panel-back"]') as HTMLButtonElement).click());
    expect(mocks.controller.end).not.toHaveBeenCalled();
    expect(container.querySelector('header')).not.toBeNull();
  });

  it('shows the supplied chat surface and starts voice with its captured route', async () => {
    await act(async () => {
      root.render(
        <ConversationModeSurface voiceTarget={miniAppTarget}>
          <div data-testid="chat-surface" />
        </ConversationModeSurface>,
      );
    });

    expect(container.querySelector('[data-testid="chat-surface"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="voice-panel"]')).toBeNull();

    await act(async () => {
      container.querySelector('button')?.click();
    });
    expect(mocks.controller.start).toHaveBeenCalledWith(miniAppTarget);
  });

  it('delegates voice-window closing to the host without duplicating the mode switch', async () => {
    const onCloseVoice = vi.fn();
    mocks.controller.phase = 'live';
    await act(async () => {
      root.render(
        <ConversationModeSurface onCloseVoice={onCloseVoice}>
          <div data-testid="chat-surface" />
        </ConversationModeSurface>,
      );
    });

    expect(container.querySelector('[data-testid="voice-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-surface"]')?.parentElement?.hidden).toBe(true);
    expect(container.querySelector('[data-openbitfun-part="modeSwitch"]')).toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="voice-panel-close"]')?.click();
    });
    expect(onCloseVoice).toHaveBeenCalledOnce();
    expect(mocks.controller.end).not.toHaveBeenCalled();
  });

  it('cannot silently fall back to workspace voice while a MiniApp route is unavailable', async () => {
    mocks.controller.phase = 'live';
    mocks.controller.target = miniAppTarget;
    await act(async () => {
      root.render(
        <ConversationModeSurface voiceStartDisabled>
          <div data-testid="chat-surface" />
        </ConversationModeSurface>,
      );
    });

    const button = container.querySelector('button');
    expect(button?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="voice-panel"]')).toBeNull();
    button?.click();
    expect(mocks.controller.start).not.toHaveBeenCalled();
  });

  it('hides the realtime voice switch until the client voice assistant is enabled', async () => {
    mocks.controller.enabled = false;
    await act(async () => {
      root.render(
        <ConversationModeSurface>
          <div data-testid="chat-surface" />
        </ConversationModeSurface>,
      );
    });

    expect(container.querySelector('[data-testid="chat-surface"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-part="modeSwitch"]')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('keeps the shared voice panel available after the assistant is disabled during a call', async () => {
    const onCloseVoice = vi.fn();
    mocks.controller.enabled = false;
    mocks.controller.phase = 'live';
    await act(async () => {
      root.render(
        <ConversationModeSurface onCloseVoice={onCloseVoice}>
          <div data-testid="chat-surface" />
        </ConversationModeSurface>,
      );
    });

    expect(container.querySelector('[data-testid="voice-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-part="modeSwitch"]')).toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="voice-panel-close"]')?.click();
    });
    expect(onCloseVoice).toHaveBeenCalledOnce();
  });
  it('switches to text without hanging up or moving the call to another conversation', async () => {
    mocks.controller.phase = 'live';
    mocks.controller.target = miniAppTarget;
    await act(async () => root.render(<ConversationModeSurface voiceTarget={miniAppTarget}><input data-testid="draft" defaultValue="keep" /></ConversationModeSurface>));
    const input = container.querySelector('input');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="voice-panel-back"]')!.click());
    expect(mocks.controller.end).not.toHaveBeenCalled();
    expect(container.querySelector('input')).toBe(input);
    await act(async () => root.render(<ConversationModeSurface voiceTarget={{ ...miniAppTarget, sessionId: 'other' }}><input /></ConversationModeSurface>));
    expect(container.querySelector('[data-testid="voice-panel"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-openbitfun-part="modeSwitchButton"]')?.disabled).toBe(true);
    expect(mocks.controller.start).not.toHaveBeenCalled();
  });

  describe('persistent identity and transcript', () => {
    beforeEach(() => {
      // These tests exercise React ownership only; no canvas rendering or visual assertions.
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
      vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    });
    const transcript = (mode: 'chat' | 'voice') => <VoiceCallTranscript presentation={mode} entries={[
      { id: 'user', role: 'user', content: 'Request' },
      { id: 'assistant', role: 'assistant', content: 'History' },
    ]} />;
    const renderIntegrated = (requiresTextInput = false, modeAware = false) => root.render(
      <ConversationModeSurface voiceTarget={miniAppTarget} renderHeader={() => <header />}
        requiresTextInput={requiresTextInput} transcript={modeAware ? transcript : transcript('voice')}>
        <input data-testid="continuous-draft" defaultValue="Unsent draft" />
      </ConversationModeSurface>,
    );
    const identity = () => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="identity"] button[aria-expanded]')!;
    const back = () => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="voiceHeader"] button[aria-label="voiceCall.call.switchToChat"]')!;

    it.each([false, true])('keeps the reading viewport through entry, return and hangup (mode-aware: %s)', async modeAware => {
      await act(async () => renderIntegrated(false, modeAware));
      const logo = container.querySelector('canvas');
      const record = container.querySelector('[data-openbitfun-part="conversation"]');
      const userMessage = container.querySelector('[data-transcript-id="user"]');
      expect(record?.getAttribute('data-openbitfun-presentation')).toBe(modeAware ? 'chat' : 'voice');
      const input = container.querySelector<HTMLInputElement>('input')!;
      await act(async () => identity().click());
      expect(mocks.controller.start).toHaveBeenCalledWith(miniAppTarget);
      mocks.controller.phase = 'live'; mocks.controller.target = miniAppTarget;
      await act(async () => renderIntegrated(false, modeAware));
      expect(record?.getAttribute('data-openbitfun-presentation')).toBe('voice');
      expect(identity().hidden).toBe(true);
      expect(container.querySelector('[data-openbitfun-part="voiceHeader"]')?.getAttribute('aria-hidden')).toBe('false');
      expect(back().querySelector('.lucide-arrow-left')).not.toBeNull();
      expect(container.querySelector('[data-openbitfun-part="composer"]')?.getAttribute('aria-hidden')).toBe('true');
      await act(async () => back().click());
      expect(record?.getAttribute('data-openbitfun-presentation')).toBe(modeAware ? 'chat' : 'voice');
      expect(mocks.controller.end).not.toHaveBeenCalled();
      expect(identity().hidden).toBe(false);
      expect(identity().getAttribute('aria-label')).toBe('voiceCall.call.identity.ongoing');
      mocks.controller.phase = 'idle'; mocks.controller.target = null;
      await act(async () => renderIntegrated(false, modeAware));
      expect(container.querySelector('canvas')).toBe(logo);
      expect(container.querySelector('[data-openbitfun-part="conversation"]')).toBe(record);
      expect(container.querySelector('[data-transcript-id="user"]')).toBe(userMessage);
      expect(container.querySelector('input')).toBe(input);
      expect(input.value).toBe('Unsent draft');
    });

    it('keeps a blocking response reachable without ending the live call', async () => {
      mocks.controller.phase = 'live'; mocks.controller.target = miniAppTarget;
      await act(async () => renderIntegrated(true));
      expect(identity().getAttribute('aria-expanded')).toBe('false');
      expect(identity().disabled).toBe(true);
      expect(container.querySelector('[data-openbitfun-part="composer"]')?.getAttribute('aria-hidden')).toBe('false');
      expect(mocks.controller.end).not.toHaveBeenCalled();
    });

    it('waits for failed-call cleanup before retrying the captured conversation', async () => {
      mocks.controller.phase = 'error'; mocks.controller.target = miniAppTarget;
      await act(async () => renderIntegrated());
      await act(async () => back().click());
      expect(mocks.controller.end).not.toHaveBeenCalled();
      await act(async () => identity().click());
      expect(mocks.controller.end).toHaveBeenCalledOnce();
      expect(mocks.controller.start).not.toHaveBeenCalled();
      mocks.controller.phase = 'idle'; mocks.controller.target = null;
      await act(async () => renderIntegrated());
      expect(mocks.controller.start).toHaveBeenCalledExactlyOnceWith(miniAppTarget);
    });
  });

});
