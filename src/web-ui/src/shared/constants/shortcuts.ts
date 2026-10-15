
import type { ShortcutConfig, ShortcutScope } from '@/shared/types/shortcut';

/**
 * A complete shortcut definition: default key binding + metadata.
 * The `descriptionKey` is an i18n key under the 'settings' namespace.
 */
export interface ShortcutDef {
  id: string;
  config: ShortcutConfig;
  /** i18n key for the human-readable shortcut description */
  descriptionKey: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Build a ShortcutConfig using OpenBitFun's logical primary modifier.
 * ShortcutManager maps it to Ctrl on Windows/Linux and Command on macOS.
 */
function mod(
  key: string,
  extras: Omit<ShortcutConfig, 'key' | 'ctrl'> = {}
): ShortcutConfig {
  return { key, ctrl: true, ...extras };
}

// ─── Global shortcuts (scope: 'app') ──────────────────────────────────────
// These fire regardless of where focus is, including inside input elements
// (where allowInInput: true) or from any scene. Use sparingly — only for
// navigation and layout operations that must always be reachable.

export const APP_SHORTCUTS: ShortcutDef[] = [
  // Panel layout
  {
    id: 'panel.toggleLeft',
    config: mod('B', { scope: 'app' }),
    descriptionKey: 'keyboard.shortcuts.panel.toggleLeft',
  },
  {
    id: 'panel.toggleBoth',
    config: mod('B', { shift: true, scope: 'app' }),
    descriptionKey: 'keyboard.shortcuts.panel.toggleBoth',
  },

  // Scene quick-open — jump to a named scene from anywhere
  {
    id: 'scene.openSession',
    config: mod('A', { shift: true, scope: 'app', allowInInput: true }),
    descriptionKey: 'keyboard.shortcuts.scene.openSession',
  },
  {
    id: 'scene.openGit',
    config: mod('G', { shift: true, scope: 'app', allowInInput: true }),
    descriptionKey: 'keyboard.shortcuts.scene.openGit',
  },
  {
    id: 'scene.openSettings',
    config: mod(',', { scope: 'app', allowInInput: true }),
    descriptionKey: 'keyboard.shortcuts.scene.openSettings',
  },

  // Left nav: workspace / session quick search (Alt+F is handled in MainNav without a second catalog id)
  {
    id: 'nav.toggleSearch',
    config: mod('k', { scope: 'app', allowInInput: true }),
    descriptionKey: 'keyboard.shortcuts.nav.toggleSearch',
  },
  {
    id: 'scene.openTerminal',
    config: mod('`', { shift: true, scope: 'app', allowInInput: true }),
    descriptionKey: 'keyboard.shortcuts.scene.openTerminal',
  },

];

// ─── Scene-bar navigation (scope: 'app', allowInInput: true) ──────────────
// Alt+1–3: switch between the top-level scene tabs; merged into one row in
// settings. Kept separate from APP_SHORTCUTS so the UI can merge them.

export const SCENE_SHORTCUTS: ShortcutDef[] = [
  { id: 'scene.focus1', config: { key: '1', alt: true, scope: 'app', allowInInput: true }, descriptionKey: 'keyboard.shortcuts.scene.focusMerged' },
  { id: 'scene.focus2', config: { key: '2', alt: true, scope: 'app', allowInInput: true }, descriptionKey: 'keyboard.shortcuts.scene.focusMerged' },
  { id: 'scene.focus3', config: { key: '3', alt: true, scope: 'app', allowInInput: true }, descriptionKey: 'keyboard.shortcuts.scene.focusMerged' },
];

// ─── Editor canvas shortcuts (scope: 'canvas') ────────────────────────────
// Active only when focus is inside the editor canvas area
// (data-shortcut-scope="canvas"). Tab-switch shortcuts retain allowInInput
// so they continue to work while a Monaco editor is focused.

export const CANVAS_SHORTCUTS: ShortcutDef[] = [
  // View
  {
    id: 'canvas.missionControl',
    config: mod('Tab', { scope: 'canvas', allowInInput: true }),
    descriptionKey: 'keyboard.shortcuts.canvas.missionControl',
  },
  {
    id: 'canvas.splitHorizontal',
    config: mod('\\', { scope: 'canvas' }),
    descriptionKey: 'keyboard.shortcuts.canvas.splitHorizontal',
  },
  {
    id: 'canvas.splitVertical',
    config: mod('\\', { shift: true, scope: 'canvas' }),
    descriptionKey: 'keyboard.shortcuts.canvas.splitVertical',
  },
  {
    id: 'canvas.anchorZone',
    config: mod('`', { scope: 'canvas' }),
    descriptionKey: 'keyboard.shortcuts.canvas.anchorZone',
  },
  {
    id: 'canvas.maximize',
    config: mod('M', { shift: true, scope: 'canvas' }),
    descriptionKey: 'keyboard.shortcuts.canvas.maximize',
  },
  // Tab management
  {
    id: 'tab.close',
    config: mod('W', { scope: 'canvas', allowInInput: true }),
    descriptionKey: 'keyboard.shortcuts.tab.close',
  },
  {
    id: 'tab.reopenClosed',
    config: mod('T', { shift: true, scope: 'canvas', allowInInput: true }),
    descriptionKey: 'keyboard.shortcuts.tab.reopenClosed',
  },
  {
    id: 'tab.switch1',
    config: mod('1', { scope: 'canvas', allowInInput: true }),
    descriptionKey: 'keyboard.shortcuts.tab.switchMerged',
  },
  {
    id: 'tab.switch2',
    config: mod('2', { scope: 'canvas', allowInInput: true }),
    descriptionKey: 'keyboard.shortcuts.tab.switchMerged',
  },
  {
    id: 'tab.switch3',
    config: mod('3', { scope: 'canvas', allowInInput: true }),
    descriptionKey: 'keyboard.shortcuts.tab.switchMerged',
  },
  {
    id: 'tab.switch4',
    config: mod('4', { scope: 'canvas', allowInInput: true }),
    descriptionKey: 'keyboard.shortcuts.tab.switchMerged',
  },
  {
    id: 'tab.switch5',
    config: mod('5', { scope: 'canvas', allowInInput: true }),
    descriptionKey: 'keyboard.shortcuts.tab.switchMerged',
  },
  {
    id: 'tab.switch6',
    config: mod('6', { scope: 'canvas', allowInInput: true }),
    descriptionKey: 'keyboard.shortcuts.tab.switchMerged',
  },
  {
    id: 'tab.switch7',
    config: mod('7', { scope: 'canvas', allowInInput: true }),
    descriptionKey: 'keyboard.shortcuts.tab.switchMerged',
  },
  {
    id: 'tab.switch8',
    config: mod('8', { scope: 'canvas', allowInInput: true }),
    descriptionKey: 'keyboard.shortcuts.tab.switchMerged',
  },
  {
    id: 'tab.switchLast',
    config: mod('9', { scope: 'canvas', allowInInput: true }),
    descriptionKey: 'keyboard.shortcuts.tab.switchMerged',
  },
];

// ─── Monaco code surface (scope: 'editor') ────────────────────────────────
// Requires data-shortcut-scope="editor" on the Monaco host; active when the
// text surface is focused (innermost scope wins over canvas).

export const EDITOR_SHORTCUTS: ShortcutDef[] = [
  {
    id: 'editor.findInFile',
    config: mod('f', { scope: 'editor', allowInInput: true }),
    descriptionKey: 'keyboard.shortcuts.editor.findInFile',
  },
];

// ─── Chat shortcuts (scope: 'chat') ───────────────────────────────────────

export const CHAT_SHORTCUTS: ShortcutDef[] = [
  {
    id: 'btw-fill',
    config: { key: 'B', ctrl: true, alt: true, scope: 'chat', allowInInput: true },
    descriptionKey: 'keyboard.shortcuts.chat.btwFill',
  },
  {
    id: 'chat.stopGeneration',
    config: { key: 'Escape', scope: 'chat', allowInInput: true },
    descriptionKey: 'keyboard.shortcuts.chat.stopGeneration',
  },
  {
    id: 'chat.newSession',
    config: mod('N', { scope: 'chat' }),
    descriptionKey: 'keyboard.shortcuts.chat.newSession',
  },
  {
    id: 'chat.insertNewline',
    config: { key: 'Enter', ctrl: true, scope: 'chat', allowInInput: true },
    descriptionKey: 'keyboard.shortcuts.chat.insertNewline',
  },
];

// ─── File tree shortcuts (scope: 'filetree') ──────────────────────────────

export const FILETREE_SHORTCUTS: ShortcutDef[] = [
  {
    id: 'filetree.rename',
    config: { key: 'F2', scope: 'filetree' },
    descriptionKey: 'keyboard.shortcuts.filetree.rename',
  },
  {
    id: 'filetree.delete',
    config: { key: 'Delete', scope: 'filetree' },
    descriptionKey: 'keyboard.shortcuts.filetree.delete',
  },
  {
    id: 'filetree.refresh',
    config: { key: 'F5', scope: 'filetree' },
    descriptionKey: 'keyboard.shortcuts.filetree.refresh',
  },
  {
    id: 'filetree.newFile',
    config: mod('N', { scope: 'filetree' }),
    descriptionKey: 'keyboard.shortcuts.filetree.newFile',
  },
  {
    id: 'filetree.newFolder',
    config: mod('N', { shift: true, scope: 'filetree' }),
    descriptionKey: 'keyboard.shortcuts.filetree.newFolder',
  },
  {
    id: 'filetree.collapseAll',
    config: mod('[', { shift: true, scope: 'filetree' }),
    descriptionKey: 'keyboard.shortcuts.filetree.collapseAll',
  },
  {
    id: 'filetree.paste',
    config: mod('V', { scope: 'filetree' }),
    descriptionKey: 'keyboard.shortcuts.filetree.paste',
  },
];

// ─── Git shortcuts (scope: 'git') ─────────────────────────────────────────

export const GIT_SHORTCUTS: ShortcutDef[] = [
  {
    id: 'git.commit',
    config: mod('Enter', { scope: 'git', allowInInput: true }),
    descriptionKey: 'keyboard.shortcuts.git.commit',
  },
  {
    id: 'git.refresh',
    config: { key: 'F5', scope: 'git' },
    descriptionKey: 'keyboard.shortcuts.git.refresh',
  },
  {
    id: 'git.stageAll',
    config: mod('A', { shift: true, scope: 'git' }),
    descriptionKey: 'keyboard.shortcuts.git.stageAll',
  },
  {
    id: 'git.unstageAll',
    config: mod('U', { shift: true, scope: 'git' }),
    descriptionKey: 'keyboard.shortcuts.git.unstageAll',
  },
  {
    id: 'git.push',
    config: mod('P', { shift: true, scope: 'git' }),
    descriptionKey: 'keyboard.shortcuts.git.push',
  },
  {
    id: 'git.pull',
    config: mod('L', { shift: true, scope: 'git' }),
    descriptionKey: 'keyboard.shortcuts.git.pull',
  },
];

// ─── All shortcuts combined ────────────────────────────────────────────────

export const ALL_SHORTCUTS: ShortcutDef[] = [
  ...APP_SHORTCUTS,
  ...SCENE_SHORTCUTS,
  ...CANVAS_SHORTCUTS,
  ...EDITOR_SHORTCUTS,
  ...CHAT_SHORTCUTS,
  ...FILETREE_SHORTCUTS,
  ...GIT_SHORTCUTS,
];

/** Shortcuts registered in code but not listed in ALL_SHORTCUTS (e.g. legacy ids). */
const EXTRA_SHORTCUT_DESCRIPTION_KEYS: Record<string, string> = {};

/**
 * Resolve the i18n key (settings namespace) for a shortcut id.
 * Used by the keyboard settings UI so labels always match known definitions.
 */
export function getShortcutDescriptionI18nKey(id: string): string | undefined {
  const fromCatalog = ALL_SHORTCUTS.find((d) => d.id === id)?.descriptionKey;
  if (fromCatalog) return fromCatalog;
  return EXTRA_SHORTCUT_DESCRIPTION_KEYS[id];
}

/** Scope display order for the settings UI. */
export const SCOPE_ORDER: ShortcutScope[] = ['app', 'chat', 'editor', 'terminal', 'canvas', 'workbench-content', 'filetree', 'git'];

/** i18n keys for scope group labels in the settings UI. */
export const SCOPE_LABEL_KEYS: Record<ShortcutScope, string> = {
  app:      'keyboard.scopes.app',
  chat:     'keyboard.scopes.chat',
  editor:   'keyboard.scopes.editor',
  terminal: 'keyboard.scopes.terminal',
  canvas:   'keyboard.scopes.canvas',
  'workbench-content': 'keyboard.scopes.canvas',
  filetree: 'keyboard.scopes.filetree',
  git:      'keyboard.scopes.git',
};

/** Sort order for scope in settings UI and registration lists (ascending). */
export function compareShortcutScope(a: ShortcutScope | undefined, b: ShortcutScope | undefined): number {
  const ia = SCOPE_ORDER.indexOf(a ?? 'app');
  const ib = SCOPE_ORDER.indexOf(b ?? 'app');
  const sa = ia === -1 ? SCOPE_ORDER.length : ia;
  const sb = ib === -1 ? SCOPE_ORDER.length : ib;
  return sa - sb;
}
