import { afterEach, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { compileWorkspaceLatex } from './LatexAPI';

const host = vi.hoisted(() => ({ invoke: vi.fn(), supportsPreview: false }));
vi.mock('./ApiClient', () => ({ api: { invoke: host.invoke } }));
vi.mock('@/infrastructure/peer-device/PeerConnectionManager', () => ({
  peerConnectionManager: {
    get: () => ({
      getState: () => ({
        capabilities: host.supportsPreview ? { workspaceLatexPreviewV1: true } : {},
      }),
    }),
  },
}));

afterEach(() => {
  activateSurface('local');
  host.supportsPreview = false;
  host.invoke.mockReset();
});

it('keeps an older peer on the source-only path and dispatches only to an advertising host', async () => {
  const origin = { surfaceId: 'peer-a', workspaceId: 'paper-id', workspacePath: '/remote/paper' };
  const path = '/remote/paper/main.tex';
  activateSurface('peer-a');
  await expect(compileWorkspaceLatex(origin, path, 'xelatex')).rejects.toThrow('does not support');
  expect(host.invoke).not.toHaveBeenCalled();

  host.supportsPreview = true;
  host.invoke.mockResolvedValue({ pdfBase64: 'compiled-preview' });
  await expect(compileWorkspaceLatex(origin, path, 'xelatex')).resolves.toEqual({ pdfBase64: 'compiled-preview' });
  expect(host.invoke).toHaveBeenCalledExactlyOnceWith('compile_workspace_latex', {
    request: { workspaceId: 'paper-id', filePath: path, engine: 'xelatex' },
  });

  activateSurface('peer-b');
  await expect(compileWorkspaceLatex(origin, path, 'xelatex')).rejects.toThrow('unavailable');
  expect(host.invoke).toHaveBeenCalledTimes(1);
});
