import type { ComponentMeta } from "../../registry.types";

export const voiceCallPanelMeta = {
  category: "feedback",
  name: "VoiceCallPanel",
  description: "A controlled live-call surface. VoiceCallIdentity, VoiceCallTranscript and VoiceCallControls also expose its shared anatomy for persistent text/voice hosts.",
  maturity: "stable",
  props: [
    { name: "title", type: "string" },
    { name: "labels", type: "VoiceCallLabels" },
    { name: "phase", type: "connecting | live | ending | error", defaultValue: "live" },
    { name: "muted", type: "boolean", defaultValue: "false" },
    { name: "userTranscript", type: "string" },
    { name: "assistantTranscript", type: "string" },
    { name: "status", type: "ReactNode" },
    { name: "readAudio", type: "VoiceParticleAudioReader" },
    { name: "presentation", type: "card | embedded", defaultValue: "card" },
    { name: "onBack / onClose / onToggleMute / onOpenSettings / onEnd", type: "() => void" },
  ],
  states: ["connecting", "live", "muted", "ending", "error"],
  tokens: [
    "color.content.onDark", "color.content.onLight",
    "type.heading.panel", "type.body.lg", "type.modifier.leading.tight",
    "type.flow.body", "type.flow.control", "type.flow.support",
    "color.content.primary", "color.content.secondary", "color.action.quiet.hover",
    "control.flowChat.cardRadius",
    "space.3", "space.6", "space.8", "radius.lg",
  ],
} as const satisfies ComponentMeta;
