import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import {
  Button, Capsule, Card, CardBody, CardHeader, ConfirmDialog, Dialog, DialogBody, DialogClose, DialogFooter,
  DialogHeader, DialogHeading, DialogTitle, Icon, IconButton, Input, MenuPopover, OverflowText, Radio, StatusPill, Tooltip,
  type MenuEntry,
} from '@openbitfun/ui';
import { ConfigPageRow, ConfigPageSection } from '@/infrastructure/config/components/common';
import { useI18n } from '@/infrastructure/i18n';
import { useSettingsDraft } from '@/infrastructure/config/settingsDraftRegistry';
import { useModelSelectPresentation } from '@/infrastructure/config/components/ModelSelectPresentation';
import './ModelPoolsSection.scss';
import type { AIModelConfig } from '@/infrastructure/config/types';
import { ModelPoolMemberPicker } from './ModelPoolMemberPicker';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { modelPoolAPI, readableModelPools, supportsModelPools,
  type ModelPoolDefinition, type ModelPoolDocument, type ModelPoolMemberStatus,
} from '@/infrastructure/api/service-api/ModelPoolAPI';

function ModelPoolStrategyPreview({ strategy }: { strategy: 'ordered' | 'balanced' }) {
  return <div className="openbitfun-model-pools__strategy-preview" data-strategy={strategy} aria-hidden="true"
    data-openbitfun-component="model-settings" data-openbitfun-part="poolStrategyPreview">
    <img src="/assets/model-pools/routing-strategies-v1.png" alt="" draggable={false} decoding="async" />
  </div>;
}

function ModelPoolMemberCapsule({ id, order, model, status, busy, canMoveUp, canMoveDown, onMoveUp, onMoveDown, onRemove, onRetry }: {
  id: string;
  order: number;
  model?: AIModelConfig;
  status?: ModelPoolMemberStatus;
  busy: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const { t, formatNumber } = useI18n('settings/models');
  const { buildModelOption } = useModelSelectPresentation();
  const [menuOpen, setMenuOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const option = model ? buildModelOption(model) : undefined;
  const label = option?.label || id;
  const orderedLabel = `${formatNumber(order)}. ${label}`;
  const healthLabel = status ? t(`pools.health.${status.status}`) : model ? t('pools.health.unverified') : t('pools.health.missing');
  const moreLabel = t('pool.moreActions', { model: orderedLabel });
  const items: MenuEntry[] = [
    { id: 'health', label: healthLabel, disabled: true },
    ...(status && ['needs_attention', 'cooling_down'].includes(status.status)
      ? [{ id: 'retry', label: t('pools.retry'), disabled: busy, onSelect: onRetry }] : []),
    { id: 'up', label: t('pools.up'), icon: <Icon name="arrow-up" size="sm" />, disabled: busy || !canMoveUp, onSelect: onMoveUp },
    { id: 'down', label: t('pools.down'), icon: <Icon name="arrow-down" size="sm" />, disabled: busy || !canMoveDown, onSelect: onMoveDown },
  ];

  return <div className="openbitfun-model-pools__member" role="listitem"
    data-openbitfun-component="model-settings" data-openbitfun-part="poolMember">
    <Capsule size="xs" action={(
      <Tooltip content={t('pools.remove')}>
        <IconButton size="xs" shape="circle" variant="quiet" disabled={busy}
          aria-label={t('providerSelection.removeModelByName', { name: label })}
          data-testid="settings-model-pool-member-remove" data-model-id={id}
          icon={<Icon name="xmark" size="xs" />} onClick={onRemove} />
      </Tooltip>
    )}>
      <Tooltip disabled={menuOpen} content={(
        <div className="openbitfun-model-pools__member-summary"
          data-openbitfun-component="model-settings" data-openbitfun-part="poolMemberSummary">
          {option?.description && <span>{option.description}</span>}
          <span>{healthLabel}</span>
          {status?.reason && <span>{status.reason}</span>}
        </div>
      )}>
        <Button ref={anchorRef} variant="fill" size="xs" disabled={busy}
          className="openbitfun-model-pools__member-button"
          leadingIcon={<span className="openbitfun-model-pools__member-order"
            data-openbitfun-component="model-settings" data-openbitfun-part="poolMemberOrder">{formatNumber(order)}</span>}
          data-testid="settings-model-pool-member" data-model-id={id}
          aria-label={moreLabel} aria-haspopup="menu" aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined} onClick={() => setMenuOpen(open => !open)}
          onKeyDown={event => {
            if (event.key !== 'ArrowDown') return;
            event.preventDefault();
            setMenuOpen(true);
          }}>
          {label}
        </Button>
      </Tooltip>
    </Capsule>
    <span data-openbitfun-component="model-settings" data-openbitfun-part="poolMemberActions">
      <MenuPopover id={menuId} data-testid="settings-model-pool-member-menu" aria-label={moreLabel}
        anchorRef={anchorRef} ownerRef={anchorRef} placement="bottom" open={menuOpen && !busy}
        onClose={() => setMenuOpen(false)} items={items} />
    </span>
  </div>;
}

/** Pool records belong to the execution host and are saved in the main configuration. */
export function ModelPoolsSection({ models }: { models: AIModelConfig[] }) {
  const { t } = useI18n('settings/models');
  const strategyGroupId = useId();
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const [document, setDocument] = useState<ModelPoolDocument>();
  const [draft, setDraft] = useState<ModelPoolDefinition>();
  const [statuses, setStatuses] = useState<ModelPoolMemberStatus[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const statusRequest = useRef(0);
  const [deleteId, setDeleteId] = useState<string>();
  const supported = supportsModelPools();
  const strategyOptions = [
    { value: 'ordered', label: t('pools.ordered') },
    { value: 'balanced', label: t('pools.balanced') },
  ] as const;
  const pools = document ? readableModelPools(document) : [];
  const load = useCallback(async () => {
    try {
      const result = await modelPoolAPI.list();
      if (!scope.isCurrent()) return;
      setDocument(result);
      setError(undefined);
    } catch (cause) {
      if (scope.isCurrent()) setError(String(cause));
    }
  }, [scope]);
  useEffect(() => {
    statusRequest.current += 1;
    setBusy(false);
    setDocument(undefined); setDraft(undefined); setStatuses([]); setDeleteId(undefined); setError(undefined);
    if (supported) void load();
  }, [load, supported]);

  const save = async (): Promise<boolean> => {
    if (!draft || busy) return false;
    setBusy(true);
    try {
      const result = await modelPoolAPI.save(draft);
      if (!scope.isCurrent()) return false;
      statusRequest.current += 1;
      setDocument(result); setDraft(undefined); setStatuses([]); setError(undefined);
      return true;
    } catch (cause) {
      if (scope.isCurrent()) setError(String(cause));
      return false;
    } finally {
      if (scope.isCurrent()) setBusy(false);
    }
  };
  const discardDraft = () => {
    if (busy) return;
    statusRequest.current += 1;
    setDraft(undefined);
    setStatuses([]);
    setError(undefined);
  };
  useSettingsDraft({ id: 'model-pools', pageId: 'ai.models', label: t('pools.title'),
    dirty: Boolean(draft), saving: busy, save, discard: discardDraft });

  const edit = (pool: ModelPoolDefinition) => {
    const request = ++statusRequest.current;
    setDraft({ ...pool, member_model_ids: [...pool.member_model_ids] });
    setStatuses([]); setDeleteId(undefined); setError(undefined);
    void modelPoolAPI.status(pool.id).then(result => {
      if (scope.isCurrent() && request === statusRequest.current) setStatuses(result);
    }).catch(cause => { if (scope.isCurrent() && request === statusRequest.current) setError(String(cause)); });
  };
  const remove = async (id: string) => {
    if (!document || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await modelPoolAPI.remove(id);
      if (!scope.isCurrent()) return;
      setDocument(result); setDeleteId(undefined); setError(undefined);
    } catch (cause) {
      if (scope.isCurrent()) setError(String(cause));
    } finally {
      if (scope.isCurrent()) setBusy(false);
    }
  };
  const move = (index: number, direction: number) => {
    if (!draft) return;
    const members = [...draft.member_model_ids];
    [members[index], members[index + direction]] = [members[index + direction], members[index]];
    setDraft({ ...draft, member_model_ids: members });
  };

  const errorBanner = error && <div role="alert"><p>{t('pools.error')}</p><p>{error}</p>
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>{t('pools.refresh')}</Button></div>;

  return <>
    <ConfigPageSection title={t('pools.title')} extra={supported && (
      <Tooltip content={t('pools.create')}>
        <IconButton size="sm" aria-label={t('pools.create')} icon={<Icon name="plus" size="sm" />}
          disabled={busy || !document} onClick={() => {
            statusRequest.current += 1;
            setStatuses([]); setDeleteId(undefined); setError(undefined);
            setDraft({ id: '', name: '', strategy: 'ordered', member_model_ids: [] });
          }} />
      </Tooltip>
    )}>
      {!supported ? <p role="status">{t('pools.unsupported')}</p> : <>
        {!draft && !deleteId && errorBanner}
        {document && document.pools.length !== pools.length && <p role="status">{t('pools.invalidRecords')}</p>}
        {document && <>
          {document.pools.length === 0 && <ConfigPageRow align="center" label={
            <span className="openbitfun-model-pools__empty" role="status"
              data-openbitfun-component="model-settings" data-openbitfun-part="poolEmpty">
              {t('pools.empty')}
            </span>
          }>{null}</ConfigPageRow>}
          {pools.map(pool => <ConfigPageRow key={pool.id} className="openbitfun-model-pools__pool" align="center" label={
            <div className="openbitfun-model-pools__summary" data-openbitfun-component="model-settings" data-openbitfun-part="poolSummary">
              <OverflowText className="openbitfun-model-pools__name">{pool.name}</OverflowText>
              <StatusPill tone="neutral">
                {pool.strategy === 'ordered' ? t('pools.ordered') : pool.strategy === 'balanced' ? t('pools.balanced') : t('pools.unsupported')}
              </StatusPill>
            </div>
          }>
            <div className="openbitfun-model-pools__actions" data-openbitfun-component="model-settings" data-openbitfun-part="poolActions">
              <Tooltip content={t('shared:tools.edit')}>
                <IconButton size="sm" aria-label={t('shared:tools.edit')} icon={<Icon name="edit" size="sm" />}
                  onClick={() => edit(pool)} disabled={busy} />
              </Tooltip>
              <Tooltip content={t('pools.delete')}>
                <IconButton size="sm" tone="danger" aria-label={t('pools.delete')}
                  icon={<Icon name="delete" size="sm" />} disabled={busy}
                  onClick={() => { setError(undefined); setDeleteId(pool.id); }} />
              </Tooltip>
            </div>
          </ConfigPageRow>)}
        </>}
      </>}
    </ConfigPageSection>
    <ConfirmDialog
      key={scope.epoch}
      open={Boolean(deleteId)}
      onOpenChange={() => { if (!busy) { setDeleteId(undefined); setError(undefined); } }}
      onConfirm={async () => { if (deleteId) await remove(deleteId); }}
      title={t('pools.deleteTitle', { name: pools.find(pool => pool.id === deleteId)?.name ?? '' })}
      message={<>
        <p>{t('pools.deleteHint')}</p>
        {error && <p role="alert">{error}</p>}
      </>}
      confirmText={t('pools.confirmDelete')}
      cancelText={t('pools.cancel')}
      pendingAction={busy ? 'confirm' : null}
      closeOnPointerOutside={false}
      confirmDanger
      type="warning"
    />
    <Dialog open={Boolean(draft)} onOpenChange={nextOpen => { if (!nextOpen) discardDraft(); }}
      className="openbitfun-model-pools__editor"
      data-testid="settings-model-pool-dialog"
      size="lg" closeOnPointerOutside={false}>
      <DialogHeader>
        <DialogHeading>
          <DialogTitle>{t(pools.some(pool => pool.id === draft?.id) ? 'pools.editTitle' : 'pools.create')}</DialogTitle>
        </DialogHeading>
        <DialogClose disabled={busy} />
      </DialogHeader>
      <DialogBody aria-busy={busy}>
        {errorBanner}
        {draft && <>
          <ConfigPageRow className="openbitfun-model-pools__editor-row openbitfun-model-pools__name-row" wide align="center" label={t('pools.name')}><Input size="sm" aria-label={t('pools.name')}
            value={draft.name} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} /></ConfigPageRow>
          <ConfigPageRow className="openbitfun-model-pools__editor-row" multiline label={
            <span className="openbitfun-model-pools__summary" data-openbitfun-component="model-settings" data-openbitfun-part="poolStrategyLabel">
              {t('pools.strategy')}
              <Tooltip content={t('pools.stickyHint')}>
                <IconButton size="xs" variant="quiet" aria-label={t('pools.stickyHint')}
                  icon={<Icon name="info" size="sm" />} />
              </Tooltip>
            </span>
          }>
            <div className="openbitfun-model-pools__strategies" role="radiogroup" aria-label={t('pools.strategy')}
              data-openbitfun-component="model-settings" data-openbitfun-part="poolStrategies"
              onKeyDown={event => {
                if (busy) return;
                const radios = Array.from(event.currentTarget.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
                const index = Math.max(0, radios.findIndex(radio => radio === event.target));
                let next: number;
                if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = radios.length - 1;
                else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % radios.length;
                else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + radios.length - 1) % radios.length;
                else return;
                event.preventDefault();
                setDraft({ ...draft, strategy: radios[next].value });
                radios[next].focus({ preventScroll: true });
              }}>
              {strategyOptions.map(option => (
                <Card key={option.value} appearance="neutral" padding="none" clip
                  className="openbitfun-model-pools__strategy-card"
                  data-selected={draft.strategy === option.value} data-disabled={busy}
                  onClick={event => {
                    if (busy) return;
                    setDraft({ ...draft, strategy: option.value });
                    event.currentTarget.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
                  }}>
                  <ModelPoolStrategyPreview strategy={option.value} />
                  <CardHeader className="openbitfun-model-pools__strategy-header" actions={<Radio name={strategyGroupId} value={option.value} size="sm"
                    checked={draft.strategy === option.value} disabled={busy}
                    aria-label={option.label}
                    data-testid={`settings-model-pool-strategy-${option.value}`}
                    onCheckedChange={() => setDraft({ ...draft, strategy: option.value })} />} />
                  <CardBody align="center" className="openbitfun-model-pools__strategy-content">
                    <span className="openbitfun-model-pools__strategy-title"
                      data-openbitfun-component="model-settings" data-openbitfun-part="poolStrategyTitle">{option.label}</span>
                  </CardBody>
                </Card>
              ))}
            </div>
          </ConfigPageRow>
          <ConfigPageRow className="openbitfun-model-pools__editor-row" balanced align="center" label={
            <span className="openbitfun-model-pools__summary" data-openbitfun-component="model-settings" data-openbitfun-part="poolAddLabel">
              {t('pools.add')}
              <Tooltip content={t('pools.addHint')}>
                <IconButton size="xs" variant="quiet" aria-label={t('pools.addHint')}
                  icon={<Icon name="info" size="sm" />} />
              </Tooltip>
            </span>
          }><ModelPoolMemberPicker key={scope.epoch} models={models} value={draft.member_model_ids} disabled={busy}
            onValueChange={member_model_ids => setDraft({ ...draft, member_model_ids })} /></ConfigPageRow>
          {draft.member_model_ids.length > 0 && <div className="openbitfun-model-pools__members" role="list"
            data-openbitfun-component="model-settings" data-openbitfun-part="poolMembers">
            {draft.member_model_ids.map((id, index) => (
              <ModelPoolMemberCapsule key={id} id={id} order={index + 1} model={models.find(item => item.id === id)}
                status={statuses.find(item => item.modelId === id)} busy={busy}
                canMoveUp={index > 0} canMoveDown={index < draft.member_model_ids.length - 1}
                onMoveUp={() => move(index, -1)} onMoveDown={() => move(index, 1)}
                onRemove={() => setDraft({ ...draft, member_model_ids: draft.member_model_ids.filter(member => member !== id) })}
                onRetry={() => {
                    setBusy(true);
                    void modelPoolAPI.retryMember(id).then(() => modelPoolAPI.status(draft.id))
                      .then(result => { if (scope.isCurrent()) setStatuses(result); })
                      .catch(cause => { if (scope.isCurrent()) setError(String(cause)); })
                      .finally(() => { if (scope.isCurrent()) setBusy(false); });
                }} />
            ))}
          </div>}
        </>}
      </DialogBody>
      <DialogFooter appearance="floating">
        <Button size="sm" variant="fill" disabled={busy} onClick={discardDraft}>{t('pools.cancel')}</Button>
        <Button size="sm" variant="primary" loading={busy} disabled={busy || !draft?.name.trim()} onClick={() => void save()}>{t('pools.save')}</Button>
      </DialogFooter>
    </Dialog>
  </>;
}
