// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GrokLivePet, grokStateForMood } from './GrokLivePet';
import * as player from './grok-live/grok-player.js';
import { readGrokLiveSettings, saveGrokLiveSettings, subscribeGrokLiveSettings } from './grok-live/grokLiveSettings';
import { GROK_LIVE_PET } from '@/infrastructure/config/services/AgentCompanionPetService';
import { isGrokLivePet } from '@/infrastructure/config/services/grokLivePetIdentity';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const queuedFrames = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  queuedFrames.clear();
  nextFrameId = 0;
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextFrameId;
    queuedFrames.set(id, callback);
    return id;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { queuedFrames.delete(id); }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('renders a live black SVG sphere with two opaque white eyes and cleans up', async () => {
  expect(isGrokLivePet(GROK_LIVE_PET)).toBe(true);
  expect(isGrokLivePet({ ...GROK_LIVE_PET, source: 'user' })).toBe(false);
  await act(async () => root.render(<GrokLivePet mood="rest" nativePetdexSize />));
  const stage = host.querySelector('.openbitfun-grok-live__stage')!;
  const svg = stage.querySelector('svg[id^="gp"]')!;
  expect(svg).toBeTruthy();
  const eyePath = svg.querySelector('path[fill="#ffffff"][d]:not([d=""])')!;
  expect(eyePath).toBeTruthy();
  expect(eyePath.getAttribute('d')!.match(/M/g)?.length).toBeGreaterThanOrEqual(2);
  expect(svg.querySelectorAll('path[fill="#000000"][d]:not([d=""])').length).toBeGreaterThan(0);
  expect(svg.querySelector('path[mask]')).toBeNull();
  act(() => root.unmount());
  expect(host.querySelector('svg')).toBeNull();
  root = createRoot(host);
});

it('maps live task moods to existing recipe states', () => {
  expect(grokStateForMood('rest')).toBe('idle');
  expect(grokStateForMood('analyzing')).toBe('thinking');
  expect(grokStateForMood('working')).toBe('coding');
  expect(grokStateForMood('waiting', true, true)).toBe('waiting');
  expect(grokStateForMood('waiting', false, true)).toBe('working');
  expect(grokStateForMood('dragging')).toBe('dragging');
});

it('routes desktop gaze coordinates to the player without enabling webview pointer follow', async () => {
  const create = vi.spyOn(player, 'createGrokBot');
  await act(async () => root.render(<GrokLivePet mood="rest" gaze={null} />));
  const bot = create.mock.results[0].value as player.GrokBot;
  const setGaze = vi.spyOn(bot, 'setGaze');
  await act(async () => root.render(<GrokLivePet mood="rest" gaze={[0.25, -0.5]} />));
  expect(setGaze).toHaveBeenCalledWith([0.25, -0.5]);
  expect(create).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({ follow: false }));
});

it('updates live SVG frames for a task and pauses while hidden', async () => {
  await act(async () => root.render(<GrokLivePet mood="rest" nativePetdexSize />));
  const svg = host.querySelector('svg[id^="gp"]')!;
  const body = svg.querySelector('path[fill="#000000"][d]:not([d=""])')!;
  const before = body.getAttribute('d');
  await act(async () => root.render(<GrokLivePet mood="analyzing" nativePetdexSize />));
  const start = performance.now();
  for (let frame = 1; frame <= 40; frame++) {
    const next = queuedFrames.entries().next().value as [number, FrameRequestCallback] | undefined;
    expect(next).toBeDefined();
    queuedFrames.delete(next![0]);
    next![1](start + frame * 12);
  }
  expect(body.getAttribute('d')).not.toBe(before);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(queuedFrames.size).toBe(0);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(queuedFrames.size).toBeGreaterThan(0);
  act(() => root.unmount());
  expect(queuedFrames.size).toBe(0);
  root = createRoot(host);
});

it('returns to the latest mood after failure and keeps accepting mood updates', async () => {
  vi.useFakeTimers();
  const create = vi.spyOn(player, 'createGrokBot');
  await act(async () => root.render(<GrokLivePet mood="working" action="failed" />));
  const bot = create.mock.results[0].value as player.GrokBot;
  expect(bot.state).toBe('failed');
  await act(async () => root.render(<GrokLivePet mood="analyzing" action="failed" />));
  expect(bot.state).toBe('failed');
  act(() => vi.advanceTimersByTime(1650));
  expect(bot.state).toBe('thinking');
  await act(async () => root.render(<GrokLivePet mood="working" action="failed" />));
  expect(bot.state).toBe('coding');
  expect(create).toHaveBeenCalledTimes(1);
});

it('keeps the fallback when synchronous initialization fails', async () => {
  vi.spyOn(player, 'createGrokBot').mockImplementation(() => { throw new Error('test initialization failure'); });
  await act(async () => root.render(<GrokLivePet mood="rest" />));
  expect(host.querySelector('.openbitfun-grok-live__fallback')).toBeTruthy();
  expect(host.querySelector('[aria-label="GrokLive (animation unavailable)"]')).toBeTruthy();
});

it('does not follow the pointer or schedule frames with reduced motion', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const listener = vi.spyOn(window, 'addEventListener');
  await act(async () => root.render(<GrokLivePet mood="working" />));
  expect(queuedFrames.size).toBe(0);
  expect(listener.mock.calls.some(([name]) => name === 'pointermove')).toBe(false);
});

it('persists settings and notifies live subscribers', () => {
  const onChange = vi.fn();
  const unsubscribe = subscribeGrokLiveSettings(onChange);
  saveGrokLiveSettings({ fps: '60', follow: false, size: 112 });
  expect(readGrokLiveSettings()).toMatchObject({ fps: '60', follow: false, size: 112 });
  expect(onChange).toHaveBeenCalled();
  unsubscribe();
});
