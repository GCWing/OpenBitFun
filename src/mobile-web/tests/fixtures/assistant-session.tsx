import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/styles/reset.scss';
import '@openbitfun/theme-openbitfun/default.css';
import '@openbitfun/ui/mobile.css';
import '../../src/styles/index.scss';
import SessionListPage from '../../src/pages/SessionListPage';
import ChatPage from '../../src/pages/ChatPage';
import { I18nProvider } from '../../src/i18n';
import { ThemeProvider } from '../../src/theme';
import { useMobileStore } from '../../src/services/store';
import { RemoteSessionManager, type SessionInfo } from '../../src/services/RemoteSessionManager';
import type { SessionWorkspaceContext } from '../../src/services/workspaceIdentity';
import type { RelayHttpClient } from '../../src/services/RelayHttpClient';
import { queueStorage, type QueueItem, type QueueOutboxRecord } from '../../../shared/dialog-queue/HostDialogQueue';

/** Real sidebar, chat, manager and durable outbox; only host IO is simulated. */
export async function mountAssistantSessionFixture({ legacyWorkspace = false, queueSupported = true, legacyPending = false, selectedProject = false } = {}) {
  const account = 'assistant-mode-account', device = 'assistant-mode-host', sessionId = 'assistant-session';
  const capabilities = ['host_stream_v1', ...(queueSupported ? ['dialog_queue_v1'] : []),
    ...(legacyWorkspace ? [] : ['workspace_id_references_v1', 'harness_profiles_v1'])];
  const assistant = { ...(legacyWorkspace ? {} : { workspace_id: 'assistant-workspace' }),
    path: '/fixtures/assistant', name: 'Assistant', workspace_kind: 'assistant' as const, last_opened: '' };
  const session: SessionInfo = { session_id: sessionId, name: 'New Session', agent_type: 'Claw',
    workspace_id: assistant.workspace_id, workspace_path: assistant.path, created_at: '1', updated_at: '1', message_count: 0,
    // The host sends the root label; the assistant identity name lives on the catalog row.
    ...(selectedProject ? { workspace_name: 'workspace' } : {}) };
  // Issue 2360 shape: the host's selected workspace is a Git project, not the assistant.
  const project = (name: string) => ({ workspace_id: `${name}-workspace`, path: `/fixtures/${name}`, name,
    workspace_kind: 'normal' as const, last_opened: '' });
  const projects = selectedProject ? [project('home'), project('api')] : [];
  const projectSessions: SessionInfo[] = projects.map((workspace) => ({ session_id: `${workspace.name}-session`,
    name: `${workspace.name} session`, agent_type: 'agentic', workspace_id: workspace.workspace_id,
    workspace_path: workspace.path, workspace_name: workspace.name, created_at: '1', updated_at: '1', message_count: 0 }));
  const calls: Array<Record<string, any>> = [], sessions: SessionInfo[] = legacyPending ? [session] : [];
  const receipts = new Map<string, QueueItem>();
  const scope = JSON.stringify([account, device, sessionId]);
  const pending: QueueOutboxRecord = { scope, key: JSON.stringify([scope, 'before-upgrade-turn']),
    request: { sessionId, queueEpoch: 'assistant-epoch', action: 'submit', message: {
      turnId: 'before-upgrade-turn', agentType: 'claw', content: 'Keep my existing message',
      attachments: [{ kind: 'remote_image', id: 'existing-image', metadata: { dataUrl: 'data:image/png;base64,fixture', agentType: 'claw' } }],
      metadata: { agentType: 'claw', original: true },
    } } };
  if (legacyPending) await queueStorage.put(JSON.parse(JSON.stringify(pending)));
  const client = {
    accountUserId: account, hasAccountIdentity: false, controlTargetEpoch: 0, targetDeviceId: device,
    getControlTargetSnapshot: () => ({ deviceId: device, epoch: 0 }),
    isControlTargetCurrent: (target: { deviceId: string; epoch: number }) => target.deviceId === device && target.epoch === 0,
    onControlTargetChange: () => () => {}, onDeviceDirectoryChanged: () => () => {},
    subscribeHostStream: async (_id: string, handlers: Parameters<RemoteSessionManager['subscribeSessionStream']>[1]) => {
      handlers.onHistoryState?.({ hasMore: false, oldestSeq: null, cursor: 0, truncated: false });
      handlers.onCaughtUp?.();
      return { close() {}, wake() {}, loadOlder: async () => {} };
    },
    async sendDeviceRpc(target: string, command: Record<string, any>) {
      calls.push(structuredClone({ device: target, ...command }));
      switch (command.cmd) {
        case 'get_workspace_info': return selectedProject
          ? { resp: 'workspace_info', workspace_id: projects[0].workspace_id, path: projects[0].path, project_name: projects[0].name,
            git_branch: 'master', workspace_kind: 'normal', has_workspace: true, capabilities }
          : { resp: 'workspace_info', ...assistant, has_workspace: true, capabilities };
        case 'list_recent_workspaces': return { resp: 'recent_workspaces', workspaces: [assistant, ...projects],
          ...(legacyWorkspace ? {} : { opened_workspaces: [assistant, ...projects] }) };
        case 'list_assistants': return { resp: 'assistant_list', assistants: [assistant] };
        case 'list_sessions': return { resp: 'sessions', has_more: false, sessions: selectedProject
          ? [...sessions, ...projectSessions].filter((row) => row.workspace_id === command.workspace_id)
          : sessions };
        // The RemoteCommand create path accepts the mobile alias. The queue
        // invokes the runtime directly and requires its registered mode ID.
        case 'create_session': sessions.push(session); return { resp: 'session_created', ...session };
        case 'get_model_catalog': return { resp: 'model_catalog', catalog: { version: 1, models: [], default_models: {} } };
        case 'host_invoke': {
          if (command.command !== 'get_session_interaction_mailbox') throw new Error(`Unexpected host command: ${command.command}`);
          return { resp: 'host_invoke', ok: true, value: { sessionId, permissions: { revision: 0, requests: [] }, userQuestions: { revision: 0, questions: [] } } };
        }
        case 'send_message': return { resp: 'message_sent', turn_id: 'legacy-turn' };
        case 'dialog_queue': {
          const request = command.request;
          let receipt = request.action === 'get' ? receipts.get(request.turnId) ?? null : null;
          if (request.action === 'submit') {
            const message = request.message;
            if (!['Claw', 'Cowork', 'agentic', 'minimal', 'Ultra', 'Creative', 'plugin::claw'].includes(message.agentType)) {
              throw new Error(`Unknown session mode: ${message.agentType}`);
            }
            receipt = { turnId: message.turnId, agentType: message.agentType, displayContent: message.content,
              previewTruncated: false, attachmentCount: message.attachments.length, createdAtMs: 1,
              status: 'started' as const, reason: null, targetTurnId: null, steeringId: null };
            receipts.set(message.turnId, receipt);
          }
          return { resp: 'dialog_queue', snapshot: { sessionId, queueEpoch: 'assistant-epoch', revision: receipts.size,
            activeTurnId: receipt?.turnId ?? null, items: [], capacity: 20, used: receipts.size, receipt } };
        }
        default: throw new Error(`Unexpected command: ${command.cmd}`);
      }
    },
  } as unknown as RelayHttpClient;
  const manager = new RemoteSessionManager(client, capabilities);
  useMobileStore.getState().resetForDeviceSwitch();
  useMobileStore.setState({ authenticatedUserId: account, connectionHealth: 'connected',
    // A paired relay has no device name, so the header shows the workspace line.
    controlTarget: { deviceId: device, deviceName: selectedProject ? null : 'Host' }, error: null });
  localStorage.setItem('openbitfun-mobile-language', 'en-US');
  const element = document.createElement('main');
  element.className = 'mobile-app';
  document.body.replaceChildren(element);
  const root = createRoot(element);
  function Fixture() {
    const [selected, setSelected] = useState<{ id: string; agentType?: string; workspace?: SessionWorkspaceContext } | null>(legacyPending ? { id: sessionId, agentType: 'Claw' } : null);
    return <ThemeProvider><I18nProvider>{selected
      ? <ChatPage sessionMgr={manager} sessionId={selected.id} sessionName="New Session" agentType={selected.agentType}
        workspace={selected.workspace}
        autoFocus onBack={() => setSelected(null)} wideLayout={window.innerWidth >= 900} />
      : <SessionListPage compact client={client} sessionMgr={manager}
        onSelectSession={(id, _name, _isNew, agentType, workspace) => setSelected({ id, agentType, workspace })}
        onOpenWorkspace={() => {}} onDisconnect={() => {}} />
    }</I18nProvider></ThemeProvider>;
  }
  root.render(<Fixture />);
  return { calls, manager, pending, receipts, sessionId, dispose: () => root.unmount() };
}
