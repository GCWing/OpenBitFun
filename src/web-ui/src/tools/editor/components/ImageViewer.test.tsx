// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ImageViewer } from './ImageViewer';

const mocks = vi.hoisted(() => ({ read: vi.fn(), localRead: vi.fn(), current: vi.fn(() => true) }));
vi.mock('../services/EditorDocument', () => {
  const session = { files: { readFileContent: mocks.read }, isCurrent: mocks.current };
  return { useEditorDocument: () => session };
});
vi.mock('@/infrastructure/api', () => ({ workspaceAPI: { readWorkspaceFile: mocks.localRead } }));
vi.mock('@/infrastructure/i18n', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});
vi.mock('@openbitfun/ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  OverflowText: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
  Button: ({ children, onClick }: React.PropsWithChildren<{ onClick?: () => void }>) => <button onClick={onClick}>{children}</button>,
  Icon: () => null,
  Toolbar: ({ leading, trailing }: { leading: React.ReactNode; trailing: React.ReactNode }) => <div>{leading}{trailing}</div>,
  ToolbarGroup: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  ToolbarSeparator: () => null,
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it('uses supplied bytes without local IO and reports the actual byte size', async () => {
  await act(async () => root.render(<ImageViewer filePath="dispatch-file://job/a.png" imageSource={{ dataUrl: 'data:image/png;base64,AP8B', size: 3 }} />));
  expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AP8B');
  expect(container.textContent).toContain('3 B');
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.localRead).not.toHaveBeenCalled();
});

it('does not retry a failed read until the tab is reactivated', async () => {
  mocks.read.mockRejectedValue(new Error('offline'));
  await act(async () => root.render(<ImageViewer filePath="/remote/a.png" />));
  expect(mocks.read).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<ImageViewer filePath="/remote/a.png" isActiveTab={false} />));
  expect(mocks.read).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<ImageViewer filePath="/remote/a.png" isActiveTab />));
  expect(mocks.read).toHaveBeenCalledTimes(2);
});

it('drops a stale read after switching to an immutable dispatch result', async () => {
  let complete!: (value: string) => void;
  mocks.read.mockImplementation(() => new Promise<string>(resolve => { complete = resolve; }));
  await act(async () => root.render(<ImageViewer filePath="/remote/a.png" />));
  await act(async () => root.render(<ImageViewer filePath="dispatch-file://job/b.png" imageSource={{ dataUrl: 'data:image/png;base64,Ag==', size: 1 }} />));
  await act(async () => complete('AQ=='));
  expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,Ag==');
});

it('joins the overlay stack in fullscreen and restores its control on Escape', async () => {
  await act(async () => root.render(<ImageViewer filePath="dispatch-file://job/a.png" imageSource={{ dataUrl: 'data:image/png;base64,AP8B', size: 3 }} />));
  const label = 'editor.imageViewer.enterFullscreen';
  await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.closest('[data-openbitfun-overlay-layer]')).not.toBeNull();
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(container.hasAttribute('inert')).toBe(true);
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.hasAttribute('inert')).toBe(false);
  expect(document.activeElement).toBe(container.querySelector(`[aria-label="${label}"]`));
  expect(mocks.read).not.toHaveBeenCalled();
});
