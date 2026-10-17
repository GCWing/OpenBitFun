import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Button, Combobox, ConfirmDialog, Dialog, DialogBody, DialogClose, DialogFooter,
  DialogHeader, DialogHeading, DialogTitle, Icon, IconButton, Input, OverflowText, Select, StatusPill, Tooltip,
} from '@openbitfun/ui';
import { ConfigPageRow, ConfigPageSection } from '@/infrastructure/config/components/common';
import { useI18n } from '@/infrastructure/i18n';
import { useSettingsDraft } from '@/infrastructure/config/settingsDraftRegistry';
import { useModelSelectPresentation } from '@/infrastructure/config/components/ModelSelectPresentation';
import './ModelPoolsSection.scss';
import type { AIModelConfig } from '@/infrastructure/config/types';
import { filterSelectableTextChatModels } from '@/infrastructure/config/services/modelCategory';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { modelPoolAPI, readableModelPools, supportsModelPools,
  type ModelPoolDefinition, type ModelPoolDocument, type ModelPoolMemberStatus,
} from '@/infrastructure/api/service-api/ModelPoolAPI';

/** Pool records belong to the execution host and are saved in the main configuration. */
export function ModelPoolsSection({ models }: { models: AIModelConfig[] }) {
  const { t } = useI18n('settings/models');
  const { buildModelOption } = useModelSelectPresentation();
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const [document, setDocument] = useState<ModelPoolDocument>();
  const [draft, setDraft] = useState<ModelPoolDefinition>();
  const [statuses, setStatuses] = useState<ModelPoolMemberStatus[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const statusRequest = useRef(0);
  const [deleteId, setDeleteId] = useState<string>();
  const supported = supportsModelPools();
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
          <ConfigPageRow balanced align="center" label={t('pools.name')}><Input size="sm" aria-label={t('pools.name')}
            value={draft.name} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} /></ConfigPageRow>
          <ConfigPageRow balanced align="center" label={
            <span className="openbitfun-model-pools__summary" data-openbitfun-component="model-settings" data-openbitfun-part="poolStrategyLabel">
              {t('pools.strategy')}
              <Tooltip content={t('pools.stickyHint')}>
                <IconButton size="xs" variant="quiet" aria-label={t('pools.stickyHint')}
                  icon={<Icon name="info" size="sm" />} />
              </Tooltip>
            </span>
          }>
            <Select size="sm" aria-label={t('pools.strategy')} value={draft.strategy} disabled={busy}
              options={[
                { value: 'ordered', label: t('pools.ordered'), tooltip: t('pools.orderedHint') },
                { value: 'balanced', label: t('pools.balanced'), tooltip: t('pools.balancedHint') },
              ]}
              onValueChange={value => setDraft({ ...draft, strategy: String(value) })} />
          </ConfigPageRow>
          <ConfigPageRow balanced align="center" label={
            <span className="openbitfun-model-pools__summary" data-openbitfun-component="model-settings" data-openbitfun-part="poolAddLabel">
              {t('pools.add')}
              <Tooltip content={t('pools.addHint')}>
                <IconButton size="xs" variant="quiet" aria-label={t('pools.addHint')}
                  icon={<Icon name="info" size="sm" />} />
              </Tooltip>
            </span>
          }><Combobox size="sm" aria-label={t('pools.add')} value="" disabled={busy}
            placeholder={t('pools.add')} options={filterSelectableTextChatModels(models).filter(model => Boolean(model.id) && !draft.member_model_ids.includes(model.id!))
              .map(buildModelOption)}
            onValueChange={value => { if (value) setDraft({ ...draft, member_model_ids: [...draft.member_model_ids, String(value)] }); }} /></ConfigPageRow>
          {draft.member_model_ids.length > 0 && <ul className="openbitfun-model-pools__members" role="list"
            data-openbitfun-component="model-settings" data-openbitfun-part="poolMembers">
            {draft.member_model_ids.map((id, index) => {
              const model = models.find(item => item.id === id);
              const status = statuses.find(item => item.modelId === id);
              return <li key={id} className="openbitfun-model-pools__member" data-openbitfun-component="model-settings" data-openbitfun-part="poolMember">
                <div className="openbitfun-model-pools__summary" data-openbitfun-component="model-settings" data-openbitfun-part="poolMemberSummary">
                  <OverflowText className="openbitfun-model-pools__name">{model ? buildModelOption(model).label : id}</OverflowText>
                  <StatusPill tone="neutral">
                    {status ? t(`pools.health.${status.status}`) : model ? t('pools.health.unverified') : t('pools.health.missing')}
                  </StatusPill>
                </div>
                {status && ['needs_attention', 'cooling_down'].includes(status.status) && <Button size="sm" variant="outline" disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void modelPoolAPI.retryMember(id).then(() => modelPoolAPI.status(draft.id))
                      .then(result => { if (scope.isCurrent()) setStatuses(result); })
                      .catch(cause => { if (scope.isCurrent()) setError(String(cause)); })
                      .finally(() => { if (scope.isCurrent()) setBusy(false); });
                  }}>{t('pools.retry')}</Button>}
                <div className="openbitfun-model-pools__member-actions" data-openbitfun-component="model-settings" data-openbitfun-part="poolMemberActions">
                  <Tooltip content={t('pools.up')}>
                    <IconButton size="sm" aria-label={t('pools.up')} icon={<Icon name="arrow-up" size="sm" />}
                      disabled={busy || index === 0} onClick={() => move(index, -1)} />
                  </Tooltip>
                  <Tooltip content={t('pools.down')}>
                    <IconButton size="sm" aria-label={t('pools.down')} icon={<Icon name="arrow-down" size="sm" />}
                      disabled={busy || index === draft.member_model_ids.length - 1} onClick={() => move(index, 1)} />
                  </Tooltip>
                  <Tooltip content={t('pools.remove')}>
                    <IconButton size="sm" tone="danger" aria-label={t('pools.remove')} icon={<Icon name="delete" size="sm" />}
                      disabled={busy} onClick={() => setDraft({ ...draft, member_model_ids: draft.member_model_ids.filter(member => member !== id) })} />
                  </Tooltip>
                </div>
              </li>;
            })}
          </ul>}
        </>}
      </DialogBody>
      <DialogFooter appearance="floating">
        <Button size="sm" variant="fill" disabled={busy} onClick={discardDraft}>{t('pools.cancel')}</Button>
        <Button size="sm" variant="primary" loading={busy} disabled={busy || !draft?.name.trim()} onClick={() => void save()}>{t('pools.save')}</Button>
      </DialogFooter>
    </Dialog>
  </>;
}
