// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeReviewReportExportActions } from './CodeReviewReportExportActions';
import type { ReviewTeamRunManifest } from '@/shared/services/reviewTeamService';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const formatCodeReviewReportMarkdownMock = vi.hoisted(() => vi.fn(() => '# Review'));

function Icon({ name }: { name: string }) {
  return <svg data-icon={name} />;
}

vi.mock('@openbitfun/ui', async importOriginal => ({
  IconButton: (await importOriginal<typeof import('@openbitfun/ui')>()).IconButton,
  Button: ({
    children,
    leadingIcon,
    onClick,
  }: {
    children: React.ReactNode;
    leadingIcon?: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
  }) => (
    <button type="button" onClick={onClick}>
      {leadingIcon}
      {children}
    </button>
  ),
  Icon: ({ name }: { name: string }) => <Icon name={name} />,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        'toolCards.codeReview.export.copyMarkdown': 'Copy Markdown',
        'toolCards.codeReview.export.openMarkdown': 'Open as Markdown',
        'toolCards.codeReview.export.saveMarkdown': 'Save Markdown',
        'toolCards.codeReview.coverageSources.focusedCheck': '补充检查',
      };
      return labels[key] ?? key;
    },
  }),
}));

vi.mock('@/shared/notification-system', () => ({
  notificationService: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/shared/utils/tabUtils', () => ({
  createMarkdownEditorTab: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile: vi.fn() }));

vi.mock('../utils/codeReviewReport', () => ({
  formatCodeReviewReportMarkdown: (...args: unknown[]) => formatCodeReviewReportMarkdownMock(...args),
}));

describe('CodeReviewReportExportActions', () => {
  let root: Root | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = undefined;
    document.body.replaceChildren();
    delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
  });

  it('keeps pending export controls visible and enables them when a report arrives', async () => {
    (window as Window & { __TAURI__?: unknown }).__TAURI__ = {};
    vi.mocked(save).mockResolvedValue('/review.md');
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<CodeReviewReportExportActions reviewData={null} actions={['copy', 'save']} />);
      });
      const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')];
      expect(buttons).toHaveLength(2);
      expect(buttons.every(button => button.disabled)).toBe(true);
      expect(formatCodeReviewReportMarkdownMock).not.toHaveBeenCalled();
      await act(async () => {
        root.render(<CodeReviewReportExportActions
          reviewData={{ summary: { recommended_action: 'approve' } }}
          actions={['copy', 'save']}
        />);
      });
      expect(buttons.every(button => !button.disabled)).toBe(true);
      await act(async () => { buttons[1].click(); });
      expect(writeFile).toHaveBeenCalledWith('/review.md', new TextEncoder().encode('# Review'));
    } finally {
      act(() => root.unmount());
    }
  });

  it('uses the same copy icon as other copy buttons', () => {
    const html = renderToStaticMarkup(
      <CodeReviewReportExportActions reviewData={{ summary: { recommended_action: 'approve' } }} />,
    );

    expect(html).toContain('aria-label="Copy Markdown"');
    expect(html).toContain('data-icon="duplicate"');
    expect(html).not.toContain('data-icon="clipboard-copy"');
  });

  it('uses a download icon for saving Markdown', () => {
    const html = renderToStaticMarkup(
      <CodeReviewReportExportActions reviewData={{ summary: { recommended_action: 'approve' } }} />,
    );

    expect(html).toContain('aria-label="Save Markdown"');
    expect(html).toContain('data-icon="arrow-down"');
  });

  it('can limit the visible export actions for compact surfaces', () => {
    const html = renderToStaticMarkup(
      <CodeReviewReportExportActions
        reviewData={{ summary: { recommended_action: 'approve' } }}
        actions={['copy', 'save']}
      />,
    );

    expect(html).toContain('aria-label="Copy Markdown"');
    expect(html).toContain('aria-label="Save Markdown"');
    expect(html).not.toContain('aria-label="Open as Markdown"');
  });

  it('keeps saving disabled while the file picker is open and does not write when cancelled', async () => {
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true });
    let cancelPicker!: () => void;
    vi.mocked(save).mockImplementationOnce(
      () => new Promise(resolve => { cancelPicker = () => resolve(null); }),
    );
    const parentClick = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <div onClick={parentClick}>
          <CodeReviewReportExportActions reviewData={{ summary: { recommended_action: 'approve' } }} actions={['save']} />
        </div>,
      );
    });

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Save Markdown"]')!;
    await act(async () => button.click());

    expect(save).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('data-loading')).toBe('false');
    expect(button.querySelector('[data-icon="progress-25"]')).not.toBeNull();
    act(() => button.click());
    expect(save).toHaveBeenCalledTimes(1);
    expect(parentClick).not.toHaveBeenCalled();

    await act(async () => cancelPicker());
    expect(writeFile).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
    expect(button.querySelector('[data-icon="arrow-down"]')).not.toBeNull();
  });

  it('passes the review run manifest into Markdown formatting', () => {
    const runManifest = {
      strategyLevel: 'quick',
      skippedReviewers: [],
    };

    renderToStaticMarkup(
      <CodeReviewReportExportActions
        reviewData={{
          review_mode: 'deep',
          summary: { recommended_action: 'approve' },
        }}
        runManifest={runManifest as unknown as ReviewTeamRunManifest}
      />,
    );

    expect(formatCodeReviewReportMarkdownMock).toHaveBeenCalledWith(
      {
        review_mode: 'deep',
        summary: { recommended_action: 'approve' },
      },
      expect.any(Object),
      { runManifest },
    );
  });

  it('does not project a Deep Review manifest into a standard Review export', () => {
    const runManifest = {
      strategyLevel: 'quick',
      skippedReviewers: [],
    };

    renderToStaticMarkup(
      <CodeReviewReportExportActions
        reviewData={{
          review_mode: 'standard',
          summary: { recommended_action: 'approve' },
        }}
        runManifest={runManifest as unknown as ReviewTeamRunManifest}
      />,
    );

    expect(formatCodeReviewReportMarkdownMock).toHaveBeenLastCalledWith(
      {
        review_mode: 'standard',
        summary: { recommended_action: 'approve' },
      },
      expect.any(Object),
      { runManifest: undefined },
    );
  });

  it('passes the localized additional-check label into Markdown formatting', () => {
    renderToStaticMarkup(
      <CodeReviewReportExportActions reviewData={{ summary: { recommended_action: 'approve' } }} />,
    );

    expect(formatCodeReviewReportMarkdownMock).toHaveBeenLastCalledWith(
      { summary: { recommended_action: 'approve' } },
      expect.objectContaining({
        coverageSourceLabels: expect.objectContaining({ focusedCheck: '补充检查' }),
      }),
      { runManifest: undefined },
    );
  });
});
