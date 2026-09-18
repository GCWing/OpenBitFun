import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { VoiceConversationLedger } from './voiceConversationLedger';

const fixture = vi.hoisted(() => ({ stage: vi.fn(), record: vi.fn(), replay: vi.fn(), sessions: new Map() }));
vi.mock('../../services/controlConversation', () => ({ stageVoiceExchange: fixture.stage, recordVoiceExchange: fixture.record, replayVoiceExchanges: fixture.replay }));
vi.mock('../../store/FlowChatStore', () => ({ flowChatStore: { getState: () => ({ sessions: fixture.sessions }), subscribe: () => () => {} } }));
const target = { kind: 'control' as const, surfaceId: 'local', sessionId: 'control', workspaceId: 'workspace-control', workspacePath: '/control' };
describe('final voice exchange ledger', () => {
  beforeEach(() => { activateSurface('local'); vi.clearAllMocks(); fixture.sessions.clear(); });
  it('revises provisional ASR in place without persisting it', () => {
    const snapshots = vi.fn();
    const ledger = new VoiceConversationLedger(target, vi.fn(), snapshots);
    ledger.preview('user', 'Change');
    ledger.preview('user', 'Change the theme');
    ledger.flush();
    const snapshot = snapshots.mock.calls.at(-1)![0];
    expect(snapshot.target).toMatchObject({ surfaceId: 'local', sessionId: 'control' });
    expect(snapshot.exchanges).toEqual([expect.objectContaining({ id: ledger.exchangeId, user: 'Change the theme' })]);
    expect(fixture.stage).not.toHaveBeenCalled();
  });
  it('keeps a final preview until canonical persistence has completed', async () => {
    let release: () => void = () => {};
    fixture.record.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const snapshots = vi.fn();
    const ledger = new VoiceConversationLedger(target, vi.fn(), snapshots);
    ledger.user('Hello'); ledger.assistant('Hi'); ledger.flush();
    await vi.waitFor(() => expect(fixture.record).toHaveBeenCalledOnce());
    expect(snapshots.mock.calls.at(-1)![0].exchanges).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(snapshots.mock.calls.at(-1)![0].exchanges).toHaveLength(0));
  });
  it('records final public text once and stages it before asynchronous persistence', async () => {
    const ledger = new VoiceConversationLedger(target, vi.fn());
    ledger.user('hello'); ledger.assistant('world'); ledger.flush(); ledger.flush();
    expect(fixture.stage).toHaveBeenCalledOnce();
    expect(fixture.stage.mock.calls[0][0]).toMatchObject({ userText: 'hello', assistantText: 'world', sessionId: 'control', workspaceId: 'workspace-control' });
    expect(fixture.stage.mock.calls[0][0]).not.toHaveProperty('workspacePath');
    await vi.waitFor(() => expect(fixture.record).toHaveBeenCalledOnce());
  });
  it('prefers the loaded conversation workspace and never stages without an owner', () => {
    fixture.sessions.set('control', { workspaceId: 'workspace-live', config: {} });
    new VoiceConversationLedger(target, vi.fn()).user('hello');
    const live = new VoiceConversationLedger(target, vi.fn());
    live.user('hello'); live.assistant('hi'); live.flush();
    expect(fixture.stage.mock.calls[0][0]).toMatchObject({ workspaceId: 'workspace-live' });
    fixture.sessions.clear(); fixture.stage.mockClear();
    const unowned = new VoiceConversationLedger({ ...target, workspaceId: undefined }, vi.fn());
    unowned.user('hello'); unowned.assistant('hi'); unowned.flush();
    expect(fixture.stage).not.toHaveBeenCalled();
    expect(fixture.record).not.toHaveBeenCalled();
  });
  it('does not duplicate a task transcript after a native acknowledgement', async () => {
    const ledger = new VoiceConversationLedger(target, vi.fn());
    ledger.user('rename my workspace'); ledger.assistant('I will do that');
    expect(await ledger.delegate()).toBe('rename my workspace');
    ledger.flush(); ledger.next();
    expect(fixture.stage).not.toHaveBeenCalled();
    expect(fixture.record).not.toHaveBeenCalled();
  });
  it('persists the previous exchange before the next runtime task reads history', async () => {
    const ledger = new VoiceConversationLedger(target, vi.fn());
    ledger.user('remember blue'); ledger.assistant('okay'); ledger.next(); ledger.user('use that color');
    expect(await ledger.delegate()).toBe('use that color');
    expect(fixture.record).toHaveBeenCalledOnce();
    expect(fixture.replay).toHaveBeenCalledOnce();
  });
  it('keeps an old-device exchange staged without writing to the newly active device', async () => {
    const onError = vi.fn();
    const ledger = new VoiceConversationLedger(target, onError);
    ledger.user('old device'); activateSurface('peer'); ledger.flush();
    expect(fixture.stage.mock.calls[0][0].surfaceId).toBe('local');
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(fixture.record).not.toHaveBeenCalled();
  });
});
