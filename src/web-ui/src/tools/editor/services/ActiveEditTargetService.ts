import type * as monaco from 'monaco-editor';
import { createLogger } from '@/shared/utils/logger';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import {
  executeNativeEditAction,
  insertTextIntoElement,
  isMacOSDesktop,
  isWritableTextInput,
  readClipboardText,
} from '@/shared/utils/nativeTextEditing';

const log = createLogger('ActiveEditTargetService');

export type MacosEditMenuMode = 'system' | 'renderer';
export type EditMenuAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';
export type EditTargetKind = 'monaco' | 'markdown-ir' | 'markdown-textarea';

export interface EditTarget {
  id: string;
  kind: EditTargetKind;
  focus: () => void;
  hasTextFocus: () => boolean;
  undo: () => boolean;
  redo: () => boolean;
  cut?: () => boolean;
  copy?: () => boolean;
  paste?: () => boolean;
  selectAll?: () => boolean;
  /** Monaco: open the in-editor find widget (Ctrl/Cmd+F). */
  findInEditor?: () => boolean;
  containsElement?: (element: Element | null) => boolean;
}

const MENU_EVENT_ACTIONS: Array<{ eventName: string; action: EditMenuAction }> = [
  { eventName: 'openbitfun_menu_edit_undo', action: 'undo' },
  { eventName: 'openbitfun_menu_edit_redo', action: 'redo' },
  { eventName: 'openbitfun_menu_edit_cut', action: 'cut' },
  { eventName: 'openbitfun_menu_edit_copy', action: 'copy' },
  { eventName: 'openbitfun_menu_edit_paste', action: 'paste' },
  { eventName: 'openbitfun_menu_edit_select_all', action: 'selectAll' },
];

let monacoTargetCounter = 0;

export function createMonacoEditTarget(editor: monaco.editor.IStandaloneCodeEditor): EditTarget {
  const id = `monaco-${++monacoTargetCounter}`;

  return {
    id,
    kind: 'monaco',
    focus: () => {
      editor.focus();
    },
    hasTextFocus: () => editor.hasTextFocus(),
    undo: () => {
      editor.trigger('edit-target', 'undo', null);
      return true;
    },
    redo: () => {
      editor.trigger('edit-target', 'redo', null);
      return true;
    },
    cut: () => {
      editor.trigger('edit-target', 'editor.action.clipboardCutAction', null);
      return true;
    },
    copy: () => {
      editor.trigger('edit-target', 'editor.action.clipboardCopyAction', null);
      return true;
    },
    paste: () => {
      editor.trigger('edit-target', 'editor.action.clipboardPasteAction', null);
      return true;
    },
    selectAll: () => {
      editor.trigger('edit-target', 'editor.action.selectAll', null);
      return true;
    },
    findInEditor: () => {
      const findAction = editor.getAction('actions.find');
      if (findAction) {
        void findAction.run();
        return true;
      }
      editor.trigger('edit-target', 'editor.action.startFindWidget', null);
      return true;
    },
    containsElement: (element: Element | null) => {
      const domNode = editor.getDomNode();
      return !!domNode && !!element && domNode.contains(element);
    },
  };
}

export class ActiveEditTargetService {
  private activeTargetId: string | null = null;
  private targets = new Map<string, EditTarget>();
  private menuBridgePromise: Promise<void> | null = null;
  private lastRequestedMenuMode: MacosEditMenuMode | null = null;

  bindTarget(target: EditTarget): () => void {
    this.targets.set(target.id, target);
    void this.ensureMacOSMenuBridge();

    if (target.hasTextFocus()) {
      this.setActiveTarget(target.id);
    }

    return () => {
      this.unregisterTarget(target.id);
    };
  }

  setActiveTarget(targetId: string): void {
    if (!this.targets.has(targetId)) {
      return;
    }

    this.activeTargetId = targetId;
    void this.setMenuMode('renderer');
  }

  clearActiveTarget(targetId: string): void {
    if (this.activeTargetId !== targetId) {
      return;
    }

    this.activeTargetId = null;
    void this.setMenuMode('system');
  }

  /**
   * Open Monaco find in the currently focused code editor, if any.
   * Used by the editor shortcut scope (data-shortcut-scope="editor") via ShortcutManager.
   */
  openMonacoFind(): void {
    const focused = this.findFocusedTarget();
    if (focused?.findInEditor) {
      focused.findInEditor();
      return;
    }
    for (const target of this.targets.values()) {
      if (target.hasTextFocus() && target.findInEditor) {
        target.findInEditor();
        return;
      }
    }
  }

  executeAction(action: EditMenuAction): boolean {
    const focusedTarget = this.findFocusedTarget();
    if (focusedTarget) {
      focusedTarget.focus();

      if (action === 'paste') {
        const activeElement = document.activeElement;
        if (focusedTarget.containsElement?.(activeElement) && this.pasteIntoElement(activeElement)) {
          return true;
        }
      }

      if (this.dispatchToTarget(focusedTarget, action)) {
        return true;
      }

      if (action === 'cut' || action === 'copy' || action === 'selectAll') {
        const activeElement = document.activeElement;
        if (focusedTarget.containsElement?.(activeElement) && executeNativeEditAction(activeElement, action)) {
          return true;
        }
      }
    }

    const nativeElement = this.getFocusedNativeTextInput();
    if (action === 'paste' && this.pasteIntoElement(nativeElement)) {
      void this.setMenuMode('system');
      return true;
    }

    if (executeNativeEditAction(nativeElement, action)) {
      void this.setMenuMode('system');
      return true;
    }

    const target = this.getLastActiveTarget();
    if (target) {
      target.focus();

      if (action === 'paste') {
        const activeElement = document.activeElement;
        if (target.containsElement?.(activeElement) && this.pasteIntoElement(activeElement)) {
          return true;
        }
      }

      if (this.dispatchToTarget(target, action)) {
        return true;
      }

      if (action === 'cut' || action === 'copy' || action === 'selectAll') {
        const activeElement = document.activeElement;
        if (target.containsElement?.(activeElement) && executeNativeEditAction(activeElement, action)) {
          return true;
        }
      }
    }

    void this.setMenuMode(target ? 'renderer' : 'system');
    return false;
  }

  private pasteIntoElement(element: Element | null): boolean {
    if (!isWritableTextInput(element)) {
      return false;
    }

    void (async () => {
      const text = await readClipboardText();
      if (!text) {
        return;
      }

      insertTextIntoElement(element, text);
    })();

    return true;
  }

  private dispatchToTarget(target: EditTarget, action: EditMenuAction): boolean {
    switch (action) {
      case 'undo':
        return target.undo();
      case 'redo':
        return target.redo();
      case 'cut':
        return target.cut?.() ?? false;
      case 'copy':
        return target.copy?.() ?? false;
      case 'paste':
        return target.paste?.() ?? false;
      case 'selectAll':
        return target.selectAll?.() ?? false;
      default:
        return false;
    }
  }

  private getLastActiveTarget(): EditTarget | null {
    if (!this.activeTargetId) {
      return null;
    }

    const target = this.targets.get(this.activeTargetId);
    if (!target) {
      this.activeTargetId = null;
      return null;
    }

    return target;
  }

  private findFocusedTarget(): EditTarget | null {
    const activeTarget = this.getLastActiveTarget();
    if (activeTarget?.hasTextFocus()) {
      return activeTarget;
    }

    for (const target of this.targets.values()) {
      if (!target.hasTextFocus()) {
        continue;
      }

      if (this.activeTargetId !== target.id) {
        this.activeTargetId = target.id;
        void this.setMenuMode('renderer');
      }

      return target;
    }

    return null;
  }

  private getFocusedNativeTextInput(): HTMLElement | null {
    if (typeof document === 'undefined') {
      return null;
    }

    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) {
      return null;
    }

    if (this.isInsideRegisteredTarget(activeElement)) {
      return null;
    }

    return isWritableTextInput(activeElement) ? activeElement : null;
  }

  private isInsideRegisteredTarget(element: Element | null): boolean {
    if (!element) {
      return false;
    }

    for (const target of this.targets.values()) {
      if (target.containsElement?.(element)) {
        return true;
      }
    }

    return false;
  }

  private unregisterTarget(targetId: string): void {
    this.targets.delete(targetId);

    if (this.activeTargetId === targetId) {
      this.activeTargetId = null;
      void this.setMenuMode('system');
    }
  }

  private async ensureMacOSMenuBridge(): Promise<void> {
    if (!isMacOSDesktop()) {
      return;
    }

    if (this.menuBridgePromise) {
      return this.menuBridgePromise;
    }

    this.menuBridgePromise = (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        await Promise.all(
          MENU_EVENT_ACTIONS.map(async ({ eventName, action }) =>
            listen(eventName, () => {
              this.executeAction(action);
            }),
          ),
        );
      } catch (error) {
        log.warn('Failed to initialize macOS edit menu bridge', { error });
        this.menuBridgePromise = null;
      }
    })();

    return this.menuBridgePromise;
  }

  private async setMenuMode(mode: MacosEditMenuMode): Promise<void> {
    if (!isMacOSDesktop()) {
      return;
    }

    if (this.lastRequestedMenuMode === mode) {
      return;
    }

    this.lastRequestedMenuMode = mode;

    try {
      await systemAPI.setMacosEditMenuMode(mode);
    } catch (error) {
      if (this.lastRequestedMenuMode === mode) {
        this.lastRequestedMenuMode = null;
      }
      log.warn('Failed to switch macOS edit menu mode', { mode, error });
    }
  }
}

export const activeEditTargetService = new ActiveEditTargetService();
