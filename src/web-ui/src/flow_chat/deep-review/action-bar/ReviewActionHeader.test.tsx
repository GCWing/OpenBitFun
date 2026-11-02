import React from 'react';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewActionHeader } from './ReviewActionHeader';

const exportActionsMock = vi.hoisted(() => vi.fn(() => <span>export actions</span>));

vi.mock('../../tool-cards/CodeReviewReportExportActions', () => ({
  CodeReviewReportExportActions: exportActionsMock,
}));

describe('ReviewActionHeader', () => {
  beforeEach(() => {
    exportActionsMock.mockClear();
  });

  it('renders export actions, status, error, and minimize control', () => {
    const html = renderToStaticMarkup(
      <ReviewActionHeader
        reviewData={{ summary: { recommended_action: 'request_changes' } } as any}
        phaseIcon={{ name: 'clock' }}
        phaseIconClass="phase-class"
        phaseTitle="Review completed"
        errorMessage="Network warning"
        minimizeLabel="Minimize"
        onMinimize={vi.fn()}
      />,
    );

    expect(html).toContain('export actions');
    expect(html).toContain('Review completed');
    expect(html).toContain('Network warning');
    expect(html).toContain('aria-label="Minimize"');
  });

  it('keeps the complete multiline failure outside the compact header and export controls', () => {
    const error = 'Failed to start dialog turn: Session execution settings changed during turn admission; retry submission\n' +
      'Details: ' + 'long-unbroken-diagnostic-'.repeat(30);
    const html = renderToStaticMarkup(
      <ReviewActionHeader
        phaseIcon={{ name: 'clock' }}
        phaseIconClass="phase-error"
        phaseTitle="Fix failed"
        errorMessage={error}
        errorSummary="Localized error summary"
        errorDetailsLabel="Technical details"
        minimizeLabel="Minimize"
        onMinimize={vi.fn()}
      />,
    );
    const dom = new JSDOM(html);
    const document = dom.window.document;
    const details = document.querySelector('.deep-review-action-bar__error-message')!;
    expect(details.lastElementChild?.textContent).toBe(error);
    expect(details.textContent).toContain('Localized error summary');
    expect(details.textContent).toContain('Technical details');
    expect(details.closest('.deep-review-action-bar__status')).toBeNull();
    expect(details.closest('.deep-review-action-bar__controls')).toBeNull();
    expect(details.getAttribute('role')).toBe('status');
    dom.window.close();
  });

  it.each([null, { summary: { recommended_action: 'request_changes' } }])('keeps compact export actions while running with report data %j', (reviewData) => {
    renderToStaticMarkup(
      <ReviewActionHeader
        reviewData={reviewData as any}
        isReviewRunning
        phaseIcon={{ name: 'clock' }}
        phaseIconClass="phase-class"
        phaseTitle="Review in progress"
        minimizeLabel="Minimize"
        onMinimize={vi.fn()}
      />,
    );

    expect(exportActionsMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ actions: ['copy', 'save'] }),
    );
  });
});
