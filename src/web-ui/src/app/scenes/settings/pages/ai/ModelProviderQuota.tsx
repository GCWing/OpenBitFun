import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Input } from '@openbitfun/ui';
import { ConfigPageRow } from '@/infrastructure/config/components/common';
import type { AIModelConfig } from '@/infrastructure/config/types';
import { aiApi, type ModelPlanQuotaProvider, type StepFunQuotaSetup } from '@/infrastructure/api/service-api/AIApi';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { SubscriptionQuotaPanel } from './SubscriptionQuotaPanel';
import { modelPlanQuotaKind, canReadSavedPlanQuota } from './modelPlanQuota';
import styles from './ModelProviderQuota.module.scss';

let epoch = 0;
export function ModelProviderQuota({ draft, saved, active, supported }: {
  draft: Partial<AIModelConfig>; saved?: AIModelConfig; active: boolean; supported: boolean;
}) {
  const { t } = useI18n('settings/models');
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const identity = useMemo(() => saved ? `plan-quota-${++epoch}` : 'plan-quota-unsaved', [saved]);
  const provider = modelPlanQuotaKind(draft);
  if (!provider || !active) return null;
  if (!canReadSavedPlanQuota(draft, saved)) return <ConfigPageRow label={t('quota.title')} description={t('quota.planSaveBeforeQuery')} className={styles.root}>{null}</ConfigPageRow>;
  if (!supported) return <ConfigPageRow label={t('quota.title')} description={t('quota.hostUnsupported')} className={styles.root}>{null}</ConfigPageRow>;
  return <SavedPlanQuota key={scope.key(identity)} provider={provider} modelId={saved.id} identity={identity} active={active} />;
}

function SavedPlanQuota({ provider, modelId, identity, active }: { provider: ModelPlanQuotaProvider; modelId: string; identity: string; active: boolean }) {
  const [version, setVersion] = useState(0);
  return <div className={styles.root}>
    {provider === 'stepfun' && <StepFunConnection modelId={modelId} active={active} onChanged={() => setVersion(v => v + 1)} />}
    <SubscriptionQuotaPanel key={version} provider={provider} accountId={`model:${modelId}`} modelId={modelId}
      identity={`${identity}:${version}`} active={active} supported compact />
  </div>;
}

function StepFunConnection({ modelId, active, onChanged }: { modelId: string; active: boolean; onChanged: () => void }) {
  const { t } = useI18n('settings/models');
  const [setup, setSetup] = useState<StepFunQuotaSetup | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const generation = useRef(0);
  useEffect(() => {
    let alive = true;
    const request = ++generation.current;
    if (active) void aiApi.manageModelQuotaConnection(modelId, 'status').then(value => {
      if (alive && scope.isCurrent() && request === generation.current) setSetup(value);
    }).catch(() => { if (alive && scope.isCurrent() && request === generation.current) setMessage('quota.stepfunConnectFailed'); });
    return () => { alive = false; generation.current += 1; };
  }, [modelId, active, scope]);
  const change = async (action: 'connect' | 'disconnect') => {
    if (busy || !scope.isCurrent()) return;
    const request = ++generation.current;
    setBusy(true); setMessage(null);
    const secret = token; setToken('');
    try {
      const value = await aiApi.manageModelQuotaConnection(modelId, action, action === 'connect' ? secret : undefined);
      if (!scope.isCurrent() || request !== generation.current) return;
      setSetup(value); onChanged();
    } catch { if (scope.isCurrent() && request === generation.current) setMessage('quota.stepfunConnectFailed'); }
    finally { if (scope.isCurrent() && request === generation.current) setBusy(false); }
  };
  const open = async (copy: boolean) => {
    if (!setup || !scope.isCurrent()) return;
    try {
      if (copy) {
        await systemAPI.setClipboard(setup.bookmarklet);
        if (scope.isCurrent()) setMessage('quota.stepfunBookmarkCopied');
      } else await systemAPI.openExternal(setup.signInUrl);
    } catch { if (scope.isCurrent()) setMessage('quota.stepfunConnectFailed'); }
  };
  return <>
    <ConfigPageRow label={t('quota.stepfunConnection')} description={t('quota.stepfunConnectionHint')} wide>
      <div className={styles.actions}>{setup?.connected ? <>
        <span>{t('quota.stepfunAccount', { account: setup.account || '' })}</span>
        <Button size="xs" variant="text" disabled={busy || !active} onClick={() => void change('disconnect')}>{t('quota.stepfunDisconnect')}</Button>
      </> : <>
        <Button size="xs" variant="text" disabled={!setup || !active} onClick={() => void open(false)}>{t('quota.stepfunOpen')}</Button>
        <Button size="xs" variant="text" disabled={!setup || !active} onClick={() => void open(true)}>{t('quota.stepfunCopyBookmark')}</Button>
      </>}</div>
    </ConfigPageRow>
    {!setup?.connected && <ConfigPageRow label={t('quota.stepfunAuthorization')} description={t('quota.stepfunBookmarkHint')} multiline>
      <div className={styles.authorization}><Input type="password" size="sm" autoComplete="off" aria-label={t('quota.stepfunAuthorization')} value={token} onChange={e => setToken(e.target.value)} disabled={busy || !active} />
      <Button size="xs" variant="text" disabled={!token.trim() || busy || !active || !setup} onClick={() => void change('connect')}>{t('quota.stepfunConnect')}</Button></div>
    </ConfigPageRow>}
    {message && <ConfigPageRow label={t('quota.title')} description={t(message)} role="status">{null}</ConfigPageRow>}
  </>;
}
