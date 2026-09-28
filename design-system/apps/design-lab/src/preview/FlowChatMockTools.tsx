import { Select } from '@openbitfun/ui';
import { productOwnedToolNames, toolPresentationRegistry, type ToolNameForOwner } from '@openbitfun/flow-chat-presentation/registry';
import { FlowChatComponentPreview } from './FlowChatPreviewRegistry';
import { useI18n } from '../i18n';

const toolGroups = ['files', 'execution', 'web', 'collaboration'] as const;
type ToolGroup = typeof toolGroups[number];
export type MockToolScope = 'all' | ToolGroup;

// Only grouping is Lab-owned. Names and component bindings come from production.
const groupForTool = {
  get_goal: 'collaboration', create_goal: 'collaboration', update_goal: 'collaboration', AgentList: 'collaboration', AgentDelete: 'collaboration',
  SessionHistory: 'collaboration', analyze_image: 'files', GetTime: 'execution',
  ListMCPResources: 'execution', ReadMCPResource: 'execution', ListMCPPrompts: 'execution', GetMCPPrompt: 'execution',
  Worktree: 'files', PortForward: 'execution', ReviewPlatform: 'collaboration', FrontendWorkbench: 'web',
  FinalizeMiniApp: 'web', PublishMiniApp: 'web', PublishAppearance: 'web', Playbook: 'execution',
  Read: 'files', Write: 'files', Edit: 'files', Delete: 'files', Grep: 'files', Glob: 'files', LS: 'files',
  GetFileDiff: 'files', view_image: 'files',
  ListModels: 'execution', ControlHub: 'web', AgentInterrupt: 'collaboration',
  RunCode: 'execution', ExecCommand: 'execution', WriteStdin: 'execution', ExecControl: 'execution', Cron: 'execution', GetToolSpec: 'execution', Skill: 'execution',
  WebSearch: 'web', WebFetch: 'web', PageDeploy: 'web', PagePublish: 'web',
  AgentSpawn: 'collaboration', AgentSendInput: 'collaboration', AgentWait: 'collaboration', TodoWrite: 'collaboration',
  ContextCompression: 'collaboration', ReviewSessionSummary: 'collaboration', SessionControl: 'collaboration', SessionMessage: 'collaboration',
} as const satisfies Record<ToolNameForOwner<'standard'>, ToolGroup>;

export const mockToolCoverage = Object.entries(toolPresentationRegistry)
  .flatMap(([name, entry]) => {
    if (entry.owner !== 'standard') return [];
    const tool = name as ToolNameForOwner<'standard'>;
    return [{ tool, component: entry.component, group: groupForTool[tool] }];
  });

export function FlowChatMockToolFilter({ group, onChange }: { group: MockToolScope; onChange: (group: MockToolScope) => void }) {
  const { t } = useI18n();
  const visible = mockToolCoverage.filter((tool) => group === 'all' || group === tool.group);
  return <div className="flow-chat-mock__coverage-controls">
      <Select size="sm" aria-label={t('flowChat.mock.toolGroup')} value={group} onValueChange={(value) => onChange(value as MockToolScope)}
        options={(['all', ...toolGroups] as const).map((value) => ({ value, label: t(`flowChat.mock.tools.${value}`) }))} />
      <span>{t('flowChat.mock.coverage', { visible: visible.length, total: mockToolCoverage.length })}</span>
    </div>;
}

export function FlowChatMockTools({ group }: { group: MockToolScope }) {
  const { t } = useI18n();
  const visible = mockToolCoverage.filter((tool) => group === 'all' || group === tool.group);
  return <>
    {toolGroups.filter((kind) => group === 'all' || kind === group).map((kind) => <article className="flow-chat-mock__assistant" key={kind}>
      <p><strong>{t(`flowChat.mock.tools.${kind}`)}</strong></p>
      {visible.filter((tool) => tool.group === kind).map(({ tool, component }) => <div className="flow-chat-mock__tool" data-mock-tool={tool} key={tool}>
        <FlowChatComponentPreview componentName={component} specimen={{ tool }} />
      </div>)}
    </article>)}
  </>;
}

export function FlowChatMockCoverageNote() {
  const { t } = useI18n();
  return <aside className="flow-chat-mock__coverage-note">
      <p>{t('flowChat.mock.productOwned')}</p>
      <code>{[...productOwnedToolNames, 'mcp__*'].join(' · ')}</code>
    </aside>;
}
