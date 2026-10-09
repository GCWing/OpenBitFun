import '@/app/scenes/settings/pages/tools/WebSearchSettingsPage.scss';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import {
  ConfigActionBar, ConfigLoadingState, ConfigMessage, ConfigPageContent,
  ConfigPageHeader,
  ConfigPageLayout,
  ConfigPageRow,
  ConfigPageSection, ConfigRetryState
} from '@/infrastructure/config/components/common';
import { useSettingsDraft } from '@/infrastructure/config/settingsDraftRegistry';
import { useI18n } from '@/infrastructure/i18n';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { copyTextToClipboard } from '@/shared/utils/textSelection';
import { Button, Icon, IconButton, Input, Select, type SelectOption, Tooltip } from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const log = createLogger('WebSearchSettings');

type ProviderId = 'exa_mcp_free' | 'exa_search_api' | 'tavily' | 'openbitfun_search_http';
type HttpAuthMode = 'none' | 'bearer' | 'header';

interface CredentialProviderConfig extends Record<string, unknown> {
  credentialId: string;
}

interface OpenBitFunHttpAuthConfig extends Record<string, unknown> {
  mode: string;
  credentialId: string;
  headerName: string;
}

interface OpenBitFunHttpConfig extends Record<string, unknown> {
  endpoint: string;
  auth: OpenBitFunHttpAuthConfig;
}

interface WebSearchConfig extends Record<string, unknown> {
  provider: string;
  providers: {
    exa_search_api: CredentialProviderConfig;
    tavily: CredentialProviderConfig;
    openbitfun_search_http: OpenBitFunHttpConfig;
    [key: string]: unknown;
  };
}

const DEFAULT_CONFIG: WebSearchConfig = {
  provider: 'exa_mcp_free',
  providers: {
    exa_search_api: { credentialId: 'exa-search-api' },
    tavily: { credentialId: 'tavily-search-api' },
    openbitfun_search_http: {
      endpoint: '',
      auth: {
        mode: 'none',
        credentialId: 'openbitfun-search-http',
        headerName: '',
      },
    },
  },
};

const OPENBITFUN_PROTOCOL_REQUEST_EXAMPLE = `POST <configured endpoint>
Content-Type: application/json
Accept: application/vnd.openbitfun.web-search.v1+json

{
  "query": "Rust async runtime",
  "maxResults": 10
}`;

const OPENBITFUN_PROTOCOL_SUCCESS_EXAMPLE = `{
  "results": [
    {
      "title": "Rust Async Book",
      "url": "https://example.com/rust-async",
      "publishedAt": "2026-08-30T00:00:00Z",
      "author": "Example Author"
    }
  ]
}`;

const OPENBITFUN_PROTOCOL_ERROR_EXAMPLE = `{
  "error": {
    "code": "rate_limited",
    "message": "try again later",
    "retryAfterSeconds": 30
  }
}`;

const OPENBITFUN_PROTOCOL_ERROR_CODES = [
  'invalid_request',
  'authentication_failed',
  'permission_denied',
  'quota_exhausted',
  'rate_limited',
  'provider_unavailable',
  'invalid_response',
].join(', ');

function normalizeSelectValue(value: string | number | (string | number)[]): string {
  const selected = Array.isArray(value) ? value[0] : value;
  return selected == null ? '' : String(selected);
}

function normalizeConfig(value: unknown): WebSearchConfig {
  const raw = value && typeof value === 'object' ? value as Partial<WebSearchConfig> : {};
  const rawProviders: Partial<WebSearchConfig['providers']> & Record<string, unknown> =
    raw.providers && typeof raw.providers === 'object'
      ? raw.providers
      : {};
  const rawExa = rawProviders.exa_search_api && typeof rawProviders.exa_search_api === 'object'
    ? rawProviders.exa_search_api as Partial<CredentialProviderConfig>
    : {};
  const rawTavily = rawProviders.tavily && typeof rawProviders.tavily === 'object'
    ? rawProviders.tavily as Partial<CredentialProviderConfig>
    : {};
  const rawHttp = rawProviders.openbitfun_search_http && typeof rawProviders.openbitfun_search_http === 'object'
    ? rawProviders.openbitfun_search_http as Partial<OpenBitFunHttpConfig>
    : {};
  const rawAuth = rawHttp.auth && typeof rawHttp.auth === 'object'
    ? rawHttp.auth as Partial<OpenBitFunHttpAuthConfig>
    : {};
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    provider: typeof raw.provider === 'string' ? raw.provider : DEFAULT_CONFIG.provider,
    providers: {
      ...DEFAULT_CONFIG.providers,
      ...rawProviders,
      exa_search_api: {
        ...DEFAULT_CONFIG.providers.exa_search_api,
        ...rawExa,
      },
      tavily: {
        ...DEFAULT_CONFIG.providers.tavily,
        ...rawTavily,
      },
      openbitfun_search_http: {
        ...DEFAULT_CONFIG.providers.openbitfun_search_http,
        ...rawHttp,
        auth: {
          ...DEFAULT_CONFIG.providers.openbitfun_search_http.auth,
          ...rawAuth,
        },
      },
    },
  };
}

const WebSearchSettingsPage: React.FC = () => {
  const { t } = useI18n('settings/web-search');
  const { success: notifySuccess, error: notifyError } = useNotification();
  const protocolRef = useRef<HTMLDivElement>(null);
  const loadRequestIdRef = useRef(0);
  const credentialStatusRequestIdRef = useRef(0);
  const mutationBusyRef = useRef(false);
  const [config, setConfig] = useState<WebSearchConfig>(DEFAULT_CONFIG);
  const [savedConfig, setSavedConfig] = useState<WebSearchConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credential, setCredential] = useState('');
  const [credentialConfigured, setCredentialConfigured] = useState(false);
  const [draftMessage, setDraftMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [operationMessage, setOperationMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  const providerOptions = useMemo<(SelectOption & { description: string })[]>(() => [
    {
      value: 'exa_mcp_free',
      label: t('providers.exaMcpFree'),
      description: t('providerDescriptions.exaMcpFree'),
    },
    {
      value: 'exa_search_api',
      label: t('providers.exaSearchApi'),
      description: t('providerDescriptions.exaSearchApi'),
    },
    {
      value: 'tavily',
      label: t('providers.tavily'),
      description: t('providerDescriptions.tavily'),
    },
    {
      value: 'openbitfun_search_http',
      label: t('providers.openbitfunSearchHttp'),
      description: t('providerDescriptions.openbitfunSearchHttp'),
    },
  ], [t]);
  const authOptions = useMemo<SelectOption[]>(() => [
    { value: 'none', label: t('auth.none') },
    { value: 'bearer', label: t('auth.bearer') },
    { value: 'header', label: t('auth.header') },
  ], [t]);

  const selectedProvider = config.provider as ProviderId;
  const httpConfig = config.providers.openbitfun_search_http;
  const hasUnsavedChanges = useMemo(
    () => JSON.stringify(config) !== JSON.stringify(savedConfig),
    [config, savedConfig],
  );
  const credentialRequired = selectedProvider === 'exa_search_api'
    || selectedProvider === 'tavily'
    || (selectedProvider === 'openbitfun_search_http' && !['', 'none'].includes(httpConfig.auth.mode));

  const refreshCredentialStatus = useCallback(async (provider: string, required: boolean) => {
    const requestId = ++credentialStatusRequestIdRef.current;
    if (!required) {
      setCredentialConfigured(false);
      return;
    }
    try {
      const status = await configAPI.getWebSearchCredentialStatus(provider);
      if (requestId === credentialStatusRequestIdRef.current) {
        setCredentialConfigured(status.configured);
      }
    } catch (error) {
      log.error('Failed to load WebSearch credential status', { provider, error });
      if (requestId === credentialStatusRequestIdRef.current) {
        setCredentialConfigured(false);
      }
    }
  }, []);

  const loadConfiguration = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    setLoadFailed(false);
    try {
      const loaded = normalizeConfig(await configAPI.getConfig('ai.web_search'));
      if (requestId === loadRequestIdRef.current) {
        setConfig(loaded);
        setSavedConfig(loaded);
        setDraftMessage(null);
        setOperationMessage(null);
      }
    } catch (error) {
      log.error('Failed to load WebSearch settings', error);
      if (requestId === loadRequestIdRef.current) {
        setLoadFailed(true);
      }
    } finally {
      if (requestId === loadRequestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfiguration();
    return () => {
      loadRequestIdRef.current += 1;
      credentialStatusRequestIdRef.current += 1;
    };
  }, [loadConfiguration]);

  useEffect(() => {
    void refreshCredentialStatus(selectedProvider, credentialRequired);
    setCredential('');
    setDraftMessage(null);
  }, [credentialRequired, refreshCredentialStatus, selectedProvider]);

  const saveConfiguration = useCallback(async (showSuccess: boolean) => {
    await configAPI.setConfig('ai.web_search', config);
    setSavedConfig(config);
    if (showSuccess) {
      setDraftMessage(null);
      notifySuccess(t('messages.saved'));
    }
  }, [config, notifySuccess, t]);

  const handleSaveConfiguration = useCallback(async (): Promise<boolean> => {
    if (mutationBusyRef.current) return false;
    mutationBusyRef.current = true;
    setOperationMessage(null);
    setSaving(true);
    try {
      await saveConfiguration(true);
      await refreshCredentialStatus(selectedProvider, credentialRequired);
      return true;
    } catch (error) {
      log.error('Failed to save WebSearch settings', error);
      setDraftMessage({ type: 'error', text: t('messages.saveFailed') });
      return false;
    } finally {
      mutationBusyRef.current = false;
      setSaving(false);
    }
  }, [credentialRequired, refreshCredentialStatus, saveConfiguration, selectedProvider, t]);

  const handleSaveCredential = useCallback(async (): Promise<boolean> => {
    if (!credential.trim()) {
      setDraftMessage({ type: 'error', text: t('messages.credentialRequired') });
      return false;
    }
    if (mutationBusyRef.current) return false;
    mutationBusyRef.current = true;
    setOperationMessage(null);
    setCredentialBusy(true);
    let configurationSaved = false;
    try {
      if (hasUnsavedChanges) {
        await saveConfiguration(false);
        configurationSaved = true;
      }
      const status = await configAPI.saveWebSearchCredential(selectedProvider, credential);
      setCredential('');
      setCredentialConfigured(status.configured);
      setDraftMessage(null);
      notifySuccess(t('messages.credentialSaved'));
      return true;
    } catch (error) {
      log.error('Failed to save WebSearch credential', { provider: selectedProvider, error });
      setDraftMessage({
        type: 'error',
        text: t(configurationSaved
          ? 'messages.credentialSaveFailedAfterConfigSaved'
          : 'messages.credentialSaveFailed'),
      });
      return false;
    } finally {
      mutationBusyRef.current = false;
      setCredentialBusy(false);
    }
  }, [credential, hasUnsavedChanges, notifySuccess, saveConfiguration, selectedProvider, t]);

  const draftDirty = hasUnsavedChanges || credential.trim().length > 0;
  const mutationBusy = saving || credentialBusy;
  const discardDraft = useCallback(() => {
    setConfig(savedConfig);
    setCredential('');
    setDraftMessage(null);
    setOperationMessage(null);
  }, [savedConfig]);
  const saveDraft = useCallback(async (): Promise<boolean> => (
    credential.trim()
      ? handleSaveCredential()
      : handleSaveConfiguration()
  ), [credential, handleSaveConfiguration, handleSaveCredential]);

  useSettingsDraft({
    id: 'web-search-settings',
    pageId: 'tools.web-search',
    label: t('title'),
    dirty: draftDirty,
    saving: saving || credentialBusy,
    save: saveDraft,
    discard: discardDraft,
  });

  const handleClearCredential = useCallback(async () => {
    if (mutationBusyRef.current) return;
    mutationBusyRef.current = true;
    setOperationMessage(null);
    setCredentialBusy(true);
    try {
      const status = await configAPI.clearWebSearchCredential(selectedProvider);
      setCredentialConfigured(status.configured);
      setCredential('');
      setDraftMessage(null);
      notifySuccess(t('messages.credentialCleared'));
    } catch (error) {
      log.error('Failed to clear WebSearch credential', { provider: selectedProvider, error });
      setOperationMessage({ type: 'error', text: t('messages.credentialClearFailed') });
    } finally {
      mutationBusyRef.current = false;
      setCredentialBusy(false);
    }
  }, [notifySuccess, selectedProvider, t]);

  const handleCopyProtocol = useCallback(async () => {
    const protocolContent = protocolRef.current?.innerText.trim();
    if (!protocolContent) {
      notifyError(t('messages.protocolCopyFailed'));
      return;
    }
    const copied = await copyTextToClipboard([
      t('sections.protocol.title'),
      t('sections.protocol.description'),
      protocolContent,
    ].join('\n\n'));
    if (copied) {
      notifySuccess(t('messages.protocolCopied'));
    } else {
      notifyError(t('messages.protocolCopyFailed'));
    }
  }, [notifyError, notifySuccess, t]);

  if (loading) {
    return <ConfigLoadingState label={t('messages.loading')} />;
  }

  if (loadFailed) {
    return (
      <ConfigPageLayout data-openbitfun-component="config" data-openbitfun-part="root">
        <ConfigPageHeader title={t('title')} subtitle={t('subtitle')} />
        <ConfigPageContent>
          <ConfigRetryState
            message={t('messages.loadFailed')}
            retryLabel={t('actions.retry')}
            onRetry={() => void loadConfiguration()}
            loading={loading}
          />
        </ConfigPageContent>
      </ConfigPageLayout>
    );
  }

  return (
    <ConfigPageLayout data-openbitfun-component="config" data-openbitfun-part="root">
      <ConfigPageHeader
        title={t('title')}
        subtitle={t('subtitle')}
      />
      <ConfigPageContent>
        <ConfigMessage message={operationMessage} />
        <ConfigActionBar
          status={draftMessage?.type === 'error'
            ? 'error'
            : saving || credentialBusy
              ? 'saving'
              : draftDirty
                ? 'unsaved'
                : 'saved'}
          statusMessage={draftMessage?.text}
          saving={mutationBusy}
          saveDisabled={!draftDirty}
          discardDisabled={!draftDirty}
          saveLabel={credential.trim() ? t('actions.saveCredential') : t('actions.saveConfiguration')}
          onSave={() => void saveDraft()}
          onDiscard={discardDraft}
        />
        <ConfigPageSection
          title={t('sections.provider.title')}
          description={t('sections.provider.description')}
        >
          <ConfigPageRow
            label={t('fields.provider.label')}
            description={t('fields.provider.description')}
            align="center"
          >
            <Select
              value={config.provider}
              options={providerOptions}
              size="sm"
              aria-label={t('fields.provider.label')}
              aria-describedby="web-search-provider-help"
              placeholder={t('fields.provider.placeholder')}
              disabled={mutationBusy}
              onValueChange={(value) => setConfig(previous => ({
                ...previous,
                provider: normalizeSelectValue(value),
              }))}
            />
          </ConfigPageRow>
          <ConfigPageRow
            label={t('fields.providerHelp.label')}
            description={(
              <span id="web-search-provider-help">
                {providerOptions.find(option => option.value === selectedProvider)?.description
                  ?? t('fields.providerHelp.description')}
              </span>
            )}
          >
            {null}
          </ConfigPageRow>
        </ConfigPageSection>

        {selectedProvider === 'openbitfun_search_http' ? (
          <ConfigPageSection
            title={t('sections.http.title')}
            description={t('sections.http.description')}
          >
            <ConfigPageRow label={t('fields.endpoint.label')} description={t('fields.endpoint.description')}>
              <Input
                size="sm"
                value={httpConfig.endpoint}
                placeholder={t('fields.endpoint.placeholder')}
                disabled={mutationBusy}
                onChange={(event) => setConfig(previous => ({
                  ...previous,
                  providers: {
                    ...previous.providers,
                    openbitfun_search_http: {
                      ...previous.providers.openbitfun_search_http,
                      endpoint: event.target.value,
                    },
                  },
                }))}
              />
            </ConfigPageRow>
            <ConfigPageRow label={t('fields.authMode.label')} align="center">
              <Select
                value={httpConfig.auth.mode || 'none'}
                options={authOptions}
                size="sm"
                disabled={mutationBusy}
                onValueChange={(value) => setConfig(previous => ({
                  ...previous,
                  providers: {
                    ...previous.providers,
                    openbitfun_search_http: {
                      ...previous.providers.openbitfun_search_http,
                      auth: {
                        ...previous.providers.openbitfun_search_http.auth,
                        mode: normalizeSelectValue(value) as HttpAuthMode,
                      },
                    },
                  },
                }))}
              />
            </ConfigPageRow>
            {httpConfig.auth.mode === 'header' ? (
              <ConfigPageRow label={t('fields.headerName.label')} description={t('fields.headerName.description')}>
                <Input
                  size="sm"
                  value={httpConfig.auth.headerName}
                  placeholder={t('fields.headerName.placeholder')}
                  disabled={mutationBusy}
                  onChange={(event) => setConfig(previous => ({
                    ...previous,
                    providers: {
                      ...previous.providers,
                      openbitfun_search_http: {
                        ...previous.providers.openbitfun_search_http,
                        auth: {
                          ...previous.providers.openbitfun_search_http.auth,
                          headerName: event.target.value,
                        },
                      },
                    },
                  }))}
                />
              </ConfigPageRow>
            ) : null}
          </ConfigPageSection>
        ) : null}

        {credentialRequired ? (
          <ConfigPageSection title={t('sections.credential.title')} description={t('sections.credential.description')}>
            <ConfigPageRow label={t('fields.credentialStatus.label')} balanced>
              <div className="web-search-settings__credential-status">
                <span>{credentialConfigured ? t('status.configured') : t('status.missing')}</span>
                <Button size="sm" variant="outline" disabled={!credentialConfigured || mutationBusy} onClick={() => void handleClearCredential()}>
                  {t('actions.clearCredential')}
                </Button>
              </div>
            </ConfigPageRow>
            <ConfigPageRow label={t('fields.credential.label')} description={t('fields.credential.description')} balanced>
              <Input
                type="password"
                size="sm"
                autoComplete="off"
                value={credential}
                disabled={mutationBusy}
                placeholder={credentialConfigured
                  ? t('fields.credential.replacePlaceholder')
                  : t('fields.credential.placeholder')}
                onChange={(event) => setCredential(event.target.value)}
              />
            </ConfigPageRow>
          </ConfigPageSection>
        ) : null}

        {selectedProvider === 'openbitfun_search_http' ? (
          <ConfigPageSection
            title={t('sections.protocol.title')}
            description={t('sections.protocol.description')}
            extra={(
              <Tooltip content={t('actions.copyProtocol')} placement="bottom">
                <IconButton
                  type="button"
                  size="sm"
                  variant="quiet"
                  aria-label={t('actions.copyProtocol')}
                  icon={<Icon name="duplicate" size="sm" />}
                  onClick={() => void handleCopyProtocol()}
                />
              </Tooltip>
            )}
          >
            <div
              ref={protocolRef}
              id="web-search-openbitfun-protocol"
              data-openbitfun-component="config"
              data-openbitfun-part="collectionDetails"
            >
              <section>
                <h4>{t('protocol.request.title')}</h4>
                <p>{t('protocol.request.description')}</p>
                <pre><code>{OPENBITFUN_PROTOCOL_REQUEST_EXAMPLE}</code></pre>
              </section>
              <section>
                <h4>{t('protocol.success.title')}</h4>
                <p>{t('protocol.success.description')}</p>
                <pre><code>{OPENBITFUN_PROTOCOL_SUCCESS_EXAMPLE}</code></pre>
              </section>
              <section>
                <h4>{t('protocol.error.title')}</h4>
                <p>{t('protocol.error.description')}</p>
                <pre><code>{OPENBITFUN_PROTOCOL_ERROR_EXAMPLE}</code></pre>
                <p>
                  {t('protocol.error.codes')}{' '}
                  {OPENBITFUN_PROTOCOL_ERROR_CODES}
                </p>
              </section>
              <ul>
                <li>{t('protocol.notes.resultHandling')}</li>
                <li>{t('protocol.notes.transportLimits')}</li>
              </ul>
            </div>
          </ConfigPageSection>
        ) : null}

      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export default WebSearchSettingsPage;
