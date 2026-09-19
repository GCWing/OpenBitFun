import { HARNESS_IDS, canonicalAgentId, type HarnessId } from '@/shared/agents/identity';
import { HARNESS_PRESENTATION } from '@/shared/agents/harnessPresentation';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { subscribeOverlayInteraction, createOverlayPortal, OverflowText, Icon, Menu, MenuItem, MenuSection, MenuSeparator, Tooltip } from '@openbitfun/ui';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { confirmDialog } from '@/infrastructure/confirm-dialog';
import { notificationService } from '@/shared/notification-system';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import { useSideAnchoredPopoverPosition } from '@/shared/utils/useSideAnchoredPopoverPosition';
import './HarnessProfileSelector.scss';

export type HarnessProfileId = KnownHarnessProfileId | (string & {});
/** Includes the existing Agent submenu, which is navigation rather than an identity. */
export type KnownHarnessProfileId = HarnessId | 'other';
export type SelectableHarnessProfileId = HarnessId;

export interface HarnessAgentOption {
  id: string;
  name: string;
  available?: boolean;
}

export type HarnessNewSessionSelection =
  | { kind: 'profile'; id: SelectableHarnessProfileId }
  | { kind: 'agent'; id: string };

export type HarnessProfileSelectorPresentation = 'standalone' | 'menu-item';

interface HarnessProfileSelectorProps {
  /** Session still runs a legacy fixed mode and cannot switch. */
  legacySession?: boolean;
  /** The Session has accepted its first runtime Turn, so Harness and main Agent are fixed. */
  sessionStarted?: boolean;
  selectedProfile: HarnessProfileId;
  selectedAgentId?: string;
  otherAgents?: HarnessAgentOption[];
  disabled?: boolean;
  /**
   * `standalone` anchors the picker to its own floating trigger. `menu-item`
   * turns that trigger into a row inside a parent action menu and opens the
   * secondary picker beside it in the shared overlay layer.
   */
  presentation?: HarnessProfileSelectorPresentation;
  /** A parent menu can coordinate this flyout with its sibling submenus. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSelectProfile: (profileId: SelectableHarnessProfileId) => void | Promise<void>;
  onSelectAgent?: (agentId: string) => void | Promise<void>;
  onStartNewSession?: (
    selection: HarnessNewSessionSelection,
  ) => void | Promise<void>;
  /** Lets a parent action menu close after a terminal selection. */
  onSelectionComplete?: () => void;
}

const PROFILE_IDS: KnownHarnessProfileId[] = [...HARNESS_IDS, 'other'];
type DensityHarnessProfileId = 'Minimal' | 'Standard' | 'Ultimate';

function isDensityProfile(profile: KnownHarnessProfileId): profile is DensityHarnessProfileId {
  return profile === 'Minimal' || profile === 'Standard' || profile === 'Ultimate';
}

function isSelectableProfile(
  profile: KnownHarnessProfileId,
): profile is SelectableHarnessProfileId {
  return isDensityProfile(profile) || profile === 'Creative';
}

function sameAgent(left: string | null | undefined, right: string | null | undefined): boolean {
  return canonicalAgentId(left?.trim() ?? '').toLowerCase() === canonicalAgentId(right?.trim() ?? '').toLowerCase();
}

/** Menu rows and the compact add-menu trigger share one mode mark. */
function HarnessProfileMark({
  profile,
}: {
  profile: KnownHarnessProfileId;
}): React.ReactElement {
  const densityProfile = isDensityProfile(profile) ? profile : undefined;

  return (
    <span
      className="openbitfun-harness-selector__density-mark"
      data-harness-profile={profile}
      data-harness-density={densityProfile ? HARNESS_PRESENTATION[densityProfile].gear : 0}
      aria-hidden
    >
      {profile === 'other' ? (
        <Icon
          name="user"
          className="openbitfun-harness-selector__density-frame"
          size="md"
        />
      ) : (
        <Icon
          name={HARNESS_PRESENTATION[profile].icon}
          className="openbitfun-harness-selector__density-frame"
          size="md"
        />
      )}
    </span>
  );
}

/**
 * Before the first Turn this is the Session execution picker. Afterwards it
 * becomes a lightweight Session signature whose menu choices ask for
 * confirmation before starting a new Session. ChatInput presents the
 * signature as a disclosure row inside its add menu; other consumers may keep
 * the standalone trigger.
 */
export const HarnessProfileSelector: React.FC<HarnessProfileSelectorProps> = ({
  legacySession = false,
  sessionStarted = false,
  selectedProfile,
  selectedAgentId,
  otherAgents = [],
  disabled = false,
  presentation = 'standalone',
  open: controlledOpen,
  onOpenChange,
  onSelectProfile,
  onSelectAgent,
  onStartNewSession,
  onSelectionComplete,
}) => {
  const { t } = useTranslation('flow-chat');
  const fixedSession = legacySession || sessionStarted;
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = useCallback((nextOpen: boolean) => {
    if (controlledOpen === undefined) setLocalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }, [controlledOpen, onOpenChange]);
  const [page, setPage] = useState<'profiles' | 'agents'>('profiles');
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuLayout = useAnchoredPopoverPosition({
    open: open && presentation === 'standalone',
    anchorRef: triggerRef,
    popoverRef: menuRef,
    preferredPlacement: 'top',
    alignment: 'start',
    gap: 8,
    layoutRevision: `${fixedSession ? 1 : 0}:${page}:${otherAgents.length}`,
  });
  const sideMenuLayout = useSideAnchoredPopoverPosition({
    open: open && presentation === 'menu-item',
    anchorRef: triggerRef,
    popoverRef: menuRef,
    layoutRevision: `${fixedSession ? 1 : 0}:${page}:${otherAgents.length}`,
  });

  const close = useCallback(() => {
    setOpen(false);
    setPage('profiles');
  }, [setOpen]);

  const finishSelection = useCallback(() => {
    close();
    onSelectionComplete?.();
  }, [close, onSelectionComplete]);

  const confirmNewSession = useCallback(async (
    selection: HarnessNewSessionSelection,
    targetName: string,
  ) => {
    finishSelection();
    const confirmed = await confirmDialog({
      title: t('chatInput.harness.newSessionConfirmation.title', { name: targetName }),
      message: t('chatInput.harness.newSessionConfirmation.message', { name: targetName }),
      confirmText: t('chatInput.harness.newSessionConfirmation.confirm'),
    });
    if (!confirmed) return;
    await onStartNewSession?.(selection);
  }, [finishSelection, onStartNewSession, t]);

  useEffect(() => {
    let removeOverlayPointerdown0: (() => void) | undefined;
    let removeOverlayKeydown1: (() => void) | undefined;
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || triggerRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    removeOverlayPointerdown0 = subscribeOverlayInteraction(menuRef, 'pointerdown', handlePointerDown);
    removeOverlayKeydown1 = subscribeOverlayInteraction(menuRef, 'keydown', handleKeyDown);
    return () => {
      removeOverlayPointerdown0?.();
      removeOverlayKeydown1?.();
    };
  }, [close, open]);

  const handleSelectProfile = useCallback((profileId: KnownHarnessProfileId) => {
    if (profileId === 'other') {
      setPage('agents');
      return;
    }
    if (fixedSession) {
      if (isSelectableProfile(profileId)) {
        void confirmNewSession(
          { kind: 'profile', id: profileId },
          t(`chatInput.harness.profiles.${profileId}.name`),
        );
      } else {
        finishSelection();
      }
      return;
    }
    if (profileId === selectedProfile) {
      finishSelection();
      return;
    }
    if (isSelectableProfile(profileId)) {
      void onSelectProfile(profileId);
    }
    finishSelection();
  }, [confirmNewSession, finishSelection, fixedSession, onSelectProfile, selectedProfile, t]);

  const handleSelectAgent = useCallback((agent: HarnessAgentOption) => {
    if (agent.available === false) {
      notificationService.info(t('chatInput.harness.agentUnavailable', { name: agent.name }), {
        duration: 3200,
      });
      return;
    }
    if (fixedSession) {
      void confirmNewSession({ kind: 'agent', id: agent.id }, agent.name);
      return;
    }
    const connected = selectedProfile === 'other' && sameAgent(agent.id, selectedAgentId);
    if (!connected) {
      void onSelectAgent?.(agent.id);
    }
    finishSelection();
  }, [confirmNewSession, finishSelection, fixedSession, onSelectAgent, selectedAgentId, selectedProfile, t]);

  const knownSelectedProfile = PROFILE_IDS.find(id => id === selectedProfile);
  const selectedAgent = otherAgents.find(agent => sameAgent(agent.id, selectedAgentId));
  const selectedProfileAvailable = Boolean(
    knownSelectedProfile
      && (
        isSelectableProfile(knownSelectedProfile)
        || (
          knownSelectedProfile === 'other'
          && selectedAgent
          && selectedAgent.available !== false
        )
      ),
  );
  const primaryLabel = legacySession
    ? t('chatInput.harness.compatibilityShort')
    : knownSelectedProfile === 'other'
      ? selectedAgent?.name || selectedAgentId || t('chatInput.harness.profiles.other.name')
      : knownSelectedProfile
        ? t(`chatInput.harness.profiles.${knownSelectedProfile}.name`)
        : t('chatInput.harness.unsupportedProfile', { id: selectedProfile });
  const triggerLabel = primaryLabel;
  const triggerTooltip = legacySession
    ? t('chatInput.harness.legacySessionNotice')
    : !selectedProfileAvailable
      ? t('chatInput.harness.unsupportedProfileNotice', { id: selectedProfile })
      : sessionStarted
        ? t('chatInput.harness.fixedTooltip', { name: primaryLabel })
        : t('chatInput.harness.selectorTooltip', { name: primaryLabel });
  const triggerState = [open ? 'open' : '', fixedSession ? 'fixed' : '']
    .filter(Boolean)
    .join(' ') || undefined;
  const creatingNewSession = fixedSession;
  const handleTriggerClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!open) setPage('profiles');
    setOpen(!open);
  };
  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (presentation !== 'menu-item' || event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    if (!open) setPage('profiles');
    setOpen(true);
  };
  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' && !(presentation === 'menu-item' && event.key === 'ArrowLeft')) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    close();
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <div
      className={`openbitfun-harness-selector openbitfun-harness-selector--${presentation}`}
      data-openbitfun-component="harness-selector"
      data-openbitfun-part="root"
      data-openbitfun-presentation={presentation}
      data-openbitfun-profile={knownSelectedProfile}
    >
      <Tooltip content={triggerTooltip}>
        {presentation === 'menu-item' ? (
          <MenuItem
            ref={triggerRef}
            data-openbitfun-component="harness-selector"
            data-openbitfun-part="trigger"
            data-openbitfun-state={triggerState}
            data-harness-legacy={legacySession ? 'true' : undefined}
            data-harness-locked={sessionStarted ? 'true' : undefined}
            data-harness-fixed={fixedSession ? 'true' : undefined}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={menuId}
            aria-label={triggerTooltip}
            disabled={disabled}
            onClick={handleTriggerClick}
            onKeyDown={handleTriggerKeyDown}
            leading={knownSelectedProfile
              ? <HarnessProfileMark profile={knownSelectedProfile} />
              : <Icon name="user" size="md" aria-hidden />}
            metadata={(
              <Icon
                name="chevron-right"
                className="openbitfun-harness-selector__trigger-chevron"
                size="sm"
                aria-hidden
              />
            )}
            data-testid="harness-profile-selector"
          >
            {triggerLabel}
          </MenuItem>
        ) : (
          <button data-overflow-trigger
            ref={triggerRef}
            type="button"
            className="openbitfun-harness-selector__trigger"
            data-openbitfun-component="harness-selector"
            data-openbitfun-part="trigger"
            data-openbitfun-state={triggerState}
            data-harness-legacy={legacySession ? 'true' : undefined}
            data-harness-locked={sessionStarted ? 'true' : undefined}
            data-harness-fixed={fixedSession ? 'true' : undefined}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={triggerTooltip}
            disabled={disabled}
            onClick={handleTriggerClick}
            data-testid="harness-profile-selector"
          >
            <OverflowText className="openbitfun-harness-selector__trigger-value">{triggerLabel}</OverflowText>
          </button>
        )}
      </Tooltip>

      {open && createOverlayPortal(
        <Menu
          ref={menuRef}
          id={menuId}
          className="openbitfun-harness-selector__menu"
          data-openbitfun-component="harness-selector"
          data-openbitfun-part="menu"
          data-openbitfun-state="open"
          data-openbitfun-page={page}
          data-openbitfun-placement={presentation === 'menu-item'
            ? 'side'
            : menuLayout?.placement ?? 'top'}
          data-harness-locked={sessionStarted ? 'true' : undefined}
          data-harness-fixed={fixedSession ? 'true' : undefined}
          style={presentation === 'menu-item'
            ? {
                top: sideMenuLayout?.top ?? 0,
                left: sideMenuLayout?.left ?? 0,
                visibility: sideMenuLayout ? 'visible' : 'hidden',
              }
            : {
                top: `${menuLayout?.top ?? 0}px`,
                left: `${menuLayout?.left ?? 0}px`,
                visibility: menuLayout ? 'visible' : 'hidden',
              }}
          autoFocusFirstItem
          onMouseDown={event => event.stopPropagation()}
          onKeyDown={handleMenuKeyDown}
        >
          <MenuSection>
            {page === 'profiles' ? (
              <>
                {PROFILE_IDS.map((id) => {
                  const name = t(`chatInput.harness.profiles.${id}.name`);
                  const connected = !creatingNewSession
                    && id === selectedProfile
                    && !legacySession;
                  const state = connected
                    ? 'current'
                    : 'available';
                  return (
                    <span
                      key={id}
                      className="openbitfun-harness-selector__row-contract"
                      data-openbitfun-component="harness-selector"
                      data-openbitfun-part="profile"
                      data-openbitfun-profile={id}
                      data-openbitfun-state={state}
                    >
                      <MenuItem
                        role={creatingNewSession ? 'menuitem' : 'menuitemradio'}
                        checked={!creatingNewSession && connected}
                        data-openbitfun-profile={id}
                        data-openbitfun-state={state}
                        leading={<HarnessProfileMark profile={id} />}
                        metadata={(
                          <span className="openbitfun-harness-selector__profile-status">
                            {connected ? <Icon name="check-line" size="sm" style={{ width: 13, height: 13 }} aria-hidden /> : null}
                            {id === 'other' ? (
                              <>
                                <span className="openbitfun-harness-selector__agent-count">
                                  {otherAgents.length}
                                </span>
                                <Icon name="chevron-right" size="sm" aria-hidden />
                              </>
                            ) : null}
                          </span>
                        )}
                        onClick={() => handleSelectProfile(id)}
                        data-testid={`harness-profile-${id}`}
                      >
                        {name}
                      </MenuItem>
                    </span>
                  );
                })}
              </>
            ) : (
              <>
                <MenuItem
                  leading={<Icon name="chevron-left" size="sm" aria-hidden />}
                  onClick={() => setPage('profiles')}
                  data-testid="harness-agent-back"
                >
                  {t('chatInput.harness.otherAgentsTitle')}
                </MenuItem>
                <MenuSeparator />
                {otherAgents.length === 0 ? (
                  <div className="openbitfun-harness-selector__empty">
                    {t('chatInput.harness.otherAgentsEmpty')}
                  </div>
                ) : otherAgents.map(agent => {
                  const connected = !creatingNewSession
                    && selectedProfile === 'other'
                    && sameAgent(agent.id, selectedAgentId);
                  const state = connected
                    ? 'current'
                    : agent.available === false
                      ? 'unavailable'
                      : 'available';
                  return (
                    <span
                      key={agent.id}
                      className="openbitfun-harness-selector__row-contract"
                      data-openbitfun-component="harness-selector"
                      data-openbitfun-part="agent"
                      data-openbitfun-agent-id={agent.id}
                      data-openbitfun-state={state}
                    >
                      <MenuItem
                        role={creatingNewSession ? 'menuitem' : 'menuitemradio'}
                        checked={!creatingNewSession && connected}
                        data-openbitfun-agent-id={agent.id}
                        data-openbitfun-state={state}
                        leading={<Icon name="user" size="md" aria-hidden />}
                        metadata={(
                          <span className="openbitfun-harness-selector__profile-status">
                            {connected ? <Icon name="check-line" size="sm" style={{ width: 13, height: 13 }} aria-hidden /> : null}
                            {agent.available === false
                              ? t('chatInput.harness.unavailable')
                              : null}
                          </span>
                        )}
                        onClick={() => handleSelectAgent(agent)}
                        data-testid={`harness-agent-${agent.id}`}
                      >
                        {agent.name}
                      </MenuItem>
                    </span>
                  );
                })}
              </>
            )}
          </MenuSection>
        </Menu>,
        getAppearanceOverlayHost(),
      )}
    </div>
  );
};

export default HarnessProfileSelector;
