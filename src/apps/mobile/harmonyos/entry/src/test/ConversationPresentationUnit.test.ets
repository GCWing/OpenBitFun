import { AccountLoginErrorPolicy } from '../main/ets/pages/policy/AccountLoginErrorPolicy';
import { describe, it, expect } from '@ohos/hypium';
import { RemoteI18n } from '../main/ets/i18n/RemoteI18n';
import { ChatComposerPolicy, ComposerPrimaryAction } from '../main/ets/services/ChatComposerPolicy';
import { ChatSurface } from '../main/ets/pages/state/ChatSurface';
import {
  GENERAL_CHAT_COMPOSER_CAPABILITIES,
  REMOTE_CHAT_COMPOSER_CAPABILITIES
} from '../main/ets/pages/state/ChatComposerCapabilities';
import { ConversationViewState } from '../main/ets/pages/state/ConversationViewState';
import { GeneralChatPageState } from '../main/ets/pages/state/GeneralChatPageState';
import { RemotePageState } from '../main/ets/pages/state/RemotePageState';
import { AppRoute } from '../main/ets/pages/navigation/AppRouteContract';
import { ConversationHeaderPolicy } from '../main/ets/pages/policy/ConversationHeaderPolicy';
import { ModelServiceSettingsPolicy } from '../main/ets/pages/policy/ModelServiceSettingsPolicy';
import { GENERAL_CHAT_LOCAL_MODEL_ID } from '../main/ets/services/general-chat/GeneralChatConfigStore';
import { RemoteModelCatalog, RemoteModelConfig } from '../main/ets/model/RemoteModels';
import { ThinkingPresentationPolicy } from '../main/ets/pages/policy/ThinkingPresentationPolicy';
import {
  ActivityGroupPolicy,
  ActivityRowPlan,
  ActivityThinkingPart
} from '../main/ets/pages/policy/ActivityGroupPolicy';
import { AssistantProcessLayoutPolicy } from '../main/ets/pages/policy/AssistantProcessLayoutPolicy';
import { ConversationMessageRenderPolicy } from '../main/ets/pages/policy/ConversationMessageRenderPolicy';
import { ToolCollapsePolicy } from '../main/ets/pages/policy/ToolCollapsePolicy';
import { ChatMessageStructurePolicy } from '../main/ets/pages/policy/ChatMessageStructurePolicy';
import { ToolStatusPresentationPolicy } from '../main/ets/pages/policy/ToolStatusPresentationPolicy';
import { PlanToolPolicy } from '../main/ets/pages/policy/PlanToolPolicy';
import {
  ConversationUiMessage,
  ConversationUiMessageItem,
  ConversationUiToolStatus
} from '../main/ets/pages/state/ConversationUiModels';
import {
  ConnectSheetLandingPolicy,
  ConnectSheetStatusPolicy,
  ConnectSheetStep
} from '../main/ets/pages/policy/ConnectSheetLandingPolicy';
import {
  RemoteConnectEntryKind,
  RemoteSurfaceEntryPolicy
} from '../main/ets/pages/policy/RemoteSurfaceEntryPolicy';
import { RemoteCompactHomePolicy } from '../main/ets/pages/policy/RemoteCompactHomePolicy';
import { AccountDeviceSelectionPolicy } from '../main/ets/pages/policy/AccountDeviceSelectionPolicy';
import { SidebarConnectionActionPolicy } from '../main/ets/pages/policy/SidebarConnectionActionPolicy';
import { SidebarDeviceProjectionPolicy } from '../main/ets/pages/policy/SidebarDeviceProjectionPolicy';
import { HarnessProfilePolicy } from '../main/ets/pages/policy/HarnessProfilePolicy';
import { CONNECT_INTENT_AUTO, CONNECT_INTENT_SCAN } from '../main/ets/pages/state/AppShellState';
import {
  DetectedUrlAction
} from '../main/ets/services/ConnectScanDecisionPolicy';

interface LoginFailureFixture { code?: number; statusCode?: number; }

export default function conversationPresentationUnitTest() {
  describe('HarnessProfilePolicy', () => {
    it('maps mobile execution levels to canonical host Agents', 0, () => {
      expect(HarnessProfilePolicy.agentType('minimal')).assertEqual('minimal');
      expect(HarnessProfilePolicy.agentType('standard')).assertEqual('agentic');
      expect(HarnessProfilePolicy.agentType('ultimate')).assertEqual('Ultra');
    });
  });

  describe('Local conversation empty home', () => {
    it('keeps local chat on a blank timeline instead of suggestion chips', 0, () => {
      const projection = ConversationViewState.project(
        AppRoute.ChatHome,
        new RemotePageState(),
        new GeneralChatPageState(),
        ''
      );

      expect(projection.surface).assertEqual(ChatSurface.General);
      expect(projection.showSuggestionsWhenEmpty).assertFalse();
      expect(projection.timelineItems.length).assertEqual(0);
    });
  });

  describe('ThinkingPresentationPolicy', () => {
    it('reserves enough width for every running dot and inter-dot gap', 0, () => {
      expect(ThinkingPresentationPolicy.runningDotsWidth()).assertEqual(30);
      expect(ThinkingPresentationPolicy.runningDotsWidth() >=
        ThinkingPresentationPolicy.RUNNING_DOT_WIDTH * ThinkingPresentationPolicy.RUNNING_DOT_COUNT +
        ThinkingPresentationPolicy.RUNNING_DOT_GAP * (ThinkingPresentationPolicy.RUNNING_DOT_COUNT - 1)).assertTrue();
    });

    it('treats active and running as in-progress thinking', 0, () => {
      expect(ThinkingPresentationPolicy.isRunning('active')).assertTrue();
      expect(ThinkingPresentationPolicy.isRunning('running')).assertTrue();
      expect(ThinkingPresentationPolicy.isRunning('ACTIVE')).assertTrue();
      expect(ThinkingPresentationPolicy.isRunning('complete')).assertFalse();
      expect(ThinkingPresentationPolicy.isRunning('')).assertFalse();
    });

    it('hides the block when thinking is done and the body is empty', 0, () => {
      expect(ThinkingPresentationPolicy.shouldRender('complete', '')).assertFalse();
      expect(ThinkingPresentationPolicy.shouldRender('complete', '   ')).assertFalse();
    });

    it('keeps the block visible while running or when a body remains', 0, () => {
      expect(ThinkingPresentationPolicy.shouldRender('running', '')).assertTrue();
      expect(ThinkingPresentationPolicy.shouldRender('complete', '先看现有会话结构')).assertTrue();
    });

    it('expands by default only while running unless keepExpandedWhenDone is set', 0, () => {
      expect(ThinkingPresentationPolicy.defaultExpanded(true, false)).assertTrue();
      expect(ThinkingPresentationPolicy.defaultExpanded(false, false)).assertFalse();
      expect(ThinkingPresentationPolicy.defaultExpanded(false, true)).assertTrue();
    });

    it('lets the user collapse live thinking and folds it when the turn moves on', 0, () => {
      expect(ThinkingPresentationPolicy.allowsToggle(true)).assertTrue();
      expect(ThinkingPresentationPolicy.allowsToggle(false)).assertFalse();
      expect(ThinkingPresentationPolicy.expandedForStatus(true, false, false, false)).assertTrue();
      expect(ThinkingPresentationPolicy.expandedForStatus(true, false, true, false)).assertFalse();
      expect(ThinkingPresentationPolicy.expandedForStatus(false, false, true, true)).assertFalse();
      expect(ThinkingPresentationPolicy.expandedForStatus(false, true, false, true)).assertTrue();
    });

    it('marks leading thinking done once tools or answer text have started', 0, () => {
      expect(ThinkingPresentationPolicy.liveThinkingStatus('active', false)).assertEqual('active');
      expect(ThinkingPresentationPolicy.liveThinkingStatus('active', true)).assertEqual('done');
      expect(ThinkingPresentationPolicy.liveThinkingStatus('running', true)).assertEqual('done');
    });

    it('folds consecutive thinking segments into one body', 0, () => {
      expect(ThinkingPresentationPolicy.mergedText(['先看结构', '', '再跑工具'])).assertEqual('先看结构\n\n再跑工具');
      expect(ThinkingPresentationPolicy.mergedStatusValue(['done', 'done'], [false, false])).assertEqual('done');
      expect(ThinkingPresentationPolicy.mergedStatusValue(['done', 'active'], [false, true])).assertEqual('active');
      expect(ThinkingPresentationPolicy.mergedStreaming([false, false, true])).assertTrue();
      expect(ThinkingPresentationPolicy.mergedStreaming([false, false])).assertFalse();
    });
  });

  describe('ActivityGroupPolicy', () => {
    it('keeps consecutive thinking and completed tools in one foldable group', 0, () => {
      expect(ActivityGroupPolicy.shouldFoldEntry(true, false)).assertTrue();
      expect(ActivityGroupPolicy.shouldFoldEntry(false, false, toolStatus('1', 'Grep', 'completed'))).assertTrue();
      expect(ActivityGroupPolicy.shouldFoldEntry(false, false, toolStatus('2', 'ExecCommand', 'done'))).assertTrue();
      expect(ActivityGroupPolicy.thinkingHeaderCount(4)).assertEqual(1);
    });

    it('does not swallow Task cards, questions, or live tools into the thinking group', 0, () => {
      expect(ActivityGroupPolicy.shouldFoldEntry(false, true, toolStatus('1', 'Task', 'completed'))).assertFalse();
      expect(ActivityGroupPolicy.shouldFoldEntry(false, false, toolStatus('2', 'AskUserQuestion', 'completed'))).assertFalse();
      expect(ActivityGroupPolicy.shouldFoldEntry(false, false, toolStatus('3', 'Grep', 'running'))).assertFalse();
      expect(ActivityGroupPolicy.thinkingHeaderCount(0)).assertEqual(0);
    });

    it('merges an uninterrupted stretch of reasoning but keeps it where it happened', 0, () => {
      const parts = ActivityGroupPolicy.mergeThinkingParts([
        thinkingPart(0, 'first'),
        thinkingPart(0, 'still first'),
        thinkingPart(2, 'after two tools')
      ]);
      expect(parts.length).assertEqual(2);
      expect(parts[0].text).assertEqual('first\n\nstill first');
      expect(parts[0].beforeToolIndex).assertEqual(0);
      expect(parts[1].text).assertEqual('after two tools');
      expect(parts[1].beforeToolIndex).assertEqual(2);
    });

    it('hides reasoning behind the tool summary and unfolds it in transcript order', 0, () => {
      const tools = [
        toolStatus('1', 'Grep', 'completed'),
        toolStatus('2', 'Read', 'completed'),
        toolStatus('3', 'ExecCommand', 'completed')
      ];
      const parts = ActivityGroupPolicy.mergeThinkingParts([
        thinkingPart(0, 'before any tool'),
        thinkingPart(2, 'after two tools')
      ]);

      const collapsed = ToolCollapsePolicy.collapsedGroups(tools);
      expect(ActivityGroupPolicy.hasSummaryRow(collapsed)).assertTrue();
      const collapsedRows = ActivityGroupPolicy.weaveRows(collapsed, parts, false);
      expect(collapsedRows.length).assertEqual(1);
      expect(collapsedRows[0].kind).assertEqual('group');

      const expandedRows = ActivityGroupPolicy.weaveRows(
        ToolCollapsePolicy.expandedGroups(tools),
        parts,
        true
      );
      expect(rowPlanTrace(expandedRows)).assertEqual('group0 thinking0 group1 group2 thinking1 group3');
    });

    it('keeps reasoning on screen when a lone tool has no summary to unfold', 0, () => {
      const groups = ToolCollapsePolicy.collapsedGroups([toolStatus('1', 'Grep', 'completed')]);
      expect(ActivityGroupPolicy.hasSummaryRow(groups)).assertFalse();
      const rows = ActivityGroupPolicy.weaveRows(groups, [thinkingPart(0, 'why')], true);
      expect(rowPlanTrace(rows)).assertEqual('thinking0 group0');
    });

    it('trails reasoning that came after the last tool', 0, () => {
      const tools = [toolStatus('1', 'Grep', 'completed'), toolStatus('2', 'Read', 'completed')];
      const rows = ActivityGroupPolicy.weaveRows(
        ToolCollapsePolicy.expandedGroups(tools),
        [thinkingPart(2, 'wrapping up')],
        true
      );
      expect(rowPlanTrace(rows)).assertEqual('group0 group1 group2 thinking0');
    });
  });

  describe('ConversationMessageRenderPolicy', () => {
    it('does not throw when assistant text is missing and still shows structured content', 0, () => {
      expect(ConversationMessageRenderPolicy.visibleText(undefined)).assertEqual('');
      expect(ConversationMessageRenderPolicy.visibleText('(空消息)')).assertEqual('');
      const item: ConversationUiMessage = {
        id: 'a1',
        role: 'assistant',
        text: '',
        status: 'done',
        items: [{ type: 'thinking', content: '先看仓库结构' }]
      };
      expect(ConversationMessageRenderPolicy.shouldRender(item)).assertTrue();
    });

    it('hides an assistant row that has no text, thinking, tools, or items', 0, () => {
      const item: ConversationUiMessage = {
        id: 'a2',
        role: 'assistant',
        text: '',
        status: 'done'
      };
      expect(ConversationMessageRenderPolicy.shouldRender(item)).assertFalse();
    });

    it('keeps an empty failed assistant row for its error UI', 0, () => {
      const item: ConversationUiMessage = {
        id: 'a3',
        role: 'assistant',
        text: '',
        status: 'failed',
        error: 'Model request failed'
      };
      expect(ConversationMessageRenderPolicy.shouldRender(item)).assertTrue();
    });
  });

  describe('Extracted chat presentation policies', () => {
    it('classifies tool behavior and projects question payloads without the component', 0, () => {
      const question = toolStatus('question-1', 'AskUserQuestion', 'running');
      question.input_preview = '{"questions":[{"header":"Scope","question":"Which files?"}]}';
      expect(ToolStatusPresentationPolicy.isQuestion(question)).assertTrue();
      expect(ToolStatusPresentationPolicy.questionPromptFromJson(question.input_preview)).assertEqual('Which files?');
      expect(ToolStatusPresentationPolicy.isFileMutation(toolStatus('edit-1', 'ApplyPatch', 'done'))).assertTrue();
      expect(ToolStatusPresentationPolicy.isCommand(toolStatus('exec-1', 'ExecCommand', 'running'))).assertTrue();
    });

    it('groups adjacent reasoning and completed tools in transcript order', 0, () => {
      const groups = ChatMessageStructurePolicy.structuredGroups([
        { type: 'thinking', content: 'Inspect the architecture' },
        { type: 'tool', tool: toolStatus('read-1', 'Read', 'completed') },
        { type: 'text', content: 'The result' }
      ], 'item', false, 'done');
      expect(groups.length).assertEqual(2);
      expect(groups[0].type).assertEqual('activity_group');
      expect(ChatMessageStructurePolicy.activityGroupTools(groups[0]).length).assertEqual(1);
      expect(groups[1].type).assertEqual('item');
    });

    it('routes Task tools through the subagent item renderer instead of the generic tool list', 0, () => {
      const task = toolStatus('task-1', 'Task', 'running');
      task.input_preview = '{"description":"Read the README introduction"}';
      const groups = ChatMessageStructurePolicy.structuredGroups([
        { type: 'tool', tool: task, content: 'Running task' }
      ], 'item', true, 'active');
      expect(groups.length).assertEqual(1);
      expect(groups[0].type).assertEqual('item');
      expect(groups[0].items.length).assertEqual(1);
      expect(groups[0].tools.length).assertEqual(0);
      expect(ChatMessageStructurePolicy.subagentTitle(groups[0].items[0]))
        .assertEqual('Read the README introduction');
    });

    it('nests marked subagent execution inside its Task while preserving interleaved parent tools', 0, () => {
      const task = toolStatus('task-1', 'Task', 'running');
      const internalRead = toolStatus('read-1', 'Read', 'running');
      const directRead = toolStatus('read-parent', 'Read', 'completed');
      const groups = ChatMessageStructurePolicy.structuredGroups([
        { type: 'tool', tool: task },
        { type: 'tool', tool: directRead },
        { type: 'thinking', content: 'Inspect child files', is_subagent: true },
        { type: 'tool', tool: internalRead, is_subagent: true }
      ], 'item', true, 'active');
      expect(groups.length).assertEqual(2);
      expect(groups[0].items.length).assertEqual(1);
      expect(groups[0].items[0].tool?.name || '').assertEqual('Task');
      expect(groups[0].items[0].subItems?.length || 0).assertEqual(2);
      expect(groups[1].tools.length).assertEqual(1);
      expect(groups[1].tools[0].id).assertEqual('read-parent');
    });

    it('scopes legacy unmarked process output only while a Task is running', 0, () => {
      const runningTask = toolStatus('task-running', 'Task', 'running');
      const childRead = toolStatus('child-read', 'Read', 'running');
      const scoped = ChatMessageStructurePolicy.scopeSubagentItems([
        { type: 'tool', tool: runningTask },
        { type: 'thinking', content: 'Legacy child thinking' },
        { type: 'tool', tool: childRead }
      ]);
      expect(scoped.length).assertEqual(1);
      expect(scoped[0].subItems?.length || 0).assertEqual(2);

      const completedTask = toolStatus('task-done', 'Task', 'completed');
      const parentOutput = ChatMessageStructurePolicy.scopeSubagentItems([
        { type: 'tool', tool: completedTask },
        { type: 'thinking', content: 'Parent resumes' }
      ]);
      expect(parentOutput.length).assertEqual(2);
      expect(parentOutput[0].subItems?.length || 0).assertEqual(0);
    });

    it('keeps one plain assistant text item on the lightweight markdown path', 0, () => {
      expect(ChatMessageStructurePolicy.requiresStructuredRendering([
        { type: 'text', content: 'Hello' }
      ])).assertFalse();
      expect(ChatMessageStructurePolicy.requiresStructuredRendering([
        { type: 'text', content: 'Streaming', subItems: [] }
      ])).assertFalse();
      expect(ChatMessageStructurePolicy.requiresStructuredRendering([
        { type: 'thinking', content: 'Inspect' },
        { type: 'text', content: 'Done' }
      ])).assertTrue();
    });

    it('renders steering as a stable inline user entry instead of assistant text', 0, () => {
      const steering: ConversationUiMessageItem = {
        type: 'user-steering',
        steering_id: 'steering-1',
        content: 'Use the second approach'
      };
      expect(ChatMessageStructurePolicy.isUserSteeringEntry(steering)).assertTrue();
      expect(ChatMessageStructurePolicy.isTextEntry(steering)).assertFalse();
      expect(ChatMessageStructurePolicy.requiresStructuredRendering([steering])).assertTrue();
      expect(ChatMessageStructurePolicy.structuredItemKey(steering, 'item-1'))
        .assertEqual('item-1-steering-steering-1');
    });

    it('peels a trailing composite reply onto a stable streaming markdown leaf', 0, () => {
      const items: ConversationUiMessageItem[] = [
        { type: 'thinking', content: 'Inspect' },
        { type: 'tool', tool: toolStatus('read-1', 'Read', 'completed') },
        { type: 'text', content: 'Growing answer' }
      ];
      const processItems = ChatMessageStructurePolicy.withoutTrailingTopLevelText(items);
      expect(processItems.length).assertEqual(2);
      expect(ChatMessageStructurePolicy.trailingTopLevelText(items)).assertEqual('Growing answer');

      const toolAfterText: ConversationUiMessageItem[] = [
        { type: 'text', content: 'Intermediate note' },
        { type: 'tool', tool: toolStatus('write-1', 'Write', 'running') }
      ];
      expect(ChatMessageStructurePolicy.trailingTopLevelText(toolAfterText)).assertEqual('');
      expect(ChatMessageStructurePolicy.withoutTrailingTopLevelText(toolAfterText).length).assertEqual(2);
    });

    it('invalidates structured rendering when tool topology changes without keying growing reply text', 0, () => {
      const first: ConversationUiMessageItem[] = [
        { type: 'thinking', content: 'Inspect' },
        { type: 'tool', tool: toolStatus('skill-1', 'Skill', 'running') }
      ];
      const moreTools: ConversationUiMessageItem[] = [
        { type: 'thinking', content: 'Inspect' },
        { type: 'tool', tool: toolStatus('skill-1', 'Skill', 'completed') },
        { type: 'tool', tool: toolStatus('read-1', 'Read', 'running') }
      ];
      const firstKey = ChatMessageStructurePolicy.structuredRenderKey(first, 'item', true, 'active');
      const moreToolsKey = ChatMessageStructurePolicy.structuredRenderKey(moreTools, 'item', true, 'active');
      expect(firstKey === moreToolsKey).assertFalse();

      const replyA = moreTools.concat([{ type: 'text', content: 'A' }]);
      const replyB = moreTools.concat([{ type: 'text', content: 'A growing answer' }]);
      const processA = ChatMessageStructurePolicy.withoutTrailingTopLevelText(replyA);
      const processB = ChatMessageStructurePolicy.withoutTrailingTopLevelText(replyB);
      expect(ChatMessageStructurePolicy.structuredRenderKey(processA, 'item', true, 'active'))
        .assertEqual(ChatMessageStructurePolicy.structuredRenderKey(processB, 'item', true, 'active'));
    });

    it('does not render a top-level tool twice when structured items already contain it', 0, () => {
      const covered = toolStatus('read-1', 'Read', 'completed');
      const extra = toolStatus('exec-1', 'ExecCommand', 'completed');
      const remaining = ChatMessageStructurePolicy.toolsNotCoveredByItems(
        [covered, extra],
        [{ type: 'tool', tool: covered }]
      );
      expect(remaining.length).assertEqual(1);
      expect(remaining[0].id).assertEqual('exec-1');
    });
  });

  describe('AssistantProcessLayoutPolicy', () => {
    it('does not pin thinking below tools or omit in-flow thinking while streaming', 0, () => {
      expect(AssistantProcessLayoutPolicy.pinsThinkingAfterTools()).assertFalse();
      expect(AssistantProcessLayoutPolicy.omitsInFlowThinkingWhileStreaming()).assertFalse();
    });

    it('keeps a live Task card below the thinking that produced it', 0, () => {
      const order = AssistantProcessLayoutPolicy.processBlockOrder(
        '先看现有会话结构',
        false,
        '',
        false,
        1
      );
      expect(order.length).assertEqual(2);
      expect(order[0]).assertEqual('thinking');
      expect(order[1]).assertEqual('tools');
    });

    it('keeps thinking above tools when assistant text has also started', 0, () => {
      const order = AssistantProcessLayoutPolicy.processBlockOrder(
        '先看现有会话结构',
        true,
        '已经开始改布局',
        false,
        1
      );
      expect(order[0]).assertEqual('thinking');
      expect(order[1]).assertEqual('tools');
      expect(order[2]).assertEqual('text');
    });

    it('renders activity-group thinking before folded read or search cards', 0, () => {
      const order = AssistantProcessLayoutPolicy.activityGroupBlockOrder(true, 2);
      expect(order.length).assertEqual(2);
      expect(order[0]).assertEqual('thinking');
      expect(order[1]).assertEqual('tools');
    });

    it('still renders completed thinking inside an activity group', 0, () => {
      expect(AssistantProcessLayoutPolicy.shouldRenderActivityThinking(true)).assertTrue();
      expect(AssistantProcessLayoutPolicy.shouldRenderActivityThinking(false)).assertFalse();
    });

    it('shows typing dots only when the live turn has no thinking or tools yet', 0, () => {
      const order = AssistantProcessLayoutPolicy.processBlockOrder('', false, '', true, 0);
      expect(order.length).assertEqual(1);
      expect(order[0]).assertEqual('typing');
    });

    it('keeps a tool-only activity group without inventing a thinking block', 0, () => {
      const order = AssistantProcessLayoutPolicy.activityGroupBlockOrder(false, 1);
      expect(order.length).assertEqual(1);
      expect(order[0]).assertEqual('tools');
    });
  });

  describe('ToolCollapsePolicy', () => {
    it('folds consecutive completed tools of any kind into one summary', 0, () => {
      const groups = ToolCollapsePolicy.collapsedGroups([
        toolStatus('1', 'Grep', 'completed'),
        toolStatus('2', 'ExecCommand', 'done'),
        toolStatus('3', 'Task', 'success')
      ]);
      expect(groups.length).assertEqual(1);
      expect(groups[0].type).assertEqual('summary');
      expect(groups[0].tools.length).assertEqual(3);
    });

    it('keeps a single completed tool as its own row', 0, () => {
      const groups = ToolCollapsePolicy.collapsedGroups([
        toolStatus('1', 'ExecCommand', 'completed')
      ]);
      expect(groups.length).assertEqual(1);
      expect(groups[0].type).assertEqual('tool');
    });

    it('keeps plan cards out of collapsed tool summaries', 0, () => {
      const planTool: ConversationUiToolStatus = {
        id: 'plan-1',
        name: 'Write',
        status: 'completed',
        input_preview: '{"file_path":"/repo/.openbitfun/plans/mobile.plan.md"}'
      };
      const groups = ToolCollapsePolicy.collapsedGroups([
        toolStatus('1', 'Read', 'completed'),
        planTool,
        toolStatus('2', 'Grep', 'completed')
      ]);
      expect(groups.length).assertEqual(3);
      expect(groups[1].tools[0].name).assertEqual('Write');
      expect(PlanToolPolicy.descriptor(planTool)?.file_path || '').assertEqual('/repo/.openbitfun/plans/mobile.plan.md');
      expect(PlanToolPolicy.canBuild(planTool)).assertTrue();
    });

    it('does not fold running, failed, or blocking tools into the summary', 0, () => {
      const groups = ToolCollapsePolicy.collapsedGroups([
        toolStatus('1', 'Grep', 'completed'),
        toolStatus('2', 'Read', 'completed'),
        toolStatus('3', 'ExecCommand', 'running'),
        toolStatus('4', 'AskUserQuestion', 'pending'),
        toolStatus('5', 'Write', 'failed')
      ]);
      expect(groups.length).assertEqual(4);
      expect(groups[0].type).assertEqual('summary');
      expect(groups[0].tools.length).assertEqual(2);
      expect(groups[1].type).assertEqual('tool');
      expect(groups[1].tools[0].name).assertEqual('ExecCommand');
      expect(groups[2].tools[0].name).assertEqual('AskUserQuestion');
      expect(groups[3].tools[0].name).assertEqual('Write');
    });

    it('presents subagent progress as a plain label without repeating it as body copy', 0, () => {
      const progress: ConversationUiMessageItem = {
        type: 'subagent',
        is_subagent: true,
        content: '**Planning exploration of AGENTS subcrates**'
      };
      expect(ChatMessageStructurePolicy.subagentTitle(progress))
        .assertEqual('Planning exploration of AGENTS subcrates');
      expect(ChatMessageStructurePolicy.subagentBody(progress)).assertEqual('');

      const task = toolStatus('task-2', 'Task', 'running');
      task.input_preview = '{"description":"Inspect workspace structure"}';
      const taskProgress: ConversationUiMessageItem = {
        type: 'tool',
        tool: task,
        content: 'Running “Inspect workspace structure”'
      };
      expect(ChatMessageStructurePolicy.subagentTitle(taskProgress)).assertEqual('Inspect workspace structure');
      expect(ChatMessageStructurePolicy.subagentBody(taskProgress)).assertEqual('');

      const structuredTask = toolStatus('task-3', 'Task', 'running');
      structuredTask.tool_input = JSON.parse('{"description":"Read the README first paragraph"}') as Object;
      expect(ToolStatusPresentationPolicy.taskTitle(structuredTask))
        .assertEqual('Read the README first paragraph');

      const codexTask = toolStatus('task-4', 'Task', 'running');
      codexTask.tool_input = JSON.parse(
        '{"task_name":"read_readme","message":"Read the first README paragraph."}'
      ) as Object;
      expect(ToolStatusPresentationPolicy.taskTitle(codexTask))
        .assertEqual('Read the first README paragraph.');
    });

    it('keeps the summary row and lists members when the group is expanded', 0, () => {
      const groups = ToolCollapsePolicy.expandedGroups([
        toolStatus('1', 'Grep', 'completed'),
        toolStatus('2', 'ExecCommand', 'completed')
      ]);
      expect(groups.length).assertEqual(3);
      expect(groups[0].type).assertEqual('summary');
      expect(groups[1].type).assertEqual('tool');
      expect(groups[2].type).assertEqual('tool');
    });
  });

  describe('ChatComposerPolicy add button', () => {
    it('hides the add control unless attachments are supported', 0, () => {
      expect(ChatComposerPolicy.shouldShowAddButton(true, false)).assertFalse();
      expect(ChatComposerPolicy.shouldShowAddButton(false, true)).assertFalse();
      expect(ChatComposerPolicy.shouldShowAddButton(true, true)).assertTrue();
    });

    it('lets local chat pick images because the composer can honour attachments', 0, () => {
      expect(GENERAL_CHAT_COMPOSER_CAPABILITIES.surface).assertEqual(ChatSurface.General);
      expect(GENERAL_CHAT_COMPOSER_CAPABILITIES.supportsAttachments).assertTrue();
      expect(GENERAL_CHAT_COMPOSER_CAPABILITIES.showAddButton).assertTrue();
      expect(ChatComposerPolicy.shouldShowAddButton(
        GENERAL_CHAT_COMPOSER_CAPABILITIES.showAddButton,
        GENERAL_CHAT_COMPOSER_CAPABILITIES.supportsAttachments
      )).assertTrue();
      expect(REMOTE_CHAT_COMPOSER_CAPABILITIES.showAddButton).assertTrue();
      expect(REMOTE_CHAT_COMPOSER_CAPABILITIES.supportsAttachments).assertTrue();
    });

    it('keeps voice reachable beside Send once a draft has content', 0, () => {
      expect(ChatComposerPolicy.shouldShowSupplementalVoice('继续补充', 0, false, true)).assertTrue();
      expect(ChatComposerPolicy.shouldShowSupplementalVoice('', 1, false, true)).assertTrue();
      expect(ChatComposerPolicy.shouldShowSupplementalVoice('', 0, false, true)).assertFalse();
      expect(ChatComposerPolicy.shouldShowSupplementalVoice('继续补充', 0, true, true)).assertFalse();
      expect(ChatComposerPolicy.shouldShowSupplementalVoice('继续补充', 0, false, false)).assertFalse();
      expect(ChatComposerPolicy.canUseSupplementalVoice(false)).assertTrue();
      expect(ChatComposerPolicy.canUseSupplementalVoice(true)).assertFalse();
    });

    it('keeps the composer expanded while model selection returns to the active edit', 0, () => {
      expect(ChatComposerPolicy.isExpanded('', false, false, true)).assertTrue();
      expect(ChatComposerPolicy.isExpanded('', false, false, false)).assertFalse();
      expect(ChatComposerPolicy.isExpanded('', false, true, false)).assertTrue();
    });

    it('names the primary composer action for assistive labels', 0, () => {
      expect(ChatComposerPolicy.primaryActionAccessibilityKey(ComposerPrimaryAction.Send, false))
        .assertEqual('chat.send');
      expect(ChatComposerPolicy.primaryActionAccessibilityKey(ComposerPrimaryAction.Stop, false))
        .assertEqual('chat.stop');
      expect(ChatComposerPolicy.primaryActionAccessibilityKey(ComposerPrimaryAction.Stop, true))
        .assertEqual('chat.stopListening');
      expect(ChatComposerPolicy.primaryActionAccessibilityKey(ComposerPrimaryAction.Voice, false))
        .assertEqual('chat.voiceInput');
    });
  });

  describe('Conversation source naming', () => {
    it('keeps the remote chrome naming consistent', 0, () => {
      expect(RemoteI18n.t('remote.title')).assertEqual('远程');
      expect(RemoteI18n.t('connect.accountDevicesSubtitle')).assertEqual('远程');
      expect(RemoteI18n.t('chat.remoteSession')).assertEqual('远程会话');
    });

    it('names the sidebar by what things are, not by where they run', 0, () => {
      // The sidebar used to ask "local or remote" before it would show anything.
      // It now stacks a conversation timeline over account devices, so the
      // labels name those two kinds rather than an execution location, and the
      // local/remote pair the switcher needed is gone.
      expect(RemoteI18n.t('sidebar.conversations')).assertEqual('最近对话');
      expect(RemoteI18n.t('sidebar.devices')).assertEqual('设备');
      expect(RemoteI18n.t('sidebar.newChat')).assertEqual('聊天');
      expect(RemoteI18n.t('sidebar.connectDesktop')).assertEqual('连接电脑');
      expect(RemoteI18n.t('sidebar.scanToConnect')).assertEqual('扫码连接电脑');
      expect(RemoteI18n.t('sidebar.signInOpenBitFunAccount')).assertEqual('使用 GitHub 登录');
      expect(RemoteI18n.t('connect.chooseConnectionTitle')).assertEqual('连接电脑');
      expect(RemoteI18n.t('sidebar.local')).assertEqual('sidebar.local');
      expect(RemoteI18n.t('sidebar.code')).assertEqual('sidebar.code');
      expect(RemoteI18n.t('sidebar.recent')).assertEqual('sidebar.recent');
    });

    it('labels the workspace-header plus as adding an existing desktop workspace', 0, () => {
      // The phone still does not create a remote directory. The selected
      // device owns the picker, and choosing one of its directories adds that
      // existing workspace to the visible tree.
      expect(RemoteI18n.t('sidebar.addWorkspace')).assertEqual('添加工作区');
    });

    it('hides the redundant scan action after a QR connection succeeds', 0, () => {
      expect(SidebarConnectionActionPolicy.chatAction('normal', true)).assertEqual('choose-harness');
      expect(SidebarConnectionActionPolicy.chatAction('remote', true)).assertEqual('choose-harness');
      expect(SidebarConnectionActionPolicy.chatAction('normal', false)).assertEqual('code');
      expect(SidebarConnectionActionPolicy.chatAction('assistant', true)).assertEqual('assistant');
      expect(SidebarConnectionActionPolicy.chatAction('assistant', false)).assertEqual('assistant');
      expect(SidebarConnectionActionPolicy.canCreateSession('connected', false)).assertTrue();
      expect(SidebarConnectionActionPolicy.canCreateSession('connected', true)).assertFalse();
      expect(SidebarConnectionActionPolicy.canCreateSession('reconnecting', false)).assertFalse();
      expect(SidebarConnectionActionPolicy.canCreateSession('idle', false)).assertFalse();
      expect(SidebarConnectionActionPolicy.shouldShowScan('disconnected')).assertTrue();
      expect(SidebarConnectionActionPolicy.shouldShowScan('connected')).assertFalse();
    });

    it('uses the complete chat and settings shell for QR access without an account', 0, () => {
      expect(SidebarConnectionActionPolicy.shouldShowPrimaryNavigation('', 'room', 'connected')).assertTrue();
      expect(SidebarConnectionActionPolicy.shouldShowPrimaryNavigation('', 'room', 'disconnected')).assertTrue();
      expect(SidebarConnectionActionPolicy.shouldShowPrimaryNavigation('account-user', 'none', 'idle')).assertTrue();
      expect(SidebarConnectionActionPolicy.shouldShowPrimaryNavigation('', 'none', 'idle')).assertFalse();
    });

    it('merges matching QR targets and keeps unmatched QR targets beside account devices', 0, () => {
      expect(SidebarDeviceProjectionPolicy.shouldPrependControlTarget(
        [], 'room', 'desk-qr', true, false
      )).assertTrue();
      expect(SidebarDeviceProjectionPolicy.shouldPrependControlTarget(
        ['desk-qr'], 'room', 'desk-qr', true, false
      )).assertFalse();
      expect(SidebarDeviceProjectionPolicy.shouldPrependControlTarget(
        ['desk-account'], 'room', 'desk-qr', true, false
      )).assertTrue();
      expect(SidebarDeviceProjectionPolicy.shouldPrependControlTarget(
        ['desk-account'], 'none', '', false, false
      )).assertFalse();
    });

    it('does not keep leftover pending-copy keys that claim general chat is unavailable', 0, () => {
      expect(RemoteI18n.t('chatHome.generalPending')).assertEqual('chatHome.generalPending');
      expect(RemoteI18n.t('chatHome.generalAdvicePending')).assertEqual('chatHome.generalAdvicePending');
    });
  });

  describe('ConnectSheetLandingPolicy', () => {
    it('opens unsigned-in automatic entry on the explainer, not the camera', 0, () => {
      expect(ConnectSheetLandingPolicy.initialStep(CONNECT_INTENT_AUTO, false))
        .assertEqual(ConnectSheetStep.Intro);
      expect(ConnectSheetLandingPolicy.initialStep(CONNECT_INTENT_AUTO, true))
        .assertEqual(ConnectSheetStep.Account);
      expect(ConnectSheetLandingPolicy.initialStep(CONNECT_INTENT_SCAN, false))
        .assertEqual(ConnectSheetStep.Scan);
      expect(ConnectSheetLandingPolicy.initialStep(CONNECT_INTENT_SCAN, true))
        .assertEqual(ConnectSheetStep.Scan);
    });

    it('keeps the current pairing step while a URL is present or pairing is busy', 0, () => {
      expect(ConnectSheetLandingPolicy.visibleStep(ConnectSheetStep.Intro, false))
        .assertEqual(ConnectSheetStep.Intro);
      expect(ConnectSheetLandingPolicy.visibleStep(ConnectSheetStep.Scan, false))
        .assertEqual(ConnectSheetStep.Scan);
      expect(ConnectSheetLandingPolicy.visibleStep(ConnectSheetStep.Account, true))
        .assertEqual(ConnectSheetStep.Account);
      expect(ConnectSheetLandingPolicy.visibleStep(ConnectSheetStep.Account, false))
        .assertEqual(ConnectSheetStep.Intro);
    });

    it('maps a failed pair to the matching reconnect hint', 0, () => {
      expect(ConnectSheetStatusPolicy.failureHintKey('expired_room'))
        .assertEqual('connect.hintExpiredRoom');
      expect(ConnectSheetStatusPolicy.failureHintKey('network'))
        .assertEqual('connect.hintNetwork');
      expect(ConnectSheetStatusPolicy.isConnectError('failed', false, false, '', '失败', '', ''))
        .assertTrue();
      expect(ConnectSheetStatusPolicy.isConnectError('pairing', true, false, '', '失败', '', ''))
        .assertFalse();
    });
  });

  describe('RemoteSurfaceEntryPolicy', () => {
    it('treats switching to remote as navigation and keeps connect as an explicit action', 0, () => {
      expect(RemoteSurfaceEntryPolicy.shouldOpenConnectSheet(RemoteConnectEntryKind.EnterSurface))
        .assertFalse();
      expect(RemoteSurfaceEntryPolicy.shouldOpenConnectSheet(RemoteConnectEntryKind.OpenConnect))
        .assertTrue();
      expect(RemoteSurfaceEntryPolicy.shouldOpenConnectSheet(RemoteConnectEntryKind.OpenScan))
        .assertTrue();
    });
  });

  describe('AccountLoginErrorPolicy', () => {
    it('uses actionable copy for SDK transport failures', 0, () => {
      expect(AccountLoginErrorPolicy.messageKey({ code: 2300006 } as LoginFailureFixture)).assertEqual('account.errorNetwork');
      expect(AccountLoginErrorPolicy.messageKey({ code: 2300028 } as LoginFailureFixture)).assertEqual('account.errorTimeout');
      expect(AccountLoginErrorPolicy.messageKey({ code: 2300060 } as LoginFailureFixture)).assertEqual('account.errorSecureConnection');
      expect(AccountLoginErrorPolicy.messageKey({ statusCode: 429 } as LoginFailureFixture)).assertEqual('account.errorRateLimited');
    });
    it('does not expose unknown exception text or server bodies', 0, () => {
      expect(AccountLoginErrorPolicy.messageKey(new Error('raw SDK JSON')))
        .assertEqual('remote.settings.accountLoginFailed');
      expect(AccountLoginErrorPolicy.messageKey({ statusCode: 500 } as LoginFailureFixture))
        .assertEqual('remote.settings.accountLoginFailed');
    });
  });

  describe('RemoteCompactHomePolicy', () => {
    it('keeps the welcome entry without replacing a retained control target', 0, () => {
      expect(RemoteCompactHomePolicy.shouldShowWelcomeHome('none', 'idle')).assertTrue();
      expect(RemoteCompactHomePolicy.shouldShowWelcomeHome('none', 'idle', true)).assertFalse();
      expect(RemoteCompactHomePolicy.shouldShowWelcomeHome('none', 'failed', true)).assertFalse();
      expect(RemoteCompactHomePolicy.shouldShowWelcomeHome('none', 'disconnected')).assertTrue();
      expect(RemoteCompactHomePolicy.shouldShowWelcomeHome('none', 'failed')).assertTrue();
      expect(RemoteCompactHomePolicy.shouldShowWelcomeHome('none', 'pairing')).assertTrue();
      expect(RemoteCompactHomePolicy.shouldShowWelcomeHome('account_device', 'disconnected')).assertFalse();
      expect(RemoteCompactHomePolicy.shouldShowWelcomeHome('account_device', 'reconnecting')).assertFalse();
      expect(RemoteCompactHomePolicy.shouldShowWelcomeHome('account_device', 'connected')).assertFalse();
    });

    it('keeps pick-session chrome only while the desktop link is actually connected', 0, () => {
      expect(RemoteCompactHomePolicy.shouldShowConnectHome('connected')).assertFalse();
    });

    it('opens the connect home after the desktop drops even when cached sessions remain', 0, () => {
      expect(RemoteCompactHomePolicy.shouldShowConnectHome('reconnecting')).assertTrue();
      expect(RemoteCompactHomePolicy.shouldShowConnectHome('failed')).assertTrue();
      expect(RemoteCompactHomePolicy.shouldShowConnectHome('disconnected')).assertTrue();
      expect(RemoteCompactHomePolicy.shouldShowConnectHome('idle')).assertTrue();
      expect(RemoteCompactHomePolicy.headerSubtitle('reconnecting', 'Studio')).assertEqual('');
      expect(RemoteCompactHomePolicy.headerSubtitle('connected', 'Studio')).assertEqual('Studio');
    });
  });

  describe('AccountDeviceSelectionPolicy', () => {
    it('lets an online desktop be selected unless this phone is already switching', 0, () => {
      expect(AccountDeviceSelectionPolicy.canSelectOnline(true, 'desk-1', 'phone-1', '')).assertTrue();
      expect(AccountDeviceSelectionPolicy.canSelectOnline(false, 'desk-1', 'phone-1', '')).assertFalse();
      expect(AccountDeviceSelectionPolicy.canSelectOnline(true, 'phone-1', 'phone-1', '')).assertFalse();
      expect(AccountDeviceSelectionPolicy.canSelectOnline(true, 'desk-1', 'phone-1', 'desk-1')).assertFalse();
    });

    it('offers connect on device management for another online desktop or the last target after drop', 0, () => {
      expect(AccountDeviceSelectionPolicy.shouldShowConnectAction(true, 'desk-1', 'phone-1', 'desk-1', 'connected'))
        .assertFalse();
      expect(AccountDeviceSelectionPolicy.shouldShowConnectAction(true, 'desk-1', 'phone-1', 'desk-1', 'failed'))
        .assertTrue();
      expect(AccountDeviceSelectionPolicy.shouldShowConnectAction(true, 'desk-2', 'phone-1', 'desk-1', 'connected'))
        .assertTrue();
      expect(AccountDeviceSelectionPolicy.shouldShowConnectAction(false, 'desk-1', 'phone-1', 'desk-1', 'failed'))
        .assertTrue();
      expect(AccountDeviceSelectionPolicy.shouldShowConnectAction(false, 'desk-2', 'phone-1', 'desk-1', 'failed'))
        .assertFalse();
    });

    it('reconnects the last control target when it is no longer live', 0, () => {
      expect(AccountDeviceSelectionPolicy.shouldReconnectLastTarget('desk-1', 'desk-1', 'failed')).assertTrue();
      expect(AccountDeviceSelectionPolicy.shouldReconnectLastTarget('desk-1', 'desk-1', 'connected')).assertFalse();
      expect(AccountDeviceSelectionPolicy.shouldReconnectLastTarget('desk-2', 'desk-1', 'failed')).assertFalse();
    });
  });

  describe('ConversationHeaderPolicy', () => {
    it('keeps local chat on a single-line title and only shows actions once a timeline exists', 0, () => {
      const empty = ConversationHeaderPolicy.present(ChatSurface.General, '今日计划', '', '', false);
      expect(empty.fallbackKey).assertEqual('app.title');
      expect(empty.title).assertEqual('今日计划');
      expect(empty.subtitle).assertEqual('');
      expect(empty.allowRename).assertFalse();
      expect(empty.showActions).assertFalse();
      const withTimeline = ConversationHeaderPolicy.present(ChatSurface.General, '今日计划', '', '', true);
      expect(withTimeline.showActions).assertTrue();
    });

    it('gives remote chat a subtitle, rename, and a persistent overflow control', 0, () => {
      const named = ConversationHeaderPolicy.present(ChatSurface.Remote, '修登录', 'Studio', 'main', false);
      expect(named.fallbackKey).assertEqual('chat.remoteSession');
      expect(named.subtitle).assertEqual('Studio');
      expect(named.allowRename).assertTrue();
      expect(named.showActions).assertTrue();
      const branded = ConversationHeaderPolicy.present(ChatSurface.Remote, '', '', 'feat/ui', false);
      expect(branded.subtitle).assertEqual('OpenBitFun · feat/ui');
    });

  });

  describe('ModelServiceSettingsPolicy', () => {
    it('resolves the current model in selected / session / primary order', 0, () => {
      const catalog = modelServiceCatalog([
        cloudModel('cloud:a', 'alpha'),
        cloudModel('cloud:b', 'beta'),
        localModel('local-chat')
      ], 'cloud:b', 'cloud:a');
      expect(ModelServiceSettingsPolicy.currentModel(catalog, 'cloud:a')?.id).assertEqual('cloud:a');
      expect(ModelServiceSettingsPolicy.currentModel(catalog, '')?.id).assertEqual('cloud:b');
      expect(ModelServiceSettingsPolicy.currentModel({
        version: 1,
        models: catalog.models,
        default_models: { primary: 'cloud:a' }
      }, '')?.id).assertEqual('cloud:a');
      expect(ModelServiceSettingsPolicy.currentModel({
        version: 1,
        models: [],
        default_models: {}
      }, '') === undefined).assertTrue();
    });

    it('lists only enabled cloud account models and keeps source rows unselected', 0, () => {
      const catalog = modelServiceCatalog([
        cloudModel('cloud:a', 'alpha'),
        {
          id: 'cloud:off',
          name: 'off',
          provider: 'account',
          base_url: '',
          model_name: 'off',
          enabled: false,
          capabilities: []
        },
        localModel('local-chat')
      ], 'cloud:a', 'cloud:a');
      const accountModels = ModelServiceSettingsPolicy.accountModels(catalog);
      expect(accountModels.length).assertEqual(1);
      expect(accountModels[0].id).assertEqual('cloud:a');
      expect(ModelServiceSettingsPolicy.isAccountModelSelected(catalog, 'cloud:a')).assertTrue();
      expect(ModelServiceSettingsPolicy.isLocalModelSelected(catalog, 'cloud:a')).assertFalse();
      expect(ModelServiceSettingsPolicy.sourceRowShowsSelectionCheck()).assertFalse();
      expect(ModelServiceSettingsPolicy.localRowSelectsOnBodyTap(
        'https://api.example.com',
        'local-chat',
        true
      )).assertTrue();
      expect(ModelServiceSettingsPolicy.localRowSelectsOnBodyTap('', '', false)).assertFalse();
      expect(ModelServiceSettingsPolicy.modelLabel(undefined, 'fallback')).assertEqual('fallback');
      expect(ModelServiceSettingsPolicy.sheetPage('account')).assertEqual('account');
      expect(ModelServiceSettingsPolicy.sheetPage('unknown')).assertEqual('overview');
      expect(ModelServiceSettingsPolicy.parentSettingsPage('overview')).assertEqual('main');
      expect(ModelServiceSettingsPolicy.parentSettingsPage('language')).assertEqual('main');
      expect(ModelServiceSettingsPolicy.parentSettingsPage('account')).assertEqual('overview');
      expect(ModelServiceSettingsPolicy.parentSettingsPage('local')).assertEqual('overview');
    });

    it('sizes the overview, account list, editor, and language sheets from content', 0, () => {
      const overview = ModelServiceSettingsPolicy.overviewSheetHeight();
      expect(overview < 400).assertTrue();
      expect(overview > 300).assertTrue();
      expect(ModelServiceSettingsPolicy.accountListSheetHeight(0)).assertEqual(
        ModelServiceSettingsPolicy.HEADER_HEIGHT +
          ModelServiceSettingsPolicy.LIST_TOP_PADDING +
          ModelServiceSettingsPolicy.EMPTY_ACCOUNT_HEIGHT +
          ModelServiceSettingsPolicy.LIST_BOTTOM_PADDING
      );
      const three = ModelServiceSettingsPolicy.accountListContentHeight(3);
      const seven = ModelServiceSettingsPolicy.accountListContentHeight(7);
      const twelve = ModelServiceSettingsPolicy.accountListContentHeight(12);
      expect(three < seven).assertTrue();
      expect(twelve).assertEqual(seven);
      expect(ModelServiceSettingsPolicy.accountListSheetHeight(12))
        .assertEqual(ModelServiceSettingsPolicy.MAX_SHEET_HEIGHT);
      expect(ModelServiceSettingsPolicy.localEditorSheetHeight())
        .assertEqual(ModelServiceSettingsPolicy.LOCAL_EDITOR_HEIGHT);
      expect(ModelServiceSettingsPolicy.languageSheetHeight(2)).assertEqual(
        ModelServiceSettingsPolicy.HEADER_HEIGHT +
          ModelServiceSettingsPolicy.LANGUAGE_LIST_TOP_PADDING +
          2 * ModelServiceSettingsPolicy.LANGUAGE_ROW_HEIGHT +
          ModelServiceSettingsPolicy.LANGUAGE_LIST_BOTTOM_PADDING
      );
    });
  });
}

function cloudModel(id: string, modelName: string): RemoteModelConfig {
  return {
    id,
    name: modelName,
    provider: 'account',
    base_url: 'https://chat.example.com/v1',
    model_name: modelName,
    enabled: true,
    capabilities: ['text_chat']
  };
}

function localModel(modelName: string): RemoteModelConfig {
  return {
    id: GENERAL_CHAT_LOCAL_MODEL_ID,
    name: modelName,
    provider: 'local',
    base_url: 'https://localhost/v1',
    model_name: modelName,
    enabled: true,
    capabilities: ['text_chat']
  };
}

function modelServiceCatalog(
  models: RemoteModelConfig[],
  sessionModelId: string,
  primary: string
): RemoteModelCatalog {
  return {
    version: 1,
    models,
    default_models: { primary },
    session_model_id: sessionModelId
  };
}

function thinkingPart(beforeToolIndex: number, text: string): ActivityThinkingPart {
  return {
    beforeToolIndex,
    text,
    status: 'done',
    streaming: false,
    streamKey: `k-${beforeToolIndex}-${text}`
  };
}

function rowPlanTrace(rows: ActivityRowPlan[]): string {
  const parts: string[] = [];
  rows.forEach((row: ActivityRowPlan) => {
    parts.push(`${row.kind}${row.index}`);
  });
  return parts.join(' ');
}

function toolStatus(id: string, name: string, status: string): ConversationUiToolStatus {
  return {
    id,
    name,
    status
  };
}
