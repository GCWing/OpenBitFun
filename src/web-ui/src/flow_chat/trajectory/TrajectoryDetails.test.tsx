// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resolve } from 'node:path';
import { compile } from 'sass';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DialogTurn, Session } from '../types/flow-chat';
import type { TrajectoryPanelData } from './trajectoryPanel';
const mocks = vi.hoisted(() => ({ state: { sessions: new Map<string, Session>() }, surface: { surfaceId: 'local', epoch: 1, isCurrent: () => true },
  window: vi.fn(), older: vi.fn() }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key,
  formatNumber: (value: number) => `${value}s`, formatDate: (value: number) => String(value) }) }));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({ getActiveSurfaceScope: () => mocks.surface, onSurfaceActivated: () => () => {} }));
vi.mock('../store/FlowChatStore', () => ({ flowChatStore: { subscribe: () => () => {}, getState: () => mocks.state,
  getSessionHistoryViewState: () => undefined, loadSessionTurnWindow: mocks.window, loadOlderRelaySessionHistory: mocks.older } }));
vi.mock('./trajectoryPanel', () => ({ TRAJECTORY_NAVIGATE_EVENT: 'trajectory-test' }));
vi.mock('@/infrastructure/event-bus', () => ({ globalEventBus: { emit: vi.fn() } }));
import { TrajectoryDetails } from './TrajectoryDetails';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement; let turn: DialogTurn;
const node: TrajectoryPanelData['node'] = { id: 'tool', turnId: 'turn', turnOrdinal: 0, roundId: 'round', kind: 'tool', label: 'Read',
  status: 'completed', timestamp: 1, preview: '', matched: false };
beforeEach(() => {
  mocks.surface = { surfaceId: 'local', epoch: 1, isCurrent: () => true };
  mocks.window.mockReset(); mocks.older.mockReset();
  turn = { id: 'turn', userMessage: { id: 'u', content: 'USER', timestamp: 1 }, modelRounds: [{ id: 'round', items: [{
    id: 'tool', type: 'tool', toolName: 'Read', durationMs: 0, toolCall: { id: 'call', input: { path: '/remote/path' } },
    toolResult: { success: true, result: 'x'.repeat(12000) + 'NEEDLE', duration_ms: 0 }, status: 'completed',
  }] }] } as DialogTurn;
  mocks.state = { sessions: new Map([['s', { sessionId: 's', dialogTurns: [turn] } as Session]]) };
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function render(query = '', surfaceId = 'local', selectedNode = node) { await act(async () => root.render(<TrajectoryDetails
  sessionId="s" surfaceId={surfaceId} viewId="v" node={selectedNode} query={query} />)); }

describe('trajectory detail composition', () => {
  it('shows timing in the header and bounded parameter/result chapters without tabs', async () => {
    (turn.modelRounds[0].items[0] as any).queueWaitMs = 0;
    (turn.modelRounds[0].items[0] as any).executionMs = 1234;
    await render();
    expect(container.querySelector('[data-openbitfun-component="page-header"]')).not.toBeNull();
    expect(container.querySelectorAll('[role="tab"], [role="tablist"], [role="tabpanel"]')).toHaveLength(0);
    expect(container.querySelectorAll('.trajectory-details__section[data-openbitfun-component="disclosure"]')).toHaveLength(2);
    expect(container.querySelector('.trajectory-details__name')?.textContent).toBe('path');
    expect(container.querySelector('.trajectory-details__type')?.textContent).toBe('string');
    expect(container.querySelector('.trajectory-details__field dd')?.textContent).toBe('/remote/path');
    expect(container.querySelectorAll('[data-openbitfun-component="status-pill"]')).toHaveLength(1);
    const timing = container.querySelector('.trajectory-details__header .trajectory-details__timing')!;
    expect([...timing.querySelectorAll('dt')].map(label => label.textContent))
      .toEqual(['trajectory.started', 'trajectory.duration', 'trajectory.queue', 'trajectory.execution']);
    expect([...timing.querySelectorAll('dd')].map(value => value.textContent)).toEqual(['1', '0s', '0s', '1.234s']);
    expect(container.textContent).not.toContain('NEEDLE');
    expect(container.textContent).not.toContain('trajectory.firstOutput');
    expect(mocks.window).not.toHaveBeenCalled();
  });
  it('keeps unknown timing distinct from zero and avoids elapsed time for user messages', async () => {
    (turn.modelRounds[0].items[0] as any).durationMs = undefined;
    await render();
    expect(container.querySelector('.trajectory-details__timing')?.textContent).toContain('trajectory.notRecorded');
    expect(container.querySelector('.trajectory-details__timing')?.textContent).not.toContain('0s');
    await render('', 'local', { ...node, id: 'u', kind: 'user', roundId: undefined });
    expect(container.querySelectorAll('.trajectory-details__timing dt')).toHaveLength(1);
    expect(container.querySelector('[data-trajectory-section="parameters"]')).toBeNull();
    expect(container.querySelector('[data-trajectory-section="result"] pre')?.textContent).toBe('USER');
  });
  it('shows a distant search hit without mounting the entire tool result', async () => {
    await render('needle');
    expect(container.querySelector('mark')?.textContent).toBe('NEEDLE');
    expect(container.textContent!.length).toBeLessThan(5000);
  });
  it('preserves path search hits when presenting short parameter values', async () => {
    (turn.modelRounds[0].items[0] as any).toolCall.input = { path: String.raw`C:\workspace\file.ts` };
    await render(String.raw`C:\workspace`);
    expect(container.querySelector('.trajectory-details__field dd mark')?.textContent).toBe(String.raw`C:\workspace`);
  });
  it('reveals the matched chapter inside the details viewport without scrolling ancestors', async () => {
    (turn.modelRounds[0].items[0] as any).toolCall.input = { path: 'NEEDLE' };
    await render('needle');
    const viewport = container.querySelector<HTMLDivElement>('.trajectory-details__viewport')!;
    const result = container.querySelector<HTMLElement>('[data-trajectory-section="result"] mark')!;
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 10 } as DOMRect);
    vi.spyOn(result, 'getBoundingClientRect').mockReturnValue({ top: 310 } as DOMRect);
    container.scrollTop = 21;
    viewport.scrollTop = 20;
    await render('needle', 'local', { ...node, matchField: 'result' });
    expect(viewport.scrollTop).toBe(320);
    expect(container.scrollTop).toBe(21);
    expect(container.querySelectorAll('.trajectory-details__section')).toHaveLength(2);
  });
  it('unmounts collapsed output and reopens it for a new search hit', async () => {
    vi.useFakeTimers();
    await render();
    const outputHeader = container.querySelector<HTMLButtonElement>('[data-trajectory-section="result"] .trajectory-details__section-header button')!;
    await act(async () => outputHeader.click());
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(container.querySelector('pre')).toBeNull();
    await render('needle');
    expect(container.querySelector('mark')?.textContent).toBe('NEEDLE');
    expect(container.textContent!.length).toBeLessThan(5000);
  });
  it('pages large parameter objects and opens only the branch containing a search hit', async () => {
    const tool = turn.modelRounds[0].items[0] as any;
    tool.toolCall.input = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`field-${index}`, { value: `entry-${index}` }]));
    await render();
    expect(container.querySelectorAll('.trajectory-details__name')).toHaveLength(50);
    expect(container.textContent).not.toContain('entry-');
    const more = [...container.querySelectorAll<HTMLButtonElement>('.trajectory-details__tree button')]
      .find(button => button.textContent === 'trajectory.showMore')!;
    await act(async () => more.click());
    expect(container.querySelectorAll('.trajectory-details__name')).toHaveLength(100);
    await render('entry-119');
    expect(container.querySelector('mark')?.textContent).toBe('entry-119');
    expect(container.querySelectorAll('.trajectory-details__name')).toHaveLength(51);
    expect(container.textContent).not.toContain('entry-118');
  });
  it('does not replace a removed tool with unrelated user content', async () => {
    turn.modelRounds[0].items = [];
    await render();
    expect(container.textContent).toContain('trajectory.unavailable');
    expect(container.textContent).not.toContain('USER');
  });
  it('keeps recorded fields plain when the app global code styles are present', async () => {
    const style = document.createElement('style');
    style.textContent = compile(resolve(__dirname, '../../app/styles/global.scss')).css;
    document.head.append(style);
    // jsdom parses cascade layers but does not apply them to computed styles.
    // Flatten the actual base rules before adding the component overrides.
    const baseRules = [...style.sheet!.cssRules].flatMap(rule => 'name' in rule && rule.name === 'openbitfun.base'
      ? [...(rule as CSSGroupingRule).cssRules] : [rule]);
    style.textContent = baseRules.map(rule => rule.cssText).join('\n') + compile(resolve(__dirname, 'Trajectory.scss')).css;
    const outsideCode = document.createElement('code'); outsideCode.textContent = 'outside'; document.body.append(outsideCode);
    try {
      await render();
      expect(getComputedStyle(outsideCode).padding).toBe('2px 4px');
      for (const field of container.querySelectorAll('.trajectory-details__name, .trajectory-details__type, .trajectory-details__inline-value, .trajectory-details__value')) {
        const computed = getComputedStyle(field);
        expect(computed.padding).toBe('0px');
        expect(computed.borderTopWidth).toBe('0px');
        expect(computed.backgroundColor).toBe('rgba(0, 0, 0, 0)');
      }
    } finally { style.remove(); outsideCode.remove(); }
  });
  it('keeps long paths readable and expands nested results without losing zero or false values', async () => {
    const path = '/Users/gcwing/WorkSpace/OpenBitFun-WorkSpace/OpenBitFun/docs/features/miniapp.md';
    (turn.modelRounds[0].items[0] as any).toolResult.result = { match_count: 0, matches: [path], path, truncated: false };
    await render();
    const result = container.querySelector('[data-trajectory-section="result"]')!;
    expect(result.querySelector('[data-layout="stacked"] dd')?.textContent).toBe(path);
    expect([...result.querySelectorAll('.trajectory-details__field dd')].map(value => value.textContent)).toEqual(['0', path, 'false']);
    const nested = result.querySelector<HTMLButtonElement>('.trajectory-details__nested-trigger')!;
    expect(nested.getAttribute('aria-expanded')).toBe('false');
    await act(async () => nested.click());
    expect(result.querySelector('.trajectory-details__nested-content dd')?.textContent).toBe(path);
  });
  it('retains explicit null output and rejects retained bodies from another device', async () => {
    (turn.modelRounds[0].items[0] as any).toolResult.result = null;
    await render();
    expect(container.querySelector('.trajectory-details__inline-value')?.textContent).toBe('/remote/path');
    expect(container.querySelector('pre')?.textContent).toBe('null');
    mocks.surface = { surfaceId: 'peer:b', epoch: 2, isCurrent: () => true };
    mocks.state = { sessions: new Map([['s', { sessionId: 's', dialogTurns: [], isPartial: false } as unknown as Session]]) };
    await render('', 'peer:b');
    expect(container.textContent).toContain('trajectory.unavailable');
    expect(container.textContent).not.toContain('/remote/path');
    expect(mocks.window).not.toHaveBeenCalled();
  });
});
