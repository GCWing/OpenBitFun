/**
 * SCENE_TAB_REGISTRY — static definitions for all scene tab types.
 *
 * Rules:
 *  - Every explicitly opened scene remains open until the user closes it.
 *  - pinned = true: stays ahead of regular tabs while open.
 *  - closable = false: protected from manual close; pinning is independent.
 *  - Scene ids are unique, while Mini Apps use one id per app instance.
 */

import React from 'react';
import { Icon, type IconName } from '@openbitfun/ui';
import {
  CircleUserRound,
  House,
  Users,
  Boxes,
  PanelsTopLeft,
  BarChart3,
  CalendarClock,
  Cable,
} from 'lucide-react';
import type { SceneTabDef, SceneTabIcon, SceneTabId } from '../components/SceneBar/types';
import { getSceneViewId } from '../components/SceneBar/types';

function catalogSceneIcon(name: IconName): SceneTabIcon {
  return function CatalogSceneIcon() {
    return React.createElement(Icon, { name, size: 'lg', 'aria-hidden': true });
  };
}

export const SCENE_TAB_REGISTRY: SceneTabDef[] = [
  {
    id: 'personal-overview',
    label: 'Home',
    labelKey: 'nav.items.personalOverview',
    Icon: House,
    pinned: false,
    singleton: true,
    defaultOpen: false,
  },
  {
    id: 'session' as SceneTabId,
    label: 'Session',
    labelKey: 'scenes.aiAgent',
    Icon: catalogSceneIcon('session'),
    pinned: true,
    closable: true,
    singleton: true,
    defaultOpen: false,
  },
  {
    id: 'terminal' as SceneTabId,
    label: 'Terminal',
    Icon: catalogSceneIcon('terminal'),
    pinned: false,
    singleton: true,
    defaultOpen: false,
  },
  {
    id: 'git' as SceneTabId,
    label: 'Git',
    Icon: catalogSceneIcon('git'),
    pinned: false,
    singleton: true,
    defaultOpen: false,
  },
  {
    id: 'settings' as SceneTabId,
    label: 'Settings',
    labelKey: 'shared:features.settings',
    Icon: catalogSceneIcon('gear'),
    pinned: false,
    singleton: true,
    defaultOpen: false,
  },
  {
    id: 'profile' as SceneTabId,
    label: 'Profile',
    Icon: CircleUserRound,
    pinned: false,
    singleton: true,
    defaultOpen: false,
  },
  {
    id: 'agents' as SceneTabId,
    label: 'Agents',
    labelKey: 'scenes.agents',
    Icon: Users,
    pinned: false,
    singleton: true,
    defaultOpen: false,
  },
  {
    id: 'skills' as SceneTabId,
    label: 'Skills',
    labelKey: 'scenes.skills',
    Icon: catalogSceneIcon('extension'),
    pinned: false,
    singleton: true,
    defaultOpen: false,
  },
  {
    id: 'ecosystem-compatibility' as SceneTabId,
    label: 'External Import',
    labelKey: 'nav.items.ecosystemCompatibility',
    Icon: Cable,
    pinned: false,
    singleton: true,
    defaultOpen: false,
  },
  {
    id: 'miniapps' as SceneTabId,
    label: 'Mini App',
    labelKey: 'scenes.miniApps',
    Icon: Boxes,
    pinned: false,
    singleton: true,
    defaultOpen: false,
  },
  {
    id: 'pages' as SceneTabId,
    label: 'Pages',
    Icon: PanelsTopLeft,
    pinned: false,
    singleton: true,
    defaultOpen: false,
  },
  {
    id: 'browser' as SceneTabId,
    label: 'Browser',
    labelKey: 'scenes.browser',
    Icon: catalogSceneIcon('browser'),
    pinned: false,
    singleton: true,
    defaultOpen: false,
  },
  {
    id: 'assistant' as SceneTabId,
    label: 'Assistant',
    labelKey: 'scenes.assistant',
    Icon: catalogSceneIcon('user'),
    pinned: false,
    singleton: true,
    defaultOpen: false,
  },
  {
    id: 'todos' as SceneTabId,
    label: 'Task Board',
    labelKey: 'scenes.todos',
    Icon: CalendarClock,
    pinned: false,
    singleton: true,
    defaultOpen: false,
  },
  {
    id: 'insights' as SceneTabId,
    label: 'Insights',
    labelKey: 'scenes.insights',
    Icon: BarChart3,
    pinned: false,
    singleton: true,
    defaultOpen: false,
  },
  {
    id: 'shell' as SceneTabId,
    label: 'Shell',
    labelKey: 'scenes.shell',
    Icon: catalogSceneIcon('terminal'),
    pinned: false,
    singleton: true,
    defaultOpen: false,
  },
];

export function getSceneDef(id: SceneTabId): SceneTabDef | undefined {
  return SCENE_TAB_REGISTRY.find(d => d.id === getSceneViewId(id));
}

/** Shared closeability policy for the scene store and every tab interaction. */
export function isSceneTabClosable(def: SceneTabDef | undefined): boolean {
  return def !== undefined && def.closable !== false;
}

/** Dynamic scene def for a MiniApp tab (used by SceneBar and useSceneManager). */
export function getMiniAppSceneDef(appId: string, appName?: string): SceneTabDef {
  const id: SceneTabId = `miniapp:${appId}`;
  return {
    id,
    label: appName ?? appId,
    Icon: catalogSceneIcon('mini-app'),
    pinned: false,
    closable: true,
    singleton: false,
    defaultOpen: false,
  };
}
