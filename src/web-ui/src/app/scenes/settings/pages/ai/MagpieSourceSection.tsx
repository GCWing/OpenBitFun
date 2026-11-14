import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Checkbox, Icon, IconButton, Input, SearchField, StatusPill, Tooltip } from '@openbitfun/ui';
import { ConfigPageRow } from '@/infrastructure/config/components/common';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { useSettingsDraft } from '@/infrastructure/config/settingsDraftRegistry';
import type { AIModelConfig } from '@/infrastructure/config/types';
import { useI18n } from '@/infrastructure/i18n';
import { peerConnectionManager } from '@/infrastructure/peer-device/PeerConnectionManager';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { magpieAPI, supportsMagpieDiscovery, type MagpieProbeResult } from '@/infrastructure/api/service-api/MagpieAPI';
import { MAGPIE_APP_KEY, MAGPIE_DEFAULT_URL, magpieConnections, magpieGatewayUrl, magpieModelImportIssue, mergeMagpieModels, type MagpieConnection } from '@/infrastructure/config/services/magpieModels';
import './MagpieSourceSection.scss';

interface Props {
  models: AIModelConfig[];
  ready: boolean;
  onModelsChange: (models: AIModelConfig[]) => void;
  onManual: () => void;
  onRemoveModel: (model: AIModelConfig, trigger?: HTMLElement) => void;
}

export function MagpieSourceSection(props: Props) {
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  return <MagpieSourceEditor key={scope.epoch} {...props} />;
}

function MagpieSourceEditor({ models, ready, onModelsChange, onManual, onRemoveModel }: Props) {
  const { t, formatNumber } = useI18n('settings/models');
  const [scope] = useState(getActiveSurfaceScope);
  const panelId = useId();
  const connections = useMemo(() => magpieConnections(models), [models]);
  const [connectionId, setConnectionId] = useState<string>();
  const [connection, setConnection] = useState<MagpieConnection>();
  const [draftModels, setDraftModels] = useState(models);
  const [expanded, setExpanded] = useState(false);
  const [baseUrl, setBaseUrl] = useState(MAGPIE_DEFAULT_URL);
  const [apiKey, setApiKey] = useState(MAGPIE_APP_KEY);
  const [baseline, setBaseline] = useState({ baseUrl: MAGPIE_DEFAULT_URL, apiKey: MAGPIE_APP_KEY });
  const [result, setResult] = useState<MagpieProbeResult>();
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const sequence = useRef(0);
  const supported = useSyncExternalStore(
    listener => peerConnectionManager.subscribe(listener), supportsMagpieDiscovery, supportsMagpieDiscovery,
  );
  const activeConnection = connection ? connections.find(item => item.id === connection.id) : undefined;
  const importedModels = activeConnection?.models ?? (connection ? [] : models.filter(model =>
    magpieGatewayUrl(model.base_url) === magpieGatewayUrl(baseUrl)
    && (model.api_key?.trim() || MAGPIE_APP_KEY) === (apiKey.trim() || MAGPIE_APP_KEY)
    && (!model.auth || model.auth.type === 'api_key')));
  const imported = new Set(importedModels.map(model => model.model_name));
  const catalogReady = result?.status === 'ready' || result?.status === 'empty';
  const credentialsChanged = baseUrl !== baseline.baseUrl || apiKey !== baseline.apiKey;
  const dirty = selected.length > 0 || credentialsChanged;
  const canSave = supported && ready && catalogReady && !checking && !saving && !failed
    && (selected.length > 0 || (Boolean(connection) && credentialsChanged));
  useEffect(() => () => { sequence.current += 1; }, []);
  useEffect(() => {
    if (!supported) { sequence.current += 1; setChecking(false); setResult(undefined); setSelected([]); }
  }, [supported]);

  const invalidate = () => { sequence.current += 1; setResult(undefined); setChecking(false); setSelected([]); setSaved(false); setFailed(false); };
  const detect = async (address = baseUrl, key = apiKey) => {
    if (!supported || saving || !scope.isCurrent()) return;
    const request = ++sequence.current;
    // Keep the last catalog mounted while refreshing the same connection.
    // Address/key edits and connection switches clear it through invalidate().
    setChecking(true);
    try {
      const response = await magpieAPI.probe(address, key);
      if (!scope.isCurrent() || request !== sequence.current) return;
      setResult(response); setFailed(false); setSaved(false);
      setSelected(previous => previous.filter(id => response.models.some(model => model.id === id && !magpieModelImportIssue(model))));
    } catch {
      if (scope.isCurrent() && request === sequence.current) { setFailed(true); setSaved(false); }
    } finally {
      if (scope.isCurrent() && request === sequence.current) setChecking(false);
    }
  };
  const chooseConnection = (id?: string) => {
    invalidate();
    const next = connections.find(item => item.id === id);
    const values = { baseUrl: next?.baseUrl ?? MAGPIE_DEFAULT_URL, apiKey: next?.apiKey ?? MAGPIE_APP_KEY };
    setConnection(next); setDraftModels(models);
    setConnectionId(next?.id); setBaseUrl(values.baseUrl); setApiKey(values.apiKey); setBaseline(values); setQuery('');
    void detect(values.baseUrl, values.apiKey);
  };
  const save = async (): Promise<boolean> => {
    if (!canSave || !result || !scope.isCurrent()) return false;
    setSaving(true); setFailed(false);
    try {
      const next = await configManager.updateConfig<AIModelConfig[]>('ai.models', current => {
        scope.assertCurrent('import Magpie models');
        return mergeMagpieModels(current, result.models, selected, result.base_url, apiKey, connection);
      }, { expectedValue: draftModels });
      if (!scope.isCurrent()) return false;
      onModelsChange(next);
      const linked = magpieConnections(next).find(item => item.baseUrl === result.base_url && item.apiKey === (apiKey.trim() || MAGPIE_APP_KEY));
      setConnection(linked); setDraftModels(next);
      setConnectionId(linked?.id); setBaseUrl(result.base_url);
      setBaseline({ baseUrl: result.base_url, apiKey }); setSelected([]); setSaved(true);
      return true;
    } catch {
      if (scope.isCurrent()) setFailed(true);
      return false;
    } finally { if (scope.isCurrent()) setSaving(false); }
  };
  const discard = () => {
    if (saving) return;
    invalidate(); setBaseUrl(baseline.baseUrl); setApiKey(baseline.apiKey); setExpanded(false);
  };
  useSettingsDraft({ id: 'magpie-source', pageId: 'ai.models', label: t('providers.magpie.name'), dirty, saving, save, discard });

  const statusLabels = {
    ready: t('magpie.states.ready'), empty: t('magpie.states.empty'),
    unreachable: t('magpie.states.unreachable'), access_denied: t('magpie.states.accessDenied'),
    unrecognized: t('magpie.states.unrecognized'), catalog_error: t('magpie.states.catalogError'),
    invalid_address: t('magpie.states.invalidAddress'),
  };
  const importIssues = {
    contextTooSmall: t('magpie.contextTooSmall'), invalidLimits: t('magpie.invalidLimits'),
  };
  const status = !supported ? t('magpie.states.unsupported') : checking && !result && !failed ? t('magpie.states.checking')
    : failed ? t('magpie.states.failed') : saved ? t('magpie.states.saved')
      : result ? statusLabels[result.status] : t('magpie.states.idle');
  const visible = result?.models.filter(model => !query.trim()
    || (model.id + ' ' + (model.display_name ?? '')).toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  const missing = catalogReady ? [...imported].filter(id => !result.models.some(model => model.id === id)) : [];

  return <>
    <ConfigPageRow label={t('providers.magpie.name')}
      description={expanded ? undefined : result || checking || failed || saved ? status : t('magpie.description')} align="center">
      <Button size="sm" data-testid="settings-model-connect-magpie-btn" disabled={!ready || saving}
        aria-expanded={expanded} aria-controls={expanded ? panelId : undefined}
        onClick={() => { if (expanded) setExpanded(false); else { setExpanded(true); if (!dirty) chooseConnection(connections[0]?.id); } }}>
        {t(connections.length ? 'magpie.manage' : 'magpie.connect')}
      </Button>
    </ConfigPageRow>
    {expanded && <div id={panelId} className="openbitfun-magpie-source" data-testid="settings-magpie-panel"
      data-openbitfun-component="model-settings" data-openbitfun-part="magpieSource">
      {connections.length > 0 && <div className="openbitfun-magpie-source__actions" data-openbitfun-component="model-settings" data-openbitfun-part="magpieActions">
        {connections.map(item => <Button size="sm" key={item.id} disabled={saving || dirty}
          aria-pressed={item.id === connectionId} onClick={() => chooseConnection(item.id)}>{item.baseUrl}</Button>)}
        <Button size="sm" disabled={saving || dirty} onClick={() => chooseConnection()}>{t('magpie.addConnection')}</Button>
      </div>}
      <ConfigPageRow label={t('magpie.address')}
        description={scope.surfaceId !== 'local' ? t('magpie.hostHint') : undefined} align="center">
        <Input size="sm" value={baseUrl} disabled={saving} aria-label={t('magpie.address')} data-testid="settings-magpie-address"
          onChange={event => { invalidate(); setBaseUrl(event.target.value); }} />
      </ConfigPageRow>
      <ConfigPageRow label={t('magpie.key')} description={t('magpie.keyHint')} align="center">
        <Input size="sm" type="password" autoComplete="off" value={apiKey} disabled={saving} aria-label={t('magpie.key')}
          onChange={event => { invalidate(); setApiKey(event.target.value); }} />
      </ConfigPageRow>
      <div className="openbitfun-magpie-source__actions" data-openbitfun-component="model-settings" data-openbitfun-part="magpieActions">
        <Button size="sm" disabled={!supported || saving || checking} loading={checking} onClick={() => void detect()}
          data-testid="settings-magpie-detect">{t(result ? 'magpie.refresh' : 'magpie.detect')}</Button>
        <Button size="sm" disabled={saving || dirty} onClick={onManual}>{t('magpie.manual')}</Button>
      </div>
      <p role="status" aria-live="polite" aria-busy={checking}>{status}</p>
      {catalogReady && <>
        {result.models.length > 0 && <SearchField size="sm" value={query} onChange={event => setQuery(event.target.value)}
          aria-label={t('magpie.search')} placeholder={t('magpie.search')} />}
        <div className="openbitfun-magpie-source__catalog" aria-busy={checking}
          data-openbitfun-component="model-settings" data-openbitfun-part="magpieCatalog">
          {visible.map(model => {
            const issue = magpieModelImportIssue(model);
            return <div key={model.id} className="openbitfun-magpie-source__model"
              data-openbitfun-component="model-settings" data-openbitfun-part="magpieModel">
              <Checkbox checked={imported.has(model.id) || selected.includes(model.id)}
                disabled={saving || imported.has(model.id) || Boolean(issue)}
                label={model.display_name || model.id} description={model.id}
                onChange={event => setSelected(previous => event.target.checked
                  ? [...previous, model.id] : previous.filter(id => id !== model.id))} />
              {imported.has(model.id) && <>
                <StatusPill tone="neutral">{t('magpie.imported')}</StatusPill>
                <Tooltip content={t('providerSelection.removeModel')}>
                  <IconButton
                    size="xs"
                    shape="circle"
                    variant="quiet"
                    tone="danger"
                    aria-label={t('providerSelection.removeModelByName', { name: model.display_name || model.id })}
                    data-testid="settings-magpie-remove-model"
                    data-model-id={model.id}
                    disabled={saving}
                    icon={<Icon name="xmark" size="xs" />}
                    onClick={event => {
                      event.stopPropagation();
                      const config = importedModels.find(item => item.model_name === model.id);
                      if (config) onRemoveModel(config, event.currentTarget);
                    }}
                  />
                </Tooltip>
              </>}
              {model.id.startsWith('group/') && <StatusPill tone="info">{t('magpie.routingGroup')}</StatusPill>}
              {issue && <StatusPill tone="warning">{importIssues[issue]}</StatusPill>}
            </div>;
          })}
          {missing.map(id => <div key={id} className="openbitfun-magpie-source__model"
            data-openbitfun-component="model-settings" data-openbitfun-part="magpieModel">
            <span>{id}</span><StatusPill tone="warning">{t('magpie.missing')}</StatusPill>
          </div>)}
        </div>
        {missing.length > 0 && <p>{t('magpie.missingHint')}</p>}
        {selected.length > 0 && <p>{t('magpie.poolHint')}</p>}
      </>}
      <div className="openbitfun-magpie-source__actions" data-openbitfun-component="model-settings" data-openbitfun-part="magpieActions">
        <Button size="sm" variant="primary" disabled={!canSave} loading={saving} onClick={() => void save()}
          data-testid="settings-magpie-import">{selected.length ? t('magpie.importSelected', { count: formatNumber(selected.length) }) : t('magpie.saveConnection')}</Button>
        <Button size="sm" disabled={saving} onClick={discard}>{t(dirty ? 'magpie.discard' : 'magpie.close')}</Button>
      </div>
    </div>}
  </>;
}
