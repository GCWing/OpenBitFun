import { VoiceCallPanel } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { useRealtimeVoiceCall } from './RealtimeVoiceCallContext';

interface RealtimeVoiceCallPanelProps {
  /** The compact host owns closing/collapsing its window. */
  onClose?: () => void;
  onBack?: () => void;
  embedded?: boolean;
}

/** Product binding only; the published design-system component owns the full call anatomy. */
export function RealtimeVoiceCallPanel({ onClose, onBack, embedded = false }: RealtimeVoiceCallPanelProps) {
  const { t } = useI18n('settings/voice-input');
  const controller = useRealtimeVoiceCall();
  const status = controller.notice || (controller.phase !== 'live'
    || controller.taskPhase
    || (!controller.userTranscript && !controller.assistantTranscript)
    ? controller.status
    : undefined);

  return <VoiceCallPanel
    presentation={embedded ? 'embedded' : 'card'}
    data-openbitfun-product-component="realtime-voice-call"
    data-openbitfun-product-part="root"
    data-openbitfun-phase={controller.phase}
    data-openbitfun-state={[controller.phase, controller.taskPhase?.replace(/_/g, '-')].filter(Boolean).join(' ')}
    aria-description={controller.status}
    title={t('voiceCall.call.title')}
    labels={{
      back: t('voiceCall.call.switchToChat'),
      close: t('voiceCall.call.close'),
      mute: t('voiceCall.call.mute'),
      unmute: t('voiceCall.call.unmute'),
      settings: t('voiceCall.call.settings'),
      end: t('voiceCall.call.hangUp'),
    }}
    phase={controller.phase === 'idle' ? 'ending' : controller.phase}
    muted={controller.muted}
    userTranscript={controller.userTranscript}
    assistantTranscript={controller.assistantTranscript}
    status={status}
    readAudio={controller.readAudio}
    onBack={onBack ?? controller.end}
    onClose={onClose ?? controller.end}
    onToggleMute={controller.toggleMute}
    onOpenSettings={controller.openSettings}
    onEnd={controller.end}
  />;
}
