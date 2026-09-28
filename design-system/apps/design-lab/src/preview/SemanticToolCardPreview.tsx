import { useState } from 'react';
import { Target, Users, History, ScanEye, Clock, FolderSearch, GitBranch, Route, GitPullRequest, PanelsTopLeft, RefreshCw, Upload, Workflow } from 'lucide-react';
import {
  GoalToolCard, AgentRosterToolCard, SessionHistoryToolCard, ImageAnalysisToolCard, TimeToolCard,
  McpResourceToolCard, WorktreeToolCard, PortForwardToolCard, ReviewPlatformToolCard,
  FrontendWorkbenchToolCard, MiniAppFinalizeToolCard, MarketplacePublishToolCard, PlaybookToolCard,
  type SemanticToolCardProps,
} from '@openbitfun/ui/flow-chat';
import { toolsForComponent } from '@openbitfun/flow-chat-presentation/registry';
import { useI18n, type MessageKey } from '../i18n';
import type { FlowChatPreviewDefinition } from './FlowChatPreviewRegistry';

const views = { GoalToolCard, AgentRosterToolCard, SessionHistoryToolCard, ImageAnalysisToolCard, TimeToolCard,
  McpResourceToolCard, WorktreeToolCard, PortForwardToolCard, ReviewPlatformToolCard,
  FrontendWorkbenchToolCard, MiniAppFinalizeToolCard, MarketplacePublishToolCard, PlaybookToolCard };
type Name = keyof typeof views;
const icons = { GoalToolCard: Target, AgentRosterToolCard: Users, SessionHistoryToolCard: History,
  ImageAnalysisToolCard: ScanEye, TimeToolCard: Clock, McpResourceToolCard: FolderSearch, WorktreeToolCard: GitBranch,
  PortForwardToolCard: Route, ReviewPlatformToolCard: GitPullRequest, FrontendWorkbenchToolCard: PanelsTopLeft,
  MiniAppFinalizeToolCard: RefreshCw, MarketplacePublishToolCard: Upload, PlaybookToolCard: Workflow };

function SemanticPreview({ component, interactive, specimen, state }: Parameters<FlowChatPreviewDefinition['render']>[0] & { component: Name }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(state === 'expanded' || state === 'error');
  const text = (key: string) => t(`flowChat.builtin.${key}` as MessageKey);
  const tool = specimen?.tool ?? toolsForComponent(component)[0] ?? component;
  const prominent = ['create_goal', 'update_goal', 'AgentDelete', 'Worktree', 'PortForward', 'ReviewPlatform',
    'FrontendWorkbench', 'FinalizeMiniApp', 'PublishMiniApp', 'PublishAppearance'].includes(tool);
  const props: SemanticToolCardProps = {
    action: text(`tools.${tool}`), status: state === 'loading' ? 'running' : state === 'error' ? 'error' : 'completed',
    attention: prominent ? 'prominent' : 'ambient', isExpanded: expanded,
    requiresConfirmation: state === 'confirmation', onToggle: interactive ? () => setExpanded(value => !value) : undefined,
    error: state === 'error' ? text('samples.error') : undefined,
    resultText: '{ "recorded": true }', resultLabel: text('rawResult'),
    fields: [{ label: text('fields.state'), value: text('states.ready') }],
  };
  const field = (key: string, value: string) => ({ label: text(`fields.${key}`), value });
  switch (component) {
    case 'GoalToolCard':
      props.summary = text('samples.goal');
      props.fields = [field('tokenBudget', '20,000'), field('tokensUsed', '6,420'), field('tokensRemaining', '13,580')];
      props.outcome = { label: text('states.active'), tone: 'neutral' };
      break;
    case 'AgentRosterToolCard':
      props.summary = text('directChildren'); props.recordsLabel = text('fields.agents');
      props.records = [{ key: 'reviewer', title: 'reviewer', state: text('states.running') }, { key: 'writer', title: 'writer', state: text('states.complete') }];
      if (tool === 'AgentDelete') props.notice = text('deleteAgentScope');
      break;
    case 'SessionHistoryToolCard':
      props.summary = 'design-review'; props.fields = [field('path', 'history/design-review.md'), field('index', '18–62')]; break;
    case 'ImageAnalysisToolCard':
      props.summary = 'dashboard.png'; props.fields = [field('dimensions', '1440 × 900')];
      props.sections = [{ key: 'analysis', label: text('fields.analysis'), content: text('samples.analysis') }]; break;
    case 'TimeToolCard':
      props.summary = '2026-09-27T12:30:00+08:00'; props.fields = [field('utc', '2026-09-27T04:30:00Z'), field('timezone', '+08:00')]; break;
    case 'McpResourceToolCard':
      props.summary = 'project-docs'; props.fields = [field('server', 'project-docs')];
      props.records = [{ key: 'guide', title: 'Architecture', fields: [field('uri', 'docs://architecture'), field('mimeType', 'text/markdown')] }]; break;
    case 'WorktreeToolCard':
      props.summary = 'design-review'; props.fields = [field('path', '/worktrees/design-review'), field('branch', 'design-review'), field('baseRef', 'main')]; break;
    case 'PortForwardToolCard':
      props.summary = '127.0.0.1:5174'; props.connection = { from: 'development:5173', to: '127.0.0.1:5174' };
      props.fields = [field('requestedPort', '5173')]; props.notice = text('portMoved'); break;
    case 'ReviewPlatformToolCard':
      props.summary = '#42 · Keyboard navigation'; props.fields = [field('sourceBranch', 'keyboard-navigation'), field('targetBranch', 'main')]; break;
    case 'FrontendWorkbenchToolCard':
      props.summary = 'revision-18'; props.fields = [field('activeRevision', 'revision-17'), field('previousRevision', 'revision-16')];
      props.outcome = { label: text('states.rolledBack'), tone: 'warning' }; break;
    case 'MiniAppFinalizeToolCard':
      props.summary = 'dashboard'; props.fields = [field('version', '1.2.0')];
      props.outcome = { label: text('states.updated'), tone: 'success' }; props.notice = text('runtimeNotified'); break;
    case 'MarketplacePublishToolCard':
      props.summary = 'dashboard'; props.fields = [field('submission', 'submission-42')];
      props.outcome = { label: text('states.pendingReview'), tone: 'neutral' }; props.notice = text('reviewPending'); break;
    case 'PlaybookToolCard':
      props.summary = 'Review'; props.ordered = true; props.recordsLabel = text('fields.steps'); props.notice = text('playbookInstructions');
      props.records = [{ key: '1', title: 'browser.snapshot' }, { key: '2', title: 'browser.read_article' }]; break;
  }
  if (props.status !== 'completed') props.outcome = undefined;
  if (component === 'AgentRosterToolCard') return <AgentRosterToolCard {...props} deleting={tool === 'AgentDelete'} />;
  if (component === 'MarketplacePublishToolCard') return <MarketplacePublishToolCard {...props} appearance={tool === 'PublishAppearance'} />;
  if (component === 'McpResourceToolCard') return <McpResourceToolCard {...props} kind={tool === 'ReadMCPResource' ? 'resource'
    : tool === 'GetMCPPrompt' ? 'prompt' : tool === 'ListMCPPrompts' ? 'prompts' : 'resources'} />;
  const View = views[component];
  return <View {...props} />;
}

function definition(component: Name): FlowChatPreviewDefinition { return {
  attention: 'adaptive', icon: icons[component], section: 'tool-card',
  codeSample: () => `<${component} status={status} action={label} fields={fields} isExpanded={expanded} onToggle={toggle} />`,
  render: options => <SemanticPreview {...options} component={component} />,
  specimens: toolsForComponent(component).map(tool => ({ tool })),
}; }

export const semanticToolCardPreviews = {
  GoalToolCard: definition('GoalToolCard'), AgentRosterToolCard: definition('AgentRosterToolCard'),
  SessionHistoryToolCard: definition('SessionHistoryToolCard'), ImageAnalysisToolCard: definition('ImageAnalysisToolCard'),
  TimeToolCard: definition('TimeToolCard'), McpResourceToolCard: definition('McpResourceToolCard'),
  WorktreeToolCard: definition('WorktreeToolCard'), PortForwardToolCard: definition('PortForwardToolCard'),
  ReviewPlatformToolCard: definition('ReviewPlatformToolCard'), FrontendWorkbenchToolCard: definition('FrontendWorkbenchToolCard'),
  MiniAppFinalizeToolCard: definition('MiniAppFinalizeToolCard'), MarketplacePublishToolCard: definition('MarketplacePublishToolCard'),
  PlaybookToolCard: definition('PlaybookToolCard'),
} satisfies Record<Name, FlowChatPreviewDefinition>;
