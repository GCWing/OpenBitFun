// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSceneStore } from '@/app/stores/sceneStore';
import { useGallerySceneAutoRefresh } from './useGallerySceneAutoRefresh';

vi.mock('@/app/stores/sceneStore', async () => {
  const { create } = await import('zustand');
  return { useSceneStore: create(() => ({ activeTabId: 'agents', navigationSequence: 0 })) };
});
let root: Root;
let container: HTMLDivElement;
let renders = 0;
const refresh = vi.fn();
function Harness() {
  renders++;
  useGallerySceneAutoRefresh({ sceneId: 'agents', refetch: refresh });
  return null;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  refresh.mockReset();
  renders = 0;
  useSceneStore.setState({ activeTabId: 'agents', navigationSequence: 0 });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it('refreshes on re-entry and visible focus, without subscribing to unrelated navigation state', async () => {
  await act(async () => root.render(<Harness />));
  expect(refresh).not.toHaveBeenCalled();
  act(() => useSceneStore.setState({ navigationSequence: 1 }));
  expect(renders).toBe(1);
  act(() => useSceneStore.setState({ activeTabId: 'skills' }));
  const inactiveRenders = renders;
  act(() => useSceneStore.setState({ activeTabId: 'miniapps' }));
  expect(renders).toBe(inactiveRenders);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(refresh).not.toHaveBeenCalled();
  await act(async () => useSceneStore.setState({ activeTabId: 'agents' }));
  expect(refresh).toHaveBeenCalledTimes(1);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(refresh).toHaveBeenCalledTimes(2);
});
