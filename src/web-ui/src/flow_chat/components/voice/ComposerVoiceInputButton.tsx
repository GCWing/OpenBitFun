import {
  Button,
  Icon,
  IconButton,
  OverflowText,
  Tooltip,
} from '@openbitfun/ui';
import { ChatComposerActionButton } from '@openbitfun/ui/flow-chat';
import { useEffect, useRef, useState } from 'react';
import { Loader2, VolumeX } from 'lucide-react';
import type { ComposerVoiceInputController } from './useComposerVoiceInput';

const VOICE_TIMELINE_SAMPLE_COUNT = 32;
const VOICE_TIMELINE_TICK_MS = 86;
const VOICE_SILENCE_THRESHOLD = 0.035;

function createFlatTimelineSamples(): number[] {
  return Array.from({ length: VOICE_TIMELINE_SAMPLE_COUNT }, () => 0);
}

function formatElapsedTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

interface ComposerVoiceInputButtonProps {
  controller: ComposerVoiceInputController;
}

export function ComposerVoiceInputButton({ controller }: ComposerVoiceInputButtonProps) {
  const [timelineSamples, setTimelineSamples] = useState(createFlatTimelineSamples);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const currentLevelRef = useRef(0);

  useEffect(() => {
    currentLevelRef.current = controller.audioLevel;
  }, [controller.audioLevel]);

  useEffect(() => {
    if (
      controller.phase === 'idle'
      || controller.phase === 'setup'
      || controller.phase === 'downloading'
      || controller.phase === 'preparing'
    ) {
      setTimelineSamples(createFlatTimelineSamples());
      return undefined;
    }
    if (controller.phase === 'transcribing') {
      return undefined;
    }

    setTimelineSamples(createFlatTimelineSamples());
    const timerId = window.setInterval(() => {
      const level = currentLevelRef.current < VOICE_SILENCE_THRESHOLD
        ? 0
        : Math.min(1, currentLevelRef.current);
      setTimelineSamples(previous => [...previous.slice(1), level]);
    }, VOICE_TIMELINE_TICK_MS);

    return () => window.clearInterval(timerId);
  }, [controller.phase]);

  useEffect(() => {
    if (
      controller.phase === 'idle'
      || controller.phase === 'setup'
      || controller.phase === 'downloading'
      || controller.phase === 'preparing'
    ) {
      setElapsedSeconds(0);
      return undefined;
    }
    if (controller.phase !== 'recording') {
      return undefined;
    }

    const timerId = window.setInterval(() => {
      setElapsedSeconds(previous => previous + 1);
    }, 1000);
    return () => window.clearInterval(timerId);
  }, [controller.phase]);

  if (!controller.enabled) {
    return null;
  }

  const setupRequired = controller.phase === 'setup';
  const downloading = controller.phase === 'downloading';

  if (setupRequired || downloading) {
    const progress = Math.min(100, Math.max(0, controller.downloadProgress ?? 0));
    return (
      <span
        className="openbitfun-chat-input__voice-cluster openbitfun-chat-input__voice-cluster--setup"
        data-openbitfun-component="composer-voice-input"
        data-openbitfun-part="root"
        data-openbitfun-phase={controller.phase}
        data-openbitfun-state="active"
      >
        <span
          className="openbitfun-chat-input__voice-setup-pill"
          data-openbitfun-component="composer-voice-input"
          data-openbitfun-part="setupPill"
          role="group"
          aria-label={controller.setupMessage}
          aria-busy={downloading}
        >
          <span
            className="openbitfun-chat-input__voice-setup-icon"
            data-openbitfun-component="composer-voice-input"
            data-openbitfun-part="status"
            aria-hidden="true"
          >
            {downloading
              ? <Icon glyph={Loader2} size="sm" className="openbitfun-chat-input__voice-spinner" />
              : <Icon name="arrow-down" size="sm" />}
          </span>
          <span
            className="openbitfun-chat-input__voice-setup-copy"
            data-openbitfun-component="composer-voice-input"
            data-openbitfun-part="setupMessage"
          >
            <OverflowText>{controller.setupMessage}</OverflowText>
            {downloading ? (
              <span className="openbitfun-chat-input__voice-setup-progress" aria-hidden="true">
                <span style={{ width: `${progress}%` }} />
              </span>
            ) : null}
          </span>
          {setupRequired ? (
            <span data-openbitfun-component="composer-voice-input" data-openbitfun-part="action" data-openbitfun-action="install">
              <Button
                className="openbitfun-chat-input__voice-setup-action"
                variant="primary"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation();
                  controller.installAndStart();
                }}
              >
                {controller.setupActionLabel}
              </Button>
            </span>
          ) : null}
          <span data-openbitfun-component="composer-voice-input" data-openbitfun-part="action" data-openbitfun-action="dismiss">
            <Tooltip content={controller.setupCancelTooltip}>
              <IconButton
                aria-label={controller.setupCancelTooltip}
                className="openbitfun-chat-input__voice-setup-dismiss"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation();
                  controller.dismissSetup();
                }}
                icon={<Icon name="xmark" size="sm" />}
              />
            </Tooltip>
          </span>
        </span>
      </span>
    );
  }

  const preparing = controller.phase === 'preparing';
  const transcribing = controller.phase === 'transcribing';
  const recording = controller.phase === 'recording';
  const activeVoicePill = preparing || recording || transcribing;

  if (activeVoicePill) {
    const currentSample = !recording || controller.audioLevel < VOICE_SILENCE_THRESHOLD
      ? 0
      : Math.min(1, controller.audioLevel);
    const visibleTimelineSamples = recording
      ? [...timelineSamples.slice(0, -1), currentSample]
      : timelineSamples;
    const controlsDisabled = preparing || transcribing;

    return (
      <span
        className="openbitfun-chat-input__voice-cluster openbitfun-chat-input__voice-cluster--recording"
        data-openbitfun-component="composer-voice-input"
        data-openbitfun-part="root"
        data-openbitfun-phase={controller.phase}
        data-openbitfun-state={['active', controller.lowVolumeWarning && 'low-volume'].filter(Boolean).join(' ')}
      >
        <span
          aria-label={controller.tooltip}
          aria-busy={preparing || transcribing}
          className="openbitfun-chat-input__voice-pill"
          data-openbitfun-component="composer-voice-input"
          data-openbitfun-part="pill"
          role="group"
        >
          <span
            className="openbitfun-chat-input__voice-pill-status"
            data-openbitfun-component="composer-voice-input"
            data-openbitfun-part="status"
            title={controller.lowVolumeWarning ? controller.lowVolumeTooltip : undefined}
            aria-hidden="true"
          >
            {preparing ? (
              <Icon glyph={Loader2} size="xs" className="openbitfun-chat-input__voice-spinner" />
            ) : controller.lowVolumeWarning ? (
              <Icon glyph={VolumeX} size="sm" className="openbitfun-chat-input__voice-low-volume" />
            ) : (
              <span className="openbitfun-chat-input__voice-pill-recording-dot" />
            )}
          </span>

          <span className="openbitfun-chat-input__voice-pill-time" data-openbitfun-component="composer-voice-input" data-openbitfun-part="time" aria-hidden="true">
            {formatElapsedTime(elapsedSeconds)}
          </span>

          <span
            className={`openbitfun-chat-input__voice-pill-timeline${recording ? '' : ' openbitfun-chat-input__voice-pill-timeline--paused'}`}
            data-openbitfun-component="composer-voice-input"
            data-openbitfun-part="timeline"
            aria-hidden="true"
          >
            {visibleTimelineSamples.map((sample, index) => {
              const scale = Math.max(0.12, Math.min(1, 0.12 + sample * 0.88));
              return (
                <span
                  key={index}
                  className="openbitfun-chat-input__voice-pill-timeline-bar"
                  data-openbitfun-component="composer-voice-input"
                  data-openbitfun-part="timelineBar"
                  style={{
                    opacity: sample === 0 ? 0.32 : 0.82,
                    transform: `scaleY(${scale})`,
                  }}
                />
              );
            })}
          </span>

          <span className="openbitfun-chat-input__voice-pill-divider" data-openbitfun-component="composer-voice-input" data-openbitfun-part="divider" aria-hidden="true" />

          <span className="openbitfun-chat-input__voice-pill-action-shell" data-openbitfun-component="composer-voice-input" data-openbitfun-part="action" data-openbitfun-action="cancel" data-openbitfun-state={transcribing ? 'disabled' : undefined}>
            <Tooltip content={controller.cancelTooltip}>
              <ChatComposerActionButton
                aria-label={controller.cancelTooltip}
                className="openbitfun-chat-input__voice-pill-action openbitfun-chat-input__voice-pill-action--cancel"
                disabled={transcribing}
                onClick={(event) => {
                  event.stopPropagation();
                  controller.cancel();
                }}
                icon={<Icon name="xmark" size="md" />}
                variant="quiet"
              />
            </Tooltip>
          </span>

          <span className="openbitfun-chat-input__voice-pill-action-shell" data-openbitfun-component="composer-voice-input" data-openbitfun-part="action" data-openbitfun-action="transcribe" data-openbitfun-state={controlsDisabled ? 'disabled' : undefined}>
            <Tooltip content={controlsDisabled ? controller.tooltip : controller.transcribeTooltip}>
              <ChatComposerActionButton
                aria-label={controlsDisabled ? controller.tooltip : controller.transcribeTooltip}
                className="openbitfun-chat-input__voice-pill-action openbitfun-chat-input__voice-pill-action--transcribe"
                disabled={controlsDisabled}
                onClick={(event) => {
                  event.stopPropagation();
                  controller.transcribe();
                }}
                icon={transcribing && controller.completionMode === 'transcribe' ? (
                  <Loader2 size={15} className="openbitfun-chat-input__voice-spinner" />
                ) : (
                  <Icon name="check-line" size="md" />
                )}
                variant="fill"
              />
            </Tooltip>
          </span>

          <span className="openbitfun-chat-input__voice-pill-action-shell" data-openbitfun-component="composer-voice-input" data-openbitfun-part="action" data-openbitfun-action="send" data-openbitfun-state={controlsDisabled ? 'disabled' : undefined}>
            <Tooltip content={controlsDisabled ? controller.tooltip : controller.sendTooltip}>
              <ChatComposerActionButton
                aria-label={controlsDisabled ? controller.tooltip : controller.sendTooltip}
                className="openbitfun-chat-input__voice-pill-action openbitfun-chat-input__voice-pill-action--send"
                tone="danger"
                disabled={controlsDisabled}
                onClick={(event) => {
                  event.stopPropagation();
                  controller.transcribeAndSend();
                }}
                icon={transcribing && controller.completionMode === 'send' ? (
                  <Loader2 size={15} className="openbitfun-chat-input__voice-spinner" />
                ) : (
                  <Icon name="arrow-up" size="md" />
                )}
                variant="primary"
              />
            </Tooltip>
          </span>
        </span>
      </span>
    );
  }

  return (
    <span className="openbitfun-chat-input__voice-cluster" data-openbitfun-component="composer-voice-input" data-openbitfun-part="root" data-openbitfun-phase="idle">
      <span className="openbitfun-chat-input__voice-control-shell" data-openbitfun-component="composer-voice-input" data-openbitfun-part="control" data-openbitfun-state={controller.disabled ? 'disabled' : undefined}>
        <Tooltip content={controller.tooltip}>
          <IconButton
            aria-label={controller.tooltip}
            className="openbitfun-chat-input__voice-control"
            size="sm"
            disabled={controller.disabled}
            onClick={(event) => {
              event.stopPropagation();
              controller.toggle();
            }}
            icon={<Icon name="mic" size="sm" />}
          />
        </Tooltip>
      </span>
    </span>
  );
}
