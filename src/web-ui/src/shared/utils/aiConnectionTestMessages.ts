type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

export type ConnectionTestMessageCode =
  | 'tool_calls_not_detected'
  | 'image_input_check_failed'
  | 'tls_or_certificate_issue'
  | 'proxy_issue'
  | 'network_issue';

const MESSAGE_KEY_BY_CODE: Record<ConnectionTestMessageCode, string> = {
  tool_calls_not_detected: 'messages.connectionTestMessages.toolCallsNotDetected',
  image_input_check_failed: 'messages.connectionTestMessages.imageInputCheckFailed',
  tls_or_certificate_issue: 'messages.connectionTestMessages.tlsOrCertificateIssue',
  proxy_issue: 'messages.connectionTestMessages.proxyIssue',
  network_issue: 'messages.connectionTestMessages.networkIssue',
};

export function translateConnectionTestMessage(
  messageCode: ConnectionTestMessageCode | undefined,
  t: TranslateFn
): string | undefined {
  if (!messageCode) {
    return undefined;
  }

  const translationKey = MESSAGE_KEY_BY_CODE[messageCode];
  return translationKey ? t(translationKey) : undefined;
}

const SAFE_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function safeReasoningEffort(value: string | undefined): string | undefined {
  const normalized = /^["']?([a-z]+)["']?[.,;:]?$/i.exec(value ?? '')?.[1].toLowerCase();
  return normalized && SAFE_REASONING_EFFORTS.has(normalized) ? normalized : undefined;
}

function reportedReasoningEfforts(details: string): string | undefined {
  const reported = /\bSupported (?:types|values)(?:\s+are|\s*:)\s+([^\r\n]+?)(?:\.(?=\s|$|["}])|[\r\n]|$)/i.exec(details)?.[1];
  if (!reported) return undefined;
  const values = reported.trim().replace(/^\[|\]$/g, '').replace(/\s*\(default\)/gi, '')
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+/i).map(value => safeReasoningEffort(value.trim()));
  // Never turn a mixed or custom provider list into a misleading partial list.
  return values.length && values.every(value => value !== undefined)
    ? [...new Set(values)].join(', ') : undefined;
}

/** Derive display copy from provider errors without displaying or logging their contents. */
export function translateConnectionTestFailure(
  result: { message_code?: ConnectionTestMessageCode; error_details?: string },
  t: TranslateFn
): string | undefined {
  // Specific transport/capability diagnoses retain their existing translation.
  if (result.message_code && Object.prototype.hasOwnProperty.call(MESSAGE_KEY_BY_CODE, result.message_code)) {
    return translateConnectionTestMessage(result.message_code, t);
  }
  const details = result.error_details;
  if (typeof details !== 'string') return undefined;
  const rejection = /\b(?:unexpected|unsupported|invalid)\s+["']?reasoning(?:_|\s+)effort["']?(?=\s|[:=.,;]|$)/i.exec(details);
  const parameterRejection = rejection || /\breasoning(?:_|\s+)effort\b[^\r\n.]{0,100}\b(?:not supported|unsupported|invalid)\b/i.test(details);
  if (!parameterRejection) return undefined;

  const value = rejection
    ? safeReasoningEffort(details.slice(rejection.index + rejection[0].length).trimStart().replace(/^[:=]\s*/, '').split(/\s/, 1)[0])
    : undefined;
  if (!value) return t('messages.connectionTestMessages.reasoningEffortRejected');
  const supported = reportedReasoningEfforts(details);
  return supported
    ? t('messages.connectionTestMessages.reasoningEffortValueRejectedWithSupported', { value, supported })
    : t('messages.connectionTestMessages.reasoningEffortValueRejected', { value });
}
