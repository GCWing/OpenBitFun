import { describe, expect, it } from 'vitest';
import { SUBAGENT_AVATAR_IDS } from './catalog';
import {
  resolveSubagentAvatarId,
  resolveSubagentAvatarPresentation,
} from './avatarResolver';

describe('subagent avatar resolver', () => {
  it('maps a session ID to the same catalog avatar without stored state', () => {
    const first = resolveSubagentAvatarId('child-session');

    expect(resolveSubagentAvatarId('child-session')).toBe(first);
    expect(SUBAGENT_AVATAR_IDS).toContain(first);
  });

  it('uses the default avatar when the session ID is empty', () => {
    expect(resolveSubagentAvatarId('   ')).toBe(SUBAGENT_AVATAR_IDS[0]);
  });

  it('keeps the authored character together instead of assigning a separate color', () => {
    expect(resolveSubagentAvatarPresentation('child-session')).toEqual({
      avatarId: resolveSubagentAvatarId('child-session'),
    });
  });
});
