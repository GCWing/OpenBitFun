import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Combobox, ConfirmDialog, Dialog, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogHeaderActions, DialogHeading, DialogTitle, FieldRow, Input } from '@openbitfun/ui';
import { ConfigPageRow, ConfigPageSection } from '../common';
import { mediaAPI, type ImageServiceTestOutcome } from '@/infrastructure/api/service-api/MediaApi';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { useSettingsDraft } from '../../settingsDraftRegistry';
import type { AuthConfig, ImageDialect, ImageServiceConfig } from '../../types';
import { findImageDialectPreset, IMAGE_DIALECT_PRESETS, withImageServiceAuth } from './imageDialects';
import { duplicateImageService } from './imageModels';

export interface ReusableImageCredential {
  id: string; label: string; apiKey: string; baseUrl: string; auth: AuthConfig;
  customHeaders?: Record<string, string>; customHeadersMode?: ImageServiceConfig['custom_headers_mode']; skipSslVerify?: boolean;
}

function createDraft(initial: ImageServiceConfig | null): ImageServiceConfig {
  if (initial) return withImageServiceAuth({ ...initial, params: { ...initial.params } }, initial.auth ?? { type: 'api_key' });
  const preset = IMAGE_DIALECT_PRESETS[0];
  return { id: crypto.randomUUID(), name: '', dialect: preset.id, base_url: preset.defaultBaseUrl,
    model_name: preset.defaultModel, api_key: '', auth: { type: 'api_key' }, enabled: true, params: { n: 1 } };
}
function isUrl(value: string): boolean {
  try { return ['http:', 'https:'].includes(new URL(value.trim()).protocol); } catch { return false; }
}

interface Props {
  open: boolean; initial: ImageServiceConfig | null; credentials: readonly ReusableImageCredential[]; services: readonly ImageServiceConfig[];
  onClose: () => void; onSubmit: (service: ImageServiceConfig) => Promise<boolean>;
}

export default function ImageGenerationEditor({ open, initial, credentials, services, onClose, onSubmit }: Props) {
  const { t, formatNumber } = useI18n('settings/media');
  const [draft, setDraft] = useState(() => createDraft(initial));
  const [source, setSource] = useState(initial ? 'saved' : 'manual');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testConfirmOpen, setTestConfirmOpen] = useState(false);
  const [outcome, setOutcome] = useState<ImageServiceTestOutcome>();
  const version = useRef(0);
  const original = useRef('');
  const checkPrompt = 'A cute minimalist mascot icon with a rounded-rectangle body, two small friendly oval eyes, and a short top antenna ending in a round joystick knob. Use a playful, harmonious color palette selected randomly for each generation, with no fixed colors. Centered composition, clean uncluttered background, polished product illustration.';

  useEffect(() => {
    version.current += 1; setOutcome(undefined); setTesting(false); setSaving(false); setTestConfirmOpen(false);
    if (open) {
      const value = createDraft(initial);
      setDraft(value); original.current = JSON.stringify(value); setSource(initial ? 'saved' : 'manual');
    }
  }, [open, initial]);

  const patch = useCallback((changes: Partial<ImageServiceConfig>) => {
    version.current += 1; setOutcome(undefined); setTesting(false); setTestConfirmOpen(false);
    setDraft(current => ({ ...current, ...changes }));
  }, []);
  const subscription = draft.auth?.type === 'subscription' || draft.auth?.type === 'subscription_pool';
  const preset = findImageDialectPreset(draft.dialect);
  const duplicate = duplicateImageService(services, draft);
  const validationError = draft.auth?.type === 'subscription_pool' ? t('wizard.validation.unsupportedAuth')
    : !subscription && !draft.api_key.trim() ? t('wizard.validation.apiKeyRequired')
    : !subscription && !isUrl(draft.request_url || draft.base_url) ? t('wizard.validation.baseUrlInvalid')
    : draft.dialect !== 'chatgpt_codex' && !draft.model_name.trim() ? t('wizard.validation.modelRequired')
    : duplicate ? t('wizard.validation.duplicate') : undefined;
  const sourceOptions = useMemo(() => [
    ...(initial ? [{ label: t('import.saved'), value: 'saved' }] : []),
    { label: t('import.manual'), value: 'manual' },
    ...credentials.map(credential => ({ label: credential.label, value: `configured:${credential.id}` })),
  ], [credentials, initial, t]);

  const chooseSource = (value: string) => {
    setSource(value);
    if (value === 'saved' && initial) { patch(createDraft(initial)); return; }
    if (value === 'manual') { patch(withImageServiceAuth(draft, { type: 'api_key' })); return; }
    const credential = credentials.find(item => `configured:${item.id}` === value);
    if (!credential) return;
    const next = withImageServiceAuth(draft, credential.auth);
    patch({ ...next, name: credential.label,
      api_key: credential.auth.type === 'subscription' ? '' : credential.apiKey,
      base_url: credential.auth.type === 'subscription' ? next.base_url : credential.baseUrl || next.base_url,
      request_url: undefined, custom_headers: credential.customHeaders ? { ...credential.customHeaders } : undefined,
      custom_headers_mode: credential.customHeadersMode, skip_ssl_verify: credential.skipSslVerify });
  };
  const chooseDialect = (dialect: ImageDialect) => {
    const next = findImageDialectPreset(dialect);
    patch({ dialect, request_url: undefined,
      base_url: draft.base_url === preset.defaultBaseUrl ? next.defaultBaseUrl : draft.base_url,
      model_name: draft.model_name === preset.defaultModel ? next.defaultModel : draft.model_name,
      params: { ...draft.params, size: undefined, n: 1 } });
  };
  const submit = async (): Promise<boolean> => {
    if (saving || validationError) return false;
    const scope = getActiveSurfaceScope();
    setSaving(true);
    try {
      return await onSubmit({ ...draft, name: draft.name.trim() || draft.model_name.trim() || t('dialect.chatgptCodex.name'),
        model_name: draft.model_name.trim(), base_url: draft.base_url.trim(), request_url: draft.request_url?.trim() || undefined,
        api_key: subscription ? '' : draft.api_key.trim() });
    } finally { if (scope.isCurrent()) setSaving(false); }
  };
  const dirty = open && JSON.stringify(draft) !== original.current;
  useSettingsDraft({ id: 'image-generation-editor', pageId: 'ai.models', label: t('title'), dirty, saving,
    save: submit, discard: onClose });

  const runTest = async () => {
    if (!open || saving || testing || validationError) return;
    const ticket = ++version.current;
    const scope = getActiveSurfaceScope();
    setTesting(true); setOutcome(undefined);
    try {
      const result = await mediaAPI.testImageGenerationService(draft, checkPrompt);
      if (scope.isCurrent() && ticket === version.current) setOutcome(result);
    } catch (cause) {
      if (scope.isCurrent() && ticket === version.current) {
        const candidate = cause as { code?: string; context?: { originalError?: { code?: string } } };
        setOutcome({ success: false, elapsed_ms: 0,
          error_kind: candidate.code === 'REQUEST_TIMEOUT' || candidate.context?.originalError?.code === 'REQUEST_TIMEOUT' ? 'timeout' : 'transport',
          message: cause instanceof Error ? cause.message : String(cause) });
      }
    } finally { if (scope.isCurrent() && ticket === version.current) setTesting(false); }
  };

  const hasTestImage = Boolean(outcome?.success && outcome.image_base64 && outcome.mime);
  const testResult = outcome && <div className="openbitfun-image-settings__test-result" role={hasTestImage ? 'status' : 'alert'} data-status={hasTestImage ? 'success' : 'failure'}>
    <p>{hasTestImage ? t('wizard.test.success', { time: formatNumber(outcome.elapsed_ms) })
      : t(`wizard.errors.${outcome.success ? 'empty_result' : outcome.error_kind || 'provider'}`)}</p>
    {outcome.message && <p className="openbitfun-image-settings__test-detail">{outcome.message}</p>}
    {hasTestImage && <img className="openbitfun-image-settings__test-image" src={`data:${outcome.mime};base64,${outcome.image_base64}`} alt={t('wizard.test.previewAlt')} />}
  </div>;

  return <><Dialog open={open} onOpenChange={next => { if (!next && !saving && !testing) onClose(); }} preset="panel" closeOnPointerOutside={false}>
    <DialogHeader><DialogHeading><DialogTitle>{t(initial ? 'wizard.titleEdit' : 'wizard.titleCreate')}</DialogTitle></DialogHeading>
      <DialogHeaderActions><DialogClose disabled={saving || testing} /></DialogHeaderActions></DialogHeader>
    <DialogBody>
      <div className="openbitfun-image-settings__editor" aria-busy={saving}>
        <ConfigPageSection title={t('wizard.steps.connection.label')} bodySurface fieldSurface="default"
          className="openbitfun-image-settings__editor-fields">
          <ConfigPageRow label={t('import.source')} description={t('import.hint')} align="center">
            <Combobox size="sm" options={sourceOptions} value={source} disabled={saving || testing} data-testid="image-service-source"
              onValueChange={value => chooseSource(String(Array.isArray(value) ? value[0] ?? '' : value))} />
          </ConfigPageRow>
          {subscription ? <FieldRow><p className="openbitfun-image-settings__hint" role="note">{t('import.subscriptionHint')}</p></FieldRow> : <>
            <ConfigPageRow label={t('wizard.steps.dialect.label')} align="center">
              <Combobox size="sm" value={draft.dialect} options={IMAGE_DIALECT_PRESETS.filter(item => item.id !== 'chatgpt_codex').map(item => ({ label: t(item.labelKey), value: item.id }))}
                disabled={saving || testing} onValueChange={value => chooseDialect(String(value) as ImageDialect)} />
            </ConfigPageRow>
            <ConfigPageRow label={t('wizard.fields.modelName.label')} required align="center">
              <Input size="sm" value={draft.model_name} disabled={saving || testing} onValueChange={value => patch({ model_name: value })} />
            </ConfigPageRow>
            <ConfigPageRow label={t('wizard.fields.baseUrl.label')} required align="center">
              <Input size="sm" value={draft.request_url ?? draft.base_url} disabled={saving || testing}
                onValueChange={value => patch(draft.request_url !== undefined ? { request_url: value } : { base_url: value })} />
            </ConfigPageRow>
            <ConfigPageRow label={t('wizard.fields.apiKey.label')} required align="center">
              <Input size="sm" type="password" autoComplete="off" value={draft.api_key} disabled={saving || testing} onValueChange={value => patch({ api_key: value })} />
            </ConfigPageRow>
          </>}
          {duplicate && <FieldRow><p className="openbitfun-image-settings__hint" role="alert">{t('wizard.validation.duplicate')}</p></FieldRow>}
        </ConfigPageSection>

        {hasTestImage ? <ConfigPageSection title={t('wizard.steps.test.label')} bodySurface fieldSurface="default">
          <FieldRow>{testResult}</FieldRow>
        </ConfigPageSection> : testResult}
      </div>
    </DialogBody>
    <DialogFooter appearance="floating">
      <Button size="sm" variant="outline" disabled={saving || testing || Boolean(validationError)} loading={testing} onClick={() => setTestConfirmOpen(true)}>{t('wizard.test.run')}</Button>
      <Button size="sm" variant="fill" onClick={onClose} disabled={saving || testing}>{t('actions.cancel')}</Button>
      <Button size="sm" variant="primary" onClick={() => void submit()} loading={saving} disabled={testing || Boolean(validationError)} title={validationError}>{t('actions.save')}</Button>
    </DialogFooter>
  </Dialog>
    <ConfirmDialog open={open && testConfirmOpen} onOpenChange={() => setTestConfirmOpen(false)}
      title={t('wizard.test.run')} message={t('wizard.test.billed')}
      confirmText={t('wizard.test.run')} cancelText={t('actions.cancel')}
      onConfirm={() => { setTestConfirmOpen(false); void runTest(); }} />
  </>;
}
