import { ArrowLeft, X } from "lucide-react";
import { OverflowText } from "../../primitives/OverflowText";
import { IconButton } from "../IconButton";
import { Tooltip } from "../Tooltip";
import type { VoiceCallLabels, VoiceCallPhase } from "./VoiceCallPanel";
import styles from "./VoiceCallPanel.module.css";

export interface VoiceCallHeaderProps {
  title: string;
  labels: Pick<VoiceCallLabels, "back" | "close">;
  phase?: VoiceCallPhase;
  onBack: () => void;
  onClose: () => void;
}

/** Shared call navigation, including the original circular back action. */
export function VoiceCallHeader({ title, labels, phase = "live", onBack, onClose }: VoiceCallHeaderProps) {
  return <header className={styles.header} data-openbitfun-component="voice-call-panel" data-openbitfun-part="header">
    <Tooltip content={labels.back}>
      <IconButton className={styles.back} shape="circle" aria-label={labels.back}
        onClick={onBack} disabled={phase === "ending"} icon={<ArrowLeft size={20} />} />
    </Tooltip>
    <h2 className={styles.title} data-openbitfun-part="title"><OverflowText>{title}</OverflowText></h2>
    <Tooltip content={labels.close}>
      <IconButton className={styles.close} shape="circle" aria-label={labels.close}
        onClick={onClose} icon={<X size={20} />} />
    </Tooltip>
  </header>;
}
