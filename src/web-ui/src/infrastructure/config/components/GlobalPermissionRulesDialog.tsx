import {
  Button,
  FieldGroup,
  FormSection,
  Icon,
  IconButton,
  Input,
  Select,
  type SelectOption,
  Tooltip,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
} from '@openbitfun/ui';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  requestSettingsDraftExit,
  useSettingsDraft,
} from '@/infrastructure/config/settingsDraftRegistry';

import type { PermissionEffect, PermissionRule } from '../types';
import './GlobalPermissionRulesDialog.scss';

const GLOBAL_PERMISSION_ACTION_OPTIONS: SelectOption[] = [
  { value: '*', label: '*' },
  { value: 'read', label: 'read' },
  { value: 'edit', label: 'edit' },
  { value: 'bash', label: 'bash' },
  { value: 'git', label: 'git' },
  { value: 'websearch', label: 'websearch' },
  { value: 'webfetch', label: 'webfetch' },
  { value: 'task', label: 'task' },
  { value: 'skill', label: 'skill' },
  { value: 'mcp', label: 'mcp' },
  { value: 'computer_use', label: 'computer_use' },
  { value: 'custom_tool', label: 'custom_tool' },
  { value: 'external_directory', label: 'external_directory' },
];

const EFFECTS: PermissionEffect[] = ['allow', 'ask', 'deny'];
const RULE_EXIT_DURATION_MS = 120;
const REDUCED_MOTION_RULE_EXIT_DURATION_MS = 60;
const RULE_MOVE_DURATION_MS = 160;
const RULE_ENTER_DURATION_MS = 150;
const REDUCED_MOTION_ENTER_DURATION_MS = 70;
const RULE_MOTION_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
const MIN_RULE_SHIFT_PX = 0.5;

interface DraftRule extends PermissionRule {
  localId: string;
}

interface GlobalPermissionRulesDialogProps {
  isOpen: boolean;
  rules: PermissionRule[];
  isSaving: boolean;
  onSave: (rules: PermissionRule[]) => Promise<boolean>;
  onClose: () => void;
}

let draftRuleSequence = 0;

function toDraftRule(rule: PermissionRule): DraftRule {
  draftRuleSequence += 1;
  return { ...rule, localId: `global-rule-${draftRuleSequence}` };
}

function toPermissionRules(rules: DraftRule[]): PermissionRule[] {
  return rules.map(({ action, resource, effect }) => ({ action, resource, effect }));
}

function rulesEqual(left: PermissionRule[], right: PermissionRule[]): boolean {
  return left.length === right.length && left.every((rule, index) => {
    const other = right[index];
    return rule.action === other.action && rule.resource === other.resource && rule.effect === other.effect;
  });
}

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export const GlobalPermissionRulesDialog: React.FC<GlobalPermissionRulesDialogProps> = ({
  isOpen,
  rules,
  isSaving,
  onSave,
  onClose,
}) => {
  const { t } = useTranslation('settings/runtime');
  const [savedRules, setSavedRules] = useState<PermissionRule[]>([]);
  const [draftRules, setDraftRules] = useState<DraftRule[]>([]);
  const [exitingRuleIds, setExitingRuleIds] = useState<Set<string>>(() => new Set());
  const dialogRootRef = useRef<HTMLDivElement>(null);
  const ruleRowsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const rowAnimationsRef = useRef<Map<string, Animation>>(new Map());
  const removalTimersRef = useRef<Map<string, number>>(new Map());
  const exitingRuleIdsRef = useRef<Set<string>>(new Set());
  const pendingLayoutRectsRef = useRef<Map<string, DOMRect> | null>(null);
  const enteringRuleIdsRef = useRef<Set<string>>(new Set());
  const dialogSessionRef = useRef(0);
  const effectOptions = useMemo<SelectOption[]>(
    () => EFFECTS.map((effect) => ({
      value: effect,
      label: t(`permissionPolicy.globalRulesEffects.${effect}`),
    })),
    [t],
  );

  const cancelRowAnimations = useCallback(() => {
    rowAnimationsRef.current.forEach((animation) => animation.cancel());
    rowAnimationsRef.current.clear();
  }, []);

  const invalidatePendingRuleWork = useCallback(() => {
    dialogSessionRef.current += 1;
    removalTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    removalTimersRef.current.clear();
    pendingLayoutRectsRef.current = null;
    enteringRuleIdsRef.current.clear();
    cancelRowAnimations();
  }, [cancelRowAnimations]);

  useEffect(() => {
    invalidatePendingRuleWork();
    if (!isOpen) {
      // Keep the last rendered content stable while Modal retains it for exit.
      return;
    }
    exitingRuleIdsRef.current = new Set();
    setExitingRuleIds(new Set());
    setSavedRules(rules);
    setDraftRules(rules.map(toDraftRule));
  }, [invalidatePendingRuleWork, isOpen, rules]);

  useEffect(() => () => {
    invalidatePendingRuleWork();
  }, [invalidatePendingRuleWork]);

  const activeDraftRules = useMemo(
    () => draftRules.filter((rule) => !exitingRuleIds.has(rule.localId)),
    [draftRules, exitingRuleIds],
  );

  const activeRuleIndexes = useMemo(
    () => new Map(activeDraftRules.map((rule, index) => [rule.localId, index])),
    [activeDraftRules],
  );

  const permissionRules = useMemo(() => toPermissionRules(activeDraftRules), [activeDraftRules]);
  const rulesDirty = !rulesEqual(permissionRules, savedRules);
  const rulesValid = permissionRules.every((rule) => rule.action.trim() && rule.resource.trim());

  const updateDraftRule = (localId: string, update: Partial<PermissionRule>) => {
    if (exitingRuleIdsRef.current.has(localId)) {
      return;
    }
    setDraftRules((current) => current.map((rule) => (
      rule.localId === localId ? { ...rule, ...update } : rule
    )));
  };

  const captureLayoutRects = useCallback(() => {
    const nextRects = new Map<string, DOMRect>();
    ruleRowsRef.current.forEach((row, localId) => {
      if (!exitingRuleIdsRef.current.has(localId)) {
        nextRects.set(localId, row.getBoundingClientRect());
      }
    });
    cancelRowAnimations();
    pendingLayoutRectsRef.current = nextRects;
  }, [cancelRowAnimations]);

  const animateRow = useCallback((
    localId: string,
    row: HTMLDivElement,
    keyframes: Keyframe[],
    duration: number,
  ) => {
    if (typeof row.animate !== 'function') {
      return;
    }
    rowAnimationsRef.current.get(localId)?.cancel();
    const animation = row.animate(keyframes, {
      duration,
      easing: RULE_MOTION_EASING,
    });
    rowAnimationsRef.current.set(localId, animation);
    const forgetAnimation = () => {
      if (rowAnimationsRef.current.get(localId) === animation) {
        rowAnimationsRef.current.delete(localId);
      }
    };
    animation.onfinish = forgetAnimation;
    animation.oncancel = forgetAnimation;
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) {
      return;
    }

    const reduceMotion = prefersReducedMotion();
    const previousRects = pendingLayoutRectsRef.current;
    pendingLayoutRectsRef.current = null;
    if (previousRects && !reduceMotion) {
      previousRects.forEach((previousRect, localId) => {
        const row = ruleRowsRef.current.get(localId);
        if (!row || exitingRuleIdsRef.current.has(localId)) {
          return;
        }
        const nextRect = row.getBoundingClientRect();
        const deltaX = previousRect.left - nextRect.left;
        const deltaY = previousRect.top - nextRect.top;
        if (Math.abs(deltaX) < MIN_RULE_SHIFT_PX && Math.abs(deltaY) < MIN_RULE_SHIFT_PX) {
          return;
        }
        animateRow(localId, row, [
          { transform: `translate(${deltaX}px, ${deltaY}px)` },
          { transform: 'translate(0, 0)' },
        ], RULE_MOVE_DURATION_MS);
      });
    }

    enteringRuleIdsRef.current.forEach((localId) => {
      const row = ruleRowsRef.current.get(localId);
      if (!row) {
        return;
      }
      animateRow(
        localId,
        row,
        reduceMotion
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [
              { opacity: 0, transform: 'translateY(4px)' },
              { opacity: 1, transform: 'translateY(0)' },
            ],
        reduceMotion ? REDUCED_MOTION_ENTER_DURATION_MS : RULE_ENTER_DURATION_MS,
      );
    });
    enteringRuleIdsRef.current.clear();
  }, [animateRow, draftRules, isOpen]);

  const moveDraftRule = (localId: string, direction: -1 | 1) => {
    const currentIndex = activeRuleIndexes.get(localId);
    if (currentIndex === undefined) {
      return;
    }
    const nextIndex = currentIndex + direction;
    const targetRule = activeDraftRules[nextIndex];
    if (!targetRule) {
      return;
    }
    captureLayoutRects();
    setDraftRules((current) => {
      const nextRules = [...current];
      const sourcePosition = nextRules.findIndex((rule) => rule.localId === localId);
      const targetPosition = nextRules.findIndex((rule) => rule.localId === targetRule.localId);
      if (sourcePosition < 0 || targetPosition < 0) {
        return current;
      }
      [nextRules[sourcePosition], nextRules[targetPosition]] = [
        nextRules[targetPosition],
        nextRules[sourcePosition],
      ];
      return nextRules;
    });
  };

  const handleAddRule = () => {
    const nextRule = toDraftRule({ action: '', resource: '', effect: 'ask' });
    enteringRuleIdsRef.current.add(nextRule.localId);
    setDraftRules((current) => [...current, nextRule]);
  };

  const moveFocusAfterRemoval = (localId: string) => {
    const removedRow = ruleRowsRef.current.get(localId);
    if (!removedRow?.contains(document.activeElement)) {
      return;
    }
    const liveIds = activeDraftRules.map((rule) => rule.localId);
    const removedIndex = liveIds.indexOf(localId);
    const focusTargetId = liveIds[removedIndex + 1] ?? liveIds[removedIndex - 1];
    const focusTarget = focusTargetId
      ? ruleRowsRef.current
        .get(focusTargetId)
        ?.querySelector<HTMLButtonElement>('.global-permission-rules-dialog__rule-actions button:last-of-type')
      : dialogRootRef.current?.querySelector<HTMLButtonElement>(
        '[data-permission-add-rule]',
      );
    focusTarget?.focus();
  };

  const handleRemoveRule = (localId: string) => {
    if (isSaving || exitingRuleIdsRef.current.has(localId)) {
      return;
    }
    moveFocusAfterRemoval(localId);
    rowAnimationsRef.current.get(localId)?.cancel();
    rowAnimationsRef.current.delete(localId);

    const nextExitingIds = new Set(exitingRuleIdsRef.current);
    nextExitingIds.add(localId);
    exitingRuleIdsRef.current = nextExitingIds;
    setExitingRuleIds(nextExitingIds);

    const session = dialogSessionRef.current;
    const exitDuration = prefersReducedMotion()
      ? REDUCED_MOTION_RULE_EXIT_DURATION_MS
      : RULE_EXIT_DURATION_MS;
    const timer = window.setTimeout(() => {
      removalTimersRef.current.delete(localId);
      if (session !== dialogSessionRef.current || !exitingRuleIdsRef.current.has(localId)) {
        return;
      }
      captureLayoutRects();
      const remainingExitingIds = new Set(exitingRuleIdsRef.current);
      remainingExitingIds.delete(localId);
      exitingRuleIdsRef.current = remainingExitingIds;
      setExitingRuleIds(remainingExitingIds);
      setDraftRules((current) => current.filter((rule) => rule.localId !== localId));
    }, exitDuration);
    removalTimersRef.current.set(localId, timer);
  };

  const handleDiscard = () => {
    invalidatePendingRuleWork();
    exitingRuleIdsRef.current = new Set();
    setExitingRuleIds(new Set());
    setDraftRules(savedRules.map(toDraftRule));
  };

  const handleSave = async (): Promise<boolean> => {
    if (!rulesValid || isSaving) {
      return false;
    }
    const session = dialogSessionRef.current;
    const saved = await onSave(permissionRules);
    if (saved && session === dialogSessionRef.current) {
      setSavedRules(permissionRules);
    }
    return saved;
  };

  const requestClose = useCallback(() => {
    if (isSaving) return;
    requestSettingsDraftExit(['global-permission-rules'], onClose);
  }, [isSaving, onClose]);

  useSettingsDraft({
    id: 'global-permission-rules',
    pageId: 'ai.permissions',
    label: t('permissionPolicy.globalRulesDialogTitle'),
    dirty: isOpen && rulesDirty,
    saving: isSaving,
    save: handleSave,
    discard: handleDiscard,
  });

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isSaving) {
          requestClose();
        }
      }}
      size="xl"
    >
      <DialogHeader>
        <DialogHeading>
          <DialogTitle>{t('permissionPolicy.globalRulesDialogTitle')}</DialogTitle>
          <DialogDescription data-openbitfun-component="global-permission-rules-dialog" data-openbitfun-part="intro">
            {t('permissionPolicy.globalRulesDialogDescription')}
          </DialogDescription>
        </DialogHeading>
        <DialogClose disabled={isSaving} />
      </DialogHeader>
      <DialogBody>
        <div ref={dialogRootRef} className="global-permission-rules-dialog" data-openbitfun-component="global-permission-rules-dialog" data-openbitfun-part="root">
          <FormSection
            data-openbitfun-component="global-permission-rules-dialog"
            data-openbitfun-part="section"
            className="global-permission-rules-dialog__section"
            title={(
              <span data-openbitfun-component="global-permission-rules-dialog" data-openbitfun-part="sectionHeader">
                {t('permissionPolicy.globalRulesTitle')}
              </span>
            )}
            actions={(
              <Button
                size="sm"
                variant="fill"
                data-permission-add-rule
                disabled={isSaving}
                onClick={handleAddRule}
                leadingIcon={<Icon name="plus" size="sm" />}
              >
                {t('permissionPolicy.addGlobalRule')}
              </Button>
            )}
          >
            {draftRules.length === 0 ? (
              <FieldGroup>
                <div data-openbitfun-component="global-permission-rules-dialog" data-openbitfun-part="empty" className="global-permission-rules-dialog__empty">
                  {t('permissionPolicy.globalRulesEmpty')}
                </div>
              </FieldGroup>
            ) : (
              <FieldGroup
                appearance="subtle"
                dividers={false}
                data-openbitfun-component="global-permission-rules-dialog"
                data-openbitfun-part="rules"
                className="global-permission-rules-dialog__rules"
              >
                <div className="global-permission-rules-dialog__rule-heading" aria-hidden="true">
                  <span>{t('permissionPolicy.globalRulesEffect')}</span>
                  <span>{t('permissionPolicy.globalRulesAction')}</span>
                  <span>{t('permissionPolicy.globalRulesResource')}</span>
                  <span />
                </div>
                {draftRules.map((rule) => {
                  const exiting = exitingRuleIds.has(rule.localId);
                  const activeIndex = activeRuleIndexes.get(rule.localId);
                  return (
                    <div
                      ref={(row) => {
                        if (row) {
                          ruleRowsRef.current.set(rule.localId, row);
                        } else {
                          ruleRowsRef.current.delete(rule.localId);
                        }
                      }}
                      data-openbitfun-component="global-permission-rules-dialog"
                      data-openbitfun-part="rule"
                      data-rule-id={rule.localId}
                      data-exiting={exiting ? 'true' : 'false'}
                      aria-hidden={exiting || undefined}
                      {...(exiting ? { inert: '' } : {})}
                      key={rule.localId}
                      className="global-permission-rules-dialog__rule-row"
                    >
                      <Select
                        size="sm"
                        value={rule.effect}
                        options={effectOptions}
                        aria-label={t('permissionPolicy.globalRulesEffect')}
                        disabled={isSaving || exiting}
                        onValueChange={(value) => updateDraftRule(rule.localId, { effect: value as PermissionEffect })}
                      />
                      <Select
                        size="sm"
                        value={rule.action}
                        options={GLOBAL_PERMISSION_ACTION_OPTIONS}
                        placeholder={t('permissionPolicy.globalRulesAction')}
                        aria-label={t('permissionPolicy.globalRulesAction')}
                        disabled={isSaving || exiting}
                        invalid={!rule.action.trim()}
                        onValueChange={(value) => updateDraftRule(rule.localId, { action: value as string })}
                      />
                      <Input
                        value={rule.resource}
                        placeholder={t('permissionPolicy.globalRulesResourcePlaceholder')}
                        aria-label={t('permissionPolicy.globalRulesResource')}
                        disabled={isSaving || exiting}
                        invalid={!rule.resource.trim()}
                        onChange={(event) => updateDraftRule(rule.localId, { resource: event.target.value })}
                        size="sm"
                      />
                      <div data-openbitfun-component="global-permission-rules-dialog" data-openbitfun-part="ruleActions" className="global-permission-rules-dialog__rule-actions">
                        <Tooltip content={t('permissionPolicy.moveGlobalRuleUp')}>
                          <IconButton
                            type="button"
                            size="sm"
                            aria-label={t('permissionPolicy.moveGlobalRuleUp')}
                            disabled={isSaving || exiting || activeIndex === 0}
                            onClick={() => moveDraftRule(rule.localId, -1)}
                            icon={<Icon name="arrow-up" size="sm" />}
                          />
                        </Tooltip>
                        <Tooltip content={t('permissionPolicy.moveGlobalRuleDown')}>
                          <IconButton
                            type="button"
                            size="sm"
                            aria-label={t('permissionPolicy.moveGlobalRuleDown')}
                            disabled={
                              isSaving
                              || exiting
                              || activeIndex === undefined
                              || activeIndex === activeDraftRules.length - 1
                            }
                            onClick={() => moveDraftRule(rule.localId, 1)}
                            icon={<Icon name="arrow-down" size="sm" />}
                          />
                        </Tooltip>
                        <Tooltip content={t('permissionPolicy.removeGlobalRule')}>
                          <IconButton
                            type="button"
                            size="sm"
                            aria-label={t('permissionPolicy.removeGlobalRule')}
                            disabled={isSaving || exiting}
                            onClick={() => handleRemoveRule(rule.localId)}
                            icon={<Icon name="delete" size="sm" />}
                          />
                        </Tooltip>
                      </div>
                    </div>
                  );
                })}
              </FieldGroup>
            )}
          </FormSection>
        </div>
      </DialogBody>
      {rulesDirty ? (
        <DialogFooter data-openbitfun-component="global-permission-rules-dialog" data-openbitfun-part="footer">
          <Button
            type="button"
            variant="fill"
            onClick={handleDiscard}
            disabled={isSaving}
          >
            {t('permissionPolicy.discardGlobalRules')}
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={isSaving}
            disabled={!rulesValid || isSaving}
            onClick={() => void handleSave()}
            leadingIcon={<Save size={14} />}
          >
            {t('permissionPolicy.saveGlobalRules')}
          </Button>
        </DialogFooter>
      ) : null}
    </Dialog>
  );
};
