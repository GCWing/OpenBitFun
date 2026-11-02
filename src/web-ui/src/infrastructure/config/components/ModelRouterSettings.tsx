import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Combobox, Dialog, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogHeading, DialogTitle, Field, Select } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { agentAPI, type ModelRoutingStatus } from '@/infrastructure/api/service-api/AgentAPI';
import { aiApi, type ConnectionTestResult } from '@/infrastructure/api/service-api/AIApi';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';
import { translateConnectionTestFailure, translateConnectionTestMessage } from '@/shared/utils/aiConnectionTestMessages';
import { configManager } from '../services/ConfigManager';
import type { AIModelConfig, DefaultModelsConfig, ModelRoutingConfig } from '../types';
import { filterSelectableTextChatModels } from '../services/modelCategory';
import { useModelSelectPresentation } from './ModelSelectPresentation';
import { affectsModelRoutingConnectionChecks, modelRoutingCheckIdentity, modelRoutingProbeSelectionChanged } from './modelRoutingCheckIdentity';
import { stableJson } from './modelConnectionTestPlan';
import './ModelRouterSettings.scss';

const DEFAULTS: ModelRoutingConfig = { default_mode: null, router_model_id: null, simple_threshold: 0.75, timeout_ms: 10000, summary_enabled: true };
const log = createLogger('ModelRouterSettings');
const CHECK_ROLES = ['primary', 'economy', 'router'] as const;
type CheckRole = typeof CHECK_ROLES[number];
type ConnectionCheck = {
  state: 'checking' | 'connected' | 'failed' | 'unconfigured';
  detail?: string;
};
type ConnectionChecks = Record<CheckRole, ConnectionCheck>;
type ConnectionCheckRun = {
  id: number;
  selectionIdentity: string;
  probe?: { roles: DefaultModelsConfig; routerModelId: string | null; identity: string };
};

/** Router configuration belongs to the selected execution host. */
export function ModelRouterSettings({ models, onClose, onSaved, onManageModels, initialStatus }: {
  models: AIModelConfig[]; onClose: () => void; onSaved: () => void; onManageModels?: () => void;
  initialStatus?: ModelRoutingStatus;
}) {
  const { t } = useI18n('settings/models');
  const { t: tModels } = useI18n('settings/default-model');
  const { buildModelOption } = useModelSelectPresentation();
  const [surface] = useState(getActiveSurfaceScope);
  const [available, setAvailable] = useState(initialStatus?.apiVersion === 1 && initialStatus.available === true);
  const [draft, setDraft] = useState<ModelRoutingConfig | null>(null);
  const [roleDraft, setRoleDraft] = useState<DefaultModelsConfig | null>(null);
  const [initialRoles, setInitialRoles] = useState<DefaultModelsConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [checks, setChecks] = useState<ConnectionChecks | null>(null);
  useEffect(() => {
    let active = true;
    if (initialStatus) {
      setAvailable(initialStatus.apiVersion === 1 && initialStatus.available === true);
    } else {
      void agentAPI.getModelRoutingStatus().then(status => {
        if (active && surface.isCurrent()) setAvailable(status.apiVersion === 1 && status.available === true);
      }).catch(() => { if (active && surface.isCurrent()) setAvailable(false); });
    }
    return () => { active = false; };
  }, [initialStatus, surface]);
  const checkRun = useRef(0);
  const activeCheckRun = useRef<ConnectionCheckRun | null>(null);
  const latestModels = useRef(models);
  latestModels.current = models;
  const selectionIdentity = modelRoutingCheckIdentity(models, roleDraft, draft?.router_model_id);
  const latestSelectionIdentity = useRef(selectionIdentity);
  latestSelectionIdentity.current = selectionIdentity;
  const clearChecks = useCallback(() => {
    checkRun.current += 1;
    activeCheckRun.current = null;
    setChecks(null); setMessage(''); setBusy(false);
  }, []);
  const isRunCurrent = (run: ConnectionCheckRun) => run.id === checkRun.current
    && activeCheckRun.current === run && surface.isCurrent()
    && run.selectionIdentity === latestSelectionIdentity.current
    && (!run.probe || run.probe.identity === modelRoutingCheckIdentity(latestModels.current, run.probe.roles, run.probe.routerModelId));
  const staleRun = activeCheckRun.current !== null && !isRunCurrent(activeCheckRun.current);
  // Hide old greens during the render that observes a changed configuration,
  // before the invalidation effect also releases the abandoned run's busy state.
  const currentChecks = staleRun || !surface.isCurrent() ? null : checks;
  useEffect(() => { if (staleRun) clearChecks(); }, [staleRun, clearChecks]);
  useEffect(() => {
    const unsubscribe = configManager.onConfigChange((path, oldValue, newValue) => {
      if (!surface.isCurrent()) return;
      const probe = activeCheckRun.current?.probe;
      const selectionChanged = probe && modelRoutingProbeSelectionChanged(path, newValue, probe.roles, probe.routerModelId);
      if (!affectsModelRoutingConnectionChecks(path) && !selectionChanged) return;
      if ((oldValue !== undefined || newValue !== undefined) && stableJson(oldValue) === stableJson(newValue)) return;
      clearChecks();
    });
    surface.signal.addEventListener('abort', clearChecks);
    if (!surface.isCurrent()) clearChecks();
    return () => {
      unsubscribe();
      surface.signal.removeEventListener('abort', clearChecks);
      checkRun.current += 1;
      activeCheckRun.current = null;
    };
  }, [surface, clearChecks]);
  useEffect(() => {
    if (!available) return;
    let active = true;
    void configManager.getConfigs(['ai.model_routing', 'ai.default_models']).then(values => {
      if (active && surface.isCurrent()) {
        if (!values['ai.model_routing'] || !values['ai.default_models']) throw new Error('Incomplete smart-mode configuration');
        setDraft({ ...DEFAULTS, ...values['ai.model_routing'] as ModelRoutingConfig });
        const roles = values['ai.default_models'] as DefaultModelsConfig;
        setRoleDraft({ ...roles }); setInitialRoles({ ...roles });
      }
    }).catch(error => {
      if (active && surface.isCurrent()) {
        log.warn('Failed to load smart-mode configuration', { error });
        setMessage(t('router.loadFailed'));
      }
    });
    return () => { active = false; };
  }, [available, surface, t]);
  const checkConnections = async (roles: DefaultModelsConfig, isCurrent: () => boolean) => {
    const update = (role: CheckRole, check: ConnectionCheck) => {
      if (isCurrent()) setChecks(current => isCurrent() && current ? { ...current, [role]: check } : current);
    };
    setChecks({ primary: { state: 'checking' }, economy: { state: 'checking' }, router: { state: 'checking' } });
    // The same concrete model may fill both roles; test it once on this host.
    const requests = new Map<string, Promise<ConnectionTestResult>>();
    const selectableModels = filterSelectableTextChatModels(latestModels.current);
    const modelChecks = (['primary', 'economy'] as const).map(async role => {
      const model = selectableModels.find(item => item.id === roles[role] && item.enabled);
      if (!model?.id) { update(role, { state: 'unconfigured' }); return; }
      try {
        let request = requests.get(model.id);
        if (!request) {
          // Retain the exact supplied draft for this request, including defaults
          // and credentials, even if a caller later mutates its catalog objects.
          const requestConfig = JSON.parse(JSON.stringify(model)) as AIModelConfig;
          request = aiApi.testAIConfigConnection(requestConfig); requests.set(model.id, request);
        }
        const result = await request;
        update(role, {
          state: result.success ? 'connected' : 'failed',
          detail: result.success ? translateConnectionTestMessage(result.message_code, t) : translateConnectionTestFailure(result, t),
        });
      } catch {
        // Provider responses and wrapped errors can contain credentials/configuration.
        update(role, { state: 'failed' });
        log.warn('Smart-mode model connection check failed', { role });
      }
    });
    const routerFailureDetail = (issue: unknown): string => {
      // Host/provider diagnostics may contain credentials or paths. Only select
      // fixed translated advice; never render any part of the diagnostic itself.
      const reason = typeof issue === 'string' ? issue : '';
      if (/Router requires OpenAI Chat Completions API format|Router protocol mismatch|Router response lacks classifier token logprobs|Failed to decode Router response|Router (?:output is invalid JSON|response did not contain)/i.test(reason)) {
        return t('router.connectionFailures.protocol');
      }
      const httpStatus = /\bRouter returned HTTP ([1-5]\d{2})\b/i.exec(reason)?.[1];
      if (httpStatus === '401' || httpStatus === '403') return t('router.connectionFailures.authentication');
      if (httpStatus === '404' || /Invalid Router URL|Router URL must use HTTP\(S\)/i.test(reason)) {
        return t('router.connectionFailures.addressOrModel');
      }
      if (httpStatus === '429') return t('router.connectionFailures.rateLimited');
      if (httpStatus?.startsWith('5')) return t('router.connectionFailures.serviceUnavailable');
      if (httpStatus) return t('router.connectionFailures.http');
      if (/Router (?:request failed|deadline expired)|\b(?:connection refused|connect error|dns error|timed out)\b/i.test(reason)) {
        return t('router.connectionFailures.network');
      }
      if (/Configure a Router service model|Configure an enabled (?:primary|economy) model/i.test(reason)) {
        return t('router.connectionChecks.unconfigured');
      }
      return t('router.checkFailed');
    };
    const routerCheck = async () => {
      try {
        const status = await agentAPI.getModelRoutingStatus({ probe: true });
        update('router', {
          state: status.connected ? 'connected' : 'failed',
          detail: status.connected ? undefined : routerFailureDetail(status.connectionIssue ?? status.issue),
        });
      } catch {
        update('router', { state: 'failed', detail: t('router.checkFailed') });
        log.warn('Smart-mode Router connection check failed');
      }
    };
    await Promise.allSettled([...modelChecks, routerCheck()]);
  };
  const save = async (probe: boolean) => {
    if (!available || !draft || !roleDraft || !initialRoles || busy || !surface.isCurrent()) return;
    const run: ConnectionCheckRun = { id: ++checkRun.current, selectionIdentity };
    activeCheckRun.current = run;
    const isCurrent = () => isRunCurrent(run);
    setBusy(true); setMessage(''); setChecks(null);
    let failureMessage = t('router.loadFailed');
    try {
      // Feature negotiation precedes any write, including on older peer hosts.
      const support = await agentAPI.getModelRoutingStatus();
      if (!isCurrent()) return;
      if (support.apiVersion !== 1) { setMessage(t('router.unsupported')); return; }
      if (support.available !== true) { setAvailable(false); setMessage(t('router.notOpen')); return; }
      const requireTokenBudgetSupport = (current: ModelRoutingConfig) => {
        if (support.estimatedTokenBudgetSupported !== true
          && (typeof current.tokenizer_path !== 'string' || !current.tokenizer_path.trim())) {
          failureMessage = t('router.tokenBudgetUnsupported');
          throw new Error('Execution host requires a Router tokenizer file');
        }
      };
      if (support.estimatedTokenBudgetSupported !== true) {
        // Bypass the editor/cache snapshot before writing either model roles or routing.
        const current: unknown = await configAPI.getConfig('ai.model_routing');
        if (!isCurrent()) return;
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
          throw new Error('Router configuration is unavailable on the execution host');
        }
        requireTokenBudgetSupport(current as ModelRoutingConfig);
      }
      // A catalog refresh does not hydrate this editor's role draft. Read the
      // authoritative roles once before any write, so an old dialog cannot
      // certify different host selections or silently replace a concurrent edit.
      const currentRoles: unknown = await configAPI.getConfig('ai.default_models');
      if (!isCurrent()) return;
      if (!currentRoles || typeof currentRoles !== 'object' || Array.isArray(currentRoles)) {
        throw new Error('Default model configuration is unavailable on the execution host');
      }
      const authoritativeRoles = currentRoles as DefaultModelsConfig;
      if ((['primary', 'economy'] as const).some(role => authoritativeRoles[role] != null && typeof authoritativeRoles[role] !== 'string')) {
        throw new Error('Default model selection has an invalid shape');
      }
      if ((['primary', 'economy'] as const).some(role => (authoritativeRoles[role] || null) !== (initialRoles[role] || null))) {
        setMessage(t('router.configurationChanged'));
        return;
      }
      failureMessage = t('router.saveFailed');
      const changedRoles = Object.fromEntries((['primary', 'economy'] as const)
        .filter(role => (roleDraft[role] || null) !== (initialRoles[role] || null))
        .map(role => [role, roleDraft[role] || null]));
      let savedRoles = roleDraft;
      if (Object.keys(changedRoles).length) {
        savedRoles = await configManager.updateConfig<DefaultModelsConfig>('ai.default_models', current => ({ ...current, ...changedRoles }));
        if (!isCurrent()) return;
        setInitialRoles({ ...roleDraft });
        onSaved();
      }
      await configManager.updateConfig<ModelRoutingConfig>('ai.model_routing', current => {
        // Recheck the fresh mutation value in case a legacy path changed after validation.
        requireTokenBudgetSupport(current);
        return {
          ...DEFAULTS, ...current, router_model_id: draft.router_model_id || null,
          // Keep automatic history preparation enabled on older execution hosts too.
          summary_enabled: true,
        };
      });
      if (!isCurrent()) return;
      onSaved();
      if (probe) {
        failureMessage = t('router.checkFailed');
        run.probe = {
          roles: { ...savedRoles }, routerModelId: draft.router_model_id || null,
          identity: modelRoutingCheckIdentity(latestModels.current, savedRoles, draft.router_model_id),
        };
        await checkConnections(savedRoles, isCurrent);
      } else onClose();
    } catch (error) {
      if (isCurrent()) {
        log.warn('Failed to save or check smart-mode configuration', { error });
        setMessage(failureMessage);
      }
    } finally { if (isCurrent()) setBusy(false); }
  };
  const saving = busy && !currentChecks;
  return <Dialog open preset="panel" closeOnEscape={!saving} closeOnPointerOutside={false} onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <DialogHeader><DialogHeading><DialogTitle>{t('router.title')}</DialogTitle></DialogHeading><DialogClose disabled={saving} /></DialogHeader>
    <DialogBody>
      <div className="model-router-settings" data-openbitfun-component="model-router-settings" data-openbitfun-part="root">
        <div className="model-router-settings__models">
          {(['primary', 'economy'] as const).map(role => <Field key={role} label={tModels(`core.${role}.label`)} controlWidth="fill">
            <Combobox size="sm" aria-label={tModels(`core.${role}.label`)} value={roleDraft?.[role] ?? ''}
              disabled={!available || busy || !roleDraft} placeholder={tModels(`core.${role}.placeholder`)}
              options={filterSelectableTextChatModels(models).map(buildModelOption)}
              onValueChange={value => { clearChecks(); setRoleDraft(current => current && { ...current, [role]: String(Array.isArray(value) ? value[0] ?? '' : value) || null }); }} />
          </Field>)}
        </div>
        <Field label={t('router.service')} description={t('router.serviceHint')} controlWidth="fill">
          <Select size="sm" aria-label={t('router.service')} value={draft?.router_model_id ?? ''} disabled={!available || busy || !draft}
            onValueChange={value => { clearChecks(); setDraft(current => current && { ...current, router_model_id: String(value) || null }); }}
            options={[{ value: '', label: t('router.unconfigured') }, ...models.filter((model): model is AIModelConfig & { id: string } => Boolean(model.id) && model.enabled && (!model.auth || model.auth.type === 'api_key'))
              .map(model => ({ value: model.id, label: `${model.model_name} · ${model.name}` }))]} />
        </Field>
        {(!available || message || currentChecks) && <div className="model-router-settings__status" role="status" aria-label={t('router.status')}
          data-openbitfun-component="model-router-settings" data-openbitfun-part="status">
          <span className="model-router-settings__status-label" data-openbitfun-component="model-router-settings" data-openbitfun-part="statusLabel">{t('router.status')}</span>
          {(message || !available) && <span>{message || t('router.notOpen')}</span>}
          {currentChecks && CHECK_ROLES.map(role => <div className="model-router-settings__check" key={role} data-model-routing-check={role}>
            <span>{role === 'router' ? t('router.connectionChecks.router') : tModels(`core.${role}.label`)}</span>
            <span className="model-router-settings__check-result">
              <span aria-hidden="true">{currentChecks[role].state === 'connected' ? '✓ ' : currentChecks[role].state === 'checking' ? '' : '× '}</span>
              {t(`router.connectionChecks.${currentChecks[role].state}`)}
            </span>
            {currentChecks[role].detail && <span className="model-router-settings__check-detail">{currentChecks[role].detail}</span>}
          </div>)}
        </div>}
        {onManageModels && <Button size="sm" variant="text" disabled={busy} onClick={onManageModels}>{t('router.manageModels')}</Button>}
      </div>
    </DialogBody>
    <DialogFooter appearance="floating">
      <Button size="sm" variant="outline" disabled={!available || busy || !draft || !roleDraft} onClick={() => void save(true)}>{t('router.test')}</Button>
      <Button size="sm" variant="primary" loading={busy} disabled={!available || !draft || !roleDraft} onClick={() => void save(false)}>{t('router.save')}</Button>
    </DialogFooter>
  </Dialog>;
}
