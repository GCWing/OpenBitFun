import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Alert, Button, Disclosure, Empty, FieldGroup, FieldRow, Icon, LoadingState, OverflowText, PageHeader, ScrollArea, Stack, StatusPill } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { flowChatStore } from '../store/FlowChatStore';
import type { DialogTurn, FlowToolItem } from '../types/flow-chat';
import { globalEventBus } from '@/infrastructure/event-bus';
import type { TrajectoryRangeSummary } from './trajectoryRange';
import { TRAJECTORY_NAVIGATE_EVENT, type TrajectoryPanelData } from './trajectoryPanel';
import { trajectoryValueMatches } from './trajectoryModel';
import { trajectoryStatus } from './trajectoryPresentation';
import './Trajectory.scss';

const subscribe = (listener: () => void) => flowChatStore.subscribe(listener);
const getState = () => flowChatStore.getState();

const QueryContext = createContext('');
function HighlightedText({ text }: { text: string }) {
  const query = useContext(QueryContext).trim().toLowerCase();
  if (!query) return text;
  const parts: ReactNode[] = []; let offset = 0;
  for (;;) {
    const index = text.toLowerCase().indexOf(query, offset);
    if (index < 0) { parts.push(text.slice(offset)); break; }
    parts.push(text.slice(offset, index), <mark key={index}>{text.slice(index, index + query.length)}</mark>);
    offset = index + query.length;
  }
  return <>{parts}</>;
}

/** Strings and object branches are independently paged; never stringify a whole result. */
function ValueView({ value }: { value: unknown }) {
  const { t } = useI18n('flow-chat');
  const query = useContext(QueryContext).trim().toLowerCase();
  const [limit, setLimit] = useState(4000);
  if (value === undefined) return <span>{t('trajectory.notRecorded')}</span>;
  if (value === null || typeof value !== 'object') {
    const text = String(value);
    const hit = query ? text.toLowerCase().indexOf(query) : -1;
    const start = hit >= limit ? Math.max(0, hit - 200) : 0;
    return <Stack gap="2"><pre className="trajectory-details__value" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="value">
      {start > 0 && '…'}<HighlightedText text={text.slice(start, start + limit)} />
    </pre>{text.length > start + limit && <Button size="xs" variant="text"
      onClick={() => setLimit(amount => amount + 16000)}>{t('trajectory.showMore')}</Button>}</Stack>;
  }
  return <ValueTree value={value} />;
}
function ValueTree({ value }: { value: object }) {
  const { t } = useI18n('flow-chat');
  const query = useContext(QueryContext).trim().toLowerCase();
  const [limit, setLimit] = useState(50);
  const keys = useMemo(() => {
    const keys = Object.keys(value);
    if (!query) return keys;
    const matching = keys.filter(key => key.toLowerCase().includes(query) || trajectoryValueMatches((value as Record<string, unknown>)[key], query));
    const found = new Set(matching);
    return [...matching, ...keys.filter(key => !found.has(key))];
  }, [value, query]);
  if (!keys.length) return <code className="trajectory-details__inline-value" data-openbitfun-product-component="session-trajectory"
    data-openbitfun-product-part="inlineValue">{Array.isArray(value) ? '[]' : '{}'}</code>;
  return <FieldGroup appearance="plain" dividers className="trajectory-details__tree" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="tree">
    {keys.slice(0, limit).map(key => <ValueBranch key={key} name={key} value={(value as Record<string, unknown>)[key]} />)}
    {keys.length > limit && <Button size="xs" variant="text" onClick={() => setLimit(count => count + 50)}>{t('trajectory.showMore')}</Button>}
  </FieldGroup>;
}
function ValueBranch({ name, value }: { name: string; value: unknown }) {
  const { t } = useI18n('flow-chat');
  const query = useContext(QueryContext).trim().toLowerCase();
  const short = value === null || typeof value !== 'object' && String(value).length <= 160;
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const label = <span className="trajectory-details__field-label" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="fieldLabel">
    <code className="trajectory-details__name" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="name"><HighlightedText text={name} /></code>
    {value !== undefined && <code className="trajectory-details__type" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="type">{type}</code>}
  </span>;
  if (short) return <FieldRow align="start" padding="none" className="trajectory-details__attribute"
    data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="attribute">
    <dl className="trajectory-details__field" data-layout={typeof value === 'string' && (value.length > 64 || value.includes('\n')) ? 'stacked' : 'inline'}
      data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="field">
      <dt>{label}</dt>
      <dd><code className="trajectory-details__inline-value" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="inlineValue">
        <HighlightedText text={value === undefined ? t('trajectory.notRecorded') : value === '' ? '""' : String(value)} />
      </code></dd>
    </dl>
  </FieldRow>;
  return <FieldRow align="start" padding="none" className="trajectory-details__attribute"
    data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="attribute">
    <Disclosure summary={label} defaultOpen={!!query && (name.toLowerCase().includes(query) || trajectoryValueMatches(value, query))}
      className="trajectory-details__branch" headerClassName="trajectory-details__nested-header"
      triggerClassName="trajectory-details__nested-trigger" contentInnerClassName="trajectory-details__nested-content"
      data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="branch"
      unmountOnClose><ValueView value={value} /></Disclosure>
  </FieldRow>;
}
function DetailSection({ title, section, children }: {
  title: string; section?: 'parameters' | 'result'; children: ReactNode;
}) {
  return <Disclosure summary={<span className="trajectory-details__section-title" data-openbitfun-product-component="session-trajectory"
    data-openbitfun-product-part="sectionTitle">{title}</span>} defaultOpen unmountOnClose className="trajectory-details__section"
    headerClassName="trajectory-details__section-header" triggerClassName="trajectory-details__section-trigger"
    contentInnerClassName="trajectory-details__section-content"
    data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="section" data-trajectory-section={section}>
    <Stack gap="2">{children}</Stack>
  </Disclosure>;
}
function TimingSummary({ values }: { values: string[][] }) {
  return <dl className="trajectory-details__timing" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="timing">
    {values.map(([label, value]) => <div key={label} className="trajectory-details__timing-item">
      <dt className="trajectory-details__label" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="label">{label}</dt>
      <dd className="trajectory-details__fact-value" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="factValue">{value}</dd>
    </div>)}
  </dl>;
}
function DetailFields({ values }: { values: string[][] }) {
  return <FieldGroup appearance="plain" dividers>{values.map(([label, value]) => <FieldRow key={label} align="start" padding="none"
    className="trajectory-details__fact" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="fact">
    <div className="trajectory-details__fact-content">
      <span className="trajectory-details__label" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="label">{label}</span>
      <span className="trajectory-details__fact-value" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="factValue">{value}</span>
    </div>
  </FieldRow>)}</FieldGroup>;
}

export function TrajectoryDetails({ sessionId, surfaceId, node, query }: TrajectoryPanelData) {
  const { t, formatNumber, formatDate } = useI18n(['flow-chat', 'shared']);
  const state = useSyncExternalStore(subscribe, getState, getState);
  const surface = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [retained, setRetained] = useState<{ owner: string; turn: DialogTurn }>();
  const owner = JSON.stringify([surfaceId, surface.epoch, sessionId]);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const session = surface.surfaceId === surfaceId ? state.sessions.get(sessionId) : undefined;
  const live = session?.dialogTurns.find(turn => turn.id === node.turnId);
  const cached = !live && session ? flowChatStore.getSessionHistoryViewState(sessionId)?.loadedRanges
    .flatMap(range => range.turns).find(turn => turn.id === node.turnId) : undefined;
  const retired = session?.turnCatalog?.complete === true && !session.turnCatalog.entries.some(entry => entry.turnId === node.turnId)
    && !live;
  const turn = retired ? undefined : live ?? cached ?? (surface.surfaceId === surfaceId && retained?.owner === owner && retained.turn.id === node.turnId ? retained.turn : undefined);
  const hasTurn = !!turn;
  const hasSession = !!session;
  useEffect(() => { const turn = live ?? cached; if (turn) setRetained({ owner, turn }); }, [live, cached, owner]);
  useEffect(() => {
    if (hasTurn || retired || !hasSession || surface.surfaceId !== surfaceId) return;
    let cancelled = false;
    setLoading(true);
    const current = () => !cancelled && surface.isCurrent();
    const read = async () => {
      if (surfaceId !== 'local') {
        let snapshot = flowChatStore.getState().sessions.get(sessionId);
        while (current() && snapshot?.isPartial && !snapshot.dialogTurns.some(turn => turn.id === node.turnId)) {
          const advanced = await flowChatStore.loadOlderRelaySessionHistory(sessionId);
          if (!current()) return;
          snapshot = flowChatStore.getState().sessions.get(sessionId);
          if (!advanced) break;
        }
        return snapshot?.dialogTurns.find(turn => turn.id === node.turnId);
      }
      const result = await flowChatStore.loadSessionTurnWindow(sessionId, node.turnOrdinal, { before: 0, after: 1, source: 'target' });
      return result.isCurrent && result.status === 'ready' ? result.range?.turns.find(item => item.id === node.turnId) : undefined;
    };
    void read().then(turn => {
      if (current() && turn) setRetained({ owner, turn });
    }).catch(() => {}).finally(() => { if (current()) setLoading(false); });
    return () => { cancelled = true; };
  }, [node.turnId, node.turnOrdinal, sessionId, surfaceId, surface, retry, hasTurn, hasSession, retired, owner]);
  const round = turn?.modelRounds.find(item => item.id === node.roundId);
  const item = round?.items.find(item => item.id === node.id);
  const tool = item?.type === 'tool' ? item as FlowToolItem : undefined;
  const user = node.focusItemId && item?.type === 'user-steering' ? item : turn?.userMessage;
  const output = useMemo(() => tool?.toolResult ? (tool.toolResult.result !== undefined ? tool.toolResult.result : tool.toolResult.resultForAssistant)
    : (node.kind === 'model' ? round?.items.filter(item => item.type === 'text' || item.type === 'thinking')
      .map(item => ({ id: item.id, content: item.content })) : user?.content), [tool, round, user, node.kind]);
  const available = !!turn && (node.kind === 'tool' ? !!tool : node.kind === 'model' ? !!round : !!user);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const section = node.matchField === 'parameters' ? 'parameters' : 'result';
    const match = query && available ? viewport.querySelector<HTMLElement>(`[data-trajectory-section="${section}"] mark`)
      ?? viewport.querySelector<HTMLElement>('mark') : null;
    // Keep search navigation inside this panel; do not scroll the conversation or its ancestors.
    viewport.scrollTop = match ? Math.max(0, viewport.scrollTop + match.getBoundingClientRect().top - viewport.getBoundingClientRect().top) : 0;
  }, [owner, node.id, node.turnId, node.matchField, query, available]);
  const missing = t('trajectory.notRecorded');
  const duration = (value?: number | null) => typeof value === 'number' && Number.isFinite(value)
    ? formatNumber(value / 1000, { style: 'unit', unit: 'second', maximumFractionDigits: 3 }) : missing;
  const status = tool?.status ?? (node.kind === 'model' ? round?.status : node.status) ?? node.status;
  const statusPresentation = trajectoryStatus(status, t);
  const source = node.kind === 'user' ? undefined : tool ?? round;
  const timing = [
    [t('trajectory.duration'), duration(source?.durationMs ?? node.durationMs)],
    [t('trajectory.queue'), duration(tool?.queueWaitMs)], [t('trajectory.preflight'), duration(tool?.preflightMs)],
    [t('trajectory.confirmation'), duration(tool?.confirmationWaitMs)], [t('trajectory.execution'), duration(tool?.executionMs)],
    [t('trajectory.firstOutput'), duration(round?.ttftMs)], [t('trajectory.streaming'), duration(round?.streamDurationMs)],
  ];
  const parameters = tool?.toolCall.input ?? (round && { providerId: round.providerId, model: round.effectiveModelName,
    modelConfigId: round.modelConfigId, routing: round.routing, attempts: round.attemptDiagnostics, tokenDetails: round.tokenDetails });
  const fields = [[t('trajectory.started'), node.timestamp ? formatDate(node.timestamp, { dateStyle: 'medium', timeStyle: 'medium' }) : missing],
    ...timing.filter(([, value], index) => node.kind !== 'user' && (index === 0 || value !== missing
      && (node.kind === 'tool' ? index <= 4 : index >= 5)))];
  return <div className="trajectory-details" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="details">
    <div className="trajectory-details__header" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="header">
    <PageHeader level={2} size="sm" className="trajectory-details__identity" title={<span className="trajectory-details__heading"
      data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="heading">
      <OverflowText>{node.label || (node.kind === 'user' ? t('trajectory.user') : t('trajectory.model'))}</OverflowText>
      <span className="trajectory-details__turn" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="turn">{t('trajectory.turn', { turn: node.turnOrdinal + 1 })}</span>
    </span>}
      leading={<Icon size="sm" name={node.kind === 'tool' ? 'terminal' : node.kind === 'user' ? 'user' : 'message-square'} />}
      action={<StatusPill tone={statusPresentation.tone}>{statusPresentation.label}</StatusPill>} />
    <TimingSummary values={fields} />
    </div>
    <ScrollArea ref={viewportRef} className="trajectory-details__viewport" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="viewport">
      <QueryContext.Provider value={query}>
      <Stack gap="4">
        {query && <Alert tone="info" message={t('trajectory.query', { query })} />}
        {!available ? !turn && loading ? <LoadingState>{t('trajectory.loading')}</LoadingState>
          : <Empty title={t('trajectory.unavailable')} actions={!turn && !retired && session
            ? <Button size="sm" variant="secondary" onClick={() => setRetry(value => value + 1)}>{t('trajectory.retry')}</Button> : undefined} />
          : <>
            {node.kind !== 'user' && <DetailSection title={t('trajectory.parameters')} section="parameters"
              key={`${node.turnId}:${node.id}:parameters:${query}`}>
              <ValueView value={parameters} />
            </DetailSection>}
            <DetailSection title={t('trajectory.result')} section="result"
              key={`${node.turnId}:${node.id}:output:${query}`}>
              {tool?.toolResult?.error && <Alert tone="error" message={tool.toolResult.error} />}
              <ValueView value={output} />
            </DetailSection>
          </>}
      </Stack>
      </QueryContext.Provider>
    </ScrollArea>
  </div>;
}


export function TrajectoryRangeDetails({ sessionId, surfaceId, range, viewId }: {
  sessionId: string; surfaceId: string; range: TrajectoryRangeSummary; viewId: string;
}) {
  const { t, formatNumber } = useI18n('flow-chat');
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const duration = (value?: number) => value === undefined ? t('trajectory.notRecorded')
    : formatNumber(value / 1000, { style: 'unit', unit: 'second', maximumFractionDigits: 3 });
  const metrics = [[t('trajectory.user'), formatNumber(range.counts.user)], [t('trajectory.model'), formatNumber(range.counts.model)],
    [t('trajectory.tool'), formatNumber(range.counts.tool)], [t('trajectory.errors'), formatNumber(range.counts.errors)],
    [t('trajectory.modelTotal'), duration(range.modelMs)], [t('trajectory.toolTotal'), duration(range.toolMs)]];
  return <div className="trajectory-details" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="details">
    <div className="trajectory-details__header" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="header">
    <PageHeader level={2} size="sm" title={t('trajectory.rangeDetails')}
      description={t('trajectory.rangeTurns', { start: range.start.turnOrdinal + 1, end: range.end.turnOrdinal + 1 })} />
    <TimingSummary values={metrics.slice(4)} />
    </div>
    <ScrollArea className="trajectory-details__viewport" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="viewport">
      <Stack gap="4">
        <DetailSection title={t('trajectory.overview')}><DetailFields values={metrics.slice(0, 4)} /></DetailSection>
        <Alert tone="info" message={t('trajectory.parallelTime')} />
        <Stack direction="horizontal" gap="2" wrap>{[range.start, range.end].map((node, index) => <Button key={index}
          size="sm" variant="secondary" disabled={scope.surfaceId !== surfaceId}
          onClick={() => void globalEventBus.emit<TrajectoryPanelData>(TRAJECTORY_NAVIGATE_EVENT, { sessionId, surfaceId, viewId, node, query: '' })}>
          {index === 0 ? t('trajectory.locateStart') : t('trajectory.locateEnd')}</Button>)}</Stack>
      </Stack>
    </ScrollArea>
  </div>;
}
