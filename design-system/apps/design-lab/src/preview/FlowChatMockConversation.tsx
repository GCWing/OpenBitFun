import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Copy, Check, GitBranch, Square, Trash2 } from 'lucide-react';
import { Button, Icon, IconButton, MenuPopover, OverflowText, StatusPill } from '@openbitfun/ui';
import {
  AskUser, ChatComposer, ChatComposerActionButton, ChatComposerQueue,
  ChatComposerQueueHeader, ChatComposerQueueItem, ChatComposerQueueItemActions,
  ChatComposerQueueItemContent, ChatComposerQueueList, ChatComposerQueueTitle,
  ExploreGroup, FileOperationToolCard, FlowChatRuntimeStatus, GrepSearchToolCard,
  ReadFileToolCard, ThinkingBlock, TodoToolCard, type AskUserAnswers,
} from '@openbitfun/ui/flow-chat';
import { createScenarioClock, SCENARIO_EPOCH } from '@openbitfun/flow-chat-presentation/scenarios';
import { useThinkingDisclosure } from '@openbitfun/flow-chat-presentation/thinking';
import { buildExploreSummary } from '@openbitfun/flow-chat-presentation/explore';
import { useI18n } from '../i18n';
import { ScenarioCommand } from './FlowChatScenarios';
import { usePresentationFormatNumber, usePresentationTranslate } from './flowChatTranslation';
import type { FlowChatMockScenario } from './flowChatMockScenarios';

function MessageCopy({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return <>
    <IconButton className="flow-chat-mock__copy" size="sm" icon={<Icon glyph={copied ? Check : Copy} size="sm" />}
      aria-label={t(copied ? 'flowChat.scenario.copied' : 'flowChat.scenario.copy')}
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setCopied(true); setFailed(false); }
        catch { setFailed(true); }
      }} />
    {failed && <span role="status">{t('flowChat.scenario.copyFailed')}</span>}
  </>;
}

function UserTurn({ children, newTurn = false }: { children: string; newTurn?: boolean }) {
  const { t } = useI18n();
  return <article className="flow-chat-mock__user" data-new-turn={newTurn || undefined} aria-label={t('flowChat.mock.user')}>
    <div className="flow-chat-mock__user-bubble"><div className="flow-chat-mock__user-content">{children}</div></div>
    <div className="flow-chat-mock__message-meta"><MessageCopy text={children} /></div>
  </article>;
}

function AmbientItem({ children }: { children: ReactNode }) {
  return <div className="flowchat-flow-item"><div className="flow-tool-card-wrapper" data-openbitfun-attention="ambient">{children}</div></div>;
}

function MockThinking({ active = false, summary = false }: { active?: boolean; summary?: boolean }) {
  const { t } = useI18n();
  const disclosure = useThinkingDisclosure({ isActive: active, isLastItem: active, isSummary: summary });
  return <ThinkingBlock expanded={disclosure.expanded} onToggle={disclosure.toggle} streaming={active}
    reasoningKind={summary ? 'summary' : 'reasoning'}
    label={t(summary ? 'flowChat.mock.thinkingSummary' : 'flowChat.scenario.thinking')}>
    <p>{t(summary ? 'flowChat.mock.summaryDetail' : 'flowChat.mock.reasoning')}</p>
  </ThinkingBlock>;
}

function MockExploration({ active }: { active: boolean }) {
  const { t } = useI18n();
  const translate = usePresentationTranslate();
  const formatNumber = usePresentationFormatNumber();
  const [expanded, setExpanded] = useState(false);
  const [searchExpanded, setSearchExpanded] = useState(false);
  return <ExploreGroup expanded={expanded} onToggle={() => setExpanded((value) => !value)}
    streaming={active} kind="mixed" counts={{ read: 2, search: 1, command: 0 }}
    {...buildExploreSummary({ readCount: 2, searchCount: 1, commandCount: 0 }, 3, translate, formatNumber)}>
    <AmbientItem><GrepSearchToolCard status="completed" action={t('flowChat.mock.search')}
      summary="session.user · src/pages" isExpanded={searchExpanded}
      onToggle={() => setSearchExpanded((value) => !value)}
      results={[{ key: 'login', title: 'src/pages/LoginPage.tsx', meta: '42', description: 'const name = session.user.name;' }]} /></AmbientItem>
    {['src/pages/LoginPage.tsx', 'src/pages/LoginPage.test.tsx'].map((path) =>
      <AmbientItem key={path}><ReadFileToolCard action={t('flowChat.mock.read')} content={path} status="completed" /></AmbientItem>)}
  </ExploreGroup>;
}

function MockPlan({ completed, active, cancelled }: { completed: boolean; active: boolean; cancelled: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  return <TodoToolCard status="completed" title={t('flowChat.mock.plan')} totalCount={3}
    completedCount={completed ? 3 : 2} allCompleted={completed}
    summary={t(completed ? 'flowChat.mock.planDone' : 'flowChat.mock.planVerify')}
    isExpanded={expanded} onToggle={() => setExpanded((value) => !value)}
    items={[
      { key: 'diagnose', content: t('flowChat.mock.planDiagnose'), status: 'completed' },
      { key: 'fix', content: t('flowChat.mock.planFix'), status: 'completed' },
      { key: 'verify', content: t('flowChat.mock.planVerify'), status: completed ? 'completed' : cancelled ? 'cancelled' : active ? 'in_progress' : 'pending' },
    ]} />;
}

function MockFileChange({ test = false }: { test?: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const path = test ? 'src/pages/LoginPage.test.tsx' : 'src/pages/LoginPage.tsx';
  return <FileOperationToolCard operation="edit" status="completed" path={path} pathLabel={path}
    actionLabel={t('flowChat.mock.edit')} isExpanded={expanded} onToggle={() => setExpanded((value) => !value)}
    changeSummary={{ additions: test ? 8 : 2, deletions: test ? 0 : 1, label: t('flowChat.mock.changes') }}
    preview={<pre className="flow-chat-mock__diff"><code>{test
      ? "+ it('renders safely without a session', () => {\n+   render(<LoginPage session={null} />);\n+   expect(screen.getByRole('button')).toBeVisible();\n+ });"
      : '- const name = session.user.name;\n+ const name = session?.user?.name ?? "";\n+ if (!session) return <SignInForm />;'}</code></pre>} />;
}

interface LocalMessage { id: number; text: string }

/** Composes real public views; scenario playback and local inputs are Lab-owned. */
export function FlowChatMockConversation({ scenario, fromStart = false, toolGallery }: {
  scenario: FlowChatMockScenario; fromStart?: boolean; toolGallery?: ReactNode;
}) {
  const { t } = useI18n();
  const initialStep = fromStart ? 0 : scenario.initialStep;
  const [index, setIndex] = useState(initialStep);
  const [clock] = useState(() => createScenarioClock(SCENARIO_EPOCH + scenario.steps[initialStep]!.at));
  const [stopped, setStopped] = useState(false);
  const [analysisOnly, setAnalysisOnly] = useState(false);
  const [answers, setAnswers] = useState<AskUserAnswers>({});
  const [answered, setAnswered] = useState(false);
  const [draft, setDraft] = useState('');
  const [queued, setQueued] = useState<LocalMessage[]>([]);
  const [sent, setSent] = useState<LocalMessage[]>([]);
  const [model, setModel] = useState('deepseek-v4-pro');
  const [modelOpen, setModelOpen] = useState(false);
  const modelRef = useRef<HTMLButtonElement>(null);
  const nextMessageId = useRef(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const current = scenario.steps[index]!;
  const command = stopped && current.command && !['completed', 'error', 'cancelled', 'rejected'].includes(current.command.status)
    ? { ...current.command, status: 'cancelled' as const, isParamsStreaming: false }
    : current.command;
  const finished = stopped || analysisOnly || current.phase === 'result';
  const waiting = !finished && current.phase === 'question';
  const busy = !finished && !waiting;
  const success = finished && !stopped && !analysisOnly && command?.status === 'completed';
  const cancelled = stopped || command?.status === 'cancelled';
  const outcome = analysisOnly ? 'analysis' : cancelled ? 'cancelled' : command?.status === 'error' ? 'error' : 'completed';
  const status = waiting ? 'question' : !finished ? 'running' : cancelled ? 'cancelled' : command?.status === 'error' ? 'error' : 'completed';
  const questionIndex = scenario.steps.findIndex((step) => step.phase === 'question');
  const editIndex = scenario.steps.findIndex((step) => step.phase === 'editing');
  const showChanges = index >= editIndex && !analysisOnly;

  useEffect(() => {
    if (sent.length && transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [sent.length]);

  function next() {
    if (finished || waiting || index >= scenario.steps.length - 1) return;
    advance(index + 1);
  }
  function advance(nextIndex: number) {
    clock.advanceTo(SCENARIO_EPOCH + scenario.steps[nextIndex]!.at);
    setIndex(nextIndex);
  }
  function submitAnswer() {
    if (!answers.scope?.length || answered) return;
    setAnswered(true);
    if (answers.scope[0] === 'inspect') setAnalysisOnly(true);
    else advance(index + 1);
  }
  function submitMessage() {
    const text = draft.trim();
    if (!text) return;
    const message = { id: ++nextMessageId.current, text };
    if (!finished) setQueued((items) => [...items, message]);
    else setSent((items) => [...items, message]);
    setDraft('');
  }

  return <div className="flow-chat-mock-demo" data-mock-scenario={scenario.id} data-mock-phase={current.phase}>
    <div className="flow-chat-mock__toolbar">
      <div><strong>{t('flowChat.mock.sessionTitle')}</strong><span>/workspace/project</span></div>
      <StatusPill tone={status === 'error' ? 'danger' : status === 'question' ? 'warning' : 'neutral'}>
        {t(`flowChat.mock.variant.${status}`)}
      </StatusPill>
      <Button size="sm" variant="text" disabled={finished || waiting}
        onClick={next}>{t('flowChat.scenario.next')}</Button>
    </div>
    <div className="flow-chat-mock">
    <div className="flow-chat-mock__transcript" ref={transcriptRef} role="region"
      aria-label={t('flowChat.mock.transcript')} tabIndex={0}>
      <div className="flow-chat-mock__timeline">
        <UserTurn>{t('flowChat.mock.request')}</UserTurn>
        <article className="flow-chat-mock__assistant" aria-label="OpenBitFun">
          <p>{t('flowChat.mock.intro')}</p>
          <MockThinking active={!finished && current.phase === 'thinking'} />
        </article>
        {index >= 1 && <MockExploration active={!finished && current.phase === 'exploring'} />}
        <article className="flow-chat-mock__assistant" aria-label="OpenBitFun">
          {index >= 2 && <p>{t('flowChat.mock.finding')}</p>}
          {questionIndex >= 0 && index >= questionIndex && <AskUser
            answers={answers} onAnswersChange={(id, values) => setAnswers((previous) => ({ ...previous, [id]: values }))}
            onSubmit={submitAnswer} state={answered ? 'completed' : 'asking'}
            header={t('flowChat.mock.questionTitle')} statusLabel={answered ? undefined : t('flowChat.mock.variant.question')}
            submitLabel={answered ? undefined : t('flowChat.mock.confirm')} submitDisabled={!answers.scope?.length}
            summaryLabel={answered ? t('flowChat.mock.answerRecorded') : undefined}
            summaryDetail={answered ? t(analysisOnly ? 'flowChat.mock.inspect' : 'flowChat.mock.frontend') : undefined}
            questions={[{ id: 'scope', prompt: t('flowChat.mock.question'), selectionMode: 'single', options: [
              { value: 'frontend', label: t('flowChat.mock.frontend'), description: t('flowChat.mock.frontendDetail') },
              { value: 'inspect', label: t('flowChat.mock.inspect'), description: t('flowChat.mock.inspectDetail') },
            ] }]} />}
        </article>
        {showChanges && <>
          <UserTurn>{t('flowChat.mock.steering')}</UserTurn>
          <article className="flow-chat-mock__assistant" aria-label="OpenBitFun">
            <p>{t('flowChat.mock.applied')}</p>
            <MockThinking summary />
            <div className="flow-chat-mock__tool"><MockPlan completed={success} active={busy} cancelled={cancelled} /></div>
            <div className="flow-chat-mock__tool"><MockFileChange /></div>
            <div className="flow-chat-mock__tool"><MockFileChange test /></div>
            {command && <div className="flow-chat-mock__tool"><ScenarioCommand item={command} clock={clock} /></div>}
          </article>
        </>}
        {finished && <article className="flow-chat-mock__assistant flow-chat-mock__result" aria-label="OpenBitFun">
          <p><strong>{t(`flowChat.mock.result.${outcome}`)}</strong></p>
          <p>{t(stopped && !showChanges ? 'flowChat.mock.resultDetail.stoppedBeforeChanges' : `flowChat.mock.resultDetail.${outcome}`)}</p>
          {success && <ul><li><code>src/pages/LoginPage.tsx</code> — {t('flowChat.mock.fileResult')}</li>
            <li><code>src/pages/LoginPage.test.tsx</code> — {t('flowChat.mock.testResult')}</li></ul>}
          <div className="flow-chat-mock__result-meta"><MessageCopy text={`${t(`flowChat.mock.result.${outcome}`)}\n${t(`flowChat.mock.resultDetail.${outcome}`)}`} /></div>
        </article>}
        {success && toolGallery && <>
          <UserTurn newTurn>{t('flowChat.mock.toolsRequest')}</UserTurn>
          {toolGallery}
        </>}
        {sent.map((message) => <Fragment key={message.id}>
          <UserTurn newTurn>{message.text}</UserTurn>
          <article className="flow-chat-mock__assistant" aria-label="OpenBitFun"><p>{t('flowChat.mock.localReply')}</p></article>
        </Fragment>)}
        <div className="flow-chat-mock__runtime"><FlowChatRuntimeStatus visible={busy} label={t(`flowChat.mock.runtime.${current.phase}`)} /></div>
      </div>
    </div>
    <form className="flow-chat-mock__composer" onSubmit={(event) => { event.preventDefault(); submitMessage(); }}>
      <ChatComposer busy={busy} layout={draft.includes('\n') ? 'expanded' : 'compact'}
        contextBar={<div className="flow-chat-mock__context"><Icon glyph={GitBranch} size="xs" />main<span>project</span></div>}
        queue={queued.length > 0 ? <ChatComposerQueue aria-label={t('flowChat.mock.queued')}>
          <ChatComposerQueueHeader><ChatComposerQueueTitle count={queued.length}>{t('flowChat.mock.queued')}</ChatComposerQueueTitle></ChatComposerQueueHeader>
          <ChatComposerQueueList>{queued.map((message) => <ChatComposerQueueItem key={message.id}>
            <ChatComposerQueueItemContent>{message.text}</ChatComposerQueueItemContent>
            <ChatComposerQueueItemActions>
              <IconButton type="button" size="xs" icon={<Icon glyph={ArrowUp} />} aria-label={t('flowChat.mock.sendQueued')}
                disabled={!finished} onClick={() => { setSent((items) => [...items, message]); setQueued((items) => items.filter(({ id }) => id !== message.id)); }} />
              <IconButton type="button" size="xs" icon={<Icon glyph={Trash2} />} aria-label={t('flowChat.mock.deleteQueued')}
                onClick={() => setQueued((items) => items.filter(({ id }) => id !== message.id))} />
            </ChatComposerQueueItemActions>
          </ChatComposerQueueItem>)}</ChatComposerQueueList>
        </ChatComposerQueue> : undefined}
        endActions={<>
          <button type="button" ref={modelRef} className="flow-chat-mock__model" aria-haspopup="menu" aria-expanded={modelOpen}
            aria-label={t('flowChat.mock.model')} onClick={() => setModelOpen((value) => !value)}>
            <OverflowText>{model}</OverflowText><span>high</span>
          </button>
          <MenuPopover open={modelOpen} onClose={() => setModelOpen(false)} anchorRef={modelRef} placement="top"
            aria-label={t('flowChat.mock.model')} items={['deepseek-v4-pro', 'gpt-5.6'].map((name) => ({
              id: name, label: name, role: 'menuitemradio', checked: name === model, onSelect: () => setModel(name),
            }))} />
          {busy && <ChatComposerActionButton type="button" icon={<Icon glyph={Square} />} aria-label={t('flowChat.mock.stop')}
            onClick={() => setStopped(true)} />}
          <ChatComposerActionButton type="submit" variant="primary" icon={<Icon glyph={ArrowUp} />}
            aria-label={t(finished ? 'flowChat.mock.send' : 'flowChat.mock.enqueue')} disabled={!draft.trim()} />
        </>}>
        <textarea aria-label={t('flowChat.mock.message')} placeholder={t('flowChat.mock.placeholder')} rows={draft.includes('\n') ? 3 : 1}
          value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault(); submitMessage();
            }
          }} />
      </ChatComposer>
    </form>
    </div>
  </div>;
}
