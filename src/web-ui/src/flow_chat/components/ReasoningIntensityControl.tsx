import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { MenuItem, SegmentedControl } from '@openbitfun/ui';
import { FlowChatCollapse } from '@openbitfun/ui/flow-chat';
import { useI18n } from '@/infrastructure/i18n';
import type { ReasoningPresetDescriptor } from '@/infrastructure/config/types';
import { isAutomaticReasoningPreset, presetDisplayLabel, presetSemanticKey, reasoningAutomaticValue, reasoningPresetChoices, reasoningSelectionLabel, reasoningVisualTier, resolveReasoningPresetChoice } from './reasoningPresetPresentation';
import './ReasoningIntensityControl.scss';

interface ReasoningIntensityControlProps {
  presets: ReasoningPresetDescriptor[];
  selectedPreset?: ReasoningPresetDescriptor;
  allowDefaultReset?: boolean;
  active?: boolean;
  disabled?: boolean;
  onSelect: (presetId: string | null) => boolean | Promise<boolean>;
}

interface ReasoningChoice {
  value: string;
  presetId: string | null;
  label: string;
}

const stars = Array.from({ length: 48 }, (_, index) => index);
const reasoningTransitionMs = 180;

export const ReasoningIntensityControl: React.FC<ReasoningIntensityControlProps> = ({
  presets,
  selectedPreset,
  allowDefaultReset = true,
  active = true,
  disabled = false,
  onSelect,
}) => {
  const { t } = useI18n('flow-chat');
  const skyId = useId();
  const choicesId = useId();
  const [expanded, setExpanded] = useState(false);
  const [previewValue, setPreviewValue] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [focusRevision, setFocusRevision] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const choicesRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  const activeRef = useRef(active);
  const restoreFocusRef = useRef(false);
  const retryFocusRef = useRef<string | undefined>(undefined);
  activeRef.current = active;

  const selectedChoice = resolveReasoningPresetChoice(selectedPreset, presets);
  const label = reasoningSelectionLabel(selectedChoice, t);
  const selectedValue = selectedChoice && !isAutomaticReasoningPreset(selectedChoice) ? `preset:${selectedChoice.id}` : 'auto';
  const advertisedPresets = reasoningPresetChoices(presets);
  const manualPresets = advertisedPresets.filter(preset => !isAutomaticReasoningPreset(preset));
  const presetChoices = manualPresets.map(preset => ({
    value: `preset:${preset.id}`,
    presetId: preset.id,
    label: presetDisplayLabel(preset, t),
  }));
  const automaticValue = reasoningAutomaticValue(advertisedPresets, allowDefaultReset);
  const automaticChoices: ReasoningChoice[] = automaticValue !== undefined
    ? [{ value: 'auto', presetId: automaticValue, label: t('reasoningSelector.auto') }] : [];
  const choices: ReasoningChoice[] = [...automaticChoices, ...presetChoices];
  const previewChoice = expanded ? choices.find(choice => choice.value === previewValue) : undefined;
  const visualPreset = previewChoice
    ? presets.find(preset => preset.id === previewChoice.presetId)
    : selectedChoice;
  const visualMeaning = visualPreset && presetSemanticKey(visualPreset);
  const visualState = visualMeaning === 'off' ? 'off'
    : visualPreset && isAutomaticReasoningPreset(visualPreset) ? 'auto'
      : visualPreset ? 'manual' : 'auto';
  const visualTier = reasoningVisualTier(visualPreset, presets);
  const locked = disabled || pending || !active;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (active) return;
    restoreFocusRef.current = false;
    setPreviewValue(null);
    setExpanded(false);
  }, [active]);

  useLayoutEffect(() => {
    if (!active || locked) return;
    if (expanded) {
      const buttons = Array.from(choicesRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const preferred = buttons.find(button => button.dataset.openbitfunValue === retryFocusRef.current)
        ?? buttons.find(button => button.getAttribute('aria-pressed') === 'true')
        ?? buttons[0];
      preferred?.focus({ preventScroll: true });
      retryFocusRef.current = undefined;
    } else if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      triggerRef.current?.focus({ preventScroll: true });
    }
  }, [active, expanded, focusRevision, locked]);

  const collapse = () => {
    restoreFocusRef.current = activeRef.current;
    setPreviewValue(null);
    setExpanded(false);
  };

  const previewTarget = (target: EventTarget) => {
    if (!expanded || locked || !(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('button[data-openbitfun-value]');
    if (button && !button.disabled) setPreviewValue(button.dataset.openbitfunValue ?? null);
  };

  const select = async (value: string) => {
    const choice = choices.find(item => item.value === value);
    if (!expanded || locked || pendingRef.current || !choice) return;
    if (value === selectedValue && (choice.presetId ?? undefined) === selectedPreset?.id) {
      collapse();
      return;
    }
    pendingRef.current = true;
    retryFocusRef.current = value;
    setPending(true);
    try {
      if (await onSelect(choice.presetId) && mountedRef.current) collapse();
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) {
        setPending(false);
        // Fast failures can batch both pending updates into one render.
        setFocusRevision(revision => revision + 1);
      }
    }
  };

  const handleChoiceKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      collapse();
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const forward = event.key === 'ArrowRight' ? !rtl : rtl;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (forward ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus({ preventScroll: true });
  };

  return (
    <div
      className="openbitfun-reasoning-control"
      data-testid="chat-model-selector-intensity-control"
      data-openbitfun-component="model-selector"
      data-openbitfun-part="reasoningSlider"
      data-reasoning-state={visualState}
      data-intensity={visualTier}
      data-expanded={expanded ? 'true' : 'false'}
      data-disabled={locked ? 'true' : undefined}
    >
      <div
        className="openbitfun-reasoning-control__value"
        data-openbitfun-component="model-selector"
        data-openbitfun-part="reasoningSliderValue"
      >
        <div
          className="openbitfun-reasoning-control__summary"
          aria-hidden={expanded}
          {...(expanded ? { inert: '' } : {})}
        >
          <MenuItem
            ref={triggerRef}
            className="openbitfun-reasoning-control__trigger"
            data-testid="chat-model-selector-settings-reasoning"
            aria-label={`${t('reasoningSelector.title')}: ${label}`}
            aria-expanded={expanded}
            aria-controls={choicesId}
            disabled={locked || expanded || choices.length === 0}
            onClick={() => setExpanded(true)}
            onKeyDown={event => {
              if (event.key !== 'ArrowRight') return;
              event.preventDefault();
              event.stopPropagation();
              if (!locked && choices.length > 0) setExpanded(true);
            }}
          >
            {t('reasoningSelector.thinking')}{' · '}{label}
          </MenuItem>
        </div>
        <FlowChatCollapse
          isOpen={expanded}
          durationMs={reasoningTransitionMs}
          className="openbitfun-reasoning-control__options"
          innerClassName="openbitfun-reasoning-control__options-content"
        >
          <div
            id={choicesId}
            ref={choicesRef}
            className="openbitfun-reasoning-control__choices"
            data-testid="chat-model-selector-reasoning-options"
            data-openbitfun-component="model-selector"
            data-openbitfun-part="reasoningSliderInput"
            aria-busy={pending || undefined}
            onKeyDown={handleChoiceKeyDown}
            onPointerOver={event => previewTarget(event.target)}
            onPointerLeave={() => setPreviewValue(null)}
            onFocus={event => previewTarget(event.target)}
            onBlur={event => {
              if (!event.currentTarget.contains(event.relatedTarget)) setPreviewValue(null);
            }}
          >
            <SegmentedControl
              className="openbitfun-reasoning-control__segments"
              data-wrap={choices.length > 5 ? 'true' : undefined}
              style={choices.length > 5 ? {
                gridTemplateColumns: `repeat(${Math.min(4, Math.ceil(choices.length / 2))}, minmax(0, 1fr))`,
              } : undefined}
              aria-label={t('reasoningSelector.title')}
              interaction="buttons"
              distribution="fill"
              tone="neutral"
              options={choices}
              value={selectedValue}
              disabled={locked || !expanded}
              onValueChange={value => { void select(value); }}
            />
          </div>
        </FlowChatCollapse>
      </div>
      <div className="openbitfun-reasoning-control__backdrop" aria-hidden="true">
        <span
          className="openbitfun-reasoning-control__sky"
          data-openbitfun-component="model-selector"
          data-openbitfun-part="reasoningSliderSky"
        >
          <span className="openbitfun-reasoning-control__field">
            <svg
              className="openbitfun-reasoning-control__nebula"
              data-openbitfun-component="model-selector"
              data-openbitfun-part="reasoningSliderNebula"
              viewBox="0 0 280 56"
              preserveAspectRatio="none"
              focusable="false"
            >
              <defs>
                <filter id={`${skyId}-cloud`} x="0" y="0" width="100%" height="100%">
                  <feTurbulence type="fractalNoise" baseFrequency="0.035 0.09" numOctaves="3" seed="8" result="noise" />
                  <feColorMatrix
                    in="noise"
                    type="matrix"
                    values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  2.8 0 0 0 -0.9"
                    result="cloud"
                  />
                  <feComposite in="SourceGraphic" in2="cloud" operator="in" />
                </filter>
              </defs>
              <rect width="280" height="56" fill="currentColor" filter={`url(#${skyId}-cloud)`} />
            </svg>
          </span>
          <span
            className="openbitfun-reasoning-control__aurora"
            data-openbitfun-component="model-selector"
            data-openbitfun-part="reasoningSliderAurora"
          />
          {visualState !== 'off' && <span className="openbitfun-reasoning-control__stars">
            {stars.map(index => (
              <span key={index} className="openbitfun-reasoning-control__star-slot">
                <span className="openbitfun-reasoning-control__star" />
              </span>
            ))}
          </span>}
        </span>
      </div>
    </div>
  );
};
