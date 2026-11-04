import { describe, expect, it } from 'vitest';
import { requestWorkspaceAction, takeWorkspaceAction } from './pendingWorkspaceAction';

describe('pendingWorkspaceAction', () => {
  it('runs once, on the row of the same device and workspace only', () => {
    requestWorkspaceAction({ surfaceId: 'peer', workspaceId: 'w', kind: 'menu' });
    expect(takeWorkspaceAction('local', 'w')).toBeNull();
    expect(takeWorkspaceAction('peer', 'other')).toBeNull();
    expect(takeWorkspaceAction('peer', 'w')).toBe('menu');
    expect(takeWorkspaceAction('peer', 'w')).toBeNull();
  });
});
