import { describe, expect, it } from 'vitest';
import {
  shouldRouteVoiceTaskToMiniApp,
  workspaceForSession,
  type VoiceMiniAppCallTarget,
} from './voiceClientContext';

const target: VoiceMiniAppCallTarget = {
  kind: 'miniapp',
  appId: 'builtin-ppt-live',
  appName: 'PPT Live',
  claimToken: 'builtin-ppt-live#1',
  sessionId: 'miniapp-session',
};

describe('realtime voice task routing', () => {
  it('keeps an unqualified task in the MiniApp conversation that launched voice', () => {
    expect(shouldRouteVoiceTaskToMiniApp(target)).toBe(true);
    expect(shouldRouteVoiceTaskToMiniApp(target, '   ')).toBe(true);
  });

  it('lets an explicit workspace override the captured MiniApp target', () => {
    expect(shouldRouteVoiceTaskToMiniApp(target, 'workspace-1')).toBe(false);
    expect(shouldRouteVoiceTaskToMiniApp(null)).toBe(false);
  });
});


describe('voice workspace identity', () => {
  it('uses the session ID binding when local and remote folders share a path', () => {
    const local = { id: 'local-1', rootPath: '/repo', workspaceKind: 'normal' };
    const remote = { id: 'remote-1', rootPath: '/repo', workspaceKind: 'remote', connectionId: 'ssh-1' };
    const session = { workspaceId: 'remote-1', config: { workspacePath: '/repo' } };
    expect(workspaceForSession(session as any, [local, remote] as any)).toBe(remote);
    expect(workspaceForSession({ ...session, workspaceId: 'missing' } as any, [local, remote] as any)).toBeUndefined();
    expect(workspaceForSession({ config: session.config } as any, [local, remote] as any)).toBeUndefined();
  });
});
