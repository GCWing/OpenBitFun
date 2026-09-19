// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareUpdateDownloadHandoff, runUpdateDownloadHandoff } from './updateDownloadMotion';

let card: HTMLDivElement;
let source: HTMLButtonElement;
let target: HTMLButtonElement;
let vessel: HTMLSpanElement;
let transfer: HTMLSpanElement;
let releaseOrigin: (() => void) | undefined;
let stopMotion: (() => void) | undefined;
let reduced = false;
let onPreference: (() => void) | undefined;
let originalAnimate: PropertyDescriptor | undefined;
const motions: { element: Element; frames: Keyframe[]; finish: () => void; cancel: ReturnType<typeof vi.fn> }[] = [];

beforeEach(() => {
  reduced = false;
  onPreference = undefined;
  motions.length = 0;
  card = document.createElement('div');
  source = document.createElement('button');
  card.append(source);
  target = document.createElement('button');
  vessel = document.createElement('span');
  target.append(vessel);
  transfer = document.createElement('span');
  document.body.append(card, target, transfer);
  target.style.setProperty('--openbitfun-motion-duration-slow', '420ms');
  target.style.setProperty('--openbitfun-motion-duration-base', '220ms');
  vi.spyOn(source, 'getBoundingClientRect').mockReturnValue(new DOMRect(180, 600, 120, 28));
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(160, 680, 28, 28));
  vi.stubGlobal('matchMedia', () => ({
    get matches() { return reduced; },
    addEventListener: (_: string, callback: () => void) => { onPreference = callback; },
    removeEventListener: vi.fn(),
  }));
  originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: function (this: Element, frames: Keyframe[]) {
    let finish!: () => void;
    let reject!: (error: Error) => void;
    const finished = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; });
    const cancel = vi.fn(() => reject(new Error('cancelled')));
    motions.push({ element: this, frames, finish, cancel });
    return { finished, cancel };
  } });
});

afterEach(() => {
  stopMotion?.();
  releaseOrigin?.();
  stopMotion = undefined;
  releaseOrigin = undefined;
  card.remove(); target.remove(); transfer.remove();
  if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate);
  else Reflect.deleteProperty(Element.prototype, 'animate');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('connects the clicked button to the actual navigation position before completing the handoff', async () => {
  const arrive = vi.fn();
  releaseOrigin = prepareUpdateDownloadHandoff(source, card, '2.0.0', false);
  stopMotion = runUpdateDownloadHandoff('2.0.0', target, vessel, transfer, arrive);
  expect(motions).toHaveLength(2);
  expect(target.style.visibility).toBe('hidden');
  expect(motions[0].frames[0].transform).toContain('translate(240px, 614px)');
  expect(motions[0].frames.at(-1)?.transform).toContain('translate(174px, 694px)');
  expect(arrive).not.toHaveBeenCalled();
  motions[1].finish();
  await Promise.resolve(); await Promise.resolve();
  expect(target.style.visibility).toBe('hidden');
  expect(arrive).not.toHaveBeenCalled();
  motions[0].finish();
  await Promise.resolve(); await Promise.resolve();
  expect(arrive).toHaveBeenCalledOnce();
  expect(target.style.visibility).toBe('');
  expect(motions[0].cancel).toHaveBeenCalledOnce();
  expect(motions.at(-1)?.element).toBe(vessel);
  expect(runUpdateDownloadHandoff('2.0.0', target, vessel, transfer, arrive)).toBeUndefined();
});

it('cancels obsolete arrivals when the download or navigation is replaced', async () => {
  const arrive = vi.fn();
  target.style.visibility = 'visible';
  releaseOrigin = prepareUpdateDownloadHandoff(source, card, '2.0.0', false);
  stopMotion = runUpdateDownloadHandoff('2.0.0', target, vessel, transfer, arrive);
  expect(target.style.visibility).toBe('hidden');
  stopMotion?.();
  expect(target.style.visibility).toBe('visible');
  motions.forEach(motion => motion.finish());
  await Promise.resolve(); await Promise.resolve();
  expect(arrive).not.toHaveBeenCalled();
  expect(motions.every(motion => motion.cancel.mock.calls.length > 0)).toBe(true);
});

it('keeps the card when the navigation destination is hidden', () => {
  const arrive = vi.fn();
  vi.mocked(target.getBoundingClientRect).mockReturnValue(new DOMRect());
  releaseOrigin = prepareUpdateDownloadHandoff(source, card, '2.0.0', false);
  stopMotion = runUpdateDownloadHandoff('2.0.0', target, vessel, transfer, arrive);
  expect(arrive).not.toHaveBeenCalled();
  expect(motions).toHaveLength(0);
  expect(target.style.visibility).toBe('');
});

it('hands keyboard focus to the progress control without spatial motion', () => {
  source.focus();
  const arrive = vi.fn();
  releaseOrigin = prepareUpdateDownloadHandoff(source, card, '2.0.0', true);
  stopMotion = runUpdateDownloadHandoff('2.0.0', target, vessel, transfer, arrive);
  expect(document.activeElement).toBe(target);
  expect(target.style.visibility).toBe('');
  expect(arrive).toHaveBeenCalledOnce();
  expect(motions).toHaveLength(0);
});

it('honors reduced motion both before and during a transfer', async () => {
  const arrive = vi.fn();
  reduced = true;
  releaseOrigin = prepareUpdateDownloadHandoff(source, card, '2.0.0', false);
  stopMotion = runUpdateDownloadHandoff('2.0.0', target, vessel, transfer, arrive);
  expect(target.style.visibility).toBe('');
  expect(arrive).toHaveBeenCalledOnce();
  expect(motions).toHaveLength(0);
  stopMotion?.();
  reduced = false;
  releaseOrigin = prepareUpdateDownloadHandoff(source, card, '2.0.0', false);
  stopMotion = runUpdateDownloadHandoff('2.0.0', target, vessel, transfer, arrive);
  expect(target.style.visibility).toBe('hidden');
  reduced = true;
  onPreference?.();
  await Promise.resolve(); await Promise.resolve();
  expect(arrive).toHaveBeenCalledTimes(2);
  expect(target.style.visibility).toBe('');
  expect(motions.every(motion => motion.cancel.mock.calls.length > 0)).toBe(true);
});

it('reveals the control when a resize interrupts the transfer', async () => {
  const arrive = vi.fn();
  releaseOrigin = prepareUpdateDownloadHandoff(source, card, '2.0.0', false);
  stopMotion = runUpdateDownloadHandoff('2.0.0', target, vessel, transfer, arrive);
  expect(target.style.visibility).toBe('hidden');
  window.dispatchEvent(new Event('resize'));
  await Promise.resolve(); await Promise.resolve();
  expect(target.style.visibility).toBe('');
  expect(arrive).toHaveBeenCalledOnce();
  expect(motions.every(motion => motion.cancel.mock.calls.length > 0)).toBe(true);
});

it('completes the handoff if the browser cancels an animation', async () => {
  const arrive = vi.fn();
  releaseOrigin = prepareUpdateDownloadHandoff(source, card, '2.0.0', false);
  stopMotion = runUpdateDownloadHandoff('2.0.0', target, vessel, transfer, arrive);
  motions[0].cancel();
  await Promise.resolve(); await Promise.resolve();
  expect(target.style.visibility).toBe('');
  expect(arrive).toHaveBeenCalledOnce();
});

it('does not use an origin for another version or after the request has been cancelled', () => {
  const arrive = vi.fn();
  releaseOrigin = prepareUpdateDownloadHandoff(source, card, '2.0.0', false);
  expect(runUpdateDownloadHandoff('3.0.0', target, vessel, transfer, arrive)).toBeUndefined();
  releaseOrigin();
  expect(runUpdateDownloadHandoff('2.0.0', target, vessel, transfer, arrive)).toBeUndefined();
  expect(arrive).not.toHaveBeenCalled();
});
