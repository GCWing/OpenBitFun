import type { SceneTabId } from '@/app/components/SceneBar/types';

export interface ProjectResourceTarget {
  surfaceId: string;
  workspaceId: string;
}

const PREFIX = 'project-resources:';

export function projectResourceSceneId(target: ProjectResourceTarget): SceneTabId {
  return `${PREFIX}${encodeURIComponent(JSON.stringify([target.surfaceId, target.workspaceId]))}`;
}

export function parseProjectResourceTarget(id: string): ProjectResourceTarget | null {
  if (!id.startsWith(PREFIX)) return null;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(id.slice(PREFIX.length)));
    if (Array.isArray(value) && value.length === 2 && value.every(part => typeof part === 'string' && part.length > 0)) {
      return { surfaceId: value[0], workspaceId: value[1] };
    }
  } catch { /* Invalid destinations never fall back to the active workspace. */ }
  return null;
}
