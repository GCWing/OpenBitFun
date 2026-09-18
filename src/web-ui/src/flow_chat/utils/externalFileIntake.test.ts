import { describe, expect, it, vi } from 'vitest';
import type { FileMetadata } from '@/infrastructure/api/service-api/WorkspaceAPI';
import type { ContextItem } from '@/shared/types/context';
import {
  buildExternalFileContexts,
  normalizeExternalFilePath,
  partitionExternalDropFiles,
  resolveExternalFileIntakeAvailability,
  shouldAttemptNativeClipboardImageRead,
} from './externalFileIntake';

const metadata = (isDir: boolean, size = 12): FileMetadata => ({
  path: '',
  modified: 0,
  size,
  isFile: !isDir,
  isDir,
});

const build = (
  paths: string[],
  existingContexts: ContextItem[] = [],
  loadMetadata = vi.fn(async (path: string) => metadata(path.endsWith('/dir'))),
) => buildExternalFileContexts({
  source: 'drop',
  paths,
  existingContexts,
  workspacePath: '/workspace',
  maxImageCount: 2,
  loadMetadata,
});

describe('external file intake availability', () => {
  it.each([
    [{ desktopRuntime: false, remoteWorkspace: false, peerDevice: false, detachedDispatch: false }, 'web'],
    [{ desktopRuntime: true, remoteWorkspace: true, peerDevice: false, detachedDispatch: false }, 'remote-workspace'],
    [{ desktopRuntime: true, remoteWorkspace: false, peerDevice: true, detachedDispatch: false }, 'peer-device'],
    [{ desktopRuntime: true, remoteWorkspace: false, peerDevice: false, detachedDispatch: true }, 'detached-dispatch'],
  ] as const)('rejects unsupported data planes', (environment, reason) => {
    expect(resolveExternalFileIntakeAvailability(environment)).toEqual({ supported: false, reason });
  });

  it('accepts Desktop local execution', () => {
    expect(resolveExternalFileIntakeAvailability({
      desktopRuntime: true,
      remoteWorkspace: false,
      peerDevice: false,
      detachedDispatch: false,
    })).toEqual({ supported: true });
  });
});

describe('external browser drop fallback', () => {
  const droppedFile = (name: string, type: string, path?: string) => ({ name, type, path }) as File;

  it('uses exposed paths and keeps only pathless images as byte fallbacks', () => {
    const pathImage = droppedFile('photo.png', 'image/png', 'C:\\tmp\\photo.png');
    const pathlessImage = droppedFile('capture.png', 'image/png');
    const pathlessDocument = droppedFile('report.pdf', 'application/pdf');

    expect(partitionExternalDropFiles(
      [pathImage, pathlessImage, pathlessDocument],
      true,
    )).toEqual({
      paths: ['C:\\tmp\\photo.png'],
      fallbackImages: [pathlessImage],
      hasUnavailableFiles: true,
    });
  });

  it('uses image bytes instead of controller paths on unsupported data planes', () => {
    const image = droppedFile('photo.png', 'image/png', '/tmp/photo.png');
    const document = droppedFile('report.pdf', 'application/pdf', '/tmp/report.pdf');

    expect(partitionExternalDropFiles([image, document], false)).toEqual({
      paths: ['/tmp/photo.png', '/tmp/report.pdf'],
      fallbackImages: [image],
      hasUnavailableFiles: false,
    });
  });
});

describe('buildExternalFileContexts', () => {
  it('normalizes POSIX and Windows paths for deduplication', async () => {
    expect(normalizeExternalFilePath('C:\\Users\\Me\\file.txt')).toBe('c:/users/me/file.txt');
    expect(normalizeExternalFilePath('/tmp/file.txt/')).toBe('/tmp/file.txt');
    expect(normalizeExternalFilePath('/')).toBe('/');
    expect(normalizeExternalFilePath('C:\\')).toBe('c:/');
    expect(normalizeExternalFilePath('\\\\Server\\Share\\File.txt')).toBe('//server/share/file.txt');

    const result = await build(['C:\\Users\\Me\\file.txt', 'c:/users/me/file.txt']);
    expect(result.contexts).toHaveLength(1);
    expect(result.duplicateCount).toBe(1);
  });

  it('keeps case-distinct POSIX siblings outside the workspace', async () => {
    const result = await buildExternalFileContexts({
      source: 'drop',
      paths: ['/srv/repo/report.md'],
      existingContexts: [],
      workspacePath: '/srv/Repo',
      maxImageCount: 2,
      loadMetadata: async () => metadata(false),
    });

    expect(result.contexts[0]).toMatchObject({
      type: 'file',
      filePath: '/srv/repo/report.md',
      relativePath: undefined,
    });
  });

  it('computes Windows relative paths case-insensitively', async () => {
    const result = await buildExternalFileContexts({
      source: 'drop',
      paths: ['c:\\Work\\Repo\\docs\\report.md'],
      existingContexts: [],
      workspacePath: 'C:\\WORK\\REPO',
      maxImageCount: 2,
      loadMetadata: async () => metadata(false),
    });

    expect(result.contexts[0]).toMatchObject({ relativePath: 'docs/report.md' });
  });

  it('classifies files, directories, images, and preserves input order', async () => {
    const loadMetadata = vi.fn(async (path: string) => {
      if (path.endsWith('folder')) return metadata(true);
      return metadata(false, path.endsWith('.png') ? 42 : 7);
    });
    const result = await buildExternalFileContexts({
      source: 'clipboard',
      paths: ['/tmp/a.txt', '/tmp/folder', '/tmp/picture.png'],
      existingContexts: [],
      maxImageCount: 5,
      loadMetadata,
    });

    expect(result.contexts.map((context) => context.type)).toEqual(['file', 'directory', 'image']);
    expect(result.contexts.map((context) => context.metadata?.externalFileSource)).toEqual([
      'clipboard', 'clipboard', 'clipboard',
    ]);
    expect(result.contexts[0]).toMatchObject({ fileName: 'a.txt', mimeType: 'text/plain' });
    expect(result.contexts[2]).toMatchObject({ imagePath: '/tmp/picture.png', fileSize: 42 });
  });

  it('deduplicates paths already present as files, directories, and local images', async () => {
    const existingContexts = [
      { id: 'f', type: 'file', filePath: '/tmp/a', fileName: 'a', timestamp: 0 },
      { id: 'd', type: 'directory', directoryPath: '/tmp/b', directoryName: 'b', recursive: true, timestamp: 0 },
      { id: 'i', type: 'image', imagePath: '/tmp/c.png', imageName: 'c.png', fileSize: 1, mimeType: 'image/png', source: 'file', isLocal: true, timestamp: 0 },
    ] satisfies ContextItem[];
    const result = await build(['/tmp/a', '/tmp/b', '/tmp/c.png', '/tmp/new'], existingContexts);
    expect(result.contexts).toHaveLength(1);
    expect(result.duplicateCount).toBe(3);
  });

  it('keeps successes when metadata fails or a path is invalid', async () => {
    const loadMetadata = vi.fn(async (path: string) => {
      if (path.endsWith('missing')) throw new Error('missing');
      if (path.endsWith('invalid')) return { ...metadata(false), isFile: false };
      return metadata(false);
    });
    const result = await build(['/tmp/ok', '/tmp/missing', '/tmp/invalid'], [], loadMetadata);
    expect(result.contexts.map((context) => context.type)).toEqual(['file']);
    expect(result.failures.map((failure) => failure.reason)).toEqual(['metadata', 'invalid-path']);
  });

  it('enforces only the image count limit', async () => {
    const result = await buildExternalFileContexts({
      source: 'drop',
      paths: ['/tmp/a.png', '/tmp/b.jpg', '/tmp/c.gif', '/tmp/a.txt'],
      existingContexts: [],
      maxImageCount: 2,
      loadMetadata: async () => metadata(false),
    });
    expect(result.contexts.map((context) => context.type)).toEqual(['image', 'image', 'file']);
    expect(result.failures).toEqual([{ path: '/tmp/c.gif', reason: 'image-limit' }]);
  });

  it('attempts the native clipboard image read only for empty-typed pastes', () => {
    // WebKitGTK delivers paste with no types at all; only that shape falls
    // back to the host clipboard read.
    expect(shouldAttemptNativeClipboardImageRead([])).toBe(true);
    // Engines that report anything (files or text) deliver images in-band.
    expect(shouldAttemptNativeClipboardImageRead(['Files'])).toBe(false);
    expect(shouldAttemptNativeClipboardImageRead(['text/plain'])).toBe(false);
    expect(shouldAttemptNativeClipboardImageRead(['Files', 'text/plain'])).toBe(false);
  });
});
