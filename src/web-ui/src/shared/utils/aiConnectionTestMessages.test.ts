import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locales/en-US/settings/models.json';
import zhCN from '../../locales/zh-CN/settings/models.json';
import zhTW from '../../locales/zh-TW/settings/models.json';
import {
  type ConnectionTestMessageCode,
  translateConnectionTestFailure,
  translateConnectionTestMessage,
} from './aiConnectionTestMessages';

const messages = en.messages.connectionTestMessages;
function translate(key: string, options?: Record<string, unknown>): string {
  const template = messages[key.slice(key.lastIndexOf('.') + 1) as keyof typeof messages] ?? key;
  return template.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''));
}

afterEach(() => vi.restoreAllMocks());

describe('safe connection-test failure messages', () => {
  it('explains the reported reasoning rejection using only known enum values', () => {
    const t = vi.fn(translate);
    const detail = translateConnectionTestFailure({
      error_details: 'HTTP 400: Unexpected reasoning effort high. Supported types are xhigh(default), medium, and low.',
    }, t);

    expect(detail).toContain('reasoning_effort=high');
    expect(detail).toContain('reported supported values: xhigh, medium, low;');
    expect(detail).toContain('custom request body');
    expect(t).toHaveBeenCalledWith('messages.connectionTestMessages.reasoningEffortValueRejectedWithSupported', {
      value: 'high', supported: 'xhigh, medium, low',
    });
  });

  it('recognizes a reasoning rejection inside a generic provider failure code', () => {
    expect(translateConnectionTestFailure({
      message_code: 'OpenAIServiceError' as ConnectionTestMessageCode,
      error_details: 'Invalid reasoning_effort: "high". Supported values: ["low", "medium", "xhigh"].',
    }, translate)).toContain('reported supported values: low, medium, xhigh;');
  });

  it('retains specific structured diagnoses and ignores unrelated raw provider text', () => {
    const result = { message_code: 'network_issue' as const, error_details: 'Unexpected reasoning effort high. token=secret-value' };
    expect(translateConnectionTestFailure(result, translate)).toBe(translateConnectionTestMessage('network_issue', translate));
    expect(translateConnectionTestFailure({ error_details: 'HTTP 401 secret-api-key: provider response' }, translate)).toBeUndefined();
    expect(translateConnectionTestFailure({ error_details: 'Network timeout connecting to https://secret.example/?token=private' }, translate)).toBeUndefined();
    expect(translateConnectionTestFailure({}, translate)).toBeUndefined();
  });

  it.each(['custom-effort', 'high.private-value', 'high<script>', 'sk-private-key'])('uses only a generic parameter hint for unknown value %s', value => {
    expect(translateConnectionTestFailure({
      error_details: `Unexpected reasoning effort ${value}. Supported types are xhigh, medium, and low.`,
    }, translate)).toBe(messages.reasoningEffortRejected);
  });

  it.each(['xhigh, custom-private-value, low', 'xhigh, high.private-value, low', 'xhigh, , low', 'xhigh, medium, https://private.example'])('omits the entire unsupported or incomplete value list %s', supported => {
    const t = vi.fn(translate);
    expect(translateConnectionTestFailure({
      error_details: `Unexpected reasoning effort high. Supported types are ${supported}.`,
    }, t)).toBe(translate('messages.connectionTestMessages.reasoningEffortValueRejected', { value: 'high' }));
    expect(t).toHaveBeenCalledWith('messages.connectionTestMessages.reasoningEffortValueRejected', { value: 'high' });
  });

  it('does not forward provider secrets, URLs, request content or forged logs to display, translation or logs', () => {
    const logs = (['debug', 'info', 'log', 'warn', 'error'] as const)
      .map(method => vi.spyOn(console, method).mockImplementation(() => undefined));
    const t = vi.fn(translate);
    const detail = translateConnectionTestFailure({
      error_details: 'HTTP 400: Unexpected reasoning effort high. Supported types are xhigh(default), medium, and low.\n'
        + 'Authorization: Bearer sk-provider-secret\nhttps://private-api.example/?api_key=private-token\n'
        + 'Prompt: private-user-content\n[INFO] <script>private-script-content</script><img src=x onerror=private-handler>',
    }, t);

    const rendered = renderToStaticMarkup(createElement('span', null, detail));
    for (const secret of ['sk-provider-secret', 'private-api.example', 'private-token', 'private-user-content', 'private-script-content', 'private-handler', '<script', '<img', '[INFO]']) {
      expect(rendered).not.toContain(secret);
      expect(JSON.stringify(t.mock.calls)).not.toContain(secret);
    }
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(rendered).toContain('reasoning_effort=high');
  });

  it('provides all diagnostics in every supported locale with matching placeholders', () => {
    const keys = ['reasoningEffortRejected', 'reasoningEffortValueRejected', 'reasoningEffortValueRejectedWithSupported'] as const;
    for (const locale of [zhCN, zhTW]) {
      for (const key of keys) {
        const translated = locale.messages.connectionTestMessages[key];
        expect(translated.length).toBeGreaterThan(0);
        expect(translated.match(/{{\w+}}/g) ?? []).toEqual(messages[key].match(/{{\w+}}/g) ?? []);
      }
    }
  });
});
