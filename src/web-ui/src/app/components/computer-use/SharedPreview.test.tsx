// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SharedPreview } from './SharedPreview';
import { ComputerUsePermissions } from '../ComputerUsePermissions';
import type { ComputerUseControlSnapshot } from '@/infrastructure/api/service-api/ComputerUseControlAPI';
const mocks = vi.hoisted(() => ({ observeShare: vi.fn(), inputShare: vi.fn(), permissions: vi.fn(), requestPermission: vi.fn(),
  scope: { epoch: 1, isCurrent: () => true }, listeners: new Set<() => void>(), t: (key: string) => key }));
vi.mock('@/infrastructure/api/service-api/ComputerUseControlAPI', () => ({ computerUseControlAPI: mocks }));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({
  getActiveSurfaceScope: () => mocks.scope,
  onSurfaceActivated: (fn: () => void) => { mocks.listeners.add(fn); return () => mocks.listeners.delete(fn); },
}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: mocks.t }) }));
vi.mock('./PreviewCursor', () => ({ PreviewCursor: () => <span /> }));
vi.mock('@openbitfun/ui', () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props}>{children}</button>,
  Input: ({ size: _size, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> & { size?: string }) => <input {...props} />,
  Select: () => <select />,
  StatusPill: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
  OverflowText: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
}));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
let resize: () => void;
const snapshot = (granted = true): ComputerUseControlSnapshot => ({ supported: true, generation: 4, target_revision: 2,
  owner: 'task', mode: granted ? 'background' : 'observe', state: 'active', target: 'pid:12/window:20', action: null,
  sequence: 1, reason: null, pointer: null, capabilities: ['app-sharing-v1'], sharing: { phase: 'shared', requested_mode: 'background',
    target_label: 'Fixture', control_enabled: granted, authorization_revision: granted ? 1 : 2 } });
const image = { screenshot_id: 'frame-original', image_base64: 'AA==', mime_type: 'image/png', width: 100, height: 100,
  content: { left: 0, top: 0, width: 100, height: 100 }, bounds: { left: 0, top: 0, width: 100, height: 100 } };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  mocks.scope = { epoch: 1, isCurrent: () => mocks.scope.epoch === 1 };
  mocks.observeShare.mockResolvedValue({ control: snapshot(), frame: image, tree: null });
  mocks.inputShare.mockResolvedValue(snapshot());
  mocks.permissions.mockResolvedValue({ permissions: { platform: 'macos', process_id: 3, executable: '/app', prompts_requested: false,
    permissions: [{ kind: 'accessibility', state: 'required', requestable: true, settings_url: null, detail: '' }] } });
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  HTMLElement.prototype.setPointerCapture = vi.fn();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function preview() {
  const element = container.querySelector<HTMLElement>('[data-openbitfun-part="preview"]')!;
  element.getBoundingClientRect = () => ({ left: 20, top: 30, width: 200, height: 200, x: 20, y: 30, right: 220, bottom: 230, toJSON: () => ({}) });
  return element;
}
async function pointer(element: HTMLElement, type: string, x: number, y: number, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  await act(async () => element.dispatchEvent(event));
}
it('does not send input without the separate grant and keeps permission probes read-only', async () => {
  await act(async () => root.render(<SharedPreview snapshot={snapshot(false)} onSnapshot={vi.fn()} />));
  await pointer(preview(), 'pointerdown', 60, 80); await pointer(preview(), 'pointerup', 60, 80);
  expect(mocks.inputShare).not.toHaveBeenCalled();
  await act(async () => root.render(<ComputerUsePermissions />));
  expect(mocks.permissions).toHaveBeenCalled(); expect(mocks.requestPermission).not.toHaveBeenCalled();
  mocks.requestPermission.mockResolvedValue({ current_granted: false, request_api_invoked: true, restart_may_be_required: false });
  const request = [...container.querySelectorAll('button')].find(button => button.textContent === 'computerSharing.requestPermission')!;
  await act(async () => request.click());
  expect(mocks.requestPermission).toHaveBeenCalledExactlyOnceWith('accessibility');
  expect(container.textContent).toContain('computerSharing.permissionRequested');
  expect(container.textContent).not.toContain('computerSharing.permissionGranted');
});
it('uses exact image coordinates and dispatches one drag after release, without queuing duplicate input', async () => {
  let release!: (result: ComputerUseControlSnapshot) => void;
  mocks.inputShare.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const onSnapshot = vi.fn();
  await act(async () => root.render(<SharedPreview snapshot={snapshot()} onSnapshot={onSnapshot} />));
  const element = preview();
  await pointer(element, 'pointerdown', 60, 80);
  await act(async () => vi.advanceTimersByTime(1500));
  expect(mocks.observeShare).toHaveBeenCalledTimes(1);
  expect(mocks.inputShare).not.toHaveBeenCalled();
  await pointer(element, 'pointerup', 180, 160);
  expect(mocks.inputShare).toHaveBeenCalledTimes(1);
  expect(mocks.inputShare.mock.calls[0][1]).toMatchObject({ action: 'app_drag', from: { x: 20, y: 25, screenshot_id: 'frame-original' }, to: { x: 80, y: 65, screenshot_id: 'frame-original' } });
  await pointer(element, 'pointerdown', 70, 80); await pointer(element, 'pointerup', 70, 80);
  expect(mocks.inputShare).toHaveBeenCalledTimes(1);
  await act(async () => release(snapshot()));
  expect(onSnapshot).toHaveBeenCalledTimes(1);
});
it('cancels a gesture when the grant is revoked or preview dimensions change', async () => {
  await act(async () => root.render(<SharedPreview snapshot={snapshot()} onSnapshot={vi.fn()} />));
  const element = preview();
  await pointer(element, 'pointerdown', 60, 80);
  await act(async () => resize());
  await pointer(element, 'pointerup', 180, 160);
  expect(mocks.inputShare).not.toHaveBeenCalled();
  await pointer(element, 'pointerdown', 60, 80);
  await act(async () => root.render(<SharedPreview snapshot={snapshot(false)} onSnapshot={vi.fn()} />));
  await pointer(element, 'pointerup', 180, 160);
  expect(mocks.inputShare).not.toHaveBeenCalled();
});
it('keeps a gesture bound to its initiating pointer and cancels it when capture is lost', async () => {
  await act(async () => root.render(<SharedPreview snapshot={snapshot()} onSnapshot={vi.fn()} />));
  const element = preview();
  await pointer(element, 'pointerdown', 60, 80, 1);
  await pointer(element, 'pointerdown', 180, 160, 2);
  await pointer(element, 'pointerup', 180, 160, 2);
  expect(mocks.inputShare).not.toHaveBeenCalled();
  await pointer(element, 'pointerup', 60, 80, 1);
  expect(mocks.inputShare).toHaveBeenCalledTimes(1);
  expect(mocks.inputShare.mock.calls[0][1]).toMatchObject({
    action: 'app_click', target: { x: 20, y: 25, screenshot_id: 'frame-original' },
  });
  await pointer(element, 'pointerdown', 60, 80, 1);
  await pointer(element, 'lostpointercapture', 60, 80, 1);
  await pointer(element, 'pointerup', 180, 160, 1);
  expect(mocks.inputShare).toHaveBeenCalledTimes(1);
});
