import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptMiniAppComposerMessage,
  completeMiniAppComposerMessage,
  postMiniAppComposerMessage,
  rejectPendingMiniAppComposerMessages,
  requestMiniAppComposerMessage,
} from './miniAppComposerMessages';
import { MINIAPP_COMPOSER_MESSAGE_EVENT } from './miniAppStore';
import type { MiniAppComposerMessageDetail } from './miniAppStore';
import type { ImageContext } from '@/shared/types/context';

const mocks = vi.hoisted(() => ({ readFile: vi.fn(), assertCurrent: vi.fn(), surfaceId: 'local', supported: false }));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: { invoke: vi.fn() } }));
vi.mock('@/infrastructure/peer-device/PeerConnectionManager', () => ({ peerConnectionManager: {
  get: () => ({ getState: () => ({ capabilities: { miniAppAgentImagesV1: mocks.supported } }) }),
} }));
vi.mock('@/infrastructure/api/service-api/WorkspaceAPI', () => ({
  workspaceAPI: { readFileContent: mocks.readFile },
}));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({
  getActiveSurfaceId: () => 'local',
  getActiveSurfaceScope: () => ({ surfaceId: mocks.surfaceId, assertCurrent: mocks.assertCurrent }),
  isLocalSurface: (surfaceId: string) => surfaceId === 'local',
}));
const image: ImageContext = {
  id: 'image-1', type: 'image', timestamp: 1, imagePath: '/host/reference.png',
  imageName: 'reference.png', fileSize: 3, mimeType: 'image/png', source: 'clipboard',
  isLocal: false, dataUrl: 'data:image/png;base64,YQ==',
};

class TestCustomEvent<T> extends Event {
  readonly detail: T;

  constructor(type: string, init?: CustomEventInit<T>) {
    super(type);
    this.detail = init?.detail as T;
  }
}

describe('MiniApp composer message lifecycle', () => {
  beforeEach(() => {
    mocks.readFile.mockReset();
    mocks.assertCurrent.mockReset();
    mocks.surfaceId = 'local';
    mocks.supported = false;
    const eventTarget = new EventTarget();
    Object.assign(eventTarget, {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    vi.stubGlobal('window', eventTarget);
    vi.stubGlobal('CustomEvent', TestCustomEvent);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds a unique request id and source to ordinary composer submissions', () => {
    let received: Record<string, unknown> | undefined;
    window.addEventListener(MINIAPP_COMPOSER_MESSAGE_EVENT, event => {
      received = (event as CustomEvent<Record<string, unknown>>).detail;
    });

    const requestId = postMiniAppComposerMessage({ token: 'ppt#1', text: 'build slides' });

    expect(received).toMatchObject({
      token: 'ppt#1',
      text: 'build slides',
      source: 'composer',
      requestId,
    });
  });

  it('settles a voice submission only from the runner that owns its token', async () => {
    let requestId = '';
    window.addEventListener(MINIAPP_COMPOSER_MESSAGE_EVENT, event => {
      requestId = (event as CustomEvent<{ requestId: string }>).detail.requestId;
    });

    const completion = requestMiniAppComposerMessage({
      token: 'ppt#1',
      source: 'realtime_voice',
      text: 'make page three visual',
    });

    expect(completeMiniAppComposerMessage('ppt#2', requestId)).toBe(false);
    expect(completeMiniAppComposerMessage('ppt#1', requestId)).toBe(true);
    await expect(completion).resolves.toBeUndefined();
  });

  it('propagates MiniApp callback failures to realtime voice', async () => {
    let requestId = '';
    window.addEventListener(MINIAPP_COMPOSER_MESSAGE_EVENT, event => {
      requestId = (event as CustomEvent<{ requestId: string }>).detail.requestId;
    });
    const completion = requestMiniAppComposerMessage({ token: 'ppt#1', text: 'build' });

    completeMiniAppComposerMessage('ppt#1', requestId, 'Deck generation failed');

    await expect(completion).rejects.toThrow('Deck generation failed');
  });

  it('stops waiting when the voice task is cancelled', async () => {
    const controller = new AbortController();
    const completion = requestMiniAppComposerMessage(
      { token: 'ppt#1', text: 'build' },
      controller.signal,
    );

    controller.abort();

    await expect(completion).rejects.toThrow('MiniApp message was cancelled');
  });

  it('fails pending work when the owning MiniApp releases its composer', async () => {
    const completion = requestMiniAppComposerMessage({ token: 'ppt#1', text: 'build' });

    rejectPendingMiniAppComposerMessages('ppt#1', 'MiniApp closed');

    await expect(completion).rejects.toThrow('MiniApp closed');
  });

  it.each([false, true])('prepares inline image pixels before delivering the composer request (file=%s)', async isLocal => {
    mocks.readFile.mockResolvedValue('YQ==');
    let received: MiniAppComposerMessageDetail | undefined;
    window.addEventListener(MINIAPP_COMPOSER_MESSAGE_EVENT, event => {
      received = (event as CustomEvent<MiniAppComposerMessageDetail>).detail;
      completeMiniAppComposerMessage(received.token, received.requestId!);
    });
    await requestMiniAppComposerMessage({
      token: 'ppt#1', text: 'Match #img:reference.png this design',
      displayText: 'Match #img:reference.png this design',
      contexts: [{ ...image, isLocal, dataUrl: isLocal ? undefined : image.dataUrl }],
    });
    expect(received?.text).toBe('Match this design');
    expect(received?.displayText).toBe('Match #img:reference.png this design');
    expect(received?.imageContexts).toEqual([expect.objectContaining({
      id: image.id, data_url: image.dataUrl, image_path: undefined, mime_type: 'image/png',
    })]);
  });

  it.each(['local', 'peer'])('preserves text paths and all five pasted images on %s', async surfaceId => {
    mocks.surfaceId = surfaceId;
    mocks.supported = true;
    const images = Array.from({ length: 5 }, (_, index) => ({
      ...image,
      id: `reference-${index}`,
      imageName: `reference-${index}.png`,
      dataUrl: `data:image/png;base64,${btoa(`image-${index}`)}`,
    }));
    const text = 'Use these references and read /workspace/deck-notes.md';
    let received: MiniAppComposerMessageDetail | undefined;
    window.addEventListener(MINIAPP_COMPOSER_MESSAGE_EVENT, event => {
      received = (event as CustomEvent<MiniAppComposerMessageDetail>).detail;
      acceptMiniAppComposerMessage(received.token, received.requestId!);
    });

    await requestMiniAppComposerMessage({
      token: 'ppt#1',
      text: `${text}\n${images.map(item => `#img:${item.imageName}`).join(' ')}`,
      contexts: images,
    }, undefined, { resolveOnAgentRun: true });

    expect(received?.text).toBe(text);
    expect(received?.imageContexts).toHaveLength(5);
    expect(received?.imageContexts?.map(item => [item.id, item.data_url, item.metadata?.name]))
      .toEqual(images.map(item => [item.id, item.dataUrl, item.imageName]));
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('keeps image-only input sendable after removing the inline pill', async () => {
    window.addEventListener(MINIAPP_COMPOSER_MESSAGE_EVENT, event => {
      const detail = (event as CustomEvent<MiniAppComposerMessageDetail>).detail;
      expect(detail.text.trim()).not.toBe('');
      expect(detail.text).not.toContain('#img:');
      expect(detail.imageContexts).toHaveLength(1);
      completeMiniAppComposerMessage(detail.token, detail.requestId!);
    });
    await requestMiniAppComposerMessage({ token: 'ppt#1', text: '#img:reference.png', contexts: [image] });
  });

  it.each(['read failure', 'surface changed'])('does not dispatch an incomplete image submission after %s', async reason => {
    const dispatched = vi.fn();
    window.addEventListener(MINIAPP_COMPOSER_MESSAGE_EVENT, dispatched);
    mocks.readFile.mockResolvedValue('YQ==');
    if (reason === 'read failure') mocks.readFile.mockRejectedValue(new Error(reason));
    else mocks.assertCurrent.mockImplementation(() => { throw new Error(reason); });
    await expect(requestMiniAppComposerMessage({
      token: 'ppt#1', text: 'Reference', contexts: [{ ...image, isLocal: true, dataUrl: undefined }],
    })).rejects.toThrow(reason);
    expect(dispatched).not.toHaveBeenCalled();
  });

  it('unlocks typed input when the Agent accepts the turn but keeps voice waiting', async () => {
    const ids: string[] = [];
    window.addEventListener(MINIAPP_COMPOSER_MESSAGE_EVENT, event => {
      ids.push((event as CustomEvent<MiniAppComposerMessageDetail>).detail.requestId!);
    });
    const typed = requestMiniAppComposerMessage({
      token: 'ppt#1', text: 'build',
      imageContexts: [{ id: image.id, data_url: image.dataUrl, mime_type: image.mimeType }],
    }, undefined, { resolveOnAgentRun: true });
    const voice = requestMiniAppComposerMessage({ token: 'ppt#1', text: 'build', source: 'realtime_voice' });
    expect(acceptMiniAppComposerMessage('other', ids[0])).toBe(false);
    expect(acceptMiniAppComposerMessage('ppt#1', ids[0])).toBe(true);
    expect(acceptMiniAppComposerMessage('ppt#1', ids[1])).toBe(false);
    await expect(typed).resolves.toBeUndefined();
    expect(completeMiniAppComposerMessage('ppt#1', ids[1])).toBe(true);
    await expect(voice).resolves.toBeUndefined();
  });

  it('rejects image input before an older peer MiniApp SDK can ignore it', async () => {
    mocks.surfaceId = 'old-peer';
    const dispatched = vi.fn();
    window.addEventListener(MINIAPP_COMPOSER_MESSAGE_EVENT, dispatched);
    await expect(requestMiniAppComposerMessage({ token: 'ppt#1', text: 'look', contexts: [image] }))
      .rejects.toThrow('miniapp_agent_images_v1_unsupported');
    expect(dispatched).not.toHaveBeenCalled();
  });

  it('keeps plain typed input usable with old peer SDKs that cannot acknowledge Agent acceptance', async () => {
    mocks.surfaceId = 'old-peer';
    const dispatched = vi.fn();
    window.addEventListener(MINIAPP_COMPOSER_MESSAGE_EVENT, dispatched);
    await expect(requestMiniAppComposerMessage(
      { token: 'ppt#1', text: 'text only' }, undefined, { resolveOnAgentRun: true },
    )).resolves.toBeUndefined();
    expect(dispatched).toHaveBeenCalledTimes(1);
  });

  it('delivers pixels to a negotiated peer without uploading a controller path', async () => {
    mocks.surfaceId = 'peer';
    mocks.supported = true;
    window.addEventListener(MINIAPP_COMPOSER_MESSAGE_EVENT, event => {
      const detail = (event as CustomEvent<MiniAppComposerMessageDetail>).detail;
      expect(detail.imageContexts?.[0].data_url).toBe(image.dataUrl);
      expect(detail.imageContexts?.[0].image_path).toBeUndefined();
      completeMiniAppComposerMessage(detail.token, detail.requestId!);
    });
    await requestMiniAppComposerMessage({ token: 'ppt#1', text: 'look', contexts: [image] });
    expect(mocks.readFile).not.toHaveBeenCalled();
  });
});
