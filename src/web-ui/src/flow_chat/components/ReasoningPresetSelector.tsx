import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Circle,
  CircleOff,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { subscribeOverlayInteraction, createOverlayPortal, OverflowText, Menu, MenuItem, MenuList } from '@openbitfun/ui';
import { Tooltip } from '@openbitfun/ui';
import { RetainedMountBoundary } from '@/shared/presence';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import type { ReasoningCatalogProjection } from '@/infrastructure/config/types';
import { getModelSelectorDropdownLayout } from './modelSelectorDropdownPosition';
import { presetLabel, presetDisplayLabel, reasoningIntensityLevel, type ReasoningIntensityLevel } from './reasoningPresetPresentation';
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

interface ReasoningIntensityMarkProps {
  level: ReasoningIntensityLevel;
  compact?: boolean;
}

export const ReasoningIntensityMark: React.FC<ReasoningIntensityMarkProps> = ({
  level,
  compact = false,
}) => {
  const ringSizes = compact ? [14, 9, 4.5] : [24, 14, 6.5];
  const ringCount = level === 0 ? 0 : Math.min(level, 3);

  return (
    <span
      className="openbitfun-reasoning-preset-selector__status-meter"
      data-intensity={level}
      data-size={compact ? 'compact' : 'option'}
      aria-hidden="true"
    >
      {level === 0 ? (
        <CircleOff
          className="openbitfun-reasoning-preset-selector__status-off"
          size={compact ? 14 : 22}
          strokeWidth={compact ? 1.5 : 1.2}
        />
      ) : (
        <>
          {ringSizes.slice(0, ringCount).map((size, index) => (
            <Circle
              key={size}
              className="openbitfun-reasoning-preset-selector__status-ring"
              data-ring={index + 1}
              size={size}
              strokeWidth={index === 0
                ? (compact ? 1.45 : 1.1)
                : (compact ? 1.7 : 1.35)}
            />
          ))}
          {level === 4 && (
            <Circle
              className="openbitfun-reasoning-preset-selector__status-peak"
              size={compact ? 3.5 : 5.5}
              strokeWidth={0}
              fill="currentColor"
            />
          )}
        </>
      )}
    </span>
  );
};

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
  const selected = presets.find(preset => preset.id === selectedPreset);
  const defaultPreset = presets.find(preset => preset.id === projection?.default_preset);

  useEffect(() => {
    if (presets.length === 0) setOpen(false);
  }, [presets.length]);

  useEffect(() => {
    let removeOverlayMousedown0: (() => void) | undefined;
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
        setKeyboardOpen(false);
      }
    };
    removeOverlayMousedown0 = subscribeOverlayInteraction(menuRef, 'mousedown', handlePointerDown);
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
    if (menuRef.current?.contains(document.activeElement)) {
      triggerRef.current?.focus();
    }
    setOpen(false);
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

  const orderedPresets = [...presets].sort((left, right) => left.order - right.order);
  const presetLabels = orderedPresets.map(preset => (
    presetDisplayLabel(preset, t)
  ));

  const currentLabel = selected
    ? presetLabel(selected, t)
    : t('reasoningSelector.auto');
  const effectivePreset = selected ?? defaultPreset;
  const intensityLevel = reasoningIntensityLevel(effectivePreset, orderedPresets);
  const statusLabel = effectivePreset
    ? presetDisplayLabel(effectivePreset, t)
    : currentLabel;
  // The trigger is the meter and nothing else, so this string is both the hover
  // text and the control's accessible name. Preserve the preset's actual meaning:
  // its position in the visual series must not rename an on toggle to low effort.
  const tooltip = selected
    ? t('reasoningSelector.current', { preset: statusLabel })
    : t('reasoningSelector.currentAuto', {
        preset: effectivePreset ? statusLabel : t('reasoningSelector.modelDefault'),
      });

  return (
    <div
      ref={rootRef}
      className="openbitfun-reasoning-preset-selector"
      data-openbitfun-component="reasoning-preset-selector"
      data-openbitfun-part="root"
      data-openbitfun-state={open ? 'open' : undefined}
      data-openbitfun-presentation={triggerPresentation}
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
          {triggerPresentation === 'label' ? (
            <OverflowText className="openbitfun-reasoning-preset-selector__trigger-label">
              {statusLabel}
            </OverflowText>
          ) : (
            <ReasoningIntensityMark level={intensityLevel} compact />
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
              checked={!selected}
              className="openbitfun-reasoning-preset-selector__auto-row"
              data-openbitfun-component="reasoning-preset-selector"
              data-openbitfun-part="auto"
              data-openbitfun-state={!selected ? 'selected' : undefined}
              onClick={() => select(null)}
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
