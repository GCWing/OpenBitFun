import { describe, expect, it } from 'vitest';
import { getTurnCompletionNotice } from './turnCompletionNotice';

describe('getTurnCompletionNotice', () => {
  it('returns null for normal completed turns', () => {
    expect(getTurnCompletionNotice({
      status: 'completed',
      finishReason: 'complete',
    } as any)).toBeNull();
  });

  it.each([true, false, undefined])('does not warn on user steering (final response: %s)', (hasFinalResponse) => {
    expect(getTurnCompletionNotice({
      status: 'completed', finishReason: 'user_steering', hasFinalResponse,
    })).toBeNull();
  });

  it('returns null for non-completed turns', () => {
    expect(getTurnCompletionNotice({
      status: 'processing',
      finishReason: 'max_rounds',
    } as any)).toBeNull();
  });

  it('shows a final-response body for max-round turns that produced a final reply', () => {
    expect(getTurnCompletionNotice({
      status: 'completed',
      finishReason: 'max_rounds',
      hasFinalResponse: true,
    } as any)).toMatchObject({
      reasonCode: 'max_rounds',
      tone: 'warning',
      titleKey: 'turnCompletionNotice.maxRounds.title',
      bodyKey: 'turnCompletionNotice.finalResponseProvided',
    });
  });

  it('omits the body when the turn ended without a final response', () => {
    expect(getTurnCompletionNotice({
      status: 'completed',
      finishReason: 'repeated_tool_failures',
      hasFinalResponse: false,
    } as any)).toMatchObject({
      reasonCode: 'repeated_tool_failures',
      titleKey: 'turnCompletionNotice.repeatedToolFailures.title',
    });
    expect(getTurnCompletionNotice({
      status: 'completed',
      finishReason: 'repeated_tool_failures',
      hasFinalResponse: false,
    } as any)?.bodyKey).toBeUndefined();
  });

  it('omits body text for terse reasons', () => {
    expect(getTurnCompletionNotice({
      status: 'completed',
      finishReason: 'interrupted',
    } as any)).toMatchObject({
      reasonCode: 'interrupted',
      titleKey: 'turnCompletionNotice.interrupted.title',
    });
    expect(getTurnCompletionNotice({
      status: 'completed',
      finishReason: 'interrupted',
    } as any)?.bodyKey).toBeUndefined();
  });

  it('falls back to a generic notice for unknown abnormal reasons', () => {
    expect(getTurnCompletionNotice({
      status: 'completed',
      finishReason: 'unexpected_reason',
    } as any)).toMatchObject({
      reasonCode: 'unexpected_reason',
      tone: 'warning',
      titleKey: 'turnCompletionNotice.generic.title',
    });
  });
  it('treats an admitted empty background ending as normal completion', () => {
    expect(getTurnCompletionNotice({ status: 'completed', finishReason: 'background_quiet', hasFinalResponse: false })).toBeNull();
  });

});
