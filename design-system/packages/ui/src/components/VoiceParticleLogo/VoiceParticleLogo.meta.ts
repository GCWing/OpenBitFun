import type { ComponentMeta } from "../../registry.types";

export const voiceParticleLogoMeta = {
  category: "feedback",
  name: "VoiceParticleLogo",
  description: "A particle logo with separate microphone and audible assistant speech responses, preserving the supplied motion model.",
  maturity: "stable",
  props: [
    { name: "readAudio", type: "VoiceParticleAudioReader" },
    { name: "active", type: "boolean", defaultValue: "true" },
    { name: "formation", type: "number (0 = solid, 1 = particles)", defaultValue: "1" },
  ],
  states: ["idle", "paused", "reduced-motion"],
  tokens: ["color.content.onDark", "color.content.onLight"],
} as const satisfies ComponentMeta;
