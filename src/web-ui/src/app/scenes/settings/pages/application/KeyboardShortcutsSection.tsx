/**
 * KeyboardShortcutsSection — view and remap keyboard shortcuts in one list.
 *
 * Features:
 * - One searchable list of actions
 * - Search filter by action name or key combination
 * - Click-to-record new key binding (capture mode)
 * - Real-time conflict detection (highlighted in red)
 * - Apply saves to configManager at path 'app.keybindings'
 * - Reset button restores all defaults
 */

import { Button, FieldGroup, Icon, IconButton, OverflowText, SearchField, Tooltip } from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import '@/app/scenes/settings/pages/application/KeyboardShortcutsSection.scss';
import {
  ConfigFieldStatus,
  ConfigPageRow,
  ConfigPageSection
} from '@/infrastructure/config/components/common';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { useSettingsDraft } from '@/infrastructure/config/settingsDraftRegistry';
import { confirmWarning } from '@/infrastructure/confirm-dialog';
import { useI18n } from '@/infrastructure/i18n';
import {
  buildStoredKeybindings,
  parseStoredKeybindings,
  shortcutManager,
  type KeybindingOverrides,
  type ShortcutRegistration,
} from '@/infrastructure/services/ShortcutManager';
import {
  ALL_SHORTCUTS,
  compareShortcutScope,
  getShortcutDescriptionI18nKey,
} from '@/shared/constants/shortcuts';
import type { ShortcutConfig } from '@/shared/types/shortcut';
import { createLogger } from '@/shared/utils/logger';
import { useSettingsSectionAnchor } from '../shared/useSettingsSectionAnchor';

const log = createLogger('KeyboardShortcutsSection');


/** SceneBar Alt+1–3: merged into one row in settings; not listed individually */
const MERGED_SCENE_FOCUS_IDS = new Set(['scene.focus1', 'scene.focus2', 'scene.focus3']);

/** Canvas tabs Mod+1–9: merged into one row in settings; not listed individually */
const MERGED_TAB_SWITCH_IDS = new Set([
  'tab.switch1',
  'tab.switch2',
  'tab.switch3',
  'tab.switch4',
  'tab.switch5',
  'tab.switch6',
  'tab.switch7',
  'tab.switch8',
  'tab.switchLast',
]);

const MERGED_SCENE_RECORD_ID = '__merged_scene__';
const MERGED_TAB_RECORD_ID = '__merged_tab__';

const SCENE_FOCUS_ORDER = ['scene.focus1', 'scene.focus2', 'scene.focus3'] as const;
const TAB_SWITCH_ORDER = [
  'tab.switch1',
  'tab.switch2',
  'tab.switch3',
  'tab.switch4',
  'tab.switch5',
  'tab.switch6',
  'tab.switch7',
  'tab.switch8',
  'tab.switchLast',
] as const;

/**
 * Merge live ShortcutManager registrations with the static catalog so the settings UI
 * lists every known shortcut even when no runtime useShortcut has registered yet.
 */
const SPECIAL_KEY_LABELS: Record<string, string> = {
  ' ': 'keyboard.keyLabels.space',
  Enter: 'keyboard.keyLabels.enter',
  Escape: 'keyboard.keyLabels.escape',
  Tab: 'keyboard.keyLabels.tab',
  Delete: 'keyboard.keyLabels.delete',
  Backspace: 'keyboard.keyLabels.backspace',
  ArrowUp: 'keyboard.keyLabels.arrowUp',
  ArrowDown: 'keyboard.keyLabels.arrowDown',
  ArrowLeft: 'keyboard.keyLabels.arrowLeft',
  ArrowRight: 'keyboard.keyLabels.arrowRight',
};

/** Key cap label: named keys are localized; other single chars stay upper-case. */
function formatShortcutKeyCap(key: string, t: (key: string) => string): string {
  const labelKey = SPECIAL_KEY_LABELS[key];
  if (labelKey) return t(labelKey);
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function mergeCatalogWithLive(live: ShortcutRegistration[]): ShortcutRegistration[] {
  const liveById = new Map(live.map((r) => [r.id, r]));
  const out: ShortcutRegistration[] = [];
  for (const def of ALL_SHORTCUTS) {
    const hit = liveById.get(def.id);
    if (hit) {
      out.push(hit);
      liveById.delete(def.id);
    } else {
      out.push({
        id: def.id,
        config: shortcutManager.getEffectiveConfig(def.id, def.config),
        callback: () => { },
        priority: 0,
        description: def.descriptionKey,
      });
    }
  }
  for (const r of liveById.values()) {
    out.push(r);
  }
  out.sort((a, b) => {
    const c = compareShortcutScope(a.config.scope, b.config.scope);
    if (c !== 0) {
      return c;
    }
    return b.priority - a.priority;
  });
  return out;
}

function captureDigit(e: KeyboardEvent): string | null {
  const code = e.code ?? '';
  const d = /^Digit([1-9])$/i.exec(code);
  if (d) return d[1];
  const n = /^Numpad([1-9])$/i.exec(code);
  if (n) return n[1];
  return null;
}

function modSignature(cfg: ShortcutConfig): string {
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');
  const primary = isMac ? Boolean(cfg.meta || cfg.ctrl) : Boolean(cfg.ctrl);
  return [primary ? '1' : '0', cfg.shift ? '1' : '0', cfg.alt ? '1' : '0'].join('');
}

function getEffectiveConfig(reg: ShortcutRegistration, pending?: PendingChange): ShortcutConfig {
  if (!pending) return reg.config;
  return {
    ...reg.config,
    key: pending.key,
    ctrl: pending.ctrl,
    shift: pending.shift,
    alt: pending.alt,
  };
}

function sceneGroupUniform(
  registrations: ShortcutRegistration[],
  pending: Record<string, PendingChange>
): boolean {
  const cfgs = SCENE_FOCUS_ORDER.map((id) => {
    const reg = registrations.find((r) => r.id === id);
    if (!reg) return null;
    return getEffectiveConfig(reg, pending[id]);
  });
  if (cfgs.some((c) => !c)) return false;
  const m0 = modSignature(cfgs[0]!);
  return (
    m0 === modSignature(cfgs[1]!) &&
    m0 === modSignature(cfgs[2]!) &&
    cfgs[0]!.key === '1' &&
    cfgs[1]!.key === '2' &&
    cfgs[2]!.key === '3'
  );
}

function tabGroupUniform(
  registrations: ShortcutRegistration[],
  pending: Record<string, PendingChange>
): boolean {
  const cfgs = TAB_SWITCH_ORDER.map((id) => {
    const reg = registrations.find((r) => r.id === id);
    if (!reg) return null;
    return getEffectiveConfig(reg, pending[id]);
  });
  if (cfgs.some((c) => !c)) return false;
  const m0 = modSignature(cfgs[0]!);
  for (let i = 0; i < 9; i++) {
    if (modSignature(cfgs[i]!) !== m0) return false;
    if (cfgs[i]!.key !== String(i + 1)) return false;
  }
  return true;
}

function formatModifierPrefix(cfg: ShortcutConfig): string {
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');
  const primary = isMac ? Boolean(cfg.meta || cfg.ctrl) : Boolean(cfg.ctrl);
  const parts: string[] = [];
  if (primary) parts.push(isMac ? '⌘' : 'Ctrl');
  if (cfg.shift) parts.push(isMac ? '⇧' : 'Shift');
  if (cfg.alt) parts.push(isMac ? '⌥' : 'Alt');
  return parts.join(isMac ? '' : '+');
}

function formatMergedRangeLabel(cfg: ShortcutConfig, range: '1–3' | '1–9'): string {
  const prefix = formatModifierPrefix(cfg);
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');
  if (!prefix) return range;
  return isMac ? `${prefix}${range}` : `${prefix}+${range}`;
}

interface PendingChange {
  id: string;
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

function shortcutModifierSignature(config: ShortcutConfig): string {
  const isMac = typeof navigator !== 'undefined'
    && navigator.platform.toUpperCase().includes('MAC');
  const primary = isMac ? Boolean(config.ctrl || config.meta) : Boolean(config.ctrl);
  const meta = isMac ? false : Boolean(config.meta);
  return [primary, config.shift, config.alt, meta].map(Boolean).map(Number).join('');
}

function shortcutConfigsConflict(left: ShortcutConfig, right: ShortcutConfig): boolean {
  const leftScope = left.scope ?? 'app';
  const rightScope = right.scope ?? 'app';
  const scopesOverlap = leftScope === rightScope || leftScope === 'app' || rightScope === 'app';
  return scopesOverlap
    && left.key.toLowerCase() === right.key.toLowerCase()
    && shortcutModifierSignature(left) === shortcutModifierSignature(right);
}

function buildFinalConflictMap(
  registrations: ShortcutRegistration[],
  pendingChanges: Record<string, PendingChange>,
): Map<string, ShortcutRegistration> {
  const finalRegistrations = registrations.map(registration => ({
    registration,
    config: getEffectiveConfig(registration, pendingChanges[registration.id]),
  }));
  const conflicts = new Map<string, ShortcutRegistration>();

  for (let leftIndex = 0; leftIndex < finalRegistrations.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < finalRegistrations.length;
      rightIndex += 1
    ) {
      const left = finalRegistrations[leftIndex];
      const right = finalRegistrations[rightIndex];
      if (!pendingChanges[left.registration.id] && !pendingChanges[right.registration.id]) {
        continue;
      }
      if (!shortcutConfigsConflict(left.config, right.config)) {
        continue;
      }
      if (!conflicts.has(left.registration.id)) {
        conflicts.set(left.registration.id, right.registration);
      }
      if (!conflicts.has(right.registration.id)) {
        conflicts.set(right.registration.id, left.registration);
      }
    }
  }
  return conflicts;
}

function firstConflictInGroup(
  ids: readonly string[],
  conflicts: Map<string, ShortcutRegistration>,
): ShortcutRegistration | null {
  for (const id of ids) {
    const conflict = conflicts.get(id);
    if (conflict) return conflict;
  }
  return null;
}

/** Human-readable label for settings list (always via settings namespace + catalog). */
function shortcutDisplayName(
  reg: ShortcutRegistration,
  t: (key: string) => string
): string {
  const i18nKey =
    getShortcutDescriptionI18nKey(reg.id) ??
    (reg.description?.startsWith('keyboard.') ? reg.description : undefined);
  if (i18nKey) {
    const text = t(i18nKey);
    if (text && text !== i18nKey) return text;
  }
  if (reg.description && !reg.description.startsWith('keyboard.')) {
    return reg.description;
  }
  return reg.id.replace(/[._]/g, ' ');
}

const KeyboardShortcutsSection: React.FC = () => {
  const { t } = useI18n('settings');
  const { t: tComponents } = useI18n('components');

  const [registrations, setRegistrations] = useState<ShortcutRegistration[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [pendingChanges, setPendingChanges] = useState<Record<string, PendingChange>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const recordingRef = useRef<string | null>(null);
  const saveInFlightRef = useRef(false);
  recordingRef.current = recordingId;

  // Live registrations from ShortcutManager (effects may register after first paint).
  const refreshRegistrations = useCallback(() => {
    setRegistrations(shortcutManager.getAllRegistrations());
  }, []);

  useEffect(() => {
    refreshRegistrations();
    return shortcutManager.subscribeRegistrationChanges(refreshRegistrations);
  }, [refreshRegistrations]);

  /** Full list for the UI: catalog + live, so every scope shows even before hooks register. */
  const displayRegistrations = useMemo(() => mergeCatalogWithLive(registrations), [registrations]);
  const finalConflicts = useMemo(
    () => buildFinalConflictMap(displayRegistrations, pendingChanges),
    [displayRegistrations, pendingChanges],
  );
  const hasBlockingConflicts = finalConflicts.size > 0;

  // Key capture during recording mode
  useEffect(() => {
    if (!recordingId) return;

    const handleCapture = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        setRecordingId(null);
        return;
      }

      const isMac = navigator.platform.toUpperCase().includes('MAC');
      const ctrl = isMac ? e.metaKey : e.ctrlKey;

      if (recordingId === MERGED_SCENE_RECORD_ID) {
        if (!captureDigit(e)) return;
        const next: Record<string, PendingChange> = {};
        for (let i = 0; i < SCENE_FOCUS_ORDER.length; i++) {
          const id = SCENE_FOCUS_ORDER[i];
          next[id] = {
            id,
            key: String(i + 1),
            ctrl,
            shift: e.shiftKey,
            alt: e.altKey,
          };
        }
        setPendingChanges((prev) => ({ ...prev, ...next }));
        setRecordingId(null);
        return;
      }

      if (recordingId === MERGED_TAB_RECORD_ID) {
        if (!captureDigit(e)) return;
        const next: Record<string, PendingChange> = {};
        for (let i = 0; i < TAB_SWITCH_ORDER.length; i++) {
          const id = TAB_SWITCH_ORDER[i];
          next[id] = {
            id,
            key: String(i + 1),
            ctrl,
            shift: e.shiftKey,
            alt: e.altKey,
          };
        }
        setPendingChanges((prev) => ({ ...prev, ...next }));
        setRecordingId(null);
        return;
      }

      // Skip modifier-only presses
      if (['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(e.key)) return;

      setPendingChanges((prev) => ({
        ...prev,
        [recordingId]: {
          id: recordingId,
          key: e.key,
          ctrl,
          shift: e.shiftKey,
          alt: e.altKey,
        },
      }));
      setRecordingId(null);
    };

    window.addEventListener('keydown', handleCapture, true);
    return () => window.removeEventListener('keydown', handleCapture, true);
  }, [recordingId]);

  // Apply all pending changes
  const handleApply = useCallback(async () => {
    if (saveInFlightRef.current) return false;
    if (hasBlockingConflicts) {
      return false;
    }
    saveInFlightRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      // 1. Read existing stored overrides so previous sessions' changes are not lost
      let existingOverrides: KeybindingOverrides = {};
      try {
        const raw = await configManager.getConfig('app.keybindings');
        existingOverrides = parseStoredKeybindings(raw);
      } catch {
        // First use — no stored overrides yet
      }

      // 2. Build overrides map from this session's pending changes
      const pendingOverrides: KeybindingOverrides = {};
      for (const [id, change] of Object.entries(pendingChanges)) {
        pendingOverrides[id] = {
          key: change.key,
          ...(change.ctrl ? { ctrl: true } : {}),
          ...(change.shift ? { shift: true } : {}),
          ...(change.alt ? { alt: true } : {}),
        };
      }

      // 3. Merge: pending changes override existing ones
      const merged: KeybindingOverrides = { ...existingOverrides, ...pendingOverrides };

      // 4. Prune overrides whose shortcut ID no longer exists in the catalog,
      //    preventing unbounded storage growth as shortcuts are added/removed.
      const knownIds = new Set(ALL_SHORTCUTS.map((d) => d.id));
      for (const id of Object.keys(merged)) {
        if (!knownIds.has(id)) delete merged[id];
      }

      // 5. Persist with versioned format + sync in-memory state
      await configManager.setConfig('app.keybindings', buildStoredKeybindings(merged));
      shortcutManager.loadUserOverrides(merged);
      setPendingChanges({});
      refreshRegistrations();
      return true;
    } catch (err) {
      log.error('Failed to save keybindings', err);
      setSaveError(t('keyboard.saveError'));
      return false;
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }, [hasBlockingConflicts, pendingChanges, refreshRegistrations, t]);

  // Reset all to defaults
  const handleReset = useCallback(async () => {
    if (saving) return;
    const confirmed = await confirmWarning(
      t('keyboard.resetConfirmTitle'),
      t('keyboard.resetConfirmMessage'),
    );
    if (!confirmed) return;

    setSaving(true);
    setSaveError(null);
    try {
      await configManager.setConfig('app.keybindings', buildStoredKeybindings({}));
      shortcutManager.loadUserOverrides({});
      setPendingChanges({});
      refreshRegistrations();
    } catch (err) {
      log.error('Failed to reset keybindings', err);
      setSaveError(t('keyboard.resetError'));
    } finally {
      setSaving(false);
    }
  }, [refreshRegistrations, saving, t]);

  // Format a key combination from a registration or pending change
  const formatKey = (reg: ShortcutRegistration, pending?: PendingChange): string => {
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    const cfg: ShortcutConfig = pending
      ? { ...reg.config, key: pending.key, ctrl: pending.ctrl, shift: pending.shift, alt: pending.alt }
      : reg.config;
    const parts: string[] = [];
    const primaryMod = isMac ? cfg.ctrl || cfg.meta : cfg.ctrl;
    if (primaryMod) parts.push(isMac ? '⌘' : 'Ctrl');
    if (cfg.shift) parts.push(isMac ? '⇧' : 'Shift');
    if (cfg.alt) parts.push(isMac ? '⌥' : 'Alt');
    parts.push(formatShortcutKeyCap(cfg.key, t));
    return parts.join(isMac ? '' : '+');
  };

  // Filter by search query (match translated action name or key combo)
  const visibleShortcuts = displayRegistrations.filter((registration) => {
    if (MERGED_SCENE_FOCUS_IDS.has(registration.id) || MERGED_TAB_SWITCH_IDS.has(registration.id)) return false;
    const query = searchQuery.trim().toLowerCase();
    return !query || shortcutDisplayName(registration, t).toLowerCase().includes(query)
      || registration.id.toLowerCase().includes(query)
      || formatKey(registration, pendingChanges[registration.id]).toLowerCase().includes(query);
  });

  /** Whether the merged SceneBar row matches the current search query */
  const mergedSceneRowVisible = useMemo(() => {
    const hasRegs = displayRegistrations.some((r) => MERGED_SCENE_FOCUS_IDS.has(r.id));
    if (!hasRegs) return false;
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    const hay = [
      t('keyboard.shortcuts.scene.focusMerged'),
      t('keyboard.shortcuts.scene.focusMergedHint'),
      t('keyboard.mergedNonUniform'),
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  }, [displayRegistrations, searchQuery, t]);

  /** Whether the merged canvas-tab row matches the current search query */
  const mergedTabSwitchRowVisible = useMemo(() => {
    const hasRegs = displayRegistrations.some((r) => MERGED_TAB_SWITCH_IDS.has(r.id));
    if (!hasRegs) return false;
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    const hay = [
      t('keyboard.shortcuts.tab.switchMerged'),
      t('keyboard.shortcuts.tab.switchMergedHint'),
      t('keyboard.mergedNonUniform'),
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  }, [displayRegistrations, searchQuery, t]);

  const mergedSceneKeyLabel = useMemo(() => {
    const firstId = SCENE_FOCUS_ORDER[0];
    const reg = displayRegistrations.find((r) => r.id === firstId);
    if (!reg) return t('keyboard.mergedNonUniform');
    if (!sceneGroupUniform(displayRegistrations, pendingChanges)) {
      return t('keyboard.mergedNonUniform');
    }
    const cfg = getEffectiveConfig(reg, pendingChanges[firstId]);
    return formatMergedRangeLabel(cfg, '1–3');
  }, [displayRegistrations, pendingChanges, t]);

  const mergedTabKeyLabel = useMemo(() => {
    const firstId = TAB_SWITCH_ORDER[0];
    const reg = displayRegistrations.find((r) => r.id === firstId);
    if (!reg) return t('keyboard.mergedNonUniform');
    if (!tabGroupUniform(displayRegistrations, pendingChanges)) {
      return t('keyboard.mergedNonUniform');
    }
    const cfg = getEffectiveConfig(reg, pendingChanges[firstId]);
    return formatMergedRangeLabel(cfg, '1–9');
  }, [displayRegistrations, pendingChanges, t]);

  const mergedSceneConflict = useMemo(
    () => firstConflictInGroup(SCENE_FOCUS_ORDER, finalConflicts),
    [finalConflicts],
  );

  const mergedTabConflict = useMemo(
    () => firstConflictInGroup(TAB_SWITCH_ORDER, finalConflicts),
    [finalConflicts],
  );

  const mergedScenePending = useMemo(
    () => SCENE_FOCUS_ORDER.some((id) => pendingChanges[id] !== undefined),
    [pendingChanges]
  );

  const mergedTabPending = useMemo(
    () => TAB_SWITCH_ORDER.some((id) => pendingChanges[id] !== undefined),
    [pendingChanges]
  );

  const hasAnyVisibleShortcut = mergedTabSwitchRowVisible || mergedSceneRowVisible || visibleShortcuts.length > 0;

  const hasPendingChanges = Object.keys(pendingChanges).length > 0;
  const discardPendingChanges = useCallback(() => {
    setPendingChanges({});
    setRecordingId(null);
    setSaveError(null);
  }, []);

  const sectionAnchor = useSettingsSectionAnchor('shortcuts', true);

  useSettingsDraft({
    id: 'keyboard-shortcuts',
    pageId: 'application.input',
    label: t('keyboard.title'),
    dirty: hasPendingChanges,
    saving,
    save: handleApply,
    discard: discardPendingChanges,
  });

  return (
    <div id={sectionAnchor} data-openbitfun-component="keyboard-shortcuts" data-openbitfun-part="root">
      <ConfigPageSection title={t('keyboard.title')} description={t('keyboard.description')} bodySurface={false}>
        {/* Search + actions bar */}
        <div className="kb-shortcuts__toolbar" data-openbitfun-component="keyboard-shortcuts" data-openbitfun-part="toolbar">
          <SearchField
            className="kb-shortcuts__search"
            data-openbitfun-component="keyboard-shortcuts"
            data-openbitfun-part="search"
            size="sm"
            value={searchQuery}
            onValueChange={setSearchQuery}
            leadingIcon={<Icon name="search" size="sm" aria-hidden />}
            placeholder={t('keyboard.search')}
            aria-label={t('keyboard.search')}
            clearLabel={searchQuery ? tComponents('search.clear') : undefined}
            onClear={searchQuery ? () => setSearchQuery('') : undefined}
          />
          <div className="kb-shortcuts__actions" data-openbitfun-component="keyboard-shortcuts" data-openbitfun-part="actions">
            {hasPendingChanges || saving || saveError ? (
              <ConfigFieldStatus
                status={saveError ? 'error' : saving ? 'saving' : 'unsaved'}
                message={saveError}
              />
            ) : null}
            {hasPendingChanges && (
              <Button
                variant="primary"
                size="sm"
                onClick={handleApply}
                disabled={saving || hasBlockingConflicts}
              >
                {saving ? t('keyboard.saving') : t('keyboard.apply')}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleReset}
              disabled={saving}
            >
              {t('keyboard.reset')}
            </Button>
          </div>
        </div>

        {hasBlockingConflicts && (
          <div role="alert" className="kb-shortcuts__error" data-openbitfun-component="keyboard-shortcuts" data-openbitfun-part="error">
            {t('keyboard.conflictBlocking')}
          </div>
        )}

        <FieldGroup appearance="subtle" fieldSurface="ambient" dividers={false}>
          <div className="kb-shortcuts__list" data-openbitfun-component="keyboard-shortcuts" data-openbitfun-part="list">
            {mergedTabSwitchRowVisible && (
              <ConfigPageRow
                align="center"
                data-openbitfun-component="keyboard-shortcuts"
                data-openbitfun-part="item"
                data-openbitfun-state={[
                  recordingId === MERGED_TAB_RECORD_ID && 'recording',
                  mergedTabConflict && 'conflict',
                  mergedTabPending && 'modified',
                ].filter(Boolean).join(' ') || undefined}
                className={[
                  'kb-shortcuts__item',
                  recordingId === MERGED_TAB_RECORD_ID ? 'kb-shortcuts__item--recording' : '',
                  mergedTabConflict ? 'kb-shortcuts__item--conflict' : '',
                  mergedTabPending ? 'kb-shortcuts__item--modified' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                key="tab-switch-merged"
                label={(
                  <OverflowText className="kb-shortcuts__item-name" data-openbitfun-component="keyboard-shortcuts" data-openbitfun-part="label">
                    {t('keyboard.shortcuts.tab.switchMerged')}
                  </OverflowText>
                )}
                description={(
                  <>
                    {t('keyboard.shortcuts.tab.switchMergedHint')}
                    {mergedTabConflict && (
                      <span className="kb-shortcuts__item-conflict-hint">
                        {t('keyboard.conflict')}: {shortcutDisplayName(mergedTabConflict, t)}
                      </span>
                    )}
                  </>
                )}
              >
                <div className="kb-shortcuts__item-key" data-openbitfun-component="keyboard-shortcuts" data-openbitfun-part="key">
                  <Tooltip content={t('keyboard.clickToRecord')} placement="top">
                    <Button
                      aria-pressed={recordingId === MERGED_TAB_RECORD_ID}
                      size="xs"
                      tone={mergedTabConflict ? 'danger' : 'neutral'}
                      variant={recordingId === MERGED_TAB_RECORD_ID ? 'primary' : 'outline'}
                      onClick={() =>
                        setRecordingId(recordingId === MERGED_TAB_RECORD_ID ? null : MERGED_TAB_RECORD_ID)
                      }
                    >
                      {recordingId === MERGED_TAB_RECORD_ID ? t('keyboard.recording') : mergedTabKeyLabel}
                    </Button>
                  </Tooltip>
                  {mergedTabPending && recordingId !== MERGED_TAB_RECORD_ID && (
                    <Tooltip content={t('keyboard.revertChange')} placement="top">
                      <IconButton
                        aria-label={t('keyboard.revertChange')}
                        icon="↩"
                        size="xs"
                        variant="quiet"
                        onClick={() => {
                          setPendingChanges((prev) => {
                            const next = { ...prev };
                            for (const id of TAB_SWITCH_ORDER) delete next[id];
                            return next;
                          });
                        }}
                      />
                    </Tooltip>
                  )}
                </div>
              </ConfigPageRow>
            )}
            {mergedSceneRowVisible && (
              <ConfigPageRow
                align="center"
                data-openbitfun-component="keyboard-shortcuts"
                data-openbitfun-part="item"
                data-openbitfun-state={[
                  recordingId === MERGED_SCENE_RECORD_ID && 'recording',
                  mergedSceneConflict && 'conflict',
                  mergedScenePending && 'modified',
                ].filter(Boolean).join(' ') || undefined}
                className={[
                  'kb-shortcuts__item',
                  recordingId === MERGED_SCENE_RECORD_ID ? 'kb-shortcuts__item--recording' : '',
                  mergedSceneConflict ? 'kb-shortcuts__item--conflict' : '',
                  mergedScenePending ? 'kb-shortcuts__item--modified' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                key="scene-focus-merged"
                label={(
                  <OverflowText className="kb-shortcuts__item-name" data-openbitfun-component="keyboard-shortcuts" data-openbitfun-part="label">
                    {t('keyboard.shortcuts.scene.focusMerged')}
                  </OverflowText>
                )}
                description={(
                  <>
                    {t('keyboard.shortcuts.scene.focusMergedHint')}
                    {mergedSceneConflict && (
                      <span className="kb-shortcuts__item-conflict-hint">
                        {t('keyboard.conflict')}: {shortcutDisplayName(mergedSceneConflict, t)}
                      </span>
                    )}
                  </>
                )}
              >
                <div className="kb-shortcuts__item-key" data-openbitfun-component="keyboard-shortcuts" data-openbitfun-part="key">
                  <Tooltip content={t('keyboard.clickToRecord')} placement="top">
                    <Button
                      aria-pressed={recordingId === MERGED_SCENE_RECORD_ID}
                      size="xs"
                      tone={mergedSceneConflict ? 'danger' : 'neutral'}
                      variant={recordingId === MERGED_SCENE_RECORD_ID ? 'primary' : 'outline'}
                      onClick={() =>
                        setRecordingId(recordingId === MERGED_SCENE_RECORD_ID ? null : MERGED_SCENE_RECORD_ID)
                      }
                    >
                      {recordingId === MERGED_SCENE_RECORD_ID ? t('keyboard.recording') : mergedSceneKeyLabel}
                    </Button>
                  </Tooltip>
                  {mergedScenePending && recordingId !== MERGED_SCENE_RECORD_ID && (
                    <Tooltip content={t('keyboard.revertChange')} placement="top">
                      <IconButton
                        aria-label={t('keyboard.revertChange')}
                        icon="↩"
                        size="xs"
                        variant="quiet"
                        onClick={() => {
                          setPendingChanges((prev) => {
                            const next = { ...prev };
                            for (const id of SCENE_FOCUS_ORDER) delete next[id];
                            return next;
                          });
                        }}
                      />
                    </Tooltip>
                  )}
                </div>
              </ConfigPageRow>
            )}
            {visibleShortcuts.map((reg) => {
              const pending = pendingChanges[reg.id];
              const isRecording = recordingId === reg.id;
              const conflict = finalConflicts.get(reg.id) ?? null;
              const displayName = shortcutDisplayName(reg, t);
              const formattedKey = formatKey(reg, pending);

              return (
                <ConfigPageRow
                  align="center"
                  data-openbitfun-component="keyboard-shortcuts"
                  data-openbitfun-part="item"
                  data-openbitfun-state={[
                    isRecording && 'recording',
                    conflict && 'conflict',
                    pending && 'modified',
                  ].filter(Boolean).join(' ') || undefined}
                  key={reg.id}
                  className={[
                    'kb-shortcuts__item',
                    isRecording ? 'kb-shortcuts__item--recording' : '',
                    conflict ? 'kb-shortcuts__item--conflict' : '',
                    pending ? 'kb-shortcuts__item--modified' : '',
                  ].filter(Boolean).join(' ')}
                  label={(
                    <OverflowText className="kb-shortcuts__item-name" data-openbitfun-component="keyboard-shortcuts" data-openbitfun-part="label">
                      {displayName}
                    </OverflowText>
                  )}
                  description={conflict ? (
                    <span className="kb-shortcuts__item-conflict-hint">
                      {t('keyboard.conflict')}: {shortcutDisplayName(conflict, t)}
                    </span>
                  ) : undefined}
                >
                  <div className="kb-shortcuts__item-key" data-openbitfun-component="keyboard-shortcuts" data-openbitfun-part="key">
                    <Tooltip content={t('keyboard.clickToRecord')} placement="top">
                      <Button
                        aria-pressed={isRecording}
                        size="xs"
                        tone={conflict ? 'danger' : 'neutral'}
                        variant={isRecording ? 'primary' : 'outline'}
                        onClick={() => setRecordingId(isRecording ? null : reg.id)}
                      >
                        {isRecording
                          ? t('keyboard.recording')
                          : formattedKey}
                      </Button>
                    </Tooltip>
                    {pending && !isRecording && (
                      <Tooltip content={t('keyboard.revertChange')} placement="top">
                        <IconButton
                          aria-label={t('keyboard.revertChange')}
                          icon="↩"
                          size="xs"
                          variant="quiet"
                          onClick={() => {
                            setPendingChanges((prev) => {
                              const next = { ...prev };
                              delete next[reg.id];
                              return next;
                            });
                          }}
                        />
                      </Tooltip>
                    )}
                  </div>
                </ConfigPageRow>
              );
            })}
          </div>

          {displayRegistrations.length > 0 && !hasAnyVisibleShortcut && (
            <div className="kb-shortcuts__empty" data-openbitfun-component="keyboard-shortcuts" data-openbitfun-part="empty">
              {t('keyboard.noResults')}
            </div>
          )}
        </FieldGroup>
      </ConfigPageSection>
    </div>
  );
};

export default KeyboardShortcutsSection;
