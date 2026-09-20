/**
 * The ACP session mode picker.
 *
 * ACP's `mode` category is "the picker that is not the model picker": dsh-acp
 * publishes its agent presets there, claude-code and codex their permission
 * modes. It used to live as a second section inside the model dropdown, which
 * made one button stand for two unrelated choices. It is its own trigger now,
 * sitting beside the model picker and showing the mode in force.
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';
import { subscribeOverlayInteraction, createOverlayPortal, OverflowText, Menu, MenuItem } from '@openbitfun/ui';
import { Tooltip, Icon } from '@openbitfun/ui';
import { RetainedMountBoundary } from '@/shared/presence';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import type { AcpModeState } from '../utils/acpSessionConfig';
import { getModelSelectorDropdownLayout } from './modelSelectorDropdownPosition';
import './AcpModeSelector.scss';

interface AcpModeSelectorProps {
  mode: AcpModeState;
  /** Which agent published the mode; shown as the dropdown's right-hand hint. */
  clientId?: string;
  disabled?: boolean;
  loading?: boolean;
  dropdownPlacement?: 'top' | 'bottom';
  /**
   * Replaces the trigger tooltip. The caller uses this when this picker is the
   * only one on screen and therefore also carries the context-usage readout.
   */
  tooltip?: React.ReactNode;
  onSelect: (value: string) => void | Promise<void>;
}

export const AcpModeSelector: React.FC<AcpModeSelectorProps> = ({
  mode,
  clientId,
  disabled = false,
  loading = false,
  dropdownPlacement = 'top',
  tooltip,
  onSelect,
}) => {
  const { t } = useTranslation('flow-chat');
  const [open, setOpen] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({
    position: 'fixed',
    visibility: 'hidden',
  });
  const [resolvedPlacement, setResolvedPlacement] = useState(dropdownPlacement);

  const candidates = mode.option.options;

  useEffect(() => {
    if (candidates.length === 0) setOpen(false);
  }, [candidates.length]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
        setKeyboardOpen(false);
      }
    };
    const removeOverlayMousedown0 = subscribeOverlayInteraction(menuRef, 'mousedown', handlePointerDown);
    return () => removeOverlayMousedown0?.();
  }, [open]);

  useEffect(() => {
    if (!open || !rootRef.current) return;
    const updatePosition = () => {
      if (!rootRef.current || !menuRef.current) return;
      const layout = getModelSelectorDropdownLayout(
        rootRef.current.getBoundingClientRect(),
        menuRef.current.getBoundingClientRect(),
        dropdownPlacement,
        { width: window.innerWidth, height: window.innerHeight },
      );
      setMenuStyle(layout.style);
      setResolvedPlacement(layout.placement);
    };
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    if (menuRef.current) observer.observe(menuRef.current);
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [dropdownPlacement, open]);

  const select = useCallback((value: string) => {
    if (menuRef.current?.contains(document.activeElement)) {
      triggerRef.current?.focus();
    }
    setOpen(false);
    void onSelect(value);
  }, [onSelect]);

  const handleMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      triggerRef.current?.focus();
      setOpen(false);
    }
  }, []);

  if (candidates.length === 0) return null;

  const currentLabel = candidates.find(candidate => candidate.value === mode.currentValue)?.name
    ?? mode.currentValue;
  const triggerTooltip = tooltip
    ?? mode.option.description
    ?? `${mode.option.name}: ${currentLabel}`;

  return (
    <div
      ref={rootRef}
      className="openbitfun-acp-mode-selector"
      data-openbitfun-component="acp-mode-selector"
      data-openbitfun-part="root"
      data-openbitfun-state={open ? 'open' : undefined}
    >
      <Tooltip content={triggerTooltip} disabled={open}>
        <button data-overflow-trigger
          ref={triggerRef}
          type="button"
          className={`openbitfun-acp-mode-selector__trigger${open ? ' openbitfun-acp-mode-selector__trigger--open' : ''}`}
          data-openbitfun-component="acp-mode-selector"
          data-openbitfun-part="trigger"
          data-openbitfun-state={open ? 'open' : undefined}
          data-testid="chat-acp-mode-selector-btn"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          disabled={disabled || loading}
          onClick={(event) => {
            const nextOpen = !open;
            if (nextOpen) {
              setKeyboardOpen(event.detail === 0);
            } else if (event.detail !== 0) {
              setKeyboardOpen(false);
            }
            setOpen(nextOpen);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setKeyboardOpen(true);
              setOpen(true);
            } else if (event.key === 'Escape' && open) {
              event.preventDefault();
              setOpen(false);
            }
          }}
        >
          <OverflowText
            className="openbitfun-acp-mode-selector__label"
            data-openbitfun-component="acp-mode-selector"
            data-openbitfun-part="label"
          >
            {currentLabel}
          </OverflowText>
          <Icon name="chevron-down" size="lg" style={{ width: 10, height: 10 }} aria-hidden="true" />
        </button>
      </Tooltip>

      <RetainedMountBoundary present={open}>
        {createOverlayPortal(
          <Menu
            id={menuId}
            ref={menuRef}
            autoFocusFirstItem={keyboardOpen}
            className="openbitfun-acp-mode-selector__menu"
            data-openbitfun-component="acp-mode-selector"
            data-openbitfun-part="menu"
            data-placement={resolvedPlacement}
            data-open={open ? 'true' : 'false'}
            data-keyboard-open={keyboardOpen ? 'true' : 'false'}
            style={menuStyle}
            aria-hidden={!open}
            {...(!open ? { inert: '' } : {})}
            aria-label={t('modelSelector.acpMode')}
            data-testid="chat-acp-mode-selector-menu"
            onKeyDown={handleMenuKeyDown}
          >
            <div
              className="openbitfun-acp-mode-selector__header"
              data-openbitfun-component="acp-mode-selector"
              data-openbitfun-part="header"
            >
              <span>{t('modelSelector.acpMode')}</span>
              {clientId && (
                <OverflowText className="openbitfun-acp-mode-selector__header-hint">{clientId}</OverflowText>
              )}
            </div>
            {candidates.map((candidate) => {
              const isSelected = mode.currentValue === candidate.value;
              // The row stays one line; what a mode does — or why it can no
              // longer change — is hover-only.
              const hint = mode.locked
                ? (mode.option.description ?? t('modelSelector.acpModeLocked'))
                : (candidate.description ?? candidate.name);

              return (
                <MenuItem
                    type="button"
                    role="menuitemradio"
                    checked={isSelected}
                    key={candidate.value}
                    data-testid="chat-acp-mode-option"
                    data-mode-value={candidate.value}
                    data-selected={isSelected ? 'true' : 'false'}
                    disabled={mode.locked || loading}
                    className="openbitfun-acp-mode-selector__option-row"
                    data-openbitfun-component="acp-mode-selector"
                    data-openbitfun-part="option"
                    data-openbitfun-state={isSelected ? 'selected' : undefined}
                    title={hint}
                    onClick={() => select(candidate.value)}
                    shortcut={isSelected ? <Icon name="check-line" size="sm" aria-hidden="true" /> : undefined}
                  >
                    <span className="openbitfun-acp-mode-menu__option-content">
                      <strong>{candidate.name}</strong>
                    </span>
                  </MenuItem>
              );
            })}
          </Menu>,
          getAppearanceOverlayHost(),
          null,
          { open, ownerRef: triggerRef },
        )}
      </RetainedMountBoundary>
    </div>
  );
};

export default AcpModeSelector;
