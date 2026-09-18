// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useAgentIdentityDocument,
  type UseAgentIdentityDocumentResult,
} from './useAgentIdentityDocument';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  readWorkspaceFile: vi.fn(),
  writeWorkspaceFile: vi.fn(),
}));
const watchFileChangesMock = vi.hoisted(() => vi.fn(() => vi.fn()));

vi.mock('@/infrastructure/api/service-api/WorkspaceAPI', () => ({
  workspaceAPI: {
    readWorkspaceFile: apiMocks.readWorkspaceFile,
    writeWorkspaceFile: apiMocks.writeWorkspaceFile,
  },
}));

vi.mock('@/tools/file-system/services/FileSystemService', () => ({
  fileSystemService: {
    watchFileChanges: watchFileChangesMock,
  },
}));

vi.mock('@/shared/services/ide-control', () => ({
  ideControl: {
    navigation: {
      goToFile: vi.fn(),
    },
  },
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
  }),
}));

const INITIAL_IDENTITY = [
  '---',
  'name: Mira',
  'creature: Assistant',
  'vibe: Focused',
  'emoji: 💼',
  '---',
  '',
].join('\n');

describe('useAgentIdentityDocument autosave', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestResult: UseAgentIdentityDocumentResult | null;

  const Harness = () => {
    latestResult = useAgentIdentityDocument({ id: 'assistant-1', rootPath: '/tmp/assistant' });
    return null;
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    apiMocks.readWorkspaceFile.mockReset();
    apiMocks.writeWorkspaceFile.mockReset();
    watchFileChangesMock.mockClear();
    apiMocks.readWorkspaceFile.mockResolvedValue(INITIAL_IDENTITY);
    apiMocks.writeWorkspaceFile
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValue(undefined);

    latestResult = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('stops retrying after a failed write until the user edits again', async () => {
    act(() => latestResult?.updateField('emoji', '🚀'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(apiMocks.writeWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(apiMocks.writeWorkspaceFile).toHaveBeenCalledWith(
      'assistant-1',
      '/tmp/assistant/IDENTITY.md',
      expect.any(String),
    );
    expect(latestResult?.saveStatus).toBe('error');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(apiMocks.writeWorkspaceFile).toHaveBeenCalledTimes(1);

    act(() => latestResult?.updateField('emoji', '🧭'));
    expect(latestResult?.saveStatus).toBe('idle');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(apiMocks.writeWorkspaceFile).toHaveBeenCalledTimes(2);
    expect(latestResult?.saveStatus).toBe('saved');
  });
});
