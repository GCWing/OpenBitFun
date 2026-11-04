import { describe, expect, it } from 'vitest';
import { catalogSessionStatus } from './catalogSessionStatus';

const summary = (extra: Record<string, unknown>) => ({
  sessionId: 's', execution: 'idle', pendingApprovals: 0, pendingQuestions: 0, ...extra,
});

describe('catalogSessionStatus', () => {
  it('prioritizes interactions that block the host', () => {
    expect(catalogSessionStatus(summary({ execution: 'running', pendingApprovals: 2 }))).toEqual({ kind: 'approval', pendingCount: 2 });
    expect(catalogSessionStatus(summary({ execution: 'running', pendingQuestions: 1 })).kind).toBe('input');
  });

  it('maps execution and unread results', () => {
    expect(catalogSessionStatus(summary({ execution: 'running' })).kind).toBe('running');
    expect(catalogSessionStatus(summary({ execution: 'queued' })).kind).toBe('queued');
    expect(catalogSessionStatus(summary({ unreadCompletion: 'completed' })).kind).toBe('unread');
    expect(catalogSessionStatus(summary({ unreadCompletion: 'interrupted' })).kind).toBe('stopped');
    expect(catalogSessionStatus(summary({ unreadCompletion: 'error' })).kind).toBe('error');
  });

  it('is idle without a summary', () => {
    expect(catalogSessionStatus(undefined).kind).toBe('idle');
    expect(catalogSessionStatus(summary({})).kind).toBe('idle');
  });
});
