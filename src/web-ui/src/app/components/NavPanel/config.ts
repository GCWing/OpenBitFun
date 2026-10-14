/**
 * NAV_SECTIONS — pure data config for NavPanel navigation.
 *
 * behavior:'contextual' → stays in current scene, updates AuxPane / inline section
 * behavior:'scene'      → opens / activates a SceneBar tab
 *
 * Section groups:
 *   - workspace: project workspace essentials (sessions, files)
 *   - assistant: assistant persona / nursery (profile)
 *   - ecosystem compatibility: footer More menu entry; catalogs live in Personal Overview
 */

import type { NavSection } from './types';

export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'assistants',
    label: 'Assistants',
    collapsible: false,
    items: [],
  },
  {
    id: 'workspace',
    label: 'Workspace',
    collapsible: false,
    items: [],
  },
];
