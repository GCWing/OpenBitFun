/** Motion coefficients and FFT envelopes ported from the supplied Voice-Particles-Demo. */
export interface Point { x: number; y: number }
export interface ParticleMotion extends Point { motionSpeed: number; motionPhase: number; seed: number }
export interface VoiceParticleAudio {
  /** FFT byte bins (fftSize 256), sampled from capture before muting or from audible playback. */
  user: Uint8Array | null;
  assistant: Uint8Array | null;
  assistantSpeaking: boolean;
}
export type VoiceParticleAudioReader = () => VoiceParticleAudio;
export const SILENT_VOICE_AUDIO: VoiceParticleAudio = { user: null, assistant: null, assistantSpeaking: false };
export const effectProfiles = {
  human: { strength: 1.4, motion: 1.2, density: 1.4, brightness: 1 },
  ai: { strength: 2.1, motion: 1.6, density: 1.5, brightness: 1.2 },
} as const;
export const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export interface VoiceEnergy { base: number; ai: number; aiBreath: number; demo: number }

function spectrum(data: Uint8Array) {
  let sum = 0, peak = 0;
  for (const byte of data) {
    const value = byte / 255;
    sum += value;
    if (value > peak) peak = value;
  }
  return { average: data.length ? sum / data.length : 0, peak };
}

/** Renderer-local envelopes avoid React updates at audio/frame frequency. No simulated speech. */
export class VoiceParticleAudioState {
  mode: 'idle' | 'speech' | 'ai' = 'idle';
  private micLevel = 0;
  private aiActivity = 0;
  private aiAudioLevel = 0;
  private previousAiAudioLevel = 0;
  private aiBreathPulse = 0;
  private aiPulse = 0;

  update(audio: VoiceParticleAudio, time: number): VoiceEnergy {
    this.mode = audio.assistantSpeaking ? 'ai' : audio.user ? 'speech' : 'idle';
    if (audio.user) {
      const { average, peak } = spectrum(audio.user);
      this.micLevel = lerp(this.micLevel, Math.max(average * 1.8, peak * 0.85), 0.18);
      this.aiActivity = Math.max(this.aiActivity, peak * 0.45);
    } else {
      this.micLevel *= 0.92;
    }
    if (audio.assistant) {
      const { average, peak } = spectrum(audio.assistant);
      this.aiAudioLevel = lerp(this.aiAudioLevel, Math.max(average * 1.7, peak * 1.15), 0.24);
      this.aiActivity = Math.max(this.aiActivity, average * 1.7, peak * 1.15);
    } else {
      this.aiAudioLevel *= 0.9;
    }
    if (this.mode === 'ai') {
      const breathGap = this.previousAiAudioLevel > 0.12 && this.aiAudioLevel < 0.07 ? 0.76 : 0;
      this.aiBreathPulse = Math.max(this.aiBreathPulse * 0.955, breathGap);
      this.previousAiAudioLevel = this.aiAudioLevel;
      this.aiActivity *= 0.965;
      const breathing = 0.18 + Math.sin(time * 0.010) * 0.07;
      this.aiPulse = lerp(this.aiPulse, Math.max(0.18, this.aiActivity + breathing), 0.16);
    } else {
      this.aiActivity *= 0.9;
      this.aiPulse *= 0.88;
      this.aiAudioLevel *= 0.88;
      this.aiBreathPulse *= 0.88;
      this.previousAiAudioLevel = this.aiAudioLevel;
    }
    return {
      base: clamp(this.micLevel * effectProfiles.human.strength, 0, 1.4),
      ai: clamp(this.aiPulse * effectProfiles.ai.strength, 0, 2.2),
      aiBreath: clamp(this.aiBreathPulse * effectProfiles.ai.strength, 0, 1.5),
      demo: 0,
    };
  }
}

export function particleForce(p: ParticleMotion, anchor: Point, time: number, energy: VoiceEnergy) {
  const dx = anchor.x - p.x;
  const dy = anchor.y - p.y;
  const dist = Math.max(1, Math.hypot(dx, dy));
  const nx = dx / dist;
  const ny = dy / dist;
  const tx = -ny;
  const ty = nx;
  const individualPhase = time * p.motionSpeed + p.motionPhase;
  const orbit = Math.sin(individualPhase) * 0.7 + Math.cos(individualPhase * 0.63 + 1.4) * 0.35;
  const localWave = Math.sin(individualPhase * 0.8 + dist * 0.08) * 0.18;
  let ax = dx * 0.0008 + tx * (0.045 + orbit * 0.03) + nx * localWave * 0.025;
  let ay = dy * 0.0008 + ty * (0.045 + orbit * 0.03) + ny * localWave * 0.025;

  // A shared travelling field gives the cloud a direction without synchronising particles.
  const wavePhase = time * (0.007 + energy.base * 0.001) + anchor.y * 0.014;
  const humanMotion = energy.base * effectProfiles.human.motion;
  const aiMotion = energy.ai * effectProfiles.ai.motion;
  const breathFlow = energy.aiBreath * effectProfiles.ai.motion;
  const directionWave = Math.sin(wavePhase) * (0.08 + humanMotion * 0.16 + aiMotion * 0.24 + energy.demo * 0.28);
  const crossWave = Math.cos(wavePhase * 0.73 + anchor.x * 0.004) * (0.025 + humanMotion * 0.06 + aiMotion * 0.1);
  ax += directionWave * 0.32;
  ay += crossWave;

  // AI breath is a short, local airflow disturbance instead of a global size pulse.
  const airflowPhase = time * 0.015 + p.seed * 0.11 + anchor.x * 0.012;
  const airflowCurl = Math.sin(airflowPhase) * breathFlow;
  const airflowDrift = Math.cos(airflowPhase * 0.71 + anchor.y * 0.008) * breathFlow;
  ax += tx * airflowCurl * 0.14 + nx * airflowDrift * 0.035;
  ay += ty * airflowCurl * 0.14 + ny * airflowDrift * 0.035;

  // Moving pressure lanes compress a small portion of particles into turbulent beams.
  const beamPhase = anchor.x * 0.024 - anchor.y * 0.017 - time * 0.006;
  const beamCompression = Math.cos(beamPhase)
    * (energy.aiBreath * 0.85 + energy.ai * 0.18)
    * effectProfiles.ai.motion;
  ax += 0.82 * beamCompression * 0.12;
  ay -= 0.57 * beamCompression * 0.12;

  // Speech/AI amplify each particle's own response rather than moving the whole shape as one body.
  const responsePhase = individualPhase * 1.7 + anchor.x * 0.011;
  const response = Math.sin(responsePhase) * (humanMotion * 0.08 + aiMotion * 0.18 + energy.demo * 0.2);
  ax += tx * response;
  ay += ty * response;
  return { ax, ay };
}
