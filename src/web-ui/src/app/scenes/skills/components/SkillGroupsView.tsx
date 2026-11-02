import { useMemo, useRef, useState } from 'react';
import {
  Button, Icon, IconButton, LoadingState, MenuPopover, OverflowText, ScrollArea,
  type MenuEntry,
} from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { confirmDialog } from '@/infrastructure/confirm-dialog';
import { isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
import type { UserSkillGroup } from '@/infrastructure/config/types';
import {
  builtinSkillGroupLabelKey, deleteUserSkillGroup, moveUserSkillGroup,
  resolveSkillGroups, saveUserSkillGroup, type GroupableSkill, type ResolvedSkillGroup,
} from '@/features/skill-groups/skillGroups';
import type { useUserSkillGroups } from '@/features/skill-groups/useUserSkillGroups';
import { SkillGroupEditor, type SkillGroupDraft } from './SkillGroupEditor';
import { skillGroupErrorMessage } from './skillGroupMessages';
import './SkillGroupsView.scss';

interface SkillGroupsViewProps {
  searchQuery: string;
  skills: GroupableSkill[];
  collection: ReturnType<typeof useUserSkillGroups>;
  catalogReady: boolean;
  catalogLoading: boolean;
  catalogIncomplete: boolean;
  onRefresh: () => void;
}

function GroupActions({ label, items, disabled }: { label: string; items: MenuEntry[]; disabled: boolean }) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton ref={anchorRef} aria-label={label} title={label} size="sm" disabled={disabled}
        aria-haspopup="menu" aria-expanded={open} icon={<Icon name="more" />}
        onClick={() => setOpen(value => !value)} />
      <MenuPopover anchorRef={anchorRef} open={open && !disabled} onClose={() => setOpen(false)}
        items={items} placement="bottom" aria-label={label} />
    </>
  );
}

export default function SkillGroupsView({ searchQuery, skills, collection, catalogReady, catalogLoading, catalogIncomplete, onRefresh }: SkillGroupsViewProps) {
  const { t, formatNumber } = useI18n('scenes/skills');
  const [draft, setDraft] = useState<SkillGroupDraft | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const groups = useMemo(() => resolveSkillGroups(skills, collection.groups, {
    builtin: key => {
      const labelKey = builtinSkillGroupLabelKey(key);
      return labelKey ? t(`groups.builtin.${labelKey}`) : key;
    },
    other: '',
  }), [collection.groups, skills, t]);
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filtered = groups.filter(group => !normalizedQuery || [group.label, ...group.skills.map(skill => skill.name)]
    .some(value => value.toLowerCase().includes(normalizedQuery)));
  const userGroups = filtered.filter(group => group.kind === 'user');
  const builtinGroups = filtered.filter(group => group.kind === 'builtin');
  const busy = collection.saving || !collection.ready;

  const copy = (group: ResolvedSkillGroup | UserSkillGroup) => {
    const label = 'label' in group ? group.label : group.name;
    const baseName = t('groups.copyName', { name: label });
    let name = baseName;
    let index = 2;
    while (collection.groups.some(item => item.name.toLowerCase() === name.toLowerCase())) {
      name = t('groups.copyNameNumbered', { name: baseName, count: index++ });
    }
    setDraft({ group: { id: crypto.randomUUID(), name, skillKeys: [...group.skillKeys] }, original: null });
  };

  const edit = (group: ResolvedSkillGroup) => {
    setActionError(null);
    const original = collection.groups.find(item => `user:${item.id}` === group.id);
    setDraft(original
      ? { group: { ...original, skillKeys: [...original.skillKeys] }, original }
      : { group: { id: group.id, name: group.label, skillKeys: group.skillKeys }, original: null, readOnly: true });
  };

  const mutate = async (change: (groups: UserSkillGroup[]) => UserSkillGroup[]) => {
    setActionError(null);
    try {
      await collection.updateGroups(change);
    } catch (error) {
      if (!isSurfaceChangedError(error)) setActionError(skillGroupErrorMessage(error, t, 'save'));
    }
  };

  const remove = async (group: UserSkillGroup) => {
    const confirmed = await confirmDialog({
      title: t('groups.deleteTitle'), message: t('groups.deleteMessage', { name: group.name }),
      confirmText: t('groups.delete'), cancelText: t('groups.cancel'), confirmDanger: true, type: 'warning',
    });
    if (confirmed && collection.scope.isCurrent()) await mutate(current => deleteUserSkillGroup(current, group));
  };

  const renderGroup = (group: ResolvedSkillGroup) => {
    const original = collection.groups.find(item => `user:${item.id}` === group.id);
    const index = collection.groups.findIndex(item => item.id === original?.id);
    const items: MenuEntry[] = [
      { id: 'edit', label: t('groups.edit'), onSelect: () => edit(group) },
      { id: 'copy', label: t('groups.copy'), onSelect: () => copy(group) },
      { id: 'up', label: t('groups.moveUp'), disabled: index <= 0,
        onSelect: () => { if (original) void mutate(current => moveUserSkillGroup(current, original.id, -1)); } },
      { id: 'down', label: t('groups.moveDown'), disabled: index === collection.groups.length - 1,
        onSelect: () => { if (original) void mutate(current => moveUserSkillGroup(current, original.id, 1)); } },
      { id: 'delete', label: t('groups.delete'), tone: 'danger',
        onSelect: () => { if (original) void remove(original); } },
    ];
    return (
      <div key={group.id} role="row" className="skill-groups__row" data-overflow-trigger
        aria-disabled={busy || undefined} data-openbitfun-scene="skills" data-openbitfun-part="groupRow">
        <div className="skill-groups__identity" role="cell">
          <button type="button" className="skill-groups__open" disabled={busy} aria-label={group.label}
            onClick={() => edit(group)} data-openbitfun-scene="skills" data-openbitfun-part="groupOpen" />
          <span className="skill-groups__name"><OverflowText>{group.label}</OverflowText></span>
          <OverflowText lines={2} className="skill-groups__preview">{group.skills.length
            ? group.skills.map(skill => skill.name).join(' · ')
            : t(group.skillKeys.length ? 'groups.unresolvedMembers' : 'groups.emptyGroup')}</OverflowText>
        </div>
        <div className="skill-groups__meta" role="cell">
          <span>{t('groups.memberCount', { count: group.skillKeys.length })}</span>
          {catalogReady && !catalogIncomplete && group.unavailableSkillKeys.length > 0 && (
            <span>{t('groups.unavailableCount', { count: group.unavailableSkillKeys.length })}</span>
          )}
        </div>
        <div className="skill-groups__actions" role="cell" data-openbitfun-scene="skills" data-openbitfun-part="groupActions">
          {original
            ? <GroupActions label={t('groups.actions', { name: group.label })} items={items} disabled={busy} />
            : <Button size="sm" variant="text" disabled={busy} onClick={() => copy(group)}>{t('groups.copy')}</Button>}
        </div>
      </div>
    );
  };

  const renderSection = (label: string, sectionGroups: ResolvedSkillGroup[]) => (
    <section className="skill-groups__section" aria-label={label}>
      <div className="skill-groups__list" role="table" aria-label={label}
        data-openbitfun-scene="skills" data-openbitfun-part="groupTable">
        <div className="skill-groups__list-header" role="row"
          data-openbitfun-scene="skills" data-openbitfun-part="groupListHeader">
          <div className="skill-groups__list-heading" role="columnheader">
            <h2 className="skill-groups__section-title"><OverflowText>{label}</OverflowText></h2>
            <span className="skill-groups__count">{formatNumber(sectionGroups.length)}</span>
          </div>
          <span className="skill-groups__column-label" role="columnheader">{t('nav.title')}</span>
          <span className="skill-groups__column-label skill-groups__column-label--actions" role="columnheader">{t('list.columns.actions')}</span>
        </div>
        <div role="rowgroup">
          {sectionGroups.length ? sectionGroups.map(renderGroup) : (
            <div role="row">
              <div className="skill-groups__empty" role="cell" aria-colspan={3}>
                {t(normalizedQuery ? 'groups.noMatch' : 'groups.noGroups')}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );

  return (
    <div className="skill-groups" data-openbitfun-scene="skills" data-openbitfun-part="groups">
      <header className="skills-content-header" data-openbitfun-scene="skills" data-openbitfun-part="groupsHeader">
        <div className="skills-content-header__identity">
          <div className="skills-content-header__copy">
            <h2 className="skills-content-header__title"><OverflowText>{t('groups.title')}</OverflowText></h2>
            <p className="skills-content-header__description">{t('groups.subtitle')}</p>
          </div>
        </div>
        <Button size="sm" variant="primary" disabled={busy}
          onClick={() => { setActionError(null); setDraft({ group: { id: crypto.randomUUID(), name: '', skillKeys: [] }, original: null }); }}>
          {t('groups.create')}
        </Button>
      </header>
      <div className="skills-main__toolbar" data-openbitfun-scene="skills" data-openbitfun-part="toolbar">
        <IconButton aria-label={t('groups.refresh')} title={t('groups.refresh')} icon={<Icon name="refresh" />}
          size="sm" disabled={collection.saving || collection.loading || catalogLoading} onClick={onRefresh} />
      </div>
      {collection.loading && <LoadingState size="sm" role="status">{t('groups.loading')}</LoadingState>}
      {collection.error ? (
        <p role="alert" className="skill-groups__notice">{skillGroupErrorMessage(collection.error, t, 'load')}</p>
      ) : null}
      {actionError && <p role="alert" className="skill-groups__notice">{actionError}</p>}
      {!catalogLoading && (!catalogReady || catalogIncomplete) && (
        <p role="status" className="skill-groups__notice">{t('groups.catalogUnavailable')}</p>
      )}
      {collection.ready && (
        <ScrollArea className="skill-groups__sections" data-openbitfun-scene="skills" data-openbitfun-part="groupList">
          {renderSection(t('groups.myGroups'), userGroups)}
          {builtinGroups.length > 0 && renderSection(t('groups.builtinGroups'), builtinGroups)}
        </ScrollArea>
      )}
      {draft && (
        <SkillGroupEditor key={draft.group.id} draft={draft} skills={skills} catalogReady={catalogReady && !catalogIncomplete}
          saving={collection.saving} onClose={() => setDraft(null)} onCopy={() => copy(draft.group)}
          onSave={group => collection.updateGroups(current => saveUserSkillGroup(current, group, draft.original))} />
      )}
    </div>
  );
}
