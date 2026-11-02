import { Icon, OverflowText } from '@openbitfun/ui';
import type { ReactNode } from 'react';
import './ProjectFolderList.scss';

interface ProjectFolderListProps {
  label: string;
  children: ReactNode;
  scrollable?: boolean;
}

export function ProjectFolderList({ label, children, scrollable = false }: ProjectFolderListProps) {
  return (
    <ul className="project-folder-list" aria-label={label} data-scrollable={scrollable}
      data-openbitfun-component="project-folder-list" data-openbitfun-part="root">
      {children}
    </ul>
  );
}

interface ProjectFolderItemProps {
  name: string;
  path: string;
  leading?: ReactNode;
  actions?: ReactNode;
  editorId?: string;
  children?: ReactNode;
}

export function ProjectFolderItem({ name, path, leading, actions, children, editorId }: ProjectFolderItemProps) {
  return (
    <li className="project-folder-list__item" data-openbitfun-component="project-folder-list" data-openbitfun-part="item">
      <div className="project-folder-list__row">
        {leading ?? <Icon name="folder" size="sm" />}
        <div className="project-folder-list__info">
          <OverflowText className="project-folder-list__name">{name}</OverflowText>
          {path && <OverflowText className="project-folder-list__path" title={path}>{path}</OverflowText>}
        </div>
        {actions && <div className="project-folder-list__actions">{actions}</div>}
      </div>
      {children && <div className="project-folder-list__editor" id={editorId}>{children}</div>}
    </li>
  );
}
