import { useState } from 'react';
import { flowChatStore } from '../../src/flow_chat/store/FlowChatStore';
import { processToolEvent } from '../../src/flow_chat/services/flow-chat-manager/ToolEventModule';
import { projectGenerativeWidgetTool } from '../../src/flow_chat/utils/generativeWidgetProjection';
import type { FlowToolItem, Session } from '../../src/flow_chat/types/flow-chat';
import { describeGenUIApp, reduceGenUIMessages } from '../../src/tools/generative-ui/genUIProtocol';
import type { GenUIAppDefinition } from '../../src/tools/generative-ui/genUITypes';
import GenerativeWidgetPanel from '../../src/tools/generative-widget/GenerativeWidgetPanel';

/** Production parameter ingestion -> store -> subscribed panel -> source renderer. */
export default function GenUIStreamingFixture({ deferred }: { deferred: boolean }) {
  const [fixture] = useState(() => {
    const app: GenUIAppDefinition = { schemaVersion: 2, id: 'stream-source', title: 'Streaming source', template: 'openui.app', libraryId: 'openbitfun.composable.v1', libraryRevision: 2, designSpec: { id: 'openbitfun.desktop.v1', revision: 1 }, source: { kind: 'openui-lang', content: 'root = Col([Text("Streaming source")])' }, state: {} };
    const generation = describeGenUIApp(app);
    const source = app.source.kind === 'openui-lang' ? app.source.content : '';
    const checkpoints = [Math.floor(source.length / 3), Math.floor(source.length * 2 / 3), source.length];
    const item: FlowToolItem = { id: 'stream-tool', type: 'tool', toolName: deferred ? 'CallDeferredTool' : 'GenerativeUI', timestamp: 1, status: 'preparing', toolCall: { id: 'stream-tool', input: deferred ? { tool_name: 'GenerativeUI', args: {} } : {} }, isParamsStreaming: true };
    const session = { sessionId: 'stream-session', status: 'active', config: {}, createdAt: 1, dialogTurns: [{ id: 'stream-turn', sessionId: 'stream-session', userMessage: { id: 'user', content: 'Build an app', timestamp: 1 }, status: 'processing', startTime: 1, modelRounds: [{ id: 'stream-round', index: 0, items: [item], isStreaming: true, isComplete: false, status: 'streaming', startTime: 1 }] }] } as Session;
    flowChatStore.setState(() => ({ sessions: new Map([[session.sessionId, session]]), activeSessionId: session.sessionId }));
    return { app, source, checkpoints, item, generation, offset: 0 };
  });
  const [stage, setStage] = useState(0);
  const advance = () => {
    const end = fixture.checkpoints[stage];
    if (end !== undefined) {
      const text = fixture.source.slice(fixture.offset, end);
      processToolEvent({} as never, 'stream-session', 'stream-turn', 'stream-round', {
        event_type: 'GenUIStream',
        tool_id: 'stream-tool',
        tool_name: fixture.item.toolName,
        effective_tool_name: 'GenerativeUI',
        message_id: 'stream-source',
        seq: stage,
        format: 'openui-lang',
        text,
        reset: stage === 0,
        app_id: 'stream-source',
        title: 'Streaming source',
        template: fixture.app.template,
        library_id: fixture.app.libraryId,
        library_revision: fixture.app.libraryRevision,
      });
      fixture.offset = end;
    } else {
      const document = reduceGenUIMessages(fixture.generation);
      flowChatStore.updateModelRoundItem('stream-session', 'stream-turn', 'stream-tool', { status: 'completed', isParamsStreaming: false, toolResult: { success: true, result: { app: document.app, app_state: document.state } } });
    }
    setStage(stage + 1);
  };
  const session = flowChatStore.getState().sessions.get('stream-session')!;
  const item = flowChatStore.findToolItem('stream-session', 'stream-turn', 'stream-tool') as FlowToolItem;
  const projection = projectGenerativeWidgetTool(session, item, { turnId: 'stream-turn' });
  return <div data-testid="genui-stream" data-stage={stage} data-sent={fixture.offset} data-total={fixture.source.length}>
    <button data-testid="stream-advance" disabled={stage > fixture.checkpoints.length} onClick={advance}>Advance stream</button>
    {projection && <GenerativeWidgetPanel origin={projection.origin} />}
  </div>;
}
