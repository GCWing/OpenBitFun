// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LocalContextTruncationSection from './LocalContextTruncationSection';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), error: vi.fn(), success: vi.fn(), peer: null as unknown }));
vi.mock('@/infrastructure/config/services/ConfigManager', () => ({
  configManager: {
    getOptionalConfig: mocks.get,
    setConfig: mocks.set,
    hasCachedConfig: () => false,
    watch: () => () => undefined,
  },
}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', () => ({
  usePeerDeviceModeOptional: () => mocks.peer,
}));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => ({ error: mocks.error, success: mocks.success }) }));
vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Select: ({ value, onValueChange, options, disabled, 'aria-label': label }: {
    value: string; onValueChange: (value: string) => void; options: { value: string; label: string }[];
    disabled?: boolean; 'aria-label'?: string;
  }) => (
    <select aria-label={label} value={value} disabled={disabled} onChange={event => onValueChange(event.target.value)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
}));

let container: HTMLDivElement;
let root: Root;
const picker = () => container.querySelector<HTMLSelectElement>('select');
const choose = async (value: string) => {
  await act(async () => {
    picker()!.value = value;
    picker()!.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  activateSurface('local');
  vi.clearAllMocks();
  mocks.peer = null;
  mocks.get.mockResolvedValue(undefined);
  mocks.set.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  activateSurface('local');
});

describe('Local context truncation setting', () => {
  it('requires an advertised capability before editing an older peer host', async () => {
    mocks.peer = { peerMode: { active: true }, currentPeerCapabilities: {} };
    await act(async () => root.render(<LocalContextTruncationSection />));
    expect(picker()).toBeNull();
    expect(container.textContent).toContain('localContextTruncation.unsupported');
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('defaults missing legacy fields to explicit invocation without writing defaults', async () => {
    await act(async () => root.render(<LocalContextTruncationSection />));
    expect(picker()!.value).toBe('explicit_only');
    expect(picker()!.options).toHaveLength(3);
    expect(mocks.set).not.toHaveBeenCalled();
    await choose('on_context_overflow');
    expect(mocks.set).toHaveBeenLastCalledWith('ai.local_context_truncation', 'on_context_overflow');
    expect(picker()!.value).toBe('on_context_overflow');
    await choose('always');
    expect(mocks.set).toHaveBeenLastCalledWith('ai.local_context_truncation', 'always');
    await choose('explicit_only');
    expect(mocks.set).toHaveBeenLastCalledWith('ai.local_context_truncation', 'explicit_only');
  });

  it('preserves a saved choice and keeps it when saving fails', async () => {
    mocks.get.mockResolvedValue('always');
    await act(async () => root.render(<LocalContextTruncationSection />));
    expect(picker()!.value).toBe('always');
    mocks.set.mockRejectedValueOnce(new Error('Host unavailable'));
    await choose('on_context_overflow');
    expect(picker()!.value).toBe('always');
    expect(mocks.error).toHaveBeenCalledWith('messages.saveFailed');
  });

  it('keeps an unread configuration locked until retry succeeds', async () => {
    mocks.get.mockRejectedValueOnce(new Error('Host unavailable'));
    await act(async () => root.render(<LocalContextTruncationSection />));
    expect(picker()).toBeNull();
    expect(container.textContent).toContain('messages.loadFailedLocked');
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(picker()!.value).toBe('explicit_only');
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('ignores an old device response after switching execution hosts', async () => {
    let finishOldRead!: (value: string) => void;
    mocks.get.mockReturnValueOnce(new Promise<string>(resolve => { finishOldRead = resolve; }));
    await act(async () => root.render(<LocalContextTruncationSection />));
    mocks.get.mockResolvedValueOnce('on_context_overflow');
    await act(async () => activateSurface('peer-host'));
    expect(picker()!.value).toBe('on_context_overflow');
    await act(async () => finishOldRead('always'));
    expect(picker()!.value).toBe('on_context_overflow');
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
