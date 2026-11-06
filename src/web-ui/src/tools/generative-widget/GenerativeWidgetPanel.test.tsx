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

const autoRepair = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('@/tools/generative-ui/genUIAutoRepair', () => ({ requestGenUIAutoRepair: autoRepair }));

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

const openbitfunApp: GenUIAppDefinition = {
  schemaVersion: 2, id: 'loading-app', title: 'Plant garden',
  template: 'openbitfun.app', libraryId: 'openbitfun.composable.v1', libraryRevision: 2,
  designSpec: { id: 'openbitfun.desktop.v1', revision: 1 },
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
    autoRepair.mockClear();
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
      ...streamingItem(openbitfunApp), status: 'error',
      toolCall: { id: 'loading-call', input: withSource ? { app: openbitfunApp } : {} },
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
      ...streamingItem(openbitfunApp), status: 'rejected',
      toolCall: { id: 'loading-call', input: { app: openbitfunApp } },
      toolResult: { success: false, result: { app: openbitfunApp, error: 'Repair the description' } },
    };
    const origin = mountProjection(item);
    try {
      act(() => root.render(<GenerativeWidgetPanel origin={origin} presentation="inline" />));
      expect(container.innerHTML).toBe('');
      expect(flowChatStore.findToolItem('loading-session', 'loading-turn', item.id)?.toolResult).toEqual(item.toolResult);
    } finally { act(() => root.unmount()); }
  });

  it.each([false, true])('repairs missing references only after observing a live generation: live=%s', async live => {
    const root = createRoot(container);
    const app: GenUIAppDefinition = { ...openbitfunApp,
      source: { kind: 'openui-lang', content: 'root = Col([Button("Still usable"), missing])' },
    };
    const item = streamingItem(app, app.source!.content);
    const origin = mountProjection(item);
    flowChatStore.setState(previous => ({ ...previous, activeSessionId: origin.sessionId }));
    try {
      if (live) await act(async () => root.render(<GenerativeWidgetPanel origin={origin} presentation="inline" />));
      await act(async () => {
        mountProjection({ ...item, status: 'completed', toolResult: { success: true, result: { app, app_state: {} } } });
      });
      await act(async () => root.render(<GenerativeWidgetPanel origin={origin} presentation="inline" />));
      expect(container.textContent).toContain('Still usable');
      expect(container.querySelector<HTMLButtonElement>('.gen-ui-application button')?.disabled).toBe(false);
      if (live) expect(autoRepair).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ render: 'passed',
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'unresolved-reference', statementId: 'missing' })]),
      }));
      else {
        expect(autoRepair).not.toHaveBeenCalled();
        expect(container.querySelector('[data-openbitfun-state="repairRequired"]')).not.toBeNull();
      }
    } finally { await act(async () => root.unmount()); }
  });

  it.each(['processing', 'finishing', 'completed'] as const)('handles a deferred GenUI card first mounted during owning turn status %s', async status => {
    const root = createRoot(container);
    const app: GenUIAppDefinition = { ...openbitfunApp,
      source: { kind: 'openui-lang', content: 'root = Col([Button("Still usable"), missing])' },
    };
    const item: FlowToolItem = { ...streamingItem(app), toolName: 'CallDeferredTool', status: 'completed',
      toolCall: { id: 'loading-call', input: { tool_name: 'GenerativeUI', args: {} } },
      toolResult: { success: true, result: { app, app_state: {} } },
    };
    const origin = mountProjection(item);
    flowChatStore.setState(previous => ({ ...previous, activeSessionId: origin.sessionId,
      sessions: new Map([...previous.sessions].map(([id, session]) => [id, { ...session,
        dialogTurns: session.dialogTurns.map(turn => ({ ...turn, status })),
      }])),
    }));
    try {
      await act(async () => root.render(<GenerativeWidgetPanel origin={origin} presentation="inline" />));
      expect(container.textContent).toContain('Still usable');
      if (status === 'completed') {
        expect(autoRepair).not.toHaveBeenCalled();
        expect(container.querySelector('[data-openbitfun-state="repairRequired"]')).not.toBeNull();
      } else {
        expect(autoRepair).toHaveBeenCalledTimes(1);
        expect(container.querySelector('[data-openbitfun-state="repairRequired"]')).toBeNull();
      }
    } finally { await act(async () => root.unmount()); }
  });
});
