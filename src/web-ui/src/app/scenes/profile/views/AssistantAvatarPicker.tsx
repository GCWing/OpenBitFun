import { subscribeOverlayInteraction, createOverlayPortal, Button, Icon, IconButton, Input, ScrollArea } from '@openbitfun/ui';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  AssistantAvatar,
  ASSISTANT_AVATAR_PRESETS,
  getAssistantAvatarPreset,
} from '@/app/components/AssistantAvatar';
import type { IdentitySaveStatus } from '@/app/scenes/my-agent/useAgentIdentityDocument';
import { ASSISTANT_EMOJI_PRESETS, firstAvatarGrapheme } from './assistantAvatar';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';

interface AssistantAvatarPickerProps {
  presetValue?: string;
  value: string;
  stableKey?: string;
  assistantName?: string;
  saveStatus: IdentitySaveStatus;
  saveError?: string | null;
  onPresetChange?: (value: string) => void;
  onChange: (value: string) => void;
}

const AssistantAvatarPicker: React.FC<AssistantAvatarPickerProps> = ({
  presetValue = '',
  value,
  stableKey,
  assistantName,
  saveStatus,
  saveError,
  onPresetChange,
  onChange,
}) => {
  const { t } = useTranslation('scenes/profile');
  const pickerId = useId();
  const titleId = `${pickerId}-title`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const displayedValue = useMemo(() => firstAvatarGrapheme(value), [value]);
  const selectedPresetId = getAssistantAvatarPreset(presetValue)?.id ?? '';
  const [customValue, setCustomValue] = useState(displayedValue);
  const popoverLayout = useAnchoredPopoverPosition({
    open: isOpen,
    anchorRef: triggerRef,
    popoverRef,
    preferredPlacement: 'bottom',
    alignment: 'start',
    gap: 8,
  });

  useEffect(() => {
    setCustomValue(displayedValue);
  }, [displayedValue]);

  useEffect(() => {
    let removeOverlayPointerdown0: (() => void) | undefined;
    let removeOverlayKeydown1: (() => void) | undefined;
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsOpen(false);
      triggerRef.current?.focus();
    };

    removeOverlayPointerdown0 = subscribeOverlayInteraction(popoverRef, 'pointerdown', handlePointerDown);
    removeOverlayKeydown1 = subscribeOverlayInteraction(popoverRef, 'keydown', handleKeyDown);
    return () => {
      removeOverlayPointerdown0?.();
      removeOverlayKeydown1?.();
    };
  }, [isOpen]);

  const chooseEmojiAvatar = (nextValue: string) => {
    setCustomValue(nextValue);
    onPresetChange?.('');
    onChange(nextValue);
  };

  const choosePresetAvatar = (nextValue: string) => {
    onPresetChange?.(nextValue);
  };

  const handleCustomSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextValue = firstAvatarGrapheme(customValue);
    if (!nextValue) return;
    chooseEmojiAvatar(nextValue);
  };

  const normalizedCustomValue = firstAvatarGrapheme(customValue);
  const statusContent = saveStatus === 'saving'
    ? t('identity.avatarSaving')
    : saveStatus === 'saved'
      ? t('identity.avatarSaved')
      : saveStatus === 'error'
        ? t('identity.avatarSaveFailed')
        : t('identity.avatarAutosave');

  return (
    <div ref={rootRef} className="acp-avatar-picker">
      <button
        ref={triggerRef}
        type="button"
        className={`acp-avatar-picker__trigger${isOpen ? ' is-open' : ''}`}
        aria-label={t('identity.avatarChange')}
        aria-expanded={isOpen}
        aria-controls={pickerId}
        onClick={() => setIsOpen((open) => !open)}
      >
        <AssistantAvatar
          presetId={presetValue}
          emoji={displayedValue}
          stableKey={stableKey}
          name={assistantName}
          size={58}
        />
        <span className="acp-avatar-picker__edit-cue" aria-hidden="true">
          <Icon name="edit" size="2xs" />
        </span>
      </button>

      {isOpen ? createOverlayPortal(
        <ScrollArea
          ref={popoverRef}
          id={pickerId}
          className="acp-avatar-picker__popover"
          role="region"
          aria-labelledby={titleId}
          data-openbitfun-placement={popoverLayout?.placement ?? 'bottom'}
          style={{
            top: `${popoverLayout?.top ?? 0}px`,
            left: `${popoverLayout?.left ?? 0}px`,
            visibility: popoverLayout ? 'visible' : 'hidden',
          }}
        >
          <div className="acp-avatar-picker__header">
            <div className="acp-avatar-picker__heading">
              <strong id={titleId}>{t('identity.avatarPickerTitle')}</strong>
              <span>{t('identity.avatarPickerHint')}</span>
            </div>
            <IconButton
              type="button"
              size="sm"
              aria-label={t('identity.avatarPickerClose')}
              icon={<Icon name="xmark" size="lg" />}
              onClick={() => {
                setIsOpen(false);
                triggerRef.current?.focus();
              }}
            />
          </div>

          <div className="acp-avatar-picker__section-label">{t('identity.avatarOfficialPresets')}</div>
          <div className="acp-avatar-picker__grid" role="group" aria-label={t('identity.avatarOfficialPresets')}>
            {ASSISTANT_AVATAR_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`acp-avatar-picker__option is-official${selectedPresetId === preset.id ? ' is-selected' : ''}`}
                aria-label={t('identity.avatarUseOfficialPreset', {
                  name: t(`identity.avatarFamilies.${preset.family}`),
                })}
                aria-pressed={selectedPresetId === preset.id}
                onClick={() => choosePresetAvatar(preset.id)}
              >
                <AssistantAvatar presetId={preset.id} size={30} />
              </button>
            ))}
          </div>

          <div className="acp-avatar-picker__section-label is-secondary">{t('identity.avatarEmojiPresets')}</div>
          <div className="acp-avatar-picker__grid" role="group" aria-label={t('identity.avatarEmojiPresets')}>
            {ASSISTANT_EMOJI_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`acp-avatar-picker__option${!presetValue && displayedValue === preset ? ' is-selected' : ''}`}
                aria-label={t('identity.avatarUsePreset', { emoji: preset })}
                aria-pressed={!presetValue && displayedValue === preset}
                onClick={() => chooseEmojiAvatar(preset)}
              >
                <span aria-hidden="true">{preset}</span>
              </button>
            ))}
          </div>

          <form className="acp-avatar-picker__custom" onSubmit={handleCustomSubmit}>
            <Input
              value={customValue}
              maxLength={16}
              autoComplete="off"
              aria-label={t('identity.avatarCustom')}
              placeholder={t('identity.avatarCustomPlaceholder')}
              className="acp-avatar-picker__custom-input"
              onChange={(event) => setCustomValue(event.target.value)}
              size="sm"
            />
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={!normalizedCustomValue || normalizedCustomValue === displayedValue}
            >
              {t('identity.avatarApply')}
            </Button>
          </form>

          <div className="acp-avatar-picker__footer">
            <span
              className={[
                'acp-avatar-picker__status',
                saveStatus === 'error' && 'is-error',
                saveStatus === 'saved' && 'is-saved',
              ].filter(Boolean).join(' ')}
              title={saveStatus === 'error' && saveError ? saveError : undefined}
              aria-live="polite"
            >
              {saveStatus === 'saved' ? <Icon name="check-line" size="xs" aria-hidden="true" /> : null}
              {statusContent}
            </span>
          </div>
        </ScrollArea>,
        getAppearanceOverlayHost(),
      ) : null}
    </div>
  );
};

export default AssistantAvatarPicker;
