
/**
 * Keyboard shortcut scope — determines when a shortcut is active.
 *
 * - 'app'      : always active within the application window (not input-focused by default)
 * - 'canvas'   : active when focus is inside the editor canvas (data-shortcut-scope="canvas")
 * - 'workbench-content': the main document view, independent of the side canvas
 * - 'editor'   : active when focus is inside the Monaco text surface (data-shortcut-scope="editor" inside canvas)
 * - 'chat'     : active when focus is inside the chat panel (data-shortcut-scope="chat")
 * - 'terminal' : active when focus is inside the integrated terminal
 * - 'filetree' : active when focus is inside the file tree panel
 * - 'git'      : active when focus is inside the git panel
 */
export type ShortcutScope = 'app' | 'canvas' | 'workbench-content' | 'chat' | 'editor' | 'terminal' | 'filetree' | 'git';

/**
 * Keyboard shortcut configuration (modifier + key + scope).
 * Used by ShortcutManager for global shortcut registration.
 */
export interface ShortcutConfig {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  /**
   * Scope in which this shortcut is active.
   * Defaults to 'app' if not specified.
   */
  scope?: ShortcutScope;
  /**
   * When true, the shortcut fires even when an input/textarea/contenteditable
   * element is focused. Defaults to false.
   */
  allowInInput?: boolean;
}
