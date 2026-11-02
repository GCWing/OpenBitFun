import { useLayoutEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { Button, Icon, IconButton, OverflowText, Tooltip } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { ConfigPageRow, ConfigPageSection } from '@/infrastructure/config/components/common';
import { useSidebarNavigation } from '@/app/navigation/useSidebarNavigation';
import { sidebarPreferences } from '@/app/navigation/sidebarPreferences';

export default function SidebarSettingsSection() {
  const { t } = useI18n('settings/appearance');
  const { t: tCommon } = useI18n('common');
  const navigation = useSidebarNavigation();
  const { pinnedIds, entries, context } = navigation;
  const { setPinned, move, reset, storageIssue } = useStore(sidebarPreferences);
  const resetRef = useRef<HTMLButtonElement>(null);
  const capsuleRefs = useRef(new Map<string, HTMLButtonElement>());
  const nextFocus = useRef<string | null | undefined>(undefined);
  const readOnly = storageIssue === 'read' || storageIssue === 'version';
  const available = entries.filter(entry => !pinnedIds.includes(entry.id));
  useLayoutEffect(() => {
    if (nextFocus.current === undefined) return;
    const next = nextFocus.current && capsuleRefs.current.get(nextFocus.current);
    (next || resetRef.current)?.focus();
    nextFocus.current = undefined;
  }, [pinnedIds]);

  return <ConfigPageSection id="sidebar-navigation" title={t('sidebar.title')}
    extra={<Button ref={resetRef} size="sm" variant="quiet" onClick={reset}>{t('sidebar.reset')}</Button>}>
    {storageIssue && <p role="alert">{t(storageIssue === 'write' ? 'sidebar.saveFailed' : 'sidebar.readFailed')}</p>}
    <ul className="sidebar-settings__pinned" aria-label={t('sidebar.pinned')}>
      <li className="sidebar-settings__pinned-item">
        <OverflowText className="sidebar-settings__label">{tCommon('nav.items.personalOverview')}</OverflowText>
        <span className="sidebar-settings__fixed">{t('sidebar.alwaysVisible')}</span>
      </li>
      {pinnedIds.map((id, index) => {
        const entry = entries.find(candidate => candidate.id === id);
        const name = entry ? tCommon(entry.labelKey) : tCommon('nav.customization.unavailableEntry', { id });
        const reason = entry?.unavailableReason?.(context);
        return <li key={id} className="sidebar-settings__pinned-item" title={reason ? tCommon(reason) : undefined}>
          <OverflowText className="sidebar-settings__label">{name}</OverflowText>
          <div className="sidebar-settings__actions">
            <IconButton size="xs" variant="quiet" icon={<Icon name="arrow-up" size="xs" />}
              aria-label={t('sidebar.moveUp', { name })} disabled={readOnly || index === 0} onClick={() => move(id, -1)} />
            <IconButton size="xs" variant="quiet" icon={<Icon name="arrow-down" size="xs" />}
              aria-label={t('sidebar.moveDown', { name })} disabled={readOnly || index === pinnedIds.length - 1} onClick={() => move(id, 1)} />
            <IconButton size="xs" variant="quiet" icon={<Icon name="xmark" size="xs" />}
              aria-label={t('sidebar.remove', { name })} disabled={readOnly} onClick={() => {
                nextFocus.current = id;
                setPinned(id, false);
                if (sidebarPreferences.getState().pinnedIds.includes(id)) nextFocus.current = undefined;
              }} />
          </div>
        </li>;
      })}
    </ul>
    <div className="sidebar-settings__add">
      <ConfigPageRow className="sidebar-settings__available-heading" label={t('sidebar.available')}>{null}</ConfigPageRow>
      <div className="sidebar-settings__available" role="group" aria-label={t('sidebar.available')}>
        {available.map((entry, index) => {
          const name = tCommon(entry.labelKey);
          const reason = entry.unavailableReason?.(context);
          return <Tooltip key={entry.id} content={reason ? tCommon(reason) : t('sidebar.addEntry', { name })}>
            <Button className="sidebar-settings__available-page" size="xs" variant="outline" leadingIcon={<Icon name="plus" size="xs" />}
              ref={element => {
                if (element) capsuleRefs.current.set(entry.id, element);
                else capsuleRefs.current.delete(entry.id);
              }}
              data-testid="sidebar-available-page"
              aria-label={t('sidebar.addEntry', { name })} disabled={readOnly} onClick={() => {
                nextFocus.current = available[index + 1]?.id ?? available[index - 1]?.id ?? null;
                setPinned(entry.id, true);
                if (!sidebarPreferences.getState().pinnedIds.includes(entry.id)) nextFocus.current = undefined;
              }}>
              {name}
            </Button>
          </Tooltip>;
        })}
        {available.length === 0 && <span role="status">{t('sidebar.noResults')}</span>}
      </div>
    </div>
  </ConfigPageSection>;
}
