// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '@/infrastructure/api/service-api/AgentAPI';
import { copyTextToClipboard } from '@/shared/utils/textSelection';
import { ChatInputApprovalBand } from './ChatInputApprovalBand';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TRANSLATIONS: Record<string, string> = {
  'permission.actions.edit': 'Edit files',
  'permission.actions.bash': 'Run command',
  'permission.actions.other': 'Other action',
  'permission.allowOnce': 'Allow once',
  'permission.allowAlways': 'Always allow this scope',
  'permission.allowAlwaysCommand': 'Always allow this command',
  'permission.allowAlwaysCommandDescription': 'Applies only to this exact command, including its arguments, in the current project. Other commands are not authorized.',
  'permission.allowCurrentAndFollowing': 'Allow all',
  'permission.reject': 'Reject',
  'permission.rejectCurrentAndFollowing': 'Reject all',
  'permission.rejectWithReason': 'Reject with reason',
  'permission.responseFailed': 'The reply could not be delivered.',
  'permission.scopeThis': 'This one',
  'permission.scopeAll': 'All',
  'toolCards.common.copy': 'Copy',
  'toolCards.common.copied': 'Copied',
};

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      if (key === 'permission.subagentOwner') return `${values?.subagent} subagent`;
      if (key === 'permission.allowAlwaysTooltip') {
        return `Remember approval in ${values?.projectPath}, limited to:\n${values?.resources}`;
      }
      if (key === 'permission.risks.pageSave') {
        return `Save ${values?.slug} as ${values?.visibility} without deploying.`;
      }
      return TRANSLATIONS[key] ?? key;
    },
  }),
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Tooltip: ({ children }: { children: React.ReactElement }) => <>{children}</>,
}));

const notifyInfo = vi.hoisted(() => vi.fn());
vi.mock('@/shared/notification-system', () => ({
  notificationService: { info: notifyInfo },
}));

vi.mock('@/shared/utils/textSelection', async importOriginal => ({
  ...await importOriginal<typeof import('@/shared/utils/textSelection')>(),
  copyTextToClipboard: vi.fn(async () => true),
}));

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: 'request-1',
    roundId: 'round-1',
    order: 0,
    sessionId: 'session-1',
    toolCallId: 'tool-1',
    projectPath: '/workspace/OpenBitFun',
    projectId: 'project-1',
    agentId: 'Standard',
    action: 'edit',
    resources: ['src/main.rs'],
    saveResources: ['src/main.rs'],
    source: { kind: 'tool_call', identity: 'Write' },
    ...overrides,
  };
}

describe('ChatInputApprovalBand', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  const click = async (testId: string) => {
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  const scopeOption = (value: 'this' | 'all') => container.querySelector<HTMLButtonElement>(
    `[data-testid="chat-input-approval-scope"] [role="radio"][data-openbitfun-value="${value}"]`,
  );

  it('says what is being asked for and who is asking', async () => {
    const resources = ['src/main.rs', 'src/components/permissions/confirmation.rs'];
    await act(async () => {
      root.render(
        <ChatInputApprovalBand
          requests={[request({
            resources,
            delegation: {
              parentSessionId: 'session-1',
              parentDialogTurnId: 'turn-1',
              parentToolCallId: 'task-1',
              subagentType: 'Explore',
            },
          })]}
          onRespond={vi.fn(async () => undefined)}
          onRespondBatch={vi.fn(async () => undefined)}
        />
      );
    });

    const band = container.querySelector<HTMLElement>('[data-testid="chat-input-approval-band"]');
    expect(band?.textContent).toContain('Edit files');
    expect(band?.textContent).toContain('src/main.rs');
    expect(band?.textContent).toContain('Explore subagent');
    const resource = band?.querySelector('code');
    expect(resource?.textContent).toBe(resources.join('\n'));
    expect(resource?.querySelector('[data-openbitfun-component="overflow-text"]')).toBeNull();
  });

  it('keeps the risk on its own line so it cannot be answered unread', async () => {
    await act(async () => {
      root.render(
        <ChatInputApprovalBand
          requests={[request({
            action: 'page_publish',
            displayMetadata: {
              pageOperation: 'save',
              pageSlug: 'status',
              pageVisibility: 'public',
            },
          })]}
          onRespond={vi.fn(async () => undefined)}
          onRespondBatch={vi.fn(async () => undefined)}
        />
      );
    });

    expect(container.querySelector('[data-openbitfun-part="risk"]')?.textContent).toBe(
      'Save status as permission.visibility.public without deploying.',
    );
  });

  it('shows a confirming note while a lost answer is read back from the device', async () => {
    let finish!: () => void;
    const onRespond = vi.fn((_id: string, _reply: string, _feedback?: string, hooks?: { onConfirming?: () => void }) => {
      hooks?.onConfirming?.();
      return new Promise<void>(resolve => { finish = resolve; });
    });
    await act(async () => {
      root.render(
        <ChatInputApprovalBand
          requests={[request()]}
          onRespond={onRespond}
          onRespondBatch={vi.fn(async () => undefined)}
        />
      );
    });
    await click('chat-input-approval-allow');
    expect(container.querySelector('[data-openbitfun-part="confirming"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-part="error"]')).toBeNull();
    await act(async () => { finish(); });
    expect(container.querySelector('[data-openbitfun-part="confirming"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="error"]')).toBeNull();
  });

  it('answers only the request in front of the reader by default', async () => {
    const onRespond = vi.fn(async () => undefined);
    const onRespondBatch = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <ChatInputApprovalBand
          requests={[request()]}
          onRespond={onRespond}
          onRespondBatch={onRespondBatch}
        />
      );
    });

    // A lone request has nothing to scope, so the toggle stays out of the way.
    expect(scopeOption('all')).toBeNull();
    expect(container.querySelector('[data-testid="chat-input-approval-pending-count"]')).toBeNull();

    await click('chat-input-approval-allow');
    expect(onRespond).toHaveBeenCalledWith('request-1', 'once', undefined, expect.any(Object));
    expect(onRespondBatch).not.toHaveBeenCalled();
  });

  it('extends an answer to the queue only when the reader picks that scope', async () => {
    const onRespond = vi.fn(async () => undefined);
    const onRespondBatch = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <ChatInputApprovalBand
          requests={[request(), request({ requestId: 'request-2', toolCallId: 'tool-2' })]}
          totalPendingCount={3}
          onRespond={onRespond}
          onRespondBatch={onRespondBatch}
        />
      );
    });

    expect(
      container.querySelector('[data-testid="chat-input-approval-pending-count"]')?.textContent,
    ).toBe('+2');
    expect(
      container.querySelector<HTMLElement>('[data-testid="chat-input-approval-band"]')
        ?.dataset.approvalScope,
    ).toBe('this');

    expect(scopeOption('this')?.tabIndex).toBe(0);
    expect(scopeOption('all')?.tabIndex).toBe(-1);
    await act(async () => {
      scopeOption('this')?.focus();
      scopeOption('this')?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight', bubbles: true,
      }));
    });
    expect(document.activeElement).toBe(scopeOption('all'));
    expect(scopeOption('all')?.getAttribute('aria-checked')).toBe('true');
    expect(onRespond).not.toHaveBeenCalled();
    expect(onRespondBatch).not.toHaveBeenCalled();
    await act(async () => {
      scopeOption('all')?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Home', bubbles: true,
      }));
    });
    expect(scopeOption('this')?.getAttribute('aria-checked')).toBe('true');
    await act(async () => scopeOption('all')?.click());
    const band = container.querySelector<HTMLElement>('[data-testid="chat-input-approval-band"]');
    expect(band?.dataset.approvalScope).toBe('all');
    expect(band?.textContent).toContain('Reject all');
    // A saved grant is never applied to requests the reader has not seen.
    expect(container.querySelector('[data-testid="chat-input-approval-allow-always"]')).toBeNull();

    await click('chat-input-approval-reject');
    expect(onRespondBatch).toHaveBeenCalledWith('request-1', 'reject', undefined, expect.any(Object));
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('offers the composer text as a rejection reason instead of assuming it is one', async () => {
    const onRespond = vi.fn(async () => undefined);
    const onRejectReasonConsumed = vi.fn();

    await act(async () => {
      root.render(
        <ChatInputApprovalBand
          requests={[request()]}
          onRespond={onRespond}
          onRespondBatch={vi.fn(async () => undefined)}
        />
      );
    });
    // With an empty composer there is no reason to offer, and allowing is not
    // gated on the composer being empty either.
    expect(
      container.querySelector('[data-testid="chat-input-approval-reject-with-reason"]'),
    ).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="chat-input-approval-allow"]')?.disabled,
    ).toBe(false);

    await act(async () => {
      root.render(
        <ChatInputApprovalBand
          requests={[request()]}
          rejectReason="  use rg instead  "
          onRejectReasonConsumed={onRejectReasonConsumed}
          onRespond={onRespond}
          onRespondBatch={vi.fn(async () => undefined)}
        />
      );
    });

    // A draft in the composer never disables allowing; it only adds a way to
    // reject that carries the draft as the reason.
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="chat-input-approval-allow"]')?.disabled,
    ).toBe(false);

    await click('chat-input-approval-reject');
    expect(onRespond).toHaveBeenLastCalledWith('request-1', 'reject', undefined, expect.any(Object));
    expect(onRejectReasonConsumed).not.toHaveBeenCalled();

    await click('chat-input-approval-reject-with-reason');
    expect(onRespond).toHaveBeenLastCalledWith('request-1', 'reject', 'use rg instead', expect.any(Object));
    expect(onRejectReasonConsumed).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['accepted', 1, false],
    ['unknown', 1, false],
    ['already_resolved', 0, true],
  ] as const)('consumes the rejection reason only when it may have been delivered (%s)', async (outcome, consumed, notified) => {
    notifyInfo.mockClear();
    const onRejectReasonConsumed = vi.fn();
    await act(async () => {
      root.render(
        <ChatInputApprovalBand
          requests={[request()]}
          rejectReason="use rg instead"
          onRejectReasonConsumed={onRejectReasonConsumed}
          onRespond={vi.fn(async () => outcome)}
          onRespondBatch={vi.fn(async () => outcome)}
        />
      );
    });
    await click('chat-input-approval-reject-with-reason');
    expect(onRejectReasonConsumed).toHaveBeenCalledTimes(consumed);
    expect(notifyInfo).toHaveBeenCalledTimes(notified ? 1 : 0);
    if (notified) expect(notifyInfo).toHaveBeenCalledWith('permission.alreadyResolved', expect.anything());
    expect(container.querySelector('[data-openbitfun-part="error"]')).toBeNull();
  });

  it('reports a reply that never landed and leaves the request answerable', async () => {
    const onRespond = vi.fn(async () => {
      throw new Error('offline');
    });
    await act(async () => {
      root.render(
        <ChatInputApprovalBand
          requests={[request({ displayMetadata: { risk: 'This changes project files.' } })]}
          onRespond={onRespond}
          onRespondBatch={vi.fn(async () => undefined)}
        />
      );
    });

    await click('chat-input-approval-allow');
    expect(container.querySelector('[data-openbitfun-part="error"]')?.textContent).toBe(
      'The reply could not be delivered.',
    );
    expect(container.querySelector('[data-openbitfun-part="risk"]')?.textContent).toBe(
      'This changes project files.',
    );
    expect(
      container.querySelector<HTMLElement>('[data-testid="chat-input-approval-band"]')
        ?.dataset.openbitfunState,
    ).toBe('error');
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="chat-input-approval-allow"]')?.disabled,
    ).toBe(false);
  });

  it('describes the exact command and project scope before saving its approval', async () => {
    const command = 'git status --short';
    const onRespond = vi.fn(async () => undefined);
    const onRespondBatch = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <ChatInputApprovalBand
          requests={[request({ action: 'bash', resources: [command], saveResources: [command] })]}
          onRespond={onRespond}
          onRespondBatch={onRespondBatch}
        />,
      );
    });

    const allowAlways = container.querySelector<HTMLButtonElement>('[data-testid="chat-input-approval-allow-always"]');
    const descriptionId = allowAlways?.getAttribute('aria-describedby');
    expect(allowAlways?.textContent).toBe('Always allow this command');
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId!)?.textContent).toBe(
      'Applies only to this exact command, including its arguments, in the current project. Other commands are not authorized.',
    );

    await click('chat-input-approval-allow-always');
    expect(onRespond).toHaveBeenCalledWith('request-1', 'always', undefined, expect.any(Object));
    expect(onRespondBatch).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'bash', resources: ['git status'], saveResources: ['git diff'] },
    { action: 'edit', resources: ['src/main.rs'], saveResources: ['src/*'] },
  ])('labels $action saved resources as a scope when they differ from the request', async overrides => {
    await act(async () => {
      root.render(
        <ChatInputApprovalBand
          requests={[request(overrides)]}
          onRespond={vi.fn(async () => undefined)}
          onRespondBatch={vi.fn(async () => undefined)}
        />,
      );
    });

    expect(container.querySelector('[data-testid="chat-input-approval-allow-always"]')?.textContent).toBe(
      'Always allow this scope',
    );
    expect(container.querySelector('[data-openbitfun-part="grantScope"]')).toBeNull();
  });

  it('copies the complete command without repeating the tool name or answering permission', async () => {
    const resources = ['Get-Location;', '  Get-ChildItem -LiteralPath "my project" -Name'];
    const onRespond = vi.fn(async () => undefined);
    const onRespondBatch = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <ChatInputApprovalBand
          requests={[request({
            action: 'bash',
            source: { kind: 'tool_call', identity: 'ExecCommand' },
            resources,
          })]}
          onRespond={onRespond}
          onRespondBatch={onRespondBatch}
        />,
      );
    });

    expect(container.querySelector('[data-openbitfun-part="request"]')?.textContent).toBe('Run command');
    await click('chat-input-approval-copy');
    expect(copyTextToClipboard).toHaveBeenCalledWith(resources.join('\n'));
    expect(container.querySelector('[data-testid="chat-input-approval-copy"]')?.getAttribute('aria-label')).toBe('Copied');
    expect(onRespond).not.toHaveBeenCalled();
    expect(onRespondBatch).not.toHaveBeenCalled();
  });

  it('shows the active response as busy and prevents changing scope while it is delivered', async () => {
    let finishResponse!: () => void;
    const pendingResponse = new Promise<void>(resolve => { finishResponse = resolve; });
    const onRespond = vi.fn(() => pendingResponse);
    await act(async () => {
      root.render(
        <ChatInputApprovalBand
          requests={[request()]}
          totalPendingCount={2}
          onRespond={onRespond}
          onRespondBatch={vi.fn(async () => undefined)}
        />,
      );
    });

    await click('chat-input-approval-allow');
    const allow = container.querySelector<HTMLButtonElement>('[data-testid="chat-input-approval-allow"]');
    expect(allow?.getAttribute('aria-busy')).toBe('true');
    const approvalButtons = container.querySelectorAll<HTMLButtonElement>(
      '[data-openbitfun-component="permission-request-panel"][data-openbitfun-part="actions"] button',
    );
    expect(Array.from(approvalButtons).every(button => button.disabled)).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="chat-input-approval-copy"]')?.disabled).toBe(false);
    await act(async () => {
      allow?.click();
      scopeOption('all')?.click();
    });
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(scopeOption('this')?.getAttribute('aria-checked')).toBe('true');

    await act(async () => finishResponse());
    expect(allow?.disabled).toBe(false);
    expect(allow?.hasAttribute('aria-busy')).toBe(false);
    expect(scopeOption('all')?.disabled).toBe(false);
  });

  it('renders nothing when there is nothing to approve', async () => {
    await act(async () => {
      root.render(
        <ChatInputApprovalBand
          requests={[]}
          onRespond={vi.fn(async () => undefined)}
          onRespondBatch={vi.fn(async () => undefined)}
        />
      );
    });
    expect(container.querySelector('[data-testid="chat-input-approval-band"]')).toBeNull();
  });
});
