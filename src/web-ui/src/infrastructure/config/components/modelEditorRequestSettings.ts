import type { AIModelConfig } from '../types';

export type ModelEditorRequestSettings = Pick<AIModelConfig,
  | 'inline_think_in_text'
  | 'custom_headers'
  | 'custom_headers_mode'
  | 'skip_ssl_verify'
  | 'custom_request_body'
  | 'custom_request_body_mode'
>;

export function getModelEditorRequestSettings(config: Partial<AIModelConfig> = {}): ModelEditorRequestSettings {
  return {
    inline_think_in_text: config.inline_think_in_text ?? true,
    custom_headers: config.custom_headers ? { ...config.custom_headers } : undefined,
    custom_headers_mode: config.custom_headers_mode,
    skip_ssl_verify: config.skip_ssl_verify ?? false,
    custom_request_body: config.custom_request_body,
    custom_request_body_mode: config.custom_request_body_mode,
  };
}

export function updateModelEditorRequestSettings<T extends { key: string; requestSettings: ModelEditorRequestSettings }>(
  drafts: T[],
  updates: Partial<ModelEditorRequestSettings>,
  draftKey?: string,
): T[] {
  return drafts.map(draft => draftKey !== undefined && draft.key !== draftKey
    ? draft
    : { ...draft, requestSettings: { ...draft.requestSettings, ...updates } });
}
