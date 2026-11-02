/** @vitest-environment jsdom */
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button, Dialog, SetupWizard } from '@openbitfun/ui';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('SetupWizard public contract', () => {
  it('resets scroll only when step identity changes, preserving the editor and its focus', () => {
    const render = (id: string, description = 'Applies to future runs.') => act(() => root.render(
      <SetupWizard title="Configure" guideLabel="Guidance" contentMode={id === 'rules' ? 'contained' : 'scroll'}
        step={{ id, title: 'Execution scope', description, label: id, progress: '2 / 5' }} footer={<Button>Save</Button>}>
        <textarea defaultValue="An unsaved draft" />
      </SetupWizard>,
    ));
    render('basics');
    const viewport = container.querySelector<HTMLElement>('[data-openbitfun-component="setup-wizard"][data-openbitfun-part="content"]')!;
    const editor = container.querySelector('textarea')!;
    act(() => editor.focus());
    viewport.scrollTop = 120;
    render('basics', 'Updated explanation');
    expect(viewport.scrollTop).toBe(120);
    render('rules');
    expect(viewport.scrollTop).toBe(0);
    expect(container.querySelector('textarea')).toBe(editor);
    expect(editor.value).toBe('An unsaved draft');
    expect(document.activeElement).toBe(editor);
    expect(container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(container.querySelector('[data-content-mode]')?.getAttribute('data-content-mode')).toBe('contained');
  });

  it('leaves validation and controlled advancement to the host while footer submission reaches the form', () => {
    const save = vi.fn();
    function Example() {
      const [step, setStep] = useState(0);
      const [error, setError] = useState(false);
      return <SetupWizard title="Configure" guideLabel="Guidance" step={{ id: String(step), title: 'Scope', description: 'Choose a scope.', label: `Stage ${step + 1}`, progress: `${step + 1} / 4` }}
        footer={<Button type="submit" form="configuration">Continue</Button>}>
        <form id="configuration" onSubmit={event => {
          event.preventDefault();
          if (!(event.currentTarget.elements.namedItem('name') as HTMLInputElement).value) { setError(true); return; }
          if (step === 0) { setStep(1); setError(false); } else save();
        }}>
          <input name="name" aria-label="Name" />
          {error && <p role="alert">Enter a name</p>}
        </form>
      </SetupWizard>;
    }
    act(() => root.render(<Example />));
    const next = container.querySelector('button')!;
    act(() => next.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Enter a name');
    expect(container.textContent).toContain('Stage 1');
    container.querySelector('input')!.value = 'Research';
    act(() => next.click());
    expect(container.textContent).toContain('Stage 2');
    expect(container.querySelector('input')!.value).toBe('Research');
    expect(save).not.toHaveBeenCalled();
    act(() => next.click());
    expect(save).toHaveBeenCalledOnce();
  });

  it('connects a containing dialog to its visible heading', () => {
    act(() => root.render(<Dialog open onOpenChange={() => {}} aria-labelledby="setup-title">
      <SetupWizard titleId="setup-title" title="Configure workflow" guideLabel="Guidance"
        step={{ id: 'rules', title: 'Consistent output', description: 'Shared rules.', label: 'Rules', progress: '1 / 1' }} footer={<Button>Save</Button>}>
        <textarea aria-label="Rules" />
      </SetupWizard>
    </Dialog>));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Configure workflow');
    expect(dialog.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
  });
});
