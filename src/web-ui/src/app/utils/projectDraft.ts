export interface ProjectFolder {
  path: string;
  remote?: { connectionId: string; connectionName: string; sshHost?: string };
}

export interface ProjectDraft {
  name: string;
  folders: ProjectFolder[];
  /** Target connection (SSH, Docker or WSL) when creating an empty project. */
  remote?: ProjectFolder['remote'];
}

export class AssistantProjectFolderError extends Error {
  constructor() {
    super('The selected folder belongs to an assistant workspace. Select a project folder instead.');
    this.name = 'AssistantProjectFolderError';
  }
}

export class ProjectDirectoryUnavailableError extends Error {
  constructor() {
    super('The target host did not provide an absolute home directory.');
    this.name = 'ProjectDirectoryUnavailableError';
  }
}

export const DEFAULT_PROJECT_SUBDIRECTORY = 'OpenBitFun/Projects';

/** Keep user projects outside the product's internal runtime storage. */
export function defaultProjectDirectory(home: string | null | undefined, remote = false): string {
  const path = remote ? home : home?.replace(/\\/g, '/');
  if (!path || !(path.startsWith('/') || (!remote && /^[a-z]:\//i.test(path)))) {
    throw new ProjectDirectoryUnavailableError();
  }
  return `${path.replace(/\/+$/, '')}/${DEFAULT_PROJECT_SUBDIRECTORY}`;
}

export function projectFolderKey(folder: ProjectFolder): string {
  const path = folder.path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return `${folder.remote?.connectionId ?? 'host'}\n${path}`;
}

export function projectFolderName(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || path;
}
