// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechRealtimeConfig } from '@/infrastructure/api';
import RealtimeVoiceSettingsSection from '@/app/scenes/settings/pages/application/RealtimeVoiceSettingsSection';

const mocks = vi.hoisted(() => ({
  get: vi.fn(), save: vi.fn(), error: vi.fn(), supported: true,
  t: (key: string) => key,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t }), Trans: () => null,
}));
vi.mock('@/infrastructure/runtime', () => ({ isTauriRuntime: () => mocks.supported }));
vi.mock('@/infrastructure/api', () => ({
  LOCAL_SENSEVOICE_SMALL_INT8_MODEL_ID: 'local',
  speechAPI: {
    getRealtimeConfig: mocks.get, saveRealtimeConfig: mocks.save,
    listModels: async () => ({ models: [] }),
    onModelProgress: () => () => {}, onModelStatusChanged: () => () => {},
  },
}));
vi.mock('../../../../../infrastructure/config/hooks', () => ({
  useAIExperienceSettings: () => ({ settings: { voice_input: { enabled: false } } }),
}));
vi.mock('../../../../../infrastructure/config/services/AIExperienceConfigService', () => ({ aiExperienceConfigService: {} }));
vi.mock('@/shared/notification-system', () => ({ notificationService: { error: mocks.error } }));
vi.mock('@/shared/utils/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));
vi.mock('../../../../../infrastructure/config/components/LocalVoiceModelsConfig', () => ({ default: () => null }));
vi.mock('../../../../../infrastructure/config/components/VoiceInputDiagnostics', () => ({ VoiceInputDiagnostics: () => null }));
vi.mock('@openbitfun/ui', () => ({
  Input: ({ size: _size, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Switch: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input type="checkbox" {...props} />,
  Select: () => null, StatusPill: () => null,
  Button: ({ children }: React.PropsWithChildren) => <button>{children}</button>,
}));
vi.mock('../../../../../infrastructure/config/components/common', () => {
  const Container = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  return {
    ConfigPageLayout: Container, ConfigPageContent: Container, ConfigPageSectionStack: Container,
    ConfigPageSection: Container, ConfigPageRow: Container,
    ConfigPageHeader: () => null, ConfigLoadingState: () => null,
    ConfigRetryState: () => <div>retry</div>,
    ConfigMessage: ({ message }: { message: { text: string } | null }) => (
      message ? <div role="alert">{message.text}</div> : null
    ),
  };
});

const initial: SpeechRealtimeConfig = {
  enabled: false, provider: 'volcengine', apiKey: '', voice: 'jupiter',
  speed: 0, loudness: 0, microphoneDeviceId: '',
};
let container: HTMLDivElement;
let root: Root;
const inputs = () => Array.from(container.querySelectorAll('input'));
const change = async (input: HTMLInputElement, value: string | boolean) => {
  await act(async () => {
    if (typeof value === 'boolean') input.checked = value;
    else input.value = value;
    Simulate.change(input);
  });
};
const mount = async () => {
  await act(async () => root.render(<RealtimeVoiceSettingsSection />));
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.supported = true;
  mocks.get.mockResolvedValue(initial);
  mocks.save.mockImplementation(async config => ({ ...config, provider: 'volcengine' }));
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('realtime voice autosave', () => {
  it('saves credentials while disabled, then saves the switch and voice without a save button', async () => {
    await mount();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(inputs()[1].disabled).toBe(false);
    await change(inputs()[1], ' key ');
    await change(inputs()[0], true);
    await change(inputs()[2], 'new-voice');
    expect(mocks.save).toHaveBeenLastCalledWith({
      enabled: true, apiKey: 'key', voice: 'new-voice',
      speed: 0, loudness: 0, microphoneDeviceId: '',
    });
    expect(container.textContent).not.toContain('voiceCall.save');
  });

  it('serializes rapid edits, preserves newer input, and finishes saving after leaving', async () => {
    let resolveFirst!: (config: SpeechRealtimeConfig) => void;
    let resolveSecond!: (config: SpeechRealtimeConfig) => void;
    mocks.save
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));
    await mount();
    await change(inputs()[1], 'first');
    await change(inputs()[1], 'latest');
    await change(inputs()[2], 'latest-voice');
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(inputs()[1].value).toBe('latest');
    expect(inputs()[2].value).toBe('latest-voice');
    await act(async () => resolveFirst({ ...initial, apiKey: 'first' }));
    expect(inputs()[1].value).toBe('latest');
    expect(inputs()[2].value).toBe('latest-voice');
    await act(async () => root.render(null));
    await act(async () => resolveSecond({ ...initial, apiKey: 'latest' }));
    expect(mocks.save).toHaveBeenCalledTimes(3);
    expect(mocks.save).toHaveBeenLastCalledWith({
      enabled: false, apiKey: 'latest', voice: 'latest-voice',
      speed: 0, loudness: 0, microphoneDeviceId: '',
    });
  });

  it('shows a failed save, restores persisted values, and allows the next edit to save', async () => {
    mocks.save.mockRejectedValueOnce(new Error('offline'));
    await mount();
    await change(inputs()[1], 'failed');
    expect(inputs()[1].value).toBe('');
    expect(container.textContent).toContain('voiceCall.messages.saveFailed');
    await change(inputs()[1], 'retry');
    expect(inputs()[1].value).toBe('retry');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('keeps invalid values editable and refuses activation without credentials', async () => {
    await mount();
    await change(inputs()[0], true);
    expect(inputs()[0].checked).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(container.textContent).toContain('voiceCall.messages.required');
    await change(inputs()[2], '');
    expect(mocks.save).not.toHaveBeenCalled();
    await change(inputs()[2], 'valid');
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it('does not load or write controller settings on an unsupported surface', async () => {
    mocks.supported = false;
    await mount();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(container.textContent).toContain('voiceCall.messages.unsupported');
  });
});
