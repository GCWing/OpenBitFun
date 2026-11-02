import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { configManager } from '../../services/ConfigManager';
import { useConfigSeed } from '../../hooks/useConfigSeed';
import { getProviderDisplayName, getProviderInstanceId } from '../../services/modelConfigs';
import type { AIModelConfig, ImageServiceConfig, MediaConfig } from '../../types';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { confirmDialog } from '@/infrastructure/confirm-dialog';
import { useI18n } from '@/infrastructure/i18n';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { configuredSubscriptionImageModels, duplicateImageService, DuplicateImageServiceError, effectiveImageServiceId, imageServiceFromSubscriptionModel, normalizeMedia, sameImageService, withDefaultImageService } from './imageModels';
import type { ReusableImageCredential } from './ImageGenerationEditor';
import { mediaAPI } from '@/infrastructure/api/service-api/MediaApi';

const log = createLogger('ImageGenerationSettings');

export function useImageGenerationSettings() {
  const { t, formatNumber } = useI18n('settings/media');
  const { success, error } = useNotification();
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const seed = useConfigSeed(['media', 'ai.models']);
  const [models, setModels] = useState(() => seed.get<AIModelConfig[]>('ai.models', []));
  const [media, setMedia] = useState(() => normalizeMedia(seed.get<MediaConfig | null>('media', null)));
  const [loading, setLoading] = useState(!seed.loaded);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editor, setEditor] = useState<{ initial: ImageServiceConfig | null }>();
  const [testingId, setTestingId] = useState<string>();
  const testingRef = useRef(false);
  const savingRef = useRef(false);
  const request = useRef(0);
  const previousEpoch = useRef(scope.epoch);
  const loadedEpoch = useRef(seed.loaded ? scope.epoch : undefined);
  const defaultAttempt = useRef('');

  const load = useCallback(async () => {
    const ticket = ++request.current;
    try {
      const [value, configuredModels] = await Promise.all([
        configManager.getConfig<MediaConfig>('media'),
        configManager.getOptionalConfig<AIModelConfig[]>('ai.models'),
      ]);
      if (!scope.isCurrent() || ticket !== request.current) return;
      loadedEpoch.current = scope.epoch;
      setMedia(normalizeMedia(value)); setModels(configuredModels ?? []); setLoadError(false);
    } catch (cause) {
      if (scope.isCurrent() && ticket === request.current) {
        log.error('Failed to load image models', cause); setLoadError(true);
      }
    } finally {
      if (scope.isCurrent() && ticket === request.current) setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    const changed = previousEpoch.current !== scope.epoch;
    previousEpoch.current = scope.epoch;
    if (changed) { loadedEpoch.current = undefined; defaultAttempt.current = ''; setMedia(normalizeMedia(null)); setModels([]); setEditor(undefined); setSaving(false); savingRef.current = false; setLoading(true); setTestingId(undefined); testingRef.current = false; }
    if (changed || !seed.loaded) void load();
    const unwatchMedia = configManager.watch('media', () => { void load(); });
    const unwatchModels = configManager.watch('ai.models', () => { void load(); });
    return () => { unwatchMedia(); unwatchModels(); };
  }, [load, scope.epoch, seed.loaded]);

  const mutate = useCallback(async (update: (value: MediaConfig) => MediaConfig, notifySaved = true): Promise<boolean> => {
    if (savingRef.current || loading || loadError || !scope.isCurrent()) return false;
    savingRef.current = true; setSaving(true);
    // Invalidate reads begun before this mutation; watches reload the committed value.
    request.current += 1;
    try {
      const value = await configManager.updateConfig<MediaConfig>('media', current => {
        const normalized = normalizeMedia(current);
        return scope.isCurrent() ? withDefaultImageService(update(normalized)) : normalized;
      });
      if (!scope.isCurrent()) return false;
      setMedia(value); if (notifySaved) success(t('messages.saved')); return true;
    } catch (cause) {
      if (scope.isCurrent()) {
        if (cause instanceof DuplicateImageServiceError) error(t('wizard.validation.duplicate'));
        else { log.error('Failed to save image models', cause); error(t('messages.saveFailed')); }
      }
      return false;
    } finally {
      if (scope.isCurrent()) { savingRef.current = false; setSaving(false); }
    }
  }, [loading, loadError, scope, success, error, t]);

  useEffect(() => {
    if (loadedEpoch.current !== scope.epoch || loading || loadError || saving || !scope.isCurrent()) return;
    const id = effectiveImageServiceId(media);
    if (!id || id === media.default_image_service) return;
    const attempt = JSON.stringify([scope.epoch, media.default_image_service, media.image_services.filter(service => service.enabled).map(service => service.id)]);
    // A failed automatic save stays manually retryable without a render-driven retry loop.
    if (defaultAttempt.current === attempt) return;
    defaultAttempt.current = attempt;
    void mutate(value => value, false);
  }, [media, loading, loadError, saving, scope, mutate]);

  const saveService = async (service: ImageServiceConfig): Promise<boolean> => {
    const saved = await mutate(value => {
      if (duplicateImageService(value.image_services, service)) throw new DuplicateImageServiceError();
      const exists = value.image_services.some(item => item.id === service.id);
      const services = exists ? value.image_services.map(item => item.id === service.id ? service : item) : [...value.image_services, service];
      return { ...value, image_services: services };
    });
    if (saved) setEditor(undefined);
    return saved;
  };
  const selectDefault = async (id: string) => {
    const model = id.startsWith('configured:') ? models.find(item => item.id === id.slice('configured:'.length)) : undefined;
    if (id.startsWith('configured:') && (!model || !model.enabled)) return;
    await mutate(value => {
      if (!model) return { ...value, default_image_service: id || undefined };
      const serviceId = `configured-image:${model.id}`;
      const candidate = value.image_services.find(item => item.id === serviceId) ?? imageServiceFromSubscriptionModel(model);
      const service = { ...(value.image_services.find(item => sameImageService(item, candidate)) ?? candidate), enabled: true };
      return { ...value, image_services: [...value.image_services.filter(item => item.id !== service.id), service], default_image_service: service.id };
    });
  };
  const toggle = async (service: ImageServiceConfig, enabled: boolean) => {
    await mutate(value => ({ ...value, image_services: value.image_services.map(item => item.id === service.id ? { ...item, enabled } : item),
      default_image_service: !enabled && value.default_image_service === service.id ? undefined : value.default_image_service }));
  };
  const remove = async (service: ImageServiceConfig) => {
    const currentScope = scope;
    if (!await confirmDialog({ title: t('delete.title'), message: t('delete.message', { name: service.name || service.model_name }), confirmText: t('delete.confirm'), type: 'warning' }) || !currentScope.isCurrent()) return;
    await mutate(value => ({ ...value, image_services: value.image_services.filter(item => item.id !== service.id),
      default_image_service: value.default_image_service === service.id ? undefined : value.default_image_service }));
  };
  const test = async (service: ImageServiceConfig) => {
    if (testingRef.current || savingRef.current || !scope.isCurrent()) return;
    testingRef.current = true; setTestingId(service.id);
    try {
      const result = await mediaAPI.testImageGenerationService(service);
      if (!scope.isCurrent()) return;
      if (result.success) success(t('wizard.test.success', { time: formatNumber(result.elapsed_ms) }));
      else error(result.message || t('wizard.errors.provider'));
    } catch (cause) {
      if (scope.isCurrent()) error(cause instanceof Error ? cause.message : t('wizard.errors.transport'));
    } finally {
      if (scope.isCurrent()) { testingRef.current = false; setTestingId(undefined); }
    }
  };
  const credentials = useMemo<ReusableImageCredential[]>(() => {
    const providers = new Map<string, ReusableImageCredential>();
    for (const model of models) {
      if (!model.id?.trim() || !model.enabled || model.auth?.type === 'subscription_pool' || (model.auth?.type === 'subscription' && model.auth.provider !== 'codex')) continue;
      // Legacy models have no provider instance id: compare their connection facts,
      // while keeping credentials out of option values and the DOM.
      const key = getProviderInstanceId(model) ?? JSON.stringify([
        model.provider, model.base_url?.trim().replace(/\/+$/, ''), model.auth ?? { type: 'api_key' }, model.api_key ?? '',
        Object.entries(model.custom_headers ?? {}).sort(([left], [right]) => left.localeCompare(right)),
        model.custom_headers_mode, model.skip_ssl_verify,
      ]);
      if (!providers.has(key)) providers.set(key, {
        id: getProviderInstanceId(model) ?? model.id, label: getProviderDisplayName(model),
        apiKey: model.api_key ?? '', baseUrl: model.base_url ?? '', auth: model.auth ?? { type: 'api_key' },
        customHeaders: model.custom_headers, customHeadersMode: model.custom_headers_mode, skipSslVerify: model.skip_ssl_verify,
      });
    }
    return [...providers.values()];
  }, [models]);

  return { scopeEpoch: scope.epoch, media, loading, loadError, saving, load, editor, credentials, testingId, test,
    selectedId: effectiveImageServiceId(media),
    configuredModels: configuredSubscriptionImageModels(models).filter(model => !media.image_services.some(service =>
      service.auth?.type === 'subscription' && service.auth.provider === 'codex' && model.auth?.type === 'subscription'
      && service.auth.account_id === model.auth.account_id && service.enabled && service.model_name === model.model_name)),
    openCreate: () => setEditor({ initial: null }), openEdit: (initial: ImageServiceConfig) => setEditor({ initial }),
    closeEditor: () => { if (!savingRef.current) setEditor(undefined); }, saveService, selectDefault, toggle, remove };
}

export type ImageGenerationSettings = ReturnType<typeof useImageGenerationSettings>;
