import { describe, expect, it } from 'vitest';
import { deriveSessionConversationCapability as capability } from './conversationCapability';
import type { Session } from '../types/flow-chat';

const child = { sessionKind: 'subagent', continuationPolicy: 'reusable', config: {} } satisfies Partial<Session>;

describe('session conversation capability', () => {
  it('rejects fresh-only children without consulting turn completion', () => {
    expect(capability({ ...child, continuationPolicy: 'fresh_only' }, 'local'))
      .toEqual({ access: 'read-only', canSubmit: false, reason: 'fresh_only' });
  });
  it('keeps completed reusable children conversational', () => {
    const completed = { ...child, status: 'completed' } as const;
    expect(capability(completed, 'local')).toEqual({ access: 'available', canSubmit: true });
  });
  it('does not infer permission from a child placeholder or missing session', () => {
    expect(capability({ ...child, continuationPolicy: undefined }, 'local').access).toBe('unknown');
    expect(capability(undefined, 'local').access).toBe('unknown');
  });
  it('rejects archived sessions', () => {
    expect(capability({ ...child, persistedStatus: 'archived' }, 'local').reason).toBe('archived');
  });
  it('requires transient projections to have an actual runtime session', () => {
    expect(capability({ config: {}, isTransient: true }, 'local').reason).toBe('unsupported_route');
    expect(capability({ config: {}, isTransient: true, agentBackedTransient: true }, 'local').canSubmit).toBe(true);
  });
  it('separates history loading from conversation eligibility', () => {
    expect(capability({ ...child, historyState: 'hydrating' }, 'local'))
      .toEqual({ access: 'available', canSubmit: false, reason: 'history_loading' });
    expect(capability({ ...child, historyState: 'metadata-only' }, 'local').canSubmit).toBe(true);
  });
  it('requires a dispatch target to have its own route', () => {
    expect(capability(child, 'dispatch').reason).toBe('unsupported_route');
    expect(capability({ config: { dispatchJobId: 'job', dispatchTargetRequest: { kind: 'ssh', connectionId: 'host' }, dispatchApprovalPolicy: 'remote' } }, 'dispatch').canSubmit).toBe(true);
  });
});
