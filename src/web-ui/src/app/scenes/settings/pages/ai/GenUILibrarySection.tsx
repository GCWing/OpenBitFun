import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Select, Switch } from '@openbitfun/ui';
import { ConfigLoadingState, ConfigPageRow, ConfigPageSection, ConfigRetryState } from '@/infrastructure/config/components/common';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { useI18n } from '@/infrastructure/i18n';
import GenUIApplication from '@/tools/generative-ui/GenUIApplication';
import { createGenUILibraryPreview, genUILibraryProfiles } from '@/tools/generative-ui/genUILibraryPreview';
import './GenUILibrarySection.scss';

const path = 'ai.generative_ui_library';
const enabledPath = 'ai.generative_ui_enabled';
export default function GenUILibrarySection() {
  const { t } = useI18n('settings/runtime');
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const [loaded, setLoaded] = useState<{ epoch: number; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [enabledReady, setEnabledReady] = useState(false);
  const [enabledSaving, setEnabledSaving] = useState(false);
  const request = useRef(0);
  const savingRef = useRef(false);
  const load = useCallback(async () => {
    const current = ++request.current;
    setError(null);
    try {
      const value = await configAPI.getConfig(path);
      const genuiEnabled = await configAPI.getConfig(enabledPath).catch(() => false);
      if (!scope.isCurrent() || current !== request.current) return;
      if (typeof value !== 'string') throw new Error('GenUI library settings are unavailable on this host');
      setLoaded({ epoch: scope.epoch, value });
      setEnabled(genuiEnabled === true);
      setEnabledReady(true);
    } catch (failure) {
      if (scope.isCurrent() && current === request.current) setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [scope]);
  useEffect(() => {
    setLoaded(null); setSaving(false); savingRef.current = false; setEnabledReady(false);
    void load();
    const stop = configManager.watch(path, () => { if (!savingRef.current) void load(); });
    return () => { stop(); };
  }, [load]);
  const save = async (value: string) => {
    if (savingRef.current || loaded?.epoch !== scope.epoch) return;
    request.current++;
    savingRef.current = true; setSaving(true); setError(null);
    try {
      await configManager.setConfig(path, value);
      if (scope.isCurrent()) setLoaded({ epoch: scope.epoch, value });
    } catch (failure) {
      if (scope.isCurrent()) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (scope.isCurrent()) { savingRef.current = false; setSaving(false); }
    }
  };
  const ready = loaded?.epoch === scope.epoch;
  const setGenUIEnabled = async (value: boolean) => {
    if (enabledSaving || !enabledReady) return;
    setEnabledSaving(true); setError(null);
    try { await configManager.setConfig(enabledPath, value); if (scope.isCurrent()) setEnabled(value); }
    catch (failure) { if (scope.isCurrent()) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (scope.isCurrent()) setEnabledSaving(false); }
  };
  const options = Object.entries(genUILibraryProfiles).map(([value, profile]) => ({ value, label: profile.label }));
  const known = ready && Object.prototype.hasOwnProperty.call(genUILibraryProfiles, loaded.value);
  if (ready && !known) options.push({ value: loaded.value, label: loaded.value });
  const preview = useMemo(() => ready && known ? createGenUILibraryPreview(loaded.value, t) : null, [ready, known, loaded?.value, t]);
  return <ConfigPageSection id="generative-ui-library" className="gen-ui-library-section" title={t('genui.title')} description={t('genui.description')} bodySurface={false}>
    {!ready ? error
      ? <ConfigRetryState message={error} retryLabel={t('genui.retry')} onRetry={() => void load()} />
      : <ConfigLoadingState label={t('genui.loading')} />
      : <>
        <ConfigPageRow label={t('genui.enable')} description={t('genui.enableDescription')} align="center">
          <Switch checked={enabled} disabled={!enabledReady || enabledSaving} onCheckedChange={value => void setGenUIEnabled(value)} />
        </ConfigPageRow>
        <div className="gen-ui-library-settings-surface" data-openbitfun-component="gen-ui-library-settings" data-openbitfun-part="settings">
          <ConfigPageRow className="gen-ui-library-selector" label={t('genui.collection')} description={known ? undefined : t('genui.unknown')} align="center">
            <Select size="sm" aria-label={t('genui.collection')} options={options} value={loaded.value} disabled={saving} onValueChange={value => void save(String(value))} />
          </ConfigPageRow>
        </div>
        {preview && <div data-openbitfun-component="gen-ui-library-settings" data-openbitfun-part="preview" className="gen-ui-library-preview" aria-label={t('genui.preview.title')}>
          <div className="gen-ui-library-preview__header">
            <div>
              <span className="gen-ui-preview-kicker">{t('genui.preview.live')}</span>
              <h4>{t('genui.preview.title')}</h4>
              <p data-openbitfun-component="gen-ui-library-settings" data-openbitfun-part="caption" className="gen-ui-library-preview__caption">{t('genui.preview.description')}</p>
            </div>
            <span className="gen-ui-preview-status"><span aria-hidden="true" />{t('genui.preview.live')}</span>
          </div>
          <div className="gen-ui-library-preview__canvas">
            <GenUIApplication key={scope.epoch + ':' + loaded.value} definition={preview} preview />
          </div>
        </div>}
        {error && <ConfigRetryState message={error} retryLabel={t('genui.retry')} onRetry={() => void load()} />}
      </>}
  </ConfigPageSection>;
}
