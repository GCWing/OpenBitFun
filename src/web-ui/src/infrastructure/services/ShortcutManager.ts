
import { hasOverlayLayers } from '@openbitfun/ui';
import type { ShortcutConfig, ShortcutScope } from '@/shared/types/shortcut';
import { compareShortcutScope } from '@/shared/constants/shortcuts';
import { createLogger } from '@/shared/utils/logger';
import { isImeOwnedKeyboardEvent } from '@/shared/utils/ime';

const log = createLogger('ShortcutManager');

export type ShortcutCallback = (event: KeyboardEvent) => void;

export interface ShortcutRegistration {
  id: string;
  config: ShortcutConfig;
  callback: ShortcutCallback;
  description?: string;
  priority: number;
}

/**
 * User-defined keybinding overrides stored in config (app.keybindings).
 * Maps shortcut id → partial ShortcutConfig (only key/modifier fields).
 */
export type KeybindingOverrides = Record<string, Pick<ShortcutConfig, 'key' | 'ctrl' | 'shift' | 'alt' | 'meta'>>;

// ─── Persistent storage utilities ─────────────────────────────────────────

export const KEYBINDINGS_STORAGE_VERSION = 1;

/** Versioned shape written to / read from config key `app.keybindings`. */
export interface StoredKeybindingsV1 {
  __version__: 1;
  overrides: KeybindingOverrides;
}

/**
 * Parse the raw value returned by configManager for `app.keybindings`.
 * Handles two formats:
 *   - V1 (current): { __version__: 1, overrides: { ... } }
 *   - Legacy (no version field): flat object treated as overrides directly
 * Unknown or malformed entries are silently skipped.
 */
export function parseStoredKeybindings(raw: unknown): KeybindingOverrides {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  if (obj.__version__ === 1 && obj.overrides && typeof obj.overrides === 'object') {
    return sanitizeOverrides(obj.overrides as Record<string, unknown>);
  }
  // Legacy format: no __version__ key → treat entire object as overrides map
  if (!('__version__' in obj)) {
    return sanitizeOverrides(obj);
  }
  return {};
}

/** Build the versioned object to write back to config storage. */
export function buildStoredKeybindings(overrides: KeybindingOverrides): StoredKeybindingsV1 {
  return { __version__: 1, overrides };
}

function sanitizeOverrides(raw: Record<string, unknown>): KeybindingOverrides {
  const result: KeybindingOverrides = {};
  for (const [id, val] of Object.entries(raw)) {
    if (id.startsWith('__') || !val || typeof val !== 'object') continue;
    const v = val as Record<string, unknown>;
    if (typeof v.key !== 'string' || !v.key) continue;
    result[id] = {
      key: v.key,
      ...(v.ctrl  ? { ctrl:  true } : {}),
      ...(v.shift ? { shift: true } : {}),
      ...(v.alt   ? { alt:   true } : {}),
      ...(v.meta  ? { meta:  true } : {}),
    };
  }
  return result;
}

/**
 * Compute the O(1) map key for a shortcut config.
 * Format: "{scope}:{key_lower}:{primary}{shift}{alt}{meta}"
 * Example: "app:]:1000"
 */
function makeMapKey(scope: ShortcutScope, config: ShortcutConfig): string {
  const normalized = normalizeShortcutConfig(config);
  const c = normalized.primary ? '1' : '0';
  const s = config.shift ? '1' : '0';
  const a = config.alt ? '1' : '0';
  const m = normalized.meta ? '1' : '0';
  return `${scope}:${config.key.toLowerCase()}:${c}${s}${a}${m}`;
}

function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');
}

function normalizeShortcutConfig(config: ShortcutConfig): { primary: boolean; meta: boolean } {
  if (isMacPlatform()) {
    return {
      primary: Boolean(config.ctrl || config.meta),
      meta: false,
    };
  }
  return {
    primary: Boolean(config.ctrl),
    meta: Boolean(config.meta),
  };
}

/**
 * Normalize which logical key was pressed for lookup.
 * Digit row: prefer `event.code` (Digit1–Digit9) so Ctrl+digit shortcuts work when `event.key`
 * differs by layout/browser; also support Numpad1–Numpad9.
 */
function eventKeyForLookup(event: KeyboardEvent): string {
  const code = event.code ?? '';
  const digit = /^Digit([1-9])$/.exec(code);
  if (digit) return digit[1];
  const numpad = /^Numpad([1-9])$/.exec(code);
  if (numpad) return numpad[1];
  // Keep in sync with makeMapKey: always lower-case logical key (Tab, escape, w, etc.)
  return event.key.toLowerCase();
}

/**
 * Compute the map key directly from a KeyboardEvent for lookup.
 */
function makeEventKey(scope: ShortcutScope, event: KeyboardEvent): string {
  const ctrl = isMacPlatform() ? event.metaKey : event.ctrlKey;
  const c = ctrl ? '1' : '0';
  const s = event.shiftKey ? '1' : '0';
  const a = event.altKey ? '1' : '0';
  const m = !isMacPlatform() && event.metaKey ? '1' : '0';
  return `${scope}:${eventKeyForLookup(event)}:${c}${s}${a}${m}`;
}

export class ShortcutManager {
  private static instance: ShortcutManager;

  /**
   * All registrations, keyed by shortcut id.
   */
  private registrations: Map<string, ShortcutRegistration & { defaultConfig: ShortcutConfig }> = new Map();

  /**
   * O(1) lookup index: mapKey → sorted registrations (descending priority).
   * Built incrementally on register/unregister.
   */
  private lookupMap: Map<string, ShortcutRegistration[]> = new Map();

  private keyDownHandler: ((e: KeyboardEvent) => void) | null = null;
  private isEnabled: boolean = true;

  /**
   * User overrides from configManager (id → key+modifiers).
   * Applied when a shortcut is registered or overrides are (re)loaded.
   */
  private userOverrides: KeybindingOverrides = {};

  /** Listeners notified whenever the registration set changes (for settings UI sync). */
  private registrationListeners: Set<() => void> = new Set();

  private constructor() {
    this.start();
  }

  public static getInstance(): ShortcutManager {
    if (!ShortcutManager.instance) {
      ShortcutManager.instance = new ShortcutManager();
    }
    return ShortcutManager.instance;
  }

  private start(): void {
    if (typeof window === 'undefined') return;
    if (this.keyDownHandler) return;
    this.keyDownHandler = this.handleKeyDown.bind(this);
    window.addEventListener('keydown', this.keyDownHandler, true);
  }

  public stop(): void {
    if (this.keyDownHandler && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.keyDownHandler, true);
      this.keyDownHandler = null;
    }
  }

  // ─── Registration ──────────────────────────────────────────────────────────

  public register(
    id: string,
    config: ShortcutConfig,
    callback: ShortcutCallback,
    options?: { description?: string; priority?: number }
  ): () => void {
    // Apply user override if present
    const effectiveConfig = this.applyOverride(id, config);

    const existing = this.registrations.get(id);
    if (existing) {
      this.removeFromLookupMap(existing);
    }

    const registration: ShortcutRegistration & { defaultConfig: ShortcutConfig } = {
      id,
      defaultConfig: { ...config },
      config: effectiveConfig,
      callback,
      description: options?.description,
      priority: options?.priority ?? 0,
    };

    this.registrations.set(id, registration);
    this.addToLookupMap(registration);
    this.notifyRegistrationListeners();

    return () => this.unregister(id);
  }

  public unregister(id: string): boolean {
    const registration = this.registrations.get(id);
    if (!registration) return false;
    this.removeFromLookupMap(registration);
    this.registrations.delete(id);
    this.notifyRegistrationListeners();
    return true;
  }

  // ─── Lookup map maintenance ────────────────────────────────────────────────

  private addToLookupMap(reg: ShortcutRegistration): void {
    const scope = reg.config.scope ?? 'app';
    const key = makeMapKey(scope, reg.config);
    const list = this.lookupMap.get(key) ?? [];
    list.push(reg);
    list.sort((a, b) => b.priority - a.priority);
    this.lookupMap.set(key, list);
  }

  private removeFromLookupMap(reg: ShortcutRegistration): void {
    const scope = reg.config.scope ?? 'app';
    const key = makeMapKey(scope, reg.config);
    const list = this.lookupMap.get(key);
    if (!list) return;
    const idx = list.indexOf(reg);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) {
      this.lookupMap.delete(key);
    }
  }

  // ─── Event handling ────────────────────────────────────────────────────────

  private handleKeyDown(event: KeyboardEvent): void {
    if (!this.isEnabled) return;
    if (event.defaultPrevented) return;
    if (this.isImeOwnedKey(event)) return;
    // The latest overlay owns Escape even if focus is still in its trigger.
    if (event.key === 'Escape' && hasOverlayLayers()) return;

    const inInput = this.isInputContext(event);
    const activeScope = this.detectScope(event.target);

    // Collect candidates: always check 'app' scope, plus active panel scope if different
    const candidates = this.findCandidates(event, activeScope, inInput);

    if (candidates.length === 0) return;

    // Candidates are already sorted: panel-scope first, then app-scope, then by priority
    const winner = candidates[0];
    try {
      event.preventDefault();
      event.stopPropagation();
      winner.callback(event);
    } catch (error) {
      log.error('Shortcut callback execution failed', { id: winner.id, error });
    }
  }

  private findCandidates(
    event: KeyboardEvent,
    activeScope: ShortcutScope,
    inInput: boolean
  ): ShortcutRegistration[] {
    const results: ShortcutRegistration[] = [];

    // Check app-scope registrations
    const appKey = makeEventKey('app', event);
    const appList = this.lookupMap.get(appKey) ?? [];
    for (const reg of appList) {
      if (inInput && !reg.config.allowInInput) continue;
      results.push(reg);
    }

    // Check panel-scope registrations (if inside a scoped panel)
    if (activeScope !== 'app') {
      // When the innermost scope is the Monaco editor surface, inherit canvas-registered
      // shortcuts (tab switch, close tab, etc.) in addition to editor-scoped ones.
      const panelScopes: ShortcutScope[] =
        activeScope === 'editor' ? (['editor', 'canvas'] as const) : [activeScope];
      const panelRegs: ShortcutRegistration[] = [];
      for (const scope of panelScopes) {
        for (const reg of this.lookupMap.get(makeEventKey(scope, event)) ?? []) {
          if (inInput && !reg.config.allowInInput) {
            continue;
          }
          panelRegs.push(reg);
        }
      }
      const seenId = new Set<string>();
      const deduped: ShortcutRegistration[] = [];
      for (const reg of panelRegs) {
        if (seenId.has(reg.id)) {
          continue;
        }
        seenId.add(reg.id);
        deduped.push(reg);
      }
      for (let i = deduped.length - 1; i >= 0; i--) {
        results.unshift(deduped[i]);
      }
    }

    // Deduplicate (panel-scope items inserted at front may repeat)
    const seen = new Set<string>();
    return results.filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
  }

  /**
   * Detect the active shortcut scope by walking up the DOM from the event target.
   * Returns the innermost known data-shortcut-scope value, or 'app' as fallback.
   */
  private detectScope(target: EventTarget | null): ShortcutScope {
    if (!target || !(target instanceof Element)) return 'app';
    const el = target.closest('[data-shortcut-scope]');
    const scope = el?.getAttribute('data-shortcut-scope') as ShortcutScope | null;
    // Only accept known panel scopes; canvas is included so canvas-scoped shortcuts
    // fire only when focus is inside the editor canvas area.
    if (scope === 'canvas' || scope === 'editor' || scope === 'chat' || scope === 'terminal' || scope === 'filetree' || scope === 'git') {
      return scope;
    }
    return 'app';
  }

  private isImeOwnedKey(event: KeyboardEvent): boolean {
    return (event.key === 'Escape' || event.key === 'Enter')
      && isImeOwnedKeyboardEvent(event);
  }

  /**
   * Determine whether the current event originates from an input context.
   * Monaco editor is explicitly excluded (it manages its own keybindings).
   */
  private isInputContext(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement | null;
    if (!target) return false;

    // Monaco editor — not treated as a generic input context
    if (
      target.classList.contains('monaco-editor') ||
      target.classList.contains('inputarea') ||
      target.closest('.monaco-editor') !== null
    ) {
      return false;
    }

    const tag = target.tagName.toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag)) {
      const style = window.getComputedStyle(target);
      if (style.display !== 'none' && style.visibility !== 'hidden') return true;
    }

    if (
      target.classList.contains('openbitfun-chat-input') ||
      target.classList.contains('rich-text-input') ||
      target.closest('.openbitfun-chat-input') !== null ||
      target.closest('.rich-text-input') !== null
    ) {
      return true;
    }

    if (target.isContentEditable) return true;

    return false;
  }

  // ─── User overrides ────────────────────────────────────────────────────────

  /**
   * Load user keybinding overrides from config storage.
   * Existing registrations are re-indexed with the new effective configs.
   * Call this once on app startup and again whenever configManager fires a change.
   */
  public loadUserOverrides(overrides: KeybindingOverrides): void {
    this.userOverrides = overrides ?? {};

    // Re-apply overrides to all existing registrations
    for (const [id, registration] of this.registrations.entries()) {
      const newConfig = this.applyOverride(id, registration.defaultConfig);
      this.removeFromLookupMap(registration);
      registration.config = newConfig;
      this.addToLookupMap(registration);
    }

    log.debug('User keybinding overrides loaded', { count: Object.keys(this.userOverrides).length });
    this.notifyRegistrationListeners();
  }

  /**
   * Effective config for a shortcut id (catalog default merged with user overrides).
   * Used by the keyboard settings UI for shortcuts not yet registered at runtime.
   */
  public getEffectiveConfig(id: string, catalogDefault: ShortcutConfig): ShortcutConfig {
    return this.applyOverride(id, catalogDefault);
  }

  private applyOverride(id: string, config: ShortcutConfig): ShortcutConfig {
    const override = this.userOverrides[id];
    if (!override) return config;
    // Stored overrides only persist truthy modifiers. Shallow merge would keep
    // catalog ctrl/meta when the user clears them (e.g. Alt+Q must not stay Ctrl+Alt+Q).
    return {
      ...config,
      key: override.key,
      ctrl: !!override.ctrl,
      shift: !!override.shift,
      alt: !!override.alt,
      meta: !!override.meta,
    };
  }

  /** Subscribe to registration / override changes. Used to refresh the shortcuts settings list. */
  public subscribeRegistrationChanges(listener: () => void): () => void {
    this.registrationListeners.add(listener);
    return () => {
      this.registrationListeners.delete(listener);
    };
  }

  private notifyRegistrationListeners(): void {
    for (const fn of this.registrationListeners) {
      try {
        fn();
      } catch (e) {
        log.error('registration listener failed', { error: e });
      }
    }
  }

  // ─── Introspection ─────────────────────────────────────────────────────────

  /**
   * Returns all current registrations for display in the settings UI.
   * Returned array is sorted by scope then priority (descending).
   */
  public getAllRegistrations(): ShortcutRegistration[] {
    return Array.from(this.registrations.values()).sort((a, b) => {
      const c = compareShortcutScope(a.config.scope, b.config.scope);
      if (c !== 0) {
        return c;
      }
      return b.priority - a.priority;
    });
  }

  /**
   * Check whether a given config conflicts with registered shortcuts in the same scope
   * or with app-scope shortcuts. App-scope shortcuts are active globally inside OpenBitFun,
   * so they can shadow or be shadowed by scoped shortcuts.
   * Used by the settings UI for real-time conflict detection.
   */
  public checkConflicts(config: ShortcutConfig, excludeId?: string, excludeIds?: string[]): ShortcutRegistration[] {
    const scope = config.scope ?? 'app';
    const scopesToCheck: ShortcutScope[] = scope === 'app'
      ? ['app', 'chat', 'editor', 'terminal', 'canvas', 'filetree', 'git']
      : [scope, 'app'];
    const seen = new Set<string>();
    const list: ShortcutRegistration[] = [];
    for (const candidateScope of scopesToCheck) {
      for (const reg of this.lookupMap.get(makeMapKey(candidateScope, config)) ?? []) {
        if (seen.has(reg.id)) continue;
        seen.add(reg.id);
        list.push(reg);
      }
    }
    const exclude = new Set<string>([...(excludeIds ?? [])]);
    if (excludeId) exclude.add(excludeId);
    return exclude.size ? list.filter((r) => !exclude.has(r.id)) : [...list];
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  public formatShortcut(config: ShortcutConfig): string {
    const isMac = isMacPlatform();
    const normalized = normalizeShortcutConfig(config);
    const parts: string[] = [];
    if (normalized.primary) parts.push(isMac ? '⌘' : 'Ctrl');
    if (config.shift) parts.push(isMac ? '⇧' : 'Shift');
    if (config.alt) parts.push(isMac ? '⌥' : 'Alt');
    if (!isMac && normalized.meta) parts.push('Meta');
    const key = config.key === ' ' ? 'Space' : config.key.length === 1 ? config.key.toUpperCase() : config.key;
    parts.push(key);
    return parts.join(isMac ? '' : '+');
  }

  public parseShortcut(shortcut: string): Omit<ShortcutConfig, 'scope' | 'allowInInput'> | null {
    const parts = shortcut.split('+').map((s) => s.trim().toLowerCase());
    if (parts.length === 0) return null;
    const key = parts[parts.length - 1];
    return {
      key,
      ctrl: parts.includes('ctrl') || parts.includes('cmd') || parts.includes('mod'),
      shift: parts.includes('shift'),
      alt: parts.includes('alt'),
      meta: parts.includes('meta'),
    };
  }

  public setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
  }

  public isShortcutEnabled(): boolean {
    return this.isEnabled;
  }

  public clear(): void {
    this.registrations.clear();
    this.lookupMap.clear();
    this.notifyRegistrationListeners();
  }
}

export const shortcutManager = ShortcutManager.getInstance();
