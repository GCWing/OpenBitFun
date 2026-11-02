import { useId } from 'react';
import { ActionCard, Button, Icon, OverflowText, StatusPill, type ActionCardAction } from '@openbitfun/ui';
import { FolderCog, FolderOpen } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { isRemoteWorkspace, type WorkspaceInfo } from '@/shared/types';
import { ProjectResourceCards } from './ProjectResourceCards';

export function ProjectDirectoriesSection({ workspace, fileAccess, onBrowse, onManage, onAdd, onRemove, removingPath,
  canReveal, onReveal, revealingPath, error }: {
  workspace: WorkspaceInfo;
  fileAccess: boolean;
  onBrowse: () => void;
  onManage: () => void;
  onAdd: () => void;
  onRemove: (path: string) => void;
  removingPath: string | null;
  canReveal: boolean;
  onReveal: (path: string) => void;
  revealingPath: string | null;
  error: string | null;
}) {
  const { t } = useI18n('scenes/project-resources');
  const titleId = useId();
  const directories = [
    { path: workspace.rootPath, name: workspace.name, primary: true, description: undefined },
    ...(workspace.relatedPaths ?? []).map(directory => {
      const normalized = isRemoteWorkspace(workspace) ? directory.path : directory.path.replace(/\\/g, '/');
      return { ...directory, name: normalized.replace(/\/+$/, '').split('/').pop() || directory.path, primary: false };
    }),
  ];
  const hasRelatedDirectories = directories.length > 1;
  return <section className="project-resources__section" aria-labelledby={titleId}
    data-openbitfun-scene="project-resources" data-openbitfun-part="materials">
    <div className="project-resources__section-header">
      <h2 id={titleId}>{t('directories.title')}</h2>
      <div className="project-resources__section-actions">
        {hasRelatedDirectories && <Button className="project-resources__section-action" variant="text" size="sm"
          leadingIcon={<Icon name="plus" size="sm" />} disabled={!!removingPath} onClick={onAdd}>{t('directories.add')}</Button>}
        {hasRelatedDirectories && <span className="project-resources__action-divider" aria-hidden="true" />}
        <Button className="project-resources__section-action" variant="text" size="sm" leadingIcon={<Icon glyph={FolderCog} size="sm" />} disabled={!!removingPath} onClick={onManage}>{t('directories.manage')}</Button>
      </div>
    </div>
    <ProjectResourceCards label={t('directories.title')} previousLabel={t('directories.scrollPrevious')} nextLabel={t('directories.scrollNext')}
      resetKey={JSON.stringify([workspace.id, ...directories.map(directory => directory.path)])}>
      {directories.map((directory, index) => <li className="project-resource-cards__cell" key={`${index}:${directory.path}`}>
        <ActionCard className="project-resource-cards__card" triggerClassName="project-resource-cards__trigger" actionPlacement="floating"
            disabled={directory.primary ? !fileAccess : !!removingPath} onClick={directory.primary ? onBrowse : onManage}
            aria-label={t(directory.primary ? 'directories.openDirectory' : 'directories.editDirectory', { name: directory.name })}
            actions={[{ id: 'reveal', label: t('directories.revealDirectory', { name: directory.name }),
              tooltip: t(canReveal ? 'directories.reveal' : 'directories.revealUnavailable'),
              icon: <Icon glyph={FolderOpen} size="sm" />, disabled: !canReveal || !!revealingPath || !!removingPath,
              loading: revealingPath === directory.path, onClick: () => onReveal(directory.path) },
              ...(directory.primary ? [] : [{ id: 'remove', label: t('directories.removeDirectory', { name: directory.name }),
              icon: <Icon name="delete" size="sm" />, tone: 'danger', 'aria-haspopup': 'dialog',
              disabled: !!removingPath, loading: removingPath === directory.path, onClick: () => onRemove(directory.path) } satisfies ActionCardAction])]}
            body={<>
            <span className="project-resource-cards__icon" aria-hidden="true"><Icon name="folder" size="lg" /></span>
            <span className="project-resource-cards__copy">
              <OverflowText className="project-resource-cards__name">{directory.name}</OverflowText>
              <OverflowText className="project-resource-cards__path" title={directory.path}>{directory.path}</OverflowText>
              {directory.description && <OverflowText className="project-resource-cards__description">{directory.description}</OverflowText>}
              <span className="project-resource-cards__status"><StatusPill tone={directory.primary ? 'info' : 'neutral'}>
                {t(directory.primary ? 'directories.primary' : 'directories.related')}
              </StatusPill></span>
            </span>
            </>} />
      </li>)}
      {!hasRelatedDirectories && <li className="project-resource-cards__add">
        <Button variant="quiet" size="sm" leadingIcon={<Icon name="plus" size="sm" />} disabled={!!removingPath} onClick={onAdd}>{t('directories.add')}</Button>
      </li>}
    </ProjectResourceCards>
    {error && <p className="project-resources__error" role="alert">{error}</p>}
  </section>;
}
