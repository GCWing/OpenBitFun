import { Button, IconButton } from '@openbitfun/ui';
import { Check, Image, Palette, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useVisualSkin, type VisualSkinCatalogEntry } from '@/infrastructure/visual-skin';
import { ConfigPageSection, formatStandaloneUiText } from './common';

function previewSource(entry: VisualSkinCatalogEntry): string | undefined {
  return typeof entry.previewAsset === 'string' && entry.previewAsset.trim()
    ? entry.previewAsset
    : undefined;
}

/**
 * Import and activate declarative visual skin packs generated from a reference
 * image. The runtime owns validation and persistence; this component only
 * exposes the safe, user-facing workflow.
 */
export function VisualSkinConfigSection() {
  const { t } = useTranslation('settings/appearance');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    skins,
    invalidRecords,
    activeSkinId,
    initialized,
    status,
    error: runtimeError,
    importPackage,
    activate,
    preview,
    cancelPreview,
    previewSkinId,
    remove,
  } = useVisualSkin();

  const disabled = !initialized || busy || status === 'applying';

  async function handleFile(file?: File) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await importPackage(await file.arrayBuffer());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleAction(action: () => Promise<unknown>) {
    if (disabled) return;
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return (
    <ConfigPageSection
      className="visual-skin-config"
      title={t('skin.title')}
      description={formatStandaloneUiText(t('skin.description'))}
      bodySurface={false}
      fieldSurface="ambient"
      data-openbitfun-product-component="visual-skin-settings"
      data-openbitfun-product-part="section"
      data-openbitfun-state={disabled ? 'disabled' : undefined}
      extra={(
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.zip,.openbitfun-skin,application/json,application/zip"
            hidden
            aria-label={t('skin.import')}
            data-testid="visual-skin-file-input"
            onChange={event => {
              void handleFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <Button
            variant="outline"
            size="sm"
            leadingIcon={<Upload size={14} aria-hidden="true" />}
            disabled={disabled}
            loading={busy}
            data-testid="visual-skin-import"
            onClick={() => fileInputRef.current?.click()}
          >
            {busy ? t('skin.importing') : t('skin.import')}
          </Button>
        </>
      )}
    >
      <div className="visual-skin-config__body">
        {invalidRecords.map((record, index) => (
          <article key={index} className="visual-skin-config__invalid" data-testid="visual-skin-invalid-record">
            <strong>{t('skin.invalidRecord', { key: String(record.key) })}</strong>
            <p role="status">{record.error}</p>
            <Button size="sm" variant="quiet" tone="danger" disabled={disabled}
              onClick={() => void handleAction(() => remove(record.key))}>
              {t('skin.remove')}
            </Button>
          </article>
        ))}
        {skins.length === 0 ? (
          <div className="visual-skin-config__empty" data-testid="visual-skin-empty">
            <Palette size={18} aria-hidden="true" />
            <span>{t('skin.empty')}</span>
          </div>
        ) : (
          <div className="visual-skin-config__grid" data-testid="visual-skin-gallery">
            {skins.map(entry => {
              const active = entry.id === activeSkinId;
              const previewing = previewSkinId === entry.id;
              const previewAsset = previewSource(entry);
              return (
                <article
                  key={entry.id}
                  className="visual-skin-config__card"
                  data-openbitfun-product-component="visual-skin-settings"
                  data-openbitfun-product-part="card"
                  data-openbitfun-state={active ? 'selected' : undefined}
                  data-testid={`visual-skin-card-${entry.id}`}
                  data-skin-id={entry.id}
                  data-active={active ? 'true' : 'false'}
                  data-previewing={previewing ? 'true' : 'false'}
                >
                  <div
                    className="visual-skin-config__preview"
                    style={previewAsset ? { backgroundImage: `url(${previewAsset})` } : undefined}
                    role={previewAsset ? 'img' : undefined}
                    aria-label={previewAsset ? t('skin.previewAlt', { name: entry.name }) : undefined}
                  >
                    {!previewAsset && <Image size={22} aria-hidden="true" />}
                  </div>
                  <div className="visual-skin-config__copy">
                    <div className="visual-skin-config__heading">
                      <strong>{entry.name}</strong>
                      {(active || previewing) && (
                        <span className="visual-skin-config__status" data-testid={`visual-skin-status-${entry.id}`}>
                          {active && !previewing && <Check size={12} aria-hidden="true" />}
                          {previewing ? t('skin.previewing') : t('skin.active')}
                        </span>
                      )}
                    </div>
                    <p>{entry.description || t('skin.generated')}</p>
                    <small>{entry.author || t('skin.generated')} · v{entry.version}</small>
                  </div>
                  <div className="visual-skin-config__actions">
                    <Button
                      size="sm"
                      variant="quiet"
                      disabled={disabled}
                      data-testid={`visual-skin-preview-${entry.id}`}
                      onClick={() => void handleAction(() => previewSkinId === entry.id ? cancelPreview() : preview(entry.id))}
                    >
                      {previewSkinId === entry.id ? t('skin.cancelPreview') : t('skin.preview')}
                    </Button>
                    <Button
                      size="sm"
                      variant={active ? 'secondary' : 'primary'}
                      disabled={disabled || active}
                      data-testid={`visual-skin-activate-${entry.id}`}
                      onClick={() => void handleAction(() => activate(entry.id))}
                    >
                      {t('skin.activate')}
                    </Button>
                    <IconButton
                      size="sm"
                      variant="quiet"
                      tone="danger"
                      aria-label={t('skin.remove')}
                      icon={<Trash2 size={15} aria-hidden="true" />}
                      disabled={disabled}
                      data-testid={`visual-skin-remove-${entry.id}`}
                      onClick={() => void handleAction(() => remove(entry.id))}
                    />
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {(error || runtimeError) && (
          <p className="visual-skin-config__error" role="alert" data-testid="visual-skin-error">
            {t('skin.error', { message: error || runtimeError })}
          </p>
        )}
      </div>
    </ConfigPageSection>
  );
}

export default VisualSkinConfigSection;
