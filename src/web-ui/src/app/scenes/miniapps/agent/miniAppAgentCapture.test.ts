/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';

import { captureSurface } from './miniAppAgentCapture';
import type { MiniAppAgentDomSurface } from './miniAppAgentDomRuntime';
import { MiniAppAgentSurfaceError } from './miniAppAgentProtocol';

function createSurface(html: string): MiniAppAgentDomSurface {
  const doc = document.implementation.createHTMLDocument('MiniApp');
  doc.body.innerHTML = html;
  const iframe = { contentDocument: doc } as unknown as HTMLIFrameElement;
  return { appId: 'demo', iframe };
}

/**
 * jsdom has no 2D canvas backend, so the capture path runs against a stub that
 * records what the runtime drew and returns a bounded data URL.
 */
function stubCanvas(
  payload: number | ((width: number) => number),
): { drawn: { width: number; height: number }[]; restore: () => void } {
  const prototype = HTMLCanvasElement.prototype;
  const contextDescriptor = Object.getOwnPropertyDescriptor(prototype, 'getContext');
  const dataUrlDescriptor = Object.getOwnPropertyDescriptor(prototype, 'toDataURL');
  const drawn: { width: number; height: number }[] = [];

  Object.defineProperty(prototype, 'getContext', {
    configurable: true,
    value: () => ({
      drawImage: (_source: unknown, _x: number, _y: number, width: number, height: number) => {
        drawn.push({ width, height });
      },
    }),
  });
  Object.defineProperty(prototype, 'toDataURL', {
    configurable: true,
    value: (type: string) => {
      const width = drawn[drawn.length - 1]?.width ?? 0;
      const size = typeof payload === 'function' ? payload(width) : payload;
      return `data:${type};base64,${'A'.repeat(Math.max(0, size))}`;
    },
  });

  return {
    drawn,
    restore: () => {
      if (contextDescriptor) Object.defineProperty(prototype, 'getContext', contextDescriptor);
      else delete (prototype as unknown as Record<string, unknown>).getContext;
      if (dataUrlDescriptor) Object.defineProperty(prototype, 'toDataURL', dataUrlDescriptor);
      else delete (prototype as unknown as Record<string, unknown>).toDataURL;
    },
  };
}

describe('MiniApp agent capture', () => {
  it('captures the largest canvas, scaled into the observation bound', async () => {
    const stub = stubCanvas(64);
    try {
      const surface = createSurface(`
        <canvas id="background" width="40" height="40"></canvas>
        <canvas id="game" width="1600" height="1200"></canvas>
      `);
      const capture = await captureSurface(surface, 900);

      expect(capture.label).toBe('#game');
      expect(capture.source).toBe('canvas');
      expect(capture.width).toBe(900);
      expect(capture.height).toBe(675);
      // A scaled-down frame ships as JPEG: smaller payload, same observation.
      expect(capture.mimeType).toBe('image/jpeg');
      expect(stub.drawn).toEqual([{ width: 900, height: 675 }]);
      expect(capture.dataBase64.length).toBe(64);
    } finally {
      stub.restore();
    }
  });

  it('never upscales a small canvas and keeps text-crisp PNG output', async () => {
    const stub = stubCanvas(32);
    try {
      const surface = createSurface('<canvas id="board" width="320" height="240"></canvas>');
      const capture = await captureSurface(surface, 900);

      expect(capture.width).toBe(320);
      expect(capture.height).toBe(240);
      expect(capture.mimeType).toBe('image/png');
    } finally {
      stub.restore();
    }
  });

  it('steps the frame down when one capture exceeds the payload limit', async () => {
    const limit = Math.ceil((1_500_000 / 3) * 4);
    // The 900px export overflows the limit, so the runtime retries smaller.
    const stub = stubCanvas((width) => (width >= 900 ? limit + 16 : 128));
    try {
      const surface = createSurface('<canvas id="game" width="1600" height="1200"></canvas>');
      const capture = await captureSurface(surface, 900);

      expect(stub.drawn.length).toBeGreaterThan(1);
      expect(capture.width).toBeLessThan(900);
    } finally {
      stub.restore();
    }
  });

  it('reports an app that paints no canvas instead of inventing pixels', async () => {
    const surface = createSurface('<main><button>Start</button></main>');
    await expect(captureSurface(surface, 900)).rejects.toMatchObject({
      code: 'CAPABILITY_MISSING',
    });
  });

  it('reports an unreadable frame instead of an empty capture', async () => {
    const iframe = Object.defineProperty({}, 'contentDocument', {
      get() {
        throw new Error('Blocked a frame with origin from accessing a cross-origin frame');
      },
    }) as unknown as HTMLIFrameElement;
    await expect(captureSurface({ appId: 'opaque', iframe }, 900)).rejects.toBeInstanceOf(
      MiniAppAgentSurfaceError,
    );
  });
});
