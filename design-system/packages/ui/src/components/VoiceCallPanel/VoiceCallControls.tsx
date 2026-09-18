import { Mic, MicOff, Phone, SlidersHorizontal } from "lucide-react";
import { IconButton } from "../IconButton";
import { Tooltip } from "../Tooltip";
import type { VoiceCallLabels, VoiceCallPhase } from "./VoiceCallPanel";
import styles from "./VoiceCallPanel.module.css";
import { classNames } from "../../internal/classNames";

export interface VoiceCallControlsProps {
  labels: VoiceCallLabels;
  phase: VoiceCallPhase;
  muted: boolean;
  compact?: boolean;
  onToggleMute: () => void;
  onOpenSettings: () => void;
  onEnd: () => void;
}

export function VoiceCallControls({ labels, phase, muted, compact, onToggleMute, onOpenSettings, onEnd }: VoiceCallControlsProps) {
  return <footer className={classNames(styles.controls, compact && styles.compactControls)} data-openbitfun-component="voice-call-panel" data-openbitfun-part="controls">
    <Tooltip content={muted ? labels.unmute : labels.mute}>
      <IconButton className={styles.control} shape="circle" aria-label={muted ? labels.unmute : labels.mute}
        aria-pressed={muted} disabled={phase === "connecting" || phase === "ending"} onClick={onToggleMute}
        icon={muted ? <MicOff size={28} /> : <Mic size={28} />} />
    </Tooltip>
    <Tooltip content={labels.settings}>
      <IconButton className={styles.control} shape="circle" aria-label={labels.settings}
        onClick={onOpenSettings} icon={<SlidersHorizontal size={28} />} />
    </Tooltip>
    <Tooltip content={labels.end}>
      <IconButton className={styles.control} shape="circle" aria-label={labels.end}
        disabled={phase === "ending"} onClick={onEnd} icon={<Phone size={28} />} />
    </Tooltip>
  </footer>;
}
