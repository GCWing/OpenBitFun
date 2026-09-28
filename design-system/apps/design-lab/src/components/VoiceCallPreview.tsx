import { useState } from "react";
import { Button, VoiceCallPanel, type VoiceCallPhase } from "@openbitfun/ui";
import { VoiceParticleLogo } from "@openbitfun/ui/brand";
import { useI18n } from "../i18n";
import "./VoiceCallPreview.css";

/** Both catalog and workbench consume the published components, without simulated audio. */
export function VoiceCallPreview({ state = "live", compact = false }: { state?: string; compact?: boolean }) {
  const { t } = useI18n();
  const [muted, setMuted] = useState(state === "muted");
  const [closed, setClosed] = useState(false);
  const [settingsRequested, setSettingsRequested] = useState(false);
  const phase: VoiceCallPhase = state === "connecting" || state === "ending" || state === "error" ? state : "live";
  return <div className={compact ? "lab-voice-call-preview lab-voice-call-preview--compact" : "lab-voice-call-preview"}>
    {closed ? <Button onClick={() => setClosed(false)}>{t("voice.preview.reopen")}</Button> : <VoiceCallPanel
      title={t("voice.preview.title")}
      labels={{
        back: t("voice.preview.back"), close: t("components.preview.close"), mute: t("voice.preview.mute"),
        unmute: t("voice.preview.unmute"), settings: t("voice.preview.settings"), end: t("voice.preview.end")
      }}
      phase={phase} muted={muted} userTranscript={t("voice.preview.user")} assistantTranscript={t("voice.preview.assistant")}
      status={settingsRequested ? t("voice.preview.settingsRequested") : phase === "live" ? undefined : t(`voice.preview.${phase}`)}
      onBack={() => setClosed(true)} onClose={() => setClosed(true)} onEnd={() => setClosed(true)}
      onToggleMute={() => setMuted(value => !value)} onOpenSettings={() => setSettingsRequested(value => !value)}
    />}
  </div>;
}

export function VoiceParticlePreview({ active = true }: { active?: boolean }) {
  return <div className="lab-voice-particle-preview"><VoiceParticleLogo active={active} /></div>;
}
