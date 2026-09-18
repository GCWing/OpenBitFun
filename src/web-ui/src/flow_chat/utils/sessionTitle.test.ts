// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../types/flow-chat';
import type { SessionMetadata } from '@/shared/types/session-history';
import { createDefaultSessionTitleDescriptor, deriveSessionTitleState, deriveSessionTitleStateFromMetadata, freezeSessionTitleState, resolvePersistedSessionTitle, resolveSessionTitle } from './sessionTitle';
import { buildSessionMetadata } from './sessionMetadata';
import { sessionTitleNumbers } from './sessionTitlePresentation';

vi.mock('@/infrastructure/i18n', () => ({ i18nService: { t: (key: string) => key } }));

const translate = (key: string) => key === 'flow-chat:session.new' ? 'New Session' : key;
function session(id: string, path: string, number = 1, overrides: Partial<Session> = {}): Session {
  return {
    sessionId: id, ...deriveSessionTitleState(createDefaultSessionTitleDescriptor(translate)),
    workspaceSessionNumber: number, workspacePath: path, config: {},
    dialogTurns: [], status: 'idle', createdAt: number, lastActiveAt: number, error: null,
    mode: 'Standard', sessionKind: 'normal', ...overrides,
  };
}

describe('workspace session titles', () => {
  it('uses one plain default title independently of the workspace number', () => {
    expect(createDefaultSessionTitleDescriptor(translate)).toMatchObject({ text: 'New Session', key: 'flow-chat:session.new' });
    expect(resolveSessionTitle(session('a', '/a', 27), translate)).toBe('New Session');
  });

  it('shows numbers only for duplicate default titles in the same workspace, across modes', () => {
    const a = session('a', '/a');
    const b = session('b', '/b');
    expect(sessionTitleNumbers([a, b]).size).toBe(0);
    const c = session('c', '/a', 2, { mode: 'Cowork' });
    expect([...sessionTitleNumbers([a, b, c])]).toEqual([['a', 1], ['c', 2]]);
  });

  it('keeps surviving display slots stable when a vacant number is reused', () => {
    const a = session('a', '/a', 2);
    const b = session('b', '/a', 8);
    expect(sessionTitleNumbers([b, a]).get('a')).toBe(2);
    const renamed = { ...a, ...freezeSessionTitleState('Fix login') };
    expect(renamed.workspaceSessionNumber).toBe(2);
    expect(sessionTitleNumbers([renamed, b]).size).toBe(0);
    const c = session('c', '/a', 2);
    expect(sessionTitleNumbers([b, c]).get('b')).toBe(8);
    expect([...sessionTitleNumbers([renamed, b, c])]).toEqual([['b', 8], ['c', 2]]);
    const metadata = buildSessionMetadata(a, { customMetadata: { workspaceSessionNumber: 2 } } as SessionMetadata);
    const restored = { ...a, ...deriveSessionTitleStateFromMetadata(metadata) };
    expect(restored.workspaceSessionNumber).toBe(2);
    expect(sessionTitleNumbers([restored, b]).get('a')).toBe(2);
  });

  it('does not count generated, manually named, or child sessions as duplicate defaults', () => {
    const a = session('a', '/a');
    const manual = session('manual', '/a', 2, freezeSessionTitleState('New Session'));
    const child = session('child', '/a', 3, { sessionKind: 'review', parentSessionId: 'a' });
    const archived = session('archived', '/a', 4, { persistedStatus: 'archived' });
    expect(sessionTitleNumbers([a, manual, child, archived]).size).toBe(0);
  });

  it('uses the owning project for worktrees and normalizes local paths', () => {
    const a = session('a', 'D:/Project');
    const worktree = session('worktree', 'D:/Worktrees/task', 2, { projectWorkspacePath: 'd:/project/' });
    expect(sessionTitleNumbers([a, worktree]).size).toBe(2);
  });

  it('groups by workspace ID before paths and never joins different IDs on a shared path', () => {
    const a = session('a', '/same', 1, { workspaceId: 'ws-a' });
    const b = session('b', '/same', 2, { workspaceId: 'ws-b' });
    expect(sessionTitleNumbers([a, b]).size).toBe(0);
    const worktree = session('worktree', '/worktrees/task', 2, {
      workspaceId: 'ws-worktree', projectWorkspaceId: 'ws-a', projectWorkspacePath: '/elsewhere',
    });
    expect([...sessionTitleNumbers([a, worktree])]).toEqual([['a', 1], ['worktree', 2]]);
  });

  it('isolates SSH hosts and case-sensitive remote roots', () => {
    const a = session('a', '/repo', 1, { remoteSshHost: 'host-a', remoteConnectionId: 'ssh-user@host-a' });
    const b = session('b', '/repo', 1, { remoteSshHost: 'host-b', remoteConnectionId: 'ssh-user@host-b' });
    const c = session('c', '/Repo', 2, { remoteSshHost: 'host-a', remoteConnectionId: 'ssh-user@host-a' });
    expect(sessionTitleNumbers([a, b, c]).size).toBe(0);
    const d = session('d', '/repo/', 3, { remoteConnectionId: 'ssh-user@host-a:22' });
    expect([...sessionTitleNumbers([a, b, c, d])]).toEqual([['a', 1], ['d', 3]]);
  });

  it('reads old indexed titles as ordinary text without renaming or numbering', () => {
    for (const key of ['flow-chat:session.newCodeWithIndex', 'flow-chat:session.newCoworkWithIndex', 'flow-chat:session.newClawWithIndex', 'flow-chat:session.newWithIndex']) {
      const metadata = { sessionName: 'Old title 7', turnCount: 0, customMetadata: { titleSource: 'i18n', titleKey: key, titleParams: { count: 7 } } } as SessionMetadata;
      const titleState = deriveSessionTitleStateFromMetadata(metadata);
      expect(titleState).toMatchObject({ title: 'Old title 7', titleSource: 'text', workspaceSessionNumber: undefined });
      expect(resolvePersistedSessionTitle(metadata, translate)).toBe('Old title 7');
      expect(sessionTitleNumbers([session('old', '/a', 7, titleState), session('new', '/a')]).size).toBe(0);
    }
  });

  it('preserves generated text and rejects invalid numeric metadata', () => {
    const metadata = { sessionName: 'Fix login', turnCount: 1, customMetadata: { titleSource: 'i18n', titleKey: 'flow-chat:session.new', workspaceSessionNumber: 4 } } as SessionMetadata;
    expect(resolvePersistedSessionTitle(metadata, translate)).toBe('Fix login');
    for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2']) {
      expect(deriveSessionTitleStateFromMetadata({ ...metadata, customMetadata: { workspaceSessionNumber: number } } as SessionMetadata).workspaceSessionNumber).toBeUndefined();
    }
  });

  it('keeps a manually renamed empty session as text even when default metadata is stale', () => {
    const metadata = {
      sessionName: 'Fix login', turnCount: 0,
      customMetadata: {
        titleSource: 'i18n', titleKey: 'flow-chat:session.new',
        titleParams: { defaultTitleText: 'New Session' }, workspaceSessionNumber: 4,
      },
    } as SessionMetadata;
    expect(deriveSessionTitleStateFromMetadata(metadata)).toMatchObject({
      title: 'Fix login', titleSource: 'text', workspaceSessionNumber: 4,
    });
    expect(resolvePersistedSessionTitle(metadata, translate)).toBe('Fix login');
  });

  it('clears default title identity when the user names an empty session New Session', () => {
    const draft = session('a', '/a', 4);
    const metadata = buildSessionMetadata(draft, { customMetadata: { workspaceSessionNumber: 4 } } as SessionMetadata);
    const renamed = buildSessionMetadata({ ...draft, ...freezeSessionTitleState('New Session') }, metadata);
    expect(deriveSessionTitleStateFromMetadata(renamed)).toMatchObject({
      title: 'New Session', titleSource: 'text', workspaceSessionNumber: 4,
    });
  });
});
