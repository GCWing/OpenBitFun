import { useEffect, useId, useState } from 'react';
import { Alert, Button, Card, CardHeader, Icon, IconButton, LoadingState, OverflowText, StatusPill } from '@openbitfun/ui';
import { CircleUserRound } from 'lucide-react';
import { aiApi, type SubscriptionAccount } from '@/infrastructure/api/service-api/AIApi';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { useSettingsStore } from '@/app/scenes/settings/settingsStore';
import { useSceneStore } from '@/app/stores/sceneStore';

interface Props {
  provider: 'codex' | 'opencode';
  supported: boolean;
  refreshVersion: number;
  expanded: boolean;
  onToggle: () => void;
}

export default function EcosystemAccounts({ provider, supported, refreshVersion, expanded, onToggle }: Props) {
  const { t } = useI18n('scenes/ecosystem-compatibility');
  const id = useId();
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{ provider: string; account: SubscriptionAccount | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    setSnapshot(null);
    setFailed(false);
    if (!supported) { setLoading(false); return; }
    const scope = getActiveSurfaceScope();
    setLoading(true);
    void aiApi.listSubscriptionAccounts().then((accounts) => {
      if (current && scope.isCurrent()) setSnapshot({ provider, account: accounts.find((entry) => entry.provider === provider) ?? null });
    }).catch(() => {
      if (current && scope.isCurrent()) setFailed(true);
    }).finally(() => {
      if (current && scope.isCurrent()) setLoading(false);
    });
    return () => { current = false; };
  }, [provider, supported, refreshVersion, revision]);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  const account = supported && snapshot?.provider === provider ? snapshot.account : null;
  const state = !supported ? 'unsupportedHost' : loading ? 'loading' : failed ? 'failed'
    : !account ? 'unavailable' : account.vault_unavailable ? 'vaultUnavailable'
      : account.reauthentication_required ? 'reauthenticationRequired' : account.connected ? 'connected' : 'notConnected';
  const openAccountSettings = () => {
    if (!supported || !account) return;
    useSettingsStore.getState().openDestination({ pageId: 'ai.models' });
    useSceneStore.getState().openScene('settings');
  };
  return <div data-content-group="account" role="rowgroup" className="ecosystem-compatibility__content-group">
    <div className="ecosystem-compatibility__content-summary" role="row">
      <span role="cell" className="ecosystem-compatibility__import-item">
        <span className="ecosystem-compatibility__import-item-icon"><Icon glyph={CircleUserRound} size="md" /></span>
        <span className="ecosystem-compatibility__import-item-copy"><strong>{t('capabilities.account')}</strong><small>{t('content.accounts.description')}</small></span>
      </span>
      <span role="cell"><OverflowText>{t(`content.accounts.providers.${provider}`)}</OverflowText></span>
      <span role="cell" className="ecosystem-compatibility__content-summary-state">
        <StatusPill tone="neutral" title={t(`content.accounts.states.${state}`)}>{state === 'loading' ? t('loading') : t(`content.accounts.labels.${state}`)}</StatusPill>
        <IconButton size="sm" variant="quiet" icon={<Icon name={expanded ? 'chevron-down' : 'chevron-right'} size="sm" />}
          aria-label={t(expanded ? 'content.collapseCategory' : 'content.expandCategory', { type: t('capabilities.account') })}
          aria-expanded={expanded} aria-controls={id} onClick={() => { if (!expanded) setRevision((value) => value + 1); onToggle(); }} />
      </span>
    </div>
    <div role="row" hidden={!expanded}><div id={id} role="cell" aria-colspan={3} className="ecosystem-compatibility__content-expanded">
      {expanded ? <Card appearance="subtle" padding="sm" className="ecosystem-compatibility__account-panel">
        <CardHeader
          title={<OverflowText>{account?.account || t(`content.accounts.providers.${provider}`)}</OverflowText>}
          description={supported && loading
            ? <LoadingState size="sm">{t('loading')}</LoadingState>
            : t(`content.accounts.notes.${provider}`)}
        />
        <div className="ecosystem-compatibility__account-actions">
          {account ? <Button size="sm" variant="outline" onClick={openAccountSettings}>{t(account.connected && !account.reauthentication_required && !account.vault_unavailable ? 'content.accounts.manage' : 'content.accounts.connect')}</Button> : null}
          <IconButton size="sm" variant="quiet" icon={<Icon name="refresh" size="sm" />}
            aria-label={t('content.accounts.refresh')} title={t('content.accounts.refresh')}
            disabled={!supported || loading} onClick={() => setRevision((value) => value + 1)} />
        </div>
        {!['loading', 'connected', 'notConnected'].includes(state) ? <Alert
          className="ecosystem-compatibility__account-feedback"
          tone={state === 'failed' ? 'error' : 'info'}
          message={t(`content.accounts.states.${state}`)}
        /> : null}
      </Card> : null}
    </div></div>
  </div>;
}
