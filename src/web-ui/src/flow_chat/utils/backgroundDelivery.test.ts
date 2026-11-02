import { describe, expect, it } from 'vitest';
import { backgroundDeliveryFromMetadata, readBackgroundDelivery, shouldDeliverBackgroundCompletion, isSuppressedBackgroundTurn } from './backgroundDelivery';
import type { DialogTurn } from '../types/flow-chat';

const delivery = { schemaVersion: 1, source: 'scheduled_job', taskId: 'any-task', runId: 'run', policy: 'conditional', disposition: 'quiet', resolvedAtMs: 1, reason: 'No reportable change.' };

describe('background result delivery', () => {
  it('keeps legacy, mismatched and unknown-version results visible', () => {
    expect(shouldDeliverBackgroundCompletion({ turnId: 'run' })).toBe(true);
    for (const data of [{ ...delivery, runId: 'other' }, { ...delivery, schemaVersion: 2 }, { ...delivery, disposition: 'future' }, { ...delivery, policy: 'future' }, { ...delivery, resolvedAtMs: undefined }]) {
      expect(readBackgroundDelivery(data, 'run')).toBeUndefined();
      expect(shouldDeliverBackgroundCompletion({ turnId: 'run', backgroundDelivery: data })).toBe(true);
    }
    expect(backgroundDeliveryFromMetadata({ backgroundDelivery: delivery }, 'run')).toMatchObject(delivery);
  });

  it('suppresses a quiet completion while failures, partial recovery and always-report remain visible', () => {
    expect(shouldDeliverBackgroundCompletion({ turnId: 'run', backgroundDelivery: delivery })).toBe(false);
    expect(shouldDeliverBackgroundCompletion({ turn_id: 'run', background_delivery: delivery })).toBe(false);
    for (const flags of [{ success: false }, { finishReason: 'max_rounds' }, { partialRecoveryReason: 'stream interrupted' }, { backgroundDelivery: { ...delivery, policy: 'always' } }]) {
      expect(shouldDeliverBackgroundCompletion({ turnId: 'run', backgroundDelivery: delivery, ...flags })).toBe(true);
    }
  });

  it('collapses valid quiet text and empty quiet records without deleting them or hiding errors', () => {
    const turn: DialogTurn = {
      id: 'run', sessionId: 'session', status: 'completed', startTime: 1,
      userMessage: { id: 'user', content: 'Only report changes.', timestamp: 1, metadata: { backgroundDelivery: delivery } },
      modelRounds: [],
    };
    expect(isSuppressedBackgroundTurn(turn)).toBe(true);
    expect(isSuppressedBackgroundTurn({ ...turn, recoveryEpoch: 1 })).toBe(false);
    expect(turn.userMessage.content).toBe('Only report changes.');
    expect(isSuppressedBackgroundTurn({ ...turn, status: 'error' })).toBe(false);
    expect(isSuppressedBackgroundTurn({ ...turn, status: 'completed', userMessage: { ...turn.userMessage, metadata: { backgroundDelivery: { ...delivery, disposition: 'pending' } } } })).toBe(false);
  });
});
