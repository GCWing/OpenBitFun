import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Phone } from 'lucide-react';
import { OverflowText, IconButton, VoiceCallIdentity, VoiceCallControls, VoiceCallHeader } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';

import { RealtimeVoiceCallPanel } from './RealtimeVoiceCallPanel';
import { useRealtimeVoiceCall } from './RealtimeVoiceCallContext';
import type { VoiceCallTarget } from './voiceClientContext';
import { ConversationTextVisibilityContext } from '../../contexts/conversationViewScope';
import './ConversationModeSurface.scss';

interface ConversationModeSurfaceProps {
  children: ReactNode;
  className?: string;
  /** Captured conversation route; absence uses the default control conversation. */
  voiceTarget?: VoiceCallTarget;
  /** Prevents a MiniApp call from falling back to the workspace route while its session binds. */
  voiceStartDisabled?: boolean;
  switchTestId?: string;
  onCloseVoice?: () => void;
  /** Host chrome, including the logo control, is shown only in text mode. */
  renderHeader?: (modeSwitch: ReactNode) => ReactNode;
  onVoiceViewChange?: (visible: boolean) => void;
  /** A persistent transcript opts into the integrated identity; children become its composer.
   * A render function can follow the mode without remounting the reading viewport. */
  transcript?: ReactNode | ((mode: 'chat' | 'voice') => ReactNode);
  /** Secondary action in the compact conversation header. */
  headerAction?: ReactNode;
  requiresTextInput?: boolean;
  active?: boolean;
}

/**
 * Shared text/realtime-voice capability shell for compact conversation hosts.
 * Window-specific components own only their chrome and provide the text
 * surface; this component is the single owner of mode switching and voice UI.
 */
export function ConversationModeSurface({
  children,
  className,
  voiceTarget,
  voiceStartDisabled = false,
  switchTestId,
  onCloseVoice,
  renderHeader,
  onVoiceViewChange,
  transcript,
  headerAction,
  requiresTextInput = false,
  active = true,
}: ConversationModeSurfaceProps) {
  const { t } = useI18n('settings/voice-input');
  const controller = useRealtimeVoiceCall();
  const {
    enabled,
    phase,
    target,
    start: startVoiceCall,
    end: endVoiceCall,
  } = controller;
  const integrated = transcript !== undefined;
  const ownsCall = phase !== 'idle' && (voiceTarget
    ? target?.sessionId === voiceTarget.sessionId && target?.surfaceId === voiceTarget.surfaceId
    : !voiceStartDisabled);
  const [showVoice, setShowVoice] = useState(ownsCall);
  const isVoiceMode = ownsCall && showVoice;
  const composerRef = useRef<HTMLDivElement>(null);
  const voiceHeaderRef = useRef<HTMLDivElement>(null);
  const [restartTarget, setRestartTarget] = useState<VoiceCallTarget | null>(null);
  useLayoutEffect(() => {
    if (composerRef.current) composerRef.current.inert = isVoiceMode;
    if (voiceHeaderRef.current) voiceHeaderRef.current.inert = !isVoiceMode;
  }, [isVoiceMode]);
  useEffect(() => { if (requiresTextInput) setShowVoice(false); }, [requiresTextInput]);
  useEffect(() => {
    if (!restartTarget || phase !== 'idle') return;
    setRestartTarget(null);
    if (restartTarget.sessionId === voiceTarget?.sessionId && restartTarget.surfaceId === voiceTarget.surfaceId) startVoiceCall(restartTarget);
  }, [restartTarget, phase, voiceTarget, startVoiceCall]);
  useLayoutEffect(() => { onVoiceViewChange?.(isVoiceMode); }, [isVoiceMode, onVoiceViewChange]);
  const showModeSwitch = (enabled || ownsCall) && !isVoiceMode && !renderHeader;

  const handleModeSwitch = useCallback(() => {
    if (integrated && ownsCall && phase === 'error' && voiceTarget) {
      setRestartTarget(voiceTarget);
      setShowVoice(true);
      endVoiceCall();
      return;
    }
    if (isVoiceMode) { setShowVoice(false); return; }
    if (requiresTextInput) return;
    if (voiceStartDisabled && !ownsCall) return;
    if (!enabled && !ownsCall) { startVoiceCall(voiceTarget); return; }
    if (phase !== 'idle' && !ownsCall) return;
    setShowVoice(true);
    if (!ownsCall) startVoiceCall(voiceTarget);
  }, [enabled, startVoiceCall, voiceStartDisabled, voiceTarget, ownsCall, phase, isVoiceMode, integrated, endVoiceCall, requiresTextInput]);

  return (
    <div
      className={[
        'openbitfun-conversation-mode-surface',
        className,
        integrated && 'openbitfun-conversation-mode-surface--integrated',
      ].filter(Boolean).join(' ')}
      data-openbitfun-component="conversation-mode-surface"
      data-openbitfun-part="root"
      data-openbitfun-state={isVoiceMode ? 'voice' : 'chat'}
    >
      {!isVoiceMode && renderHeader?.(integrated ? null : <IconButton
        size="sm"
        data-testid={switchTestId}
        icon={<span className="openbitfun-conversation-mode-surface__logo" aria-hidden="true" />}
        aria-label={t(isVoiceMode ? 'voiceCall.call.switchToChat' : 'voiceCall.call.switchToVoice')}
        aria-pressed={isVoiceMode}
        title={t(isVoiceMode ? 'voiceCall.call.switchToChat' : 'voiceCall.call.switchToVoice')}
        disabled={!ownsCall && (voiceStartDisabled || phase !== 'idle')}
        onClick={handleModeSwitch}
      />)}
      {integrated && <div ref={voiceHeaderRef} className="openbitfun-conversation-mode-surface__voice-header" aria-hidden={!isVoiceMode}
        data-openbitfun-component="conversation-mode-surface" data-openbitfun-part="voiceHeader">
        <div className="openbitfun-conversation-mode-surface__voice-header-content">
          <VoiceCallHeader title={t('voiceCall.call.title')} phase={phase === 'idle' ? 'live' : phase}
            labels={{ back: t('voiceCall.call.switchToChat'), close: t('voiceCall.call.close') }}
            onBack={() => setShowVoice(false)} onClose={onCloseVoice ?? controller.end} />
        </div>
      </div>}
      <div
        className="openbitfun-conversation-mode-surface__body"
        data-openbitfun-component="conversation-mode-surface"
        data-openbitfun-part="body"
      >
        {integrated && <VoiceCallIdentity expanded={isVoiceMode} active={active && ownsCall && phase === 'live'}
          leading={headerAction}
          readAudio={ownsCall ? controller.readAudio : undefined}
          label={t(ownsCall && phase === 'error' ? 'voiceCall.call.identity.retry'
              : ownsCall ? phase === 'connecting' ? 'voiceCall.call.identity.connecting' : 'voiceCall.call.identity.ongoing'
                : 'voiceCall.call.identity.start')}
          disabled={!isVoiceMode && requiresTextInput || !ownsCall && (voiceStartDisabled || phase !== 'idle')}
          onClick={handleModeSwitch} />}
        {integrated ? (typeof transcript === 'function' ? transcript(isVoiceMode ? 'voice' : 'chat') : transcript)
          : isVoiceMode && <RealtimeVoiceCallPanel embedded={Boolean(renderHeader)} onClose={onCloseVoice} onBack={() => setShowVoice(false)} />}
        {integrated && ownsCall && <VoiceCallControls phase={phase} muted={controller.muted}
          compact={!isVoiceMode}
          labels={{ back: t('voiceCall.call.switchToChat'), close: t('voiceCall.call.close'), mute: t('voiceCall.call.mute'),
            unmute: t('voiceCall.call.unmute'), settings: t('voiceCall.call.settings'), end: t('voiceCall.call.hangUp') }}
          onToggleMute={controller.toggleMute} onOpenSettings={controller.openSettings} onEnd={controller.end} />}
        <ConversationTextVisibilityContext.Provider value={!isVoiceMode}>
          {integrated ? <div ref={composerRef} className="openbitfun-conversation-mode-surface__composer" aria-hidden={isVoiceMode}
            data-openbitfun-component="conversation-mode-surface" data-openbitfun-part="composer">
            <div className="openbitfun-conversation-mode-surface__composer-content">{children}</div>
          </div> : <div hidden={isVoiceMode} style={{ display: isVoiceMode ? 'none' : 'contents' }}>{children}</div>}
        </ConversationTextVisibilityContext.Provider>
      </div>

      {showModeSwitch && !integrated ? (
        <footer
          className="openbitfun-conversation-mode-surface__switch"
          data-openbitfun-component="conversation-mode-surface"
          data-openbitfun-part="modeSwitch"
        >
          <button data-overflow-trigger
            type="button"
            className="openbitfun-conversation-mode-surface__switch-button"
            data-testid={switchTestId}
            data-openbitfun-component="conversation-mode-surface"
            data-openbitfun-part="modeSwitchButton"
            disabled={!ownsCall && (voiceStartDisabled || phase !== 'idle')}
            onClick={handleModeSwitch}
          >
            <Phone size={15} aria-hidden="true" />
            <OverflowText>
              {t('voiceCall.call.switchToVoice')}
            </OverflowText>
          </button>
        </footer>
      ) : null}
    </div>
  );
}
