import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { VoiceCallPanel, VoiceParticleLogo, VoiceCallIdentity, VoiceCallTranscript } from "../dist/index.js";

const motionSource = await readFile(new URL("../src/components/VoiceParticleLogo/voiceParticleDynamics.ts", import.meta.url), "utf8");
const motionModule = ts.transpileModule(motionSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { VoiceParticleAudioState, particleForce, SILENT_VOICE_AUDIO } = await import(`data:text/javascript;base64,${Buffer.from(motionModule).toString("base64")}`);
const formationSource = await readFile(new URL("../src/components/VoiceParticleLogo/voiceParticleFormation.ts", import.meta.url), "utf8");
const formationModule = ts.transpileModule(formationSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { VoiceParticleFormation } = await import(`data:text/javascript;base64,${Buffer.from(formationModule).toString("base64")}`);

const labels = { back: "Back to chat", close: "Close window", mute: "Mute", unmute: "Unmute", settings: "Settings", end: "End call" };
const props = { title: "Live Call", labels, onBack() {}, onClose() {}, onToggleMute() {}, onOpenSettings() {}, onEnd() {} };

test("formation reverses from its current pose and reduced motion settles immediately", () => {
  const formation = new VoiceParticleFormation(0);
  formation.setTarget(1, 100);
  const midpoint = formation.sample(350);
  assert.ok(midpoint > 0 && midpoint < 1);
  formation.setTarget(0, 350);
  assert.equal(formation.sample(350), midpoint);
  assert.ok(formation.sample(450) < midpoint);
  assert.equal(formation.sample(830), 0);
  assert.equal(formation.moving, false);
  formation.setTarget(1, 900);
  assert.equal(formation.sample(901, true), 1);
  assert.equal(formation.moving, false);
  assert.equal(formation.sample(902), 1);
});

test("shared identity is an explicit keyboard action and transcript preserves authored entry identities", () => {
  const identity = renderToStaticMarkup(createElement(VoiceCallIdentity, { expanded: false, active: false, label: "Live voice", onClick() {} }));
  assert.match(identity, /aria-label="Live voice"/);
  assert.match(identity, /aria-expanded="false"/);
  const transcript = renderToStaticMarkup(createElement(VoiceCallTranscript, { entries: [
    { id: 'first:user', role: 'user', content: 'Hello' }, { id: 'first:assistant', role: 'assistant', content: 'Hi' },
  ] }));
  assert.match(transcript, /data-transcript-id="first:user"/);
  assert.match(transcript, /data-transcript-id="first:assistant"/);
  assert.doesNotMatch(transcript, /role="status"/);
});

test("call presentation exposes one title, full transcripts and five labeled controls without accessing media", () => {
  const markup = renderToStaticMarkup(createElement(VoiceCallPanel, { ...props, muted: true, userTranscript: "A <portfolio>", assistantTranscript: "Let's build it." }));
  assert.equal((markup.match(/<button/g) ?? []).length, 5);
  for (const label of [labels.back, labels.close, labels.unmute, labels.settings, labels.end]) assert.ok(markup.includes(`aria-label="${label}"`));
  assert.match(markup, /aria-pressed="true"/);
  assert.equal((markup.match(/<h2/g) ?? []).length, 1);
  assert.match(markup, /A &lt;portfolio&gt;/);
  assert.match(markup, /data-openbitfun-component="voice-particle-logo"/);
  assert.doesNotMatch(markup, /role="status"/);
});

test("ending disables mute, back and end while close and settings remain answerable", () => {
  const markup = renderToStaticMarkup(createElement(VoiceCallPanel, { ...props, phase: "ending", status: "Ending call" }));
  assert.equal((markup.match(/disabled=""/g) ?? []).length, 3);
  assert.match(markup, /role="status"/);
  assert.match(markup, /data-openbitfun-phase="ending"/);
  const logo = renderToStaticMarkup(createElement(VoiceParticleLogo, { active: false }));
  assert.match(logo, /aria-hidden="true"/);
});

test("microphone and playback have distinct envelopes and decay to rest after a disconnect", () => {
  const human = new VoiceParticleAudioState();
  const assistant = new VoiceParticleAudioState();
  const bins = new Uint8Array(128).fill(128);
  const input = human.update({ user: bins, assistant: null, assistantSpeaking: false }, 1000);
  assert.ok(Math.abs(input.base - 0.22768941176470586) < 1e-12);
  assert.equal(input.ai, 0);
  let output = assistant.update({ user: null, assistant: bins, assistantSpeaking: true }, 1000);
  assert.equal(output.base, 0);
  assert.ok(output.ai > 0);
  // Muting the user must not mute the assistant's live output.
  output = assistant.update({ user: null, assistant: bins, assistantSpeaking: true }, 1020);
  assert.ok(output.ai > input.ai);
  for (let frame = 0; frame < 300; frame++) output = assistant.update(SILENT_VOICE_AUDIO, 1040 + frame * 1000 / 60);
  assert.equal(assistant.mode, "idle");
  assert.ok(output.ai < 1e-12);
});

test("resting logo does not fabricate speech energy", () => {
  const audio = new VoiceParticleAudioState();
  for (let time = 0; time < 5000; time += 1000 / 60) {
    assert.deepEqual(audio.update(SILENT_VOICE_AUDIO, time), { base: 0, ai: 0, aiBreath: 0, demo: 0 });
  }
  const point = { x: 230, y: 160, seed: 318, motionSpeed: 0.0021, motionPhase: 1.4 };
  const anchor = { x: 240, y: 180 };
  const quiet = particleForce(point, anchor, 2200, { base: 0, ai: 0, aiBreath: 0, demo: 0 });
  const speech = particleForce(point, anchor, 2200, { base: 0.7, ai: 0, aiBreath: 0, demo: 0 });
  const playback = particleForce(point, anchor, 2200, { base: 0, ai: 1.1, aiBreath: 0.5, demo: 0 });
  // Numerical snapshots evaluated from the original supplied Demo, before porting.
  const referenceForces = [
    { ax: -0.05157967464930556, ay: 0.03950864110909674 },
    { ax: -0.009936700842296173, ay: -0.01836414095695415 },
    { ax: -0.38992882124664424, ay: 0.18309865278790052 },
  ];
  [quiet, speech, playback].forEach((force, index) => {
    assert.ok(Math.abs(force.ax - referenceForces[index].ax) < 1e-14);
    assert.ok(Math.abs(force.ay - referenceForces[index].ay) < 1e-14);
  });
  assert.notDeepEqual(quiet, speech);
  assert.notDeepEqual(speech, playback);
  for (const force of [quiet, speech, playback]) assert.ok(Number.isFinite(force.ax) && Number.isFinite(force.ay));
});
