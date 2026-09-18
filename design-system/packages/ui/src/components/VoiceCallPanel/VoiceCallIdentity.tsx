import { useEffect, useState, type ReactNode } from "react";
import { VoiceParticleLogo, type VoiceParticleAudioReader } from "../VoiceParticleLogo";
import { OverflowText } from "../../primitives/OverflowText";
import { Button } from "../Button";
import styles from "./VoiceCallIdentity.module.css";

export interface VoiceCallIdentityProps {
  expanded: boolean;
  active: boolean;
  label: string;
  /** Optional secondary action in the compact identity row. */
  leading?: ReactNode;
  disabled?: boolean;
  readAudio?: VoiceParticleAudioReader;
  onClick: () => void;
}

/** A persistent identity above the transcript, expanding on the same axis. */
export function VoiceCallIdentity({ expanded, active, label, leading, disabled, readAudio, onClick }: VoiceCallIdentityProps) {
  const [hovered, setHovered] = useState(false);
  const previewActive = hovered && !expanded && !disabled;

  useEffect(() => {
    if (expanded || disabled) setHovered(false);
  }, [expanded, disabled]);

  return <div className={styles.root} data-expanded={expanded} data-disabled={!expanded && disabled || undefined}
    data-openbitfun-component="voice-call-panel" data-openbitfun-part="identity">
    {leading && <div className={styles.leading} hidden={expanded}>{leading}</div>}
    <div className={styles.content} data-overflow-trigger>
      <span className={styles.artwork}>
        <VoiceParticleLogo className={styles.logo} active={expanded ? active : previewActive}
          readAudio={expanded ? readAudio : undefined} />
      </span>
      <span className={styles.label} hidden={expanded} aria-hidden="true"><OverflowText>{label}</OverflowText></span>
      <Button className={styles.action} size="sm" variant="fill" labelBehavior="static"
        data-hovered={previewActive || undefined}
        onPointerEnter={event => {
          if (event.pointerType === "mouse" && !disabled) setHovered(true);
        }}
        onPointerLeave={() => setHovered(false)} onPointerCancel={() => setHovered(false)}
        hidden={expanded} disabled={disabled} onClick={onClick} aria-label={label} aria-expanded={expanded}>
        {null}
      </Button>
    </div>
  </div>;
}
