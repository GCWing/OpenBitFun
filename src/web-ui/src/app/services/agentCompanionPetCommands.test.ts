import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAgentCompanionPetCommand } from './agentCompanionPetCommands';

const sendMessageMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const sessionsMock = vi.hoisted(() => new Map<string, unknown>());
const clearSessionUnreadCompletionMock = vi.hoisted(() => vi.fn());
const getSettingsAsyncMock = vi.hoisted(() => vi.fn());
const saveSettingsMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const openSettingsMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

const markAllSessionsReadMock = vi.hoisted(() => vi.fn());

vi.mock('@/app/services/markAllSessionsRead', () => ({
  markAllSessionsRead: markAllSessionsReadMock,
}));

vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({
  api: {
    invoke: invokeMock,
  },
}));

vi.mock('@/flow_chat/services/FlowChatManager', () => ({
  FlowChatManager: {
    getInstance: () => ({
      getFlowChatState: () => ({ sessions: sessionsMock }),
      sendMessage: sendMessageMock,
    }),
  },
}));

vi.mock('@/flow_chat/store/FlowChatStore', () => ({
  FlowChatStore: {
    getInstance: () => ({
      clearSessionUnreadCompletion: clearSessionUnreadCompletionMock,
    }),
  },
}));

vi.mock('@/infrastructure/config/services/AIExperienceConfigService', () => ({
  aiExperienceConfigService: {
    getSettingsAsync: getSettingsAsyncMock,
    saveSettings: saveSettingsMock,
  },
}));

vi.mock('@/shared/services/ide-control', () => ({
  quickActions: {
    openSettings: openSettingsMock,
  },
}));

describe('handleAgentCompanionPetCommand', () => {
  beforeEach(() => {
    sendMessageMock.mockClear();
    clearSessionUnreadCompletionMock.mockClear();
    saveSettingsMock.mockClear();
    openSettingsMock.mockClear();
    invokeMock.mockClear();
    sessionsMock.clear();
    getSettingsAsyncMock.mockReset();
    getSettingsAsyncMock.mockResolvedValue({
      enable_agent_companion: true,
    });
  });

  it('marks every session read like the sidebar view menu', async () => {
    markAllSessionsReadMock.mockClear();
    await handleAgentCompanionPetCommand({ type: 'mark-all-read' });

    expect(markAllSessionsReadMock).toHaveBeenCalledTimes(1);
  });

  it('opens the companion personalization settings', async () => {
    await handleAgentCompanionPetCommand({ type: 'open-pet-settings' });

    expect(openSettingsMock).toHaveBeenCalledWith({ pageId: 'application.pet' });
    expect(invokeMock).toHaveBeenCalledWith('show_main_window');
  });

  it('turns the desktop companion off when the pet is closed', async () => {
    await handleAgentCompanionPetCommand({ type: 'close-desktop-pet' });

    expect(saveSettingsMock).toHaveBeenCalledWith({
      enable_agent_companion: false,
    });
  });

  it('does not rewrite settings when the companion is already off', async () => {
    getSettingsAsyncMock.mockResolvedValue({
      enable_agent_companion: false,
    });

    await handleAgentCompanionPetCommand({ type: 'close-desktop-pet' });

    expect(saveSettingsMock).not.toHaveBeenCalled();
  });

  it('clears the unread completion mark for a dismissed bubble', async () => {
    await handleAgentCompanionPetCommand({ type: 'dismiss-task', sessionId: 'session-1' });

    expect(clearSessionUnreadCompletionMock).toHaveBeenCalledWith('session-1');
  });

  it('sends a bubble message into its own session', async () => {
    sessionsMock.set('session-1', { sessionId: 'session-1' });

    await handleAgentCompanionPetCommand({
      type: 'send-message',
      sessionId: 'session-1',
      message: '  ship it  ',
    });

    expect(sendMessageMock).toHaveBeenCalledWith('ship it', 'session-1');
    expect(clearSessionUnreadCompletionMock).toHaveBeenCalledWith('session-1');
  });

  it('ignores a bubble message for an unknown session', async () => {
    await handleAgentCompanionPetCommand({
      type: 'send-message',
      sessionId: 'missing-session',
      message: 'hello',
    });

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('ignores a blank bubble message', async () => {
    sessionsMock.set('session-1', { sessionId: 'session-1' });

    await handleAgentCompanionPetCommand({
      type: 'send-message',
      sessionId: 'session-1',
      message: '   ',
    });

    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
