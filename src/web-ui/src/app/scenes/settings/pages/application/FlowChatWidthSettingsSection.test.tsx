// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { flowChatWidthStore, FLOW_CHAT_WIDTH_STORAGE_KEY } from '@/infrastructure/appearance/preferences/flowChatWidthStore';
import FlowChatWidthSettingsSection from './FlowChatWidthSettingsSection';

vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div');
const root = createRoot(host);
afterEach(() => { act(() => root.render(null)); flowChatWidthStore.setState({ preferredWidth: 900 }); });

it('edits the same persisted appearance preference as dragging and offers an independent reset', () => {
  document.body.appendChild(host);
  flowChatWidthStore.setState({ preferredWidth: 1000 });
  act(() => root.render(<FlowChatWidthSettingsSection />));
  const input = host.querySelector<HTMLInputElement>('input')!;
  expect(input.value).toBe('1000');
  const click = (label: string) => act(() => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
  click('contentWidth.increase');
  expect(flowChatWidthStore.getState().preferredWidth).toBe(1010);
  expect(window.localStorage.getItem(FLOW_CHAT_WIDTH_STORAGE_KEY)).toBe('1010');
  act(() => flowChatWidthStore.getState().setPreferredWidth(750));
  expect(input.value).toBe('750');
  act(() => flowChatWidthStore.getState().setPreferredWidth(0));
  expect(input.value).toBe('600');
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="contentWidth.decrease"]')!.disabled).toBe(true);
  act(() => [...host.querySelectorAll('button')].find(button => button.textContent === 'contentWidth.reset')!.click());
  expect(input.value).toBe('900');
  expect(window.localStorage.getItem(FLOW_CHAT_WIDTH_STORAGE_KEY)).toBe('900');
  host.remove();
});
