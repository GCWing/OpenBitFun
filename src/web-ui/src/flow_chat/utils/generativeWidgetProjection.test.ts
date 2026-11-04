import examples from '../../../../shared/generative-ui/examples.json';
import { describeGenUIApp } from '@/tools/generative-ui/genUIProtocol';
import type { GenUIAppDefinition } from '@/tools/generative-ui/genUITypes';
import { describe, expect, it } from 'vitest';
import type { FlowToolItem, Session } from '../types/flow-chat';
import {
  findGenerativeWidgetProjection,
  projectGenerativeWidgetTool,
} from './generativeWidgetProjection';

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    dialogTurns: [],
    status: 'active',
    config: {},
    createdAt: 1,
    lastActiveAt: 1,
    error: null,
    workspaceId: 'workspace-1',
    workspacePath: '/workspace/project',
    ...overrides,
  } as Session;
}

function tool(overrides: Partial<FlowToolItem> = {}): FlowToolItem {
  return {
    id: 'tool-1',
    type: 'tool',
    toolName: 'GenerativeUI',
    timestamp: 1,
    status: 'streaming',
    isParamsStreaming: true,
    partialParams: { app: { ...examples.picker, title: 'Partial' } },
    toolCall: { id: 'call-1', input: { app: examples.picker } },
    ...overrides,
  };
}

describe('generative widget projection', () => {
  it.each([false, true])('identifies Harmony loading from native stream metadata before source arrives, deferred=%s', deferred => {
    const projection = projectGenerativeWidgetTool(session(), tool({
      toolName: deferred ? 'CallDeferredTool' : 'GenerativeUI',
      toolCall: { id: 'call', input: deferred ? { tool_name: 'GenerativeUI', args: {} } : {} },
      _genUIStream: { messageId: 'source', format: 'openui-lang', content: '', nextSeq: 1, libraryId: 'openbitfun.harmony.v1', libraryRevision: 3 },
    }));
    expect(projection).toMatchObject({ deliveryMode: 'delivery', libraryId: 'openbitfun.harmony.v1', isStreaming: true, sourceAvailable: false });
    expect(projection?.app).toBeUndefined();
  });

  it('exposes the stream profile from its declared template before the source arrives', () => {
    const projection = projectGenerativeWidgetTool(session(), tool({
      toolCall: { id: 'call', input: {} },
      _genUIStream: { messageId: 'source', format: 'openui-lang', content: '', nextSeq: 1, template: 'openbitfun.harmony.app' },
    }));
    expect(projection).toMatchObject({ deliveryMode: 'delivery', libraryId: 'openbitfun.harmony.v1', sourceAvailable: false });
  });

  it.each([false, true])('projects a source document while parameters stream, deferred=%s', deferred => {
    const app = { schemaVersion: 2, id: 'stream-source', title: 'Stream source', template: 'openbitfun.app', libraryId: 'openbitfun.composable.v1', libraryRevision: 2, designSpec: { id: 'openbitfun.desktop.v1', revision: 1 }, root: 'root', state: {}, source: { kind: 'openui-lang', content: 'root = Col([Text("Hello")])' } } as GenUIAppDefinition;
    const parsed = deferred ? { tool_name: 'GenerativeUI', args: { app } } : { app };
    const item = tool({
      toolName: deferred ? 'CallDeferredTool' : 'GenerativeUI',
      _genUIStream: { messageId: 'call', format: 'openui-lang', content: app.source.content, nextSeq: 1 },
      toolCall: { id: 'call', input: parsed },
    });
    const preview = projectGenerativeWidgetTool(session(), item)!;
    expect(preview.app).toMatchObject({ id: app.id, source: app.source });
    expect(preview).toMatchObject({ isStreaming: true, readOnly: false });
  });
  it('rejects a removed graph message instead of previewing it', () => {
    const generation = describeGenUIApp({ schemaVersion: 2, id: 'source', title: 'Source', template: 'openbitfun.app', libraryId: 'openbitfun.composable.v1', libraryRevision: 2, designSpec: { id: 'openbitfun.desktop.v1', revision: 1 }, root: 'root', state: {}, source: { kind: 'openui-lang', content: 'root = Col([])' } } as GenUIAppDefinition);
    generation.messages.push({ updateLogic: {} });
    const item = tool({ _paramsBuffer: JSON.stringify(generation), partialParams: generation, toolCall: { id: 'call', input: generation } });
    expect(projectGenerativeWidgetTool(session(), item)?.app).toBeUndefined();
  });
  it('hydrates source initial values only after their complete message arrives', () => {
    const app = { schemaVersion: 2, id: 'source-state', title: 'Source state', template: 'openbitfun.app', libraryId: 'openbitfun.composable.v1', libraryRevision: 2, designSpec: { id: 'openbitfun.desktop.v1', revision: 1 }, root: 'root', state: { name: { type: 'string', default: '' } }, source: { kind: 'openui-lang', content: 'root = Col([])' } } as GenUIAppDefinition;
    const item = tool({
      status: 'completed',
      isParamsStreaming: false,
      toolCall: { id: 'call', input: { app } },
      toolResult: { success: true, result: { app, app_state: { name: 'Ada' } } },
    });
    expect(projectGenerativeWidgetTool(session(), item)?.appState).toEqual({ name: 'Ada' });
  });
  it('filters unfinished nodes but validates the failed terminal source without preview repair', () => {
    const parsed = { app: examples.picker };
    const item = tool({ status: 'completed', isParamsStreaming: false, toolCall: { id: 'call', input: parsed }, toolResult: { success: false, result: parsed } });
    const preview = projectGenerativeWidgetTool(session(), item)!;
    expect(preview.isStreaming).toBe(false);
    item.status = 'error';
    const failed = projectGenerativeWidgetTool(session(), item)!;
    expect(failed.app).toEqual(parsed.app);
    expect(failed.isStreaming).toBe(false);
    expect(failed.isFailed).toBe(true);
  });
  it('never hydrates partial app_state or skips an accepted replacement', () => {
    const partial = tool({ partialParams: { app: examples.picker, app_state: { selected: [{ id: 'half' }] } } });
    expect(projectGenerativeWidgetTool(session(), partial)!.appState).toBeUndefined();
    const original = tool({ status: 'error', isParamsStreaming: false });
    const accepted = tool({ id: 'accepted', status: 'completed', isParamsStreaming: false, toolCall: { id: 'accepted', input: { app: examples.picker } }, toolResult: { success: true, result: { app: examples.picker, app_state: { query: 'edited' } } } });
    const later = tool({ id: 'later', toolCall: { id: 'later', input: { app: examples.picker } } });
    const owner = session({ dialogTurns: [{ id: 'turn', modelRounds: [{ items: [original, accepted, later] }] }] as any });
    const origin = projectGenerativeWidgetTool(owner, original, { turnId: 'turn' })!.origin;
    expect(findGenerativeWidgetProjection({ sessions: new Map([[owner.sessionId, owner]]) } as any, origin, true)?.origin.toolCallId).toBe('accepted');
  });
  it('follows only failed same-turn same-app repairs and retains exact source lookup', () => {
    const failed = tool({ status: 'error', isParamsStreaming: false, toolResult: { success: false, result: {} } });
    const repaired = tool({ id: 'tool-2', status: 'completed', isParamsStreaming: false, toolCall: { id: 'call-2', input: { app: examples.picker } }, toolResult: { success: true, result: { app: examples.picker } } });
    const owner = session({ dialogTurns: [{ id: 'turn-1', modelRounds: [{ items: [failed, repaired] }] }] as any });
    const original = projectGenerativeWidgetTool(owner, failed, { turnId: 'turn-1' })!;
    const state = { sessions: new Map([[owner.sessionId, owner]]) } as any;
    expect(findGenerativeWidgetProjection(state, original.origin)?.origin.toolCallId).toBe('call-1');
    expect(findGenerativeWidgetProjection(state, original.origin, true)?.origin.toolCallId).toBe('call-2');
    failed.status = 'completed'; failed.toolResult = { success: true, result: { app: examples.picker, app_state: { query: 'edited' } } };
    expect(findGenerativeWidgetProjection(state, original.origin, true)?.origin.toolCallId).toBe('call-1');
  });

  it('follows a provider retry when the superseded shell has no terminal app', () => {
    const superseded = tool({
      status: 'superseded',
      isParamsStreaming: true,
      toolCall: { id: 'call-1', input: {} },
      attemptId: 'turn-1:attempt:1',
      attemptIndex: 1,
      _genUIStream: undefined,
    });
    const repaired = tool({
      id: 'tool-2',
      status: 'completed',
      isParamsStreaming: false,
      toolCall: { id: 'call-2', input: { app: examples.picker } },
      attemptId: 'turn-1:attempt:2',
      attemptIndex: 2,
      toolResult: { success: true, result: { app: examples.picker } },
    });
    const owner = session({ dialogTurns: [{ id: 'turn-1', modelRounds: [{ items: [superseded, repaired], attempts: [
      { id: 'turn-1:attempt:1', index: 1, status: 'superseded', items: [superseded] },
      { id: 'turn-1:attempt:2', index: 2, status: 'completed', items: [repaired] },
    ] }] }] as any });
    const original = projectGenerativeWidgetTool(owner, superseded, { turnId: 'turn-1' })!;
    const state = { sessions: new Map([[owner.sessionId, owner]]) } as any;
    expect(findGenerativeWidgetProjection(state, original.origin, true)?.origin.toolCallId).toBe('call-2');
  });
  it('uses the terminal result as the source of truth over partial parameters', () => {
    const projection = projectGenerativeWidgetTool(
      session(),
      tool({
        status: 'completed',
        isParamsStreaming: false,
        toolResult: {
          success: true,
          result: { app: { ...examples.picker, title: 'Final' }, widget_id: 'final-id' },
        },
      }),
      { turnId: 'turn-1' },
      'surface-1',
    );

    expect(projection).toMatchObject({
      title: 'Final',
      widgetId: 'final-id',
      app: expect.objectContaining({ title: 'Final' }),
      isComplete: true,
      isStreaming: false,
    });
  });

  it('projects a host-rendered app and its persisted state', () => {
    const app = examples.picker;
    const projection = projectGenerativeWidgetTool(
      session(),
      tool({
        status: 'completed',
        isParamsStreaming: false,
        toolResult: {
          success: true,
          result: {
            title: app.title,
            app,
            app_state: { selected: [], query: 'Camera' },
          },
        },
      }),
      { turnId: 'turn-accounting' },
      'surface-1',
    );

    expect(projection?.app).toEqual(app);
    expect(projection?.appState).toEqual({ selected: [], query: 'Camera' });
    expect(projection?.title).toBe(app.title);
    expect(projection?.sourceAvailable).toBe(true);
  });

  it('keeps the default OpenUI result interactive without a delivery lifecycle', () => {
    const app = examples.picker;
    const projection = projectGenerativeWidgetTool(session(), tool({
      status: 'completed',
      isParamsStreaming: false,
      toolResult: { success: true, result: { app, verification: { mode: 'transient', persistence: 'skipped' } } },
    }), { turnId: 'turn-openui' });

    expect(projection).toMatchObject({ deliveryMode: 'transient', interactionState: 'interactive' });
  });

  it('marks only Harmony results as delivery oriented', () => {
    const app = { ...examples.picker, template: 'openbitfun.harmony.app', libraryId: 'openbitfun.harmony.v1' };
    const projection = projectGenerativeWidgetTool(session(), tool({
      status: 'completed',
      isParamsStreaming: false,
      toolResult: { success: true, result: { app, verification: { mode: 'delivery', persistence: 'saved', reopen: 'passed' } } },
    }), { turnId: 'turn-harmony' });

    expect(projection).toMatchObject({ deliveryMode: 'delivery', interactionState: 'complete' });
  });

  it('unwraps deferred GenerativeUI calls for both input and streamed parameters', () => {
    const projection = projectGenerativeWidgetTool(
      session(),
      tool({
        toolName: 'CallDeferredTool',
        toolCall: {
          id: 'deferred-call',
          input: {
            tool_name: 'GenerativeUI',
            args: { app: { ...examples.picker, title: 'Deferred' } },
          },
        },
        partialParams: {
          tool_name: 'GenerativeUI',
          args: { app: { ...examples.picker, title: 'Deferred partial' } },
        },
      }),
      { turnId: 'turn-deferred' },
      'surface-1',
    );

    expect(projection).toMatchObject({
      title: 'Deferred',
      app: expect.objectContaining({ title: 'Deferred' }),
      origin: {
        toolCallId: 'deferred-call',
        toolItemId: 'tool-1',
        turnId: 'turn-deferred',
      },
    });
  });

  it('binds the origin to surface, session and workspace scope', () => {
    const projected = projectGenerativeWidgetTool(
      session({ remoteConnectionId: 'remote-1' }),
      tool({ status: 'completed', isParamsStreaming: false }),
      { turnId: 'turn-1' },
      'surface-remote',
    );

    expect(projected?.origin).toMatchObject({
      surfaceId: 'surface-remote',
      sessionId: 'session-1',
      scope: {
        surfaceId: 'surface-remote',
        workspaceId: 'workspace-1',
        workspacePath: '/workspace/project',
        remoteConnectionId: 'remote-1',
      },
    });
  });

  it('finds a projection only on its originating surface', () => {
    const current = session({
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'session-1',
        userMessage: { id: 'user-1', content: 'show', timestamp: 1 },
        modelRounds: [{
          id: 'round-1', index: 0, items: [tool({ status: 'completed', isParamsStreaming: false })],
          isStreaming: false, isComplete: true, status: 'completed', startTime: 1,
        }],
        status: 'completed', startTime: 1,
      }],
    });

    const state = { sessions: new Map([[current.sessionId, current]]), activeSessionId: current.sessionId };
    expect(findGenerativeWidgetProjection(state, {
      surfaceId: 'other-surface', sessionId: 'session-1', turnId: 'turn-1', toolCallId: 'call-1',
    })).toBeNull();
  });
  it('retains unsupported envelopes for diagnostics without restoring an old renderer', () => {
    const app = { schemaVersion: 1, id: 'legacy', title: 'Legacy', parts: [] };
    const item = tool({ status: 'completed', toolResult: { success: true, result: { app, app_state: { legacy: ['keep'] } } } });
    const before = JSON.stringify(item);
    expect(projectGenerativeWidgetTool(session(), item)?.app).toEqual(app);
    expect(JSON.stringify(item)).toBe(before);
  });
  it('does not use executable widget content as an application fallback', () => {
    const item = tool({ status: 'completed', isParamsStreaming: false, toolCall: { id: 'old', input: { widget_code: '<p>old</p>' } }, toolResult: { success: true, result: { widget_code: '<p>old</p>' } } });
    expect(projectGenerativeWidgetTool(session(), item)).toMatchObject({ sourceAvailable: false, readOnly: true });
  });

});

