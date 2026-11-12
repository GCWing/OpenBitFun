import { Button, Disclosure, Field, Input, PageHeader, Select, type SelectOption } from '@openbitfun/ui';
import { ArrowRight } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createModelConfigFromTemplate,
  getOrderedProviders,
  PROVIDER_TEMPLATES,
  resolveProviderFormat,
  type ApiFormat,
  type ProviderTemplate,
} from '../data/modelProviders';
import type { RequestFormatValue } from '../data/modelRequestFormats';
import type { ConnectionTestResult, InstallOptions, ModelConfig, RemoteModelInfo } from '../types/installer';
import { previewRequestUrl, resolveRequestUrl } from '../utils/modelRequestUrl';

type TestStatus = 'idle' | 'testing' | 'success' | 'error';
const CUSTOM_MODEL_OPTION = '__custom_model__';

interface ModelSetupProps {
  previewOnly?: boolean;
  options: InstallOptions;
  setOptions: React.Dispatch<React.SetStateAction<InstallOptions>>;
  onSkip: () => void;
  onNext: () => Promise<void>;
  onTestConnection: (modelConfig: ModelConfig) => Promise<ConnectionTestResult>;
}

export function ModelSetup({ options, setOptions, onSkip, onNext, onTestConnection, previewOnly = false }: ModelSetupProps) {
  const { t } = useTranslation();
  const providers = useMemo(() => getOrderedProviders(), []);
  const current = options.modelConfig;

  const [selectedProviderId, setSelectedProviderId] = useState(current?.provider || '');
  const [apiKey, setApiKey] = useState(current?.apiKey || '');
  const [showApiKey, setShowApiKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl || '');
  const [modelName, setModelName] = useState(current?.modelName || '');
  const [apiFormat, setApiFormat] = useState<ApiFormat>((current?.format as ApiFormat) || 'openai');
  const [customFormat, setCustomFormat] = useState<ApiFormat>((current?.format as ApiFormat) || 'openai');
  const [forceCustomModelInput, setForceCustomModelInput] = useState(false);

  const [remoteModels, setRemoteModels] = useState<RemoteModelInfo[]>([]);
  const [isFetchingRemoteModels, setIsFetchingRemoteModels] = useState(false);
  const [remoteModelsError, setRemoteModelsError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isCustomProvider = selectedProviderId === 'custom';
  const template = useMemo<ProviderTemplate | null>(() => {
    if (!selectedProviderId || selectedProviderId === 'custom') return null;
    return PROVIDER_TEMPLATES[selectedProviderId] || null;
  }, [selectedProviderId]);

  const defaultProviderLabel = useMemo(() => {
    if (!template) return t('model.customProvider');
    return t(template.nameKey, { defaultValue: template.id });
  }, [template, t]);

  const effectiveBaseUrl = useMemo(() => {
    if (isCustomProvider) return baseUrl.trim();
    if (baseUrl.trim()) return baseUrl.trim();
    return template?.baseUrl || '';
  }, [isCustomProvider, baseUrl, template]);

  const effectiveModelName = useMemo(() => {
    if (modelName.trim()) return modelName.trim();
    return template?.models[0] || '';
  }, [modelName, template]);

  const resolvedApiFormat = useMemo<ApiFormat>(() => {
    if (isCustomProvider || !template) return customFormat;
    return apiFormat;
  }, [isCustomProvider, template, customFormat, apiFormat]);

  const previewResolvedUrl = useMemo(
    () => previewRequestUrl(effectiveBaseUrl, resolvedApiFormat),
    [effectiveBaseUrl, resolvedApiFormat],
  );

  const draftModelConfig = useMemo<ModelConfig | null>(() => {
    if (!selectedProviderId) return null;
    return {
      provider: selectedProviderId,
      apiKey,
      baseUrl: effectiveBaseUrl,
      modelName: effectiveModelName,
      format: resolvedApiFormat,
      configName: defaultProviderLabel,
    };
  }, [selectedProviderId, apiKey, effectiveBaseUrl, effectiveModelName, resolvedApiFormat, defaultProviderLabel]);

  const canContinue = Boolean(
    selectedProviderId && apiKey.trim() && effectiveBaseUrl && effectiveModelName && draftModelConfig,
  );

  const canTestConnection = canContinue && testStatus !== 'testing';

  useEffect(() => {
    setOptions((prev) => ({
      ...prev,
      modelConfig: draftModelConfig,
    }));
  }, [draftModelConfig, setOptions]);

  const resetTestState = useCallback(() => {
    setTestStatus('idle');
    setTestMessage('');
  }, []);

  const resetRemoteDiscovery = useCallback(() => {
    setRemoteModels([]);
    setRemoteModelsError(null);
  }, []);

  const fetchRemoteModels = useCallback(async () => {
    if (!draftModelConfig || !apiKey.trim()) {
      setRemoteModelsError(t('model.fillApiKeyBeforeFetch'));
      return;
    }
    setIsFetchingRemoteModels(true);
    setRemoteModelsError(null);
    try {
      const list = await invoke<RemoteModelInfo[]>('list_model_config_models', {
        modelConfig: draftModelConfig,
      });
      setRemoteModels(list);
      if (list.length === 0) {
        setRemoteModelsError(t('model.fetchEmptyFallback'));
      }
    } catch {
      setRemoteModels([]);
      setRemoteModelsError(t('model.fetchFailedFallback'));
    } finally {
      setIsFetchingRemoteModels(false);
    }
  }, [draftModelConfig, apiKey, t]);

  const handleProviderSelect = useCallback(
    (providerId: string) => {
      resetTestState();
      resetRemoteDiscovery();
      setSelectedProviderId(providerId);
      setForceCustomModelInput(false);
      if (providerId === 'custom') {
        setBaseUrl('');
        setModelName('');
        setCustomFormat('openai');
        setApiFormat('openai');
        return;
      }
      const nextTemplate = PROVIDER_TEMPLATES[providerId];
      if (!nextTemplate) return;
      const next = createModelConfigFromTemplate(nextTemplate, null);
      setBaseUrl(next.baseUrl);
      setModelName(next.modelName);
      setApiFormat(resolveProviderFormat(nextTemplate, next.baseUrl));
      setCustomFormat(next.format);
    },
    [resetTestState, resetRemoteDiscovery],
  );

  const handleBaseUrlOptionSelect = useCallback(
    (value: string) => {
      const opt = template?.baseUrlOptions?.find((option) => `${option.format}:${option.url}` === value);
      if (!opt) return;
      setBaseUrl(opt.url);
      setApiFormat(opt.format);
      resetTestState();
      resetRemoteDiscovery();
    },
    [template, resetTestState, resetRemoteDiscovery],
  );

  const handleTestConnection = useCallback(async () => {
    if (!draftModelConfig || !canTestConnection) return;
    setTestStatus('testing');
    setTestMessage(t('model.testing'));
    try {
      const result = await onTestConnection(draftModelConfig);
      if (result.success) {
        setTestStatus('success');
        setTestMessage(t('model.testSuccess'));
      } else {
        setTestStatus('error');
        setTestMessage(result.errorDetails || t('model.testFailed'));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTestStatus('error');
      setTestMessage(message || t('model.testFailed'));
    }
  }, [draftModelConfig, canTestConnection, onTestConnection, t]);

  const handleContinue = useCallback(async () => {
    if (!canContinue) return;
    setIsSubmitting(true);
    try {
      await onNext();
    } catch (error) {
      setTestStatus('error');
      setTestMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }, [canContinue, onNext]);

  const providerOptions = useMemo<SelectOption[]>(() => {
    return [
      { value: 'custom', label: t('model.customProvider') },
      ...providers.map((provider) => ({
        value: provider.id,
        label: t(provider.nameKey, { defaultValue: provider.id }),
      })),
    ];
  }, [providers, t]);

  const baseUrlOptions = useMemo<SelectOption[]>(() => {
    if (!template?.baseUrlOptions?.length) return [];
    return template.baseUrlOptions.map((opt) => ({
      value: `${opt.format}:${opt.url}`,
      label: opt.noteKey
        ? t(opt.noteKey, { defaultValue: opt.noteKey.split('.').pop() })
        : opt.format.toUpperCase(),
    }));
  }, [template, t]);

  const formatSelectOptions = useMemo<SelectOption[]>(
    () => [
      { value: 'openai', label: t('model.formats.openaiCompatible') },
      { value: 'responses', label: t('model.formats.responsesApi') },
      { value: 'anthropic', label: t('model.formats.claudeApi') },
      { value: 'gemini', label: t('model.formats.geminiApi') },
    ],
    [t],
  );

  const mergedModelIds = useMemo(() => {
    const preset = template?.models ?? [];
    const remoteIds = remoteModels.map((m) => m.id);
    return [...new Set([...preset, ...remoteIds])];
  }, [template, remoteModels]);

  const modelOptions = useMemo<SelectOption[]>(() => {
    if (!template && !isCustomProvider) return [];
    if (isCustomProvider) {
      return [];
    }
    return [
      ...mergedModelIds.map((id) => {
        const dn = remoteModels.find((m) => m.id === id)?.displayName;
        return {
          value: id,
          label: dn ? `${id} (${dn})` : id,
        };
      }),
      {
        value: CUSTOM_MODEL_OPTION,
        label: t('model.addCustomModel'),
      },
    ];
  }, [template, isCustomProvider, mergedModelIds, remoteModels, t]);

  const modelSelectionValue = useMemo(() => {
    if (!template) return '';
    if (forceCustomModelInput) return CUSTOM_MODEL_OPTION;
    const trimmed = modelName.trim();
    if (!trimmed) return mergedModelIds[0] || CUSTOM_MODEL_OPTION;
    if (mergedModelIds.includes(trimmed)) return trimmed;
    return CUSTOM_MODEL_OPTION;
  }, [template, modelName, forceCustomModelInput, mergedModelIds]);

  const modelFetchHint = useMemo(() => {
    if (isFetchingRemoteModels) return t('model.fetchingModels');
    if (remoteModelsError) return remoteModelsError;
    if (remoteModels.length > 0) return null;
    if (template?.models?.length) return t('model.usingPresetModels');
    return null;
  }, [isFetchingRemoteModels, remoteModelsError, remoteModels.length, template, t]);

  const storedRequestUrlReadonly = useMemo(
    () => resolveRequestUrl(effectiveBaseUrl, resolvedApiFormat, effectiveModelName),
    [effectiveBaseUrl, resolvedApiFormat, effectiveModelName],
  );

  return (
    <div className="page-shell">
      <div className="page-scroll">
        <div className="page-container">
          <PageHeader className="page-heading" title={t('model.title')} description={t('model.setupDescription')} />
          <div className="model-fields">
            <Field label={t('model.providerLabel')} orientation="horizontal" labelWidth="sm" controlWidth="fill">
              <Select
                value={selectedProviderId}
                options={providerOptions}
                placeholder={t('model.selectProvider')}
                aria-label={t('model.providerLabel')}
                onValueChange={(value) => handleProviderSelect(String(value))}
              />
            </Field>

            {!!selectedProviderId && (
              <>
                <Field
                  label={t('model.form.apiKey')}
                  orientation="horizontal"
                  labelWidth="sm"
                  controlWidth="fill"
                  controlTrailing={
                    <Button
                      size="sm"
                      variant="text"
                      aria-pressed={showApiKey}
                      onClick={() => setShowApiKey((shown) => !shown)}
                    >
                      {showApiKey ? t('model.hideSecret') : t('model.showSecret')}
                    </Button>
                  }
                >
                  <Input
                    size="md"
                    type={showApiKey ? 'text' : 'password'}
                    placeholder={t('model.form.apiKeyPlaceholder')}
                    value={apiKey}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      resetTestState();
                      resetRemoteDiscovery();
                    }}
                  />
                </Field>

                {baseUrlOptions.length > 0 && (
                  <Field label={t('model.endpointPreset')} orientation="horizontal" labelWidth="sm" controlWidth="fill">
                    <Select
                      value={template?.baseUrlOptions?.some((option) => option.url === effectiveBaseUrl && option.format === resolvedApiFormat) ? `${resolvedApiFormat}:${effectiveBaseUrl}` : ''}
                      options={baseUrlOptions}
                      placeholder={t('model.baseUrlPlaceholder')}
                      aria-label={t('model.endpointPreset')}
                      onValueChange={(value) => handleBaseUrlOptionSelect(String(value))}
                    />
                  </Field>
                )}

                {template && (
                  <Field label={t('model.form.modelSelection')} orientation="horizontal" labelWidth="sm" controlWidth="fill">
                    <Select
                      value={modelSelectionValue}
                      options={modelOptions}
                      placeholder={t('model.modelNameSelectPlaceholder')}
                      aria-label={t('model.form.modelSelection')}
                      aria-busy={isFetchingRemoteModels}
                      onOpenChange={(open) => { if (open && !previewOnly && !isFetchingRemoteModels) void fetchRemoteModels(); }}
                      onValueChange={(value) => {
                        const next = String(value);
                        if (next === CUSTOM_MODEL_OPTION) {
                          setForceCustomModelInput(true);
                          if (mergedModelIds.includes(modelName.trim())) setModelName('');
                          resetTestState();
                          return;
                        }
                        setForceCustomModelInput(false);
                        setModelName(next);
                        resetTestState();
                      }}
                    />
                  </Field>
                )}

                {(!template || forceCustomModelInput || (modelName.trim() && !mergedModelIds.includes(modelName.trim()))) && (
                  <Field label={t('model.form.modelName')} orientation="horizontal" labelWidth="sm" controlWidth="fill">
                    <Input
                      size="md"
                      placeholder={t('model.modelNamePlaceholder')}
                      value={modelName}
                      spellCheck={false}
                      onChange={(event) => {
                        setModelName(event.target.value);
                        resetTestState();
                      }}
                    />
                  </Field>
                )}
                {modelFetchHint && <p className="model-fetch-hint" role="status">{modelFetchHint}</p>}
                <Disclosure
                  key={selectedProviderId}
                  summary={t('model.advancedSettings')}
                  defaultOpen={isCustomProvider}
                >
                  <div className="model-fields">
                    <Field label={t('model.form.baseUrl')} orientation="horizontal" labelWidth="sm" controlWidth="fill">
                      <Input
                        size="md"
                        type="url"
                        placeholder={template?.baseUrl || t('model.baseUrlPlaceholder')}
                        value={baseUrl}
                        spellCheck={false}
                        onChange={(event) => {
                          setBaseUrl(event.target.value);
                          resetTestState();
                          resetRemoteDiscovery();
                          // Only preset URLs imply a format; custom proxy URLs keep the user's selection.
                          const preset = template?.baseUrlOptions?.find((option) => option.url === event.target.value.trim());
                          if (preset && !isCustomProvider) setApiFormat(preset.format);
                        }}
                      />
                    </Field>

                    <Field label={t('model.form.provider')} orientation="horizontal" labelWidth="sm" controlWidth="fill">
                      <Select
                        value={isCustomProvider ? customFormat : apiFormat}
                        options={formatSelectOptions}
                        placeholder={t('model.form.providerPlaceholder')}
                        aria-label={t('model.form.provider')}
                        onValueChange={(value) => {
                          const format = value as RequestFormatValue;
                          if (isCustomProvider) setCustomFormat(format);
                          else setApiFormat(format);
                          resetTestState();
                          resetRemoteDiscovery();
                        }}
                      />
                    </Field>

                    {!!effectiveBaseUrl && (
                      <details className="request-preview">
                        <summary>{t('model.form.resolvedUrlLabel').replace(/[:：]\s*$/, '').trim()}</summary>
                        <code title={storedRequestUrlReadonly}>{previewResolvedUrl}</code>
                      </details>
                    )}
                  </div>
                </Disclosure>
              </>
            )}
          </div>

          {!!selectedProviderId && (
            <div className="model-test-row">
              <Button variant="fill" size="sm" disabled={previewOnly || !canTestConnection} loading={testStatus === 'testing'} onClick={handleTestConnection}>
                {testStatus === 'testing' ? t('model.testing') : t('model.testConnection')}
              </Button>
              {testStatus === 'success' && <span className="status-success" role="status">{testMessage}</span>}
              {testStatus === 'error' && <span className="status-danger" role="alert">{testMessage}</span>}
            </div>
          )}
        </div>
      </div>

      <div className="page-footer page-footer--split">
        <Button variant="text" disabled={isSubmitting} onClick={onSkip}>{t('model.skip')}</Button>
        <Button variant="primary" trailingIcon={<ArrowRight />} onClick={handleContinue} disabled={!canContinue} loading={isSubmitting}>
          {t('model.nextTheme')}
        </Button>
      </div>
    </div>
  );
}
