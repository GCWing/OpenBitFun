import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { subscribeOverlayInteraction, createOverlayPortal, OverflowText, Menu, MenuItem, MenuList } from '@openbitfun/ui';
import { Tooltip, Icon } from '@openbitfun/ui';
import { RetainedMountBoundary } from '@/shared/presence';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import type { ReasoningCatalogProjection } from '@/infrastructure/config/types';
import { getModelSelectorDropdownLayout } from './modelSelectorDropdownPosition';
import { isAutomaticReasoningPreset, presetLabel, presetDisplayLabel, reasoningAutomaticValue, reasoningPresetChoices, reasoningSelectionLabel, resolveReasoningPresetChoice } from './reasoningPresetPresentation';
import './ReasoningPresetSelector.scss';

interface ReasoningPresetSelectorProps {
  projection?: ReasoningCatalogProjection | null;
  selectedPreset?: string | null;
  disabled?: boolean;
  loading?: boolean;
  triggerPresentation?: 'meter' | 'label';
  dropdownPlacement?: 'top' | 'bottom';
  onSelect: (presetId: string | null) => void | Promise<void>;
}

export const ReasoningPresetSelector: React.FC<ReasoningPresetSelectorProps> = ({
  projection,
  selectedPreset,
  disabled = false,
  loading = false,
  triggerPresentation = 'meter',
  dropdownPlacement = 'top',
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

  const presets = useMemo(
    () => (projection?.status === 'known' ? projection.presets ?? [] : []),
    [projection],
  );
  const selected = resolveReasoningPresetChoice(presets.find(preset => preset.id === selectedPreset), presets);
  const defaultPreset = resolveReasoningPresetChoice(presets.find(preset => preset.id === projection?.default_preset), presets);

  useEffect(() => {
    if (presets.length === 0) setOpen(false);
  }, [presets.length]);

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

  const select = useCallback((presetId: string | null) => {
    void onSelect(presetId);
  }, [onSelect]);

  const handleMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      triggerRef.current?.focus();
      setOpen(false);
    }
  }, []);

  if (presets.length === 0) return null;

  const orderedPresets = reasoningPresetChoices(presets).filter(preset => !isAutomaticReasoningPreset(preset));
  const automaticValue = reasoningAutomaticValue(presets, true) ?? null;
  const automatic = !selected || isAutomaticReasoningPreset(selected);
  const presetLabels = orderedPresets.map(preset => (
    presetDisplayLabel(preset, t)
  ));

  const effectivePreset = selected ?? defaultPreset;
  const statusLabel = reasoningSelectionLabel(selected, t);
  const showLabel = triggerPresentation === 'label' || Boolean(selected);
  // Preserve the advertised preset's meaning in the text and accessible name.
  const tooltip = selected
    ? t('reasoningSelector.current', { preset: statusLabel })
    : t('reasoningSelector.currentAuto', {
        preset: effectivePreset ? presetDisplayLabel(effectivePreset, t) : t('reasoningSelector.modelDefault'),
      });

  return (
    <div
      ref={rootRef}
      className="openbitfun-reasoning-preset-selector"
      data-openbitfun-component="reasoning-preset-selector"
      data-openbitfun-part="root"
      data-openbitfun-state={open ? 'open' : undefined}
      data-openbitfun-presentation={showLabel ? 'label' : 'meter'}
    >
      <Tooltip content={tooltip} disabled={open}>
        <button data-overflow-trigger
          ref={triggerRef}
          type="button"
          className={[
            'openbitfun-reasoning-preset-selector__trigger',
            open && 'openbitfun-reasoning-preset-selector__trigger--open',
          ].filter(Boolean).join(' ')}
          data-openbitfun-component="reasoning-preset-selector"
          data-openbitfun-part="trigger"
          data-openbitfun-state={open ? 'open' : undefined}
          data-testid="chat-reasoning-preset-selector-btn"
          aria-label={tooltip}
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
          {showLabel ? (
            <OverflowText className="openbitfun-reasoning-preset-selector__trigger-label">
              {statusLabel}
            </OverflowText>
          ) : (
            <Icon name="reasoning-auto" size="xs" />
          )}
        </button>
      </Tooltip>

      <RetainedMountBoundary present={open}>
        {createOverlayPortal(
          <Menu
          id={menuId}
          ref={menuRef}
          autoFocusFirstItem={keyboardOpen}
          className="openbitfun-reasoning-preset-selector__menu"
          data-openbitfun-component="reasoning-preset-selector"
          data-openbitfun-part="menu"
          data-placement={resolvedPlacement}
          data-open={open ? 'true' : 'false'}
          data-keyboard-open={keyboardOpen ? 'true' : 'false'}
          style={menuStyle}
          aria-hidden={!open}
          {...(!open ? { inert: '' } : {})}
          aria-label={t('reasoningSelector.title')}
          data-testid="chat-reasoning-preset-selector-menu"
          onKeyDown={handleMenuKeyDown}
        >
          <div
            className="openbitfun-reasoning-preset-selector__header"
            data-openbitfun-component="reasoning-preset-selector"
            data-openbitfun-part="header"
          >
            <span className="openbitfun-reasoning-preset-selector__title">
              {t('reasoningSelector.title')}
            </span>
            <MenuItem
              type="button"
              role="menuitemradio"
              checked={automatic}
              className="openbitfun-reasoning-preset-selector__auto-row"
              data-openbitfun-component="reasoning-preset-selector"
              data-openbitfun-part="auto"
              data-openbitfun-state={automatic ? 'selected' : undefined}
              onClick={() => select(automaticValue)}
            >
              <span>{t('reasoningSelector.auto')}</span>
            </MenuItem>
          </div>
          <MenuList
            className="openbitfun-reasoning-preset-selector__options"
            data-openbitfun-component="reasoning-preset-selector"
            data-openbitfun-part="options"
          >
            {orderedPresets.map((preset, index) => {
              const isSelected = selected?.id === preset.id;
              const label = presetLabels[index] ?? presetLabel(preset, t);
              return (
                <MenuItem data-overflow-trigger
                  key={preset.id}
                  type="button"
                  role="menuitemradio"
                  checked={isSelected}
                  data-preset-id={preset.id}
                  className="openbitfun-reasoning-preset-selector__option-row"
                  data-openbitfun-component="reasoning-preset-selector"
                  data-openbitfun-part="option"
                  data-openbitfun-state={isSelected ? 'selected' : undefined}
                  onClick={() => select(preset.id)}
                >
                  <OverflowText className="openbitfun-reasoning-preset-selector__option-label">
                    {label}
                  </OverflowText>
                </MenuItem>
              );
            })}
          </MenuList>
          </Menu>,
          getAppearanceOverlayHost(),
          null,
          { open, ownerRef: triggerRef },
        )}
      </RetainedMountBoundary>
    </div>
  );
};

export default ReasoningPresetSelector;
