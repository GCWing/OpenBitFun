import { ChevronDown as LucideChevronDown, Sparkles as LucideSparkles } from 'lucide-react';
import React, { useId, useMemo, useRef, useState } from 'react';
import { MobileButton, MobileCard, MobileTextField } from '@openbitfun/ui/mobile';
import { useI18n } from '../i18n';
import type { RemoteModelCatalog, RemoteModelConfig } from '../services/RemoteSessionManager';
import ComposerSelectionSurface from './ComposerSelectionSurface';

const SparklesIcon: React.FC<{ className?: string; size?: number }> = ({ className, size = 10 }) => (
  <LucideSparkles className={className} width={size} height={size} stroke="currentColor" aria-hidden="true" />
);

function formatProviderName(provider: string): string {
  const normalized = provider.trim();
  if (!normalized) return 'Unknown';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function getModelProviderLabel(model: RemoteModelConfig): string {
  const configuredName = model.name?.trim();
  if (configuredName) return configuredName;
  return formatProviderName(model.provider);
}

function formatContextWindow(contextWindow?: number): string | null {
  if (!contextWindow) return null;
  return `${Math.round(contextWindow / 1000)}k`;
}

function isChatCapableModel(model: RemoteModelConfig): boolean {
  return model.enabled && Array.isArray(model.capabilities) && model.capabilities.includes('text_chat');
}

export function normalizeSelectedModelId(selectedModelId: string | null | undefined): string {
  const value = selectedModelId?.trim();
  // Keep unavailable references intact; a display fallback must not become a write.
  return !value || value === 'auto' || value === 'default' ? 'auto' : value;
}

function resolveModelSelection(
  modelId: string,
  catalog: RemoteModelCatalog | null,
): RemoteModelConfig | null {
  if (!catalog) return null;
  return catalog.models.find(model => model.id === modelId && isChatCapableModel(model)) || null;
}

function resolveConcreteModelSelection(
  modelId: string,
  catalog: RemoteModelCatalog | null,
): RemoteModelConfig | null {
  const normalizedModelId = normalizeSelectedModelId(modelId);
  if (normalizedModelId === 'auto' || normalizedModelId === 'primary') {
    return resolveModelSelection(catalog?.default_models?.primary || '', catalog);
  }
  if (normalizedModelId === 'fast') {
    return resolveModelSelection(catalog?.default_models?.fast || '', catalog)
      || resolveModelSelection(catalog?.default_models?.primary || '', catalog);
  }
  return resolveModelSelection(normalizedModelId, catalog);
}

function buildModelProviderMeta(model: RemoteModelConfig | null): string | null {
  if (!model) return null;
  const parts = [getModelProviderLabel(model)];
  const context = formatContextWindow(model.context_window);
  if (context) parts.push(context);
  return parts.join(' · ');
}

function getModelDisplayName(model: RemoteModelConfig | null): string {
  if (!model) return '';
  return model.model_name || model.name || '';
}

function getSelectedModelInfo(
  selectedModelId: string,
  catalog: RemoteModelCatalog | null,
  t: (key: string, params?: Record<string, string | number>) => string,
): {
  label: string;
  meta: string | null;
  enableThinking: boolean;
} {
  if (selectedModelId === 'auto') {
    const resolved = resolveConcreteModelSelection(selectedModelId, catalog);
    return {
      label: t('chat.modelAuto'),
      meta: t('chat.modelAutoDesc'),
      enableThinking: resolved?.reasoning?.status === 'known',
    };
  }

  if (selectedModelId === 'primary' || selectedModelId === 'fast') {
    const resolved = resolveConcreteModelSelection(selectedModelId, catalog);
    return {
      label: resolved
        ? (selectedModelId === 'primary' ? t('chat.modelPrimary') : t('chat.modelFast'))
        : t('chat.modelUnavailable'),
      meta: buildModelProviderMeta(resolved) || selectedModelId,
      enableThinking: resolved?.reasoning?.status === 'known',
    };
  }

  const resolved = resolveModelSelection(selectedModelId, catalog);
  if (!resolved) {
    return {
      label: t('chat.modelUnavailable'),
      meta: selectedModelId,
      enableThinking: false,
    };
  }

  return {
    label: getModelDisplayName(resolved),
    meta: buildModelProviderMeta(resolved),
    enableThinking: resolved.reasoning?.status === 'known',
  };
}

export const ModelSelectorPill: React.FC<{
  catalog: RemoteModelCatalog | null;
  selectedModelId: string;
  disabled?: boolean;
  onSelect: (modelId: string) => void | Promise<void>;
  onSelectReasoning: (presetId: string | null) => void | Promise<void>;
}> = ({ catalog, selectedModelId, disabled, onSelect, onSelectReasoning }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const normalizedSelectedModelId = useMemo(
    () => normalizeSelectedModelId(selectedModelId),
    [selectedModelId],
  );

  const availableModels = useMemo(
    () => (catalog?.models || []).filter(isChatCapableModel),
    [catalog],
  );
  const resolvedPrimaryModel = useMemo(
    () => resolveModelSelection(catalog?.default_models?.primary || '', catalog),
    [catalog],
  );
  const resolvedFastModel = useMemo(
    () => resolveModelSelection(catalog?.default_models?.fast || '', catalog),
    [catalog],
  );
  const selectedInfo = useMemo(
    () => getSelectedModelInfo(normalizedSelectedModelId, catalog, t),
    [catalog, normalizedSelectedModelId, t],
  );

  const modelGroups = useMemo(() => {
    const groups = new Map<string, RemoteModelConfig[]>();
    const search = query.trim().toLocaleLowerCase();
    for (const model of availableModels) {
      if (search && !`${model.model_name} ${model.name} ${model.provider}`.toLocaleLowerCase().includes(search)) continue;
      const provider = formatProviderName(model.provider);
      groups.set(provider, [...(groups.get(provider) || []), model]);
    }
    return [...groups];
  }, [availableModels, query]);

  if (!catalog) return null;

  const handleSelect = (modelId: string) => {
    setOpen(false);
    void onSelect(modelId);
  };

  const handleSelectReasoning = (presetId: string | null) => {
    setOpen(false);
    void onSelectReasoning(presetId);
  };

  return (
    <div className="chat-model-selector" ref={rootRef}>
      <MobileButton
        appearance="secondary"
        className={`chat-model-selector__trigger${open ? ' chat-model-selector__trigger--open' : ''}`}
        type="button"
        onClick={() => { setQuery(''); setOpen(prev => !prev); }}
        disabled={disabled}
        aria-label={t('chat.modelSelection')}
        aria-expanded={open && !disabled}
        aria-haspopup="dialog"
        aria-controls={open && !disabled ? menuId : undefined}
      >
        <span className="chat-model-selector__name">
          <span className="chat-model-selector__name-text">{selectedInfo.label}</span>
          {selectedInfo.enableThinking && (
            <SparklesIcon className="chat-model-selector__thinking" size={9} />
          )}
        </span>
        <span className="chat-model-selector__chevron" aria-hidden="true">
          <LucideChevronDown width="10" height="10" aria-hidden="true" />
        </span>
      </MobileButton>

      {open && !disabled && (
        <ComposerSelectionSurface anchorRef={rootRef} id={menuId} label={t('chat.modelSelection')} width={330} onClose={() => setOpen(false)}>
        <MobileCard appearance="elevated" padding="none" className="chat-model-selector__dropdown">
          <div className="chat-model-selector__header">{t('chat.modelSelection')}</div>
          {availableModels.length > 6 && <MobileTextField type="search" className="chat-model-selector__search" aria-label={t('chat.searchModels')} placeholder={t('chat.searchModels')} value={query} onChange={event => setQuery(event.target.value)} />}
          {!query.trim() && <ReasoningPresetOptions catalog={catalog} selectedModelId={selectedModelId} disabled={disabled} onSelect={handleSelectReasoning} />}
          {!query.trim() && <section aria-label={t('chat.modelDefaults')}>
          <h3 className="chat-model-selector__group-title">{t('chat.modelDefaults')}</h3>
          <MobileButton
            appearance="plain"
            block
            className={`chat-model-selector__option${normalizedSelectedModelId === 'primary' ? ' is-selected' : ''}`}
            type="button"
            aria-pressed={normalizedSelectedModelId === 'primary'}
            onClick={() => void handleSelect('primary')}
          >
            <span className="chat-model-selector__option-main">
              <span className="chat-model-selector__option-name">{t('chat.modelPrimary')}</span>
              <span className="chat-model-selector__option-meta chat-model-selector__option-meta--stacked">
                <span className="chat-model-selector__option-meta-line">
                  {getModelDisplayName(resolvedPrimaryModel) || t('chat.modelAuto')}
                </span>
                <span className="chat-model-selector__option-meta-line">
                  {buildModelProviderMeta(resolvedPrimaryModel) || t('chat.modelAutoDesc')}
                </span>
              </span>
            </span>
          </MobileButton>
          <MobileButton
            appearance="plain"
            block
            className={`chat-model-selector__option${normalizedSelectedModelId === 'fast' ? ' is-selected' : ''}`}
            type="button"
            aria-pressed={normalizedSelectedModelId === 'fast'}
            onClick={() => void handleSelect('fast')}
          >
            <span className="chat-model-selector__option-main">
              <span className="chat-model-selector__option-name">{t('chat.modelFast')}</span>
              <span className="chat-model-selector__option-meta chat-model-selector__option-meta--stacked">
                <span className="chat-model-selector__option-meta-line">
                  {getModelDisplayName(resolvedFastModel) || t('chat.modelAuto')}
                </span>
                <span className="chat-model-selector__option-meta-line">
                  {buildModelProviderMeta(resolvedFastModel) || t('chat.modelAutoDesc')}
                </span>
              </span>
            </span>
          </MobileButton>
          </section>}
          <div className="chat-model-selector__divider" />
          <div className="chat-model-selector__list">
            {modelGroups.length === 0 && <p className="chat-model-selector__empty" role="status">{t('chat.noMatchingModels')}</p>}
            {modelGroups.map(([provider, models]) => <section key={provider} aria-label={provider}>
            <h3 className="chat-model-selector__group-title">{provider}</h3>
            {models.map(model => {
              const isSelected = normalizedSelectedModelId === model.id;
              return (
                <MobileButton
                  appearance="plain"
                  block
                  key={model.id}
                  className={`chat-model-selector__option${isSelected ? ' is-selected' : ''}`}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => void handleSelect(model.id)}
                >
                  <span className="chat-model-selector__option-main">
                    <span className="chat-model-selector__option-name">
                      <span className="chat-model-selector__option-name-text">
                        {getModelDisplayName(model)}
                      </span>
                      {model.reasoning?.status === 'known' && (
                        <SparklesIcon className="chat-model-selector__option-thinking" size={10} />
                      )}
                    </span>
                    <span className="chat-model-selector__option-meta">
                      {buildModelProviderMeta(model) || formatProviderName(model.provider)}
                    </span>
                  </span>
                </MobileButton>
              );
            })}
            </section>)}
          </div>
        </MobileCard>
        </ComposerSelectionSurface>
      )}
    </div>
  );
};
const ReasoningPresetOptions: React.FC<{
  catalog: RemoteModelCatalog | null;
  selectedModelId: string;
  disabled?: boolean;
  onSelect: (presetId: string | null) => void | Promise<void>;
}> = ({ catalog, selectedModelId, disabled, onSelect }) => {
  const { t } = useI18n();
  const model = useMemo(
    () => resolveConcreteModelSelection(selectedModelId, catalog),
    [catalog, selectedModelId],
  );
  const presets = useMemo(
    () => [...(model?.reasoning?.presets || [])].sort((a, b) => a.order - b.order),
    [model],
  );
  const selectedPresetId = catalog?.session_reasoning_preset?.trim() || null;
  const selectionSupported = catalog?.reasoning_preset_selection_supported === true;
  const isDisabled = disabled || !selectionSupported;

  if (model?.reasoning?.status !== 'known' || presets.length === 0) return null;

  return (
    <section className="chat-reasoning-options" aria-label={t('chat.reasoningSelection')}>
      <h3 className="chat-model-selector__group-title">{t('chat.reasoningSelection')}</h3>
      {!selectionSupported && <p>{t('chat.reasoningUnsupported')}</p>}
          <div className="chat-model-selector__list">
            <MobileButton
              appearance="plain"
              block
              className={`chat-model-selector__option${selectedPresetId === null ? ' is-selected' : ''}`}
              type="button"
              aria-pressed={selectedPresetId === null}
              disabled={isDisabled}
              onClick={() => void onSelect(null)}
            >
              <span className="chat-model-selector__option-name">{t('chat.reasoningAuto')}</span>
            </MobileButton>
            {presets.map(preset => (
              <MobileButton
                appearance="plain"
                block
                key={preset.id}
                className={`chat-model-selector__option${selectedPresetId === preset.id ? ' is-selected' : ''}`}
                type="button"
                aria-pressed={selectedPresetId === preset.id}
                disabled={isDisabled}
              onClick={() => void onSelect(preset.id)}
              >
                <span className="chat-model-selector__option-name">{preset.label}</span>
              </MobileButton>
            ))}
          </div>
    </section>
  );
};
