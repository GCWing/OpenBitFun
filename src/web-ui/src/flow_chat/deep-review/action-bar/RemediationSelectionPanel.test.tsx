import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemediationSelectionPanel } from './RemediationSelectionPanel';
import type { ReviewRemediationItem } from '../../utils/codeReviewRemediation';

const messages: Record<string, string> = {
  'deepReviewActionBar.remediationStatus.fixed': 'Fixed',
  'deepReviewActionBar.remediationStatus.fixing': 'Fixing',
  'reviewActionBar.needsDecisionTag': 'Decision',
  'toolCards.codeReview.remediationActions.collapseOptions': 'Hide options',
  'toolCards.codeReview.remediationActions.expandOptions': 'Show options',
  'toolCards.codeReview.remediationActions.noSelectionHint': 'Select at least one remediation item to start fixing.',
  'toolCards.codeReview.remediationActions.recommended': 'recommended',
  'toolCards.codeReview.remediationActions.selectionCount': '{{selected}}/{{total}} selected',
  'toolCards.codeReview.remediationActions.ungrouped': 'Other',
};

function t(key: string, options?: Record<string, unknown> & { defaultValue?: string }): string {
  const template = messages[key] ?? options?.defaultValue ?? key;
  return template.replace(/{{(\w+)}}/g, (_match, token: string) => String(options?.[token] ?? _match));
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t,
  }),
}));

vi.mock('@openbitfun/ui', async () => ({
  Icon: ({ name }: { name: string }) => <span data-openbitfun-component="icon" data-openbitfun-name={name} />,
  Button: ({
    children,
    disabled,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
  }) => <button type="button" disabled={disabled}>{children}</button>,
  Checkbox: (await vi.importActual<typeof import("@openbitfun/ui")>("@openbitfun/ui")).Checkbox,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/infrastructure/event-bus', () => ({
  globalEventBus: {
    emit: vi.fn(),
  },
}));

const baseProps = {
  showRemediationList: true,
  onToggleRemediation: vi.fn(),
  onToggleAll: vi.fn(),
  onToggleGroup: vi.fn(),
  onToggleList: vi.fn(),
  onToggleDecisionExpansion: vi.fn(),
  onSetDecisionSelection: vi.fn(),
};

let JSDOMCtor: (new (
  html?: string,
  options?: { pretendToBeVisual?: boolean; url?: string }
) => { window: Window & typeof globalThis }) | null = null;

try {
  const jsdom = await import('jsdom');
  JSDOMCtor = jsdom.JSDOM as typeof JSDOMCtor;
} catch {
  JSDOMCtor = null;
}

const describeWithJsdom = JSDOMCtor ? describe : describe.skip;

describe('RemediationSelectionPanel', () => {
  it('renders grouped remediation counts and the empty-selection hint', () => {
    const remediationItems: ReviewRemediationItem[] = [
      {
        id: 'must-fix-1',
        index: 0,
        groupIndex: 0,
        plan: 'Fix critical issue',
        issueIndex: 0,
        groupId: 'must_fix',
        defaultSelected: true,
      },
    ];

    const html = renderToStaticMarkup(
      <RemediationSelectionPanel
        {...baseProps}
        remediationItems={remediationItems}
        selectedRemediationIds={new Set()}
        completedRemediationIds={new Set()}
        decisionSelections={{}}
        expandedDecisionIds={new Set()}
      />,
    );

    expect(html).toContain('0/1 selected');
    expect(html).toContain('must_fix');
    expect(html).toContain('0/1');
    expect(html).toContain('Select at least one remediation item to start fixing.');
  });

  it('renders completed and expanded decision remediation items', () => {
    const remediationItems: ReviewRemediationItem[] = [
      {
        id: 'decision-1',
        index: 0,
        groupIndex: 0,
        plan: 'Choose a migration strategy',
        issueIndex: 0,
        groupId: 'needs_decision',
        requiresDecision: true,
        decisionContext: {
          question: 'Which migration strategy should we use?',
          tradeoffs: 'Fast path is risky; staged path is safer.',
          options: ['Fast path', 'Staged path'],
          recommendation: 1,
        },
        defaultSelected: true,
      },
    ];

    const html = renderToStaticMarkup(
      <RemediationSelectionPanel
        {...baseProps}
        remediationItems={remediationItems}
        selectedRemediationIds={new Set(['decision-1'])}
        completedRemediationIds={new Set(['decision-1'])}
        decisionSelections={{ 'decision-1': 1 }}
        expandedDecisionIds={new Set(['decision-1'])}
      />,
    );

    expect(html).toContain('Decision');
    expect(html).toContain('Which migration strategy should we use?');
    expect(html).toContain('Fast path is risky; staged path is safer.');
    expect(html).toContain('Staged path (recommended)');
    expect(html).toContain('deep-review-action-bar__remediation-item--completed');
  });
});

describeWithJsdom('RemediationSelectionPanel interactions', () => {
  let dom: { window: Window & typeof globalThis };
  let container: HTMLDivElement;
  let root: Root;

  function mount(element: React.ReactElement): void {
    act(() => {
      root.render(element);
    });
  }

  function remediationItems(): ReviewRemediationItem[] {
    return [
      {
        id: 'remediation-should-improve-1',
        index: 0,
        groupIndex: 0,
        plan: 'Improve error copy',
        issueIndex: -1,
        groupId: 'should_improve',
        defaultSelected: false,
      },
      {
        id: 'remediation-should-improve-2',
        index: 1,
        groupIndex: 1,
        plan: 'Improve retry state',
        issueIndex: -1,
        groupId: 'should_improve',
        defaultSelected: false,
      },
    ];
  }

  beforeEach(() => {
    dom = new JSDOMCtor!('<!doctype html><html><body></body></html>', {
      pretendToBeVisual: true,
      url: 'http://localhost',
    });

    const { window } = dom;
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('navigator', window.navigator);
    vi.stubGlobal('HTMLElement', window.HTMLElement);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    dom.window.close();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([true, false])('keeps list visibility when selecting all (expanded=%s)', (expanded) => {
    const onToggleAll = vi.fn();
    const onToggleList = vi.fn();
    function Panel() {
      const [selected, setSelected] = React.useState(new Set<string>());
      const [visible, setVisible] = React.useState(expanded);
      return (
        <RemediationSelectionPanel
          {...baseProps}
          remediationItems={remediationItems()}
          selectedRemediationIds={selected}
          completedRemediationIds={new Set()}
          decisionSelections={{}}
          expandedDecisionIds={new Set()}
          showRemediationList={visible}
          onToggleAll={() => {
            onToggleAll();
            setSelected(selected.size ? new Set() : new Set(remediationItems().map((item) => item.id)));
          }}
          onToggleList={() => {
            onToggleList();
            setVisible(!visible);
          }}
        />
      );
    }
    mount(<Panel />);
    const header = container.querySelector<HTMLElement>('.deep-review-action-bar__remediation-toggle')!;
    const checkbox = header.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const box = header.querySelector<HTMLElement>('[data-openbitfun-part="box"]')!;

    for (const target of [checkbox, box]) {
      act(() => { target.click(); });
      expect(checkbox.checked).toBe(target === checkbox);
      expect(Boolean(container.querySelector('.deep-review-action-bar__remediation-list'))).toBe(expanded);
      expect(onToggleList).not.toHaveBeenCalled();
    }
    expect(onToggleAll).toHaveBeenCalledTimes(2);

    act(() => { header.querySelector<HTMLElement>('.deep-review-action-bar__remediation-label')!.click(); });
    expect(onToggleList).toHaveBeenCalledTimes(1);
    expect(Boolean(container.querySelector('.deep-review-action-bar__remediation-list'))).toBe(!expanded);
    expect(onToggleAll).toHaveBeenCalledTimes(2);
  });

  it('toggles a remediation group once when clicking the root checkbox', () => {
    const onToggleGroup = vi.fn();

    mount(
      <RemediationSelectionPanel
        {...baseProps}
        remediationItems={remediationItems()}
        selectedRemediationIds={new Set()}
        completedRemediationIds={new Set()}
        decisionSelections={{}}
        expandedDecisionIds={new Set()}
        onToggleGroup={onToggleGroup}
      />,
    );

    const groupCheckbox = container.querySelector<HTMLInputElement>(
      '.deep-review-action-bar__remediation-group-header input[type="checkbox"]',
    );
    expect(groupCheckbox).toBeTruthy();

    act(() => {
      groupCheckbox!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(onToggleGroup).toHaveBeenCalledTimes(1);
    expect(onToggleGroup).toHaveBeenCalledWith('should_improve');
  });

  it('keeps the tree visible but disables selection while fixing', () => {
    const onToggleRemediation = vi.fn();
    const onToggleGroup = vi.fn();

    mount(
      <RemediationSelectionPanel
        {...baseProps}
        remediationItems={remediationItems()}
        selectedRemediationIds={new Set(['remediation-should-improve-1'])}
        completedRemediationIds={new Set()}
        fixingRemediationIds={new Set(['remediation-should-improve-1'])}
        decisionSelections={{}}
        expandedDecisionIds={new Set()}
        selectionDisabled
        onToggleRemediation={onToggleRemediation}
        onToggleGroup={onToggleGroup}
      />,
    );

    expect(container.textContent).toContain('Improve error copy');
    expect(container.textContent).toContain('Fixing');
    const checkboxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(checkboxes.length).toBeGreaterThan(0);
    expect(checkboxes.every((checkbox) => checkbox.disabled)).toBe(true);

    act(() => {
      checkboxes[checkboxes.length - 1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(onToggleRemediation).not.toHaveBeenCalled();
    expect(onToggleGroup).not.toHaveBeenCalled();
  });
});
