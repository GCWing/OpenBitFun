// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PagesScene from './PagesScene';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  accountStatus: vi.fn(),
  accountGetCredentialHint: vi.fn(),
  listPages: vi.fn(),
  listVersions: vi.fn(),
  createOpenLink: vi.fn(),
  update: vi.fn(),
  deletePage: vi.fn(),
  confirmDanger: vi.fn(),
  listen: vi.fn(),
  openExternal: vi.fn(),
  setClipboard: vi.fn(),
}));

vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({
  api: { listen: mocks.listen },
}));

vi.mock('@/infrastructure/api/service-api/PageAPI', () => ({
  pageAPI: {
    listPages: mocks.listPages,
    listVersions: mocks.listVersions,
    createOpenLink: mocks.createOpenLink,
    update: mocks.update,
    deploy: vi.fn(),
    unpublish: vi.fn(),
    deleteVersion: vi.fn(),
    deletePage: mocks.deletePage,
  },
}));

vi.mock('@/infrastructure/api/service-api/RemoteConnectAPI', () => ({
  remoteConnectAPI: {
    accountStatus: mocks.accountStatus,
    accountGetCredentialHint: mocks.accountGetCredentialHint,
  },
}));

vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({
  systemAPI: { openExternal: mocks.openExternal, setClipboard: mocks.setClipboard },
}));

vi.mock('@/infrastructure/i18n', () => {
  const t = (key: string) => key;
  return {
    useI18n: () => ({
      t,
      formatDate: () => 'date',
      formatNumber: (value: number) => String(value),
    }),
  };
});

vi.mock('@/shared/notification-system', () => ({
  useNotification: () => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({ error: vi.fn() }),
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Button: ({ children, isLoading: _isLoading, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { isLoading?: boolean }) => (
    <button {...props}>{children}</button>
  ),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Select: () => <div />,
}));

vi.mock('@/shared/presence', () => ({
  RetainedMountBoundary: ({ present, children }: { present: boolean; children: React.ReactNode }) => (
    present ? <>{children}</> : null
  ),
}));

vi.mock('@/infrastructure/confirm-dialog', () => ({
  confirmDanger: mocks.confirmDanger,
  confirmWarning: vi.fn(),
}));

vi.mock('@/app/components/GalleryLayout', () => ({
  GalleryLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  GalleryPageHeader: ({
    title,
    actions,
  }: {
    title: React.ReactNode;
    actions?: React.ReactNode;
  }) => <header>{title}{actions}</header>,
  GalleryEmpty: ({ message, action, testId }: { message: React.ReactNode; action?: React.ReactNode; testId?: string }) => (
    <div data-testid={testId}>{message}{action}</div>
  ),
}));

describe('PagesScene initial loading', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.accountStatus.mockReset().mockResolvedValue({ logged_in: true, user_id: 'u1' });
    mocks.accountGetCredentialHint.mockReset().mockResolvedValue({ relay_url: 'https://relay.test' });
    mocks.listPages.mockReset().mockRejectedValue(new Error('relay unavailable'));
    mocks.listVersions.mockReset().mockResolvedValue([]);
    mocks.createOpenLink.mockReset();
    mocks.update.mockReset();
    mocks.deletePage.mockReset().mockResolvedValue(undefined);
    mocks.confirmDanger.mockReset().mockResolvedValue(true);
    mocks.listen.mockReset().mockImplementation(() => vi.fn());
    mocks.openExternal.mockReset().mockResolvedValue(undefined);
    mocks.setClipboard.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('attempts a failed initial load only once until the user retries', async () => {
    await act(async () => {
      root.render(<PagesScene isActive />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The failed relay call triggers one bounded auth re-check so an expired
    // session can switch to the sign-in state; it must not retry listPages.
    expect(mocks.accountStatus).toHaveBeenCalledTimes(2);
    expect(mocks.listPages).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="pages-error"]')).not.toBeNull();
  });

  it('discloses management controls on demand and locks every action while an operation is pending', async () => {
    mocks.listPages.mockResolvedValue([{
      slug: 'demo',
      generation: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      visibility: 'public',
      title: 'Demo',
      file_count: 1,
      total_bytes: 20,
      created_at: 1,
      updated_at: 1,
      url_path: '/p/alice/demo',
      preview_url_path: '/p/alice/demo/@v/v1',
      deployed_version_id: 'v1',
    }]);
    let resolveOpenLink: ((value: {
      open_url: string;
      page_url: string;
      expires_in_seconds: number;
    }) => void) | undefined;
    mocks.createOpenLink.mockImplementation(() => new Promise((resolve) => {
      resolveOpenLink = resolve;
    }));

    await act(async () => {
      root.render(<PagesScene isActive />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const management = container.querySelector('#page-management-demo') as HTMLElement | null;
    expect(management?.hidden).toBe(true);
    const manage = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('actions.manage'));
    await act(async () => {
      manage?.click();
      await Promise.resolve();
    });
    expect(management?.hidden).toBe(false);
    expect(container.querySelector('input[aria-label="titleField.inputAria"]')).not.toBeNull();

    const buttons = [...container.querySelectorAll('button')];
    const open = buttons.find((button) => button.textContent?.includes('actions.openProduction'));
    const remove = buttons.find((button) => button.textContent?.includes('actions.deletePage'));
    expect(open).toBeDefined();
    expect(remove).toBeDefined();

    await act(async () => {
      open?.click();
      await Promise.resolve();
    });
    expect(remove?.disabled).toBe(true);

    await act(async () => {
      resolveOpenLink?.({
        open_url: 'https://relay.test/open',
        page_url: 'https://relay.test/p/alice/demo',
        expires_in_seconds: 60,
      });
      await Promise.resolve();
    });
    expect(remove?.disabled).toBe(false);
  });

  it('copies the canonical protected URL instead of an account handoff ticket', async () => {
    mocks.listPages.mockResolvedValue([{
      slug: 'private-demo',
      generation: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      visibility: 'private',
      title: 'Private demo',
      file_count: 1,
      total_bytes: 20,
      created_at: 1,
      updated_at: 1,
      url_path: 'https://pages.test/site/p/alice/private-demo',
      preview_url_path: 'https://pages.test/site/p/alice/private-demo/@v/v1',
      deployed_version_id: 'v1',
    }]);
    mocks.createOpenLink.mockResolvedValue({
      open_url: 'https://relay.test/api/page-open/one-time-ticket',
      page_url: 'https://relay.test/p/alice/private-demo',
      expires_in_seconds: 60,
    });

    await act(async () => {
      root.render(<PagesScene isActive />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const copy = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('actions.copyLink'));
    await act(async () => {
      copy?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.setClipboard).toHaveBeenCalledWith(
      'https://pages.test/site/p/alice/private-demo',
    );
    expect(mocks.createOpenLink).not.toHaveBeenCalled();
    expect(mocks.setClipboard).not.toHaveBeenCalledWith(
      'https://relay.test/api/page-open/one-time-ticket',
    );
  });

  it('does not restore a deleted Page from an older refresh response', async () => {
    const page = {
      slug: 'demo',
      generation: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      visibility: 'public',
      title: 'Demo',
      file_count: 1,
      total_bytes: 20,
      created_at: 1,
      updated_at: 1,
      url_path: '/p/alice/demo',
      preview_url_path: '/p/alice/demo/@v/v1',
      deployed_version_id: 'v1',
    };
    mocks.listPages.mockResolvedValueOnce([page]);

    await act(async () => {
      root.render(<PagesScene isActive />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    let resolveRefresh: ((pages: typeof page[]) => void) | undefined;
    mocks.listPages.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = resolve;
    }));
    const refresh = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'actions.refresh');
    await act(async () => {
      refresh?.click();
      await Promise.resolve();
    });

    const remove = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('actions.deletePage'));
    await act(async () => {
      remove?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).not.toContain('Demo');

    await act(async () => {
      resolveRefresh?.([page]);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).not.toContain('Demo');
  });

  it('drops slug caches when the same account recreates a Page with a new generation', async () => {
    const oldPage = {
      slug: 'recreated',
      generation: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      visibility: 'public' as const,
      title: 'Old Page',
      file_count: 1,
      total_bytes: 20,
      created_at: 1,
      updated_at: 1,
      url_path: '/p/alice/recreated',
      preview_url_path: '/p/alice/recreated/@v/a1',
      deployed_version_id: 'a1',
    };
    const newPage = {
      ...oldPage,
      generation: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      title: 'New Page',
      preview_url_path: '/p/alice/recreated/@v/b1',
      deployed_version_id: 'b1',
    };
    mocks.listPages.mockResolvedValueOnce([oldPage]);
    mocks.listVersions
      .mockResolvedValueOnce([{
        generation: oldPage.generation,
        version_id: 'a1',
        title: oldPage.title,
        file_count: 1,
        total_bytes: 20,
        has_worker: false,
        note: 'old generation note',
        created_at: 1,
        deployed: true,
        preview_url_path: oldPage.preview_url_path,
      }])
      .mockResolvedValueOnce([{
        generation: newPage.generation,
        version_id: 'b1',
        title: newPage.title,
        file_count: 1,
        total_bytes: 20,
        has_worker: false,
        note: 'new generation note',
        created_at: 2,
        deployed: true,
        preview_url_path: newPage.preview_url_path,
      }]);

    await act(async () => {
      root.render(<PagesScene isActive />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const oldInput = container.querySelector('input') as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      valueSetter?.call(oldInput, 'old generation draft');
      oldInput.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    expect(oldInput.value).toBe('old generation draft');

    const oldVersions = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('actions.versions'));
    await act(async () => {
      oldVersions?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain('old generation note');

    mocks.listPages.mockResolvedValueOnce([newPage]);
    const refresh = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'actions.refresh');
    await act(async () => {
      refresh?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain('New Page');
    expect(container.textContent).not.toContain('old generation note');
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('New Page');

    const newVersions = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('actions.versions'));
    await act(async () => {
      newVersions?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.listVersions).toHaveBeenLastCalledWith(
      newPage.slug,
      newPage.generation,
    );
    expect(container.textContent).toContain('new generation note');
    expect(container.textContent).not.toContain('old generation note');
  });

  it('clears account-owned state immediately and fences stale same-slug actions', async () => {
    const pageA = {
      slug: 'shared',
      generation: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      visibility: 'public' as const,
      title: 'Account A Page',
      file_count: 1,
      total_bytes: 20,
      created_at: 1,
      updated_at: 1,
      url_path: '/p/alice/shared',
      preview_url_path: '/p/alice/shared/@v/a1',
      deployed_version_id: 'a1',
    };
    const pageB = {
      ...pageA,
      generation: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      title: 'Account B Page',
      url_path: '/p/bob/shared',
      preview_url_path: '/p/bob/shared/@v/b1',
      deployed_version_id: 'b1',
    };
    mocks.listPages.mockResolvedValueOnce([pageA]);
    mocks.listVersions.mockResolvedValueOnce([{
      generation: pageA.generation,
      version_id: 'a1',
      title: pageA.title,
      file_count: 1,
      total_bytes: 20,
      has_worker: false,
      note: 'A-only note',
      created_at: 1,
      deployed: true,
      preview_url_path: pageA.preview_url_path,
    }]);

    await act(async () => {
      root.render(<PagesScene isActive />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const versions = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('actions.versions'));
    await act(async () => {
      versions?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain('A-only note');

    let resolveConfirmation: ((confirmed: boolean) => void) | undefined;
    mocks.confirmDanger.mockImplementationOnce(() => new Promise((resolve) => {
      resolveConfirmation = resolve;
    }));
    const staleDelete = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('actions.deletePage'));
    await act(async () => {
      staleDelete?.click();
      await Promise.resolve();
    });

    let resolveBPages: ((pages: typeof pageB[]) => void) | undefined;
    mocks.accountStatus.mockResolvedValue({ logged_in: true, user_id: 'u2' });
    mocks.listPages.mockImplementationOnce(() => new Promise((resolve) => {
      resolveBPages = resolve;
    }));
    const loginStateListener = mocks.listen.mock.calls
      .find(([event]) => event === 'account://login-state')?.[1] as
      ((payload: { logged_in: boolean }) => void) | undefined;
    expect(loginStateListener).toBeDefined();
    await act(async () => {
      loginStateListener?.({ logged_in: true });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // B ownership is adopted before its list response arrives, so no A-only
    // versions, drafts, or cards remain actionable during the gap.
    expect(container.textContent).not.toContain('Account A Page');
    expect(container.textContent).not.toContain('A-only note');

    await act(async () => {
      resolveConfirmation?.(true);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.deletePage).not.toHaveBeenCalled();

    await act(async () => {
      resolveBPages?.([pageB]);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain('Account B Page');
    expect(container.textContent).not.toContain('A-only note');
    expect((container.querySelector('input') as HTMLInputElement | null)?.value)
      .toBe('Account B Page');
  });

  it('invalidates in-flight actions when the same user logs in again', async () => {
    const oldPage = {
      slug: 'same-user',
      generation: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      visibility: 'public' as const,
      title: 'Old session Page',
      file_count: 1,
      total_bytes: 20,
      created_at: 1,
      updated_at: 1,
      url_path: '/p/alice/same-user',
      preview_url_path: '/p/alice/same-user/@v/a1',
      deployed_version_id: 'a1',
    };
    const freshPage = {
      ...oldPage,
      generation: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      title: 'Fresh session Page',
      preview_url_path: '/p/alice/same-user/@v/b1',
      deployed_version_id: 'b1',
    };
    mocks.listPages.mockResolvedValueOnce([oldPage]);
    let resolveStaleOpen: ((value: {
      open_url: string;
      page_url: string;
      expires_in_seconds: number;
    }) => void)
      | undefined;
    mocks.createOpenLink.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStaleOpen = resolve;
    }));

    await act(async () => {
      root.render(<PagesScene isActive />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const open = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('actions.openProduction'));
    await act(async () => {
      open?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.createOpenLink).toHaveBeenCalledWith(
      oldPage.slug,
      oldPage.generation,
      undefined,
    );

    mocks.listPages.mockResolvedValueOnce([freshPage]);
    const loginStateListener = mocks.listen.mock.calls
      .find(([event]) => event === 'account://login-state')?.[1] as
      ((payload: { logged_in: boolean }) => void) | undefined;
    expect(loginStateListener).toBeDefined();
    await act(async () => {
      loginStateListener?.({ logged_in: true });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain('Fresh session Page');
    expect(container.textContent).not.toContain('Old session Page');

    await act(async () => {
      resolveStaleOpen?.({
        open_url: 'https://relay.test/stale-open',
        page_url: 'https://relay.test/p/alice/same-user',
        expires_in_seconds: 60,
      });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Fresh session Page');
  });
});
