import {
  Brain as LucideBrain,
  Check as LucideCheck,
  ChevronDown as LucideChevronDown,
  ChevronRight as LucideChevronRight,
  Circle as LucideCircle,
  CircleCheck as LucideCircleCheck,
  CirclePlay as LucideCirclePlay,
  CircleX as LucideCircleX,
  ListTodo as LucideListTodo,
  LoaderCircle as LucideLoaderCircle,
  Square as LucideSquare,
  X as LucideX,
} from 'lucide-react';
import ChatToolDetails from './ChatToolDetails';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { MobileButton, MobileCard, MobileDisclosure, MobileMessage } from '@openbitfun/ui/mobile';
import { useI18n } from '../i18n';
import type { ActiveTurnSnapshot, ChatMessage, ChatMessageItem, RemoteToolStatus } from '../services/RemoteSessionManager';
import ChatAskQuestionCard from './ChatAskQuestionCard';
import { MarkdownContent } from './ChatMarkdown';
import ChatToolApprovalActions, { isToolAwaitingApproval } from './ChatToolApprovalActions';

type ToolApprovalHandler = (toolId: string, updatedInput?: Record<string, unknown>) => Promise<void>;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function getEnglishPluralSuffix(language: string, count: number): string {
  return language === 'en-US' && count !== 1 ? 's' : '';
}

function sanitizeMessageText(content: string): string {
  return content
    .replace(/#img:\S+\s*/g, '')
    .replace(/\[Image:.*?\]\n(?:Path:.*?\n|Image ID:.*?\n)?/g, '')
    .trim();
}

export const ThinkingBlock: React.FC<{
  thinking: string;
  streaming?: boolean;
  isLastItem?: boolean;
}> = ({ thinking, streaming, isLastItem = false }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(!!streaming);
  const userToggledRef = useRef(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState({ atTop: true, atBottom: true });
  const displayedThinking = useTypewriter(thinking, !!streaming);

  useEffect(() => {
    if (userToggledRef.current) return;
    if (streaming) {
      setOpen(true);
    } else if (!isLastItem) {
      setOpen(false);
    }
  }, [streaming, isLastItem]);

  useEffect(() => {
    if (!streaming || !open) return;
    const el = wrapperRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (gap < 80) {
      el.scrollTop = el.scrollHeight;
    }
  }, [displayedThinking, streaming, open]);

  const handleScroll = useCallback(() => {
    const el = wrapperRef.current;
    if (!el) return;
    setScrollState({
      atTop: el.scrollTop < 4,
      atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 4,
    });
  }, []);

  const handleToggle = useCallback(() => {
    userToggledRef.current = true;
    setOpen(o => !o);
  }, []);

  if (!thinking && !streaming) return null;

  const charCount = thinking.length;
  const label = streaming && charCount === 0
    ? t('chat.thinking')
    : t('chat.thoughtCharacters', { count: charCount });

  return (
    <MobileDisclosure className={`chat-thinking ${streaming ? 'chat-thinking--streaming' : ''}`} onToggle={handleToggle} open={open} title={label} leading={<LucideBrain size={16} aria-hidden="true" />}>
      <div className={`chat-thinking__expand-container ${open ? 'is-expanded' : ''}`}>
        <div className="chat-thinking__expand-inner">
          {thinking && (
            <div
              className={`chat-thinking__content-wrapper ${scrollState.atTop ? 'at-top' : ''} ${scrollState.atBottom ? 'at-bottom' : ''}`}
              ref={wrapperRef}
              onScroll={handleScroll}
            >
              <div className="chat-thinking__content">
                <MarkdownContent content={streaming ? displayedThinking : thinking} />
              </div>
            </div>
          )}
        </div>
      </div>
    </MobileDisclosure>
  );
};

// ─── Tool Card ──────────────────────────────────────────────────────────────

const TOOL_TYPE_MAP: Record<string, string> = {
  explore: 'shared.tools.explore',
  read_file: 'shared.tools.read',
  write_file: 'shared.tools.write',
  list_directory: 'tools.ls',
  bash: 'shared.tools.shell',
  glob: 'tools.glob',
  grep: 'tools.grep',
  create_file: 'shared.tools.write',
  delete_file: 'tools.delete',
  Task: 'tools.task',
  search: 'shared.tools.search',
  edit_file: 'shared.tools.edit',
  web_search: 'tools.web',
  TodoWrite: 'shared.tools.todo',
};

// ─── TodoWrite card ─────────────────────────────────────────────────────────

const TodoCard: React.FC<{ tool: RemoteToolStatus }> = ({ tool }) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  const todos: { id?: string; content: string; status: string }[] = useMemo(() => {
    const src = tool.tool_input;
    if (!src) return [];
    const arr = src.todos || src.result?.todos;
    return Array.isArray(arr) ? arr : [];
  }, [tool.tool_input]);

  if (todos.length === 0) return null;

  const completed = todos.filter(t => t.status === 'completed').length;
  const allDone = completed === todos.length;
  const inProgress = todos.find(t => t.status === 'in_progress');

  const statusIcon = (s: string) => {
    switch (s) {
      case 'completed':
        return <LucideCircleCheck width="12" height="12" stroke="var(--openbitfun-color-status-success-content)" aria-hidden="true" />;
      case 'in_progress':
        return <LucideCirclePlay width="12" height="12" stroke="var(--openbitfun-color-accent-default)" aria-hidden="true" />;
      case 'cancelled':
        return <LucideCircleX width="12" height="12" stroke="var(--openbitfun-color-status-danger-content)" aria-hidden="true" />;
      default:
        return <LucideCircle width="12" height="12" stroke="var(--openbitfun-color-content-muted)" aria-hidden="true" />;
    }
  };

  return (
    <MobileCard padding="none" className="chat-todo-card">
      <MobileButton appearance="plain" block className="chat-todo-card__header" aria-expanded={expanded} aria-controls={expanded ? listId : undefined} onClick={() => setExpanded(!expanded)}>
        <span className="chat-todo-card__icon">
          <LucideListTodo width="14" height="14" stroke="currentColor" aria-hidden="true" />
        </span>
        {allDone && !expanded ? (
          <span className="chat-todo-card__current chat-todo-card__current--done">{t('chat.allTasksCompleted')}</span>
        ) : inProgress && !expanded ? (
          <span className="chat-todo-card__current">{inProgress.content}</span>
        ) : (
          <span className="chat-todo-card__current">{t('shared.tools.todo')}</span>
        )}
        <span className="chat-todo-card__right">
          <span className="chat-todo-card__dots" aria-hidden="true">
            {todos.map((t, i) => (
              <span key={t.id || i} className={`chat-todo-card__dot chat-todo-card__dot--${t.status}`} />
            ))}
          </span>
          <span className="chat-todo-card__stats">{completed}/{todos.length}</span>
        </span>
        <span className={`chat-todo-card__chevron ${expanded ? 'is-expanded' : ''}`}>
          <LucideChevronDown width="12" height="12" stroke="currentColor" aria-hidden="true" />
        </span>
      </MobileButton>
      {expanded && (
        <div id={listId} className="chat-todo-card__list">
          {todos.map((t, i) => (
            <div key={t.id || i} className={`chat-todo-card__item chat-todo-card__item--${t.status}`}>
              {statusIcon(t.status)}
              <span className="chat-todo-card__item-text">{t.content}</span>
            </div>
          ))}
        </div>
      )}
    </MobileCard>
  );
};

/**
 * Extract agent prompt and type from an agent launch tool.
 * Prefers tool_input (full JSON from backend), falls back to input_preview (truncated).
 */
function parseTaskInfo(tool: RemoteToolStatus): { description?: string; agentType?: string } | null {
  const source = tool.tool_input ?? (() => {
    try { return JSON.parse(tool.input_preview || ''); } catch { return null; }
  })();
  if (!source) return null;
  return {
    description: source.description || source.prompt,
    agentType: source.subagent_type || source.agent_type,
  };
}

/**
 * Summarize a subItem for display inside a Task card.
 */
function subItemLabel(
  item: ChatMessageItem,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (item.type === 'thinking') {
    const len = (item.content || '').length;
    return t('chat.thoughtCharacters', { count: len });
  }
  if (item.type === 'tool' && item.tool) {
    const t = item.tool;
    const preview = t.input_preview ? `: ${t.input_preview}` : '';
    return `${t.name}${preview}`;
  }
  if (item.type === 'text') {
    const len = (item.content || '').length;
    return t('chat.textCharacters', { count: len });
  }
  return '';
}

export const TaskToolCard: React.FC<{
  tool: RemoteToolStatus;
  now: number;
  subItems?: ChatMessageItem[];
  onCancelTool?: (toolId: string) => void;
  onApproveTool?: ToolApprovalHandler;
  onRejectTool?: ToolApprovalHandler;
}> = ({ tool, now, subItems = [], onCancelTool, onApproveTool, onRejectTool }) => {
  const { t, language } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stepsExpanded, setStepsExpanded] = useState(false);
  const isRunning = tool.status === 'running';
  const isCompleted = tool.status === 'completed';
  const isError = tool.status === 'failed' || tool.status === 'error';
  const showCancel = isRunning && !!onCancelTool;
  const taskInfo = parseTaskInfo(tool);

  const durationLabel = isCompleted && tool.duration_ms != null
    ? formatDuration(tool.duration_ms)
    : isRunning && tool.start_ms
    ? formatDuration(now - tool.start_ms)
    : '';

  const statusClass = isRunning ? 'running' : isCompleted ? 'done' : isError ? 'error' : 'pending';

  const subTools = subItems.filter(i => i.type === 'tool' && i.tool);
  const subToolsDone = subTools.filter(i => i.tool!.status === 'completed').length;
  const subToolsRunning = subTools.filter(i => i.tool!.status === 'running').length;
  const hasPendingSubtoolApproval = subTools.some(i => isToolAwaitingApproval(i.tool!));

  useEffect(() => {
    if (hasPendingSubtoolApproval) setStepsExpanded(true);
  }, [hasPendingSubtoolApproval]);


  return (
    <MobileCard padding="none" className={`chat-task-card chat-task-card--${statusClass}`} data-prominent={isError || isToolAwaitingApproval(tool) || hasPendingSubtoolApproval}>
      <div className="chat-task-card__header">
        <span className="chat-tool-card__icon">
          {isRunning ? (
            <span className="chat-tool-card__spinner" />
          ) : isCompleted ? (
            <span className="chat-tool-card__check">
              <LucideCheck width="12" height="12" aria-hidden="true" />
            </span>
          ) : isError ? (
            <span className="chat-tool-card__error-icon">
              <LucideX width="12" height="12" aria-hidden="true" />
            </span>
          ) : (
            <span className="chat-tool-card__spinner" />
          )}
        </span>
        <ChatToolDetails tool={tool} label={<span className="chat-tool-card__name">
          {taskInfo?.description || t('chat.task')}
        </span>} />
        {taskInfo?.agentType && (
          <span className="chat-tool-card__type">{taskInfo.agentType}</span>
        )}
        {durationLabel && (
          <span className="chat-tool-card__duration">{durationLabel}</span>
        )}
        {showCancel && (
          <MobileButton
            appearance="plain"
            className="chat-tool-card__cancel"
            onClick={(e) => { e.stopPropagation(); onCancelTool?.(tool.id); }}
            aria-label={t('common.cancel')}
          >
            <LucideSquare width="10" height="10" aria-hidden="true" />
          </MobileButton>
        )}
      </div>

      <ChatToolApprovalActions tool={tool} onApprove={onApproveTool} onReject={onRejectTool} />

      {subItems.length > 0 && (
        <>
          <MobileButton appearance="plain" block className="chat-task-card__summary" aria-expanded={stepsExpanded} onClick={() => setStepsExpanded(e => !e)}>
            <span className="chat-task-card__stat">
              {t('chat.toolCalls', { count: subTools.length, suffix: getEnglishPluralSuffix(language, subTools.length) })}
            </span>
            <span className="chat-task-card__stat-right">
              <span className="chat-task-card__stat--done">{t('chat.done', { count: subToolsDone })}</span>
              {subToolsRunning > 0 && <span className="chat-task-card__stat--running">{t('chat.running', { count: subToolsRunning })}</span>}
            </span>
            <span className={`chat-task-card__chevron ${stepsExpanded ? 'is-expanded' : ''}`}>
              <LucideChevronDown width="10" height="10" stroke="currentColor" aria-hidden="true" />
            </span>
          </MobileButton>
          {stepsExpanded && (
            <div className="chat-task-card__steps" ref={scrollRef}>
              {subItems.map((item, idx) => {
                if (item.type === 'thinking') {
                  return (
                    <div key={`sub-think-${idx}`} className="chat-task-card__step chat-task-card__step--thinking">
                      <LucideChevronDown width="10" height="10" stroke="currentColor" aria-hidden="true" />
                      <span>{subItemLabel(item, t)}</span>
                    </div>
                  );
                }
                if (item.type === 'tool' && item.tool) {
                  const t = item.tool;
                  const isDone = t.status === 'completed';
                  const isErr = t.status === 'failed' || t.status === 'error';
                  return (
                    <div key={`sub-tool-${t.id}-${idx}`} className="chat-task-card__step-wrap">
                      <div className={`chat-task-card__step chat-task-card__step--tool ${isDone ? 'is-done' : isErr ? 'is-error' : 'is-running'}`}>
                      {isDone ? (
                        <LucideCheck width="10" height="10" color="var(--openbitfun-color-status-success-content)" aria-hidden="true" />
                      ) : isErr ? (
                        <LucideX width="10" height="10" color="var(--openbitfun-color-status-danger-content)" aria-hidden="true" />
                      ) : (
                        <span className="chat-task-card__step-spinner" />
                      )}
                      <span className="chat-task-card__step-name">{t.name}</span>
                    {(() => {
                      const p = getToolPreview(t);
                      return p ? <span className="chat-task-card__step-preview">{p}</span> : null;
                    })()}
                      {isDone && t.duration_ms != null && (
                        <span className="chat-task-card__step-duration">{formatDuration(t.duration_ms)}</span>
                      )}
                      </div>
                      <ChatToolDetails tool={t} />
                      <ChatToolApprovalActions tool={t} onApprove={onApproveTool} onReject={onRejectTool} />
                    </div>
                  );
                }
                return null;
              })}
            </div>
          )}
        </>
      )}
    </MobileCard>
  );
};

/**
 * Parse tool input_preview (slim JSON from backend) and extract a concise display text.
 * Backend sends valid JSON with large fields stripped; frontend extracts the key field
 * and truncates the resulting plain text.
 */
function getToolPreview(tool: RemoteToolStatus): string | null {
  if (!tool.input_preview) return null;
  try {
    const params = JSON.parse(tool.input_preview);
    if (!params || typeof params !== 'object') return null;

    const lastSegment = (p: string) => {
      const parts = p.replace(/\\/g, '/').split('/');
      return parts[parts.length - 1] || p;
    };

    let result: string | null = null;

    const pathVal = params.file_path || params.path;
    switch (tool.name) {
      case 'Read':
      case 'Write':
      case 'Edit':
      case 'LS':
      case 'StrReplace':
      case 'delete_file':
        result = pathVal ? lastSegment(pathVal) : null;
        break;
      case 'Glob':
      case 'Grep':
        result = params.pattern || null;
        break;
      case 'Bash':
      case 'Shell':
        result = params.description || params.command || null;
        break;
      case 'web_search':
      case 'WebSearch':
        result = params.search_term || params.query || null;
        break;
      case 'WebFetch':
        result = params.url || null;
        break;
      case 'SemanticSearch':
        result = params.query || null;
        break;
      default: {
        const first = Object.values(params).find(
          (v): v is string => typeof v === 'string' && v.length > 0 && v.length < 80,
        );
        result = first || null;
      }
    }

    if (!result) return null;
    return result.length > 60 ? result.slice(0, 60) + '…' : result;
  } catch {
    return null;
  }
}

const ToolCard: React.FC<{
  tool: RemoteToolStatus;
  now: number;
  onCancelTool?: (toolId: string) => void;
  onApproveTool?: ToolApprovalHandler;
  onRejectTool?: ToolApprovalHandler;
}> = ({ tool, now, onCancelTool, onApproveTool, onRejectTool }) => {
  const { t } = useI18n();
  const toolKey = tool.name.toLowerCase().replace(/[\s-]/g, '_');
  const typeLabelKey = TOOL_TYPE_MAP[toolKey] || TOOL_TYPE_MAP[tool.name];
  const typeLabel = typeLabelKey ? t(typeLabelKey) : '';
  const isRunning = tool.status === 'running';
  const isCompleted = tool.status === 'completed';
  const isError = tool.status === 'failed' || tool.status === 'error';
  const showCancel = isRunning && !!onCancelTool;
  const preview = getToolPreview(tool);

  const durationLabel = isCompleted && tool.duration_ms != null
    ? formatDuration(tool.duration_ms)
    : isRunning && tool.start_ms
    ? formatDuration(now - tool.start_ms)
    : '';

  const statusClass = isRunning ? 'running' : isCompleted ? 'done' : isError ? 'error' : 'pending';

  return (
    <MobileCard padding="none" className={`chat-tool-card chat-tool-card--${statusClass}`} data-prominent={isError || isToolAwaitingApproval(tool)}>
      <div className="chat-tool-card__row">
        <span className="chat-tool-card__icon">
          {isRunning ? (
            <span className="chat-tool-card__spinner" />
          ) : isCompleted ? (
            <span className="chat-tool-card__check">
              <LucideCheck width="12" height="12" aria-hidden="true" />
            </span>
          ) : isError ? (
            <span className="chat-tool-card__error-icon">
              <LucideX width="12" height="12" aria-hidden="true" />
            </span>
          ) : (
            <span className="chat-tool-card__spinner" />
          )}
        </span>
        <ChatToolDetails tool={tool} label={<span className="chat-tool-card__name">
          {tool.name}
          {preview && <span className="chat-tool-card__preview"> {preview}</span>}
        </span>} />
        {typeLabel && <span className="chat-tool-card__type">{typeLabel}</span>}
        {durationLabel && (
          <span className="chat-tool-card__duration">{durationLabel}</span>
        )}
        {showCancel && (
          <MobileButton
            appearance="plain"
            className="chat-tool-card__cancel"
            onClick={(e) => { e.stopPropagation(); onCancelTool?.(tool.id); }}
            aria-label={t('common.cancel')}
          >
            <LucideSquare width="10" height="10" aria-hidden="true" />
          </MobileButton>
        )}
      </div>
      <ChatToolApprovalActions tool={tool} onApprove={onApproveTool} onReject={onRejectTool} />
    </MobileCard>
  );
};

const READ_LIKE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'SemanticSearch']);

function getToolSummaryLabel(toolName: string): string {
  return toolName;
}

function buildGroupedToolSummary(
  tools: RemoteToolStatus[],
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const counts = new Map<string, { label: string; count: number }>();
  const order: string[] = [];

  for (const tool of tools) {
    const toolKey = tool.name.toLowerCase().replace(/[\s-]/g, '_');
    const typeLabelKey = TOOL_TYPE_MAP[toolKey] || TOOL_TYPE_MAP[tool.name];
    const label = typeLabelKey ? t(typeLabelKey) : getToolSummaryLabel(tool.name);
    const key = label.toLowerCase();
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    counts.set(key, { label, count: 1 });
    order.push(key);
  }

  return order
    .map((key) => {
      const entry = counts.get(key)!;
      return `${entry.label} ${entry.count}`;
    })
    .join(', ');
}

const ReadFilesToggle: React.FC<{ tools: RemoteToolStatus[] }> = ({ tools }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (tools.length === 0) return null;

  const doneCount = tools.filter(t => t.status === 'completed').length;
  const allDone = doneCount === tools.length;
  const summary = buildGroupedToolSummary(tools, t);
  const label = allDone
    ? t('chat.readToolsDone', { summary })
    : t('chat.readToolsRunning', { summary, doneCount });

  return (
    <MobileDisclosure className={`chat-thinking ${allDone ? '' : 'chat-thinking--streaming'}`} onToggle={() => setOpen(o => !o)} open={open} title={label}>
        <div className="chat-read-tools">
          {tools.map(tool => (
            <ChatToolDetails key={tool.id} tool={tool} label={
              <span className="chat-tool-card__name">
                {tool.status === 'completed' ? '✓' : '⋯'} {tool.name}
                <span className="chat-tool-card__preview"> {getToolPreview(tool)}</span>
              </span>
            } />
          ))}
        </div>
    </MobileDisclosure>
  );
};

const TOOL_LIST_COLLAPSE_THRESHOLD = 2;

export const ToolList: React.FC<{
  tools: RemoteToolStatus[];
  now: number;
  onCancelTool?: (toolId: string) => void;
  onApproveTool?: ToolApprovalHandler;
  onRejectTool?: ToolApprovalHandler;
}> = ({ tools, now, onCancelTool, onApproveTool, onRejectTool }) => {
  const { t, language } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);


  if (!tools || tools.length === 0) return null;

  // Decisions and failures must remain visible outside collapsed process groups.
  if (tools.length <= TOOL_LIST_COLLAPSE_THRESHOLD || tools.some(tool => isToolAwaitingApproval(tool) || ['failed', 'error'].includes(tool.status))) {
    return (
      <div className="chat-tool-list">
        {tools.map((tc) => (
          <ToolCard key={tc.id} tool={tc} now={now} onCancelTool={onCancelTool} onApproveTool={onApproveTool} onRejectTool={onRejectTool} />
        ))}
      </div>
    );
  }

  const runningCount = tools.filter(t => t.status === 'running').length;
  const doneCount = tools.filter(t => t.status === 'completed').length;

  return (
    <MobileCard padding="none" className="chat-tool-list chat-tool-list--collapsed">
      <MobileButton appearance="plain" block className="chat-tool-list__header" aria-expanded={expanded} onClick={() => setExpanded(e => !e)}>
        <span className="chat-tool-list__count">{t('chat.toolCalls', { count: tools.length, suffix: getEnglishPluralSuffix(language, tools.length) })}</span>
        <span className="chat-tool-list__stats">
          {doneCount > 0 && <span className="chat-tool-list__stat chat-tool-list__stat--done">{t('chat.done', { count: doneCount })}</span>}
          {runningCount > 0 && <span className="chat-tool-list__stat chat-tool-list__stat--running">{t('chat.running', { count: runningCount })}</span>}
        </span>
        <span className={`chat-tool-list__chevron ${expanded ? 'is-expanded' : ''}`}>
          <LucideChevronDown width="10" height="10" stroke="currentColor" aria-hidden="true" />
        </span>
      </MobileButton>
      {expanded && (
        <div className="chat-tool-list__scroll" ref={scrollRef}>
          {tools.map((tc) => (
            <ToolCard key={tc.id} tool={tc} now={now} onCancelTool={onCancelTool} onApproveTool={onApproveTool} onRejectTool={onRejectTool} />
          ))}
        </div>
      )}
    </MobileCard>
  );
};

// ─── Typing indicator ───────────────────────────────────────────────────────

export const TypingDots: React.FC = () => (
  <span className="chat-msg__typing">
    <span /><span /><span />
  </span>
);

// ─── Typewriter effect (pseudo-streaming) ──────────────────────────────────

function useTypewriter(targetText: string, animate: boolean): string {
  const [displayText, setDisplayText] = useState(animate ? '' : targetText);
  const revealedRef = useRef(animate ? 0 : targetText.length);
  const targetRef = useRef(targetText);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const speedRef = useRef(3);

  useEffect(() => {
    if (!animate) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      revealedRef.current = targetText.length;
      targetRef.current = targetText;
      setDisplayText(targetText);
      return;
    }

    targetRef.current = targetText;

    if (targetText.length < revealedRef.current) {
      revealedRef.current = 0;
    }

    const delta = targetText.length - revealedRef.current;
    if (delta > 0) {
      const FRAME_INTERVAL = 30;
      const REVEAL_DURATION = 800;
      const totalFrames = REVEAL_DURATION / FRAME_INTERVAL;
      speedRef.current = Math.max(Math.ceil(delta / totalFrames), 2);

      if (!timerRef.current) {
        timerRef.current = setInterval(() => {
          const target = targetRef.current;
          const cur = revealedRef.current;
          if (cur >= target.length) {
            if (timerRef.current) {
              clearInterval(timerRef.current);
              timerRef.current = null;
            }
            return;
          }
          const next = Math.min(cur + speedRef.current, target.length);
          revealedRef.current = next;
          setDisplayText(target.slice(0, next));
        }, FRAME_INTERVAL);
      }
    }
  }, [targetText, animate]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, []);

  return displayText;
}

export const TypewriterText: React.FC<{
  content: string;
  onFileDownload?: (path: string, onProgress?: (downloaded: number, total: number) => void) => Promise<void>;
  onGetFileInfo?: (path: string) => Promise<{ name: string; size: number; mimeType: string }>;
}> = ({ content, onFileDownload, onGetFileInfo }) => {
  const displayText = useTypewriter(content, true);
  return <MarkdownContent content={displayText} onFileDownload={onFileDownload} onGetFileInfo={onGetFileInfo} />;
};

// ─── AskUserQuestion Card ─────────────────────────────────────────────────

export const isPendingAskUserQuestion = (tool?: RemoteToolStatus | null) => {
  if (!tool || tool.name !== 'AskUserQuestion' || !tool.tool_input) return false;
  return !['completed', 'failed', 'cancelled', 'rejected'].includes(tool.status);
};

/**
 * Collect subagent internal items into the agent launch item's subItems field.
 * When an AgentSpawn (or legacy Task) tool appears, subsequent subagent items
 * are attached for nested rendering.
 */
function filterSubagentItems(items: ChatMessageItem[]): ChatMessageItem[] {
  const result: ChatMessageItem[] = [];
  let currentTaskItem: ChatMessageItem | null = null;

  for (const item of items) {
    if (item.type === 'tool' && ['Task', 'AgentSpawn'].includes(item.tool?.name ?? '')) {
      const taskCopy: ChatMessageItem = { ...item, subItems: [] };
      result.push(taskCopy);
      currentTaskItem = taskCopy;
      continue;
    }

    if (item.is_subagent && currentTaskItem) {
      currentTaskItem.subItems!.push(item);
      continue;
    }

    if (item.is_subagent) {
      continue;
    }

    // Don't reset currentTaskItem — when the agent calls tools in
    // parallel (e.g. Explore + 3 Reads), direct tools interleave with
    // the subagent's internal tools.  Keeping currentTaskItem alive
    // ensures later is_subagent items still get grouped correctly.
    result.push(item);
  }

  return result;
}

/**
 * Ordered items preserve transcript position, while the legacy `tools` array is
 * the compatibility projection older/newer relay peers may update first. Keep
 * the ordered presentation, but let the explicit projection refresh matching
 * tool state and append tools that are absent from `items` so blocking prompts
 * can never become invisible during a mixed-version remote session.
 */
export function reconcileOrderedItemsWithTools(
  items: ChatMessageItem[],
  explicitTools: RemoteToolStatus[] = [],
): ChatMessageItem[] {
  if (explicitTools.length === 0) return items;

  const toolsById = new Map(explicitTools.map(tool => [tool.id, tool]));
  const seenToolIds = new Set<string>();

  const reconcileItems = (source: ChatMessageItem[]): ChatMessageItem[] => source.map((item) => {
    const explicit = item.tool?.id ? toolsById.get(item.tool.id) : undefined;
    const tool = item.tool && explicit
      ? {
          ...item.tool,
          ...explicit,
          duration_ms: explicit.duration_ms ?? item.tool.duration_ms,
          start_ms: explicit.start_ms ?? item.tool.start_ms,
          input_preview: explicit.input_preview ?? item.tool.input_preview,
          tool_input: explicit.tool_input ?? item.tool.tool_input,
        }
      : item.tool;

    if (tool?.id) seenToolIds.add(tool.id);
    const subItems = item.subItems ? reconcileItems(item.subItems) : item.subItems;
    return tool === item.tool && subItems === item.subItems ? item : { ...item, tool, subItems };
  });

  const reconciled = reconcileItems(items);
  const missingItems = explicitTools
    .filter(tool => !seenToolIds.has(tool.id))
    .map(tool => ({ type: 'tool' as const, tool }));
  return missingItems.length > 0 ? [...reconciled, ...missingItems] : reconciled;
}

function groupChatItems(items: ChatMessageItem[]) {
  const groups: { type: string; entries: ChatMessageItem[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.type === item.type) {
      last.entries.push(item);
    } else {
      groups.push({ type: item.type, entries: [item] });
    }
  }
  return groups;
}

function renderQuestionEntries(
  entries: ChatMessageItem[],
  keyPrefix: string,
  onAnswer?: (toolId: string, answers: any) => Promise<void>,
) {
  if (!onAnswer) return null;
  return entries.map((entry, idx) => (
    <ChatAskQuestionCard
      key={`${keyPrefix}-ask-${entry.tool!.id}-${idx}`}
      tool={entry.tool!}
      onAnswer={onAnswer}
    />
  ));
}

function renderStandardGroups(
  groups: { type: string; entries: ChatMessageItem[] }[],
  keyPrefix: string,
  now: number,
  onCancelTool?: (toolId: string) => void,
  onApproveTool?: ToolApprovalHandler,
  onRejectTool?: ToolApprovalHandler,
  animate?: boolean,
  onFileDownload?: (path: string, onProgress?: (downloaded: number, total: number) => void) => Promise<void>,
  onGetFileInfo?: (path: string) => Promise<{ name: string; size: number; mimeType: string }>,
  isActiveTurn?: boolean,
) {
  return groups.map((g, gi) => {
    if (g.type === 'thinking') {
      const text = g.entries.map(e => e.content || '').join('\n\n');
      const isLast = isActiveTurn && gi === groups.length - 1;
      return <ThinkingBlock key={`${keyPrefix}-thinking-${gi}`} thinking={text} streaming={isLast} isLastItem={isLast} />;
    }
    if (g.type === 'tool') {
      const rendered: React.ReactNode[] = [];
      let regularBuf: RemoteToolStatus[] = [];
      let readBuf: RemoteToolStatus[] = [];

      const flushRead = () => {
        if (readBuf.length > 0) {
          rendered.push(
            <ReadFilesToggle key={`${keyPrefix}-read-${gi}-${rendered.length}`} tools={readBuf} />,
          );
          readBuf = [];
        }
      };

      const flushRegular = () => {
        if (regularBuf.length > 0) {
          rendered.push(
            <ToolList key={`${keyPrefix}-tl-${gi}-${rendered.length}`} tools={regularBuf} now={now} onCancelTool={onCancelTool} onApproveTool={onApproveTool} onRejectTool={onRejectTool} />,
          );
          regularBuf = [];
        }
      };

      const flushAll = () => { flushRead(); flushRegular(); };

      for (const entry of g.entries) {
        if (entry.tool && !['Task', 'AgentSpawn'].includes(entry.tool.name) && isToolAwaitingApproval(entry.tool)) {
          flushAll();
          rendered.push(
            <ToolCard key={`${keyPrefix}-approval-${gi}-${rendered.length}`} tool={entry.tool} now={now} onApproveTool={onApproveTool} onRejectTool={onRejectTool} />,
          );
        } else if (entry.tool && ['Task', 'AgentSpawn'].includes(entry.tool.name)) {
          flushAll();
          rendered.push(
            <TaskToolCard key={`${keyPrefix}-task-${gi}-${rendered.length}`} tool={entry.tool!} now={now} subItems={entry.subItems} onCancelTool={onCancelTool} onApproveTool={onApproveTool} onRejectTool={onRejectTool} />,
          );
        } else if (entry.tool?.name === 'TodoWrite') {
          flushAll();
          rendered.push(<TodoCard key={`${keyPrefix}-todo-${gi}-${rendered.length}`} tool={entry.tool!} />);
        } else if (entry.tool && READ_LIKE_TOOLS.has(entry.tool.name) && !['failed', 'error'].includes(entry.tool.status)) {
          flushRegular();
          readBuf.push(entry.tool);
        } else if (entry.tool) {
          flushRead();
          regularBuf.push(entry.tool);
        }
      }
      flushAll();

      return <React.Fragment key={`${keyPrefix}-tool-${gi}`}>{rendered}</React.Fragment>;
    }
    if (g.type === 'text') {
      const text = g.entries.map(e => e.content || '').join('');
      return text ? (
        <div key={`${keyPrefix}-text-${gi}`} className="chat-msg__assistant-content">
          {animate
            ? <TypewriterText content={text} onFileDownload={onFileDownload} onGetFileInfo={onGetFileInfo} />
            : <MarkdownContent content={text} onFileDownload={onFileDownload} onGetFileInfo={onGetFileInfo} />}
        </div>
      ) : null;
    }
    return null;
  });
}

// ─── Ordered Items renderer ─────────────────────────────────────────────────

export function renderOrderedItems(
  rawItems: ChatMessageItem[],
  now: number,
  onCancelTool?: (toolId: string) => void,
  onApproveTool?: ToolApprovalHandler,
  onRejectTool?: ToolApprovalHandler,
  onAnswer?: (toolId: string, answers: any) => Promise<void>,
  onFileDownload?: (path: string, onProgress?: (downloaded: number, total: number) => void) => Promise<void>,
  onGetFileInfo?: (path: string) => Promise<{ name: string; size: number; mimeType: string }>,
) {
  const items = filterSubagentItems(rawItems);
  const askEntries = items.filter(item => isPendingAskUserQuestion(item.tool));
  if (askEntries.length === 0) {
    return renderStandardGroups(groupChatItems(items), 'ordered', now, onCancelTool, onApproveTool, onRejectTool, false, onFileDownload, onGetFileInfo);
  }

  const beforeAskItems: ChatMessageItem[] = [];
  const afterAskItems: ChatMessageItem[] = [];
  let foundFirstAsk = false;
  for (const item of items) {
    if (isPendingAskUserQuestion(item.tool)) {
      foundFirstAsk = true;
    } else if (!foundFirstAsk) {
      beforeAskItems.push(item);
    } else {
      afterAskItems.push(item);
    }
  }

  return (
    <>
      {renderStandardGroups(groupChatItems(beforeAskItems), 'ordered-before', now, onCancelTool, onApproveTool, onRejectTool, false, onFileDownload, onGetFileInfo)}
      {renderQuestionEntries(askEntries, 'ordered', onAnswer)}
      {renderStandardGroups(groupChatItems(afterAskItems), 'ordered-after', now, onCancelTool, onApproveTool, onRejectTool, false, onFileDownload, onGetFileInfo)}
    </>
  );
}

// ─── Active turn items renderer (with AskUserQuestion support) ─────────────

export function renderActiveTurnItems(
  rawItems: ChatMessageItem[],
  now: number,
  onAnswer: (toolId: string, answers: any) => Promise<void>,
  onCancelTool: (toolId: string) => void,
  onApproveTool: ToolApprovalHandler,
  onRejectTool: ToolApprovalHandler,
  onFileDownload?: (path: string, onProgress?: (downloaded: number, total: number) => void) => Promise<void>,
  onGetFileInfo?: (path: string) => Promise<{ name: string; size: number; mimeType: string }>,
) {
  const items = filterSubagentItems(rawItems);
  const askEntries = items.filter(item => isPendingAskUserQuestion(item.tool));

  if (askEntries.length === 0) {
    return renderStandardGroups(groupChatItems(items), 'active', now, onCancelTool, onApproveTool, onRejectTool, true, onFileDownload, onGetFileInfo, true);
  }

  const beforeAskItems: ChatMessageItem[] = [];
  const afterAskItems: ChatMessageItem[] = [];
  let foundFirstAsk = false;
  for (const item of items) {
    if (isPendingAskUserQuestion(item.tool)) {
      foundFirstAsk = true;
    } else if (!foundFirstAsk) {
      beforeAskItems.push(item);
    } else {
      afterAskItems.push(item);
    }
  }

  return (
    <>
      {renderStandardGroups(groupChatItems(beforeAskItems), 'active-before', now, onCancelTool, onApproveTool, onRejectTool, true, onFileDownload, onGetFileInfo, true)}
      {renderQuestionEntries(askEntries, 'active', onAnswer)}
      {renderStandardGroups(groupChatItems(afterAskItems), 'active-after', now, onCancelTool, onApproveTool, onRejectTool, true, onFileDownload, onGetFileInfo, true)}
    </>
  );
}

interface OptimisticMessage {
  id: string;
  text: string;
  images: Array<{ name: string; data_url: string }>;
}

interface ChatTranscriptProps {
  activeTurn: ActiveTurnSnapshot | null;
  expandedMessageIds: ReadonlySet<string>;
  imageAnalyzing: boolean;
  menuMessageId?: string;
  messages: ChatMessage[];
  now: number;
  optimisticMessage: OptimisticMessage | null;
  onAnswerQuestion: (toolId: string, answers: any) => Promise<void>;
  onApproveTool: ToolApprovalHandler;
  onCancelActiveTool: (toolId: string) => void;
  onCancelLegacyTool: (toolId: string) => void;
  onRejectTool: ToolApprovalHandler;
  onFileDownload?: (path: string, onProgress?: (downloaded: number, total: number) => void) => Promise<void>;
  onGetFileInfo?: (path: string) => Promise<{ name: string; size: number; mimeType: string }>;
  onMessageContextMenu: (message: ChatMessage, event: React.MouseEvent) => void;
  onMessageTouchEnd: () => void;
  onMessageTouchMove: (event: React.TouchEvent) => void;
  onMessageTouchStart: (message: ChatMessage, event: React.TouchEvent) => void;
  onToggleMessage: (messageId: string, expanded: boolean) => void;
}

/**
 * Owns the complete persisted/live transcript presentation. Remote mutations
 * stay in ChatPage and enter through callbacks so replay and target fencing
 * remain page-controller responsibilities.
 */
const ChatTranscript: React.FC<ChatTranscriptProps> = ({
  activeTurn,
  expandedMessageIds,
  imageAnalyzing,
  menuMessageId,
  messages,
  now,
  optimisticMessage,
  onAnswerQuestion,
  onApproveTool,
  onCancelActiveTool,
  onCancelLegacyTool,
  onRejectTool,
  onFileDownload,
  onGetFileInfo,
  onMessageContextMenu,
  onMessageTouchEnd,
  onMessageTouchMove,
  onMessageTouchStart,
  onToggleMessage,
}) => {
  const { t } = useI18n();
  const lastUserIndex = messages.reduceRight(
    (found, message, index) => (found < 0 && message.role === 'user' ? index : found),
    -1,
  );

  return (
    <>
      {messages.map((message, index) => {
        if (message.role === 'system' || message.role === 'tool') return null;

        if (message.role === 'user') {
          return (
            <MobileMessage
              key={message.id}
              className={`chat-msg chat-msg--user${menuMessageId === message.id ? ' chat-msg--menu-active' : ''}`}
              roleType="user"
              onTouchStart={(event) => onMessageTouchStart(message, event)}
              onTouchMove={onMessageTouchMove}
              onTouchEnd={onMessageTouchEnd}
              onTouchCancel={onMessageTouchEnd}
              onContextMenu={(event) => onMessageContextMenu(message, event)}
            >
              <div className="chat-msg__user-content">
                {sanitizeMessageText(message.content)}
                {message.images && message.images.length > 0 && (
                  <div className="chat-msg__user-images">
                    {message.images.map((image, imageIndex) => (
                      <img
                        key={imageIndex}
                        src={image.data_url}
                        alt={image.name}
                        className="chat-msg__user-image"
                      />
                    ))}
                  </div>
                )}
              </div>
            </MobileMessage>
          );
        }

        const hasItems = !!message.items?.length;
        const hasContent = !!(message.thinking || message.tools?.length || message.content);
        if (!hasItems && !hasContent) return null;

        const isOldResponse = index < lastUserIndex;
        const isExpanded = expandedMessageIds.has(message.id);
        const toggle = (expanded: boolean) => (
          <MobileButton
            appearance="plain"
            className="chat-msg__response-toggle"
            onClick={() => onToggleMessage(message.id, !expanded)}
          >
            <span className={`chat-msg__response-chevron${expanded ? ' is-open' : ''}`}>
              <LucideChevronRight width="10" height="10" aria-hidden="true" />
            </span>
            <span className="chat-msg__response-label">{t(expanded ? 'chat.hideResponse' : 'chat.showResponse')}</span>
          </MobileButton>
        );

        if (isOldResponse && !isExpanded) {
          return (
            <MobileMessage
              key={message.id}
              className={`chat-msg chat-msg--assistant chat-msg--collapsed${menuMessageId === message.id ? ' chat-msg--menu-active' : ''}`}
              roleType="assistant"
              onTouchStart={(event) => onMessageTouchStart(message, event)}
              onTouchMove={onMessageTouchMove}
              onTouchEnd={onMessageTouchEnd}
              onTouchCancel={onMessageTouchEnd}
              onContextMenu={(event) => onMessageContextMenu(message, event)}
            >
              {toggle(false)}
            </MobileMessage>
          );
        }

        return (
          <MobileMessage
            key={message.id}
            className={`chat-msg chat-msg--assistant${menuMessageId === message.id ? ' chat-msg--menu-active' : ''}`}
            roleType="assistant"
            onTouchStart={(event) => onMessageTouchStart(message, event)}
            onTouchMove={onMessageTouchMove}
            onTouchEnd={onMessageTouchEnd}
            onTouchCancel={onMessageTouchEnd}
            onContextMenu={(event) => onMessageContextMenu(message, event)}
          >
            {isOldResponse && isExpanded && toggle(true)}
            {hasItems ? (
              renderOrderedItems(reconcileOrderedItemsWithTools(message.items!, message.tools), now, undefined, onApproveTool, onRejectTool, onAnswerQuestion, onFileDownload, onGetFileInfo)
            ) : (
              <>
                {message.thinking && <ThinkingBlock thinking={message.thinking} />}
                {!!message.tools?.length && <ToolList tools={message.tools} now={now} onApproveTool={onApproveTool} onRejectTool={onRejectTool} />}
                {message.content && (
                  <div className="chat-msg__assistant-content">
                    <MarkdownContent content={message.content} onFileDownload={onFileDownload} onGetFileInfo={onGetFileInfo} />
                  </div>
                )}
              </>
            )}
          </MobileMessage>
        );
      })}

      {activeTurn && (() => {
        const turnIsActive = activeTurn.status === 'active';
        if (activeTurn.items?.length) {
          const reconciledItems = reconcileOrderedItemsWithTools(activeTurn.items, activeTurn.tools);
          return (
            <MobileMessage className="chat-msg chat-msg--assistant" roleType="assistant">
              {turnIsActive
                ? renderActiveTurnItems(
                    reconciledItems,
                    now,
                    onAnswerQuestion,
                    onCancelActiveTool,
                    onApproveTool,
                    onRejectTool,
                    onFileDownload,
                    onGetFileInfo,
                  )
                : renderOrderedItems(reconciledItems, now, undefined, onApproveTool, onRejectTool, undefined, onFileDownload, onGetFileInfo)}
              {turnIsActive && !activeTurn.thinking && !activeTurn.text && activeTurn.tools.length === 0 && (
                <div className="chat-msg__assistant-content"><TypingDots /></div>
              )}
            </MobileMessage>
          );
        }

        const taskTools = activeTurn.tools.filter((tool) => ['Task', 'AgentSpawn'].includes(tool.name));
        const hasRunningSubagent = taskTools.some((tool) => tool.status === 'running');
        const askTools = activeTurn.tools.filter(
          (tool) => tool.name === 'AskUserQuestion' && tool.status === 'running' && tool.tool_input,
        );
        const askToolIds = new Set(askTools.map((tool) => tool.id));
        const regularTools = activeTurn.tools.filter((tool) => !['Task', 'AgentSpawn'].includes(tool.name) && !askToolIds.has(tool.id));
        const subItemsForTask: ChatMessageItem[] = hasRunningSubagent
          ? [
              ...(activeTurn.thinking ? [{ type: 'thinking' as const, content: activeTurn.thinking }] : []),
              ...regularTools.map((tool) => ({ type: 'tool' as const, tool })),
            ]
          : [];

        return (
          <MobileMessage className="chat-msg chat-msg--assistant" roleType="assistant">
            {!hasRunningSubagent && (activeTurn.thinking || turnIsActive) && (
              <ThinkingBlock
                thinking={activeTurn.thinking}
                streaming={turnIsActive}
                isLastItem={turnIsActive}
              />
            )}
            {taskTools.map((tool) => (
              <TaskToolCard
                key={tool.id}
                tool={tool}
                now={now}
                subItems={tool.status === 'running' ? subItemsForTask : undefined}
                onCancelTool={onCancelLegacyTool}
                onApproveTool={onApproveTool}
                onRejectTool={onRejectTool}
              />
            ))}
            {!hasRunningSubagent && regularTools.length > 0 && (
              <ToolList tools={regularTools} now={now} onCancelTool={onCancelLegacyTool} onApproveTool={onApproveTool} onRejectTool={onRejectTool} />
            )}
            {turnIsActive && askTools.map((tool) => (
              <ChatAskQuestionCard key={tool.id} tool={tool} onAnswer={onAnswerQuestion} />
            ))}
            {!hasRunningSubagent && activeTurn.text ? (
              <div className="chat-msg__assistant-content">
                {turnIsActive
                  ? <TypewriterText content={activeTurn.text} onFileDownload={onFileDownload} onGetFileInfo={onGetFileInfo} />
                  : <MarkdownContent content={activeTurn.text} onFileDownload={onFileDownload} onGetFileInfo={onGetFileInfo} />}
              </div>
            ) : turnIsActive && !activeTurn.thinking && activeTurn.tools.length === 0 ? (
              <div className="chat-msg__assistant-content"><TypingDots /></div>
            ) : null}
          </MobileMessage>
        );
      })()}

      {optimisticMessage && (
        <MobileMessage className="chat-msg chat-msg--user" roleType="user">
          <div className="chat-msg__user-content">
            {optimisticMessage.text}
            {optimisticMessage.images.length > 0 && (
              <div className="chat-msg__user-images">
                {optimisticMessage.images.map((image, imageIndex) => (
                  <img key={imageIndex} src={image.data_url} alt={image.name} className="chat-msg__user-image" />
                ))}
              </div>
            )}
          </div>
        </MobileMessage>
      )}

      {imageAnalyzing && (
        <MobileMessage className="chat-msg chat-msg--assistant" roleType="assistant">
          <div className="chat-msg__assistant-card">
            <div className="chat-msg__image-analyzing">
              <div className="chat-msg__image-analyzing-icon">
                <LucideLoaderCircle width="16" height="16" stroke="currentColor" aria-hidden="true" />
              </div>
              <span>{t('chat.analyzingImage')}</span>
              <TypingDots />
            </div>
          </div>
        </MobileMessage>
      )}
    </>
  );
};

export default ChatTranscript;
