// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadOnlyCodeBlock } from './ReadOnlyCodeBlock';

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  createModel: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../../services/MonacoInitManager', () => ({
  monacoInitManager: { initialize: mocks.initialize },
}));

vi.mock('../../services/monacoRuntime', () => ({
  monacoApi: {
    editor: {
      create: mocks.create,
      setModelLanguage: vi.fn(),
    },
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
  },
}));

vi.mock('../../services/MonacoModelManager', () => ({
  monacoModelManager: {
    getOrCreateModel: mocks.createModel,
    releaseModel: vi.fn(),
  },
}));

vi.mock('../../services/EditorExtensionManager', () => ({
  editorExtensionManager: {
    notifyEditorCreated: () => 'editor-1',
    notifyEditorWillDispose: vi.fn(),
    notifyContentChanged: vi.fn(),
  },
}));

vi.mock('../../services/ActiveEditTargetService', () => ({
  activeEditTargetService: {
    bindTarget: () => () => {},
    setActiveTarget: vi.fn(),
    clearActiveTarget: vi.fn(),
  },
  createMonacoEditTarget: () => ({ id: 'mock-target' }),
}));

vi.mock('@/infrastructure/appearance/adapters/MonacoAppearanceAdapter', () => ({
  monacoAppearanceAdapter: {
    attachMonaco: () => 'test-theme',
    getCurrentThemeId: () => 'test-theme',
  },
}));

vi.mock('../../services/EditorOptionsBuilder', () => ({
  buildEditorOptions: () => ({}),
}));

describe('ReadOnlyCodeBlock lazy loading', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let intersectionCallbacks: IntersectionObserverCallback[] = [];

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    intersectionCallbacks = [];

    class MockIntersectionObserver implements IntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin: string = '';
      readonly thresholds: ReadonlyArray<number> = [];
      constructor(private cb: IntersectionObserverCallback) {
        intersectionCallbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords(): IntersectionObserverEntry[] { return []; }
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

    const mockModel = {
      getValue: () => 'const x = 1;',
      getLanguageId: () => 'typescript',
      onDidChangeContent: () => ({ dispose() {} }),
      dispose: vi.fn(),
    };
    const mockEditor = {
      onDidChangeCursorPosition: () => ({ dispose() {} }),
      onDidChangeCursorSelection: () => ({ dispose() {} }),
      onDidFocusEditorText: () => ({ dispose() {} }),
      onDidBlurEditorText: () => ({ dispose() {} }),
      addCommand: vi.fn(),
      updateOptions: vi.fn(),
      dispose: vi.fn(),
    };

    mocks.initialize.mockResolvedValue({});
    mocks.createModel.mockReturnValue(mockModel);
    mocks.create.mockReturnValue(mockEditor);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('defers Monaco initialization when lazy=true until intersecting', async () => {
    await act(async () => {
      root.render(
        <ReadOnlyCodeBlock content="const x = 1;" language="typescript" lazy={true} />
      );
    });

    // Not intersecting yet, Monaco should not be initialized
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();

    // Trigger viewport intersection
    expect(intersectionCallbacks.length).toBe(1);
    await act(async () => {
      intersectionCallbacks[0](
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });

    expect(mocks.initialize).toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalled();
  });

  it('initializes immediately when lazy=false', async () => {
    await act(async () => {
      root.render(
        <ReadOnlyCodeBlock content="const x = 1;" language="typescript" lazy={false} />
      );
    });

    expect(mocks.initialize).toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalled();
  });
});
