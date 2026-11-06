import { expect, it, vi } from 'vitest';
import { createOffscreenGpu } from './browserOffscreenGpu';

it('reuses the canvas and texture across intermediate widths and uploads damage at its native coordinates', () => {
  const gl = {
    createProgram: () => ({}), createTexture: () => ({}), createShader: () => ({}),
    shaderSource: vi.fn(), compileShader: vi.fn(), attachShader: vi.fn(), deleteShader: vi.fn(),
    linkProgram: vi.fn(), getProgramParameter: () => true, useProgram: vi.fn(), bindTexture: vi.fn(),
    texParameteri: vi.fn(), texImage2D: vi.fn(), texSubImage2D: vi.fn(),
    getUniformLocation: () => ({}), getParameter: () => 4096, uniform2f: vi.fn(),
    viewport: vi.fn(), drawArrays: vi.fn(), isContextLost: () => false,
    deleteProgram: vi.fn(), deleteTexture: vi.fn(),
    NO_ERROR: 0, getError: () => 0,
    get drawingBufferWidth() { return canvas.width; },
    get drawingBufferHeight() { return canvas.height; },
  };
  const canvas = { getContext: () => gl, width: 300, height: 150 };
  const gpu = createOffscreenGpu(canvas as unknown as HTMLCanvasElement)!;
  gpu.draw(540, 300, 0, 0, 540, 300, new Uint8Array(540 * 300 * 4));
  expect([canvas.width, canvas.height]).toEqual([768, 512]);
  gpu.draw(600, 300, 0, 0, 600, 300, new Uint8Array(600 * 300 * 4));
  expect([canvas.width, canvas.height]).toEqual([768, 512]);
  const bgra = new Uint8Array([48, 32, 16, 255]);
  gpu.draw(600, 300, 8, 17, 1, 1, bgra);

  expect(gl.texImage2D).toHaveBeenCalledOnce();
  expect(gl.texImage2D.mock.calls[0].slice(3, 5)).toEqual([768, 512]);
  expect(gl.texSubImage2D.mock.lastCall?.slice(2, 6)).toEqual([8, 17, 1, 1]);
  expect(gl.texSubImage2D.mock.lastCall?.at(-1)).toBe(bgra);
  expect(gl.viewport).toHaveBeenLastCalledWith(0, 212, 600, 300);
  expect(gl.uniform2f).toHaveBeenLastCalledWith(expect.anything(), 600 / 768, 300 / 512);
  gpu.dispose();
  expect(gl.deleteTexture).toHaveBeenCalledOnce();
});
