import { describe, expect, it } from 'vitest';

import {
  FILE_TOOL_GUIDANCE_PREFIX,
  displayFileToolGuidanceMessage,
  isFileToolGuidanceMessage,
  isFileToolGuidanceResult,
} from './fileToolGuidance';

describe('fileToolGuidance', () => {
  it('detects guidance-prefixed messages', () => {
    const message = `${FILE_TOOL_GUIDANCE_PREFIX}Use Read first.`;
    expect(isFileToolGuidanceMessage(message)).toBe(true);
    expect(displayFileToolGuidanceMessage(message)).toBe('Use Read first.');
  });

  it('leaves non-guidance messages unchanged', () => {
    expect(isFileToolGuidanceMessage('Permission denied')).toBe(false);
    expect(displayFileToolGuidanceMessage('Permission denied')).toBe('Permission denied');
  });
});

describe('structured file guidance', () => {
  it.each(['edit_no_change', 'edit_target_not_found', 'edit_target_ambiguous'])('recognizes %s without matching wording', code => {
    expect(isFileToolGuidanceResult('Arbitrary diagnostic', { error_detail: { code, kind: 'guidance' } })).toBe(true);
  });
  it('preserves legacy results and does not hide unknown or ordinary failures', () => {
    expect(isFileToolGuidanceResult('[guidance] Read again', null)).toBe(true);
    expect(isFileToolGuidanceResult('Permission denied', null)).toBe(false);
    expect(isFileToolGuidanceResult('[guidance] text', { error_detail: { code: 'future', kind: 'future' } })).toBe(false);
  });
});
