import { type HTMLAttributes, type ReactNode } from "react";
import { classNames } from "../../internal/classNames";
import { VoiceParticleLogo, type VoiceParticleAudioReader } from "../VoiceParticleLogo";
import styles from "./VoiceCallPanel.module.css";
import { VoiceCallTranscript, type VoiceTranscriptEntry } from "./VoiceCallTranscript";
import { VoiceCallControls } from "./VoiceCallControls";
import { VoiceCallHeader } from "./VoiceCallHeader";

export type VoiceCallPhase = "connecting" | "live" | "ending" | "error";
export interface VoiceCallLabels {
  back: string;
  close: string;
  mute: string;
  unmute: string;
  settings: string;
  end: string;
}
export interface VoiceCallPanelProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  title: string;
  labels: VoiceCallLabels;
  phase?: VoiceCallPhase;
  muted?: boolean;
  userTranscript?: string;
  assistantTranscript?: string;
  /** Localized connection, error or task status supplied by the application. */
  status?: ReactNode;
  readAudio?: VoiceParticleAudioReader;
  /** Embedded content delegates surface paint and corner geometry to its host. */
  presentation?: 'card' | 'embedded';
  onBack: () => void;
  onClose: () => void;
  onToggleMute: () => void;
  onOpenSettings: () => void;
  onEnd: () => void;
}

/** Controlled call presentation. Contains no routes, stores, locale catalogs or media APIs. */
export function VoiceCallPanel({
  title, labels, phase = "live", muted = false, userTranscript, assistantTranscript,
  status, readAudio, presentation = 'card', onBack, onClose, onToggleMute, onOpenSettings, onEnd, className, ...props
}: VoiceCallPanelProps) {
  const entries: VoiceTranscriptEntry[] = [];
  if (userTranscript) entries.push({ id: 'user', role: 'user', content: userTranscript });
  if (assistantTranscript) entries.push({ id: 'assistant', role: 'assistant', content: assistantTranscript });

  return (
    <section {...props} className={classNames(styles.root, presentation === 'embedded' && styles.embedded, className)} aria-label={title}
      data-openbitfun-component="voice-call-panel" data-openbitfun-part="root" data-openbitfun-phase={phase}>
      <VoiceCallHeader title={title} labels={labels} phase={phase} onBack={onBack} onClose={onClose} />

      <div className={styles.visualizer} data-openbitfun-part="visualizer">
        <VoiceParticleLogo readAudio={readAudio} active={phase === "live" || phase === "connecting"} />
      </div>

      <VoiceCallTranscript entries={entries} status={status} />
      <VoiceCallControls labels={labels} phase={phase} muted={muted}
        onToggleMute={onToggleMute} onOpenSettings={onOpenSettings} onEnd={onEnd} />
    </section>
  );
}
