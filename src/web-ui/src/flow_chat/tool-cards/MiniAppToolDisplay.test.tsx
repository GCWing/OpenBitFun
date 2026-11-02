import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { JSDOM } from 'jsdom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/locales/en-US/flow-chat.json';
import { InitMiniAppDisplay } from './MiniAppToolDisplay';
import type { FlowToolItem, ToolCardConfig } from '../types/flow-chat';

// Only the host navigation boundary is stubbed; disclosure uses the real UI components.
vi.mock('@/app/hooks/useSceneManager', () => ({ useSceneManager: () => ({ openScene: vi.fn() }) }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const i18n = createInstance();
const config: ToolCardConfig = {
  toolName: 'InitMiniApp', displayName: 'Create app', icon: '',
  requiresConfirmation: false, resultDisplayType: 'detailed',
};

beforeAll(async () => {
  await i18n.init({ lng: 'en-US', resources: { 'en-US': { 'flow-chat': en } } });
});

describe('MiniApp failure disclosure', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
    Object.defineProperty(dom.window, 'matchMedia', {
      value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('CustomEvent', dom.window.CustomEvent);
    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
  });

  it.each(['error', 'completed'] as const)('exposes failure details after a %s transport outcome', (status) => {
    const toolItem: FlowToolItem = {
      id: 'miniapp-failure', type: 'tool', toolName: 'InitMiniApp', timestamp: 0, status,
      toolCall: { id: 'miniapp-failure', input: { name: 'Notebook' } },
      toolResult: { success: false, error: 'Cannot create app directory' },
    };
    act(() => root.render(<I18nextProvider i18n={i18n}>
      <InitMiniAppDisplay toolItem={toolItem} config={config} />
    </I18nextProvider>));
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.error-content')?.textContent).toContain('Cannot create app directory');
    expect(container.querySelector('.error-content')?.textContent).toContain('Notebook');
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});
