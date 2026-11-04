import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Select } from '@openbitfun/ui';
import { ConfigLoadingState, ConfigPageRow, ConfigPageSection, ConfigRetryState } from '@/infrastructure/config/components/common';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { useI18n } from '@/infrastructure/i18n';
import GenUIApplication from '@/tools/generative-ui/GenUIApplication';
import { genUICatalog } from '@/tools/generative-ui/genUIContract';
import { createGenUILibraryPreview, genUILibraryProfiles } from '@/tools/generative-ui/genUILibraryPreview';
import './GenUILibrarySection.scss';

const path = 'ai.generative_ui_library';
export default function GenUILibrarySection() {
  const { t } = useI18n('settings/runtime');
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const [loaded, setLoaded] = useState<{ epoch: number; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const request = useRef(0);
  const savingRef = useRef(false);
  const load = useCallback(async () => {
    const current = ++request.current;
    setError(null);
    try {
      const value = await configAPI.getConfig(path);
      if (!scope.isCurrent() || current !== request.current) return;
      if (typeof value !== 'string') throw new Error('GenUI library settings are unavailable on this host');
      setLoaded({ epoch: scope.epoch, value });
    } catch (failure) {
      if (scope.isCurrent() && current === request.current) setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [scope]);
  useEffect(() => {
    setLoaded(null); setSaving(false); savingRef.current = false;
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
  const options = Object.entries(genUILibraryProfiles).map(([value, profile]) => ({ value, label: profile.label }));
  const known = ready && Object.prototype.hasOwnProperty.call(genUILibraryProfiles, loaded.value);
  if (ready && !known) options.push({ value: loaded.value, label: loaded.value });
  const descriptions: Record<string, string> = { openui: t('genui.collections.openui'), openbitfun: t('genui.collections.openbitfun') };
  const preview = useMemo(() => ready && known ? createGenUILibraryPreview(loaded.value, t) : null, [ready, known, loaded?.value, t]);
  const designSpec = known ? genUICatalog.designSpecs?.[genUILibraryProfiles[loaded.value].designSpec] : undefined;
  const activeProfile = known ? genUILibraryProfiles[loaded.value] : undefined;
  return <ConfigPageSection id="generative-ui-library" className="gen-ui-library-section" title={t('genui.title')} description={t('genui.description')} bodySurface={false}>
    {!ready ? error
      ? <ConfigRetryState message={error} retryLabel={t('genui.retry')} onRetry={() => void load()} />
      : <ConfigLoadingState label={t('genui.loading')} />
      : <>
        <div className="gen-ui-library-settings-surface" data-openbitfun-component="gen-ui-library-settings" data-openbitfun-part="settings">
          <ConfigPageRow className="gen-ui-library-selector" label={t('genui.collection')} description={known ? undefined : t('genui.unknown')} align="center">
            <Select size="sm" aria-label={t('genui.collection')} options={options} value={loaded.value} disabled={saving} onValueChange={value => void save(String(value))} />
          </ConfigPageRow>
          {designSpec && activeProfile && <div className={`gen-ui-profile-card gen-ui-profile-card--${loaded.value}`} data-openbitfun-component="gen-ui-library-settings" data-openbitfun-part="profile">
            <div className="gen-ui-profile-card__accent" aria-hidden="true" />
            <div className="gen-ui-profile-card__content">
              <div className="gen-ui-profile-card__heading">
                <div className="gen-ui-profile-identity">
                  <span className="gen-ui-profile-mark" aria-hidden="true">{activeProfile.label.slice(0, 1)}</span>
                  <div>
                    <span className="gen-ui-profile-kicker">{t('genui.specification')}</span>
                    <h4>{activeProfile.label}</h4>
                  </div>
                </div>
                <span className="gen-ui-profile-revision">v{designSpec.revision}</span>
              </div>
              <p className="gen-ui-profile-description">{descriptions[loaded.value]}</p>
              <dl className="gen-ui-design-spec" data-openbitfun-component="gen-ui-library-settings" data-openbitfun-part="designSpec">
                <div><dt>{t('genui.viewport')}</dt><dd>{designSpec.viewport.mode === 'fixed' ? `${designSpec.viewport.width} x ${designSpec.viewport.height} ${designSpec.viewport.unit}` : t('genui.responsiveViewport')}</dd></div>
                <div><dt>{t('genui.componentLibraries')}</dt><dd>{designSpec.componentLibraries.join(', ')}</dd></div>
                <div><dt>{t('genui.styleResources')}</dt><dd>{designSpec.styleResources.join(', ')}</dd></div>
                <div><dt>{t('genui.hostShell')}</dt><dd>{designSpec.shell.hostOwnedParts.join(', ')}{designSpec.shell.statusBarHeight ? ` · ${designSpec.shell.statusBarHeight}px` : ''}</dd></div>
              </dl>
              <details className="gen-ui-spec-details">
                <summary>
                  <span>{t('genui.specification')}</span>
                  <span className="gen-ui-spec-details__summary-value">{designSpec.label} @ {designSpec.revision}</span>
                </summary>
                <dl className="gen-ui-spec-details__body">
                  <div><dt>{t('genui.designRules')}</dt><dd>{designSpec.rules.join(' ')}</dd></div>
                  <div><dt>{t('genui.acceptance')}</dt><dd>{designSpec.acceptance.checks.join(', ')}</dd></div>
                </dl>
              </details>
            </div>
          </div>}
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
