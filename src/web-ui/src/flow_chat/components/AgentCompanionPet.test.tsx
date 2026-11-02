// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCompanionPetSelection } from '@/infrastructure/config/services/AIExperienceConfigService';
import { getPetSpriteLayout } from '@/infrastructure/config/services/agentCompanionPetSprite';
import { AgentCompanionPet } from './AgentCompanionPet';

const { resolvePet } = vi.hoisted(() => ({ resolvePet: vi.fn() }));
vi.mock('@/infrastructure/config/services/AgentCompanionPetService', () => ({ resolveAgentCompanionPet: resolvePet }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const pet: AgentCompanionPetSelection = {
  id: 'sample', displayName: 'Sample', source: 'preset', packagePath: '/sample',
  spritesheetPath: '/sample/spritesheet.webp', spritesheetMimeType: 'image/webp', spriteVersionNumber: 2,
};

let root: Root;
let container: HTMLDivElement;
let reduceMotion: (event?: unknown) => void;
let media: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  media = { matches: false, addEventListener: vi.fn((_event, listener) => { reduceMotion = listener; }), removeEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  vi.stubGlobal('Image', class {
    naturalWidth = 1536;
    naturalHeight = 2288;
    onload: (() => void) | null = null;
    set src(_value: string) { this.onload?.(); }
  });
  resolvePet.mockImplementation(async (selection: AgentCompanionPetSelection) => ({
    src: selection.spritesheetPath, layout: getPetSpriteLayout(selection.spriteVersionNumber),
  }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function sprite() {
  return container.querySelector<HTMLElement>('[data-openbitfun-part="petdex"]')!;
}

describe('pet sprite renderer', () => {
  it('keeps built-in BitBlob motion in the atlas across session states', async () => {
    const bitblob = { ...pet, id: 'bitblob' };
    for (const mood of ['rest', 'hover', 'working', 'waiting', 'analyzing', 'dragging'] as const) {
      await act(async () => root.render(<AgentCompanionPet pet={bitblob} mood={mood} />));
      expect(sprite().style.animationName).toBe('openbitfun-petdex-walk');
      expect(sprite().style.imageRendering).toBe('auto');
    }
    await act(async () => root.render(<AgentCompanionPet pet={bitblob} mood="rest" action="jumping" />));
    expect(sprite().dataset.petAction).toBe('jumping');
    expect(sprite().style.animationDuration).toBe('1.2s');
    await act(async () => root.render(<AgentCompanionPet pet={bitblob} mood="rest" lookDirection={4} />));
    expect(sprite().style.animation).toBe('none');
    // A user pet with the same id must retain its own/default presentation.
    await act(async () => root.render(<AgentCompanionPet pet={{ ...bitblob, source: 'user' }} mood="working" />));
    expect(sprite().style.animationName).toBe('');
    await act(async () => root.render(<AgentCompanionPet pet={pet} mood="working" />));
    expect(sprite().style.animationName).toBe('');
  });

  it.each([1, 2])('plays all three standard actions with v%s frame geometry and keeps drag priority', async version => {
    vi.useFakeTimers();
    vi.stubGlobal('Image', class {
      naturalWidth = 1536;
      naturalHeight = version === 1 ? 1872 : 2288;
      onload: (() => void) | null = null;
      set src(_value: string) { this.onload?.(); }
    });
    const selection = { ...pet, spriteVersionNumber: version };
    await act(async () => root.render(<AgentCompanionPet pet={selection} mood="rest" action="waving" lookDirection={12} />));
    expect(sprite().dataset.petAction).toBe('waving');
    expect(parseFloat(sprite().style.backgroundPositionY)).toBeCloseTo(3 / (version === 1 ? 8 : 10) * 100);
    expect(sprite().style.getPropertyValue('--openbitfun-petdex-frames')).toBe('4');
    await act(async () => root.render(<AgentCompanionPet pet={selection} mood="rest" />));
    expect(sprite().dataset.petAction).toBeUndefined();
    for (const [action, row, frames] of [['jumping', 4, 5], ['failed', 5, 8]] as const) {
      await act(async () => root.render(<AgentCompanionPet pet={selection} mood="rest" action={action} lookDirection={12} />));
      expect(parseFloat(sprite().style.backgroundPositionY)).toBeCloseTo(row / (version === 1 ? 8 : 10) * 100);
      expect(sprite().style.getPropertyValue('--openbitfun-petdex-frames')).toBe(String(frames));
      expect(sprite().style.animation).not.toBe('none');
    }
    await act(async () => root.render(<AgentCompanionPet pet={selection} mood="dragging" action="failed" />));
    expect(sprite().dataset.petAction).toBeUndefined();
    expect(parseFloat(sprite().style.backgroundPositionY)).toBeCloseTo(2 / (version === 1 ? 8 : 10) * 100);
    await act(async () => root.render(<AgentCompanionPet pet={selection} mood="dragging" dragDirection="right" action="waving" />));
    expect(parseFloat(sprite().style.backgroundPositionY)).toBeCloseTo(1 / (version === 1 ? 8 : 10) * 100);
    await act(async () => root.render(<AgentCompanionPet pet={selection} mood="working" action="jumping" />));
    expect(sprite().dataset.petAction).toBe('jumping');
  });
  it('renders v2 at its native cell size, with complete eight-frame drag animation', async () => {
    const onSize = vi.fn();
    await act(async () => root.render(<AgentCompanionPet pet={pet} mood="dragging" nativePetdexSize petdexScale={0.5} onPetFrameSizeChange={onSize} lookDirection={12} />));
    expect(onSize).toHaveBeenLastCalledWith({ width: 96, height: 104 });
    expect(sprite().style.backgroundSize).toBe('800% 1100%');
    expect(sprite().style.backgroundPositionY).toBe('20%');
    expect(sprite().style.getPropertyValue('--openbitfun-petdex-frames')).toBe('8');
    expect(sprite().style.animation).not.toBe('none');
  });

  it('scales an oversized native cell down into the max box, keeping its aspect ratio', async () => {
    vi.stubGlobal('Image', class {
      // v2 atlas with 512x512 cells: 256x256 at half scale, wider than the box.
      naturalWidth = 8 * 512;
      naturalHeight = 11 * 512;
      onload: (() => void) | null = null;
      set src(_value: string) { this.onload?.(); }
    });
    const onSize = vi.fn();
    await act(async () => root.render(<AgentCompanionPet pet={pet} mood="rest" nativePetdexSize petdexScale={0.5} petdexMaxSize={{ width: 168, height: 234 }} onPetFrameSizeChange={onSize} />));
    expect(onSize).toHaveBeenLastCalledWith({ width: 168, height: 168 });
    const petRoot = sprite().parentElement!;
    expect(petRoot.style.getPropertyValue('--openbitfun-petdex-width')).toBe('168px');
    expect(petRoot.style.getPropertyValue('--openbitfun-petdex-height')).toBe('168px');

    // A cell that already fits keeps the requested scale.
    await act(async () => root.render(<AgentCompanionPet pet={pet} mood="rest" nativePetdexSize petdexScale={0.25} petdexMaxSize={{ width: 168, height: 234 }} onPetFrameSizeChange={onSize} />));
    expect(onSize).toHaveBeenLastCalledWith({ width: 128, height: 128 });
  });

  it('shows look frames only during idle and restores the action under reduced motion', async () => {
    await act(async () => root.render(<AgentCompanionPet pet={pet} mood="rest" lookDirection={12} />));
    expect(sprite().style.backgroundPositionY).toBe('100%');
    expect(parseFloat(sprite().style.backgroundPositionX)).toBeCloseTo(4 / 7 * 100);
    expect(sprite().style.animation).toBe('none');
    await act(async () => root.render(<AgentCompanionPet pet={pet} mood="hover" lookDirection={12} />));
    expect(sprite().style.backgroundPositionY).toBe('0%');
    expect(sprite().style.animation).not.toBe('none');
    await act(async () => root.render(<AgentCompanionPet pet={pet} mood="working" lookDirection={12} />));
    expect(sprite().style.backgroundPositionY).toBe('70%');
    expect(sprite().style.animation).not.toBe('none');
    await act(async () => root.render(<AgentCompanionPet pet={pet} mood="rest" lookDirection={12} />));
    act(() => { media.matches = true; reduceMotion(); });
    expect(sprite().style.backgroundPositionY).toBe('0%');
    expect(sprite().style.backgroundPositionX).toBe('');
  });

  it('reports invalid atlas dimensions without displaying a miscut sprite', async () => {
    await act(async () => root.render(<AgentCompanionPet pet={{ ...pet, spriteVersionNumber: 1 }} mood="rest" lookDirection={12} />));
    expect(sprite()).toBeNull();
    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('features.pet.loadFailed');
  });

  it('keeps v1 working after switching from v2', async () => {
    await act(async () => root.render(<AgentCompanionPet pet={pet} mood="rest" lookDirection={12} />));
    vi.stubGlobal('Image', class {
      naturalWidth = 1536;
      naturalHeight = 1872;
      onload: (() => void) | null = null;
      set src(_value: string) { this.onload?.(); }
    });
    await act(async () => root.render(<AgentCompanionPet pet={{ ...pet, spriteVersionNumber: undefined }} mood="analyzing" lookDirection={12} />));
    expect(sprite().style.backgroundSize).toBe('800% 900%');
    expect(sprite().style.backgroundPositionY).toBe('100%');
    expect(sprite().style.animation).not.toBe('none');
  });
});
