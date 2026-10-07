import { useMemo, useRef, useState } from 'react';
import { Button, Select } from '@openbitfun/ui';
import {
  FlowGroup, FileOperationToolCard, ContextLoadGroup, ExploreGroup, FlowChatRuntimeStatus, GetToolSpecToolCard, ReadFileToolCard, SkillToolCard, ThinkingBlock, ToolDuration,
  ToolCardActions, ToolCardCopyButton,
} from '@openbitfun/ui/flow-chat';
import { themes, themeCssVariables, type ThemeTokenName } from '@openbitfun/theme-openbitfun';
import {
  buildExecCommandCardModel, buildExecControlCardModel, buildWriteStdinCardModel,
  ExecProcessPresentation, type ExecToolSnapshot, type PresentationClock,
} from '@openbitfun/flow-chat-presentation/exec';
import { LazyTerminalOutputRenderer, type TerminalOutputHost } from '@openbitfun/flow-chat-presentation/terminal';
import { createScenarioClock, execScenarios, SCENARIO_EPOCH, type ExecScenario } from '@openbitfun/flow-chat-presentation/scenarios';
import { useThinkingDisclosure } from '@openbitfun/flow-chat-presentation/thinking';
import { buildExploreSummary } from '@openbitfun/flow-chat-presentation/explore';
import { buildContextLoadSummary } from '@openbitfun/flow-chat-presentation/context-load';
import { useI18n } from '../i18n';
import { usePresentationFormatNumber, usePresentationTranslate } from './flowChatTranslation';

/** Only host capabilities differ: theme, clipboard and controlled scenario time. */
export function ScenarioCommand({ item, clock, initialExpanded, interactive = true, previewState }: {
  item: ExecToolSnapshot; clock: PresentationClock; initialExpanded?: boolean; interactive?: boolean; previewState?: 'hover';
}) {
  const t = usePresentationTranslate();
  const { t: lab } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<string>();
  const [copyFailed, setCopyFailed] = useState(false);
  const host = useMemo<TerminalOutputHost>(() => ({
    getColors() {
      const style = rootRef.current ? getComputedStyle(rootRef.current) : undefined;
      const color = (key: ThemeTokenName) => style?.getPropertyValue(themeCssVariables[key]).trim() || String(themes.light[key]);
      return {
        background: color('color.surface.scene'), foreground: color('color.content.primary'),
        cursor: 'transparent', cursorAccent: 'transparent',
        selectionBackground: color('color.accent.surface'),
      };
    },
    subscribe(listener) {
      const observer = new MutationObserver(listener);
      // Theme and authoring overrides can live on any enclosing ThemeRoot.
      let ancestor: HTMLElement | null = rootRef.current;
      while (ancestor) {
        observer.observe(ancestor, { attributes: true, attributeFilter: ['style', 'class', 'data-theme', 'data-color-scheme', 'data-contrast'] });
        ancestor = ancestor.parentElement;
      }
      return () => observer.disconnect();
    },
  }), []);
  const model = item.toolName === 'WriteStdin' ? buildWriteStdinCardModel(item, t)
    : item.toolName === 'ExecControl' ? buildExecControlCardModel(item, t) : buildExecCommandCardModel(item, t);
  async function copy(text: string) {
    if (!interactive) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text); setCopyFailed(false);
    } catch { setCopyFailed(true); }
  }
  return <>
    <ExecProcessPresentation toolItem={item} model={model} t={t} clock={clock} rootRef={rootRef}
      initialExpanded={initialExpanded} primaryCopied={copied === model.copyText} previewState={previewState}
      onCopyPrimary={() => { void copy(model.copyText); }}
      renderOutput={({ ref, ...props }) => <LazyTerminalOutputRenderer {...props} ref={ref} host={host} />}
      renderOutputAction={(getText) => <ToolCardActions><ToolCardCopyButton
        label={lab('flowChat.scenario.copy')} copiedLabel={lab('flowChat.scenario.copied')}
        copied={copied !== undefined && copied === getText()} onPress={() => { void copy(getText()); }}
      /></ToolCardActions>}
      renderStatus={(props) => {
        const elapsedMs = item.startTime ? Math.max(0, clock.now() - item.startTime) : 0;
        return <ToolDuration {...props} elapsedMs={elapsedMs}
          remainingMs={props.timeoutMs == null ? null : Math.max(0, props.timeoutMs - elapsedMs)} />;
      }} />
    {copyFailed && <span role="status">{lab('flowChat.scenario.copyFailed')}</span>}
  </>;
}

export function ThinkingPreview({ state, interactive = true }: { state: string; interactive?: boolean }) {
  const { t } = useI18n();
  const disclosure = useThinkingDisclosure({
    isSummary: state === 'summary', isActive: state === 'streaming',
    isLastItem: state === 'expanded' || state === 'streaming',
  });
  return <ThinkingBlock expanded={disclosure.expanded} onToggle={interactive ? disclosure.toggle : undefined}
    streaming={state === 'streaming'} reasoningKind={state === 'summary' ? 'summary' : 'reasoning'}
    label={t(state === 'summary' ? 'flowChat.scenario.summary' : 'flowChat.scenario.thinking')}>
    <p>{t('flowChat.scenario.reasoning')}</p>
  </ThinkingBlock>;
}

export function ExplorePreview({ state, interactive = true }: { state: string; interactive?: boolean }) {
  const [expanded, setExpanded] = useState(state === 'expanded');
  const t = usePresentationTranslate();
  const formatNumber = usePresentationFormatNumber();
  return <ExploreGroup expanded={expanded} onToggle={interactive ? () => setExpanded(!expanded) : undefined}
    streaming={state === 'streaming'} kind="read" counts={{ read: 2, search: 0, command: 0 }}
    {...buildExploreSummary({ readCount: 2, searchCount: 0, commandCount: 0 }, 2, t, formatNumber)}>
    {['src/flow_chat/tool-cards/index.ts', 'packages/flow-chat-presentation/src/registry.ts'].map((path) => (
      <ReadFileToolCard key={path} action="Read" content={path} status="completed" />
    ))}
  </ExploreGroup>;
}

export function RuntimeStatusPreview({ state }: { state: string }) {
  const { t } = useI18n();
  return <FlowChatRuntimeStatus label={t('flowChat.scenario.runtime')} visible={state !== 'hidden'} />;
}

export function ContextLoadPreview({ state, interactive = true }: { state: string; interactive?: boolean }) {
  const [expanded, setExpanded] = useState(state === 'expanded');
  const t = usePresentationTranslate();
  const formatNumber = usePresentationFormatNumber();
  return <ContextLoadGroup expanded={expanded} itemCount={2} streaming={state === 'streaming'}
    onToggle={interactive ? () => setExpanded(!expanded) : undefined}
    {...buildContextLoadSummary(2, t, formatNumber)}>
    <SkillToolCard status="completed" summary="frontend-design" />
    <GetToolSpecToolCard status="completed" summary="WebSearch" />
  </ContextLoadGroup>;
}

function ScenarioReplay({ scenario }: { scenario: ExecScenario }) {
  const { t } = useI18n();
  const [clock] = useState(createScenarioClock);
  const [index, setIndex] = useState(-2);
  const current = scenario.steps[Math.max(0, index)]!;
  const thinking = useThinkingDisclosure({ isSummary: false, isActive: index === -2, isLastItem: index === -2 });
  const finished = index >= 0 && ['completed', 'cancelled', 'error', 'rejected'].includes(current.item.status);
  function next() {
    const nextIndex = index + 1;
    if (nextIndex >= scenario.steps.length) return;
    clock.advanceTo(SCENARIO_EPOCH + (nextIndex < 0 ? 0 : scenario.steps[nextIndex]!.at));
    setIndex(nextIndex);
  }
  return <>
    <div className="flow-chat-scenario__controls">
      <Button size="sm" onClick={next} disabled={index === scenario.steps.length - 1}>{t('flowChat.scenario.next')}</Button>
      <span role="status">{index + 3}/{scenario.steps.length + 2} · {current.at}ms · {index === -2
        ? t('flowChat.scenario.thinking') : index === -1 ? t('flowChat.scenario.exploring') : t(`flowChat.scenario.phase.${current.phase}`)}</span>
    </div>
    <div className="flow-chat-tool-sequence__rows" data-scenario={scenario.id} data-scenario-step={index}>
      <ThinkingBlock expanded={thinking.expanded} onToggle={thinking.toggle} streaming={index === -2}
        label={t('flowChat.scenario.thinking')}><p>{t('flowChat.scenario.reasoning')}</p></ThinkingBlock>
      {index >= -1 && <ExplorePreview state={index === -1 ? 'streaming' : 'collapsed'} />}
      {index >= 0 && <ScenarioCommand item={current.item} clock={clock} />}
      {finished && <p>{t('flowChat.scenario.result')}</p>}
      <FlowChatRuntimeStatus visible={!finished} label={t('flowChat.scenario.runtime')} />
    </div>
  </>;
}

export function FlowChatScenarios() {
  const { t } = useI18n();
  const [selected, setSelected] = useState(execScenarios[0]!.id);
  const [replay, setReplay] = useState(0);
  const scenario = execScenarios.find(({ id }) => id === selected)!;
  return <section className="flow-chat-tool-sequence">
    <header><h3>{t('flowChat.scenario.title')}</h3><p>{t('flowChat.scenario.description')}</p></header>
    <div className="flow-chat-scenario__controls">
      <Select size="sm" aria-label={t('flowChat.scenario.select')} value={selected}
        onValueChange={(value) => setSelected(String(value))}
        options={execScenarios.map(({ id }) => ({ value: id, label: id }))} />
      <Button size="sm" onClick={() => setReplay(replay + 1)}>{t('flowChat.scenario.reset')}</Button>
    </div>
    <ScenarioReplay key={`${selected}-${replay}`} scenario={scenario} />
  </section>;
}

/** Public collection anatomy using the same localized presenter and native cards. */
export function FlowGroupPreview({ state, interactive = true }: { state: string; interactive?: boolean }) {
  const [expanded, setExpanded] = useState(state === 'expanded' || state === 'file-expanded' || state === 'file-error');
  const t = usePresentationTranslate();
  const formatNumber = usePresentationFormatNumber();
  if (state.startsWith('file-')) {
    const path = 'src/components/Editor.tsx';
    const summary = t('fileEditGroup.summary', { count: formatNumber(3) });
    const changes = (add: number, remove: number) => {
      const additions = formatNumber(add);
      const deletions = formatNumber(remove);
      return { additions, deletions, label: t('fileEditGroup.changes', { additions, deletions }) };
    };
    return <FlowGroup expanded={expanded} onExpandedChange={interactive ? setExpanded : undefined}
      summary={summary} summaryDescription={t('fileEditGroup.description', { path, count: formatNumber(3) })}
      itemCount={3} fileRevision={{ path, label: 'Editor.tsx', countLabel: t('fileEditGroup.label', { count: formatNumber(3) }),
        expandedLabel: t('fileEditGroup.expanded'),
        changeSummary: state === 'file-error' ? changes(9, 3) : changes(18, 6),
        status: state === 'file-error' ? 'error' : undefined,
        statusLabel: state === 'file-error' ? t('fileEditGroup.failed', { count: formatNumber(1) }) : undefined }}>
      {[1, 2, 3].map(revision => <FileOperationToolCard key={revision} operation="edit" path={path} pathLabel={null}
        actionLabel={t('fileEditGroup.revision', { count: formatNumber(revision) })}
        changeSummary={state === 'file-error' && revision === 3 ? undefined : changes(revision * 3, revision)}
        status={state === 'file-error' && revision === 3 ? 'error' : 'completed'} />)}
    </FlowGroup>;
  }
  return <FlowGroup expanded={expanded} onExpandedChange={interactive ? setExpanded : undefined}
    itemCount={2} streaming={state === 'streaming'} {...buildContextLoadSummary(2, t, formatNumber)}>
    <SkillToolCard status="completed" summary="frontend-design" />
    <GetToolSpecToolCard status="completed" summary="WebSearch" />
  </FlowGroup>;
}
