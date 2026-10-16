/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketSubmission } from '@/infrastructure/api/service-api/MiniAppMarketAPI';
import MiniAppSubmissionsView from './MiniAppSubmissionsView';

const mocks = vi.hoisted(() => ({
  accountId: 'first',
  signedIn: true,
  remote: false,
  listSubmissions: vi.fn(),
  listMiniApps: vi.fn(),
  submitInstalled: vi.fn(),
  withdrawSubmission: vi.fn(),
  onUploadProgress: vi.fn(),
  captureWindow: vi.fn(),
  openScene: vi.fn(),
  activateScene: vi.fn(),
  getAppVersion: vi.fn(),
  open: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/infrastructure/account-identity', () => ({
  useAccountIdentity: () => ({
    resolved: true,
    status: mocks.signedIn ? 'signed-in' : 'signed-out',
    me: mocks.signedIn ? { user: { accountId: mocks.accountId } } : null,
  }),
}));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({ useCurrentWorkspace: () => ({ workspace: {} }) }));
vi.mock('@/shared/types', () => ({ isRemoteWorkspace: () => mocks.remote }));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => mocks }));
vi.mock('@/app/hooks/useSceneManager', () => ({ useSceneManager: () => ({ ...mocks, openTabs: [] }) }));
vi.mock('@/infrastructure/api/service-api/MiniAppMarketAPI', () => ({ miniAppMarketAPI: mocks }));
vi.mock('@/infrastructure/api/service-api/MiniAppAPI', () => ({ miniAppAPI: mocks }));
vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({ systemAPI: mocks }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));

const record = (submissionId: string): MarketSubmission => ({
  submissionId, listingId: 'notes', slug: 'notes', releaseNumber: 1, name: submissionId,
  description: 'Notes', icon: 'box', category: 'utilities', tags: [], minOpenBitFunVersion: '1.0.5',
  changelog: '', license: { spdxExpression: 'MIT' }, permissions: {}, status: 'submitted',
  screenshotUrls: [], createdAt: 1, updatedAt: 1,
});

let root: Root;
let container: HTMLDivElement;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]');
const button = (key: string) => [...(dialog() ?? container).querySelectorAll('button')].find(item => item.textContent === key)!;
const render = () => act(async () => {
  root.render(<MiniAppSubmissionsView renderLayout={(content, actions) => (
    <div>
      <div data-testid="gallery-toolbar">{actions}</div>
      {content}
    </div>
  )} />);
});
const click = (key: string) => act(async () => { button(key).click(); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetAllMocks();
  mocks.accountId = 'first';
  mocks.signedIn = true;
  mocks.remote = false;
  mocks.listSubmissions.mockResolvedValue([record('Existing release')]);
  mocks.listMiniApps.mockResolvedValue([{ id: 'notes', name: 'Notes', description: 'Notes app', category: 'utilities', tags: [], icon: 'box' }]);
  mocks.getAppVersion.mockResolvedValue('1.0.5');
  mocks.onUploadProgress.mockReturnValue(vi.fn());
  mocks.open.mockResolvedValue(['/tmp/notes-preview.png']);
  mocks.submitInstalled.mockResolvedValue(record('New release'));
  mocks.captureWindow.mockResolvedValue('/tmp/captured-preview.png');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('MiniApp submission navigation', () => {
  it('places sign-in in the signed-out empty state and keeps the top-right area empty', async () => {
    mocks.signedIn = false;
    await act(async () => root.render(<MiniAppSubmissionsView />));
    expect(container.querySelector('.miniapp-gallery-pane__account-actions button')).toBeNull();
    const emptyState = container.querySelector('.miniapp-submissions__history-empty')!;
    expect(emptyState.textContent).toContain('market.submissions.signInRequired');
    const signIn = emptyState.querySelector<HTMLButtonElement>('button')!;
    expect(signIn.textContent).toContain('market.signIn');
    expect(mocks.listSubmissions).not.toHaveBeenCalled();
    await act(async () => signIn.click());
    expect(dialog()?.textContent).toContain('market.account.dialogTitle');
  });

  it('starts with the submitted list and an explicit submit button', async () => {
    await render();
    expect(container.textContent).toContain('Existing release');
    expect(button('market.submissions.newSubmission')).toBeDefined();
    expect(button('market.submissions.newSubmission').closest('[data-testid="gallery-toolbar"]')).not.toBeNull();
    expect(button('market.submissions.refresh').closest('[data-testid="gallery-toolbar"]')).not.toBeNull();
    expect(button('market.submissions.newSubmission').dataset.openbitfunVariant).toBe('quiet');
    expect(container.querySelector('form')).toBeNull();
    expect(container.textContent).not.toContain('market.submissions.historyHint');
    expect(mocks.listMiniApps).not.toHaveBeenCalled();
    expect(mocks.getAppVersion).not.toHaveBeenCalled();
  });

  it('opens the form in a dialog above the existing list and cancels back to it', async () => {
    await render();
    await click('market.submissions.newSubmission');
    expect(mocks.listMiniApps).toHaveBeenCalledOnce();
    const surface = dialog()!;
    expect(surface.getAttribute('data-size')).toBe('xl');
    expect(surface.textContent).toContain('market.submissions.newTitle');
    expect(surface.querySelector('form')).not.toBeNull();
    expect(container.contains(surface)).toBe(false);
    expect(container.querySelector('[data-openbitfun-part="history"]')).not.toBeNull();
    expect(container.textContent).toContain('Existing release');
    expect(button('market.submissions.submit').closest('[data-openbitfun-part="footer"]')).not.toBeNull();
    await click('confirmDelete.cancel');
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain('Existing release');
  });

  it('returns to the list containing the new record after a successful submission', async () => {
    await render();
    await click('market.submissions.newSubmission');
    await click('market.submissions.choose');
    await click('market.submissions.submit');
    expect(mocks.submitInstalled).toHaveBeenCalledExactlyOnceWith('notes', expect.objectContaining({ name: 'Notes' }), ['/tmp/notes-preview.png']);
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain('New release');
    expect(container.textContent).toContain('Existing release');
  });

  it('allows remote history browsing while keeping local packaging unavailable', async () => {
    mocks.remote = true;
    await render();
    expect(container.textContent).toContain('Existing release');
    expect(button('market.submissions.newSubmission').disabled).toBe(true);
    expect(container.textContent).toContain('market.submissions.remoteUnsupported');
    expect(mocks.listMiniApps).not.toHaveBeenCalled();
  });

  it('keeps records available when loading local apps for a new submission fails', async () => {
    mocks.listMiniApps.mockRejectedValue(new Error('Local apps unavailable'));
    await render();
    await click('market.submissions.newSubmission');
    expect(dialog()!.textContent).toContain('market.submissions.prepareFailed');
    expect(button('market.submissions.submit').disabled).toBe(true);
    await click('confirmDelete.cancel');
    expect(container.textContent).toContain('Existing release');
  });

  it('allows Escape to close an idle dialog', async () => {
    await render();
    await click('market.submissions.newSubmission');
    await act(async () => {
      dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain('Existing release');
  });

  it('keeps the dialog open while submitting and allows retry after failure', async () => {
    let rejectSubmission!: (error: Error) => void;
    mocks.submitInstalled.mockReturnValueOnce(new Promise((_, reject) => { rejectSubmission = reject; }));
    await render();
    await click('market.submissions.newSubmission');
    await click('market.submissions.choose');
    await click('market.submissions.submit');
    expect(button('confirmDelete.cancel').disabled).toBe(true);
    expect(dialog()!.querySelector<HTMLButtonElement>('[data-openbitfun-part="close"]')!.disabled).toBe(true);
    await act(async () => {
      dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(dialog()).not.toBeNull();
    await act(async () => { rejectSubmission(new Error('Upload failed')); });
    expect(button('market.submissions.submit').disabled).toBe(false);
    expect(dialog()!.textContent).toContain('notes-preview.png');
  });

  it('hides the dialog while capturing the app and restores it with the screenshot', async () => {
    vi.useFakeTimers();
    await render();
    await click('market.submissions.newSubmission');
    await click('market.submissions.capture');
    expect(dialog()).toBeNull();
    expect(mocks.openScene).toHaveBeenCalledWith('miniapp:notes');
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(mocks.captureWindow).toHaveBeenCalledOnce();
    expect(mocks.activateScene).toHaveBeenCalledWith('miniapps');
    expect(dialog()!.textContent).toContain('captured-preview.png');
  });

  it('ignores previous-account records that arrive after switching accounts', async () => {
    let resolvePrevious!: (records: MarketSubmission[]) => void;
    mocks.listSubmissions.mockReturnValueOnce(new Promise<MarketSubmission[]>(resolve => { resolvePrevious = resolve; }));
    await render();
    mocks.accountId = 'second';
    mocks.listSubmissions.mockResolvedValueOnce([record('Second account')]);
    await render();
    await act(async () => { resolvePrevious([record('Previous account')]); });
    expect(container.textContent).toContain('Second account');
    expect(container.textContent).not.toContain('Previous account');
  });
});
