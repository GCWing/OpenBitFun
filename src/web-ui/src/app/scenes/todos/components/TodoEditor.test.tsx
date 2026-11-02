import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_VALIDATION_ERRORS,
  createEmptyDraft,
  type JobDraft,
  type JobDraftValidationErrors,
  type ScheduleKind,
} from '@/app/components/scheduled-jobs/scheduledJobDraft';
import { WorkspaceKind, WorkspaceType } from '@/shared/types';
import type { TodoWorkspaceOption } from '../todoPresentation';
import TodoEditor from './TodoEditor';

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key === 'shared:agents.Standard' ? '标准' : key,
  }),
}));

vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: {
    getAvailableModes: vi.fn().mockResolvedValue([{ id: 'Standard', name: 'Agentic' }]),
  },
}));

vi.mock('@/app/components/scheduled-jobs/LocalizedDateTimeField', () => ({
  default: ({
    'aria-label': ariaLabel,
    onChange,
    value,
  }: {
    'aria-label'?: string;
    onChange: (value: string) => void;
    value: string;
  }) => (
    <input
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Button: ({
    children,
    isLoading: _isLoading,
    size: _size,
    variant: _variant,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    isLoading?: boolean;
    size?: string;
    variant?: string;
  }) => <button {...props}>{children}</button>,
  Input: ({
    error: _error,
    size: _size,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & { error?: boolean; size?: string }) => (
    <input {...props} />
  ),
  Select: ({
    disabled,
    onChange,
    options = [],
    triggerAriaLabel,
    value,
    'data-testid': testId,
  }: {
    disabled?: boolean;
    onChange?: (value: string | number | (string | number)[]) => void;
    options?: Array<{ label: string; value: string | number }>;
    triggerAriaLabel?: string;
    value?: string | number | (string | number)[];
    'data-testid'?: string;
  }) => (
    <select
      aria-label={triggerAriaLabel}
      data-testid={testId}
      disabled={disabled}
      value={Array.isArray(value) ? '' : String(value ?? '')}
      onChange={(event) => onChange?.(event.currentTarget.value)}
    >
      {options.map((option) => (
        <option key={String(option.value)} value={option.value}>{option.label}</option>
      ))}
    </select>
  ),
  Switch: ({
    checked,
    description,
    label,
    onChange,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    description?: string;
    label?: string;
  }) => (
    <label>
      <input type="checkbox" checked={checked} onChange={onChange} {...props} />
      <span>{label}</span>
      <span>{description}</span>
    </label>
  ),
  Textarea: ({
    error: _error,
    showCount: _showCount,
    ...props
  }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    error?: boolean;
    showCount?: boolean;
  }) => <textarea {...props} />,
}));

const workspaceOption: TodoWorkspaceOption = {
  workspace: {
    id: 'workspace-1',
    name: 'OpenBitFun',
    rootPath: 'D:/workspace/OpenBitFun',
    workspaceType: WorkspaceType.SingleProject,
    workspaceKind: WorkspaceKind.Normal,
    languages: ['TypeScript'],
    openedAt: '2026-08-18T00:00:00.000Z',
    lastAccessed: '2026-08-18T00:00:00.000Z',
    tags: [],
  },
  value: 'workspace-1',
  label: 'OpenBitFun',
  description: 'D:/workspace/OpenBitFun',
  remoteConnectionId: null,
  remoteSshHost: null,
};

function Harness({
  initialScheduleKind = 'at',
  onCancel,
  onSave,
}: {
  initialScheduleKind?: ScheduleKind;
  onCancel: () => void;
  onSave: () => void;
}) {
  const [draft, setDraft] = useState<JobDraft>(() => ({
    ...createEmptyDraft(),
    scheduleKind: initialScheduleKind,
  }));
  const [validationErrors, setValidationErrors] = useState<JobDraftValidationErrors>(
    EMPTY_VALIDATION_ERRORS,
  );
  const [workspaceId, setWorkspaceId] = useState(workspaceOption.value);

  return (
    <TodoEditor
      draft={draft}
      onDraftChange={setDraft}
      validationErrors={validationErrors}
      onValidationErrorsChange={setValidationErrors}
      workspaceOptions={[workspaceOption]}
      selectedWorkspaceId={workspaceId}
      onSelectedWorkspaceIdChange={setWorkspaceId}
      isEditing={false}
      saving={false}
      onSave={onSave}
      onCancel={onCancel}
    />
  );
}

let JSDOMCtor: (new (
  html?: string,
  options?: { pretendToBeVisual?: boolean; url?: string },
) => { window: Window & typeof globalThis }) | null = null;

try {
  const jsdom = await import('jsdom');
  JSDOMCtor = jsdom.JSDOM as typeof JSDOMCtor;
} catch {
  JSDOMCtor = null;
}

const describeWithJsdom = JSDOMCtor ? describe : describe.skip;

describeWithJsdom('TodoEditor', () => {
  let dom: { window: Window & typeof globalThis };
  let container: HTMLDivElement;
  let root: Root;

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
    vi.stubGlobal('Event', window.Event);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    dom.window.close();
    vi.unstubAllGlobals();
  });

  it('renders the task-card form with advanced settings collapsed', async () => {
    const onCancel = vi.fn();

    await act(async () => {
      root.render(<Harness onCancel={onCancel} onSave={vi.fn()} />);
    });

    expect(container.querySelector('[data-testid="todos-editor"]')?.tagName).toBe('FORM');
    expect(container.textContent).toContain('editor.sections.information');
    expect(container.textContent).toContain('editor.smartExecution.title');
    expect(container.textContent).toContain('editor.sections.prompt');
    expect(container.querySelector('textarea')?.maxLength).toBe(1000);
    expect(container.textContent).toContain('标准');
    expect(container.textContent).not.toContain('Agentic');

    const advancedToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="todos-editor-advanced-toggle"]',
    );
    expect(advancedToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('#todos-editor-advanced-panel')).toBeNull();

    await act(async () => {
      advancedToggle?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
    expect(advancedToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('editor.advanced.empty');

    const cancelButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'common:nav.scheduledJobs.actions.cancel');
    await act(async () => {
      cancelButton?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('keeps interval anchor settings in the advanced section and submits the form', async () => {
    const onSave = vi.fn();

    await act(async () => {
      root.render(
        <Harness initialScheduleKind="every" onCancel={vi.fn()} onSave={onSave} />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="todos-editor-advanced-toggle"]')
        ?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
    expect(container.querySelector('input[aria-label="editor.fields.anchor"]')).not.toBeNull();

    await act(async () => {
      container.querySelector('form')?.dispatchEvent(
        new window.Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('keeps Cron timezone settings in the advanced section', async () => {
    await act(async () => {
      root.render(
        <Harness initialScheduleKind="cron" onCancel={vi.fn()} onSave={vi.fn()} />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="todos-editor-advanced-toggle"]')
        ?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
    expect(container.querySelector('input[aria-label="editor.fields.timezone"]')).not.toBeNull();
    expect(container.textContent).toContain('editor.hints.cronExpr');
  });
});
