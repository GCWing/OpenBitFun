// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceIcon } from './WorkspaceIcon';

const mocks = vi.hoisted(() => ({ mode: 'light', snapshot: {
  icon: { color: 'blue', glyph: 'travel' }, imageUnavailable: false,
  imageData: 'data:image/png;base64,light', darkImageData: 'data:image/png;base64,dark' as string | undefined, darkImageUnavailable: false,
} }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/infrastructure/appearance', () => ({ useAppearance: () => ({ current: { mode: mocks.mode } }) }));
vi.mock('@/infrastructure/workspace-icons/useWorkspaceIcon', () => ({ useWorkspaceIcon: () => ({ snapshot: mocks.snapshot }) }));
vi.mock('@/infrastructure/workspace-icons/workspaceIcons', () => ({ iconColorStyle: () => undefined }));
afterEach(() => vi.unstubAllGlobals());

it('changes theme images without reloading the host and keeps a usable fallback for legacy or missing variants', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = () => act(() => root.render(<WorkspaceIcon workspace={{ id: 'project' }} />));
  try {
    render();
    expect(host.querySelector('img')?.src).toBe('data:image/png;base64,light');
    mocks.mode = 'dark'; render();
    expect(host.querySelector('img')?.src).toBe('data:image/png;base64,dark');
    mocks.snapshot.darkImageData = undefined; render();
    expect(host.querySelector('img')?.src).toBe('data:image/png;base64,light');
    mocks.snapshot.darkImageUnavailable = true; render();
    expect(host.querySelector('[title]')?.getAttribute('title')).toBe('nav.workspaces.icon.loadFailed');
    expect(host.querySelector('img')?.src).toBe('data:image/png;base64,light');
  } finally { act(() => root.unmount()); }
});
