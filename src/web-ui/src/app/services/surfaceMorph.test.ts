// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { morphFromOrigin, rememberMorphOrigin } from './surfaceMorph';

function element(rect: Partial<DOMRect>) {
  const node = document.createElement('div');
  node.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, ...rect }) as DOMRect;
  node.animate = vi.fn() as never;
  node.getAnimations = () => [];
  return node;
}

describe('surfaceMorph', () => {
  it('grows the claiming surface from the remembered origin once', () => {
    rememberMorphOrigin('dialog', element({ left: 10, top: 400, width: 300, height: 400 }));
    const surface = element({ left: 100, top: 100, width: 900, height: 600 });
    surface.appendChild(element({}));
    expect(morphFromOrigin('dialog', surface)).toBe(true);
    const [frames] = (surface.animate as ReturnType<typeof vi.fn>).mock.calls[0];
    // A window of the origin's size, moved onto it, released to the surface's own.
    expect(frames[0].transform).toBe('translate(-90px, 300px)');
    expect(frames[0].clipPath).toBe('inset(0 600px 200px 0 round 0px)');
    expect(frames[1].clipPath).toBe('inset(0 0 0 0 round 0px)');
    // Claimed: a second surface keeps its own entrance.
    expect(morphFromOrigin('dialog', element({ width: 10, height: 10 }))).toBe(false);
  });

  it('leaves a still copy of the origin until the surface claims it', () => {
    const card = element({ left: 10, top: 400, width: 300, height: 400 });
    document.body.appendChild(card);
    rememberMorphOrigin('dialog', card);
    card.remove();
    expect(document.body.children).toHaveLength(1);
    morphFromOrigin('dialog', element({ left: 100, top: 100, width: 900, height: 600 }));
  });

  it('ignores an origin left for another surface', () => {
    rememberMorphOrigin('other', element({ width: 10, height: 10 }));
    expect(morphFromOrigin('dialog', element({ width: 10, height: 10 }))).toBe(false);
  });
});
