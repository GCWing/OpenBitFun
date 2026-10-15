/**
 * SceneBar type definitions.
 */

import type { ReactNode, SVGProps } from 'react';

export type SceneTabIconProps = Omit<SVGProps<SVGSVGElement>, 'ref'> & {
  size?: number | string;
};

/** SVG icon contract shared by design-system and third-party icon components. */
export type SceneTabIcon = (props: SceneTabIconProps) => ReactNode;

/** Scene tab identifier. Open scenes are kept until the user closes them. */
export type SceneTabId =
  | 'session'
  | 'terminal'
  | 'git'
  | 'settings'
  | 'file-viewer'
  | 'profile'
  | 'personal-overview'
  | 'agents'
  | 'skills'
  | 'ecosystem-compatibility'
  | 'miniapps'
  | 'pages'
  | 'browser'
  | 'assistant'
  | 'todos'
  | 'insights'
  | 'shell'
  | `content:${string}`
  | `session:${string}`
  | `miniapp:${string}`;

/** A tab owns a resource reference, never a copy of the runtime session. */
export interface SessionSceneTarget {
  surfaceId: string;
  workspaceKey: string;
  sessionId: string;
}

export function isSessionSceneId(id: string | null | undefined): boolean {
  return id === 'session' || Boolean(id?.startsWith('session:'));
}

/** Several workspace tabs share the one active-session presentation host. */
export function getSceneViewId(id: SceneTabId): SceneTabId {
  return isSessionSceneId(id) ? 'session' : id;
}

export function getSessionSceneTabId(target: SessionSceneTarget): SceneTabId {
  return `session:${encodeURIComponent(JSON.stringify([target.surfaceId, target.workspaceKey]))}`;
}

/** Static definition (from registry) for a scene tab type */
export interface SceneTabDef {
  id: SceneTabId;
  label: string;
  /** i18n key resolved through the common namespace, or an explicit namespace key such as shared:features.settings. */
  labelKey?: string;
  Icon?: SceneTabIcon;
  /** Keep this tab ahead of regular tabs while it is open. */
  pinned: boolean;
  /** If false, the user cannot close the tab. Defaults to true. */
  closable?: boolean;
  /** One presentation host; resource tabs may share that host. */
  singleton: boolean;
  /** Open on app start */
  defaultOpen: boolean;
}

/** Runtime instance of an open scene. */
export interface SceneTab {
  id: SceneTabId;
  /** Legacy tabs without a location open in the primary pane. */
  pane?: 'primary' | 'secondary';
  session?: SessionSceneTarget;
  /** Reference to content state; the tab never owns an editor buffer. */
  contentId?: string;
  /** User ordering preference; independent of closability. */
  pinned?: boolean;
  /** Last-used timestamp for activate/close fallback (e.g. which tab to activate after close). */
  lastUsed: number;
}
