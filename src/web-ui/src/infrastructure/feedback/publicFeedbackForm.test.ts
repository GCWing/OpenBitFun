import { describe, expect, it } from 'vitest';
import { buildPublicFeedbackFormUrl, resolvePublicFeedbackFormUrl } from './publicFeedbackForm';

describe('public feedback form URL', () => {
  it('rejects missing, non-HTTPS, and malformed destinations', () => {
    expect(resolvePublicFeedbackFormUrl()).toBeNull();
    expect(resolvePublicFeedbackFormUrl('http://example.test/form')).toBeNull();
    expect(resolvePublicFeedbackFormUrl('not a URL')).toBeNull();
  });

  it('prefills supported context and hides the fields', () => {
    const result = buildPublicFeedbackFormUrl('https://example.feishu.cn/share/base/form/shrc-form', {
      uid: 'user&1', version: '1.2.3', source: 'openbitfun', deviceInfo: 'Windows Harness',
    });
    expect(result).toBeDefined();
    const url = new URL(result!);
    expect(url.searchParams.get('hide_uid')).toBe('1');
    expect(url.searchParams.get('prefill_uid')).toBe('user&1');
    expect(url.searchParams.get('prefill_harness_version')).toBe('1.2.3');
    expect(url.searchParams.get('prefill_device_info')).toBe('Windows Harness');
  });

  it('does not emit unavailable optional values', () => {
    const result = buildPublicFeedbackFormUrl('https://example.feishu.cn/share/base/form/shrc-form', {
      uid: null, version: null, deviceInfo: null,
    });
    const url = new URL(result!);
    expect(url.searchParams.has('prefill_uid')).toBe(false);
    expect(url.searchParams.has('prefill_harness_version')).toBe(false);
    expect(url.searchParams.has('prefill_device_info')).toBe(false);
    expect(url.searchParams.get('prefill_source')).toBe('openbitfun');
  });
});
