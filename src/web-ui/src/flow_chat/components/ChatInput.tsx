import { ChatInputImagePreview } from './ChatInputImagePreview';
/**
 * Standalone chat input component
 * Separated from bottom bar, supports session-level state awareness
 */

import React, { useRef, useCallback, useEffect, useReducer, useState, useMemo, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import path from 'path-browserify';
import { useTranslation } from 'react-i18next';
import { RotateCcw, Loader2, Play } from 'lucide-react';
import { ContextDropZone, useContextStore } from '../../shared/context-system';
import { useActiveSessionState } from '@/flow_chat/hooks';
import {
  RichTextInput,
  type ClipboardFilePaste,
  type ContextTriggerState,
  type InlineTriggerState,
  type RichTextInputElement,
} from './RichTextInput';
import { ChatContextPicker, type ContextPickerSkill } from './ChatContextPicker';
import { useChatMcpCatalog } from '../hooks/useChatMcpCatalog';
import type { ContextPickerMcpItem } from './chatMcpItems';
import { globalEventBus } from '@/infrastructure/event-bus';
import {
  useSessionDerivedState,
  useSessionStateMachine,
  useSessionStateMachineActions,
} from '../hooks/useSessionStateMachine';
import { SessionExecutionEvent, SessionExecutionState } from '../state-machine/types';
import { ModelSelector, type ModelSelectorAvailability } from './ModelSelector';
import { FlowChatStore } from '../store/FlowChatStore';
import { useAcpPlan } from '../hooks/useAcpPlan';
import { filterSlashCommands, useAcpSlashCommands } from '../hooks/useAcpSlashCommands';
import { acpSessionRef, acpSlashCommandText } from '../utils/acpSession';
import { AcpPlanPanel } from './AcpPlanPanel';
import type { FlowChatState, QueuedMessage } from '../types/flow-chat';
import type {
  ContextItem,
  DirectoryContext,
  FileContext,
  ImageContext,
  SessionReferenceContext,
} from '@/types/context.ts';
import { SmartRecommendations } from './smart-recommendations';
import { useCurrentWorkspace, useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { flowChatSessionConfigForCurrentWorkspace } from '@/app/utils/projectSessionWorkspace';
import { createImageContextFromFile, createImageContextFromClipboard } from '../utils/imageUtils';
import {
  getInlineSkillPickerQuery,
  getInlineSlashCommandPickerQuery,
  getSlashCommandPickerQuery,
  isSlashCommand,
  stripSlashCommand,
} from '../utils/slashCommand';
import {
  resolveSlashActionInputValue,
  type SlashActionId,
} from '../utils/slashActionSelection';
import { parseReloadCommand, supportsLocalReloadContext } from '../utils/reloadCommand';
import { reviewPromptCommandShell } from '../utils/promptCommandShellReview';
import { notificationService } from '@/shared/notification-system';
import { useI18n } from '@/infrastructure/i18n';
import { inputReducer, initialInputState, type InputAction } from '../reducers/inputReducer';
import { modeReducer, initialModeState } from '../reducers/modeReducer';
import { CHAT_INPUT_CONFIG } from '../constants/chatInputConfig';
import { useMessageSender } from '../hooks/useMessageSender';
import { useChatInputState } from '../store/chatInputStateStore';
import { useInputHistoryStore } from '../store/inputHistoryStore';
import {
  sessionComposerStore,
  type PendingLargePasteMap,
} from '../store/sessionComposerStore';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { useAssistantBootstrap } from '@/app/hooks/useAssistantBootstrap';
import {
  clearComposerForSubmission,
  failedSubmissionRecoveryTarget,
  shouldRecordContextMutation,
  successfulRetryCleanupTarget,
} from './chatInputDraftRecovery';
import { startBtwThread } from '../services/BtwThreadService';
import { buildImagePayload } from '../utils/imagePayload';
import {
  canRestoreQueuedMessageToComposer,
  getQueuedMessageComposerDraft,
} from '../utils/pendingQueueDraft';
import { isGoalSlashCommand, parseGoalCommand } from '../services/goalService';
import {
  getHistorySessionOpenTransitionSnapshot,
  subscribeHistorySessionOpenTransition,
} from '../services/sessionOpenIntent';
import { useThreadGoalController } from '../hooks/useThreadGoalController';
import { useWorkspaceModeCatalog } from '../hooks/useWorkspaceModeCatalog';
import { useSessionModeSelection } from '../hooks/useSessionModeSelection';
import { useComposerDefaultFocus } from '../hooks/useComposerDefaultFocus';
import { ThreadGoalDialogs } from './thread-goal/ThreadGoalDialogs';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import { FlowChatManager } from '@/flow_chat/services/FlowChatManager';
import { interruptedTurnRecoveryGate } from '@/flow_chat/services/interruptedTurnRecoveryGate';
import {
  getDeepReviewLaunchErrorMessage,
} from '../services/DeepReviewService';
import {
  launchPreparedReviewSession,
  prepareReviewLaunchFromSlashCommand,
} from '../services/ReviewService';
import { isReviewSlashCommand } from '../deep-review/launch/commandParser';
import { createLogger } from '@/shared/utils/logger';
import { isSamePath } from '@/shared/utils/pathUtils';
import {
  isSessionWorktreeIsolationEnabled,
  isSessionWorktreeBindingLocked,
} from '../utils/sessionWorktree';
import { chatInputSessionSubscriptionKey } from '../utils/chatInputSessionSubscription';
import { isRemoteWorkspaceSession, sessionProjectWorkspacePath } from '../utils/sessionWorkspace';
import { findWorkspaceForSession } from '../utils/workspaceScope';
import { isTauriRuntime, isWindowsDesktopRuntime } from '@/infrastructure/runtime';
import { OverflowText, Tooltip } from '@openbitfun/ui';
import { useShortcut } from '@/infrastructure/hooks/useShortcut';
import { confirmDanger, confirmWarning } from '@/infrastructure/confirm-dialog';
import { PendingQueuePanel } from './PendingQueuePanel';
import { useAgentCanvasStore } from '@/app/components/panels/content-canvas/stores';
import { openBtwSessionInAuxPane, selectActiveBtwSessionTab } from '../services/btwSessionPane';
import { resolveSessionRelationship } from '../utils/sessionMetadata';
import { isProjectedSessionEmpty } from '../utils/flowChatTurnIdentity';
import {
  canSwitchSessionMainAgent,
  isChatInputActionVisibleForTarget,
  resolveAvailableChatInputMode,
  resolveChatInputCanUseSkills,
  resolveChatInputCanUseMcp,
  resolveChatInputMainAgentModes,
  resolveChatInputSendAgentType,
  resolveChatInputModePolicy,
  isPrimarySlashActionVisible,
  resolveSessionAssistantWorkspace,
  hasCompleteThreadGoalTools,
} from '../utils/chatInputMode';
import {
  chatInputModePreferenceService,
  resolveConfiguredChatInputDefaultModeId,
} from '../services/ChatInputModePreferenceService';
import {
  resolveComposerExecutionLevelSelection,
  resolveChatInputExecutionLevelPolicy,
  resolveSelectedComposerExecutionLevel,
} from '../utils/chatInputExecutionLevelPolicy';
import { collectModifiedFilePathsFromTurns } from '../utils/modifiedFilePaths';
import { useSceneStore } from '@/app/stores/sceneStore';
import { useSettingsStore } from '@/app/scenes/settings/settingsStore';
import type { SceneTabId } from '@/app/components/SceneBar/types';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import {
  configManager,
  DEFAULT_TOOL_PERMISSION_CONFIG,
  normalizeToolPermissionConfig,
  permissionConfigService,
} from '@/infrastructure/config';
import { useComputerUseEnabled } from '@/infrastructure/config/hooks/useComputerUseEnabled';
import type { ToolPermissionConfig } from '@/infrastructure/config/types';
import { useResolvedModeSkills } from '../hooks/useResolvedModeSkills';
import { SubagentAPI, type SubagentInfo } from '@/infrastructure/api/service-api/SubagentAPI';
import MCPAPI, { type MCPPrompt, type MCPPromptMessage, type MCPServerInfo } from '@/infrastructure/api/service-api/MCPAPI';
import {
  ChatInputWorkspaceStrip,
  type ChatInputPermissionMode,
} from './ChatInputWorkspaceStrip';
import {
  HarnessProfileSelector,
  type HarnessAgentOption,
  type HarnessNewSessionSelection,
  type SelectableHarnessProfileId,
} from './HarnessProfileSelector';
import { ChatInputApprovalBand } from './ChatInputApprovalBand';
import { ChatInputBoostSubmenu } from './ChatInputBoostSubmenu';
import { scrollSelectedSlashCommandIntoView } from './slashCommandSelectionVisibility';
import { usePermissionRequests } from './modern/usePermissionRequests';
import type { DispatchSelection, DispatchTarget } from '@/features/dispatch/types';
import { isNonLocalDispatchTarget } from '@/features/dispatch/types';
import {
  DISPATCH_PERMISSION_MODES,
  dispatchApprovalPolicyFromPermissionMode,
  permissionModeFromDispatchApprovalPolicy,
} from '@/features/dispatch/approvalPolicy';
import { dispatchJobStore } from '@/features/dispatch/dispatchJobStore';
import { useComposerCapabilities } from '../session-drivers/useComposerCapabilities';
import { ComposerVoiceInputButton } from './voice/ComposerVoiceInputButton';
import { useRealtimeVoiceCallActive } from './voice/RealtimeVoiceCallContext';
import { useComposerVoiceInput } from './voice/useComposerVoiceInput';
import { expandWidgetPromptReferenceTokens } from '@/tools/generative-widget/widgetPromptReference';
import {
  expandAdditionalModePromptReferenceTokens,
} from '../utils/additionalModePromptReference';
import {
  composerPresentationContexts,
  composerPresentationToEditorText,
  composerPresentationToModelText,
  hasComposerPresentationReferences,
  parseComposerPresentation,
  type ComposerPresentation,
} from '../utils/composerPresentation';
import {
  createSkillPromptReferenceToken,
  isSkillAvailableForUserInvocation,
  isSlashAddressableSkillName,
  replaceLeadingSlashCommandWithSkillToken,
} from '../utils/skillPromptReference';
import { resolveChatInputQuickSkillShortcuts } from '../utils/chatInputQuickSkills';
import { useDeepReviewConsent } from './DeepReviewConsentDialog';
import { useSessionReviewActivity } from '../hooks/useSessionReviewActivity';
import { shouldBlockReviewCommand } from '../utils/deepReviewCommandGuard';
import { deriveDeepReviewSessionConcurrencyGuard } from '../utils/deepReviewCapacityGuard';
import { acpAgentTypeFromSession } from '../utils/acpSession';
import {
  getSessionContextUsageDisplay,
  type ContextUsageDisplay,
} from '../utils/tokenUsageDisplay';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import type { SessionPermissionMode } from '@/infrastructure/api/service-api/AgentAPI';
import { isPeerDeviceModeActive } from '@/infrastructure/peer-device/peerModeFlag';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import { useLocalFileDrop } from '@/infrastructure/files/useLocalFileDrop';
import { resolveBrowserDroppedFilePaths } from '@/infrastructure/files/resolveBrowserDroppedFilePaths';
import {
  buildExternalFileContexts,
  partitionExternalDropFiles,
  resolveExternalFileIntakeAvailability,
  type ExternalFileSource,
} from '../utils/externalFileIntake';
import { selectInterruptedTurnRecovery } from '../utils/interruptedTurnRecovery';
import {
  chatInputPermissionMode,
  permissionModeFromConfig,
  sessionPermissionMode as toBackendPermissionMode,
} from '../utils/permissionMode';
import {
  ExternalSourceApiError,
  externalSourcesAPI,
  type NativePromptCommandDescriptor,
} from '@/infrastructure/api/service-api/ExternalSourcesAPI';
import { externalSourceDiscoveryPollDelay } from '@/infrastructure/api/service-api/externalSourceDiscovery';
import {
  buildExternalPromptCommandItems,
  classifyExternalPromptCommandCatalogIssue,
  externalPromptComposerIsUnchanged,
  isExternalPromptSubmissionTargetCurrent,
  routeUnmatchedExternalPromptCommand,
  resolveExternalPromptCommandInvocation,
  type ExternalPromptCommandCatalogIssue,
  type ExternalPromptCommandItem,
} from '../utils/externalPromptCommands';
import {
  submitThroughChatInputRegistration,
  type ChatInputRegistration,
} from './chatInputRegistration';
import './ChatInput.scss';

import {
  isChatPopupActive,
  setChatPopupActive,
  subscribeChatPopupChange,
} from './chatPopupState';
import {
  resolveChatInputTargetSessionId,
  type ChatInputTarget,
} from '../utils/chatInputTarget';
import { Menu, MenuItem, MenuSeparator, Icon } from '@openbitfun/ui';
import {
  ChatComposer,
  ChatComposerActionButton,
  ChatComposerContent,
  ChatComposerEndActions,
  ChatComposerStartActions,
} from '@openbitfun/ui/flow-chat';

const log = createLogger('ChatInput');

export interface ChatInputProps {
  className?: string;
  isSceneActive?: boolean;
  /** The host conversation area that accepts files for this composer. */
  fileDropTargetRef?: React.RefObject<HTMLElement | null>;
  onFileDragOverChange?: (isOver: boolean) => void;
  /**
   * Optional content and transport registration for hosts that embed the
   * standard composer. The registration never replaces ChatInput's UI.
   */
  registration?: ChatInputRegistration;
}

interface ChatInputAdditionalModeItem {
  id: string;
  label: string;
  title: string;
  skillName: string;
}

type SlashActionItem = {
  kind: 'action';
  id: SlashActionId;
  command: string;
  label: string;
};

type SlashMcpPromptItem = {
  kind: 'mcpPrompt';
  id: string;
  command: string;
  label: string;
  serverId: string;
  serverName: string;
  promptName: string;
  description?: string;
  arguments: Array<{
    name: string;
    required: boolean;
    description?: string;
  }>;
};

type SlashAcpCommandItem = {
  kind: 'acpCommand';
  id: string;
  command: string;
  label: string;
};

type SlashSkillItem = {
  kind: 'skill';
  id: string;
  command: string;
  label: string;
  skillName: string;
};

type SlashExternalPromptCommandItem = ExternalPromptCommandItem & {
  kind: 'externalCommand';
};

function toSlashExternalPromptCommands(
  snapshot: Parameters<typeof buildExternalPromptCommandItems>[0],
): SlashExternalPromptCommandItem[] {
  return buildExternalPromptCommandItems(snapshot).map(item => ({
    ...item,
    kind: 'externalCommand' as const,
  }));
}

type SlashPickerItem =
  | SlashActionItem
  | SlashMcpPromptItem
  | SlashAcpCommandItem
  | SlashSkillItem
  | SlashExternalPromptCommandItem;
function nativePromptCommandCandidateId(
  kind: Exclude<SlashPickerItem['kind'], 'externalCommand'>,
  id: string,
): string {
  return `openbitfun.desktop:${kind}:${id}`;
}

function toNativePromptCommandDescriptor(
  item: Exclude<SlashPickerItem, SlashExternalPromptCommandItem>,
): NativePromptCommandDescriptor {
  const command = item.command;
  const commandName = command.slice(1).split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  const behaviorVersion = item.kind === 'mcpPrompt'
    ? JSON.stringify({
        kind: item.kind,
        serverId: item.serverId,
        promptName: item.promptName,
        arguments: item.arguments.map(argument => ({
          name: argument.name,
          required: argument.required,
        })),
      })
    : JSON.stringify(item.kind === 'skill'
        ? { kind: item.kind, id: item.id, skillName: item.skillName }
        : { kind: item.kind, id: item.id, command });
  return {
    commandName,
    candidateId: nativePromptCommandCandidateId(item.kind, item.id),
    behaviorVersion,
  };
}

function getCharacterCount(text: string): number {
  return Array.from(text).length;
}

function buildMcpPromptSlashCommand(serverId: string, promptName: string): string {
  return `/${serverId}:${promptName}`;
}

function parseSlashArguments(input: string): string[] {
  const matches = input.match(/"([^"]*)"|'([^']*)'|[^\s]+/g) || [];
  return matches.map(token => {
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith('\'') && token.endsWith('\''))
    ) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function renderMcpPromptContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!content || typeof content !== 'object') {
    return '[Unsupported MCP prompt content]';
  }

  const block = content as Record<string, unknown>;
  const type = typeof block.type === 'string' ? block.type : undefined;

  if (type === 'text' && typeof block.text === 'string') {
    return block.text;
  }

  if (type === 'image') {
    return `[Image${typeof block.mimeType === 'string' ? `: ${block.mimeType}` : ''}]`;
  }

  if (type === 'audio') {
    return `[Audio${typeof block.mimeType === 'string' ? `: ${block.mimeType}` : ''}]`;
  }

  if (type === 'resource_link') {
    const uri = typeof block.uri === 'string' ? block.uri : 'unknown';
    const name = typeof block.name === 'string' ? block.name : undefined;
    return name ? `[Resource Link: ${name} (${uri})]` : `[Resource Link: ${uri}]`;
  }

  if (type === 'resource' && block.resource && typeof block.resource === 'object') {
    const resource = block.resource as Record<string, unknown>;
    const resourceText =
      typeof resource.text === 'string'
        ? resource.text
        : typeof resource.content === 'string'
          ? resource.content
          : undefined;
    if (resourceText) {
      return resourceText;
    }
    const uri = typeof resource.uri === 'string' ? resource.uri : 'unknown';
    return `[Resource: ${uri}]`;
  }

  return '[Unsupported MCP prompt content]';
}

function renderMcpPromptMessages(messages: MCPPromptMessage[]): string {
  return messages
    .map(message => {
      const text = renderMcpPromptContent(message.content).trim();
      if (!text) {
        return '';
      }

      switch (message.role) {
        case 'system':
          return text;
        case 'user':
          return `User: ${text}`;
        case 'assistant':
          return `Assistant: ${text}`;
        default:
          return `${message.role}: ${text}`;
      }
    })
    .filter(Boolean)
    .join('\n\n');
}

type BoostSubmenuId = 'harness' | 'additional-modes' | 'skills';

interface ExternalFileIntakeRequest {
  availability: ReturnType<typeof resolveExternalFileIntakeAvailability>;
  sessionId: string | null;
  surfaceEpoch: number;
  targetKey: string;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  className = '',
  isSceneActive = true,
  fileDropTargetRef,
  onFileDragOverChange,
  registration,
}) => {
  const deviceSurfaceScope = getActiveSurfaceScope();
  const { t } = useTranslation('flow-chat');
  const { t: tWorktrees } = useI18n('worktrees');
  const canLaunchReview = isTauriRuntime();
  
  const [inputState, dispatchLocalInput] = useReducer(inputReducer, initialInputState);
  const [modeState, dispatchMode] = useReducer(modeReducer, initialModeState);
  const [activeBoostSubmenu, setActiveBoostSubmenu] = useState<BoostSubmenuId | null>(null);
  const setBoostSubmenuOpen = useCallback((id: BoostSubmenuId, open: boolean) => {
    // A late dismissal from one flyout must not close its newly opened sibling.
    setActiveBoostSubmenu(current => open ? id : current === id ? null : current);
  }, []);

  useEffect(() => {
    if (!modeState.dropdownOpen) setActiveBoostSubmenu(null);
  }, [modeState.dropdownOpen]);
  
  const richTextInputRef = useRef<RichTextInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const externalFileDropTargetRef = useRef<HTMLDivElement>(null);
  const [nativeFileDragOver, setNativeFileDragOver] = useState(false);
  const [contextFileDragOver, setContextFileDragOver] = useState(false);
  const inputAreaAnchorRef = useRef<HTMLDivElement>(null);
  const agentBoostRef = useRef<HTMLDivElement>(null);
  const boostTriggerRef = useRef<HTMLSpanElement>(null);
  const boostMenuRef = useRef<HTMLDivElement>(null);
  const slashCommandPickerRef = useRef<HTMLDivElement>(null);
  const isImeComposingRef = useRef(false);
  // Ref so the queuedInput sync effect can read the latest value without it being a dep
  const inputValueRef = useRef('');
  const pendingLargePastesRef = useRef<PendingLargePasteMap>({});
  const [pendingLargePastes, setPendingLargePastes] = useState<PendingLargePasteMap>({});
  const externalFileIntakeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const externalFileIntakeTargetKeyRef = useRef('');
  const chatInputMountedRef = useRef(false);
  const composerMutationRevisionsRef = useRef(new Map<string, number>());
  const isRestoringSessionDraftRef = useRef(false);
  const sessionConflictRetryBaselinesRef = useRef(new Map<string, number>());
  const reviewLaunchPendingRef = useRef(false);
  const largePasteCountersRef = useRef<Record<number, number>>({});
  const undoImageStackRef = useRef<string[]>([]);

  useEffect(() => {
    chatInputMountedRef.current = true;
    return () => {
      chatInputMountedRef.current = false;
    };
  }, []);
  
  // History navigation state
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [savedDraft, setSavedDraft] = useState('');
  const [inputTarget, setInputTarget] = useState<ChatInputTarget>('main');
  const [toolPermissionConfig, setToolPermissionConfig] = useState<ToolPermissionConfig>(
    DEFAULT_TOOL_PERMISSION_CONFIG,
  );
  const [permissionModeSaving, setPermissionModeSaving] = useState(false);
  const realtimeVoiceCallActive = useRealtimeVoiceCallActive();
  const [showPermissionModeControl, setShowPermissionModeControl] = useState(true);
  // The session's own selection. `null` means it follows the global default,
  // which is what keeps switching modes in one conversation from moving every
  // other open session.
  const [sessionPermissionMode, setSessionPermissionMode] =
    useState<SessionPermissionMode | null>(null);
  // One-off state has two owners: the idle composer arms a future submission,
  // while an executing turn keeps a mutable override until it ends.
  const [armedTurnPermissionMode, setArmedTurnPermissionMode] =
    useState<SessionPermissionMode | null>(null);
  const [activeTurnPermissionMode, setActiveTurnPermissionMode] =
    useState<SessionPermissionMode | null>(null);
  const [isHarnessSessionCreating, setIsHarnessSessionCreating] = useState(false);
  const permissionModeRequestGenerationRef = useRef(0);
  const permissionModeLifecycleRef = useRef<{
    sessionId: string | null;
    activeTurnId: string | null;
  }>({ sessionId: null, activeTurnId: null });
  const { addMessage: addToHistory, getSessionHistory } = useInputHistoryStore();
  
  const contexts = useContextStore(state => state.contexts);
  const addContext = useContextStore(state => state.addContext);
  const removeContext = useContextStore(state => state.removeContext);
  const clearContexts = useContextStore(state => state.clearContexts);
  const replaceContexts = useContextStore(state => state.replaceContexts);

  const contextsRef = useRef(contexts);
  contextsRef.current = contexts;

  const imageContexts = useMemo(
    () => contexts.filter((c): c is ImageContext => c.type === 'image'),
    [contexts],
  );
  const currentImageCount = imageContexts.length;
  
  const activeSessionState = useActiveSessionState();
  const activeBtwSessionTab = useAgentCanvasStore(state => selectActiveBtwSessionTab(state as any));
  const [flowChatState, setFlowChatState] = useState<FlowChatState>(() => FlowChatStore.getInstance().getState());
  const currentSessionId = activeSessionState.sessionId;
  const currentSession = currentSessionId ? flowChatState.sessions.get(currentSessionId) : undefined;
  const activeBtwSessionData = activeBtwSessionTab?.content.data as
    | { childSessionId: string; parentSessionId: string; workspacePath?: string }
    | undefined;
  const activeBtwSessionId = activeBtwSessionData?.parentSessionId === currentSessionId
    ? activeBtwSessionData.childSessionId
    : undefined;
  const effectiveTargetSessionId = resolveChatInputTargetSessionId({
    currentSessionId,
    inputTarget,
    activeBtwSessionId,
  });
  const effectiveTargetSessionIdRef = useRef<string | null>(effectiveTargetSessionId);
  effectiveTargetSessionIdRef.current = effectiveTargetSessionId;

  const markComposerMutation = useCallback(() => {
    const sessionId = effectiveTargetSessionIdRef.current;
    if (!sessionId) return;
    const revisions = composerMutationRevisionsRef.current;
    revisions.set(sessionId, (revisions.get(sessionId) ?? 0) + 1);
  }, []);
  const composerMutationRevision = useCallback(
    (sessionId: string) => composerMutationRevisionsRef.current.get(sessionId) ?? 0,
    [],
  );

  useComposerDefaultFocus({
    editorRef: richTextInputRef,
    sessionId: effectiveTargetSessionId,
    isSceneActive,
  });

  const dispatchInput = useCallback((action: InputAction) => {
    const changesValue = (action.type === 'SET_VALUE' && action.payload !== inputValueRef.current)
      || (action.type === 'CLEAR_VALUE' && inputValueRef.current !== '');
    if (changesValue) {
      markComposerMutation();
    }
    dispatchLocalInput(action);

    const sessionId = effectiveTargetSessionIdRef.current;
    if (!sessionId) {
      return;
    }

    if (action.type === 'SET_VALUE') {
      inputValueRef.current = action.payload;
      sessionComposerStore.getState().setValue(sessionId, action.payload);
    } else if (action.type === 'CLEAR_VALUE') {
      inputValueRef.current = '';
      sessionComposerStore.getState().setValue(sessionId, '');
    }
  }, [markComposerMutation]);
  const effectiveTargetSession = effectiveTargetSessionId
    ? flowChatState.sessions.get(effectiveTargetSessionId)
    : undefined;
  const effectiveTargetSessionHasTurns = effectiveTargetSession
    ? !isProjectedSessionEmpty(effectiveTargetSession)
    : false;
  // A submission keeps the session started even if every surviving Turn is
  // later rolled back. Before that first submission, the composer intentionally
  // stays expanded instead of collapsing as the empty draft is measured.
  const effectiveTargetSessionStarted = effectiveTargetSessionHasTurns
    || Boolean(effectiveTargetSession?.lastSubmittedMode?.trim());
  const isNewSessionComposer = !effectiveTargetSessionStarted;
  const dispatchObserverJob = dispatchJobStore(state => {
    const jobId = effectiveTargetSession?.config.dispatchJobId;
    return jobId ? state.jobs[jobId] : undefined;
  });
  const effectiveTargetRelationship = resolveSessionRelationship(effectiveTargetSession);
  const isBtwSession = effectiveTargetRelationship.displayAsChild;
  const isSubagentInputTarget = effectiveTargetRelationship.isSubagent;
  const caps = useComposerCapabilities({
    sessionId: effectiveTargetSessionId,
    session: effectiveTargetSession,
    hostMasksDispatch: !!registration,
    displayAsChild: isBtwSession,
  });
  const historySessionOpenTransition = useSyncExternalStore(
    subscribeHistorySessionOpenTransition,
    getHistorySessionOpenTransitionSnapshot,
    getHistorySessionOpenTransitionSnapshot,
  );
  const acpSessionForInput = useMemo(
    () => acpSessionRef(effectiveTargetSession),
    [effectiveTargetSession],
  );
  const { commands: acpAgentCommands } = useAcpSlashCommands(acpSessionForInput);
  const isAcpInputSession = Boolean(acpSessionForInput);
  const reloadContextSupported = supportsLocalReloadContext({
    desktopRuntime: isTauriRuntime(),
    acpSession: isAcpInputSession,
    dispatchTransport: caps.dispatchTransport,
  });
  const canReloadContext = reloadContextSupported && Boolean(effectiveTargetSessionId);
  const { entries: acpPlanEntries } = useAcpPlan(acpSessionForInput?.sessionId ?? null);
  const currentSessionTitle = currentSession?.title?.trim() || t('session.untitled');
  const activeBtwSession = activeBtwSessionId
    ? flowChatState.sessions.get(activeBtwSessionId)
    : undefined;
  const activeBtwRelationship = resolveSessionRelationship(activeBtwSession);
  const showTargetSwitcher = !!activeBtwSessionId;
  const activeBtwKind =
    activeBtwRelationship.kind === 'review' ||
    activeBtwRelationship.kind === 'deep_review' ||
    activeBtwRelationship.kind === 'miniapp' ||
    activeBtwRelationship.kind === 'subagent'
    ? activeBtwRelationship.kind
    : 'btw';
  const activeBtwTargetLabel = t(`childSession.kinds.${activeBtwKind}.short`, {
    defaultValue: t('chatInput.targetBtw'),
  });
  const activeBtwSessionTitle = activeBtwSession
    ? activeBtwSession.title?.trim() || t(`childSession.kinds.${activeBtwKind}.title`, {
        defaultValue: t('btw.threadLabel'),
      })
    : '';

  const deferChatStripPassiveGitRefresh =
    historySessionOpenTransition !== null ||
    (
      effectiveTargetSession?.isHistorical === true &&
      effectiveTargetSession.contextRestoreState === 'pending'
    );
  
  // Memoize history so keyboard handlers don't see a fresh [] on every render.
  const inputHistory = useMemo(
    () => (effectiveTargetSessionId ? getSessionHistory(effectiveTargetSessionId) : []),
    [effectiveTargetSessionId, getSessionHistory],
  );
  const derivedState = useSessionDerivedState(
    effectiveTargetSessionId,
    inputState.value.trim()
  );
  const currentReviewActivity = useSessionReviewActivity(currentSessionId);
  // The primary composer owns only the active primary session's requests.
  // Direct child-session requests are answered in BtwSessionPanel, even while
  // this composer is targeting that child, so the same request never has two
  // actionable surfaces. Delegated requests remain owned by the parent.
  const {
    ownedActiveBatch: activePermissionBatch,
    ownedRequests: pendingPermissionRequests,
    respond: respondPermission,
    respondBatch: respondPermissionBatch,
  } = usePermissionRequests(currentSessionId || undefined);
  const sessionMachine = useSessionStateMachine(effectiveTargetSessionId);
  const activePermissionTurnId =
    sessionMachine?.currentState === SessionExecutionState.PROCESSING
      ? sessionMachine.context.currentDialogTurnId
      : null;
  const activePermissionTurnIdRef = useRef<string | null>(activePermissionTurnId);
  activePermissionTurnIdRef.current = activePermissionTurnId;
  const armedTurnPermissionModeRef = useRef<SessionPermissionMode | null>(
    armedTurnPermissionMode,
  );
  armedTurnPermissionModeRef.current = armedTurnPermissionMode;
  const { confirmDeepReviewLaunch, deepReviewConsentDialog } = useDeepReviewConsent();
  // New sessions start expanded. Once the first Turn has been submitted, this
  // returns to content-driven measurement (newlines, attachments, or wrapping).
  const [isMultiLine, setIsMultiLine] = useState(isNewSessionComposer);
  // showPlaceholder is true when the editor DOM is truly empty (value empty AND no residual <br>)
  const [showPlaceholder, setShowPlaceholder] = useState(true);
  const liveCapsuleInputWidthRef = useRef<number | null>(null);
  const lockedCapsuleInputWidthRef = useRef<number | null>(null);
  const collapseVerificationRafRef = useRef<number | null>(null);
  const layoutMeasurementRafRef = useRef<number | null>(null);
  const measureIsMultiLineRef = useRef<
    ((source?: 'value-effect' | 'mutation-observer' | 'collapse-confirmation' | 'layout-change') => void) | null
  >(null);

  const checkDomEmpty = useCallback(() => {
    const el = richTextInputRef.current;
    if (!el) { setShowPlaceholder(true); return; }
    const hasOnlyBr =
      el.childNodes.length === 1 &&
      (el.childNodes[0] as Element).nodeName === 'BR';
    const isDomEmpty = (el.textContent ?? '').trim() === '' &&
      (el.childNodes.length === 0 || hasOnlyBr);
    const hasContexts = contextsRef.current.length > 0;
    setShowPlaceholder(isDomEmpty && !hasContexts);
  }, []);

  const measureCapsuleInputWidth = useCallback((): number | null => {
    const containerEl = containerRef.current;
    const editorEl = richTextInputRef.current;
    const boxEl = editorEl?.closest('.openbitfun-chat-input__box') as HTMLElement | null;

    if (!containerEl || !boxEl) {
      return null;
    }

    const clone = containerEl.cloneNode(true) as HTMLElement;
    clone.style.position = 'fixed';
    clone.style.left = '-100000px';
    clone.style.top = '0';
    clone.style.visibility = 'hidden';
    clone.style.pointerEvents = 'none';
    clone.style.width = `${containerEl.getBoundingClientRect().width}px`;
    clone.classList.add('openbitfun-chat-input--capsule');
    clone.classList.remove('openbitfun-chat-input--multi-line');

    const cloneComposerSurfaceEl = clone.querySelector(
      '[data-openbitfun-component="chat-composer"] [data-openbitfun-part="surface"]',
    ) as HTMLElement | null;
    const cloneInputAreaEl = clone.querySelector('.openbitfun-chat-input__input-area') as HTMLElement | null;

    if (cloneComposerSurfaceEl) {
      // ChatComposer owns the compact/expanded grid. Force its public layout
      // contract on the off-screen clone so collapse checks never measure the
      // wider expanded content track by accident.
      cloneComposerSurfaceEl.dataset.openbitfunLayout = 'compact';
    }

    document.body.appendChild(clone);
    const measuredWidth = cloneInputAreaEl
      ? Math.max(80, Math.floor(cloneInputAreaEl.getBoundingClientRect().width))
      : null;
    clone.remove();

    return measuredWidth;
  }, []);

  const refreshCapsuleInputWidth = useCallback((remeasureText: boolean) => {
    const measuredWidth = measureCapsuleInputWidth();
    if (measuredWidth == null) {
      return;
    }

    const previousWidth = liveCapsuleInputWidthRef.current;
    liveCapsuleInputWidthRef.current = measuredWidth;

    if (!remeasureText || previousWidth === measuredWidth) {
      return;
    }

    if (layoutMeasurementRafRef.current !== null) {
      cancelAnimationFrame(layoutMeasurementRafRef.current);
    }
    layoutMeasurementRafRef.current = requestAnimationFrame(() => {
      layoutMeasurementRafRef.current = null;
      measureIsMultiLineRef.current?.('layout-change');
      checkDomEmpty();
    });
  }, [checkDomEmpty, measureCapsuleInputWidth]);

  // Shared measurement: temporarily unconstrain the editor and use the capsule input
  // width so the result is consistent between capsule ↔ multi-line transitions.
  const measureIsMultiLine = useCallback((source: 'value-effect' | 'mutation-observer' | 'collapse-confirmation' | 'layout-change' = 'value-effect') => {
    if (isNewSessionComposer) {
      setIsMultiLine(true);
      return;
    }
    const hasNewline = inputState.value.includes('\n');
    const hasImages = imageContexts.length > 0;
    if (hasNewline || hasImages || showTargetSwitcher) {
      setIsMultiLine(true);
      return;
    }
    const el = richTextInputRef.current;
    if (!el) {
      setIsMultiLine(false);
      return;
    }
    // Measure against the live constrained input width in capsule mode.
    // A fixed boxWidth-minus-constant estimate drifts when the right-side
    // controls grow (for example with longer model labels), causing false
    // "single-line" results for text that already wraps in the real editor.
    const boxEl = el.closest('.openbitfun-chat-input__box') as HTMLElement | null;
    const actionsLeftEl = boxEl?.querySelector('.openbitfun-chat-input__actions-left') as HTMLElement | null;
    const actionsRightEl = boxEl?.querySelector('.openbitfun-chat-input__actions-right') as HTMLElement | null;
    const boxWidth = boxEl?.offsetWidth ?? containerRef.current?.offsetWidth ?? 400;
    const boxComputedStyle = boxEl ? window.getComputedStyle(boxEl) : null;
    const boxPaddingLeft = boxComputedStyle ? parseFloat(boxComputedStyle.paddingLeft || '0') : 0;
    const boxPaddingRight = boxComputedStyle ? parseFloat(boxComputedStyle.paddingRight || '0') : 0;
    const boxBorderLeft = boxComputedStyle ? parseFloat(boxComputedStyle.borderLeftWidth || '0') : 0;
    const boxBorderRight = boxComputedStyle ? parseFloat(boxComputedStyle.borderRightWidth || '0') : 0;
    const boxContentWidth = Math.max(
      80,
      Math.floor((boxEl?.getBoundingClientRect().width ?? boxWidth) - boxPaddingLeft - boxPaddingRight - boxBorderLeft - boxBorderRight),
    );
    const actionsLeftWidth = actionsLeftEl?.getBoundingClientRect().width ?? 0;
    const actionsRightWidth = actionsRightEl?.getBoundingClientRect().width ?? 0;
    const derivedCapsuleCandidateWidth = Math.max(
      80,
      Math.floor(boxContentWidth - actionsLeftWidth - actionsRightWidth),
    );
    const stableCapsuleCandidateWidth = liveCapsuleInputWidthRef.current ?? measureCapsuleInputWidth() ?? derivedCapsuleCandidateWidth;
    const previousLockedWidth = lockedCapsuleInputWidthRef.current;
    const measurementWidth = Math.max(
      80,
      Math.floor(
        isMultiLine
          ? Math.min(previousLockedWidth ?? stableCapsuleCandidateWidth, stableCapsuleCandidateWidth)
          : stableCapsuleCandidateWidth,
      ),
    );
    // Temporarily remove flex stretching + set capsule width to get the true content height.
    const prevFlex = el.style.flex;
    const prevMinH = el.style.minHeight;
    const prevWidth = el.style.width;
    el.style.flex = 'none';
    el.style.minHeight = '0';
    el.style.width = `${measurementWidth}px`;
    const measurementStyle = window.getComputedStyle(el);
    const computedLineHeight = Number.parseFloat(measurementStyle.lineHeight);
    const computedFontSize = Number.parseFloat(measurementStyle.fontSize);
    const singleLineHeight = Number.isFinite(computedLineHeight)
      ? computedLineHeight
      : Number.isFinite(computedFontSize)
        ? computedFontSize * 1.45
        : 20;
    const paddingBlock =
      (Number.parseFloat(measurementStyle.paddingTop) || 0) +
      (Number.parseFloat(measurementStyle.paddingBottom) || 0);
    const naturalHeightMeasured = el.scrollHeight;
    el.style.flex = prevFlex;
    el.style.minHeight = prevMinH;
    el.style.width = prevWidth;
    // The midpoint between one and two line boxes absorbs sub-pixel rounding
    // while following the active layout's real line height. A fixed pixel
    // threshold can oscillate when compact geometry crosses that fixed value:
    // compact expands, expanded collapses, and the cycle repeats.
    const singleLineThreshold = paddingBlock + singleLineHeight * 1.5;
    const nextIsMultiLine = naturalHeightMeasured > singleLineThreshold;
    const shouldVerifyCollapse =
      isMultiLine &&
      !nextIsMultiLine &&
      source !== 'collapse-confirmation';
    let nextLockedWidth: number | null;
    if (nextIsMultiLine) {
      nextLockedWidth =
        previousLockedWidth == null
          ? stableCapsuleCandidateWidth
          : Math.min(previousLockedWidth, stableCapsuleCandidateWidth);
      if (collapseVerificationRafRef.current !== null) {
        cancelAnimationFrame(collapseVerificationRafRef.current);
        collapseVerificationRafRef.current = null;
      }
    } else {
      nextLockedWidth = null;
    }
    if (shouldVerifyCollapse) {
      if (collapseVerificationRafRef.current !== null) {
        cancelAnimationFrame(collapseVerificationRafRef.current);
      }
      collapseVerificationRafRef.current = requestAnimationFrame(() => {
        collapseVerificationRafRef.current = null;
        measureIsMultiLineRef.current?.('collapse-confirmation');
      });
      return;
    }
    lockedCapsuleInputWidthRef.current = nextLockedWidth;
    setIsMultiLine(nextIsMultiLine);
  }, [inputState.value, imageContexts.length, isMultiLine, isNewSessionComposer, measureCapsuleInputWidth, showTargetSwitcher]);
  measureIsMultiLineRef.current = measureIsMultiLine;

  // Re-measure when value or image count changes (handles typing / deleting)
  useEffect(() => {
    // Defer one frame so RichTextInput has synced the new value to the contenteditable DOM.
    const rafId = requestAnimationFrame(() => {
      measureIsMultiLine('value-effect');
      checkDomEmpty();
    });
    return () => cancelAnimationFrame(rafId);
  }, [measureIsMultiLine, checkDomEmpty]);

  // Also watch DOM mutations on the editor so that Shift+Enter in an empty input
  // (which adds a <br> without changing the React value) triggers expansion,
  // and so that residual <br> after deletion is detected for placeholder visibility.
  useEffect(() => {
    const el = richTextInputRef.current;
    if (!el) return;
    let rafId: number;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        // Session restoration can change attachments after this observer mounts.
        measureIsMultiLineRef.current?.('mutation-observer');
        checkDomEmpty();
      });
    });
    observer.observe(el, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafId);
    };
  }, [checkDomEmpty]);

  useEffect(() => {
    const containerEl = containerRef.current;
    const boxEl = containerEl?.querySelector('.openbitfun-chat-input__box') as HTMLElement | null;
    const actionsLeftEl = containerEl?.querySelector('.openbitfun-chat-input__actions-left') as HTMLElement | null;
    const actionsRightEl = containerEl?.querySelector('.openbitfun-chat-input__actions-right') as HTMLElement | null;
    const observedElements = [containerEl, boxEl, actionsLeftEl, actionsRightEl].filter(
      (element): element is HTMLElement => !!element,
    );

    if (observedElements.length === 0) {
      return;
    }

    let rafId: number | null = null;
    // Only width feeds the capsule measurement, and re-measuring clones the whole
    // composer into the document (two forced layouts). The box height animates on
    // every capsule ↔ multi-line flip, so reacting to height would run that clone
    // once per frame of the transition — exactly while the user is typing at the
    // wrap boundary. Ignore entries whose width is unchanged.
    const lastObservedWidths = new WeakMap<Element, number>();
    const observer = new ResizeObserver(entries => {
      let widthChanged = false;
      for (const entry of entries) {
        const width = entry.contentRect.width;
        const previousWidth = lastObservedWidths.get(entry.target);
        if (previousWidth === undefined || Math.abs(previousWidth - width) >= 0.5) {
          widthChanged = true;
        }
        lastObservedWidths.set(entry.target, width);
      }
      if (!widthChanged) {
        return;
      }
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(() => {
        rafId = null;
        refreshCapsuleInputWidth(true);
      });
    });

    observedElements.forEach(element => observer.observe(element));
    refreshCapsuleInputWidth(false);

    return () => {
      observer.disconnect();
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [
    currentImageCount,
    derivedState?.sendButtonMode,
    isMultiLine,
    refreshCapsuleInputWidth,
    showTargetSwitcher,
  ]);

  useEffect(() => {
    return () => {
      if (collapseVerificationRafRef.current !== null) {
        cancelAnimationFrame(collapseVerificationRafRef.current);
      }
      if (layoutMeasurementRafRef.current !== null) {
        cancelAnimationFrame(layoutMeasurementRafRef.current);
      }
    };
  }, []);

  const { transition, setQueuedInput } = useSessionStateMachineActions(effectiveTargetSessionId);

  const {
    workspace,
    workspacePath: currentWorkspacePath,
    workspaceName: currentWorkspaceName,
  } = useCurrentWorkspace();
  // A host that explicitly registers workspacePath owns the composer
  // workspace. Even an empty registered path is intentional isolation and
  // must not leak the user's active project into an Agentic MiniApp surface.
  const hasRegisteredWorkspace = Boolean(
    registration && Object.prototype.hasOwnProperty.call(registration, 'workspacePath'),
  );
  const workspacePath = hasRegisteredWorkspace
    ? (registration?.workspacePath || '').trim()
    : currentWorkspacePath;
  const workspaceName = hasRegisteredWorkspace
    ? (workspacePath ? path.basename(workspacePath) : '')
    : currentWorkspaceName;
  const sessionBoundWorkspacePath = (
    (!hasRegisteredWorkspace && effectiveTargetSession?.workspacePath)
    || workspacePath
    || ''
  ).trim();
  const workspacePathRef = useRef(sessionBoundWorkspacePath);
  workspacePathRef.current = sessionBoundWorkspacePath;
  const { openedWorkspaces } = useWorkspaceContext();
  const contextWorkspace = useMemo(() => (
    effectiveTargetSession
      ? findWorkspaceForSession(effectiveTargetSession, openedWorkspaces.values())
      : workspace ?? undefined
  ), [effectiveTargetSession, openedWorkspaces, workspace]);
  const sessionBoundRemoteConnectionId = (
    hasRegisteredWorkspace
      ? registration?.remoteConnectionId
      : (
          effectiveTargetSession?.remoteConnectionId
          || effectiveTargetSession?.config?.remoteConnectionId
          || contextWorkspace?.connectionId
        )
  )?.trim() || undefined;

  const chatStripRepositoryPath = useMemo(() => {
    const fromSession = hasRegisteredWorkspace
      ? ''
      : (effectiveTargetSession?.workspacePath || '').trim();
    const fromContext = (workspacePath || '').trim();
    return fromSession || fromContext;
  }, [hasRegisteredWorkspace, workspacePath, effectiveTargetSession?.workspacePath]);

  const chatStripWorkspaceLabel = useMemo(() => {
    const name = (workspaceName || '').trim();
    const sessionPath = hasRegisteredWorkspace
      ? ''
      : (effectiveTargetSession?.workspacePath || '').trim();
    const contextPath = (workspacePath || '').trim();
    // A managed worktree is where the session executes, not a different project.
    // Its directory is a generated id, so keep labelling by the owning project.
    const sessionProjectPath = hasRegisteredWorkspace
      ? ''
      : (
        effectiveTargetSession?.config.projectWorkspacePath
        || effectiveTargetSession?.projectWorkspacePath
        || ''
      ).trim();
    const isWorktreeSession = !!effectiveTargetSession?.config.executionTarget?.worktreeId;
    const sessionUsesDifferentRoot = !!sessionPath
      && (!contextPath || !isSamePath(sessionPath, contextPath))
      && !(
        isWorktreeSession
        && !!contextPath
        && !!sessionProjectPath
        && isSamePath(sessionProjectPath, contextPath)
      );
    if (name && !sessionUsesDifferentRoot) return name;
    if (isWorktreeSession && sessionProjectPath) return path.basename(sessionProjectPath);
    if (chatStripRepositoryPath) return path.basename(chatStripRepositoryPath);
    return '';
  }, [
    chatStripRepositoryPath,
    effectiveTargetSession?.config.executionTarget?.worktreeId,
    effectiveTargetSession?.config.projectWorkspacePath,
    effectiveTargetSession?.projectWorkspacePath,
    effectiveTargetSession?.workspacePath,
    hasRegisteredWorkspace,
    workspaceName,
    workspacePath,
  ]);
  
  const [tokenUsage, setTokenUsage] = React.useState<ContextUsageDisplay>(
    getSessionContextUsageDisplay()
  );
  const [isModelSwitching, setIsModelSwitching] = useState(false);
  const [modelAvailability, setModelAvailability] = useState<ModelSelectorAvailability>({
    status: 'loading',
    canSend: false,
  });
  const isAssistantWorkspace = useMemo(
    () => resolveSessionAssistantWorkspace({
      currentWorkspace: workspace,
      sessionWorkspaceId: effectiveTargetSession?.workspaceId,
      sessionWorkspacePath: effectiveTargetSession?.workspacePath,
      sessionRemoteConnectionId: effectiveTargetSession?.remoteConnectionId,
      openedWorkspaces: openedWorkspaces.values(),
    }),
    [effectiveTargetSession, openedWorkspaces, workspace],
  );
  const currentMode = modeState.current;
  const isModeDropdownOpen = modeState.dropdownOpen;
  const acpTargetAgentType = useMemo(
    () => acpAgentTypeFromSession(effectiveTargetSession),
    [effectiveTargetSession]
  );
  const isAcpTargetSession = Boolean(acpTargetAgentType);
  const executionLevelPolicy = useMemo(
    () => resolveChatInputExecutionLevelPolicy({
      isAssistantWorkspace,
      sessionMode: effectiveTargetSession?.mode ?? effectiveTargetSession?.config.agentType,
      isAcpTargetSession,
      isSubagentInputTarget,
    }),
    [
      effectiveTargetSession?.config.agentType,
      effectiveTargetSession?.mode,
      isAcpTargetSession,
      isAssistantWorkspace,
      isSubagentInputTarget,
    ],
  );
  const globalPermissionMode = permissionModeFromConfig(toolPermissionConfig);
  // Session selection wins over the user-level default, matching how the
  // backend resolves the mode for each submission.
  // The session-scoped mode, which is what the menu checkmark marks. An armed
  // one-off is reported separately so the two states stay distinguishable.
  const permissionMode: ChatInputPermissionMode = isAcpTargetSession
    ? 'acp'
    : chatInputPermissionMode(sessionPermissionMode ?? globalPermissionMode);
  const temporaryPermissionMode = activePermissionTurnId
    ? activeTurnPermissionMode
    : armedTurnPermissionMode;
  const permissionModeOverridden =
    !isAcpTargetSession && (temporaryPermissionMode !== null || sessionPermissionMode !== null);
  const activeSessionMode = effectiveTargetSessionId
    ? acpTargetAgentType || flowChatState.sessions.get(effectiveTargetSessionId)?.mode
    : undefined;
  const chatInputModePolicy = useMemo(
    () => resolveChatInputModePolicy({
      currentMode,
      isAssistantWorkspace,
      sessionMode: activeSessionMode,
      isAcpTargetSession,
    }),
    [activeSessionMode, currentMode, isAcpTargetSession, isAssistantWorkspace],
  );
  const canSwitchModes = chatInputModePolicy.canSwitchModes && !isSubagentInputTarget;
  const selectedHarnessProfile = resolveSelectedComposerExecutionLevel({
    currentMode,
  });

  const mainAgentModes = useMemo(
    () => resolveChatInputMainAgentModes(modeState.available),
    [modeState.available]
  );
  const publishModeSelectionRef = useRef<((modeId: string) => void) | null>(null);
  const suppressNextUserDefaultModeApplicationRef = useRef(false);

  const openScene = useSceneStore(s => s.openScene);
  const [subagentToolInfo, setSubagentToolInfo] = useState<SubagentInfo | null>(null);
  const [targetModeEnabledTools, setTargetModeEnabledTools] = useState<string[] | null>(null);
  const [targetModeToolsResolved, setTargetModeToolsResolved] = useState(false);
  const [userDefaultModeId, setUserDefaultModeId] = useState<string | null>(null);
  const { computerUseEnabled } = useComputerUseEnabled();

  const setChatInputHeight = useChatInputState(state => state.setInputHeight);

  useEffect(() => {
    const store = FlowChatStore.getInstance();

    const unsubscribe = store.subscribeSelector(
      (state: FlowChatState): string => {
        const parts: string[] = [state.activeSessionId ?? ''];
        // Track sessions that ChatInput reads in render body (lines 278, 288, 304, 619)
        const sessionIds = [
          state.activeSessionId,
          currentSessionId,
          effectiveTargetSessionId,
          activeBtwSessionId,
        ].filter((id): id is string => !!id);
        for (const id of sessionIds) {
          const s = state.sessions.get(id);
          if (s) {
            parts.push(chatInputSessionSubscriptionKey(s));
          }
        }
        return parts.join(';');
      },
      () => {
        const state = store.getState();
        setFlowChatState(state);
        if (effectiveTargetSessionId) {
          const session = state.sessions.get(effectiveTargetSessionId);
          if (session) {
            setTokenUsage(getSessionContextUsageDisplay(session));
          }
        }
      },
      { isEqual: (a: string, b: string) => a === b },
    );

    // Initial token usage sync
    if (effectiveTargetSessionId) {
      const session = store.getState().sessions.get(effectiveTargetSessionId);
      if (session) {
        setTokenUsage(getSessionContextUsageDisplay(session));
      }
    }

    return () => unsubscribe();
  }, [currentSessionId, effectiveTargetSessionId, activeBtwSessionId]);

  useEffect(() => {
    if (!showTargetSwitcher || !activeBtwSessionId) {
      setInputTarget('main');
    }
  }, [activeBtwSessionId, showTargetSwitcher]);

  // Reset history index when switching sessions
  useEffect(() => {
    setHistoryIndex(-1);
  }, [effectiveTargetSessionId]);
  
  const modeInfoById = useMemo(
    () => new Map(modeState.available.map(mode => [mode.id, mode])),
    [modeState.available],
  );
  const availableModeIds = useMemo(
    () => new Set(modeState.available.map(mode => mode.id)),
    [modeState.available],
  );

  const getModeDisplayName = useCallback((modeId?: string) => {
    if (!modeId) {
      return '';
    }

    return (
      t(`chatInput.modeNames.${modeId}`, { defaultValue: '' }) ||
      modeInfoById.get(modeId)?.name ||
      modeId
    );
  }, [modeInfoById, t]);

  const otherAgentOptions = useMemo((): HarnessAgentOption[] => {
    const options = mainAgentModes.map(mode => ({
      id: mode.id,
      name: getModeDisplayName(mode.id),
      available: mode.id !== 'ComputerUse' || computerUseEnabled,
    }));

    if (
      selectedHarnessProfile === 'other'
      && !options.some(option => option.id.toLowerCase() === currentMode.trim().toLowerCase())
    ) {
      options.unshift({
        id: currentMode,
        name: getModeDisplayName(currentMode),
        available: false,
      });
    }

    return options;
  }, [
    computerUseEnabled,
    currentMode,
    getModeDisplayName,
    mainAgentModes,
    selectedHarnessProfile,
  ]);

  const effectiveSendAgentType = resolveChatInputSendAgentType({
    isSubagentTarget: isSubagentInputTarget,
    subagentType: effectiveTargetSession?.subagentType,
    sessionMode: effectiveTargetSession?.mode,
    acpTargetAgentType,
    composerMode: currentMode,
  });
  const targetModeInfo = useMemo(() => {
    const normalizedAgentType = effectiveSendAgentType.trim().toLowerCase();
    return normalizedAgentType
      ? modeState.available.find(mode => mode.id.toLowerCase() === normalizedAgentType) ?? null
      : null;
  }, [effectiveSendAgentType, modeState.available]);
  const targetWorkspacePath = sessionBoundWorkspacePath;

  useEffect(() => {
    if (!isSubagentInputTarget) {
      setSubagentToolInfo(null);
      return;
    }

    const targetAgentType = effectiveSendAgentType.trim();
    if (!targetAgentType) {
      setSubagentToolInfo(null);
      return;
    }

    let cancelled = false;
    setSubagentToolInfo(null);
    (async () => {
      try {
        const subagents = await SubagentAPI.listSubagents({
          workspacePath: targetWorkspacePath || undefined,
        });
        const normalizedTargetAgentType = targetAgentType.toLowerCase();
        const targetSubagent = subagents.find(subagent =>
          subagent.id.toLowerCase() === normalizedTargetAgentType ||
          subagent.key.toLowerCase() === normalizedTargetAgentType
        ) ?? null;
        if (!cancelled) {
          setSubagentToolInfo(targetSubagent);
        }
      } catch (err) {
        log.error('Failed to load subagent tool info for chat input', {
          err,
          targetAgentType,
          workspacePath: targetWorkspacePath || undefined,
        });
        if (!cancelled) {
          setSubagentToolInfo(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [effectiveSendAgentType, isSubagentInputTarget, targetWorkspacePath]);

  useEffect(() => {
    if (isSubagentInputTarget) {
      setTargetModeEnabledTools(null);
      setTargetModeToolsResolved(false);
      return;
    }

    if (!targetModeInfo) {
      setTargetModeEnabledTools(null);
      setTargetModeToolsResolved(false);
      return;
    }
    if (targetModeInfo.source === 'external') {
      setTargetModeEnabledTools(targetModeInfo.defaultTools ?? null);
      setTargetModeToolsResolved(true);
      return;
    }

    let cancelled = false;
    setTargetModeEnabledTools(null);
    setTargetModeToolsResolved(false);
    (async () => {
      try {
        const config = await configAPI.getAgentProfileConfig(targetModeInfo.id);
        if (!cancelled) {
          setTargetModeEnabledTools(config.enabled_tools ?? null);
          setTargetModeToolsResolved(true);
        }
      } catch (err) {
        log.error('Failed to load mode tool config for chat input', {
          err,
          targetAgentType: targetModeInfo.id,
        });
        if (!cancelled) {
          setTargetModeEnabledTools(null);
          setTargetModeToolsResolved(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isSubagentInputTarget, targetModeInfo]);

  const canUseThreadGoal =
    caps.threadGoal &&
    targetModeToolsResolved &&
    hasCompleteThreadGoalTools(targetModeEnabledTools);

  const threadGoalController = useThreadGoalController(effectiveTargetSession, {
    isBtwSession,
    disabled: !canUseThreadGoal,
    sceneActive: isSceneActive,
  });

  const targetSkillToolAgents = useMemo(() => {
    const normalizedTargetAgentType = effectiveSendAgentType.trim().toLowerCase();
    const agents: Array<{ id: string; defaultTools?: string[] }> = modeState.available.map(mode => ({
      id: mode.id,
      defaultTools: mode.id.toLowerCase() === normalizedTargetAgentType && targetModeEnabledTools
        ? targetModeEnabledTools
        : mode.defaultTools,
    }));
    if (subagentToolInfo) {
      agents.push({
        id: subagentToolInfo.id,
        defaultTools: subagentToolInfo.defaultTools,
      });
      if (subagentToolInfo.key !== subagentToolInfo.id) {
        agents.push({
          id: subagentToolInfo.key,
          defaultTools: subagentToolInfo.defaultTools,
        });
      }
    }
    return agents;
  }, [effectiveSendAgentType, modeState.available, subagentToolInfo, targetModeEnabledTools]);

  const canUseSkillsForTarget = useMemo(
    () => resolveChatInputCanUseSkills({
      isSubagentTarget: isSubagentInputTarget,
      targetAgentType: effectiveSendAgentType,
      availableAgents: targetSkillToolAgents,
    }),
    [effectiveSendAgentType, isSubagentInputTarget, targetSkillToolAgents],
  );
  const [slashCommandState, setSlashCommandState] = useState<{
    isActive: boolean;
    kind: 'actions' | 'all' | 'skills';
    query: string;
    selectedIndex: number;
  }>({
    isActive: false,
    kind: 'all',
    query: '',
    selectedIndex: 0,
  });
  const [contextTriggerState, setContextTriggerState] = useState<ContextTriggerState>({
    isActive: false,
    query: '',
    startOffset: 0,
  });
  const canSelectMcp = resolveChatInputCanUseMcp({
    targetAgentType: effectiveSendAgentType,
    isAcpTargetSession,
    isDispatchTransport: Boolean(caps.dispatchTransport),
  });
  const chatMcp = useChatMcpCatalog({
    enabled: canSelectMcp && contextTriggerState.isActive,
    surfaceEpoch: deviceSurfaceScope.epoch,
    modeId: effectiveSendAgentType,
    workspacePath: sessionBoundWorkspacePath || undefined,
    remoteConnectionId: sessionBoundRemoteConnectionId || undefined,
  });
  const {
    skills: resolvedModeSkills,
    loading: resolvedModeSkillsLoading,
    hasLoaded: resolvedModeSkillsLoaded,
    failed: resolvedModeSkillsLoadFailed,
    diagnostics: resolvedSkillDiagnostics,
    diagnosticsAvailable: resolvedSkillDiagnosticsAvailable,
    retry: retryResolvedModeSkills,
  } = useResolvedModeSkills({
    enabled: isSceneActive && canUseSkillsForTarget && (
      isModeDropdownOpen ||
      contextTriggerState.isActive ||
      (slashCommandState.isActive && (slashCommandState.kind === 'all' || slashCommandState.kind === 'skills'))
    ),
    surfaceEpoch: deviceSurfaceScope.epoch,
    connectionId: sessionBoundRemoteConnectionId,
    modeId: effectiveSendAgentType,
    workspacePath: targetWorkspacePath,
  });
  const skillReferenceNames = useMemo(
    () => Object.fromEntries(resolvedModeSkills.map(skill => [skill.key, skill.name])),
    [resolvedModeSkills],
  );
  const userInvocableSkills = useMemo(
    // All input pickers use the host-selected winner for each skill name.
    () => {
      const seenNames = new Set<string>();
      return resolvedModeSkills.filter(skill => {
        if (!skill.selectedForRuntime || !isSkillAvailableForUserInvocation(skill)
          || !skill.name.trim() || seenNames.has(skill.name)) return false;
        seenNames.add(skill.name);
        return true;
      });
    },
    [resolvedModeSkills]
  );

  const quickSkillShortcuts = useMemo(
    () => canUseSkillsForTarget
      ? resolveChatInputQuickSkillShortcuts(resolvedModeSkills)
      : [],
    [canUseSkillsForTarget, resolvedModeSkills],
  );
  // Claw is the fixed runtime owner for Assistant sessions, so presenting
  // quick Skills as alternate modes in their add menu is misleading.
  const showAdditionalModes = chatInputModePolicy.fixedModeId !== 'Claw'
    && quickSkillShortcuts.length > 0;
  const boostMenuLayoutRevision = quickSkillShortcuts
    .map(shortcut => shortcut.id)
    .join('|');
  const boostMenuLayout = useAnchoredPopoverPosition({
    open: modeState.dropdownOpen,
    anchorRef: boostTriggerRef,
    popoverRef: boostMenuRef,
    preferredPlacement: 'top',
    alignment: 'start',
    gap: 6,
    layoutRevision: boostMenuLayoutRevision,
  });

  const confirmPromptCacheGuardIfNeeded = useCallback(async () => {
    const nextMode = effectiveSendAgentType.trim();
    const lastSubmittedMode = effectiveTargetSession?.lastSubmittedMode?.trim();
    if (!nextMode || !lastSubmittedMode || nextMode === lastSubmittedMode) {
      return true;
    }

    const nextScopeKey = modeInfoById.get(nextMode)?.promptCacheScopeKey;
    const previousScopeKey = modeInfoById.get(lastSubmittedMode)?.promptCacheScopeKey;
    if (!nextScopeKey || !previousScopeKey || nextScopeKey === previousScopeKey) {
      return true;
    }

    return confirmWarning(
      t('chatInput.promptCacheGuardTitle'),
      t('chatInput.promptCacheGuardBody', {
        fromMode: getModeDisplayName(lastSubmittedMode),
        toMode: getModeDisplayName(nextMode),
      }),
      {
        confirmText: t('chatInput.promptCacheGuardConfirm'),
        cancelText: t('chatInput.promptCacheGuardCancel'),
      },
    );
  }, [effectiveSendAgentType, effectiveTargetSession?.lastSubmittedMode, getModeDisplayName, modeInfoById, t]);

  const [mcpPromptCommands, setMcpPromptCommands] = useState<SlashMcpPromptItem[]>([]);
  const [mcpPromptCommandsLoading, setMcpPromptCommandsLoading] = useState(false);
  const [externalPromptCommands, setExternalPromptCommands] = useState<SlashExternalPromptCommandItem[]>([]);
  const [externalPromptCommandsLoading, setExternalPromptCommandsLoading] = useState(false);
  const [externalPromptCommandsPending, setExternalPromptCommandsPending] = useState(false);
  const [externalPromptCommandsIssue, setExternalPromptCommandsIssue] = useState<ExternalPromptCommandCatalogIssue>();
  const [selectedExternalPromptCandidateId, setSelectedExternalPromptCandidateId] = useState<string>();
  const [selectedNonExternalSlashCommand, setSelectedNonExternalSlashCommand] = useState<string>();
  const [selectedNonExternalSlashCandidateId, setSelectedNonExternalSlashCandidateId] = useState<string>();
  const externalPromptCatalogRequestRef = useRef(0);

  const refreshExternalPromptCommands = useCallback(async (
    showLoading: boolean,
    forceRefresh = false,
  ) => {
    const requestId = ++externalPromptCatalogRequestRef.current;
    if (isAcpInputSession) {
      setExternalPromptCommands([]);
      setExternalPromptCommandsPending(false);
      setExternalPromptCommandsIssue(undefined);
      setExternalPromptCommandsLoading(false);
      return undefined;
    }
    if (showLoading) {
      setExternalPromptCommandsLoading(true);
    }
    try {
      const snapshot = await externalSourcesAPI.getSnapshot(
        sessionBoundWorkspacePath || undefined,
        forceRefresh,
      );
      if (requestId !== externalPromptCatalogRequestRef.current) return undefined;
      setExternalPromptCommands(toSlashExternalPromptCommands(snapshot));
      setExternalPromptCommandsPending(snapshot.discoveryPending);
      setExternalPromptCommandsIssue(undefined);
      return snapshot;
    } catch (error) {
      if (requestId !== externalPromptCatalogRequestRef.current) return undefined;
      const issue = classifyExternalPromptCommandCatalogIssue(error);
      setExternalPromptCommands([]);
      setSelectedExternalPromptCandidateId(undefined);
      setExternalPromptCommandsIssue(issue);
      setExternalPromptCommandsPending(false);
      if (issue === 'host_unavailable') {
        log.debug('External prompt commands are unavailable on this host', {
          code: error instanceof ExternalSourceApiError ? error.code : 'internal',
        });
      } else {
        log.warn('Failed to load external prompt command catalog', {
          code: error instanceof ExternalSourceApiError ? error.code : 'internal',
        });
      }
      return undefined;
    } finally {
      if (showLoading && requestId === externalPromptCatalogRequestRef.current) {
        setExternalPromptCommandsLoading(false);
      }
    }
  }, [isAcpInputSession, sessionBoundWorkspacePath]);

  useEffect(() => {
    externalPromptCatalogRequestRef.current += 1;
    setExternalPromptCommands([]);
    setExternalPromptCommandsPending(false);
    setExternalPromptCommandsIssue(undefined);
    setSelectedExternalPromptCandidateId(undefined);
    setSelectedNonExternalSlashCommand(undefined);
    setSelectedNonExternalSlashCandidateId(undefined);
    void refreshExternalPromptCommands(true);

    return () => {
      externalPromptCatalogRequestRef.current += 1;
    };
  }, [refreshExternalPromptCommands]);

  useEffect(() => {
    if (!externalPromptCommandsPending) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    let attempt = 0;
    const schedulePoll = () => {
      timer = window.setTimeout(async () => {
        const snapshot = await refreshExternalPromptCommands(false);
        if (cancelled || !snapshot || !snapshot.discoveryPending) return;
        attempt += 1;
        schedulePoll();
      }, externalSourceDiscoveryPollDelay(attempt));
    };
    schedulePoll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [externalPromptCommandsPending, refreshExternalPromptCommands]);

  const loadMcpPromptCommands = useCallback(async () => {
    setMcpPromptCommandsLoading(true);

    try {
      const servers = await MCPAPI.getServers();
      const connectedServers = servers.filter(
        server => server.status === 'Connected' || server.status === 'Healthy'
      );

      const promptGroups = await Promise.all(
        connectedServers.map(async (server: MCPServerInfo) => {
          try {
            const prompts = await MCPAPI.listPrompts({
              serverId: server.id,
              refresh: true,
            });
            return prompts.map((prompt: MCPPrompt) => ({
              kind: 'mcpPrompt' as const,
              id: `${server.id}:${prompt.name}`,
              command: buildMcpPromptSlashCommand(server.id, prompt.name),
              label:
                prompt.description?.trim() ||
                `${server.name} MCP prompt`,
              serverId: server.id,
              serverName: server.name,
              promptName: prompt.name,
              description: prompt.description,
              arguments: (prompt.arguments || []).map(argument => ({
                name: argument.name,
                required: argument.required,
                description: argument.description,
              })),
            }));
          } catch (error) {
            log.warn('Failed to load MCP prompts for server', {
              serverId: server.id,
              error,
            });
            return [] as SlashMcpPromptItem[];
          }
        })
      );

      setMcpPromptCommands(
        promptGroups
          .flat()
          .sort((a, b) => a.command.localeCompare(b.command))
      );
    } finally {
      setMcpPromptCommandsLoading(false);
    }
  }, []);
  
  const [recommendationContext, setRecommendationContext] = React.useState<{
    workspacePath?: string;
    sessionId?: string;
    turnId?: string;
    modifiedFiles?: string[];
  } | null>(null);
  
  const [inlineTriggerState, setInlineTriggerState] = useState<InlineTriggerState>({
    isActive: false,
    trigger: null,
    query: '',
    startOffset: 0,
  });
  
  const slashCommandPickerLayout = useAnchoredPopoverPosition({
    open: slashCommandState.isActive,
    anchorRef: inputAreaAnchorRef,
    popoverRef: slashCommandPickerRef,
    preferredPlacement: 'top',
    alignment: 'start',
    gap: 6,
    layoutRevision: `${slashCommandState.kind}:${slashCommandState.query}`,
  });

  const slashPickerWasActiveRef = useRef(false);
  useEffect(() => {
    const opening = slashCommandState.isActive && !slashPickerWasActiveRef.current;
    slashPickerWasActiveRef.current = slashCommandState.isActive;
    if (opening && !externalPromptCommandsLoading && !externalPromptCommandsPending) {
      void refreshExternalPromptCommands(false);
    }
  }, [externalPromptCommandsLoading, externalPromptCommandsPending, refreshExternalPromptCommands, slashCommandState.isActive]);

  const reportedChatPopupActive = useSyncExternalStore(
    subscribeChatPopupChange,
    isChatPopupActive,
    isChatPopupActive,
  );
  const chatPopupActive =
    slashCommandState.isActive || contextTriggerState.isActive || reportedChatPopupActive;

  // Keep the module-level flag in sync for other Escape owners such as modal
  // surfaces. The local state is included above so this composer does not wait
  // for the effect before giving the key to its popup.
  useEffect(() => {
    setChatPopupActive(slashCommandState.isActive || contextTriggerState.isActive);
  }, [contextTriggerState.isActive, slashCommandState.isActive]);

  useEffect(() => {
    if (!slashCommandState.isActive) {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      scrollSelectedSlashCommandIntoView(slashCommandPickerRef.current);
    });

    return () => cancelAnimationFrame(frameId);
  }, [
    slashCommandState.isActive,
    slashCommandState.kind,
    slashCommandState.query,
    slashCommandState.selectedIndex,
  ]);

  useEffect(() => {
    const closeInlineSkillPicker = () => {
      setSlashCommandState(prev => (
        prev.isActive && prev.kind === 'skills'
          ? { isActive: false, kind: 'all', query: '', selectedIndex: 0 }
          : prev
      ));
    };

    if (isAcpInputSession || !canUseSkillsForTarget) {
      closeInlineSkillPicker();
      return;
    }

    const inlineSkillQuery = getInlineSkillPickerQuery(inlineTriggerState);

    if (inlineSkillQuery !== null) {
      setSlashCommandState(prev => ({
        isActive: true,
        kind: 'skills',
        query: inlineSkillQuery,
        selectedIndex:
          prev.kind === 'skills' && prev.query === inlineSkillQuery
            ? prev.selectedIndex
            : 0,
      }));
      return;
    }

    closeInlineSkillPicker();
  }, [canUseSkillsForTarget, inlineTriggerState, isAcpInputSession]);

  const previousComposerSessionIdRef = useRef<string | null>(null);
  const previousComposerSurfaceEpochRef = useRef(deviceSurfaceScope.epoch);

  React.useLayoutEffect(() => {
    const previousSessionId = previousComposerSessionIdRef.current;
    const surfaceChanged = previousComposerSurfaceEpochRef.current !== deviceSurfaceScope.epoch;
    const draft = sessionComposerStore.getState().activateDraft(
      previousSessionId,
      effectiveTargetSessionId,
      useContextStore.getState().contexts,
      !surfaceChanged,
    );
    previousComposerSessionIdRef.current = effectiveTargetSessionId;
    previousComposerSurfaceEpochRef.current = deviceSurfaceScope.epoch;

    const nextValue = draft.value;
    const nextContexts = draft.contexts;
    const nextPendingLargePastes = draft.pendingLargePastes;

    dispatchLocalInput({ type: 'SET_VALUE', payload: nextValue });
    inputValueRef.current = nextValue;
    const restoredPendingLargePastes = { ...nextPendingLargePastes };
    pendingLargePastesRef.current = restoredPendingLargePastes;
    setPendingLargePastes(restoredPendingLargePastes);
    isRestoringSessionDraftRef.current = true;
    try {
      replaceContexts(nextContexts);
    } finally {
      isRestoringSessionDraftRef.current = false;
    }
    setHistoryIndex(-1);
    setSavedDraft('');
    setContextTriggerState({ isActive: false, query: '', startOffset: 0 });
    setInlineTriggerState({
      isActive: false,
      trigger: null,
      query: '',
      startOffset: 0,
    });
    setSlashCommandState({
      isActive: false,
      kind: 'all',
      query: '',
      selectedIndex: 0,
    });
  }, [deviceSurfaceScope.epoch, effectiveTargetSessionId, replaceContexts]);

  const applyAssistantBootstrapDraft = useCallback((value: string) => {
    dispatchInput({ type: 'SET_VALUE', payload: value });
  }, [dispatchInput]);
  useAssistantBootstrap(effectiveTargetSession, applyAssistantBootstrapDraft);

  useEffect(() => {
    let previousContexts = useContextStore.getState().contexts;
    const unsubscribe = useContextStore.subscribe((state) => {
      if (shouldRecordContextMutation(
        state.contexts !== previousContexts,
        isRestoringSessionDraftRef.current,
      )) {
        markComposerMutation();
      }
      previousContexts = state.contexts;
      const sessionId = effectiveTargetSessionIdRef.current;
      if (sessionId) {
        sessionComposerStore.getState().setContexts(sessionId, state.contexts);
      }
    });

    return () => {
      const sessionId = effectiveTargetSessionIdRef.current;
      if (sessionId) {
        sessionComposerStore.getState().setContexts(
          sessionId,
          useContextStore.getState().contexts,
        );
      }
      unsubscribe();
    };
  }, [markComposerMutation]);

  const replacePendingLargePastes = useCallback((pendingLargePastes: PendingLargePasteMap) => {
    const nextPendingLargePastes = { ...pendingLargePastes };
    const previousPendingLargePastes = pendingLargePastesRef.current;
    const previousKeys = Object.keys(previousPendingLargePastes);
    const nextKeys = Object.keys(nextPendingLargePastes);
    if (
      previousKeys.length !== nextKeys.length ||
      nextKeys.some(key => previousPendingLargePastes[key] !== nextPendingLargePastes[key])
    ) {
      markComposerMutation();
    }
    pendingLargePastesRef.current = nextPendingLargePastes;
    setPendingLargePastes(nextPendingLargePastes);

    const sessionId = effectiveTargetSessionIdRef.current;
    if (sessionId) {
      sessionComposerStore.getState().setPendingLargePastes(sessionId, nextPendingLargePastes);
    }
  }, [markComposerMutation]);

  const clearPendingLargePastes = useCallback(() => {
    replacePendingLargePastes({});
  }, [replacePendingLargePastes]);

  const restoreQueuedMessageToComposer = useCallback((item: QueuedMessage): boolean => {
    if (!effectiveTargetSessionId || item.sessionId !== effectiveTargetSessionId) {
      return false;
    }

    if (!canRestoreQueuedMessageToComposer({
      value: inputValueRef.current,
      contexts: contextsRef.current,
      pendingLargePastes: pendingLargePastesRef.current,
      queuedInput: derivedState?.queuedInput,
    })) {
      notificationService.warning(t('pendingQueue.errors.composerNotEmpty'), { duration: 4000 });
      richTextInputRef.current?.focus();
      return false;
    }

    const draft = getQueuedMessageComposerDraft(item);
    setQueuedInput(null);
    setHistoryIndex(-1);
    setSavedDraft('');
    replacePendingLargePastes(draft.pendingLargePastes);
    replaceContexts(draft.contexts);
    dispatchInput({ type: 'SET_VALUE', payload: draft.value });
    window.setTimeout(() => richTextInputRef.current?.focus(), 0);
    return true;
  }, [
    derivedState?.queuedInput,
    dispatchInput,
    effectiveTargetSessionId,
    replaceContexts,
    replacePendingLargePastes,
    setQueuedInput,
    t,
  ]);

  const { sendMessage } = useMessageSender({
    currentSessionId: effectiveTargetSessionId || undefined,
    contexts,
    onClearContexts: clearContexts,
    // A busy session queues new input. Its active override must not leak into
    // that future turn's submission metadata.
    turnPermissionMode: activePermissionTurnId ? null : armedTurnPermissionMode,
    onTurnPermissionModeConsumed: () => setArmedTurnPermissionMode(null),
    onSessionConflictRetryStart: ({ sessionId }) => {
      sessionConflictRetryBaselinesRef.current.set(
        sessionId,
        composerMutationRevision(sessionId),
      );
    },
    onSessionConflictRetrySuccess: ({ sessionId, message, contextIds }) => {
      const baselineRevision = sessionConflictRetryBaselinesRef.current.get(sessionId);
      sessionConflictRetryBaselinesRef.current.delete(sessionId);
      const isCurrentSession = effectiveTargetSessionIdRef.current === sessionId;
      const draft = isCurrentSession
        ? {
            value: inputValueRef.current,
            contexts: contextsRef.current,
          }
        : sessionComposerStore.getState().getDraft(sessionId);
      const cleanupTarget = baselineRevision !== undefined
        ? successfulRetryCleanupTarget(
            sessionId,
            effectiveTargetSessionIdRef.current,
            baselineRevision,
            composerMutationRevision(sessionId),
            draft.value,
            draft.contexts.map(context => context.id),
            message,
            contextIds,
          )
        : 'none';

      if (cleanupTarget === 'current') {
        clearContexts();
        clearPendingLargePastes();
        dispatchInput({ type: 'CLEAR_VALUE' });
        setQueuedInput(null);
      } else if (cleanupTarget === 'stored') {
        sessionComposerStore.getState().clearDraft(sessionId);
      }
    },
    currentAgentType: resolveChatInputSendAgentType({
      isSubagentTarget: isSubagentInputTarget,
      subagentType: effectiveTargetSession?.subagentType,
      sessionMode: effectiveTargetSession?.mode,
      acpTargetAgentType,
      // Composer mode is authoritative for normal sessions (synced from session
      // on switch, updated after an explicit mode change). Subagent continuations keep the
      // child session's own agent type instead of inheriting the parent composer.
      composerMode: modeState.current,
    }),
  });

  const consumedRegisteredDraftRef = useRef<{
    registrationId?: string;
    draftId: number;
  } | null>(null);
  React.useEffect(() => {
    const draft = registration?.draft;
    const consumed = consumedRegisteredDraftRef.current;
    if (
      !draft
      || (
        consumed
        && consumed.registrationId === registration?.registrationId
        && consumed.draftId === draft.id
      )
    ) {
      return;
    }

    consumedRegisteredDraftRef.current = {
      registrationId: registration?.registrationId,
      draftId: draft.id,
    };
    clearPendingLargePastes();
    replaceContexts([]);
    dispatchInput({ type: 'SET_VALUE', payload: draft.text });
    inputValueRef.current = draft.text;
    richTextInputRef.current?.focus();
    registration.onDraftConsumed?.(draft.id);
  }, [
    clearPendingLargePastes,
    dispatchInput,
    registration,
    replaceContexts,
  ]);

  const allocateLargePastePlaceholder = useCallback((charCount: number, excluded?: string): string => {
    const base = t('input.largePastePlaceholder', { count: charCount });
    let suffix = largePasteCountersRef.current[charCount] ?? 0;
    let placeholder: string;
    do {
      suffix += 1;
      placeholder = suffix === 1 ? base : `${base} #${suffix}`;
    } while (
      placeholder !== excluded
      && Object.prototype.hasOwnProperty.call(pendingLargePastesRef.current, placeholder)
    );
    largePasteCountersRef.current[charCount] = suffix;
    return placeholder;
  }, [t]);

  const createLargePastePlaceholder = useCallback((text: string): string | null => {
    const charCount = getCharacterCount(text);
    if (charCount <= CHAT_INPUT_CONFIG.largePaste.thresholdChars) {
      return null;
    }

    const placeholder = allocateLargePastePlaceholder(charCount);
    replacePendingLargePastes({
      ...pendingLargePastesRef.current,
      [placeholder]: text,
    });

    return placeholder;
  }, [allocateLargePastePlaceholder, replacePendingLargePastes]);

  const updateLargePaste = useCallback((placeholder: string, text: string): string => {
    const currentText = pendingLargePastesRef.current[placeholder];
    const charCount = getCharacterCount(text);
    const nextPlaceholder = currentText !== undefined && getCharacterCount(currentText) === charCount
      ? placeholder
      : allocateLargePastePlaceholder(charCount, placeholder);
    const nextPendingLargePastes = { ...pendingLargePastesRef.current };
    delete nextPendingLargePastes[placeholder];
    nextPendingLargePastes[nextPlaceholder] = text;
    replacePendingLargePastes(nextPendingLargePastes);
    return nextPlaceholder;
  }, [allocateLargePastePlaceholder, replacePendingLargePastes]);

  const removeLargePaste = useCallback((placeholder: string) => {
    if (!Object.prototype.hasOwnProperty.call(pendingLargePastesRef.current, placeholder)) return;
    const nextPendingLargePastes = { ...pendingLargePastesRef.current };
    delete nextPendingLargePastes[placeholder];
    replacePendingLargePastes(nextPendingLargePastes);
  }, [replacePendingLargePastes]);

  const prunePendingLargePastes = useCallback((text: string) => {
    const entries = Object.entries(pendingLargePastesRef.current);
    if (entries.length === 0) {
      return;
    }

    replacePendingLargePastes(Object.fromEntries(
      entries.filter(([placeholder]) => text.includes(placeholder))
    ));
  }, [replacePendingLargePastes]);

  const expandPendingLargePastes = useCallback((text: string) => {
    let expanded = text;
    for (const [placeholder, actual] of Object.entries(pendingLargePastesRef.current)) {
      if (expanded.includes(placeholder)) {
        expanded = expanded.split(placeholder).join(actual);
      }
    }
    return expanded;
  }, []);

  const expandComposerSpecialTokens = useCallback((text: string) => {
    return expandAdditionalModePromptReferenceTokens(
      expandWidgetPromptReferenceTokens(expandPendingLargePastes(text)),
    ).trim();
  }, [expandPendingLargePastes]);

  React.useEffect(() => {
    if (inputState.value === '') {
      clearPendingLargePastes();
    }
  }, [clearPendingLargePastes, inputState.value]);

  React.useEffect(() => {
    const handleFillInput = (event: Event) => {
      const customEvent = event as CustomEvent<{ message: string }>;
      const message = customEvent.detail?.message;
      
      if (message) {
        clearPendingLargePastes();
        dispatchInput({ type: 'SET_VALUE', payload: message });
        
        if (richTextInputRef.current) {
          richTextInputRef.current.focus();
        }
      }
    };

    window.addEventListener('fill-chat-input', handleFillInput);
    
    return () => {
      window.removeEventListener('fill-chat-input', handleFillInput);
    };
  }, [clearPendingLargePastes, dispatchInput]);

  React.useEffect(() => {
    const handleFillChatInput = (data: {
      content?: string;
      context?: ContextItem;
      /** Complete composer context replacement, including image attachments. */
      contexts?: ContextItem[];
      composerPresentation?: ComposerPresentation;
      onlyIfEmpty?: boolean;
      mode?: 'replace' | 'append';
      separator?: string;
    }) => {
      if (data.onlyIfEmpty && inputValueRef.current.trim().length > 0) {
        return;
      }

      if (data.context) {
        addContext(data.context);
        if (richTextInputRef.current) {
          const input = richTextInputRef.current as HTMLDivElement & {
            insertTag?: (context: ContextItem) => void;
          };
          input.focus();
          input.insertTag?.(data.context);
        }
        return;
      }

      const composerPresentation = parseComposerPresentation(data.composerPresentation);
      if (composerPresentation && data.mode !== 'append') {
        const restoredValue = composerPresentationToEditorText(composerPresentation);
        replaceContexts(data.contexts ?? composerPresentationContexts(composerPresentation));
        clearPendingLargePastes();
        dispatchInput({ type: 'SET_VALUE', payload: restoredValue });
        inputValueRef.current = restoredValue;
        richTextInputRef.current?.restoreComposerPresentation?.(composerPresentation);
        richTextInputRef.current?.focus();
        return;
      }

      const content = data.content ?? '';

      const nextValue =
        data.mode === 'append'
          ? (() => {
              const currentValue = inputValueRef.current;
              if (!currentValue.trim()) {
                return content;
              }

              const separator = data.separator ?? '\n\n';
              return `${currentValue.replace(/\s+$/, '')}${separator}${content.replace(/^\s+/, '')}`;
            })()
          : content;

      if (data.mode !== 'append') {
        clearPendingLargePastes();
        if (data.contexts) {
          replaceContexts(data.contexts);
        }
      }
      dispatchInput({ type: 'SET_VALUE', payload: nextValue });
      inputValueRef.current = nextValue;

      if (richTextInputRef.current) {
        richTextInputRef.current.focus();
      }
    };

    globalEventBus.on('fill-chat-input', handleFillChatInput);

    return () => {
      globalEventBus.off('fill-chat-input', handleFillChatInput);
    };
  }, [addContext, clearPendingLargePastes, dispatchInput, replaceContexts]);

  // Expose current input value for external queries (e.g. deep review fill-back confirmation)
  React.useEffect(() => {
    const handleGetChatInputState = (request: { getValue?: () => string }) => {
      request.getValue = () => inputValueRef.current;
    };

    globalEventBus.on('chat-input:get-state', handleGetChatInputState);

    return () => {
      globalEventBus.off('chat-input:get-state', handleGetChatInputState);
    };
  }, []);

  React.useEffect(() => {
    const configPath = 'app.flow_chat.show_permission_mode_control';
    let cancelled = false;
    const applyVisibility = (value: unknown) => {
      if (!cancelled) {
        setShowPermissionModeControl(value !== false);
      }
    };
    const loadVisibility = async () => {
      try {
        applyVisibility(await configManager.getOptionalConfig<boolean>(configPath));
      } catch (error) {
        log.warn('Failed to load permission mode control visibility preference', error);
        applyVisibility(true);
      }
    };

    void loadVisibility();
    const unsubscribe = configManager.onConfigChange((path, _oldValue, value) => {
      if (path === configPath) {
        applyVisibility(value);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const applyConfig = (config: ToolPermissionConfig) => {
      if (!cancelled) {
        setToolPermissionConfig(config);
      }
    };
    const loadConfig = async () => {
      applyConfig(await permissionConfigService.getConfig());
    };
    const handlePermissionConfigUpdated = (value?: ToolPermissionConfig) => {
      if (value) {
        applyConfig(normalizeToolPermissionConfig(value));
      } else {
        void loadConfig();
      }
    };

    void loadConfig();
    globalEventBus.on('permission:config:updated', handlePermissionConfigUpdated);
    return () => {
      cancelled = true;
      globalEventBus.off('permission:config:updated', handlePermissionConfigUpdated);
    };
  }, []);

  // Reconcile persistent session state and the exact active-turn override.
  // A request generation prevents a late response from a previous session or
  // completed turn from repainting the current control.
  React.useEffect(() => {
    const generation = ++permissionModeRequestGenerationRef.current;
    const previous = permissionModeLifecycleRef.current;
    const sessionChanged = previous.sessionId !== effectiveTargetSessionId;
    const activeTurnChanged = previous.activeTurnId !== activePermissionTurnId;
    permissionModeLifecycleRef.current = {
      sessionId: effectiveTargetSessionId,
      activeTurnId: activePermissionTurnId,
    };

    if (sessionChanged) {
      setArmedTurnPermissionMode(null);
      setActiveTurnPermissionMode(null);
    } else if (activeTurnChanged) {
      // A locally submitted one-off becomes the active turn's initial mode.
      // Keep it armed until start_dialog_turn acknowledges so a failed send
      // can still be retried with the user's selection.
      setActiveTurnPermissionMode(
        activePermissionTurnId ? armedTurnPermissionModeRef.current : null,
      );
    }

    if (!effectiveTargetSessionId || isAcpTargetSession) {
      setSessionPermissionMode(null);
      setArmedTurnPermissionMode(null);
      setActiveTurnPermissionMode(null);
      return undefined;
    }
    void (async () => {
      try {
        const response = await agentAPI.getSessionPermissionMode({
          sessionId: effectiveTargetSessionId,
          turnId: activePermissionTurnId ?? undefined,
          workspacePath: effectiveTargetSession?.workspacePath,
          remoteConnectionId: effectiveTargetSession?.remoteConnectionId,
          remoteSshHost: effectiveTargetSession?.remoteSshHost,
        });
        if (permissionModeRequestGenerationRef.current !== generation) return;
        setSessionPermissionMode(response.mode ?? null);
        if (activePermissionTurnId && response.activeTurnId === activePermissionTurnId) {
          setActiveTurnPermissionMode(response.turnMode ?? null);
        }
      } catch (error) {
        log.warn('Failed to read session permission mode', error);
        // Falling back to the global default is the safe read: it never shows a
        // wider mode than the session actually runs with.
        if (permissionModeRequestGenerationRef.current === generation) {
          setSessionPermissionMode(null);
        }
      }
    })();
    return undefined;
  }, [
    activePermissionTurnId,
    effectiveTargetSessionId,
    effectiveTargetSession?.workspacePath,
    effectiveTargetSession?.remoteConnectionId,
    effectiveTargetSession?.remoteSshHost,
    isAcpTargetSession,
  ]);

  const applySessionPermissionMode = useCallback(async (
    nextMode: SessionPermissionMode | null,
  ) => {
    if (!effectiveTargetSessionId) {
      notificationService.error(t('chatInput.permissionMode.noSession'));
      return;
    }
    const targetSessionId = effectiveTargetSessionId;
    const targetTurnId = activePermissionTurnIdRef.current;
    const generation = ++permissionModeRequestGenerationRef.current;
    const previousMode = sessionPermissionMode;
    const previousActiveTurnMode = activeTurnPermissionMode;
    setSessionPermissionMode(nextMode);
    setArmedTurnPermissionMode(null);
    setActiveTurnPermissionMode(null);
    setPermissionModeSaving(true);
    try {
      const response = await agentAPI.updateSessionPermissionMode({
        sessionId: targetSessionId,
        mode: nextMode,
        turnId: targetTurnId ?? undefined,
        workspacePath: effectiveTargetSession?.workspacePath,
        remoteConnectionId: effectiveTargetSession?.remoteConnectionId,
        remoteSshHost: effectiveTargetSession?.remoteSshHost,
      });
      if (
        permissionModeRequestGenerationRef.current === generation
        && effectiveTargetSessionIdRef.current === targetSessionId
      ) {
        setSessionPermissionMode(response.mode ?? null);
        setActiveTurnPermissionMode(null);
      }
    } catch (error) {
      log.error('Failed to change session permission mode', error);
      if (
        permissionModeRequestGenerationRef.current === generation
        && effectiveTargetSessionIdRef.current === targetSessionId
      ) {
        setSessionPermissionMode(previousMode);
        if (activePermissionTurnIdRef.current === targetTurnId) {
          setActiveTurnPermissionMode(previousActiveTurnMode);
        }
        notificationService.error(t('chatInput.permissionMode.changeFailed'));
      }
    } finally {
      setPermissionModeSaving(false);
    }
  }, [
    effectiveTargetSessionId,
    effectiveTargetSession?.workspacePath,
    effectiveTargetSession?.remoteConnectionId,
    effectiveTargetSession?.remoteSshHost,
    activeTurnPermissionMode,
    sessionPermissionMode,
    t,
  ]);

  // Full access is the one mode worth a confirmation in either scope: a
  // one-off turn still runs every tool without asking.
  const confirmFullAccessIfNeeded = useCallback(async (
    nextMode: Exclude<ChatInputPermissionMode, 'acp'>,
    scope: 'session' | 'next-turn' | 'active-turn',
  ) => {
    if (nextMode !== 'full_access') return true;
    return confirmDanger(
      t('chatInput.permissionMode.fullAccessWarningTitle'),
      t(scope === 'active-turn'
        ? 'chatInput.permissionMode.fullAccessWarningMessageActiveTurn'
        : scope === 'next-turn'
          ? 'chatInput.permissionMode.fullAccessWarningMessageNextTurn'
          : 'chatInput.permissionMode.fullAccessWarningMessage'),
      {
        confirmText: t('chatInput.permissionMode.fullAccessConfirm'),
        cancelText: t('chatInput.permissionMode.cancel'),
      },
    );
  }, [t]);

  /** Writes the session's own mode. */
  const handlePermissionModeChange = useCallback(async (
    nextMode: Exclude<ChatInputPermissionMode, 'acp'>,
  ) => {
    if (permissionModeSaving || isAcpTargetSession) return;
    if (!(await confirmFullAccessIfNeeded(nextMode, 'session'))) return;
    const backendMode = toBackendPermissionMode(
      nextMode as Exclude<ChatInputPermissionMode, 'acp' | 'reject'>,
    );
    await applySessionPermissionMode(backendMode);
  }, [
    applySessionPermissionMode,
    confirmFullAccessIfNeeded,
    isAcpTargetSession,
    permissionModeSaving,
  ]);

  /** Updates the active turn when one exists; otherwise arms the next send. */
  const handlePermissionModeForNextTurn = useCallback(async (
    nextMode: Exclude<ChatInputPermissionMode, 'acp'>,
  ) => {
    if (permissionModeSaving || isAcpTargetSession) return;
    const backendMode = toBackendPermissionMode(
      nextMode as Exclude<ChatInputPermissionMode, 'acp' | 'reject'>,
    );
    const targetTurnId = activePermissionTurnIdRef.current;
    const currentMode = targetTurnId
      ? activeTurnPermissionMode
      : armedTurnPermissionMode;
    const nextTemporaryMode = currentMode === backendMode ? null : backendMode;
    if (
      nextTemporaryMode === 'full_access'
      && !(await confirmFullAccessIfNeeded(
        nextMode,
        targetTurnId ? 'active-turn' : 'next-turn',
      ))
    ) return;
    if (
      activePermissionTurnIdRef.current !== targetTurnId
      || effectiveTargetSessionIdRef.current !== effectiveTargetSessionId
    ) return;

    if (!targetTurnId) {
      setArmedTurnPermissionMode(nextTemporaryMode);
      return;
    }
    if (!effectiveTargetSessionId) return;

    const targetSessionId = effectiveTargetSessionId;
    const generation = ++permissionModeRequestGenerationRef.current;
    const previousMode = activeTurnPermissionMode;
    setActiveTurnPermissionMode(nextTemporaryMode);
    setPermissionModeSaving(true);
    try {
      const response = await agentAPI.updateActiveTurnPermissionMode({
        sessionId: targetSessionId,
        turnId: targetTurnId,
        mode: nextTemporaryMode,
        workspacePath: effectiveTargetSession?.workspacePath,
        remoteConnectionId: effectiveTargetSession?.remoteConnectionId,
        remoteSshHost: effectiveTargetSession?.remoteSshHost,
      });
      if (
        permissionModeRequestGenerationRef.current === generation
        && effectiveTargetSessionIdRef.current === targetSessionId
        && activePermissionTurnIdRef.current === targetTurnId
      ) {
        setSessionPermissionMode(response.mode ?? null);
        setActiveTurnPermissionMode(response.turnMode ?? null);
      }
    } catch (error) {
      log.error('Failed to change active turn permission mode', error);
      if (
        permissionModeRequestGenerationRef.current === generation
        && effectiveTargetSessionIdRef.current === targetSessionId
        && activePermissionTurnIdRef.current === targetTurnId
      ) {
        setActiveTurnPermissionMode(previousMode);
        notificationService.error(t('chatInput.permissionMode.changeFailed'));
      }
    } finally {
      setPermissionModeSaving(false);
    }
  }, [
    activeTurnPermissionMode,
    armedTurnPermissionMode,
    confirmFullAccessIfNeeded,
    effectiveTargetSession?.remoteConnectionId,
    effectiveTargetSession?.remoteSshHost,
    effectiveTargetSession?.workspacePath,
    effectiveTargetSessionId,
    isAcpTargetSession,
    permissionModeSaving,
    t,
  ]);

  // The reset row follows the user-level default, so give it a way to reach the
  // page that owns that default instead of making the user hunt for it.
  const handleOpenPermissionDefaultSettings = useCallback(() => {
    useSettingsStore.getState().openPage('tools.execution');
    openScene('settings');
  }, [openScene]);

  const handleResetPermissionModeToDefault = useCallback(async () => {
    if (permissionModeSaving || isAcpTargetSession) return;
    if (sessionPermissionMode === null && temporaryPermissionMode === null) return;
    await applySessionPermissionMode(null);
  }, [
    applySessionPermissionMode,
    isAcpTargetSession,
    permissionModeSaving,
    sessionPermissionMode,
    temporaryPermissionMode,
  ]);

  const dispatchPermissionMode: ChatInputPermissionMode =
    permissionModeFromDispatchApprovalPolicy(
      effectiveTargetSession?.config.dispatchApprovalPolicy,
    );
  const dispatchSubmissionOptionsLocked = caps.submissionOptionsLocked;
  const handleDispatchPermissionModeChange = useCallback((
    nextMode: Exclude<ChatInputPermissionMode, 'acp'>,
  ) => {
    if (!effectiveTargetSessionId || dispatchSubmissionOptionsLocked) {
      return;
    }
    const approvalPolicy = dispatchApprovalPolicyFromPermissionMode(nextMode);
    FlowChatStore.getInstance().updateSessionDispatchApprovalPolicy(
      effectiveTargetSessionId,
      approvalPolicy,
    );
    const jobId = effectiveTargetSession?.config.dispatchJobId;
    if (jobId) {
      dispatchJobStore.getState().updateApprovalPolicy(jobId, approvalPolicy);
    }
  }, [
    dispatchSubmissionOptionsLocked,
    effectiveTargetSession?.config.dispatchJobId,
    effectiveTargetSessionId,
  ]);

  /**
   * Checking worktree isolation only arms the empty session. The first prompt
   * materializes the worktree after it has visibly been submitted.
   */
  const remoteWorkspaceSession =
    isRemoteWorkspaceSession(effectiveTargetSession, workspace);

  const worktreeControl = useMemo(() => {
    if (!effectiveTargetSessionId || !effectiveTargetSession) return undefined;
    if (remoteWorkspaceSession) return undefined;
    if (isSubagentInputTarget || isAcpTargetSession) return undefined;
    // A dispatch always executes against a managed worktree baseline of this
    // repository, so the chip reports that state instead of disappearing. It is
    // never togglable: the baseline is chosen with the target, not after.
    if (caps.worktreeBaselineLocked) {
      return {
        enabled: true,
        locked: true,
        lockedReason: 'dispatch' as const,
        onChange: () => {},
      };
    }

    const locked = isSessionWorktreeBindingLocked(
      effectiveTargetSession,
      !!derivedState?.isProcessing,
    );

    return {
      enabled: isSessionWorktreeIsolationEnabled(effectiveTargetSession),
      locked,
      onChange: (enabled: boolean) => {
        const latestSession = FlowChatStore.getInstance()
          .getState()
          .sessions
          .get(effectiveTargetSessionId);
        if (
          !latestSession
          || isSessionWorktreeBindingLocked(latestSession, false)
        ) {
          notificationService.error(tWorktrees('strip.toggleLocked'));
          return;
        }
        FlowChatStore.getInstance().setSessionWorktreeIsolationRequested(
          effectiveTargetSessionId,
          enabled,
        );
      },
    };
  }, [
    effectiveTargetSession,
    effectiveTargetSessionId,
    derivedState?.isProcessing,
    isAcpTargetSession,
    isSubagentInputTarget,
    remoteWorkspaceSession,
    tWorktrees,
    caps.worktreeBaselineLocked,
  ]);

  const handleSelectDispatchTarget = useCallback(async (selection: DispatchSelection) => {
    try {
      await FlowChatManager.getInstance().createChatSession(
        {
          ...flowChatSessionConfigForCurrentWorkspace(workspace),
          dispatchTargetRequest: selection.request,
          dispatchTarget: selection.target,
          // Not asked for while picking a target: a dispatch session starts on
          // the same permission default a local session here would, and the
          // composer strip stays the one place to change it.
          dispatchApprovalPolicy: dispatchApprovalPolicyFromPermissionMode(
            permissionMode === 'acp' ? 'ask' : permissionMode,
          ),
          dispatchIncludeUncommitted: selection.includeUncommitted,
          dispatchBaseRef: selection.baseRef,
          // Undefined is intentional: the target's probed default model wins
          // until the composer's model picker records an explicit choice.
          dispatchModel: selection.model,
          dispatchModelCatalog: selection.modelCatalog,
          dispatchAvailableModels: selection.availableModels,
          dispatchDefaultModel: selection.defaultModel,
        },
        effectiveSendAgentType,
      );
    } catch (error) {
      log.error('Failed to create dispatched session projection', { error });
      notificationService.error(t('chatInput.dispatch.createFailed'));
    }
  }, [effectiveSendAgentType, permissionMode, t, workspace]);

  const harnessProfileLocked = effectiveTargetSessionStarted;
  const dispatchControl = useMemo(() => {
    if (
      registration ||
      isBtwSession ||
      isSubagentInputTarget ||
      isAcpInputSession ||
      remoteWorkspaceSession
    ) {
      return undefined;
    }
    const target: DispatchTarget =
      effectiveTargetSession?.config.dispatchTarget ?? { kind: 'local' };
    // Syncing is available as soon as the target has a worktree to commit —
    // that is, from the moment the job starts running. Waiting for a terminal
    // state would block the common "let me see what it has so far" case.
    const jobId = effectiveTargetSession?.config.dispatchJobId;
    const jobState = effectiveTargetSession?.config.dispatchJobState;
    const syncableJobId =
      isNonLocalDispatchTarget(target)
      && jobId
      && (jobState === 'running'
        || jobState === 'succeeded'
        || jobState === 'failed'
        || jobState === 'cancelled')
        ? jobId
        : undefined;
    return {
      target,
      sourceWorkspacePath: workspacePath || undefined,
      locked:
        isNonLocalDispatchTarget(target) ||
        effectiveTargetSessionHasTurns ||
        !!derivedState?.isProcessing,
      onSelectTarget: handleSelectDispatchTarget,
      syncableJobId,
      branch: dispatchObserverJob?.branch,
      baselineWorktreePath: dispatchObserverJob?.baselineWorktreePath,
      baselineMissing: dispatchObserverJob?.baselineWorktreeMissing,
    };
  }, [
    derivedState?.isProcessing,
    effectiveTargetSession?.config.dispatchJobId,
    effectiveTargetSession?.config.dispatchJobState,
    effectiveTargetSession?.config.dispatchTarget,
    effectiveTargetSessionHasTurns,
    dispatchObserverJob?.baselineWorktreeMissing,
    dispatchObserverJob?.baselineWorktreePath,
    dispatchObserverJob?.branch,
    handleSelectDispatchTarget,
    isAcpInputSession,
    isBtwSession,
    isSubagentInputTarget,
    registration,
    remoteWorkspaceSession,
    workspacePath,
  ]);

  const dispatchModelSelection = useMemo(() => {
    if (!caps.targetModelSelection || !effectiveTargetSession) {
      return undefined;
    }
    const target = effectiveTargetSession.config.dispatchTarget;
    const providerLabel =
      target && target.kind !== 'local'
        ? target.displayName
        : t('chatInput.dispatch.remoteTarget');
    const sessionId = effectiveTargetSession.sessionId;
    const jobId = effectiveTargetSession.config.dispatchJobId;
    return {
      models: effectiveTargetSession.config.dispatchAvailableModels ?? [],
      selectedModelId: effectiveTargetSession.config.dispatchModel,
      defaultModelId: effectiveTargetSession.config.dispatchDefaultModel,
      reasoningCatalog: effectiveTargetSession.config.dispatchModelCatalog,
      selectedReasoningPreset: effectiveTargetSession.config.dispatchReasoningPreset,
      // The probe snapshot above is a starting point, not the offer. Dispatch
      // changes where a session runs, not which models this device has, and
      // submission brings the target up to whatever is chosen here — so the
      // picker offers the local catalog exactly as a local session would, and
      // survives a projection restored without that snapshot.
      includeLocalCatalog: true,
      providerLabel,
      disabled: caps.submissionOptionsLocked,
      onSelect: (modelId: string) => {
        FlowChatStore.getInstance().updateSessionDispatchModel(sessionId, modelId);
        if (jobId) {
          dispatchJobStore.getState().updateModel(jobId, modelId);
        }
      },
      onSelectReasoningPreset: (presetId: string | null) => {
        const normalizedPreset = presetId?.trim() || 'auto';
        FlowChatStore.getInstance().updateSessionDispatchReasoningPreset(
          sessionId,
          normalizedPreset,
        );
        if (jobId) {
          dispatchJobStore.getState().updateReasoningPreset(jobId, normalizedPreset);
        }
      },
    };
  }, [caps.submissionOptionsLocked, caps.targetModelSelection, effectiveTargetSession, t]);

  React.useEffect(() => {
    if (!slashCommandState.isActive || slashCommandState.kind !== 'all' || derivedState?.isProcessing) {
      return;
    }

    void loadMcpPromptCommands();
  }, [derivedState?.isProcessing, loadMcpPromptCommands, slashCommandState.isActive, slashCommandState.kind]);

  // Stable ref so the mcp-app:message handler can read the latest value without
  // being included in the effect's dependency array (prevents rapid listener
  // teardown/re-registration on every keystroke or streaming update).
  const inputStateValueRef = React.useRef(inputState.value);
  React.useEffect(() => {
    inputStateValueRef.current = inputState.value;
  });

  // Handle MCP App ui/message requests (aligned with VSCode behavior)
  React.useEffect(() => {
    const handleMcpAppMessage = async (event: import('@/infrastructure/api/service-api/MCPAPI').McpAppMessageEvent) => {
      const { requestId, params } = event;

      // Don't fill if input already has content (aligned with VSCode behavior)
      if (inputStateValueRef.current.trim()) {
        log.warn('MCP App ui/message rejected: input already has content');
        // Send error response (VSCode returns { isError: true } in this case)
        globalEventBus.emit('mcp-app:message-response', {
          requestId,
          result: { isError: true }
        } as import('@/infrastructure/api/service-api/MCPAPI').McpAppMessageResponseEvent);
        return;
      }

      try {
        // Extract text content and set input
        const textContent = params.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n\n');

        if (textContent) {
          clearPendingLargePastes();
          dispatchInput({ type: 'SET_VALUE', payload: textContent });
        }

        // Handle image attachments (respect max image limit)
        let imgCount = currentImageCount;
        for (const block of params.content) {
          if (block.type === 'image') {
            if (imgCount >= CHAT_INPUT_CONFIG.image.maxCount) break;
            try {
              const mimeType = block.mimeType || 'image/png';
              const binaryString = atob(block.data);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }
              const blob = new Blob([bytes], { type: mimeType });
              const file = new File([blob], `image.${mimeType.split('/')[1] || 'png'}`, { type: mimeType });
              const imageContext = await createImageContextFromClipboard(file);
              addContext(imageContext);
              imgCount++;
            } catch (err) {
              log.error('Failed to add image from MCP App message', { err });
            }
          }
        }

        // Focus input
        if (richTextInputRef.current) {
          richTextInputRef.current.focus();
        }

        // Send success response
        globalEventBus.emit('mcp-app:message-response', {
          requestId,
          result: { isError: false }
        } as import('@/infrastructure/api/service-api/MCPAPI').McpAppMessageResponseEvent);
      } catch (err) {
        log.error('Failed to handle MCP App ui/message', { err });
        // Send error response
        globalEventBus.emit('mcp-app:message-response', {
          requestId,
          result: { isError: true }
        } as import('@/infrastructure/api/service-api/MCPAPI').McpAppMessageResponseEvent);
      }
    };

    globalEventBus.on('mcp-app:message', handleMcpAppMessage);

    return () => {
      globalEventBus.off('mcp-app:message', handleMcpAppMessage);
    };
  }, [addContext, clearPendingLargePastes, currentImageCount, dispatchInput]);

  React.useEffect(() => {
    const handleInsertContextTag = (event: Event) => {
      const customEvent = event as CustomEvent<{ context: any }>;
      const context = customEvent.detail?.context;
      
      if (context) {
        setTimeout(() => {
          if (richTextInputRef.current && (richTextInputRef.current as any).insertTag) {
            const el = richTextInputRef.current;
            if (!el.textContent?.trim() && !el.querySelector('[data-context-id]')) {
              el.innerHTML = '';
            }
            el.focus();
            const sel = window.getSelection();
            if (sel) {
              sel.selectAllChildren(el);
              sel.collapseToEnd();
            }
            (el as any).insertTag(context);
          }
        }, 50);
      }
    };

    window.addEventListener('insert-context-tag', handleInsertContextTag);
    
    return () => {
      window.removeEventListener('insert-context-tag', handleInsertContextTag);
    };
  }, []);

  const refreshWorkspaceModeCatalog = useWorkspaceModeCatalog(
    {
      workspacePath: targetWorkspacePath || undefined,
      remoteConnectionId:
        effectiveTargetSession?.remoteConnectionId ||
        effectiveTargetSession?.config.remoteConnectionId,
      remoteSshHost:
        effectiveTargetSession?.remoteSshHost || effectiveTargetSession?.config.remoteSshHost,
    },
    modes => {
      dispatchMode({ type: 'SET_AVAILABLE_MODES', payload: modes });
    },
  );

  React.useEffect(() => {
    let cancelled = false;

    const publishPreference = (
      preference: Awaited<ReturnType<typeof chatInputModePreferenceService.getPreference>>,
    ) => {
      if (!cancelled) {
        setUserDefaultModeId(resolveConfiguredChatInputDefaultModeId(preference));
      }
    };

    void chatInputModePreferenceService.getPreference()
      .then(publishPreference)
      .catch(error => {
        log.warn('Failed to load default chat input mode preference', { error });
      });
    const unsubscribe = chatInputModePreferenceService.subscribe(
      publishPreference,
      error => {
        log.warn('Failed to refresh default chat input mode preference', { error });
      },
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  React.useEffect(() => {
    const handleSessionSwitched = (event: Event) => {
      const customEvent = event as CustomEvent<{ sessionId: string; mode: string }>;
      const { sessionId, mode } = customEvent.detail || {};
      
      if (sessionId && mode) {
        log.debug('Session switched, syncing mode', { sessionId, mode });
        dispatchMode({ type: 'SET_CURRENT_MODE', payload: mode });
      }
    };

    window.addEventListener('openbitfun:session-switched', handleSessionSwitched);
    
    return () => {
      window.removeEventListener('openbitfun:session-switched', handleSessionSwitched);
    };
  }, []);

  React.useEffect(() => {
    const suppressedUserDefaultApplication = suppressNextUserDefaultModeApplicationRef.current;
    const userDefaultModeForResolution = suppressedUserDefaultApplication
      ? null
      : userDefaultModeId;
    const nextMode = resolveAvailableChatInputMode({
      currentMode,
      isAssistantWorkspace,
      sessionMode: activeSessionMode,
      userDefaultModeId: userDefaultModeForResolution,
      availableModeIds,
    });
    suppressNextUserDefaultModeApplicationRef.current = false;

    if (nextMode && nextMode !== currentMode) {
      log.debug('Syncing mode with workspace, session, and available modes', {
        sessionId: effectiveTargetSessionId,
        mode: nextMode,
        sessionMode: activeSessionMode,
        isAssistantWorkspace,
        availableModeCount: availableModeIds.size,
      });
      const publishModeSelection = publishModeSelectionRef.current;
      if (publishModeSelection) {
        publishModeSelection(nextMode);
      } else {
        dispatchMode({ type: 'SET_CURRENT_MODE', payload: nextMode });
      }
    }
  }, [
    activeSessionMode,
    availableModeIds,
    currentMode,
    effectiveTargetSessionId,
    isAssistantWorkspace,
    userDefaultModeId,
  ]);

  React.useEffect(() => {
    const queuedInput = derivedState?.queuedInput;
    if (!queuedInput?.trim() || !effectiveTargetSessionId) {
      return;
    }
    // Sync machine queue into the input (e.g. failed turn restored by EventHandlerModule).
    // `queuedInput` is cleared on successful send via `setQueuedInput(null)` so we do not fight CLEAR_VALUE.
    // Use inputValueRef (not inputState.value) so this effect only re-runs when the machine's
    // queuedInput actually changes — not on every keystroke — avoiding the race condition where
    // a stale queuedInput would overwrite what the user is currently typing.
    const currentValue = inputValueRef.current;
    if (currentValue !== queuedInput && !currentValue.trim()) {
      // Only restore when the input is empty: this effect is for failure-recovery
      // (EventHandlerModule sets queuedInput on failed turns), NOT for live typing.
      // Restoring while the user is actively typing would overwrite their draft.
      log.debug('Detected queuedInput, restoring message to input', { queuedInput });
      // Keep the session-scoped paste map restored with this draft. Remote and
      // detached submissions must still expand placeholders before transport.
      dispatchInput({ type: 'SET_VALUE', payload: queuedInput });
      inputValueRef.current = queuedInput;
      if (richTextInputRef.current) {
        richTextInputRef.current.focus();
      }
    }
  }, [
    derivedState?.queuedInput,
    effectiveTargetSessionId,
    dispatchInput,
  ]);

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (agentBoostRef.current?.contains(target) || boostMenuRef.current?.contains(target)) return;
      dispatchMode({ type: 'CLOSE_DROPDOWN' });
    };

    if (modeState.dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [modeState.dropdownOpen]);

  React.useEffect(() => {
    if (!effectiveTargetSessionId || !sessionBoundWorkspacePath) {
      return;
    }

    const store = FlowChatStore.getInstance();
    const state = store.getState();
    const session = state.sessions.get(effectiveTargetSessionId);

    if (!session || session.dialogTurns.length === 0) {
      return;
    }

    const lastTurn = session.dialogTurns[session.dialogTurns.length - 1];
    
    if (lastTurn.status === 'completed') {
      const modifiedFiles = collectModifiedFilePathsFromTurns(
        [lastTurn],
        undefined,
        sessionBoundWorkspacePath,
      );

      if (modifiedFiles.length > 0) {
        log.debug('File modifications detected, updating recommendation context', { modifiedFiles });
        setRecommendationContext({
          workspacePath: sessionBoundWorkspacePath,
          sessionId: effectiveTargetSessionId,
          turnId: lastTurn.id,
          modifiedFiles,
        });
      }
    }
  }, [effectiveTargetSessionId, sessionBoundWorkspacePath, derivedState?.isProcessing]);

  const getFilteredActions = useCallback(() => {
    if (isAcpInputSession) {
      return [];
    }

    const items: SlashActionItem[] = [
      ...(isPrimarySlashActionVisible({ actionId: 'btw', isBtwSession, canLaunchReview })
        ? [{
            kind: 'action' as const,
            id: 'btw' as const,
            command: '/btw',
            label: t('btw.title'),
          }]
        : []),
      ...(isPrimarySlashActionVisible({ actionId: 'review', isBtwSession, canLaunchReview })
        ? [{
            kind: 'action' as const,
            id: 'review' as const,
            command: '/review',
            label: t('chatInput.reviewAction'),
          }]
        : []),
      ...(canUseThreadGoal
        ? [{
            kind: 'action' as const,
            id: 'goal' as const,
            command: '/goal',
            label: t('chatInput.goalAction'),
          }]
        : []),
      {
        kind: 'action',
        id: 'usage' as const,
        command: '/usage',
        label: t('chatInput.usageAction'),
      },
      ...(canReloadContext
        ? [{
            kind: 'action' as const,
            id: 'reload' as const,
            command: '/reload',
            label: t('chatInput.reloadAction'),
          }]
        : []),
      ...(!derivedState?.isProcessing
        ? [
            {
              kind: 'action' as const,
              id: 'compact' as const,
              command: '/compact',
              label: t('chatInput.compactAction'),
            },
            {
              kind: 'action' as const,
              id: 'init' as const,
              command: '/init',
              label: t('chatInput.initAction'),
            },
          ]
        : []),
    ];
    const q = (slashCommandState.query || '').trim().toLowerCase();
    // The picker offers exactly what this session can execute. Without this,
    // an unsupported command picked from the list falls through the per-op
    // submit gates and is sent to the agent as literal prompt text.
    const visibleItems = items.filter(item =>
      (item.id === 'reload' || caps.ops.has(item.id))
      && isChatInputActionVisibleForTarget({
        actionId: item.id,
        isSubagentTarget: isSubagentInputTarget,
      }));
    if (!q) return visibleItems;

    return visibleItems.filter(i => {
      const cmd = i.command.slice(1).toLowerCase();
      return cmd.includes(q) || i.label.toLowerCase().includes(q);
    });
  }, [canLaunchReview, canReloadContext, canUseThreadGoal, caps.ops, derivedState?.isProcessing, isAcpInputSession, isBtwSession, isSubagentInputTarget, slashCommandState.query, t]);

  const getFilteredMcpPromptCommands = useCallback((): SlashMcpPromptItem[] => {
    if (isAcpInputSession) {
      return [];
    }

    const q = (slashCommandState.query || '').trim().toLowerCase();
    if (!q) {
      return mcpPromptCommands;
    }

    return mcpPromptCommands.filter(item => {
      const commandToken = item.command.slice(1).toLowerCase();
      return (
        commandToken.includes(q) ||
        item.serverName.toLowerCase().includes(q) ||
        item.label.toLowerCase().includes(q)
      );
    });
  }, [isAcpInputSession, mcpPromptCommands, slashCommandState.query]);

  const getFilteredExternalPromptCommands = useCallback((): SlashExternalPromptCommandItem[] => {
    if (isAcpInputSession
      || derivedState?.isProcessing
      || (inlineTriggerState.isActive && inlineTriggerState.startOffset > 0)) {
      return [];
    }
    const q = (slashCommandState.query || '').trim().toLowerCase();
    if (!q) {
      return externalPromptCommands;
    }
    return externalPromptCommands.filter(item =>
      item.command.slice(1).toLowerCase().includes(q)
        || item.label.toLowerCase().includes(q));
  }, [derivedState?.isProcessing, externalPromptCommands, inlineTriggerState, isAcpInputSession, slashCommandState.query]);

  const getFilteredAcpCommands = useCallback((): SlashAcpCommandItem[] => {
    return filterSlashCommands(acpAgentCommands, slashCommandState.query).map(command => ({
      kind: 'acpCommand',
      id: command.name,
      command: `/${command.name}`,
      label: command.description,
    }));
  }, [acpAgentCommands, slashCommandState.query]);

  const getFilteredSkills = useCallback((): SlashSkillItem[] => {
    if (!canUseSkillsForTarget) {
      return [];
    }

    const q = (slashCommandState.query || '').trim().toLowerCase();
    const seenKeys = new Set<string>();
    return userInvocableSkills
      .filter(skill => {
        const normalizedName = skill.name.trim();
        const normalizedNameKey = normalizedName.toLowerCase();
        if (!normalizedName || seenKeys.has(skill.key)) {
          return false;
        }
        if (!isSlashAddressableSkillName(normalizedName)) {
          return false;
        }

        const matches =
          !q ||
          normalizedNameKey.includes(q) ||
          skill.description.toLowerCase().includes(q);
        if (matches) {
          seenKeys.add(skill.key);
        }
        return matches;
      })
      .map(skill => ({
        kind: 'skill' as const,
        id: skill.key,
        command: `/${skill.name}`,
        label: [skill.argumentHint?.trim(), skill.description || skill.name]
          .filter(Boolean)
          .join(' — '),
        skillName: skill.name,
      }))
      .sort((a, b) => {
        const aName = a.skillName.toLowerCase();
        const bName = b.skillName.toLowerCase();
        const aExact = aName === q ? 0 : aName.startsWith(q) ? 1 : 2;
        const bExact = bName === q ? 0 : bName.startsWith(q) ? 1 : 2;
        return aExact - bExact || aName.localeCompare(bName);
      });
  }, [canUseSkillsForTarget, slashCommandState.query, userInvocableSkills]);

  const resolveTypedMcpPromptCommand = useCallback((text: string): SlashMcpPromptItem | null => {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) {
      return null;
    }

    const token = trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase() || '';
    if (!token) {
      return null;
    }

    return (
      mcpPromptCommands.find(item => item.command.slice(1).toLowerCase() === token) || null
    );
  }, [mcpPromptCommands]);

  const getSlashPickerItems = useCallback((): SlashPickerItem[] => {
    const acpCommands = getFilteredAcpCommands();
    if (isAcpInputSession) {
      return acpCommands;
    }

    const actions = getFilteredActions();
    const externalCommands = getFilteredExternalPromptCommands();
    const mcpPrompts = getFilteredMcpPromptCommands();
    const skills = getFilteredSkills();
    return [...acpCommands, ...actions, ...externalCommands, ...mcpPrompts, ...skills];
  }, [getFilteredActions, getFilteredAcpCommands, getFilteredExternalPromptCommands, getFilteredMcpPromptCommands, getFilteredSkills, isAcpInputSession]);

  const getActiveSlashPickerItems = useCallback((): SlashPickerItem[] => {
    if (slashCommandState.kind === 'actions') {
      return getFilteredActions();
    }
    if (slashCommandState.kind === 'skills') {
      return getFilteredSkills();
    }
    return getSlashPickerItems();
  }, [getFilteredActions, getFilteredSkills, getSlashPickerItems, slashCommandState.kind]);
  
  const handleInputChange = useCallback((text: string, activeContexts: import('../../shared/types/context').ContextItem[]) => {
    const activeContextIds = new Set(activeContexts.map(context => context.id));
    contexts.forEach(context => {
      // Image contexts are not represented by inline tag pills inside the
      // editor; they live in a separate thumbnail strip and are removed via
      // their own × button. Skip them when reconciling against editor tags.
      if (context.type === 'image') return;
      if (!activeContextIds.has(context.id)) {
        removeContext(context.id);
      }
    });
    
    prunePendingLargePastes(text);
    dispatchInput({ type: 'SET_VALUE', payload: text });
    inputValueRef.current = text;

    if (selectedExternalPromptCandidateId) {
      const selected = externalPromptCommands.find(
        item => item.candidateId === selectedExternalPromptCandidateId,
      );
      if (!selected || !isSlashCommand(text.trim(), selected.command as `/${string}`)) {
        setSelectedExternalPromptCandidateId(undefined);
      }
    }
    if (selectedNonExternalSlashCommand
      && !isSlashCommand(text.trim(), selectedNonExternalSlashCommand as `/${string}`)) {
      setSelectedNonExternalSlashCommand(undefined);
      setSelectedNonExternalSlashCandidateId(undefined);
    }

    const promptSlashCommandsEnabled = !isAcpInputSession;
    const localSlashCommandsEnabled = promptSlashCommandsEnabled && caps.localSlashCommands;
    const trimmed = text.trim();
    const isBtwCommand =
      promptSlashCommandsEnabled && caps.ops.has('btw') && isSlashCommand(trimmed, '/btw');
    const isCompactCommand =
      promptSlashCommandsEnabled && caps.ops.has('compact') && isSlashCommand(trimmed, '/compact');
    const isGoalCommand =
      promptSlashCommandsEnabled && canUseThreadGoal && isGoalSlashCommand(text);
    const isUsageCommand =
      promptSlashCommandsEnabled && caps.ops.has('usage') && isSlashCommand(trimmed, '/usage');
    const isReviewCommand =
      promptSlashCommandsEnabled && caps.ops.has('review') && isReviewSlashCommand(text);
    const isProcessing = !!derivedState?.isProcessing;

    // Don't queue /btw or /goal while the main session is processing; they have dedicated flows.
    if (derivedState?.isProcessing && !isBtwCommand && !isGoalCommand && !isCompactCommand && !isUsageCommand && !isReviewCommand) {
      setQueuedInput(text);
    }

    if (text.startsWith('/')) {
      const afterSlash = text.slice(1);
      const hasWhitespace = /\s/.test(afterSlash);
      const pickerQuery = getSlashCommandPickerQuery(text);
      const query = pickerQuery ?? afterSlash.trimStart().split(/\s+/, 1)[0]?.toLowerCase?.() ?? '';
      const matchedMcpPrompt = promptSlashCommandsEnabled
        ? resolveTypedMcpPromptCommand(text)
        : null;

      if (isAcpInputSession && hasWhitespace) {
        if (slashCommandState.isActive) {
          setSlashCommandState({ isActive: false, kind: 'all', query: '', selectedIndex: 0 });
        }
        return;
      }

      // While the main session is running, expose a single quick action (/btw) via the same picker UX.
      if (isProcessing) {
        if (!localSlashCommandsEnabled) {
          if (slashCommandState.isActive) {
            setSlashCommandState({ isActive: false, kind: 'all', query: '', selectedIndex: 0 });
          }
          return;
        }

        // Only show the picker for "/..." patterns that are plausibly a command (/ or /b... /d...).
        // Once the user types a space (starts composing the real question), stop showing the picker
        // so Enter can submit "/btw ..." or "/review strict ..." instead of selecting from the picker.
        if (pickerQuery !== null && (query === '' || query.startsWith('b') || query.startsWith('d') || query.startsWith('g') || query.startsWith('r') || query.startsWith('u'))) {
          setSlashCommandState({
            isActive: true,
            kind: 'actions',
            query,
            selectedIndex: 0,
          });
        } else if (slashCommandState.isActive && slashCommandState.kind === 'actions') {
          setSlashCommandState({ isActive: false, kind: 'all', query: '', selectedIndex: 0 });
        }
        return;
      }

      // When idle, keep the picker for mode switching, but don't interfere with executable slash commands.
      if (pickerQuery !== null && !isBtwCommand && !isGoalCommand && !isCompactCommand && !isUsageCommand && !isReviewCommand && !matchedMcpPrompt) {
        setSlashCommandState({
          isActive: true,
          kind: 'all',
          query,
          selectedIndex: 0,
        });
        return;
      }
    }

    if (slashCommandState.isActive) {
      if (slashCommandState.kind === 'skills') {
        return;
      }
      setSlashCommandState({
        isActive: false,
        kind: 'all',
        query: '',
        selectedIndex: 0,
      });
    }
  }, [canUseThreadGoal, contexts, derivedState, dispatchInput, externalPromptCommands, isAcpInputSession, prunePendingLargePastes, removeContext, resolveTypedMcpPromptCommand, selectedExternalPromptCandidateId, selectedNonExternalSlashCommand, setQueuedInput, slashCommandState.isActive, slashCommandState.kind, caps.localSlashCommands, caps.ops]);

  const submitBtwFromInput = useCallback(async () => {
    if (!derivedState) return;
    if (!currentSessionId) {
      notificationService.error(t('btw.noSession'));
      return;
    }
    if (isBtwSession) {
      notificationService.warning(t('btw.nestedDisabled'));
      return;
    }

    const originalMessage = inputState.value.trim();
    const originalPendingLargePastes = { ...pendingLargePastesRef.current };
    const message = expandComposerSpecialTokens(originalMessage);
    const messageCharCount = getCharacterCount(message);
    const question = stripSlashCommand(message, '/btw').trim();
    const imagesForBtw = [...imageContexts];

    // Clear input without adding to main history.
    dispatchInput({ type: 'CLEAR_VALUE' });
    clearPendingLargePastes();
    setQueuedInput(null);
    setSlashCommandState({ isActive: false, kind: 'all', query: '', selectedIndex: 0 });

    if (!question) {
      notificationService.warning(t('btw.empty'));
      return;
    }

    if (messageCharCount > CHAT_INPUT_CONFIG.largePaste.maxMessageChars) {
      notificationService.error(
        t('input.messageTooLarge', {
          max: CHAT_INPUT_CONFIG.largePaste.maxMessageChars,
          count: messageCharCount,
        }),
        { duration: 4000 }
      );
      replacePendingLargePastes(originalPendingLargePastes);
      dispatchInput({ type: 'SET_VALUE', payload: originalMessage });
      return;
    }

    try {
      let imagePayload: Awaited<ReturnType<typeof buildImagePayload>>;
      try {
        imagePayload = await buildImagePayload(imagesForBtw);
      } catch (error) {
        log.error('Failed to upload images for /btw thread', {
          imageCount: imagesForBtw.length,
          error,
        });
        notificationService.error('Image upload failed. Please try again.', { duration: 3000 });
        throw error;
      }

      const { childSessionId } = await startBtwThread({
        parentSessionId: currentSessionId,
        workspacePath: sessionBoundWorkspacePath,
        question,
        imagePayload,
      });
      imagesForBtw.forEach(image => removeContext(image.id));
      openBtwSessionInAuxPane({
        childSessionId,
        parentSessionId: currentSessionId,
        workspacePath: sessionBoundWorkspacePath,
        expand: true,
      });
      setInputTarget('btw');
    } catch (e) {
      log.error('Failed to start /btw thread', { e });
      replacePendingLargePastes(originalPendingLargePastes);
      dispatchInput({ type: 'SET_VALUE', payload: originalMessage });
    }
  }, [clearPendingLargePastes, currentSessionId, derivedState, dispatchInput, expandComposerSpecialTokens, imageContexts, inputState.value, isBtwSession, removeContext, replacePendingLargePastes, sessionBoundWorkspacePath, setQueuedInput, t]);

  const submitCompactFromInput = useCallback(async () => {
    if (!effectiveTargetSessionId || !effectiveTargetSession) {
      notificationService.error(
        t('chatInput.compactNoSession')
      );
      return;
    }

    if (derivedState?.isProcessing) {
      notificationService.warning(
        t('chatInput.compactBusy')
      );
      return;
    }

    const message = inputState.value.trim();
    if (!/^\/compact\s*$/i.test(message)) {
      notificationService.warning(
        t('chatInput.compactUsage')
      );
      return;
    }

    dispatchInput({ type: 'CLEAR_VALUE' });
    setQueuedInput(null);
    setSlashCommandState({ isActive: false, kind: 'all', query: '', selectedIndex: 0 });

    try {
      await FlowChatManager.getInstance().compactSession(effectiveTargetSessionId);
    } catch (error) {
      log.error('Failed to trigger /compact', {
        error,
        sessionId: effectiveTargetSessionId,
      });
      dispatchInput({ type: 'SET_VALUE', payload: message });
      notificationService.error(
        error instanceof Error ? error.message : t('error.unknown'),
        {
          title: t('chatInput.compactFailed'),
          duration: 5000,
        }
      );
    }
  }, [
    derivedState?.isProcessing,
    dispatchInput,
    effectiveTargetSession,
    effectiveTargetSessionId,
    inputState.value,
    setQueuedInput,
    t,
  ]);

  const runEffectiveSessionUsageReport = useCallback(async () => {
    if (!effectiveTargetSessionId || !effectiveTargetSession) {
      notificationService.error(
        t('chatInput.usageNoSession')
      );
      return;
    }

    try {
      await FlowChatManager.getInstance().runSessionUsageReport(
        effectiveTargetSessionId,
        {
          isProcessing: !!derivedState?.isProcessing,
          busyMessage: t('chatInput.usageBusy'),
          noWorkspaceMessage: t('chatInput.usageNoWorkspace'),
          failedTitle: t('chatInput.usageFailed'),
          unknownErrorMessage: t('error.unknown'),
        },
      );
    } catch (error) {
      log.error('Failed to trigger /usage', {
        error,
        sessionId: effectiveTargetSessionId,
      });
      throw error;
    }
  }, [
    derivedState?.isProcessing,
    effectiveTargetSession,
    effectiveTargetSessionId,
    t,
  ]);

  const submitUsageFromInput = useCallback(async () => {
    if (!effectiveTargetSessionId || !effectiveTargetSession) {
      notificationService.error(
        t('chatInput.usageNoSession')
      );
      return;
    }

    const message = inputState.value.trim();
    if (!/^\/usage\s*$/i.test(message)) {
      notificationService.warning(
        t('chatInput.usageCommandUsage')
      );
      return;
    }

    dispatchInput({ type: 'CLEAR_VALUE' });
    setQueuedInput(null);
    setSlashCommandState({ isActive: false, kind: 'all', query: '', selectedIndex: 0 });

    try {
      await runEffectiveSessionUsageReport();
    } catch {
      dispatchInput({ type: 'SET_VALUE', payload: message });
    }
  }, [
    dispatchInput,
    effectiveTargetSession,
    effectiveTargetSessionId,
    inputState.value,
    runEffectiveSessionUsageReport,
    setQueuedInput,
    t,
  ]);

  const handleToolbarUsageReport = useCallback(() => {
    void runEffectiveSessionUsageReport().catch(() => {
      /* errors surfaced by runUsageReportCommand */
    });
  }, [runEffectiveSessionUsageReport]);

  const submitInitFromInput = useCallback(async () => {
    if (!effectiveTargetSessionId || !effectiveTargetSession) {
      notificationService.error(
        t('chatInput.initNoSession')
      );
      return;
    }

    if (isSubagentInputTarget) {
      notificationService.warning(
        t('chatInput.initUsage')
      );
      return;
    }

    if (derivedState?.isProcessing) {
      notificationService.warning(
        t('chatInput.initBusy')
      );
      return;
    }

    const message = inputState.value.trim();
    if (!/^\/init\s*$/i.test(message)) {
      notificationService.warning(
        t('chatInput.initUsage')
      );
      return;
    }

    dispatchInput({ type: 'CLEAR_VALUE' });
    setQueuedInput(null);
    setSlashCommandState({ isActive: false, kind: 'all', query: '', selectedIndex: 0 });

    try {
      await agentAPI.runInitAgentsMd({
        sessionId: effectiveTargetSessionId,
        workspacePath: effectiveTargetSession.workspacePath,
        remoteConnectionId: effectiveTargetSession.remoteConnectionId,
        remoteSshHost: effectiveTargetSession.remoteSshHost,
      });
    } catch (error) {
      log.error('Failed to trigger /init', {
        error,
        sessionId: effectiveTargetSessionId,
      });
      dispatchInput({ type: 'SET_VALUE', payload: message });
      notificationService.error(
        error instanceof Error ? error.message : t('error.unknown'),
        {
          title: t('chatInput.initFailed'),
          duration: 5000,
        }
      );
    }
  }, [
    derivedState?.isProcessing,
    dispatchInput,
    effectiveTargetSession,
    effectiveTargetSessionId,
    inputState.value,
    isSubagentInputTarget,
    setQueuedInput,
    t,
  ]);

  const submitGoalFromInput = useCallback(async () => {
    if (!canUseThreadGoal) {
      return;
    }
    if (!effectiveTargetSessionId || !effectiveTargetSession) {
      notificationService.error(
        t('chatInput.goalNoSession')
      );
      return;
    }

    if (isBtwSession) {
      notificationService.warning(
        t('chatInput.goalNestedDisabled')
      );
      return;
    }

    const message = inputState.value.trim();
    if (!isGoalSlashCommand(message)) {
      notificationService.warning(
        t('chatInput.goalUsage')
      );
      return;
    }

    const originalMessage = message;
    dispatchInput({ type: 'CLEAR_VALUE' });
    setQueuedInput(null);
    setSlashCommandState({ isActive: false, kind: 'all', query: '', selectedIndex: 0 });

    const parsed = parseGoalCommand(message);
    const result = await threadGoalController.runSlashAction(message);

    if (!result && parsed?.kind === 'set') {
      dispatchInput({ type: 'SET_VALUE', payload: originalMessage });
      return;
    }
  }, [
    dispatchInput,
    effectiveTargetSession,
    effectiveTargetSessionId,
    inputState.value,
    isBtwSession,
    canUseThreadGoal,
    setQueuedInput,
    t,
    threadGoalController,
  ]);

  const submitReloadFromInput = useCallback(async () => {
    const message = inputState.value.trim();
    const parsed = parseReloadCommand(message);
    if (!parsed || parsed.kind === 'invalid') {
      notificationService.warning(t('chatInput.reloadUsage'));
      return;
    }
    if (!effectiveTargetSessionId) {
      notificationService.error(t('chatInput.reloadNoSession'));
      return;
    }

    dispatchInput({ type: 'CLEAR_VALUE' });
    setQueuedInput(null);
    setSlashCommandState({ isActive: false, kind: 'all', query: '', selectedIndex: 0 });

    try {
      await agentAPI.reloadSessionContext({
        sessionId: effectiveTargetSessionId,
        target: parsed.target,
      });
      const successMessage = parsed.target === 'all'
        ? t('chatInput.reloadAllDone')
        : parsed.target === 'skills'
          ? t('chatInput.reloadSkillsDone')
          : t('chatInput.reloadInstructionsDone');
      notificationService.success(
        successMessage,
        { duration: 3000 }
      );
    } catch (error) {
      log.error('Failed to reload session context', {
        error,
        sessionId: effectiveTargetSessionId,
        target: parsed.target,
      });
      dispatchInput({ type: 'SET_VALUE', payload: message });
      notificationService.error(
        error instanceof Error ? error.message : t('error.unknown'),
        {
          title: t('chatInput.reloadFailed'),
          duration: 5000,
        }
      );
    }
  }, [dispatchInput, effectiveTargetSessionId, inputState.value, setQueuedInput, t]);

  const submitReviewFromInput = useCallback(async (
    message: string,
    originalComposerValue: string,
  ) => {
    if (!canLaunchReview) {
      notificationService.warning(t('chatInput.reviewUnavailableSurface'));
      return;
    }
    if (!effectiveTargetSessionId || !effectiveTargetSession) {
      notificationService.error(
        t('chatInput.reviewNoSession')
      );
      return;
    }

    if (!isReviewSlashCommand(message)) {
      notificationService.warning(
        t('chatInput.reviewUsage')
      );
      return;
    }

    if (isBtwSession) {
      notificationService.warning(
        t('chatInput.reviewNestedDisabled'),
      );
      return;
    }

    if (shouldBlockReviewCommand(message, currentReviewActivity)) {
      notificationService.warning(
        t('chatInput.reviewBusy'),
      );
      return;
    }

    if (reviewLaunchPendingRef.current) {
      notificationService.warning(t('chatInput.reviewBusy'));
      return;
    }
    reviewLaunchPendingRef.current = true;

    const originalPendingLargePastes = { ...pendingLargePastesRef.current };

    try {
      const prepared = await prepareReviewLaunchFromSlashCommand(
        message,
        effectiveTargetSession.workspacePath,
        effectiveTargetSession.remoteConnectionId,
      );
      if (prepared.mode === 'strict' && prepared.requiresConsent) {
        const confirmed = await confirmDeepReviewLaunch(prepared.runManifest, {
          sessionConcurrencyGuard: deriveDeepReviewSessionConcurrencyGuard(
            flowChatState,
            effectiveTargetSessionId,
          ),
        });
        if (!confirmed) {
          return;
        }
      }

      if (effectiveTargetSessionId) {
        addToHistory(effectiveTargetSessionId, message);
      }
      setHistoryIndex(-1);
      setSavedDraft('');
      dispatchInput({ type: 'CLEAR_VALUE' });
      clearPendingLargePastes();
      setQueuedInput(null);
      setSlashCommandState({ isActive: false, kind: 'all', query: '', selectedIndex: 0 });

      const launched = await launchPreparedReviewSession({
        parentSessionId: effectiveTargetSessionId,
        workspacePath: effectiveTargetSession.workspacePath,
        displayMessage: message,
        prepared,
        childSessionName: t('chatInput.reviewThreadTitle'),
      });
      if (launched?.launchStatus === 'uncertain') {
        notificationService.warning(t('deepReviewActionBar.launchError.uncertain'), {
          duration: 8000,
        });
      }
    } catch (error) {
      log.error('Failed to trigger Review', {
        error,
        sessionId: effectiveTargetSessionId,
      });
      replacePendingLargePastes(originalPendingLargePastes);
      dispatchInput({ type: 'SET_VALUE', payload: originalComposerValue });
      notificationService.error(
        getDeepReviewLaunchErrorMessage(error, t, t('error.unknown')),
        {
          title: t('chatInput.reviewFailed'),
          duration: 5000,
        }
      );
    } finally {
      reviewLaunchPendingRef.current = false;
    }
  }, [
    addToHistory,
    canLaunchReview,
    clearPendingLargePastes,
    confirmDeepReviewLaunch,
    currentReviewActivity,
    dispatchInput,
    effectiveTargetSession,
    effectiveTargetSessionId,
    flowChatState,
    isBtwSession,
    replacePendingLargePastes,
    setQueuedInput,
    t,
  ]);

  const submitMcpPromptFromInput = useCallback(async () => {
    const originalMessage = inputState.value.trim();
    let command = resolveTypedMcpPromptCommand(originalMessage);

    if (!command) {
      await loadMcpPromptCommands();
      command = resolveTypedMcpPromptCommand(originalMessage);
    }

    if (!command) {
      notificationService.warning(
        t('chatInput.noMatchingCommand')
      );
      return;
    }

    const argsText = originalMessage
      .slice(command.command.length)
      .trim();
    const argValues = parseSlashArguments(argsText);
    const requiredArgs = command.arguments.filter(argument => argument.required);

    if (argValues.length < requiredArgs.length) {
      const requiredNames = requiredArgs.map(argument => argument.name).join(', ');
      notificationService.warning(
        t('chatInput.mcpPromptMissingArgs', {
          args: requiredNames,
        })
      );
      return;
    }

    const confirmed = await confirmPromptCacheGuardIfNeeded();
    if (!confirmed) {
      return;
    }

    const originalPendingLargePastes = { ...pendingLargePastesRef.current };
    if (effectiveTargetSessionId) {
      addToHistory(effectiveTargetSessionId, originalMessage);
    }
    setHistoryIndex(-1);
    setSavedDraft('');
    dispatchInput({ type: 'CLEAR_VALUE' });
    clearPendingLargePastes();
    setQueuedInput(null);
    setSlashCommandState({ isActive: false, kind: 'all', query: '', selectedIndex: 0 });

    try {
      const promptArguments = command.arguments.reduce<Record<string, string>>((acc, argument, index) => {
        const value = argValues[index];
        if (typeof value === 'string' && value.length > 0) {
          acc[argument.name] = value;
        }
        return acc;
      }, {});

      const prompt = await MCPAPI.getPrompt({
        serverId: command.serverId,
        promptName: command.promptName,
        arguments: Object.keys(promptArguments).length > 0 ? promptArguments : undefined,
      });

      const renderedPrompt = renderMcpPromptMessages(prompt.messages);
      if (!renderedPrompt.trim()) {
        throw new Error('MCP prompt returned no displayable content');
      }

      await sendMessage(renderedPrompt, {
        displayMessage: originalMessage,
        composerDraft: {
          value: originalMessage,
          pendingLargePastes: originalPendingLargePastes,
        },
      });
    } catch (error) {
      log.error('Failed to run MCP prompt command', {
        command: originalMessage,
        error,
      });
      replacePendingLargePastes(originalPendingLargePastes);
      dispatchInput({ type: 'SET_VALUE', payload: originalMessage });
      notificationService.error(
        error instanceof Error ? error.message : t('error.unknown'),
        {
          title: t('chatInput.mcpPromptFailed'),
          duration: 5000,
        }
      );
    }
  }, [
    clearPendingLargePastes,
    addToHistory,
    confirmPromptCacheGuardIfNeeded,
    dispatchInput,
    effectiveTargetSessionId,
    inputState.value,
    loadMcpPromptCommands,
    resolveTypedMcpPromptCommand,
    replacePendingLargePastes,
    sendMessage,
    setQueuedInput,
    t,
  ]);

  const submitExternalPromptCommandFromInput = useCallback(async (
    message: string,
    originalMessage: string,
    originalPendingLargePastes: PendingLargePasteMap,
  ): Promise<boolean> => {
    const submissionSessionId = effectiveTargetSessionId;
    const submissionWorkspacePath = sessionBoundWorkspacePath;
    const submissionComposerValue = inputValueRef.current;
    const submissionTargetIsCurrent = () => isExternalPromptSubmissionTargetCurrent(
      submissionSessionId,
      effectiveTargetSessionIdRef.current,
      submissionWorkspacePath,
      workspacePathRef.current,
    );
    let composerCleared = false;
    const trimmedMessage = message.trim();
    const commandWhitespaceIndex = trimmedMessage.search(/\s/);
    const command = trimmedMessage.startsWith('/')
      ? (commandWhitespaceIndex === -1
          ? trimmedMessage
          : trimmedMessage.slice(0, commandWhitespaceIndex)).toLowerCase()
      : '';
    const externalCandidates = externalPromptCommands.filter(
      item => item.command.toLowerCase() === command,
    );
    const nativeCommands = getSlashPickerItems()
      .filter((item): item is Exclude<SlashPickerItem, SlashExternalPromptCommandItem> => (
        item.kind !== 'externalCommand'
      ))
      .map(toNativePromptCommandDescriptor)
      .filter(item => `/${item.commandName}` === command)
      .filter((item, index, all) => (
        all.findIndex(candidate => candidate.candidateId === item.candidateId) === index
      ));
    const reservedCommands = new Set(nativeCommands.map(item => `/${item.commandName}`));
    const externalCandidateIds = new Set(
      externalCandidates.map(candidate => candidate.candidateId),
    );
    const explicitNativeCandidate = selectedNonExternalSlashCommand === command
      ? nativeCommands.find(candidate => (
          candidate.candidateId === selectedNonExternalSlashCandidateId
        ))
      : undefined;

    if (externalCandidates.length === 0) {
      const unmatchedRoute = routeUnmatchedExternalPromptCommand({
        hasNativeCommand: nativeCommands.length > 0,
        catalogLoading: externalPromptCommandsLoading,
        discoveryPending: externalPromptCommandsPending,
        catalogIssue: externalPromptCommandsIssue,
      });
      if (unmatchedRoute === 'native' || unmatchedRoute === 'ordinary') return false;
      notificationService.warning(t(unmatchedRoute === 'load_failed'
        ? 'chatInput.externalCommandsLoadFailed'
        : 'chatInput.externalCommandsLoading'));
      return true;
    }

    if (explicitNativeCandidate) {
      try {
        const nativeConflictSnapshot = await externalSourcesAPI.getNativePromptCommandConflicts(
          submissionWorkspacePath || undefined,
          nativeCommands,
        );
        if (!submissionTargetIsCurrent()) return true;
        const nativeConflict = nativeConflictSnapshot.conflicts.find(conflict => (
          externalCandidateIds.has(conflict.externalCandidateId)
        ));
        const nativeReconfirmation = nativeConflictSnapshot.reconfirmations?.some(item => (
          item.nativeCandidateId === explicitNativeCandidate.candidateId
        ));
        if ((nativeConflict
          && nativeConflict.selectedCandidateId !== explicitNativeCandidate.candidateId)
          || nativeReconfirmation) {
          await externalSourcesAPI.setNativePromptCommandConflictChoice(
            submissionWorkspacePath || undefined,
            nativeCommands,
            explicitNativeCandidate.candidateId,
            nativeConflictSnapshot.preferenceRevision,
          );
        }
      } catch (error) {
        log.warn('Failed to persist native prompt command conflict choice', {
          code: error instanceof ExternalSourceApiError ? error.code : 'internal',
        });
        if (!submissionTargetIsCurrent()) return true;
        notificationService.warning(t('chatInput.nativeCommandChoiceNotSaved'));
      }
      if (!submissionTargetIsCurrent()) return true;
      return false;
    }

    try {
      const nativeConflictSnapshot = nativeCommands.length > 0
        ? await externalSourcesAPI.getNativePromptCommandConflicts(
            submissionWorkspacePath || undefined,
            nativeCommands,
          )
        : undefined;
      if (!submissionTargetIsCurrent()) return true;
      const nativeConflict = nativeConflictSnapshot?.conflicts.find(conflict => (
        externalCandidateIds.has(conflict.externalCandidateId)
      ));
      if (externalCandidates.length === 0) {
        const requiresReconfirmation = nativeConflictSnapshot?.reconfirmations?.some(item => (
          nativeCommands.some(commandItem => (
            commandItem.candidateId === item.nativeCandidateId
          ))
        ));
        if (requiresReconfirmation) {
          notificationService.warning(t('chatInput.nativeCommandReconfirmationRequired'));
          return true;
        }
        return false;
      }
      const persistedCandidateId = nativeConflict?.selectedCandidateId;
      if (persistedCandidateId
        && nativeCommands.some(candidate => candidate.candidateId === persistedCandidateId)) {
        return false;
      }
      const selectedExternalCandidateId = selectedExternalPromptCandidateId
        ?? (persistedCandidateId && externalCandidateIds.has(persistedCandidateId)
          ? persistedCandidateId
          : undefined);
      const resolution = resolveExternalPromptCommandInvocation(
        message,
        externalPromptCommands,
        reservedCommands,
        selectedExternalCandidateId,
      );
      if (resolution.state === 'none') {
        return false;
      }
      if (resolution.state === 'conflict') {
        setSlashCommandState({
          isActive: true,
          kind: 'all',
          query: resolution.command.slice(1),
          selectedIndex: 0,
        });
        notificationService.warning(t('chatInput.selectHint'));
        return true;
      }
      if (resolution.state === 'unavailable') {
        notificationService.warning(
          resolution.item.unavailableReason || t('chatInput.noMatchingCommand'),
        );
        return true;
      }

      let expectedPreferenceRevision = nativeConflictSnapshot?.preferenceRevision ?? 0;
      let nativeConflictKey = nativeConflict?.conflictKey;
      if (resolution.item.conflictKey) {
        const snapshot = await externalSourcesAPI.setConflictChoice(
          submissionWorkspacePath || undefined,
          resolution.item.conflictKey,
          resolution.item.candidateId,
          resolution.item.expectedPreferenceRevision ?? 0,
        );
        expectedPreferenceRevision = snapshot.preferenceRevision ?? expectedPreferenceRevision;
        if (!submissionTargetIsCurrent()) return true;
      }
      if (nativeConflict
        && selectedExternalPromptCandidateId === resolution.item.candidateId
        && nativeConflict.selectedCandidateId !== resolution.item.candidateId) {
        const updatedNativeConflicts = await externalSourcesAPI.setNativePromptCommandConflictChoice(
          submissionWorkspacePath || undefined,
          nativeCommands,
          resolution.item.candidateId,
          expectedPreferenceRevision,
        );
        expectedPreferenceRevision = updatedNativeConflicts.preferenceRevision;
        nativeConflictKey = updatedNativeConflicts.conflicts.find(conflict => (
          conflict.externalCandidateId === resolution.item.candidateId
        ))?.conflictKey;
        if (!nativeConflictKey) {
          throw new Error('Native prompt command conflict guard is unavailable');
        }
        if (!submissionTargetIsCurrent()) return true;
      }
      const nativeConflictGuard = nativeConflictKey ? {
        conflictKey: nativeConflictKey,
        expectedPreferenceRevision,
      } : undefined;
      let expanded = await externalSourcesAPI.expandPromptCommand(
        submissionWorkspacePath || undefined,
        resolution.item.command.slice(1),
        resolution.arguments,
        resolution.item.candidateId,
        resolution.item.contentVersion,
        nativeCommands,
        nativeConflictGuard,
      );
      let shellReviewCount = 0;
      while (expanded.state === 'review_required') {
        if (shellReviewCount >= 2) {
          throw new Error('Prompt command shell review changed repeatedly');
        }
        const decision = await reviewPromptCommandShell(
          expanded.review,
          (key, values) => t(key, values),
        );
        if (!decision || !submissionTargetIsCurrent()) return true;
        shellReviewCount += 1;
        expanded = await externalSourcesAPI.expandPromptCommand(
          submissionWorkspacePath || undefined,
          resolution.item.command.slice(1),
          resolution.arguments,
          resolution.item.candidateId,
          resolution.item.contentVersion,
          nativeCommands,
          nativeConflictGuard,
          decision,
        );
      }
      if (!submissionTargetIsCurrent()) return true;
      const executionTarget = expanded.executionTarget;
      if (executionTarget.kind === 'fresh_external_subagent' && contexts.length > 0) {
        notificationService.warning(t('chatInput.externalCommandContextUnsupported'));
        return true;
      }
      const expandedCharCount = getCharacterCount(expanded.content);
      if (expandedCharCount > CHAT_INPUT_CONFIG.largePaste.maxMessageChars) {
        notificationService.error(
          t('input.messageTooLarge', {
            max: CHAT_INPUT_CONFIG.largePaste.maxMessageChars,
            count: expandedCharCount,
          }),
          { duration: 4000 },
        );
        return true;
      }
      if (!(await confirmPromptCacheGuardIfNeeded())) {
        return true;
      }
      if (!submissionTargetIsCurrent()) return true;

      if (submissionSessionId) {
        addToHistory(submissionSessionId, message);
      }
      if (externalPromptComposerIsUnchanged(
        submissionComposerValue,
        inputValueRef.current,
      )) {
        setHistoryIndex(-1);
        setSavedDraft('');
        dispatchInput({ type: 'CLEAR_VALUE' });
        composerCleared = true;
        clearPendingLargePastes();
        setQueuedInput(null);
        setSelectedExternalPromptCandidateId(undefined);
        setSelectedNonExternalSlashCommand(undefined);
        setSelectedNonExternalSlashCandidateId(undefined);
      }
      await sendMessage(expanded.content, {
        displayMessage: originalMessage,
        composerDraft: {
          value: originalMessage,
          pendingLargePastes: originalPendingLargePastes,
        },
        ...(executionTarget.kind === 'fresh_external_subagent'
          ? { execution: executionTarget }
          : {}),
      });
      if (!submissionTargetIsCurrent()) return true;
    } catch (error) {
      log.warn('External prompt command invocation failed', {
        code: error instanceof ExternalSourceApiError ? error.code : 'internal',
      });
      if (!submissionTargetIsCurrent()) {
        if (composerCleared && submissionSessionId) {
          const composer = sessionComposerStore.getState();
          if (composer.getDraft(submissionSessionId)?.value === '') {
            composer.setValue(submissionSessionId, originalMessage);
            composer.setPendingLargePastes(submissionSessionId, originalPendingLargePastes);
          }
        }
        return true;
      }
      const restoreSubmittedComposer = composerCleared
        ? inputValueRef.current === ''
        : externalPromptComposerIsUnchanged(
            submissionComposerValue,
            inputValueRef.current,
          );
      if (restoreSubmittedComposer) {
        replacePendingLargePastes(originalPendingLargePastes);
        dispatchInput({ type: 'SET_VALUE', payload: originalMessage });
      }
      if (error instanceof ExternalSourceApiError
        && (error.code === 'stale_revision'
          || error.code === 'conflict'
          || error.code === 'not_found')) {
        setSelectedExternalPromptCandidateId(undefined);
        setSelectedNonExternalSlashCandidateId(undefined);
        void refreshExternalPromptCommands(false, true);
      }
      notificationService.error(
        error instanceof ExternalSourceApiError ? error.detail : t('error.unknown'),
        { duration: 5000 },
      );
    }
    return true;
  }, [addToHistory, clearPendingLargePastes, confirmPromptCacheGuardIfNeeded, contexts, dispatchInput, effectiveTargetSessionId, externalPromptCommands, externalPromptCommandsIssue, externalPromptCommandsLoading, externalPromptCommandsPending, getSlashPickerItems, refreshExternalPromptCommands, replacePendingLargePastes, selectedExternalPromptCandidateId, selectedNonExternalSlashCandidateId, selectedNonExternalSlashCommand, sendMessage, sessionBoundWorkspacePath, setQueuedInput, t]);

  const handleCancelCurrentTask = useCallback(async () => {
    if (effectiveTargetSessionId) {
      await FlowChatManager.getInstance().cancelSessionTask(effectiveTargetSessionId);
      return;
    }
    await FlowChatManager.getInstance().cancelCurrentTask();
  }, [effectiveTargetSessionId]);

  useShortcut(
    'chat.stopGeneration',
    { key: 'Escape', scope: 'chat', allowInInput: true },
    () => {
      void handleCancelCurrentTask();
    },
    {
      priority: 20,
      enabled: isSceneActive && !chatPopupActive && Boolean(derivedState?.canCancel),
      description: 'keyboard.shortcuts.chat.stopGeneration',
    },
  );

  const handleModelLoadingChange = useCallback((loading: boolean) => {
    setIsModelSwitching(loading);
  }, []);

  const publishSessionModeSelection = useCallback((modeId: string) => {
    if (effectiveTargetSessionId) {
      FlowChatStore.getInstance().updateSessionMode(effectiveTargetSessionId, modeId);
      if (effectiveTargetSessionIdRef.current !== effectiveTargetSessionId) {
        return;
      }
    }
    dispatchMode({
      type: 'SET_CURRENT_MODE',
      payload: modeId,
    });
  }, [effectiveTargetSessionId]);

  const sessionModeSelectionTarget = useMemo(() => effectiveTargetSessionId && effectiveTargetSession
    ? {
        sessionId: effectiveTargetSessionId,
        workspacePath: sessionProjectWorkspacePath(effectiveTargetSession),
        remoteConnectionId:
          effectiveTargetSession.remoteConnectionId ||
          effectiveTargetSession.config.remoteConnectionId,
        remoteSshHost:
          effectiveTargetSession.remoteSshHost || effectiveTargetSession.config.remoteSshHost,
      }
    : null, [effectiveTargetSession, effectiveTargetSessionId]);
  const reportModeSelectionFailure = useCallback((error: unknown, modeId: string) => {
      log.error('Failed to update Session agent mode', { error, modeId });
      notificationService.error(t('chatInput.modeChangeFailed'));
  }, [t]);
  const rememberCommittedHarnessMode = useCallback((modeId: string) => {
    void chatInputModePreferenceService.rememberMode(modeId)
      .then(preference => {
        setUserDefaultModeId(resolveConfiguredChatInputDefaultModeId(preference));
      })
      .catch(error => {
        log.warn('Failed to remember ChatInput Harness selection', { error, modeId });
        notificationService.warning(t('chatInput.harness.rememberFailed'));
      });
  }, [t]);
  const {
    isModeChangePending,
    publishModeSelection,
    requestModeChange: requestSessionModeChange,
  } = useSessionModeSelection(
    sessionModeSelectionTarget,
    publishSessionModeSelection,
    reportModeSelectionFailure,
    rememberCommittedHarnessMode,
  );

  const requestHarnessProfileChange = useCallback(async (profileId: SelectableHarnessProfileId) => {
    if (!executionLevelPolicy.userConfigurable) return;
    const selection = resolveComposerExecutionLevelSelection(profileId);
    if (!canSwitchSessionMainAgent({
      sessionStarted: harnessProfileLocked,
      currentAgentType: currentMode,
      nextAgentType: selection.modeId,
    })) {
      notificationService.info(t('chatInput.harness.sessionStartedNotice'));
      return;
    }
    if (effectiveTargetSessionId && !sessionModeSelectionTarget) {
      notificationService.error(t('chatInput.harness.legacySessionNotice'));
      return;
    }
    requestSessionModeChange(selection.modeId);
  }, [
    currentMode,
    effectiveTargetSessionId,
    harnessProfileLocked,
    executionLevelPolicy.userConfigurable,
    requestSessionModeChange,
    sessionModeSelectionTarget,
    t,
  ]);

  const requestMainAgentChange = useCallback((modeId: string) => {
    if (!executionLevelPolicy.userConfigurable || !canSwitchModes) return;
    const mode = mainAgentModes.find(candidate => candidate.id === modeId);
    if (!mode) return;
    if (mode.id === 'ComputerUse' && !computerUseEnabled) {
      notificationService.warning(t('chatInput.computerUseDisabled'));
      return;
    }
    if (!canSwitchSessionMainAgent({
      sessionStarted: harnessProfileLocked,
      currentAgentType: currentMode,
      nextAgentType: mode.id,
    })) {
      notificationService.info(t('chatInput.harness.sessionStartedNotice'));
      return;
    }
    if (effectiveTargetSessionId && !sessionModeSelectionTarget) {
      notificationService.error(t('chatInput.harness.legacySessionNotice'));
      return;
    }
    requestSessionModeChange(mode.id);
  }, [
    canSwitchModes,
    computerUseEnabled,
    currentMode,
    effectiveTargetSessionId,
    executionLevelPolicy.userConfigurable,
    harnessProfileLocked,
    mainAgentModes,
    requestSessionModeChange,
    sessionModeSelectionTarget,
    t,
  ]);

  const requestHarnessNewSession = useCallback(async (
    selection: HarnessNewSessionSelection,
  ) => {
    if (isHarnessSessionCreating) return;

    const modeId = selection.kind === 'profile'
      ? resolveComposerExecutionLevelSelection(selection.id).modeId
      : selection.id;
    const transferredDraft = {
      value: inputValueRef.current,
      contexts: [...contextsRef.current],
      pendingLargePastes: { ...pendingLargePastesRef.current },
    };

    setIsHarnessSessionCreating(true);
    try {
      const newSessionId = await FlowChatManager.getInstance().createChatSession(
        flowChatSessionConfigForCurrentWorkspace(workspace),
        modeId,
      );
      rememberCommittedHarnessMode(modeId);
      const composer = sessionComposerStore.getState();
      composer.setValue(newSessionId, transferredDraft.value);
      composer.setContexts(newSessionId, transferredDraft.contexts);
      composer.setPendingLargePastes(
        newSessionId,
        transferredDraft.pendingLargePastes,
      );

      // Session creation activates the new Session. Apply the transferred
      // draft immediately as well as seeding its store so the result is stable
      // whether React has already committed that activation or commits it next.
      if (FlowChatStore.getInstance().getState().activeSessionId === newSessionId) {
        effectiveTargetSessionIdRef.current = newSessionId;
        dispatchLocalInput({ type: 'SET_VALUE', payload: transferredDraft.value });
        inputValueRef.current = transferredDraft.value;
        const transferredPendingLargePastes = { ...transferredDraft.pendingLargePastes };
        pendingLargePastesRef.current = transferredPendingLargePastes;
        setPendingLargePastes(transferredPendingLargePastes);
        isRestoringSessionDraftRef.current = true;
        try {
          replaceContexts(transferredDraft.contexts);
        } finally {
          isRestoringSessionDraftRef.current = false;
        }
      }
    } catch (error) {
      log.error('Failed to create Session from execution signature', {
        error,
        modeId,
      });
    } finally {
      setIsHarnessSessionCreating(false);
    }
  }, [isHarnessSessionCreating, rememberCommittedHarnessMode, replaceContexts, workspace]);
  
  const interruptedTurnRecovery = useMemo(
    () => selectInterruptedTurnRecovery(effectiveTargetSession, {
      draft: inputState.value,
      hasComposerAttachments: contexts.length > 0,
      executionIdle:
        derivedState?.sendButtonMode === 'send'
        && !caps.transferInFlight,
      desktopRuntime: isTauriRuntime(),
      peerMode: isPeerDeviceModeActive(),
      acpSession: Boolean(acpSessionForInput || isAcpTargetSession),
      modeChangePending: isModeChangePending,
      modelChangePending: isModelSwitching,
    }),
    [
      acpSessionForInput,
      caps.transferInFlight,
      contexts.length,
      derivedState?.sendButtonMode,
      effectiveTargetSession,
      inputState.value,
      isAcpTargetSession,
      isModeChangePending,
      isModelSwitching,
    ],
  );
  useSyncExternalStore(
    interruptedTurnRecoveryGate.subscribe,
    interruptedTurnRecoveryGate.getSnapshot,
    interruptedTurnRecoveryGate.getSnapshot,
  );
  const isInterruptedTurnRecoveryInFlight =
    interruptedTurnRecoveryGate.isSessionInFlight(effectiveTargetSessionId);

  const externalFileAvailability = resolveExternalFileIntakeAvailability({
    desktopRuntime: isTauriRuntime(),
    remoteWorkspace: Boolean(sessionBoundRemoteConnectionId)
      || isRemoteWorkspaceSession(effectiveTargetSession, contextWorkspace),
    peerDevice: isPeerDeviceModeActive(),
    detachedDispatch: Boolean(effectiveTargetSession?.config.dispatchJobId)
      || isNonLocalDispatchTarget(effectiveTargetSession?.config.dispatchTarget),
  });
  const externalFileIntakeTargetKey = JSON.stringify([
    deviceSurfaceScope.epoch,
    effectiveTargetSessionId ?? '',
    registration?.registrationId ?? '',
    sessionBoundWorkspacePath,
    sessionBoundRemoteConnectionId ?? '',
    externalFileAvailability.supported ? 'supported' : externalFileAvailability.reason,
    effectiveTargetSession?.config.dispatchJobId ?? '',
    effectiveTargetSession?.config.dispatchTarget ?? null,
  ]);
  externalFileIntakeTargetKeyRef.current = externalFileIntakeTargetKey;

  const captureExternalFileIntakeRequest = useCallback((): ExternalFileIntakeRequest => ({
    availability: externalFileAvailability,
    sessionId: effectiveTargetSessionId,
    surfaceEpoch: deviceSurfaceScope.epoch,
    targetKey: externalFileIntakeTargetKey,
  }), [
    deviceSurfaceScope.epoch,
    effectiveTargetSessionId,
    externalFileAvailability,
    externalFileIntakeTargetKey,
  ]);

  const isExternalFileIntakeRequestCurrent = useCallback((request: ExternalFileIntakeRequest) => (
    chatInputMountedRef.current
    && effectiveTargetSessionIdRef.current === request.sessionId
    && getActiveSurfaceScope().epoch === request.surfaceEpoch
    && externalFileIntakeTargetKeyRef.current === request.targetKey
  ), []);

  const enqueueExternalFileIntake = useCallback((
    request: ExternalFileIntakeRequest,
    operation: () => Promise<void>,
  ): Promise<void> => {
    const queued = externalFileIntakeQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (!isExternalFileIntakeRequestCurrent(request)) return;
        await operation();
      })
      .catch((error) => {
        log.error('External file intake failed', error);
      });
    externalFileIntakeQueueRef.current = queued;
    return queued;
  }, [isExternalFileIntakeRequestCurrent]);

  const addClipboardImageFiles = useCallback(async (
    request: ExternalFileIntakeRequest,
    files: File[],
  ) => {
    let limitReached = false;
    for (const file of files) {
      if (!isExternalFileIntakeRequestCurrent(request)) return;
      const imageCount = useContextStore.getState().contexts
        .filter(context => context.type === 'image')
        .length;
      if (imageCount >= CHAT_INPUT_CONFIG.image.maxCount) {
        limitReached = true;
        continue;
      }

      try {
        const imageContext = await createImageContextFromClipboard(file);
        if (!isExternalFileIntakeRequestCurrent(request)) return;
        const latestImageCount = useContextStore.getState().contexts
          .filter(context => context.type === 'image')
          .length;
        if (latestImageCount >= CHAT_INPUT_CONFIG.image.maxCount) {
          limitReached = true;
          continue;
        }
        addContext(imageContext);
        undoImageStackRef.current.push(imageContext.id);
      } catch (error) {
        log.error('Failed to process clipboard image', { fileName: file.name, error });
        notificationService.error(
          `${t('input.imagePasteFailed')}: ${error instanceof Error ? error.message : t('error.unknown')}`,
          { duration: 3000 },
        );
      }
    }

    if (limitReached && isExternalFileIntakeRequestCurrent(request)) {
      notificationService.warning(
        t('input.maxImagesWarning', { count: CHAT_INPUT_CONFIG.image.maxCount }),
        { duration: 3000 },
      );
    }
  }, [addContext, isExternalFileIntakeRequestCurrent, t]);

  const addExternalPaths = useCallback(async (
    request: ExternalFileIntakeRequest,
    source: ExternalFileSource,
    paths: string[],
  ) => {
    if (!request.availability.supported) {
      notificationService.warning(
        t(`input.externalFiles.unsupported.${request.availability.reason}`),
        { duration: 4000 },
      );
      return;
    }
    if (paths.length === 0) {
      notificationService.error(
        t(source === 'clipboard'
          ? 'input.externalFiles.clipboardPathsUnavailable'
          : 'input.externalFiles.dropPathsUnavailable'),
        { duration: 4000 },
      );
      return;
    }

    const result = await buildExternalFileContexts({
      source,
      paths,
      existingContexts: useContextStore.getState().contexts,
      workspacePath: sessionBoundWorkspacePath || undefined,
      maxImageCount: CHAT_INPUT_CONFIG.image.maxCount,
      loadMetadata: pathToInspect => workspaceAPI.getFileMetadata(pathToInspect),
    });
    if (!isExternalFileIntakeRequestCurrent(request)) return;

    for (const context of result.contexts) {
      addContext(context);
      if (context.type !== 'image') {
        richTextInputRef.current?.insertTag?.(context);
      }
    }

    if (result.failures.length > 0) {
      const imageLimitCount = result.failures.filter(failure => failure.reason === 'image-limit').length;
      notificationService.warning(
        imageLimitCount === result.failures.length
          ? t('input.maxImagesWarning', { count: CHAT_INPUT_CONFIG.image.maxCount })
          : t('input.externalFiles.partialFailure', {
              failed: result.failures.length,
              added: result.contexts.length,
            }),
        { duration: 4000 },
      );
    }
  }, [
    addContext,
    isExternalFileIntakeRequestCurrent,
    sessionBoundWorkspacePath,
    t,
  ]);

  const intakeExternalPaths = useCallback((
    source: ExternalFileSource,
    paths: string[],
  ) => {
    const request = captureExternalFileIntakeRequest();
    return enqueueExternalFileIntake(
      request,
      () => addExternalPaths(request, source, paths),
    );
  }, [addExternalPaths, captureExternalFileIntakeRequest, enqueueExternalFileIntake]);

  const handleClipboardFiles = useCallback((paste: ClipboardFilePaste) => {
    const request = captureExternalFileIntakeRequest();
    return enqueueExternalFileIntake(request, async () => {
      if (!request.availability.supported) {
        await addClipboardImageFiles(request, paste.fallbackImages);
        if (paste.hasNonImageFiles || paste.fallbackImages.length === 0) {
          notificationService.warning(
            t(`input.externalFiles.unsupported.${request.availability.reason}`),
            { duration: 4000 },
          );
        }
        return;
      }

      try {
        const { files } = await workspaceAPI.getClipboardFiles();
        if (!isExternalFileIntakeRequestCurrent(request)) return;
        if (files.length > 0) {
          await addExternalPaths(request, 'clipboard', files);
          return;
        }
      } catch (error) {
        log.error('Failed to read clipboard file paths', error);
      }

      await addClipboardImageFiles(request, paste.fallbackImages);
      if (paste.hasNonImageFiles || paste.fallbackImages.length === 0) {
        notificationService.error(
          t('input.externalFiles.clipboardPathsUnavailable'),
          { duration: 4000 },
        );
      }
    });
  }, [
    addClipboardImageFiles,
    addExternalPaths,
    captureExternalFileIntakeRequest,
    enqueueExternalFileIntake,
    isExternalFileIntakeRequestCurrent,
    t,
  ]);

  const handleHtmlExternalFilesDrop = useCallback((files: File[]) => {
    const request = captureExternalFileIntakeRequest();
    return enqueueExternalFileIntake(request, async () => {
      const dropPayload = partitionExternalDropFiles(
        files,
        request.availability.supported,
      );
      let paths = dropPayload.paths;
      let fallbackImages = dropPayload.fallbackImages;
      let hasUnavailableFiles = dropPayload.hasUnavailableFiles;

      if (request.availability.supported && paths.length !== files.length && files.length > 0) {
        try {
          const resolvedPaths = await resolveBrowserDroppedFilePaths(files);
          if (resolvedPaths.length === files.length && resolvedPaths.every(Boolean)) {
            paths = resolvedPaths;
            fallbackImages = [];
            hasUnavailableFiles = false;
          } else {
            log.warn('Browser drop path resolution returned an incomplete result', {
              expectedCount: files.length,
              resolvedCount: resolvedPaths.length,
            });
          }
        } catch (error) {
          log.warn('Failed to resolve browser-dropped file paths', error);
        }
      }

      if (request.availability.supported && paths.length > 0) {
        await addExternalPaths(request, 'drop', paths);
      }

      await addClipboardImageFiles(request, fallbackImages);

      if (!isExternalFileIntakeRequestCurrent(request)) return;
      if (!request.availability.supported && (hasUnavailableFiles || paths.length > 0)) {
        notificationService.warning(
          t(`input.externalFiles.unsupported.${request.availability.reason}`),
          { duration: 4000 },
        );
      } else if (request.availability.supported && hasUnavailableFiles) {
        notificationService.warning(
          t('input.externalFiles.dropPathsUnavailable'),
          { duration: 4000 },
        );
      }
    });
  }, [
    addClipboardImageFiles,
    addExternalPaths,
    captureExternalFileIntakeRequest,
    enqueueExternalFileIntake,
    isExternalFileIntakeRequestCurrent,
    t,
  ]);

  useEffect(() => {
    const inputElement = richTextInputRef.current;
    if (!inputElement) return;
    const handleImagePaste = (event: Event) => {
      const file = (event as CustomEvent<{ file?: File }>).detail?.file;
      if (!file) return;
      const request = captureExternalFileIntakeRequest();
      void enqueueExternalFileIntake(
        request,
        () => addClipboardImageFiles(request, [file]),
      );
    };
    inputElement.addEventListener('imagePaste', handleImagePaste);
    return () => inputElement.removeEventListener('imagePaste', handleImagePaste);
  }, [addClipboardImageFiles, captureExternalFileIntakeRequest, enqueueExternalFileIntake]);

  useLocalFileDrop({
    targetRef: fileDropTargetRef ?? externalFileDropTargetRef,
    enabled: isSceneActive && !isWindowsDesktopRuntime()
      && !caps.transferInFlight
      && !isInterruptedTurnRecoveryInFlight,
    onDropPaths: paths => intakeExternalPaths('drop', paths),
    onDragOver: setNativeFileDragOver,
  });

  useEffect(() => {
    onFileDragOverChange?.(isSceneActive && !caps.transferInFlight
      && !isInterruptedTurnRecoveryInFlight && (nativeFileDragOver || contextFileDragOver));
  }, [onFileDragOverChange, isSceneActive, caps.transferInFlight,
    isInterruptedTurnRecoveryInFlight, nativeFileDragOver, contextFileDragOver]);

  useEffect(() => () => onFileDragOverChange?.(false), [onFileDragOverChange]);

  const handleRecoverInterruptedTurn = useCallback(async () => {
    const candidate = interruptedTurnRecovery;
    if (!candidate || !interruptedTurnRecoveryGate.tryBegin(candidate)) return;
    try {
      await agentAPI.recoverInterruptedDialogTurn({
        sessionId: candidate.sessionId,
        dialogTurnId: candidate.turnId,
        executionGeneration: candidate.executionGeneration,
        workspacePath:
          effectiveTargetSession?.projectWorkspacePath
          || effectiveTargetSession?.workspacePath
          || effectiveTargetSession?.config.projectWorkspacePath
          || effectiveTargetSession?.config.workspacePath,
      });
    } catch (error) {
      log.error('Failed to recover interrupted dialog turn', {
        sessionId: candidate.sessionId,
        turnId: candidate.turnId,
        error,
      });
      notificationService.error(t('input.continueInterruptedFailed'));
      interruptedTurnRecoveryGate.clearExact(candidate);
    }
  }, [
    effectiveTargetSession,
    interruptedTurnRecovery,
    t,
  ]);

  const handleSendOrCancel = useCallback(async (messageOverride?: string) => {
    if (!derivedState) return;
    if (caps.transferInFlight) return;
    if (isInterruptedTurnRecoveryInFlight) return;
    
    const { sendButtonMode } = derivedState;
    const draftTrimmed = (messageOverride ?? inputState.value).trim();

    // While generating, an empty control in `cancel` mode means stop. If the user has typed a follow-up,
    // never treat this path as cancel — that would call cancel_dialog_turn and abort the current round early.
    if (sendButtonMode === 'cancel' && !draftTrimmed) {
      await handleCancelCurrentTask();
      return;
    }

    // Block sending while model switch IPC is in-flight — the backend session may
    // not yet reflect the newly selected model.
    if (isModelSwitching || isModeChangePending) return;
    
    if (sendButtonMode === 'retry') {
      await transition(SessionExecutionEvent.RESET);
    }
    
    if (!draftTrimmed) return;
    
    const originalMessage = draftTrimmed;
    const submissionSessionId = effectiveTargetSessionId;
    const submittedContexts = [...contexts];
    const composerPresentation = messageOverride === undefined
      ? richTextInputRef.current?.getComposerPresentation?.() ?? null
      : null;
    const persistedComposerPresentation = hasComposerPresentationReferences(composerPresentation)
      ? composerPresentation
      : null;
    const originalPendingLargePastes = { ...pendingLargePastesRef.current };
    const expandedMessage = expandComposerSpecialTokens(
      persistedComposerPresentation
        ? composerPresentationToModelText(persistedComposerPresentation)
        : originalMessage,
    );
    const message = expandedMessage || (persistedComposerPresentation
      ? 'Use the referenced session transcript as context.'
      : expandedMessage);
    const messageCharCount = getCharacterCount(message);
    // Voice transcripts are always message content; they must not accidentally execute local commands.
    const promptSlashCommandsEnabled =
      !isAcpInputSession &&
      messageOverride === undefined;
    const localSlashCommandsEnabled =
      promptSlashCommandsEnabled &&
      caps.localSlashCommands;
    const parsedReload = messageOverride === undefined
      ? parseReloadCommand(message)
      : null;

    if (promptSlashCommandsEnabled && await submitExternalPromptCommandFromInput(
      message,
      originalMessage,
      originalPendingLargePastes,
    )) {
      return;
    }

    if (promptSlashCommandsEnabled && caps.ops.has('btw') && isSlashCommand(message, '/btw')) {
      // When idle, /btw can be sent via the normal send button.
      await submitBtwFromInput();
      return;
    }

    if (promptSlashCommandsEnabled && canUseThreadGoal && isGoalSlashCommand(message)) {
      await submitGoalFromInput();
      return;
    }

    if (promptSlashCommandsEnabled && caps.ops.has('compact') && /^\/compact\s*$/i.test(message)) {
      await submitCompactFromInput();
      return;
    }

    if (promptSlashCommandsEnabled && caps.ops.has('usage') && /^\/usage\s*$/i.test(message)) {
      await submitUsageFromInput();
      return;
    }

    if (promptSlashCommandsEnabled && caps.ops.has('init') && /^\/init\s*$/i.test(message)) {
      await submitInitFromInput();
      return;
    }

    if (promptSlashCommandsEnabled && caps.ops.has('review') && isReviewSlashCommand(message)) {
      await submitReviewFromInput(message, originalMessage);
      return;
    }

    if (parsedReload && !reloadContextSupported) {
      notificationService.warning(t('chatInput.reloadDesktopOnly'));
      return;
    }
    if (parsedReload?.kind === 'reload') {
      await submitReloadFromInput();
      return;
    }

    if (promptSlashCommandsEnabled && resolveTypedMcpPromptCommand(message)) {
      await submitMcpPromptFromInput();
      return;
    }

    if (promptSlashCommandsEnabled && caps.ops.has('compact') && isSlashCommand(message, '/compact')) {
      notificationService.warning(
        t('chatInput.compactUsage')
      );
      return;
    }

    if (promptSlashCommandsEnabled && caps.ops.has('usage') && isSlashCommand(message, '/usage')) {
      notificationService.warning(
        t('chatInput.usageCommandUsage')
      );
      return;
    }

    if (promptSlashCommandsEnabled && caps.ops.has('init') && isSlashCommand(message, '/init')) {
      notificationService.warning(
        t('chatInput.initUsage')
      );
      return;
    }

    if (localSlashCommandsEnabled && parsedReload?.kind === 'invalid') {
      notificationService.warning(t('chatInput.reloadUsage'));
      return;
    }
    
    if (messageCharCount > CHAT_INPUT_CONFIG.largePaste.maxMessageChars) {
      notificationService.error(
        t('input.messageTooLarge', {
          max: CHAT_INPUT_CONFIG.largePaste.maxMessageChars,
          count: messageCharCount,
        }),
        { duration: 4000 }
      );
      replacePendingLargePastes(originalPendingLargePastes);
      dispatchInput({ type: 'SET_VALUE', payload: originalMessage });
      return;
    }

    // The selector owns the target-specific availability contract. Keep this
    // after cancel and local slash-command handling so an unavailable model
    // cannot block cancellation or other controls that do not start a turn.
    if (!modelAvailability.canSend) return;

    const confirmed = await confirmPromptCacheGuardIfNeeded();
    if (!confirmed) {
      return;
    }

    // Add to history before clearing (session-scoped)
    if (effectiveTargetSessionId) {
      addToHistory(effectiveTargetSessionId, message);
    }
    setHistoryIndex(-1);
    setSavedDraft('');

    clearComposerForSubmission({
      clearValue: () => dispatchInput({ type: 'CLEAR_VALUE' }),
      clearContexts,
      clearPendingLargePastes,
      // Clear the machine queue too; otherwise queuedInput→input sync puts
      // the submitted text back into the composer.
      clearQueuedInput: () => setQueuedInput(null),
    });
    const clearedComposerRevision = submissionSessionId
      ? composerMutationRevision(submissionSessionId)
      : 0;

    try {
      await submitThroughChatInputRegistration(
        registration,
        {
          text: message,
          displayText: originalMessage,
          contexts: submittedContexts,
          composerPresentation: persistedComposerPresentation,
          sessionId: effectiveTargetSessionId || undefined,
          workspacePath: workspacePath || undefined,
        },
        () => sendMessage(message, {
          displayMessage: originalMessage,
          composerPresentation: persistedComposerPresentation,
          composerDraft: {
            value: originalMessage,
            pendingLargePastes: originalPendingLargePastes,
          },
          clearContextsOnSuccess: false,
        }),
      );
    } catch (error) {
      log.error('Failed to send message', { error });
      const recoveryTarget = failedSubmissionRecoveryTarget(
        submissionSessionId,
        effectiveTargetSessionIdRef.current,
        clearedComposerRevision,
        submissionSessionId ? composerMutationRevision(submissionSessionId) : 0,
      );
      if (recoveryTarget === 'current') {
        dispatchInput({ type: 'SET_VALUE', payload: originalMessage });
        replaceContexts(submittedContexts);
        replacePendingLargePastes(originalPendingLargePastes);
        if (derivedState?.isProcessing) {
          setQueuedInput(originalMessage);
        }
      } else if (recoveryTarget === 'stored' && submissionSessionId) {
        const composer = sessionComposerStore.getState();
        composer.setValue(submissionSessionId, originalMessage);
        composer.setContexts(submissionSessionId, submittedContexts);
        composer.setPendingLargePastes(submissionSessionId, originalPendingLargePastes);
      }
    }
  }, [
    isModelSwitching,
    modelAvailability.canSend,
    isModeChangePending,
    caps.transferInFlight,
    isInterruptedTurnRecoveryInFlight,
    inputState.value,
    derivedState,
    dispatchInput,
    handleCancelCurrentTask,
    transition,
    sendMessage,
    registration,
    contexts,
    workspacePath,
    clearContexts,
    addToHistory,
    effectiveTargetSessionId,
    clearPendingLargePastes,
    expandComposerSpecialTokens,
    isAcpInputSession,
    richTextInputRef,
    replaceContexts,
    replacePendingLargePastes,
    setQueuedInput,
    submitBtwFromInput,
    submitGoalFromInput,
    submitCompactFromInput,
    submitUsageFromInput,
    submitInitFromInput,
    submitReviewFromInput,
    submitMcpPromptFromInput,
    submitReloadFromInput,
    reloadContextSupported,
    confirmPromptCacheGuardIfNeeded,
    t,
    resolveTypedMcpPromptCommand,
    submitExternalPromptCommandFromInput,
    caps.localSlashCommands,
    caps.ops,
    canUseThreadGoal,
    composerMutationRevision,
  ]);
  
  publishModeSelectionRef.current = publishModeSelection;

  const selectSlashCommandAction = useCallback((actionId: SlashActionId) => {
    const raw = inputState.value || '';
    const next = resolveSlashActionInputValue(actionId, raw, isBtwSession);
    if (next === null) {
      return;
    }
    setSelectedExternalPromptCandidateId(undefined);
    setSelectedNonExternalSlashCommand(next.trim().split(/\s+/, 1)[0]?.toLowerCase());
    setSelectedNonExternalSlashCandidateId(
      nativePromptCommandCandidateId('action', actionId),
    );

    if (getInlineSlashCommandPickerQuery(inlineTriggerState) !== null) {
      const controller = richTextInputRef.current as (HTMLDivElement & {
        replaceActiveInlineTrigger?: (replacementText: string) => void;
      }) | null;
      controller?.replaceActiveInlineTrigger?.(next.trimEnd());
      setQueuedInput(null);
      setSlashCommandState({ isActive: false, kind: 'all', query: '', selectedIndex: 0 });
      return;
    }

    dispatchInput({ type: 'SET_VALUE', payload: next });
    inputValueRef.current = next;
    // Clear the machine's queued input so the queuedInput sync effect does not overwrite
    // the just-set "/btw ..." value back to the stale "/" that was queued while processing.
    setQueuedInput(null);
    setSlashCommandState({ isActive: false, kind: 'all', query: '', selectedIndex: 0 });
    window.setTimeout(() => richTextInputRef.current?.focus(), 0);
  }, [dispatchInput, inlineTriggerState, inputState.value, isBtwSession, setQueuedInput]);

  const selectSlashExternalPromptCommand = useCallback((item: SlashExternalPromptCommandItem) => {
    if (!item.available) {
      notificationService.warning(item.unavailableReason || t('chatInput.noMatchingCommand'));
      return;
    }
    setSelectedExternalPromptCandidateId(item.candidateId);
    setSelectedNonExternalSlashCommand(undefined);
    setSelectedNonExternalSlashCandidateId(undefined);
    const replacement = `${item.command} `;
    if (getInlineSlashCommandPickerQuery(inlineTriggerState) !== null) {
      const controller = richTextInputRef.current as (HTMLDivElement & {
        replaceActiveInlineTrigger?: (replacementText: string) => void;
      }) | null;
      controller?.replaceActiveInlineTrigger?.(item.command);
    } else {
      dispatchInput({ type: 'SET_VALUE', payload: replacement });
      inputValueRef.current = replacement;
    }
    setQueuedInput(null);
    setSlashCommandState({ isActive: false, kind: 'all', query: '', selectedIndex: 0 });
    window.setTimeout(() => richTextInputRef.current?.focus(), 0);
  }, [dispatchInput, inlineTriggerState, setQueuedInput, t]);

  const selectSlashPromptCommand = useCallback((item: SlashMcpPromptItem) => {
    setSelectedExternalPromptCandidateId(undefined);
    setSelectedNonExternalSlashCommand(item.command.toLowerCase());
    setSelectedNonExternalSlashCandidateId(
      nativePromptCommandCandidateId(item.kind, item.id),
    );
    if (getInlineSlashCommandPickerQuery(inlineTriggerState) !== null) {
      const controller = richTextInputRef.current as (HTMLDivElement & {
        replaceActiveInlineTrigger?: (replacementText: string) => void;
      }) | null;
      controller?.replaceActiveInlineTrigger?.(item.command);
      setQueuedInput(null);
      setSlashCommandState({ isActive: false, kind: 'all', query: '', selectedIndex: 0 });
      return;
    }
    const hasArguments = item.arguments.length > 0;
    dispatchInput({
      type: 'SET_VALUE',
      payload: hasArguments ? `${item.command} ` : item.command,
    });
    setQueuedInput(null);
    setSlashCommandState({ isActive: false, kind: 'all', query: '', selectedIndex: 0 });
    window.setTimeout(() => richTextInputRef.current?.focus(), 0);
  }, [dispatchInput, inlineTriggerState, setQueuedInput]);

  const selectSlashAcpCommand = useCallback((item: SlashAcpCommandItem) => {
    setSelectedExternalPromptCandidateId(undefined);
    setSelectedNonExternalSlashCommand(item.command.toLowerCase());
    setSelectedNonExternalSlashCandidateId(
      nativePromptCommandCandidateId(item.kind, item.id),
    );
    if (getInlineSlashCommandPickerQuery(inlineTriggerState) !== null) {
      const controller = richTextInputRef.current as (HTMLDivElement & {
        replaceActiveInlineTrigger?: (replacementText: string) => void;
      }) | null;
      controller?.replaceActiveInlineTrigger?.(acpSlashCommandText(item.id));
      setQueuedInput(null);
      setSlashCommandState({ isActive: false, kind: 'all', query: '', selectedIndex: 0 });
      return;
    }
    dispatchInput({ type: 'SET_VALUE', payload: acpSlashCommandText(item.id) });
    setQueuedInput(null);
    setSlashCommandState({ isActive: false, kind: 'all', query: '', selectedIndex: 0 });
    window.setTimeout(() => richTextInputRef.current?.focus(), 0);
  }, [dispatchInput, inlineTriggerState, setQueuedInput]);

  const getRichTextTriggerController = useCallback(() => {
    return richTextInputRef.current;
  }, []);

  const selectSlashSkill = useCallback((item: SlashSkillItem) => {
    setSelectedExternalPromptCandidateId(undefined);
    setSelectedNonExternalSlashCommand(item.command.toLowerCase());
    setSelectedNonExternalSlashCandidateId(
      nativePromptCommandCandidateId(item.kind, item.id),
    );
    const replaceInlineTrigger = getRichTextTriggerController()?.replaceActiveInlineTrigger;

    if (inlineTriggerState.isActive) {
      replaceInlineTrigger?.(createSkillPromptReferenceToken(item.skillName));
      setQueuedInput(null);
      setSlashCommandState({ isActive: false, kind: 'all', query: '', selectedIndex: 0 });
      window.setTimeout(() => richTextInputRef.current?.focus(), 0);
      return;
    }

    const next = replaceLeadingSlashCommandWithSkillToken(inputState.value, item.skillName);
    dispatchInput({ type: 'SET_VALUE', payload: next });
    inputValueRef.current = next;
    setQueuedInput(null);
    setSlashCommandState({ isActive: false, kind: 'all', query: '', selectedIndex: 0 });
    window.setTimeout(() => richTextInputRef.current?.focus(), 0);
  }, [dispatchInput, getRichTextTriggerController, inlineTriggerState.isActive, inputState.value, setQueuedInput]);

  const handleBoostStartBtw = useCallback(
    (e: React.SyntheticEvent) => {
      e.stopPropagation();
      if (!currentSessionId) {
        notificationService.error(t('btw.noSession'));
        return;
      }
      if (isBtwSession) {
        notificationService.warning(
          t('btw.nestedDisabled')
        );
        return;
      }
      selectSlashCommandAction('btw');
      dispatchMode({ type: 'CLOSE_DROPDOWN' });
    },
    [currentSessionId, isBtwSession, selectSlashCommandAction, t]
  );

  const handleBoostNewSession = useCallback(
    async (e: React.SyntheticEvent) => {
      e.stopPropagation();
      dispatchMode({ type: 'CLOSE_DROPDOWN' });
      try {
        const sessionMode = currentSessionId
          ? FlowChatStore.getInstance().getState().sessions.get(currentSessionId)?.mode
          : undefined;
        const sessionConfig = flowChatSessionConfigForCurrentWorkspace(workspace);
        await FlowChatManager.getInstance().createChatSession(sessionConfig, sessionMode);
      } catch (error) {
        log.error('Failed to create new session from boost menu', { error });
      }
    },
    [currentSessionId, workspace]
  );

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Local /btw shortcut (Ctrl/Cmd+Alt+B) should work even when ChatInput is focused.
    if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      e.stopPropagation();

      if (!currentSessionId) {
        notificationService.error(t('btw.noSession'));
        return;
      }
      if (isBtwSession) {
        notificationService.warning(t('btw.nestedDisabled'));
        return;
      }

      const selected = (window.getSelection?.()?.toString() ?? '').trim();
      const initial = selected ? `/btw Explain this:\n\n${selected}` : '/btw ';
      dispatchInput({ type: 'SET_VALUE', payload: initial });
      window.setTimeout(() => richTextInputRef.current?.focus(), 0);
      return;
    }

    // Ctrl+Z / Cmd+Z: undo last image paste (image pastes bypass the browser's native undo stack)
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
      const stack = undoImageStackRef.current;
      // Skip stale entries (images already removed manually or via clearContexts)
      while (stack.length > 0) {
        const imageId = stack.pop()!;
        if (contextsRef.current.some(c => c.id === imageId)) {
          e.preventDefault();
          removeContext(imageId);
          return;
        }
      }
      // No valid image to undo; let the browser handle native text undo (do not preventDefault)
    }

    const nativeEvt = e.nativeEvent as KeyboardEvent;
    // IME-owned keys must stay with the input method. In particular, Escape
    // closes the Chinese/Japanese/Korean candidate window and must not cancel
    // the running OpenBitFun session.
    const isComposing =
      isImeComposingRef.current
      || nativeEvt.isComposing
      || nativeEvt.keyCode === 229;

    if (e.key === 'Escape' && isComposing) {
      return;
    }

    if (slashCommandState.isActive) {
        const items = getActiveSlashPickerItems();
        const maxIndex = Math.max(0, items.length - 1);
        
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSlashCommandState(prev => ({
            ...prev,
            selectedIndex:
              items.length === 0
                ? 0
                : prev.selectedIndex >= maxIndex
                  ? 0
                  : prev.selectedIndex + 1,
          }));
          return;
        }
        
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSlashCommandState(prev => ({
            ...prev,
            selectedIndex:
              items.length === 0
                ? 0
                : prev.selectedIndex <= 0
                  ? maxIndex
                  : prev.selectedIndex - 1,
          }));
          return;
        }
        
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (items.length > 0) {
            const item = items[slashCommandState.selectedIndex] as SlashPickerItem;
            if (item.kind === 'externalCommand') {
              selectSlashExternalPromptCommand(item);
            } else if (item.kind === 'mcpPrompt') {
              selectSlashPromptCommand(item);
            } else if (item.kind === 'acpCommand') {
              selectSlashAcpCommand(item);
            } else if (item.kind === 'skill') {
              selectSlashSkill(item);
            } else {
              selectSlashCommandAction(item.id);
            }
          }
          return;
        }
        
        if (e.key === 'Escape') {
          e.preventDefault();
          const kind = slashCommandState.kind;
          if (kind === 'skills') {
            getRichTextTriggerController()?.closeInlineTrigger?.();
          }
          setSlashCommandState({ isActive: false, kind: 'all', query: '', selectedIndex: 0 });
          return;
        }
        
        if (e.key === 'Tab') {
          e.preventDefault();
          if (items.length > 0) {
            const item = items[slashCommandState.selectedIndex] as SlashPickerItem;
            if (item.kind === 'externalCommand') {
              selectSlashExternalPromptCommand(item);
            } else if (item.kind === 'mcpPrompt') {
              selectSlashPromptCommand(item);
            } else if (item.kind === 'acpCommand') {
              selectSlashAcpCommand(item);
            } else if (item.kind === 'skill') {
              selectSlashSkill(item);
            } else {
              selectSlashCommandAction(item.id);
            }
          }
          return;
        }
    }
    
    // Tab key: toggle send target when the child session switcher is visible
    if (showTargetSwitcher && e.key === 'Tab' && !e.shiftKey && !slashCommandState.isActive) {
      e.preventDefault();
      setInputTarget(prev => prev === 'main' ? 'btw' : 'main');
      return;
    }

    // History navigation with up/down arrows
    // Only handle when not in slash command mode and not composing
    if (!slashCommandState.isActive && inputHistory.length > 0) {
      const selection = window.getSelection();
      const editor = richTextInputRef.current;
      
      if (selection && selection.rangeCount > 0 && editor) {
        const range = selection.getRangeAt(0);
        
        // Check cursor position
        const isAtStart = range.collapsed && range.startOffset === 0 && 
                          (range.startContainer === editor || 
                           (range.startContainer.nodeType === Node.TEXT_NODE && 
                            range.startContainer.previousSibling === null &&
                            range.startContainer.parentNode === editor));
        
        // For end position, we need to check if cursor is at the end of content
        const isAtEnd = (() => {
          if (!range.collapsed) return false;
          const editorContent = editor.textContent || '';
          let cursorPos = 0;
          const traverse = (node: Node): boolean => {
            if (node === range.startContainer) {
              if (node.nodeType === Node.TEXT_NODE) {
                cursorPos += range.startOffset;
              }
              return true;
            }
            if (node.nodeType === Node.TEXT_NODE) {
              cursorPos += (node.textContent || '').length;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              for (const child of Array.from(node.childNodes)) {
                if (traverse(child)) return true;
              }
            }
            return false;
          };
          traverse(editor);
          return cursorPos === editorContent.length;
        })();
        
        // Arrow Up at start of line -> go back in history
        if (e.key === 'ArrowUp' && isAtStart) {
          e.preventDefault();
          
          // Save draft if starting navigation
          if (historyIndex === -1 && inputState.value.trim()) {
            setSavedDraft(inputState.value);
          }
          
          // Navigate back (older messages)
          if (historyIndex < inputHistory.length - 1) {
            const newIndex = historyIndex + 1;
            setHistoryIndex(newIndex);
            dispatchInput({ type: 'SET_VALUE', payload: inputHistory[newIndex] });
          }
          return;
        }
        
        // Arrow Down at end of line -> go forward in history
        if (e.key === 'ArrowDown' && isAtEnd) {
          e.preventDefault();
          
          if (historyIndex > 0) {
            // Navigate forward (newer messages)
            const newIndex = historyIndex - 1;
            setHistoryIndex(newIndex);
            dispatchInput({ type: 'SET_VALUE', payload: inputHistory[newIndex] });
          } else if (historyIndex === 0) {
            // Return to draft/empty
            setHistoryIndex(-1);
            dispatchInput({ type: 'SET_VALUE', payload: savedDraft });
          }
          return;
        }
      }
    }
    
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      if (isComposing) {
        return;
      }
      
      e.preventDefault();

      const isBtwCommand = isSlashCommand(inputState.value.trim(), '/btw');
      if (isBtwCommand) {
        // Allow /btw submission even while the main session is generating.
        void submitBtwFromInput();
        return;
      }

      if (canUseThreadGoal && isGoalSlashCommand(inputState.value.trim())) {
        void submitGoalFromInput();
        return;
      }

      if (derivedState?.isProcessing) {
        if (!inputState.value.trim()) return;
        void handleSendOrCancel();
        return;
      }

      handleSendOrCancel();
    }
    
  }, [canUseThreadGoal, handleSendOrCancel, submitBtwFromInput, submitGoalFromInput, derivedState, dispatchInput, slashCommandState, getActiveSlashPickerItems, selectSlashCommandAction, selectSlashExternalPromptCommand, selectSlashPromptCommand, selectSlashAcpCommand, selectSlashSkill, getRichTextTriggerController, historyIndex, inputHistory, savedDraft, inputState.value, currentSessionId, isBtwSession, showTargetSwitcher, setInputTarget, removeContext, t]);

  const handleImeCompositionStart = useCallback(() => {
    isImeComposingRef.current = true;
  }, []);

  const handleImeCompositionEnd = useCallback(() => {
    isImeComposingRef.current = false;
  }, []);

  const handleImageInput = useCallback(() => {
    const remaining = CHAT_INPUT_CONFIG.image.maxCount - currentImageCount;
    if (remaining <= 0) {
      notificationService.warning(t('input.maxImagesWarning', { count: CHAT_INPUT_CONFIG.image.maxCount }), { duration: 3000 });
      return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = CHAT_INPUT_CONFIG.image.acceptedTypes.join(',');
    input.multiple = true;
    
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files || files.length === 0) return;
      
      const fileArray = Array.from(files).slice(0, remaining);
      if (files.length > remaining) {
        notificationService.warning(t('input.maxImagesWarning', { count: CHAT_INPUT_CONFIG.image.maxCount }), { duration: 3000 });
      }
      
      for (const file of fileArray) {
        try {
          const imageContext = await createImageContextFromFile(file);
          addContext(imageContext);
        } catch (error) {
          log.error('Failed to process image', { fileName: file.name, error });
          notificationService.error(
            `${file.name}: ${error instanceof Error ? error.message : t('error.processingFailed')}`,
            { duration: 3000 }
          );
        }
      }
    };
    
    input.click();
  }, [addContext, currentImageCount, t]);
  

  const focusRichTextInputSoon = useCallback(() => {
    window.requestAnimationFrame(() => {
      richTextInputRef.current?.focus();
    });
  }, []);

  const insertInlineReferenceIntoInput = useCallback(
    (token: string) => {
      const appendInlineTokenAtEnd = getRichTextTriggerController()?.appendInlineTokenAtEnd;
      if (appendInlineTokenAtEnd) {
        appendInlineTokenAtEnd(token);
      } else {
        const trimmed = inputState.value.trimEnd();
        const next = trimmed ? `${trimmed} ${token}` : token;
        dispatchInput({ type: 'SET_VALUE', payload: next });
        inputValueRef.current = next;
      }
      dispatchMode({ type: 'CLOSE_DROPDOWN' });
      focusRichTextInputSoon();
    },
    [dispatchInput, focusRichTextInputSoon, getRichTextTriggerController, inputState.value]
  );

  const insertSkillIntoInput = useCallback((skillName: string) => {
    insertInlineReferenceIntoInput(createSkillPromptReferenceToken(skillName));
  }, [insertInlineReferenceIntoInput]);

  const selectContextSkill = useCallback((skill: ContextPickerSkill) => {
    getRichTextTriggerController()?.replaceActiveContextTrigger?.(
      createSkillPromptReferenceToken(skill.name),
    );
    setQueuedInput(null);
    focusRichTextInputSoon();
  }, [focusRichTextInputSoon, getRichTextTriggerController, setQueuedInput]);

  const selectContextMcp = useCallback((item: ContextPickerMcpItem) => {
    getRichTextTriggerController()?.replaceActiveContextTrigger?.(item.reference);
    setQueuedInput(null);
    focusRichTextInputSoon();
  }, [focusRichTextInputSoon, getRichTextTriggerController, setQueuedInput]);

  const handleContextPickerAddImage = useCallback(() => {
    getRichTextTriggerController()?.replaceActiveContextTrigger?.('');
    handleImageInput();
  }, [getRichTextTriggerController, handleImageInput]);

  const additionalModeItems = useMemo<ChatInputAdditionalModeItem[]>(() => [
    ...quickSkillShortcuts.map(shortcut => ({
      id: shortcut.id,
      label: shortcut.label,
      title: shortcut.skill.description || shortcut.label,
      skillName: shortcut.skill.name,
    })),
  ], [quickSkillShortcuts]);

  const selectAdditionalMode = useCallback((skillName: string) => {
    insertSkillIntoInput(skillName);
  }, [insertSkillIntoInput]);

  const handleBoostPickImage = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      dispatchMode({ type: 'CLOSE_DROPDOWN' });
      handleImageInput();
    },
    [handleImageInput]
  );

  const handleBoostOpenAtContext = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation();
    dispatchMode({ type: 'CLOSE_DROPDOWN' });
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const el = richTextInputRef.current;
        el?.openContextPicker?.();
      });
    });
  }, []);

  const handleOpenSkillsLibrary = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      dispatchMode({ type: 'CLOSE_DROPDOWN' });
      openScene('skills' as SceneTabId);
    },
    [openScene]
  );
  useEffect(() => {
    const dropZone = containerRef.current?.closest('.openbitfun-chat-input-drop-zone') as HTMLElement | null;
    const el = dropZone ?? containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setChatInputHeight(el.offsetHeight);
    });
    observer.observe(el);
    setChatInputHeight(el.offsetHeight);
    return () => observer.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  const voiceInput = useComposerVoiceInput({
    focusInputSoon: () => {
      window.requestAnimationFrame(() => richTextInputRef.current?.focus());
    },
    insertText: (text) => {
      const current = inputState.value.trim();
      const mergedText = current ? `${inputState.value.trimEnd()} ${text}` : text;
      dispatchInput({
        type: 'SET_VALUE',
        payload: mergedText,
      });
      return mergedText;
    },
    submitText: async (text) => {
      await handleSendOrCancel(text);
    },
  });

  const renderActionButton = () => {
    if (!derivedState) return <span className="openbitfun-chat-input__send-action" data-openbitfun-component="chat-input" data-openbitfun-part="sendButton" data-openbitfun-action="send" data-openbitfun-state="disabled"><ChatComposerActionButton
      aria-label={t('input.sendShortcut')}
      className="openbitfun-chat-input__send-button"
      disabled
      icon={<Icon name="arrow-up" size="lg" />}
      variant="primary"
    /></span>;

    const { sendButtonMode, hasQueuedInput } = derivedState;

    if (interruptedTurnRecovery) {
      return (
        <span
          className="openbitfun-chat-input__send-action"
          data-openbitfun-component="chat-input"
          data-openbitfun-part="sendButton"
          data-openbitfun-action="continue-interrupted"
          data-openbitfun-state={isInterruptedTurnRecoveryInFlight ? 'disabled' : undefined}
        >
          <Tooltip content={t('input.continueInterrupted')}>
            <ChatComposerActionButton
              aria-label={t('input.continueInterrupted')}
              className="openbitfun-chat-input__send-button"
              onClick={() => void handleRecoverInterruptedTurn()}
              disabled={isInterruptedTurnRecoveryInFlight}
              data-testid="chat-input-continue-interrupted-btn"
              icon={isInterruptedTurnRecoveryInFlight
                ? <Loader2 className="openbitfun-spin" />
                : <Play fill="currentColor" />}
              variant="primary"
            />
          </Tooltip>
        </span>
      );
    }
    
    if (sendButtonMode === 'cancel') {
      return (
        <span className="openbitfun-chat-input__send-action" data-openbitfun-component="chat-input" data-openbitfun-part="sendButton" data-openbitfun-action="cancel">
          <Tooltip content={t('input.stopGeneration')}>
            <div
              className="openbitfun-chat-input__send-button openbitfun-chat-input__send-button--breathing"
              onClick={() => void handleSendOrCancel()}
              data-testid="chat-input-cancel-btn"
            >
              <div className="openbitfun-chat-input__breathing-circle" />
              {hasQueuedInput && <span className="openbitfun-chat-input__queued-badge" data-openbitfun-component="chat-input" data-openbitfun-part="queuedBadge">1</span>}
            </div>
          </Tooltip>
        </span>
      );
    }

    if (sendButtonMode === 'retry') {
      return (
        <span className="openbitfun-chat-input__send-action" data-openbitfun-component="chat-input" data-openbitfun-part="sendButton" data-openbitfun-action="retry" data-openbitfun-state={isModelSwitching || isModeChangePending || caps.transferInFlight || !modelAvailability.canSend ? 'disabled' : undefined}>
          <Tooltip content={t('input.retry')}>
            <ChatComposerActionButton
              aria-label={t('input.retry')}
              className="openbitfun-chat-input__send-button openbitfun-chat-input__send-button--retry"
              onClick={() => void handleSendOrCancel()}
              disabled={isModelSwitching || isModeChangePending || caps.transferInFlight || !modelAvailability.canSend}
              icon={<RotateCcw />}
              variant="primary"
            />
          </Tooltip>
        </span>
      );
    }

    if (sendButtonMode === 'split') {
      return (
        <div data-openbitfun-component="chat-input" data-openbitfun-part="sendActions" data-openbitfun-action="split" className="openbitfun-chat-input__split-actions">
          <span className="openbitfun-chat-input__send-action" data-openbitfun-component="chat-input" data-openbitfun-part="sendButton" data-openbitfun-action="cancel">
            <Tooltip content={t('input.stopGeneration')}>
              <div
                className="openbitfun-chat-input__send-button openbitfun-chat-input__send-button--breathing"
                onClick={() => {
                  void handleCancelCurrentTask();
                }}
                data-testid="chat-input-cancel-btn"
              >
                <div className="openbitfun-chat-input__breathing-circle" />
              </div>
            </Tooltip>
          </span>
          <span className="openbitfun-chat-input__send-action" data-openbitfun-component="chat-input" data-openbitfun-part="sendButton" data-openbitfun-action="send" data-openbitfun-state={!inputState.value.trim() || isModelSwitching || isModeChangePending || caps.transferInFlight || !modelAvailability.canSend ? 'disabled' : undefined}>
            <Tooltip content={t('input.sendShortcut')}>
              <ChatComposerActionButton
                aria-label={t('input.sendShortcut')}
                className="openbitfun-chat-input__send-button"
                onClick={() => void handleSendOrCancel()}
                disabled={!inputState.value.trim() || isModelSwitching || isModeChangePending || caps.transferInFlight || !modelAvailability.canSend}
                data-testid="chat-input-send-btn"
                icon={<Icon name="arrow-up" size="lg" />}
                variant="primary"
              />
            </Tooltip>
          </span>
        </div>
      );
    }
    
    return (
      <span className="openbitfun-chat-input__send-action" data-openbitfun-component="chat-input" data-openbitfun-part="sendButton" data-openbitfun-action="send" data-openbitfun-state={!inputState.value.trim() || isModelSwitching || isModeChangePending || caps.transferInFlight || !modelAvailability.canSend ? 'disabled' : undefined}>
        <Tooltip content={t('input.sendShortcut')}>
          <ChatComposerActionButton
            aria-label={t('input.sendShortcut')}
            className="openbitfun-chat-input__send-button"
            onClick={() => void handleSendOrCancel()}
            disabled={!inputState.value.trim() || isModelSwitching || isModeChangePending || caps.transferInFlight || !modelAvailability.canSend}
            data-testid="chat-input-send-btn"
            icon={<Icon name="arrow-up" size="lg" />}
            variant="primary"
          />
        </Tooltip>
      </span>
    );
  };

  const workspaceStripVisible = Boolean(
    chatStripWorkspaceLabel.trim()
    || dispatchControl
    || showPermissionModeControl
    || (
      effectiveTargetSessionId
      && effectiveTargetSession
      && caps.usageReport
    ),
  );
  const workspaceStrip = workspaceStripVisible ? (
    <ChatInputWorkspaceStrip
      repositoryPath={chatStripRepositoryPath}
      workspaceLabel={chatStripWorkspaceLabel}
      executionTarget={effectiveTargetSession?.config.executionTarget}
      dispatchControl={dispatchControl}
      worktreeControl={worktreeControl}
      deferPassiveGitRefresh={deferChatStripPassiveGitRefresh}
      permissionControl={showPermissionModeControl
        ? caps.sessionScopedApproval
          ? {
              mode: dispatchPermissionMode,
              disabled: dispatchSubmissionOptionsLocked,
              options: DISPATCH_PERMISSION_MODES,
              scopeLabel: t('chatInput.dispatch.sessionScope'),
              onChange: handleDispatchPermissionModeChange,
            }
          : {
              mode: permissionMode,
              saving: permissionModeSaving,
              scopeLabel: t('chatInput.permissionMode.sessionScope'),
              overridden: permissionModeOverridden,
              nextTurnMode: temporaryPermissionMode
                ? chatInputPermissionMode(temporaryPermissionMode)
                : null,
              activeTurn: activePermissionTurnId !== null,
              onChangeForNextTurn: isAcpTargetSession
                ? undefined
                : handlePermissionModeForNextTurn,
              onChange: isAcpTargetSession ? undefined : handlePermissionModeChange,
              onResetToDefault: isAcpTargetSession
                ? undefined
                : handleResetPermissionModeToDefault,
              onOpenDefaultSettings: isAcpTargetSession
                ? undefined
                : handleOpenPermissionDefaultSettings,
            }
        : undefined}
      usageReport={
        effectiveTargetSessionId && effectiveTargetSession && caps.usageReport
          ? {
              visible: true,
              currentTokens: tokenUsage.current,
              maxTokens: tokenUsage.max,
              onOpen: handleToolbarUsageReport,
            }
          : undefined
      }
    />
  ) : undefined;

  const harnessProfileSelectorProps = {
    legacySession: !canSwitchModes,
    sessionStarted: harnessProfileLocked,
    selectedProfile: selectedHarnessProfile,
    selectedAgentId: selectedHarnessProfile === 'other' ? currentMode : undefined,
    otherAgents: otherAgentOptions,
    disabled: isModeChangePending || isHarnessSessionCreating,
    onSelectProfile: requestHarnessProfileChange,
    onSelectAgent: requestMainAgentChange,
    onStartNewSession: requestHarnessNewSession,
  } satisfies React.ComponentProps<typeof HarnessProfileSelector>;

  return (
    <>
      {deepReviewConsentDialog}
      <ContextDropZone
        extendedTargetRef={fileDropTargetRef}
        onDragStateChange={setContextFileDragOver}
        acceptedTypes={['file', 'directory', 'image', 'code-snippet', 'mermaid-diagram']}
        className="openbitfun-chat-input-drop-zone"
        disabled={!isSceneActive || caps.transferInFlight || isInterruptedTurnRecoveryInFlight}
        onExternalFilesDrop={
          isWindowsDesktopRuntime() && !caps.transferInFlight
            ? files => { void handleHtmlExternalFilesDrop(files); }
            : undefined
        }
        onContextAdded={(context) => {
          if (context.type === 'image' && currentImageCount >= CHAT_INPUT_CONFIG.image.maxCount) {
            notificationService.warning(t('input.maxImagesWarning', { count: CHAT_INPUT_CONFIG.image.maxCount }), { duration: 3000 });
            return;
          }
          // Images are shown as separate thumbnails outside the editor; they
          // don't get an inline #img: pill. All other context types do.
          if (
            context.type !== 'image' &&
            richTextInputRef.current &&
            (richTextInputRef.current as any).insertTag
          ) {
            (richTextInputRef.current as any).insertTag(context);
          }
        }}
      >
        <div 
          ref={containerRef}
          className={`openbitfun-chat-input ${isMultiLine ? 'openbitfun-chat-input--multi-line' : 'openbitfun-chat-input--capsule'} ${derivedState?.isProcessing || caps.transferInFlight ? 'openbitfun-chat-input--processing' : ''} ${className}`}
          data-openbitfun-component="chat-input"
          data-openbitfun-part="root"
          data-openbitfun-state={[
            isMultiLine && 'multiline',
            (derivedState?.isProcessing || caps.transferInFlight) && 'processing',
          ].filter(Boolean).join(' ')}
          data-testid="chat-input-container"
          aria-busy={caps.transferInFlight}
        >
        {recommendationContext && (
          <SmartRecommendations
            context={recommendationContext}
            className="openbitfun-chat-input__recommendations"
          />
        )}

        <div className="openbitfun-chat-input__container" data-openbitfun-component="chat-input" data-openbitfun-part="container">
          <AcpPlanPanel entries={acpPlanEntries} />
          {/* The request sits directly above the field that answers it, so the
              transcript it is about stays readable while deciding. */}
          {activePermissionBatch ? (
            <ChatInputApprovalBand
              key={`${activePermissionBatch.sessionId}:${activePermissionBatch.roundId}`}
              requests={activePermissionBatch.requests}
              totalPendingCount={pendingPermissionRequests.length}
              rejectReason={inputState.value}
              onRejectReasonConsumed={() => dispatchInput({ type: 'CLEAR_VALUE' })}
              onRespond={respondPermission}
              onRespondBatch={respondPermissionBatch}
            />
          ) : null}
          <div ref={externalFileDropTargetRef} className="openbitfun-chat-input__box" data-openbitfun-component="chat-input" data-openbitfun-part="box">
            <ChatComposer
              className="openbitfun-chat-input__composer"
              contextBar={workspaceStrip}
              layout={isMultiLine ? 'expanded' : 'compact'}
              queue={(
                <PendingQueuePanel
                  sessionId={effectiveTargetSessionId || undefined}
                  onRestoreToComposer={restoreQueuedMessageToComposer}
                />
              )}
              busy={Boolean(derivedState?.isProcessing || caps.transferInFlight)}
              disabled={caps.transferInFlight || isInterruptedTurnRecoveryInFlight}
            >
              <ChatComposerContent>
                <div className="openbitfun-chat-input__content">
            {showTargetSwitcher && (
              <div className="openbitfun-chat-input__target-switcher" data-openbitfun-component="chat-input" data-openbitfun-part="targetSwitcher" data-testid="chat-input-target-switcher">
                <span className="openbitfun-chat-input__target-switcher-label" data-openbitfun-component="chat-input" data-openbitfun-part="targetLabel">{t('chatInput.conversationTarget')}</span>
                <button data-overflow-trigger
                  type="button"
                  tabIndex={-1}
                  className={`openbitfun-chat-input__target-tab ${inputTarget === 'main' ? 'openbitfun-chat-input__target-tab--active' : ''}`}
                  data-openbitfun-component="chat-input"
                  data-openbitfun-part="target"
                  data-openbitfun-target="main"
                  data-openbitfun-state={inputTarget === 'main' ? 'selected' : ''}
                  onClick={() => setInputTarget('main')}
                >
                  {t('chatInput.targetMain')}
                  {inputTarget === 'main' && currentSessionTitle && (
                    <OverflowText className="openbitfun-chat-input__target-tab-name" data-openbitfun-component="chat-input" data-openbitfun-part="targetName">{currentSessionTitle}</OverflowText>
                  )}
                </button>
                <button data-overflow-trigger
                  type="button"
                  tabIndex={-1}
                  className={`openbitfun-chat-input__target-tab ${inputTarget === 'btw' ? 'openbitfun-chat-input__target-tab--active' : ''}`}
                  data-openbitfun-component="chat-input"
                  data-openbitfun-part="target"
                  data-openbitfun-target="btw"
                  data-openbitfun-state={inputTarget === 'btw' ? 'selected' : ''}
                  onClick={() => setInputTarget('btw')}
                >
                  {activeBtwTargetLabel}
                  {inputTarget === 'btw' && activeBtwSessionTitle && (
                    <OverflowText className="openbitfun-chat-input__target-tab-name" data-openbitfun-component="chat-input" data-openbitfun-part="targetName">{activeBtwSessionTitle}</OverflowText>
                  )}
                </button>
              </div>
            )}
            <div ref={inputAreaAnchorRef} className="openbitfun-chat-input__input-area" data-openbitfun-component="chat-input" data-openbitfun-part="area">
              {imageContexts.length > 0 && (
                <div
                  className="openbitfun-chat-input__image-strip"
                  data-openbitfun-component="chat-input"
                  data-openbitfun-part="imageStrip"
                  data-testid="chat-input-image-strip"
                >
                  {imageContexts.map(image => {
                    return (
                      <div data-openbitfun-component="chat-input" data-openbitfun-part="image"
                        key={image.id}
                        className="openbitfun-chat-input__image-chip"
                        title={image.imageName}
                      >
                        <ChatInputImagePreview image={image} surfaceEpoch={deviceSurfaceScope.epoch} />
                        <button
                          type="button"
                          className="openbitfun-chat-input__image-chip-remove"
                          data-openbitfun-component="chat-input"
                          data-openbitfun-part="imageRemove"
                          aria-label={t('input.removeImage')}
                          onClick={(e) => {
                            e.stopPropagation();
                            removeContext(image.id);
                          }}
                        >
                          <Icon name="xmark" size="xs" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              {showPlaceholder && (
                <span className="openbitfun-chat-input__placeholder" data-openbitfun-component="chat-input" data-openbitfun-part="placeholder" aria-hidden>
                  {t('input.placeholder')}
                </span>
              )}
              <RichTextInput
                ref={richTextInputRef}
                value={inputState.value}
                onChange={handleInputChange}
                onLargePaste={createLargePastePlaceholder}
                onPasteFiles={handleClipboardFiles}
                pendingLargePastes={pendingLargePastes}
                skillReferenceNames={skillReferenceNames}
                onUpdateLargePaste={updateLargePaste}
                onRemoveLargePaste={removeLargePaste}
                onKeyDown={handleKeyDown}
                onCompositionStart={handleImeCompositionStart}
                onCompositionEnd={handleImeCompositionEnd}
                placeholder=""
                disabled={caps.transferInFlight || isInterruptedTurnRecoveryInFlight}
                contexts={contexts}
                onRemoveContext={removeContext}
                onContextTriggerStateChange={setContextTriggerState}
                onInlineTriggerStateChange={setInlineTriggerState}
                data-testid="chat-input-textarea"
              />

              
              <ChatContextPicker
                isOpen={contextTriggerState.isActive}
                searchQuery={contextTriggerState.query}
                workspacePath={sessionBoundWorkspacePath}
                remoteConnectionId={sessionBoundRemoteConnectionId}
                workspaceId={hasRegisteredWorkspace
                  ? undefined
                  : effectiveTargetSession?.workspaceId || contextWorkspace?.id}
                excludeSessionId={effectiveTargetSessionId || undefined}
                anchorRef={inputAreaAnchorRef}
                entryView={isAcpTargetSession ? 'files' : 'sources'}
                skills={canUseSkillsForTarget ? userInvocableSkills : []}
                skillsLoading={resolvedModeSkillsLoading}
                skillsLoadFailed={resolvedModeSkillsLoadFailed}
                skillDiagnostics={resolvedSkillDiagnostics}
                skillDiagnosticsAvailable={resolvedSkillDiagnosticsAvailable}
                onRetrySkills={retryResolvedModeSkills}
                onSelectSkill={canUseSkillsForTarget ? selectContextSkill : undefined}
                mcpCatalog={chatMcp.catalog}
                mcpLoading={chatMcp.loading}
                mcpLoadFailed={chatMcp.failed}
                mcpUnavailable={chatMcp.unavailable}
                onRefreshMcp={chatMcp.refresh}
                onSelectMcp={canSelectMcp ? selectContextMcp : undefined}
                onAddImage={!isAcpTargetSession ? handleContextPickerAddImage : undefined}
                onSelectContext={(context: FileContext | DirectoryContext | SessionReferenceContext) => {
                  addContext(context);
                  richTextInputRef.current?.insertContextTagReplacingTrigger?.(context);
                }}
                onClose={() => {
                  richTextInputRef.current?.closeContextPicker?.();
                  setContextTriggerState({ isActive: false, query: '', startOffset: 0 });
                }}
              />
              
              {slashCommandState.isActive && createPortal((() => {
                if (slashCommandState.kind === 'actions') {
                  const actions = getFilteredActions();
                  return (
                    <div
                      ref={slashCommandPickerRef}
                      data-openbitfun-component="chat-input"
                      data-openbitfun-part="commandPicker"
                      data-openbitfun-command="actions"
                      data-openbitfun-state="open"
                      data-openbitfun-placement={slashCommandPickerLayout?.placement ?? 'top'}
                      className="openbitfun-chat-input__slash-command-picker"
                      style={{
                        top: `${slashCommandPickerLayout?.top ?? 0}px`,
                        left: `${slashCommandPickerLayout?.left ?? 0}px`,
                        visibility: slashCommandPickerLayout ? 'visible' : 'hidden',
                      }}
                    >
                      <div className="openbitfun-chat-input__slash-command-header" data-openbitfun-component="chat-input" data-openbitfun-part="commandHeader">
                        <span>{t('chatInput.quickAction')}</span>
                        <span className="openbitfun-chat-input__slash-command-hint">{t('chatInput.selectHint')}</span>
                      </div>
                      <div className="openbitfun-chat-input__slash-command-list" data-openbitfun-component="chat-input" data-openbitfun-part="commandList">
                        {actions.length > 0 ? (
                          actions.map((action, index) => (
                            <div data-overflow-trigger
                              data-openbitfun-component="chat-input"
                              data-openbitfun-part="commandItem"
                              data-openbitfun-command-item-kind="action"
                              data-openbitfun-state={index === slashCommandState.selectedIndex ? 'selected' : ''}
                              key={action.id}
                              className={`openbitfun-chat-input__slash-command-item ${index === slashCommandState.selectedIndex ? 'openbitfun-chat-input__slash-command-item--selected' : ''}`}
                              onClick={() => selectSlashCommandAction(action.id)}
                              onMouseEnter={() => setSlashCommandState(prev => ({ ...prev, selectedIndex: index }))}
                            >
                              <OverflowText className="openbitfun-chat-input__slash-command-name" data-openbitfun-component="chat-input" data-openbitfun-part="commandName">{action.command}</OverflowText>
                              <OverflowText lines={2} className="openbitfun-chat-input__slash-command-label" data-openbitfun-component="chat-input" data-openbitfun-part="commandLabel" marqueeActive={index === slashCommandState.selectedIndex}>{action.label}</OverflowText>
                            </div>
                          ))
                        ) : (
                          <div className="openbitfun-chat-input__slash-command-empty" data-openbitfun-component="chat-input" data-openbitfun-part="commandEmpty">
                            {t('chatInput.noMatchingCommand')}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }

                if (slashCommandState.kind === 'all') {
                  const items = getActiveSlashPickerItems();
                  const firstSkillIndex = items.findIndex(item => item.kind === 'skill');
                  return (
                    <div
                      ref={slashCommandPickerRef}
                      data-openbitfun-component="chat-input"
                      data-openbitfun-part="commandPicker"
                      data-openbitfun-command="all"
                      data-openbitfun-state="open"
                      data-openbitfun-placement={slashCommandPickerLayout?.placement ?? 'top'}
                      className="openbitfun-chat-input__slash-command-picker"
                      style={{
                        top: `${slashCommandPickerLayout?.top ?? 0}px`,
                        left: `${slashCommandPickerLayout?.left ?? 0}px`,
                        visibility: slashCommandPickerLayout ? 'visible' : 'hidden',
                      }}
                    >
                      <div className="openbitfun-chat-input__slash-command-header" data-openbitfun-component="chat-input" data-openbitfun-part="commandHeader">
                        <span>{t('chatInput.commands')}</span>
                        <span className="openbitfun-chat-input__slash-command-hint">{t('chatInput.selectHint')}</span>
                      </div>
                      <div className="openbitfun-chat-input__slash-command-list" data-openbitfun-component="chat-input" data-openbitfun-part="commandList">
                        {items.length === 0 && (mcpPromptCommandsLoading || resolvedModeSkillsLoading) ? (
                          <div className="openbitfun-chat-input__slash-command-empty" data-openbitfun-component="chat-input" data-openbitfun-part="commandEmpty">
                            {resolvedModeSkillsLoading && !mcpPromptCommandsLoading
                              ? t('chatInput.boostSkillsLoading')
                              : t('chatInput.loadingMcpPrompts')}
                          </div>
                        ) : items.length === 0 && resolvedModeSkillsLoadFailed ? (
                          <button
                            type="button"
                            className="openbitfun-chat-input__slash-command-empty openbitfun-chat-input__slash-command-empty--retry"
                            data-openbitfun-component="chat-input"
                            data-openbitfun-part="commandEmpty"
                            onClick={retryResolvedModeSkills}
                          >
                            {t('chatInput.boostSkillsLoadFailed')}
                          </button>
                        ) : items.length > 0 ? (
                          items.map((item, index) => {
                            const commandText = item.command;
                            const labelText = item.kind === 'skill'
                              ? item.label
                              : item.kind === 'mcpPrompt'
                                ? `${item.serverName} · ${item.label}`
                                : item.label;

                            return (
                              <React.Fragment key={`${item.kind}-${item.id}`}>
                                {index === firstSkillIndex && (
                                  <div className="openbitfun-chat-input__slash-command-section" data-openbitfun-component="chat-input" data-openbitfun-part="commandSection">
                                    <span className="openbitfun-chat-input__slash-command-section-line" aria-hidden />
                                    <span className="openbitfun-chat-input__slash-command-section-title">
                                      {t('chatInput.boostSkills')}
                                    </span>
                                    <span className="openbitfun-chat-input__slash-command-section-line" aria-hidden />
                                  </div>
                                )}
                                <div data-overflow-trigger
                                  data-openbitfun-component="chat-input"
                                  data-openbitfun-part="commandItem"
                                  data-openbitfun-command-item-kind={item.kind === 'mcpPrompt' ? 'mcp' : item.kind === 'externalCommand' || item.kind === 'acpCommand' ? 'action' : item.kind}
                                  data-openbitfun-state={index === slashCommandState.selectedIndex ? 'selected' : undefined}
                                  className={`openbitfun-chat-input__slash-command-item ${index === slashCommandState.selectedIndex ? 'openbitfun-chat-input__slash-command-item--selected' : ''}`}
                                  title={`${commandText}\n${labelText}`}
                                  onClick={() => {
                                    if (item.kind === 'skill') {
                                      selectSlashSkill(item);
                                    } else if (item.kind === 'externalCommand') {
                                      selectSlashExternalPromptCommand(item);
                                    } else if (item.kind === 'mcpPrompt') {
                                      selectSlashPromptCommand(item);
                                    } else if (item.kind === 'acpCommand') {
                                      selectSlashAcpCommand(item);
                                    } else {
                                      selectSlashCommandAction(item.id);
                                    }
                                  }}
                                  onMouseEnter={() => setSlashCommandState(prev => ({ ...prev, selectedIndex: index }))}
                                >
                                  <OverflowText className="openbitfun-chat-input__slash-command-name" data-openbitfun-component="chat-input" data-openbitfun-part="commandName">
                                    {commandText}
                                  </OverflowText>
                                  <span
                                    className={`openbitfun-chat-input__slash-command-label ${item.kind === 'skill' ? 'openbitfun-chat-input__slash-command-label--single-line' : ''}`}
                                    data-openbitfun-component="chat-input"
                                    data-openbitfun-part="commandLabel"
                                  >
                                    {labelText}
                                  </span>
                                  {item.kind === 'externalCommand' && item.status !== 'available' ? (
                                    <span
                                      className={`openbitfun-chat-input__slash-command-status openbitfun-chat-input__slash-command-status--${item.status === 'restricted' ? 'restricted' : 'choose'}`}
                                      data-openbitfun-component="chat-input"
                                      data-openbitfun-part="commandStatus"
                                      data-openbitfun-state={item.status}
                                    >
                                      {t(item.status === 'restricted'
                                        ? 'chatInput.commandStatus.restricted'
                                        : 'chatInput.commandStatus.chooseSource')}
                                    </span>
                                  ) : null}
                                </div>
                              </React.Fragment>
                            );
                          })
                        ) : (
                          <div className="openbitfun-chat-input__slash-command-empty" data-openbitfun-component="chat-input" data-openbitfun-part="commandEmpty">
                            {/* A catalog issue must not leave the list blank: say why nothing is listed. */}
                            {externalPromptCommandsIssue === 'host_unavailable'
                              ? t('chatInput.externalCommandsHostUnavailable')
                              : externalPromptCommandsIssue === 'load_failed'
                                ? t('chatInput.externalCommandsLoadFailed')
                                : t('chatInput.noMatchingCommand')}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }

                if (slashCommandState.kind === 'skills') {
                  const items = getActiveSlashPickerItems();
                  return (
                    <div
                      ref={slashCommandPickerRef}
                      data-openbitfun-component="chat-input"
                      data-openbitfun-part="commandPicker"
                      data-openbitfun-command="skills"
                      data-openbitfun-state="open"
                      data-openbitfun-placement={slashCommandPickerLayout?.placement ?? 'top'}
                      className="openbitfun-chat-input__slash-command-picker"
                      style={{
                        top: `${slashCommandPickerLayout?.top ?? 0}px`,
                        left: `${slashCommandPickerLayout?.left ?? 0}px`,
                        visibility: slashCommandPickerLayout ? 'visible' : 'hidden',
                      }}
                    >
                      <div className="openbitfun-chat-input__slash-command-header" data-openbitfun-component="chat-input" data-openbitfun-part="commandHeader">
                        <span>{t('chatInput.boostSkills')}</span>
                        <span className="openbitfun-chat-input__slash-command-hint">{t('chatInput.selectHint')}</span>
                      </div>
                      <div className="openbitfun-chat-input__slash-command-list" data-openbitfun-component="chat-input" data-openbitfun-part="commandList">
                        {items.length === 0 && resolvedModeSkillsLoading ? (
                          <div className="openbitfun-chat-input__slash-command-empty" data-openbitfun-component="chat-input" data-openbitfun-part="commandEmpty">
                            {t('chatInput.boostSkillsLoading')}
                          </div>
                        ) : items.length === 0 && resolvedModeSkillsLoadFailed ? (
                          <button
                            type="button"
                            className="openbitfun-chat-input__slash-command-empty openbitfun-chat-input__slash-command-empty--retry"
                            data-openbitfun-component="chat-input"
                            data-openbitfun-part="commandEmpty"
                            onClick={retryResolvedModeSkills}
                          >
                            {t('chatInput.boostSkillsLoadFailed')}
                          </button>
                        ) : items.length > 0 ? (
                          items.map((item, index) => {
                            const commandText = item.command;
                            const labelText = item.kind === 'skill'
                              ? item.label
                                : item.kind === 'mcpPrompt'
                                  ? `${item.serverName} · ${item.label}`
                                  : item.label;

                            return (
                              <div data-overflow-trigger data-openbitfun-component="chat-input" data-openbitfun-part="commandItem"
                                data-openbitfun-command-item-kind={item.kind === 'mcpPrompt' ? 'mcp' : item.kind === 'externalCommand' || item.kind === 'acpCommand' ? 'action' : item.kind}
                                data-openbitfun-state={index === slashCommandState.selectedIndex ? 'selected' : undefined}
                                key={`${item.kind}-${item.id}`}
                                className={`openbitfun-chat-input__slash-command-item ${index === slashCommandState.selectedIndex ? 'openbitfun-chat-input__slash-command-item--selected' : ''}`}
                                title={`${commandText}\n${labelText}`}
                                onClick={() => {
                                  if (item.kind === 'skill') {
                                    selectSlashSkill(item);
                                  } else if (item.kind === 'externalCommand') {
                                    selectSlashExternalPromptCommand(item);
                                  } else if (item.kind === 'mcpPrompt') {
                                    selectSlashPromptCommand(item);
                                  } else if (item.kind === 'acpCommand') {
                                    selectSlashAcpCommand(item);
                                  } else {
                                    selectSlashCommandAction(item.id);
                                  }
                                }}
                                onMouseEnter={() => setSlashCommandState(prev => ({ ...prev, selectedIndex: index }))}
                              >
                                <OverflowText className="openbitfun-chat-input__slash-command-name" data-openbitfun-component="chat-input" data-openbitfun-part="commandName">
                                  {commandText}
                                </OverflowText>
                                <span
                                  className={`openbitfun-chat-input__slash-command-label ${item.kind === 'skill' ? 'openbitfun-chat-input__slash-command-label--single-line' : ''}`}
                                  data-openbitfun-component="chat-input"
                                  data-openbitfun-part="commandLabel"
                                >
                                  {labelText}
                                </span>
                              </div>
                            );
                          })
                        ) : (
                          <div className="openbitfun-chat-input__slash-command-empty" data-openbitfun-component="chat-input" data-openbitfun-part="commandEmpty">
                            {t('chatInput.noMatchingCommand')}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }

                return null;
              })(), getAppearanceOverlayHost())}
            </div>
                </div>
              </ChatComposerContent>

              <ChatComposerStartActions>
              <div className="openbitfun-chat-input__actions-left" data-openbitfun-component="chat-input" data-openbitfun-part="actionsLeft">
                <div
                  className="openbitfun-chat-input__agent-boost"
                  data-openbitfun-component="chat-input"
                  data-openbitfun-part="boost"
                  data-testid="chat-input-agent-boost"
                  ref={agentBoostRef}
                >
                  {!isAcpTargetSession && (
                    <span className="openbitfun-chat-input__agent-boost-trigger" ref={boostTriggerRef} data-openbitfun-component="chat-input" data-openbitfun-part="boostTrigger" data-openbitfun-state={modeState.dropdownOpen ? 'open' : undefined}>
                      <Tooltip content={t('chatInput.addBoostTooltip')}>
                        <ChatComposerActionButton
                          aria-label={t('chatInput.addBoostTooltip')}
                          className="openbitfun-chat-input__agent-boost-add"
                          data-testid="chat-input-agent-boost-trigger"
                          aria-haspopup="menu"
                          aria-expanded={modeState.dropdownOpen}
                          onClick={e => {
                            e.stopPropagation();
                            if (!modeState.dropdownOpen) {
                              void refreshWorkspaceModeCatalog();
                            }
                            dispatchMode({ type: 'TOGGLE_DROPDOWN' });
                          }}
                          icon={<Icon name="plus" size="lg" />}
                          variant="fill"
                        />
                      </Tooltip>
                    </span>
                  )}

                  {modeState.dropdownOpen && createPortal(
                    <Menu
                      ref={boostMenuRef}
                      className="openbitfun-chat-input__mode-dropdown openbitfun-chat-input__mode-dropdown--agent-boost"
                      data-openbitfun-component="chat-input"
                      data-openbitfun-part="boostMenu"
                      data-openbitfun-state="open"
                      data-openbitfun-placement={boostMenuLayout?.placement ?? 'top'}
                      style={{
                        top: `${boostMenuLayout?.top ?? 0}px`,
                        left: `${boostMenuLayout?.left ?? 0}px`,
                        visibility: boostMenuLayout ? 'visible' : 'hidden',
                      }}
                      autoFocusFirstItem
                      aria-label={t('chatInput.addBoostTooltip')}
                    >
                      {!isMultiLine && executionLevelPolicy.userConfigurable ? (
                        <>
                          <HarnessProfileSelector
                            {...harnessProfileSelectorProps}
                            presentation="menu-item"
                            open={activeBoostSubmenu === 'harness'}
                            onOpenChange={open => setBoostSubmenuOpen('harness', open)}
                            onSelectionComplete={() => dispatchMode({ type: 'CLOSE_DROPDOWN' })}
                          />
                          <MenuSeparator data-openbitfun-component="chat-input" data-openbitfun-part="boostDivider" />
                        </>
                      ) : null}

                      {showAdditionalModes && (
                        <>
                          <ChatInputBoostSubmenu
                            label={t('chatInput.boostAdditionalModes')}
                            icon={<Icon name="spark" size="sm" aria-hidden />}
                            testId="chat-input-additional-modes"
                            open={activeBoostSubmenu === 'additional-modes'}
                            onOpenChange={open => setBoostSubmenuOpen('additional-modes', open)}
                          >
                            {additionalModeItems.map(item => (
                              <MenuItem
                                key={item.id}
                                data-openbitfun-component="chat-input"
                                data-openbitfun-part="boostSubmenuItem"
                                data-openbitfun-boost-item-kind="additional-mode"
                                data-openbitfun-additional-mode-id={item.id}
                                data-testid={`chat-input-additional-mode-${item.id}`}
                                title={item.title}
                                leading={<Icon name="spark" size="xs" aria-hidden />}
                                onClick={event => {
                                  event.stopPropagation();
                                  selectAdditionalMode(item.skillName);
                                }}
                              >
                                {item.label}
                              </MenuItem>
                            ))}
                          </ChatInputBoostSubmenu>
                          <MenuSeparator data-openbitfun-component="chat-input" data-openbitfun-part="boostDivider" />
                        </>
                      )}

                      <>
                        <MenuItem
                          data-openbitfun-component="chat-input"
                          data-openbitfun-part="boostItem"
                          data-openbitfun-boost-item-kind="context"
                          leading={<Icon name="files" size="sm" aria-hidden />}
                          onClick={handleBoostOpenAtContext}
                        >
                          {t('chatInput.boostAddContext')}
                        </MenuItem>

                        <MenuItem
                          data-openbitfun-component="chat-input"
                          data-openbitfun-part="boostItem"
                          data-openbitfun-boost-item-kind="context"
                          leading={<Icon name="image" size="sm" aria-hidden />}
                          onClick={handleBoostPickImage}
                        >
                          {t('input.addImage')}
                        </MenuItem>

                        {canUseSkillsForTarget && (
                          <ChatInputBoostSubmenu
                            label={t('chatInput.boostSkills')}
                            icon={<Icon name="spark" size="sm" aria-hidden />}
                            testId="chat-input-skills"
                            open={activeBoostSubmenu === 'skills'}
                            onOpenChange={open => setBoostSubmenuOpen('skills', open)}
                          >
                            {resolvedModeSkillsLoading && !resolvedModeSkillsLoaded ? (
                              <div className="openbitfun-chat-input__boost-submenu-loading" data-openbitfun-component="chat-input" data-openbitfun-part="boostSubmenuState" data-openbitfun-state="loading">
                                <Loader2 size={14} className="openbitfun-chat-input__boost-submenu-spinner" aria-hidden />
                                <span>{t('chatInput.boostSkillsLoading')}</span>
                              </div>
                            ) : resolvedModeSkillsLoadFailed ? (
                              <MenuItem
                                data-openbitfun-component="chat-input"
                                data-openbitfun-part="boostSubmenuState"
                                leading={<RotateCcw size={13} aria-hidden />}
                                onClick={event => {
                                  event.stopPropagation();
                                  retryResolvedModeSkills();
                                }}
                              >
                                {t('chatInput.boostSkillsLoadFailed')}
                              </MenuItem>
                            ) : userInvocableSkills.length === 0 ? (
                              <div className="openbitfun-chat-input__boost-submenu-empty" data-openbitfun-component="chat-input" data-openbitfun-part="boostSubmenuState" data-openbitfun-state="empty">{t('chatInput.boostSkillsEmpty')}</div>
                            ) : (
                              userInvocableSkills.map(skill => (
                                <MenuItem
                                  key={skill.key}
                                  data-openbitfun-component="chat-input"
                                  data-openbitfun-part="boostSubmenuItem"
                                  data-openbitfun-boost-item-kind="skill"
                                  title={skill.description || skill.name}
                                  leading={<Icon name="spark" size="xs" aria-hidden />}
                                  onClick={event => {
                                    event.stopPropagation();
                                    insertSkillIntoInput(skill.name);
                                  }}
                                >
                                  {[skill.name, skill.argumentHint?.trim()].filter(Boolean).join(' ')}
                                </MenuItem>
                              ))
                            )}
                            <MenuSeparator />
                            <MenuItem
                              data-openbitfun-component="chat-input"
                              data-openbitfun-part="boostSubmenuManage"
                              data-openbitfun-boost-item-kind="manage"
                              onClick={handleOpenSkillsLibrary}
                            >
                              {t('chatInput.openSkillsLibrary')}
                            </MenuItem>
                          </ChatInputBoostSubmenu>
                        )}

                        {!!currentSessionId && !isBtwSession && (
                          <>
                            <MenuSeparator data-openbitfun-component="chat-input" data-openbitfun-part="boostDivider" />
                            <MenuItem
                              data-openbitfun-component="chat-input"
                              data-openbitfun-part="boostItem"
                              data-openbitfun-boost-item-kind="context"
                              data-testid="chat-input-boost-start-btw"
                              leading={<Icon name="side-chat" size="sm" aria-hidden />}
                              onClick={handleBoostStartBtw}
                            >
                              {t('chatInput.boostStartBtw')}
                            </MenuItem>
                          </>
                        )}

                        {(!currentSessionId || isBtwSession) && (
                          <MenuSeparator data-openbitfun-component="chat-input" data-openbitfun-part="boostDivider" />
                        )}
                        <MenuItem
                          data-openbitfun-component="chat-input"
                          data-openbitfun-part="boostItem"
                          data-openbitfun-boost-item-kind="context"
                          data-testid="chat-input-boost-new-session"
                          leading={<Icon name="plus" size="sm" aria-hidden />}
                          onClick={handleBoostNewSession}
                        >
                          {t('chatInput.boostNewSession')}
                        </MenuItem>
                      </>
                    </Menu>,
                    getAppearanceOverlayHost(),
                  )}
                </div>
                {isMultiLine && executionLevelPolicy.userConfigurable ? (
                  <HarnessProfileSelector
                    {...harnessProfileSelectorProps}
                    presentation="standalone"
                  />
                ) : null}
              </div>

              </ChatComposerStartActions>

              <ChatComposerEndActions>
              <div className="openbitfun-chat-input__actions-right" data-openbitfun-component="chat-input" data-openbitfun-part="actionsRight">
                {voiceInput.phase === 'idle' ? (
                  <div className="openbitfun-chat-input__model-usage-group" data-openbitfun-component="chat-input" data-openbitfun-part="model">
                  <ModelSelector
                    currentMode={effectiveSendAgentType}
                    sessionId={effectiveTargetSessionId || undefined}
                    isSubagentSession={isSubagentInputTarget}
                    currentTokens={tokenUsage.current}
                    maxTokens={tokenUsage.max}
                    contextUsageSource={tokenUsage.source}
                    onLoadingChange={handleModelLoadingChange}
                    onAvailabilityChange={setModelAvailability}
                    externalSelection={dispatchModelSelection}
                    modeDefaultModelId={targetModeInfo?.model}
                    persistSharedModeDefault={Boolean(targetModeInfo && targetModeInfo.source !== 'external')}
                    disabled={isInterruptedTurnRecoveryInFlight}
                    reasoningTriggerPresentation="label"
                  />
                  </div>
                ) : null}

                {!realtimeVoiceCallActive
                  && !caps.transferInFlight
                  && !isInterruptedTurnRecoveryInFlight ? (
                  <ComposerVoiceInputButton controller={voiceInput} />
                ) : null}
                {voiceInput.phase === 'idle' ? renderActionButton() : null}
              </div>
              </ChatComposerEndActions>
            </ChatComposer>
          </div>
        </div>
      </div>
      {effectiveTargetSession && canUseThreadGoal ? (
        <ThreadGoalDialogs
          controller={threadGoalController}
          disabled={!effectiveTargetSession.workspacePath}
        />
      ) : null}
    </ContextDropZone>
    </>
  );
};

export default ChatInput;
