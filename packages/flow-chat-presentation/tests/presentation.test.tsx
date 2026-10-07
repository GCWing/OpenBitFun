import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExploreGroup, FlowChatRuntimeStatus, ThinkingBlock, ToolDuration } from '@openbitfun/ui/flow-chat';
import { ExecProcessPresentation, buildExecCommandCardModel, buildExecControlCardModel, buildWriteStdinCardModel, type ExecToolSnapshot } from '../src/exec';
import { TerminalOutputFallback } from '../src/terminal';
import { createScenarioClock, execScenarios, SCENARIO_EPOCH, type ExecScenarioStep } from '../src/scenarios';
import { defaultThinkingExpanded, useThinkingDisclosure, type ThinkingDisclosureInput } from '../src/thinking';
import { formatExploreSummary } from '../src/explore';

const t = (key: string, values?: Record<string, unknown>) => `${key}${values ? ` ${Object.values(values).join(' ')}` : ''}`;
const expandedSurface = '[data-openbitfun-part="surface"][data-openbitfun-state~="expanded"]';
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function model(item: ExecToolSnapshot) {
  return item.toolName === 'WriteStdin' ? buildWriteStdinCardModel(item, t)
    : item.toolName === 'ExecControl' ? buildExecControlCardModel(item, t) : buildExecCommandCardModel(item, t);
}
function player(attention: 'ambient' | 'prominent' = 'prominent') {
  const clock = createScenarioClock();
  const output = vi.fn(({ content, maxRows }) => <TerminalOutputFallback content={content} maxRows={maxRows} />);
  const change = vi.fn();
  const copy = vi.fn();
  function render(step: ExecScenarioStep, key = 'same-instance') {
    act(() => clock.advanceTo(SCENARIO_EPOCH + step.at));
    act(() => root.render(<ExecProcessPresentation key={key} toolItem={step.item} model={model(step.item)}
      t={t} attention={attention} clock={clock} onExpandedChange={change} onCopyPrimary={copy}
      renderOutput={output} renderOutputAction={() => null} renderStatus={(props) => <ToolDuration {...props} />} />));
  }
  function toggle() {
    act(() => container.querySelector<HTMLElement>('[data-openbitfun-part="surface"][data-openbitfun-attention]')!.click());
  }
  return { clock, output, render, toggle, change, copy };
}

describe('shared raw-input scenario playback', () => {
  it('uses one ambient Shell surface across collapse and expansion with an accessible detail control', () => {
    const p = player('ambient');
    const steps = execScenarios.find(({ id }) => id === 'ExecCommand-lifecycle')!.steps;
    p.render(steps.at(-1)!);
    const surface = container.querySelector('[data-openbitfun-part="surface"][data-openbitfun-attention="ambient"]');
    expect(surface).not.toBeNull();
    const control = surface!.querySelector<HTMLButtonElement>('[data-openbitfun-part="iconAffordanceButton"]')!;
    expect(control.getAttribute('aria-expanded')).toBe('false');
    act(() => control.click());
    expect(control.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-openbitfun-part="outputFrame"]')).not.toBeNull();
    expect(surface!.textContent).not.toContain('toolCards.terminal.exitCode');
    expect(container.querySelector('[data-openbitfun-part="footer"]')?.textContent).toContain('toolCards.terminal.exitCode 0');
    expect(container.querySelector('[data-openbitfun-part="surface"][data-openbitfun-attention="ambient"]')).toBe(surface);
    p.toggle();
    expect(control.getAttribute('aria-expanded')).toBe('false');
    expect(p.change.mock.calls.map(([open]) => open)).toEqual([true, false]);
  });

  it.each(execScenarios)('$id keeps identity and renders every raw snapshot without mutating it', (scenario) => {
    const original = JSON.stringify(scenario);
    const p = player();
    let first: Element | null = null;
    for (const step of scenario.steps) {
      p.render(step);
      const current = container.querySelector('[data-openbitfun-adapter="exec-process-tool-card"]');
      expect(current).not.toBeNull();
      if (first) expect(current).toBe(first);
      first = current;
      expect(current?.getAttribute('data-tool-card-id')).toBe(step.item.id);
      const viewModel = model(step.item);
      if (viewModel.interaction) {
        expect(container.querySelector('[data-openbitfun-part="target"]')?.textContent).toBe(viewModel.interaction.target.label);
        expect(container.querySelector('[aria-expanded]')).toBeNull();
      } else {
        expect(container.textContent).toContain(viewModel.primaryText);
      }
    }
    expect(JSON.stringify(scenario)).toBe(original);
  });

  it('reveals overflowing commands without toggling the card or interrupting text selection', () => {
    const measurements = new Map<Element, () => void>();
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: () => void) {}
      observe(element: Element) { measurements.set(element, this.callback); }
      disconnect() {}
    });
    const p = player('ambient');
    p.render(execScenarios.find(({ id }) => id === 'ExecCommand-lifecycle')!.steps.at(-1)!);
    p.toggle();
    const preview = container.querySelector<HTMLElement>('[data-openbitfun-part="commandPreview"]')!;
    const command = preview.querySelector<HTMLElement>('[data-openbitfun-part="command"]')!;
    const text = command.firstElementChild!;
    const fullCommand = command.textContent;
    // jsdom supplies no layout: dimensions exercise disclosure behavior only.
    command.style.lineHeight = '20px';
    let contentHeight = 60;
    Object.defineProperties(text, {
      clientWidth: { value: 320 },
      scrollHeight: { get: () => contentHeight },
    });
    const measure = measurements.get(text)!;
    act(measure);
    expect(preview.hasAttribute('role')).toBe(false);
    expect(preview.hasAttribute('tabindex')).toBe(false);

    contentHeight = 80;
    act(measure);
    expect(preview.getAttribute('role')).toBe('button');
    expect(preview.getAttribute('aria-expanded')).toBe('false');
    const copyButton = container.querySelector<HTMLButtonElement>('[data-openbitfun-part="commandRow"] [data-openbitfun-part="copyButton"]')!;
    expect(container.querySelector('[data-openbitfun-part="surface"] [data-openbitfun-part="copyButton"]')).toBeNull();
    act(() => copyButton.click());
    expect(p.copy).toHaveBeenCalledOnce();
    expect(preview.getAttribute('aria-expanded')).toBe('false');
    act(() => preview.click());
    expect(preview.getAttribute('aria-expanded')).toBe('true');

    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(text);
    selection.addRange(range);
    act(() => preview.click());
    expect(preview.getAttribute('aria-expanded')).toBe('true');
    selection.removeAllRanges();

    act(() => preview.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
    expect(preview.getAttribute('aria-expanded')).toBe('false');
    act(() => preview.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(preview.getAttribute('aria-expanded')).toBe('true');
    expect(command.textContent).toBe(fullCommand);
    expect(p.change.mock.calls.map(([open]) => open)).toEqual([true]);

    contentHeight = 60;
    act(measure);
    expect(preview.hasAttribute('role')).toBe(false);
    expect(preview.hasAttribute('tabindex')).toBe(false);
  });

  it.each(['ambient', 'prominent'] as const)('keeps %s Shell collapsed through live output and completion with progress in the left icon', (attention) => {
    const steps = execScenarios.find(({ id }) => id === 'ExecCommand-lifecycle')!.steps;
    const p = player(attention);
    for (const step of steps.slice(0, 3)) {
      p.render(step);
      expect(container.querySelector(expandedSurface)).toBeNull();
      expect(container.querySelector('[data-openbitfun-part="icon"] [data-openbitfun-part="processing"]')).not.toBeNull();
      expect(container.querySelector('[data-openbitfun-part="statusIcon"]')).toBeNull();
    }
    p.render(steps[3]);
    expect(container.querySelector(expandedSurface)).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="processing"]')).toBeNull();
    expect(p.change).not.toHaveBeenCalled();
    p.toggle();
    expect(p.output.mock.lastCall?.[0].maxRows).toBe(15);
  });

  it('preserves manual expansion through completion; replay restores the collapsed default', () => {
    const steps = execScenarios[0].steps;
    const p = player();
    p.render(steps[2]);
    expect(container.querySelector(expandedSurface)).toBeNull();
    p.toggle();
    expect(p.output.mock.lastCall?.[0].maxRows).toBe(15);
    p.render(steps[3]);
    act(() => p.clock.advanceTo(SCENARIO_EPOCH + 1500));
    expect(container.querySelector(expandedSurface)).not.toBeNull();
    expect(p.output.mock.lastCall?.[0].maxRows).toBe(15);
    expect(p.change.mock.calls.map(([open]) => open)).toEqual([true]);
    p.render({ ...steps[3], at: 1500 }, 'reloaded-history');
    expect(container.querySelector(expandedSurface)).toBeNull();
  });

  it('does not reopen a manually collapsed stream when additional output arrives', () => {
    const p = player();
    const step = execScenarios[0].steps[2];
    p.render(step); p.toggle(); p.toggle();
    p.render({ ...step, at: 350, item: { ...step.item, _progressLogs: ['More output'] } });
    expect(container.querySelector(expandedSurface)).toBeNull();
  });

  it.each(['ambient', 'prominent'] as const)('shows exit codes only in expanded %s Shell details and preserves remote POSIX metadata', attention => {
    const p = player(attention);
    p.render(execScenarios.find(({ id }) => id === 'ExecCommand-nonzero')!.steps[0]);
    expect(container.textContent).not.toContain('toolCards.terminal.exitCode');
    p.toggle();
    expect(container.textContent).toContain('toolCards.terminal.exitCode 1');
    const exitStatus = [...container.querySelectorAll('[data-openbitfun-part="footer"] [data-tone]')]
      .find((item) => item.textContent?.includes('toolCards.terminal.exitCode 1'));
    expect(exitStatus?.textContent).toContain('toolCards.terminal.exitCode 1');
    expect(exitStatus?.getAttribute('data-tone')).toBe('neutral');
    expect(exitStatus?.querySelector('.lucide-check')).toBeNull();
    expect(container.querySelector(expandedSurface)?.textContent).not.toContain('toolCards.terminal.exitCode');
    expect(container.textContent).toContain('/workspace/project');
    expect(container.textContent).toContain('toolCards.execProcess.remote');
    expect(container.querySelector('[data-openbitfun-state="completed"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-part="error"]')).toBeNull();
    p.toggle();
    expect(container.textContent).not.toContain('toolCards.terminal.exitCode');
  });

  it('projects legacy JSON identically, tolerates missing results, and distinguishes polling from input', () => {
    const normal = execScenarios[0].steps.at(-1)!.item;
    const legacy = execScenarios.find(({ id }) => id === 'ExecCommand-legacy')!.steps[0].item;
    expect(model(legacy)).toEqual(model(normal));
    expect(model({ ...normal, toolResult: { result: { unknown_future_field: true } } }).resultOutput).toBe('');
    const missing = execScenarios.find(({ id }) => id === 'WriteStdin-missing')!.steps[0].item;
    expect(model(missing).resultNoticeText).toContain('42');
    expect(model(missing).copyDisabled).toBe(true);
    const input = execScenarios.find(({ id }) => id === 'WriteStdin-input')!.steps[0].item;
    expect(model(input).copyText).toBe('yes\n');
    expect(model(input).copyDisabled).toBe(false);
  });
});

function Reasoning({ input }: { input: ThinkingDisclosureInput }) {
  const state = useThinkingDisclosure(input);
  return <ThinkingBlock expanded={state.expanded} onToggle={state.toggle} label="Thinking" streaming={input.isActive}>
    <a href="#evidence">Evidence</a>
  </ThinkingBlock>;
}

describe('conversation disclosure contracts', () => {
  it('static catalog specimens do not introduce focusable disclosure controls', () => {
    act(() => root.render(<><ThinkingBlock label="Thinking" expanded={false} /><ExploreGroup expanded={false} summary="Explore" /></>));
    expect(container.querySelector('[role="button"]')).toBeNull();
    expect(container.querySelector('[tabindex="0"]')).toBeNull();
  });
  it('uses summary, tail and subagent rules without timers or host state', () => {
    expect(defaultThinkingExpanded({ isSummary: true, isLastItem: true, isActive: true })).toBe(false);
    expect(defaultThinkingExpanded({ isSummary: false, isLastItem: false, isActive: true })).toBe(true);
    expect(defaultThinkingExpanded({ isSummary: false, isLastItem: false, isActive: false, isRevealing: true })).toBe(true);
    expect(defaultThinkingExpanded({ isSummary: false, isLastItem: false, isActive: false })).toBe(false);
    expect(defaultThinkingExpanded({ isSummary: false, isLastItem: false, isActive: true, displayContext: 'subagent-projection' })).toBe(true);
    expect(defaultThinkingExpanded({ isSummary: true, isLastItem: false, isActive: false, forceExpanded: true })).toBe(true);
  });

  it('keeps reasoning mounted and native button activation overrides later automatic state', () => {
    const input = { isSummary: false, isLastItem: true, isActive: true };
    act(() => root.render(<Reasoning input={input} />));
    const panel = container.querySelector('[data-testid="chat-thinking-panel"]');
    const toggle = container.querySelector<HTMLElement>('[data-testid="chat-thinking-toggle"]')!;
    const content = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('type')).toBe('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // The browser owns Space/Enter activation; handling keydown here as well
    // would toggle twice once the native click is emitted.
    act(() => toggle.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    act(() => toggle.dispatchEvent(new MouseEvent('click', { detail: 0, bubbles: true })));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(content.hasAttribute('inert')).toBe(true);
    act(() => root.render(<Reasoning input={{ ...input, forceExpanded: true }} />));
    expect(container.querySelector('[data-testid="chat-thinking-panel"]')).toBe(panel);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('exploration maintains controlled state, stable item identity and accessible collapse', () => {
    function Example() {
      const [expanded, setExpanded] = useState(true);
      return <ExploreGroup expanded={expanded} onToggle={() => setExpanded(!expanded)} summary="2 次探索"
        summaryDescription="2 次探索">
        <button data-item="stable">Open file</button>
      </ExploreGroup>;
    }
    act(() => root.render(<Example />));
    const item = container.querySelector('[data-item="stable"]');
    const toggle = container.querySelector<HTMLElement>('[data-testid="chat-explore-group-toggle"]')!;
    expect(toggle.textContent).toBe('2 次探索');
    expect(toggle.getAttribute('aria-label')).toBe('2 次探索');
    act(() => toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)!.hasAttribute('inert')).toBe(true);
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-item="stable"]')).toBe(item);
  });

  it('runtime visibility never replaces its resident slot and delay clears on hide', () => {
    act(() => root.render(<FlowChatRuntimeStatus label="Working" visible revealDelayMs={160} />));
    const slot = container.firstElementChild;
    act(() => root.render(<FlowChatRuntimeStatus label="Done" visible={false} />));
    expect(container.firstElementChild).toBe(slot);
    expect(slot?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector<HTMLElement>('.runtime-status-slot__content')?.style.transitionDelay).toBe('');
  });

  it('exploration summary is shared across mixed, single-kind and otherwise unclassified input', () => {
    const translate = vi.fn(t);
    formatExploreSummary({ readCount: 2, searchCount: 1, commandCount: 0 }, 3, translate);
    expect(translate.mock.calls.map(([key]) => key)).toEqual(['exploreRegion.exploreCount']);
    expect(formatExploreSummary({ readCount: 0, searchCount: 0, commandCount: 0 }, 1, t)).toBe('exploreRegion.exploreCount 1');
  });
});
