import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolRelationRow, type ToolCardInteraction } from '@openbitfun/ui/flow-chat';
import { ExecProcessPresentation, buildWriteStdinCardModel, buildExecControlCardModel, type ExecToolSnapshot } from '../src/exec';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const relationship: ToolCardInteraction = {
  operation: 'send', source: { label: 'Current session', kind: 'session' },
  target: { id: 'result', label: 'Maintainer', kind: 'agent', details: 'Historical agent record' },
};
function click(selector: string) { act(() => container.querySelector<HTMLButtonElement>(selector)!.click()); }

describe('relationship element interactions', () => {
  it('opens the outcome in a dialog without a row disclosure or parent click', () => {
    let bubbled = 0;
    act(() => root.render(<div onClick={() => { bubbled++; }}><ToolRelationRow interaction={relationship}
      result="Sent 1 message" status="completed" details="Keep the original message body" resultLabel="View the message" /></div>));
    const row = container.querySelector<HTMLElement>('[data-openbitfun-component="tool-relation-row"]')!;
    expect(row.getAttribute('role')).toBeNull();
    expect(row.querySelector('[aria-expanded]')).toBeNull();
    act(() => row.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const before = bubbled;
    click('[data-openbitfun-part="result"]');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Keep the original message body');
    expect(bubbled).toBe(before);
    expect(row.querySelector('[aria-expanded]')).toBeNull();
  });

  it('keeps target navigation separate from result details and lists each recipient once', () => {
    const opened: string[] = [];
    const targets = ['A', 'B'].map(id => ({ id, label: id, kind: 'agent' as const, onOpen: () => opened.push(id) }));
    act(() => root.render(<ToolRelationRow interaction={{ ...relationship, operation: 'receive', targets }}
      result="Received 2 results" status="completed" details="Actual returned results" />));
    const buttons = container.querySelectorAll<HTMLButtonElement>('[data-openbitfun-part="target"]');
    expect(buttons).toHaveLength(2);
    act(() => buttons[1].click());
    expect(opened).toEqual(['B']);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('.lucide-arrow-left')).not.toBeNull();
    expect(container.querySelector('.lucide-arrow-right')).toBeNull();
  });

  it('inspects an unavailable object independently, including IDs that match result slot names', () => {
    act(() => root.render(<ToolRelationRow interaction={relationship} result="Deleted" status="completed" details="Deletion record" />));
    click('[data-openbitfun-part="target"]');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Historical agent record');
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Deletion record');
  });
});

describe('process relationship records', () => {
  const t = (key: string) => key;
  function render(item: ExecToolSnapshot) {
    let expanded = false;
    act(() => root.render(<ExecProcessPresentation toolItem={item}
      model={item.toolName === 'WriteStdin' ? buildWriteStdinCardModel(item, t) : buildExecControlCardModel(item, t)}
      t={t} onCopyPrimary={() => {}} onExpandedChange={() => { expanded = true; }}
      renderOutput={({ content }) => <pre>{content}</pre>} renderOutputAction={() => null} renderStatus={() => null} />));
    return () => expanded;
  }
  it('keeps process output available without automatically expanding the transcript', () => {
    const expanded = render({ id: 'input', toolName: 'WriteStdin', status: 'running',
      toolCall: { input: { session_id: 24, chars: 'continue\n' } }, _progressMessage: 'running output' });
    expect(expanded()).toBe(false);
    expect(container.querySelector('[aria-expanded]')).toBeNull();
    click('[data-openbitfun-part="result"]');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('continue\n');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('running output');
  });
  it('shows missing processes as errors rather than successful termination', () => {
    render({ id: 'stop', toolName: 'ExecControl', status: 'completed', toolCall: { input: { session_id: 24, action: 'terminate' } },
      toolResult: { success: true, result: JSON.stringify({ status: 'session_not_found', requested_session_id: 24 }) } });
    expect(container.querySelector('[data-openbitfun-status="error"]')).not.toBeNull();
    expect(container.textContent).toContain('toolCards.execProcess.sessionNotFound');
    expect(container.textContent).not.toContain('toolCards.interaction.terminated');
  });
});
