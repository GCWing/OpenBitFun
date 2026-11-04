/** @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestI18nT } from '@/test/i18nTestUtils';
import examples from '../../../../shared/generative-ui/examples.json';
import type { GenUIAppDefinition } from '@/tools/generative-ui/genUITypes';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { projectGenerativeWidgetTool } from '@/flow_chat/utils/generativeWidgetProjection';
import type { FlowToolItem, Session } from '@/flow_chat/types/flow-chat';
const pickerExample = examples.picker as GenUIAppDefinition;
import GenerativeWidgetPanel from './GenerativeWidgetPanel';

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: createTestI18nT('flow-chat') }),
}));

function mountProjection(item: FlowToolItem) {
  const session = {
    sessionId: 'loading-session', status: 'active', config: {}, createdAt: 1,
    dialogTurns: [{ id: 'loading-turn', modelRounds: [{ items: [item] }] }],
  } as Session;
  flowChatStore.setState(previous => ({ ...previous, sessions: new Map([[session.sessionId, session]]) }));
  return projectGenerativeWidgetTool(session, item, { turnId: 'loading-turn' })!.origin;
}

const harmonyApp: GenUIAppDefinition = {
  schemaVersion: 2, id: 'loading-app', title: 'Plant garden',
  template: 'openbitfun.harmony.app', libraryId: 'openbitfun.harmony.v1', libraryRevision: 3,
  designSpec: { id: 'harmony.phone.v1', revision: 1 },
  source: { kind: 'openui-lang', content: 'root = Col([Text("Garden is ready")])' }, state: {},
};

function streamingItem(app: GenUIAppDefinition, content = ''): FlowToolItem {
  return {
    id: 'loading-tool', type: 'tool', toolName: 'GenerativeUI', timestamp: 1,
    status: 'streaming', toolCall: { id: 'loading-call', input: {} },
    _genUIStream: {
      messageId: 'loading-source', format: 'openui-lang', content, nextSeq: 1,
      appId: app.id, title: app.title, template: app.template,
      libraryId: app.libraryId, libraryRevision: app.libraryRevision,
    },
  };
}

describe('GenerativeWidgetPanel', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => container.remove());

  it('mounts a generated host app directly instead of an iframe', () => {
    const root = createRoot(container);
    try {
      act(() => root.render(<GenerativeWidgetPanel app={pickerExample} />));
      expect(container.querySelector('iframe')).toBeNull();
      expect(container.querySelector('[data-gen-ui-app="equipment-picker"]')).not.toBeNull();
      expect(container.textContent).toContain('Equipment selection');
      expect(container.textContent).toContain('Camera');
      expect(container.querySelector('[data-openbitfun-state="interactive"]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('shows a lightweight starting state before the first source fragment', () => {
    const root = createRoot(container);
    try {
      act(() => root.render(<GenerativeWidgetPanel />));
      expect(container.querySelector('[data-openbitfun-state="starting"]')).not.toBeNull();
      expect(container.querySelector('.openbitfun-generative-widget-panel__skeleton')).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('keeps the default OpenUI inline surface free of a panel toolbar', () => {
    const root = createRoot(container);
    try {
      act(() => root.render(<GenerativeWidgetPanel app={pickerExample} presentation="inline" />));
      expect(container.querySelector('.openbitfun-generative-widget-panel__toolbar')).toBeNull();
      expect(container.querySelector('.openbitfun-generative-widget-panel--inline')).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('shows a Harmony phone skeleton before source, then streams the app into the phone', () => {
    const root = createRoot(container);
    const item = streamingItem(harmonyApp);
    const origin = mountProjection(item);
    try {
      act(() => root.render(<GenerativeWidgetPanel origin={origin} presentation="inline" />));
      expect(container.querySelector('[data-gen-ui-host-shell="phone"]')).not.toBeNull();
      expect(container.querySelector('.gen-ui-phone-loading[aria-busy="true"]')).not.toBeNull();
      expect(container.querySelector('[data-gen-ui-viewport-width="360"][data-gen-ui-viewport-height="764"]')).not.toBeNull();
      act(() => flowChatStore.updateModelRoundItem('loading-session', 'loading-turn', item.id, {
        _genUIStream: { ...item._genUIStream!, content: harmonyApp.source.kind === 'openui-lang' ? harmonyApp.source.content : '' },
      }));
      expect(container.querySelector('.gen-ui-phone-skeleton')).toBeNull();
      expect(container.querySelector('[data-gen-ui-app]')).not.toBeNull();
      expect(container.textContent).toContain('Garden is ready');
      expect(container.querySelector('[data-hm-theme="green"]')).not.toBeNull();
      act(() => flowChatStore.updateModelRoundItem('loading-session', 'loading-turn', item.id, {
        status: 'completed', toolResult: { success: true, result: { app: harmonyApp } },
      }));
      expect(container.querySelector('.gen-ui-phone-loading')).toBeNull();
      expect(container.querySelector('[data-gen-ui-host-shell="phone"]')).not.toBeNull();
      expect(container.textContent).toContain('Garden is ready');
    } finally { act(() => root.unmount()); }
  });

  it('keeps the Harmony app mounted while successive source fragments add content', () => {
    const root = createRoot(container);
    const item = streamingItem(harmonyApp, 'root = Col([first])\nfirst = Text("First suggestion")');
    const origin = mountProjection(item);
    try {
      act(() => root.render(<GenerativeWidgetPanel origin={origin} presentation="inline" />));
      const appNode = container.querySelector('[data-gen-ui-app]');
      expect(appNode).not.toBeNull();
      expect(container.textContent).toContain('First suggestion');
      act(() => flowChatStore.updateModelRoundItem('loading-session', 'loading-turn', item.id, {
        _genUIStream: {
          ...item._genUIStream!,
          content: 'root = Col([first, second])\nfirst = Text("First suggestion")\nsecond = Text("Second suggestion")',
        },
      }));
      expect(container.querySelector('[data-gen-ui-app]')).toBe(appNode);
      expect(container.textContent).toContain('First suggestion');
      expect(container.textContent).toContain('Second suggestion');
    } finally { act(() => root.unmount()); }
  });

  it.each(['openui.v1', 'openbitfun.composable.v1'])('preserves live source preview for %s without a phone skeleton', libraryId => {
    const root = createRoot(container);
    const app: GenUIAppDefinition = {
      schemaVersion: 2, id: `preview-${libraryId}`, title: 'Preview',
      template: libraryId === 'openui.v1' ? 'openui.app' : 'openbitfun.app',
      libraryId, libraryRevision: libraryId === 'openui.v1' ? 1 : 2,
      designSpec: { id: 'openbitfun.desktop.v1', revision: 1 },
      source: { kind: 'openui-lang', content: 'root = Col([Text("Live source")])' }, state: {},
    };
    const origin = mountProjection(streamingItem(app, 'root = Col([Text("Live source")])'));
    try {
      act(() => root.render(<GenerativeWidgetPanel origin={origin} presentation="inline" />));
      expect(container.querySelector('.gen-ui-phone-loading')).toBeNull();
      expect(container.querySelector('[data-gen-ui-app]')).not.toBeNull();
      expect(container.textContent).toContain('Live source');
    } finally { act(() => root.unmount()); }
  });

  it.each([false, true])('silently hides a failed generation, with source=%s, while preserving its tool error', withSource => {
    const root = createRoot(container);
    const item: FlowToolItem = {
      ...streamingItem(harmonyApp), status: 'error',
      toolCall: { id: 'loading-call', input: withSource ? { app: harmonyApp } : {} },
      toolResult: { success: false, result: { error: 'Repair the source' } },
    };
    const origin = mountProjection(item);
    try {
      act(() => root.render(<GenerativeWidgetPanel origin={origin} presentation="inline" />));
      expect(container.innerHTML).toBe('');
      expect(flowChatStore.findToolItem('loading-session', 'loading-turn', item.id)?.toolResult).toEqual(item.toolResult);
    } finally { act(() => root.unmount()); }
  });

  it('silently hides a rejected candidate while retaining its validation feedback', () => {
    const root = createRoot(container);
    const item: FlowToolItem = {
      ...streamingItem(harmonyApp), status: 'rejected',
      toolCall: { id: 'loading-call', input: { app: harmonyApp } },
      toolResult: { success: false, result: { app: harmonyApp, error: 'Repair the description' } },
    };
    const origin = mountProjection(item);
    try {
      act(() => root.render(<GenerativeWidgetPanel origin={origin} presentation="inline" />));
      expect(container.innerHTML).toBe('');
      expect(flowChatStore.findToolItem('loading-session', 'loading-turn', item.id)?.toolResult).toEqual(item.toolResult);
    } finally { act(() => root.unmount()); }
  });
});
