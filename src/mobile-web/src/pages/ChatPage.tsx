import { downloadRuntimeFile } from '../services/RuntimeFileDownload';
import { PermissionMailbox } from '../components/PermissionMailbox';
import { QuestionInteractionContext } from "../components/ChatAskQuestionCard";
import { ChevronDown as LucideChevronDown } from 'lucide-react';
import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import { MobileIconButton } from '@openbitfun/ui/mobile';
import { useI18n } from '../i18n';
import { useControlTargetEpoch } from '../hooks/useControlTargetEpoch';
import {
  isRemoteControlTargetChangedError,
  RemoteControlTargetChangedError,
  RemoteSessionManager,
  SessionSynchronizer,
  type PollResponse,
  type ChatMessage,
  type RemoteModelCatalog,
} from '../services/RemoteSessionManager';
import { useMobileStore } from '../services/store';
import { createRemoteCacheScope, remoteCache } from '../services/RemoteCache';
import ChatHeader from '../components/ChatHeader';
import ChatComposerBar from '../components/ChatComposerBar';
import {
  loadLastSelectedModelId,
  ModelSelectorPill,
  normalizeSelectedModelId,
  persistLastSelectedModelId,
  resolvePreferredModelSelection,
} from '../components/ChatModelControls';
import ChatMessageActions from '../components/ChatMessageActions';
import ChatFeedback from '../components/ChatFeedback';
import { copyToClipboard } from '../components/ChatMarkdown';
import { ArtifactImageReader } from '../components/RemoteArtifactImage';
import ChatTranscript from '../components/ChatTranscript';

function reportRemoteSessionError(
  error: unknown,
  setError: (message: string) => void,
): void {
  if (isRemoteControlTargetChangedError(error)) return;
  setError(error instanceof Error ? error.message : String(error));
}

interface ChatPageProps {
  sessionMgr: RemoteSessionManager;
  sessionId: string;
  sessionName?: string;
  agentType?: string;
  onBack: () => void;
  autoFocus?: boolean;
  wideLayout?: boolean;
}

// ─── Markdown ───────────────────────────────────────────────────────────────

function sanitizeMessageText(content: string): string {
  return content
    .replace(/#img:\S+\s*/g, '')
    .replace(/\[Image:.*?\]\n(?:Path:.*?\n|Image ID:.*?\n)?/g, '')
    .trim();
}


// ─── Thinking (ModelThinkingDisplay-style) ───────────────────────────────────



// ─── ChatPage ───────────────────────────────────────────────────────────────

const ChatPage: React.FC<ChatPageProps> = ({
  sessionMgr,
  sessionId,
  sessionName,
  agentType: sessionAgentType = 'Standard',
  onBack,
  autoFocus,
  wideLayout = false,
}) => {
  const { t } = useI18n();
  const {
    getMessages,
    setMessages,
    appendNewMessages,
    activeTurn,
    setActiveTurn,
    error,
    setError,
    currentWorkspace,
    authenticatedUserId,
    controlTarget,
    connectionHealth,
    updateSessionName,
  } = useMobileStore();

  const messages = getMessages(sessionId);
  const [input, setInput] = useState('');
  const [liveTitle, setLiveTitle] = useState(sessionName);
  const [modelCatalog, setModelCatalog] = useState<RemoteModelCatalog | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string>('auto');
  const [modelUpdating, setModelUpdating] = useState(false);
  const [pendingImages, setPendingImages] = useState<{ name: string; dataUrl: string }[]>([]);
  const [imageAnalyzing, setImageAnalyzing] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const sendInFlightRef = useRef<symbol | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [optimisticMsg, setOptimisticMsg] = useState<{
    id: string; text: string; images: { name: string; data_url: string }[];
  } | null>(null);
  const [inputExpanded, setInputExpanded] = useState(!!autoFocus);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputBarRef = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(56);

  useLayoutEffect(() => {
    const bar = inputBarRef.current;
    if (!bar) return;
    const measure = () => setComposerHeight(Math.ceil(bar.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const editor = inputRef.current;
    if (!editor) return;
    const resize = () => {
      editor.style.height = 'auto';
      editor.style.height = `${editor.scrollHeight}px`;
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [input, inputExpanded, wideLayout]);

  const [mailboxInvalidation, setMailboxInvalidation] = useState(0);
  const streamRef = useRef<SessionSynchronizer | null>(null);
  const messagesRequestSeqRef = useRef(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const isLoadingMoreRef = useRef(false);
  const hasMoreRef = useRef(true);
  const controlTargetEpoch = useControlTargetEpoch(sessionMgr);
  const cacheScope = useMemo(() => createRemoteCacheScope(
    authenticatedUserId,
    controlTarget?.deviceId ?? sessionMgr.controlTargetDeviceId,
  ), [authenticatedUserId, controlTarget?.deviceId, sessionMgr, controlTargetEpoch]);
  const chatTargetOwnerRef = useRef({
    sessionMgr,
    sessionId,
    epoch: controlTargetEpoch,
    active: true,
  });

  if (
    chatTargetOwnerRef.current.sessionMgr !== sessionMgr
    || chatTargetOwnerRef.current.sessionId !== sessionId
    || chatTargetOwnerRef.current.epoch !== controlTargetEpoch
  ) {
    chatTargetOwnerRef.current = {
      sessionMgr,
      sessionId,
      epoch: controlTargetEpoch,
      active: true,
    };
  }

  const captureChatTargetEpoch = useCallback((): number | null => {
    const owner = chatTargetOwnerRef.current;
    if (
      !owner.active
      || owner.sessionMgr !== sessionMgr
      || owner.sessionId !== sessionId
      || owner.epoch !== sessionMgr.controlTargetEpoch
    ) {
      return null;
    }
    return owner.epoch;
  }, [controlTargetEpoch, sessionId, sessionMgr]);

  const isChatTargetCurrent = useCallback((epoch: number | null): boolean => {
    const owner = chatTargetOwnerRef.current;
    return epoch !== null
      && owner.active
      && owner.sessionMgr === sessionMgr
      && owner.sessionId === sessionId
      && owner.epoch === epoch
      && sessionMgr.controlTargetEpoch === epoch;
  }, [controlTargetEpoch, sessionId, sessionMgr]);

  const modelSelectionInitializedRef = useRef(false);
  const modelCatalogRequestSeqRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [expandedMsgIds, setExpandedMsgIds] = useState<Set<string>>(new Set());
  const [infoToast, setInfoToast] = useState<string | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [menuMessage, setMenuMessage] = useState<ChatMessage | null>(null);
  const [actionToast, setActionToast] = useState<string | null>(null);
  const [deletingMsg, setDeletingMsg] = useState(false);
  const msgLongPressTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const msgLongPressPosRef = useRef({ x: 0, y: 0 });
  const msgToastTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const committedChatTargetRef = useRef({ sessionMgr, sessionId, epoch: controlTargetEpoch });

  useLayoutEffect(() => {
    const previous = committedChatTargetRef.current;
    const targetChanged = previous.sessionMgr !== sessionMgr
      || previous.sessionId !== sessionId
      || previous.epoch !== controlTargetEpoch;
    const owner = chatTargetOwnerRef.current;
    owner.active = owner.sessionMgr === sessionMgr
      && owner.sessionId === sessionId
      && owner.epoch === controlTargetEpoch
      && sessionMgr.controlTargetEpoch === controlTargetEpoch;
    if (targetChanged) {
      messagesRequestSeqRef.current += 1;
      modelCatalogRequestSeqRef.current += 1;
      isLoadingMoreRef.current = false;
      hasMoreRef.current = true;
      setIsLoadingMore(false);
      setHasMore(true);
      setModelUpdating(false);
      setImageAnalyzing(false);
      setIsSending(false);
      sendInFlightRef.current = null;
      setIsCancelling(false);
      setOptimisticMsg(null);
      modelSelectionInitializedRef.current = false;
      setModelCatalog(null);
      setSelectedModelId('auto');
      setMessages(sessionId, []);
      setMenuMessage(null);
      setDeletingMsg(false);
      setActionToast(null);
      setInfoToast(null);
      setExpandedMsgIds(new Set());
      setShowScrollToBottom(false);
      setActiveTurn(null);
      if (msgLongPressTimerRef.current) {
        clearTimeout(msgLongPressTimerRef.current);
        msgLongPressTimerRef.current = undefined;
      }
      if (msgToastTimerRef.current) {
        clearTimeout(msgToastTimerRef.current);
        msgToastTimerRef.current = undefined;
      }
      streamRef.current?.stop();
      streamRef.current = null;
    }
    committedChatTargetRef.current = { sessionMgr, sessionId, epoch: controlTargetEpoch };
    return () => {
      owner.active = false;
      messagesRequestSeqRef.current += 1;
      modelCatalogRequestSeqRef.current += 1;
      streamRef.current?.stop();
    };
  }, [controlTargetEpoch, sessionId, sessionMgr, setActiveTurn, setMessages]);

  const isStreaming = activeTurn != null && activeTurn.status === 'active';

  useEffect(() => {
    if (!isStreaming) setIsCancelling(false);
  }, [isStreaming]);

  const [now, setNow] = useState(() => Date.now());
  const handleQuestionInteraction = useCallback(async (toolId: string) => {
    const targetEpoch = captureChatTargetEpoch();
    if (targetEpoch === null) throw new RemoteControlTargetChangedError();
    try {
      await sessionMgr.startQuestionInteraction(sessionId, toolId);
      if (!isChatTargetCurrent(targetEpoch)) throw new RemoteControlTargetChangedError();
    } catch (err) {
      if (isChatTargetCurrent(targetEpoch)) setError(t('common.questionTimeoutActive'));
      throw err;
    }
  }, [captureChatTargetEpoch, isChatTargetCurrent, sessionMgr, sessionId, setError, t]);

  const handleAnswerQuestion = useCallback(async (toolId: string, answers: any) => {
    const targetEpoch = captureChatTargetEpoch();
    if (targetEpoch === null) throw new RemoteControlTargetChangedError();
    try {
      await sessionMgr.answerQuestion(toolId, answers);
      if (!isChatTargetCurrent(targetEpoch)) throw new RemoteControlTargetChangedError();
    } catch (err) {
      reportRemoteSessionError(err, setError);
      throw err;
    }
  }, [captureChatTargetEpoch, isChatTargetCurrent, sessionMgr, setError]);

  const handleApproveTool = useCallback(async (toolId: string, updatedInput?: Record<string, unknown>) => {
    const targetEpoch = captureChatTargetEpoch();
    if (targetEpoch === null) throw new RemoteControlTargetChangedError();
    try {
      await sessionMgr.confirmTool(toolId, updatedInput);
      if (!isChatTargetCurrent(targetEpoch)) throw new RemoteControlTargetChangedError();
      streamRef.current?.nudge();
    } catch (err) {
      throw err;
    }
  }, [captureChatTargetEpoch, isChatTargetCurrent, sessionMgr, setError]);

  const handleRejectTool = useCallback(async (toolId: string) => {
    const targetEpoch = captureChatTargetEpoch();
    if (targetEpoch === null) throw new RemoteControlTargetChangedError();
    try {
      await sessionMgr.rejectTool(toolId, t('chat.rejectedByUser'));
      if (!isChatTargetCurrent(targetEpoch)) throw new RemoteControlTargetChangedError();
      streamRef.current?.nudge();
    } catch (err) {
      throw err;
    }
  }, [captureChatTargetEpoch, isChatTargetCurrent, sessionMgr, setError, t]);

  const handleCancelTool = useCallback((toolId: string, reason = t('common.cancel')) => {
    if (captureChatTargetEpoch() === null) return;
    sessionMgr.cancelTool(toolId, reason).catch((error) => {
      reportRemoteSessionError(error, setError);
    });
  }, [captureChatTargetEpoch, sessionMgr, setError, t]);

  /** Fetch metadata for a workspace file before the user confirms the download. */
  const handleGetFileInfo = useCallback(
    async (filePath: string) => {
      const targetEpoch = captureChatTargetEpoch();
      if (targetEpoch === null) throw new RemoteControlTargetChangedError();
      const info = await sessionMgr.getFileInfo(filePath, sessionId);
      if (!isChatTargetCurrent(targetEpoch)) throw new RemoteControlTargetChangedError();
      return info;
    },
    [captureChatTargetEpoch, isChatTargetCurrent, sessionId, sessionMgr],
  );

  const readArtifactImage = useMemo(() => {
    const pending = new Map<string, Promise<string>>();
    return (filePath: string, refresh = false): Promise<string> => {
      const targetEpoch = captureChatTargetEpoch();
      if (targetEpoch === null) return Promise.reject(new RemoteControlTargetChangedError());
      if (refresh) pending.delete(filePath);
      const cached = pending.get(filePath);
      if (cached) return cached;
      const request = (async () => {
        const file = await sessionMgr.readFile(filePath, sessionId, undefined, 8 * 1024 * 1024);
        if (!isChatTargetCurrent(targetEpoch)) throw new RemoteControlTargetChangedError();
        if (!/^image\/(?:png|jpeg|gif|webp|bmp|svg\+xml|avif|x-icon)$/i.test(file.mimeType)) {
          throw new Error(t('chat.fileUnavailable'));
        }
        return `data:${file.mimeType};base64,${file.contentBase64}`;
      })().finally(() => {
        if (pending.get(filePath) === request) pending.delete(filePath);
      });
      // Deduplicate concurrent reads without retaining bytes after the path changes.
      if (pending.size >= 24) pending.delete(pending.keys().next().value!);
      pending.set(filePath, request);
      return request;
    };
  }, [captureChatTargetEpoch, isChatTargetCurrent, sessionMgr, sessionId, t]);

  /** Download a workspace file referenced by a `computer://` link. */
  const handleFileDownload = useCallback(async (
    filePath: string,
    onProgress?: (downloaded: number, total: number) => void,
  ) => {
    const targetEpoch = captureChatTargetEpoch();
    if (targetEpoch === null) return;
    try {
      await downloadRuntimeFile(sessionMgr, filePath, {
        sessionId, isCurrent: () => isChatTargetCurrent(targetEpoch), onProgress,
      });
    } catch (err) {
      if (isChatTargetCurrent(targetEpoch)) reportRemoteSessionError(err, setError);
      throw err;
    }
  }, [captureChatTargetEpoch, isChatTargetCurrent, sessionId, sessionMgr, setError]);

  const loadModelCatalog = useCallback(async () => {
    const targetEpoch = captureChatTargetEpoch();
    if (targetEpoch === null) return null;
    const requestSeq = ++modelCatalogRequestSeqRef.current;
    try {
      const catalog = await sessionMgr.getModelCatalog(sessionId);
      if (
        requestSeq !== modelCatalogRequestSeqRef.current
        || !isChatTargetCurrent(targetEpoch)
      ) return null;
      setModelCatalog(catalog);
      if (!modelSelectionInitializedRef.current) {
        const preferredSelection = resolvePreferredModelSelection(loadLastSelectedModelId(), catalog);
        const sessionModelId = normalizeSelectedModelId(catalog.session_model_id || 'auto', catalog);
        const nextModelId = preferredSelection.modelId || sessionModelId;

        if (preferredSelection.modelId && preferredSelection.modelId !== sessionModelId) {
          const selection = catalog.reasoning_preset_selection_supported === true
            ? await sessionMgr.setSessionModelSelection(sessionId, preferredSelection.modelId, null)
            : {
                model_id: await sessionMgr.setSessionModel(sessionId, preferredSelection.modelId),
                reasoning_preset: null,
              };
          if (
            requestSeq !== modelCatalogRequestSeqRef.current
            || !isChatTargetCurrent(targetEpoch)
          ) return null;
          const normalizedModelId = selection.model_id;
          setSelectedModelId(normalizedModelId || 'auto');
          setModelCatalog(current => current ? {
            ...current,
            session_model_id: normalizedModelId,
            session_reasoning_preset: selection.reasoning_preset,
          } : current);
          if (preferredSelection.fellBackToAuto && (!normalizedModelId || normalizedModelId === 'auto')) {
            persistLastSelectedModelId('auto');
          }
        } else {
          setSelectedModelId(nextModelId || 'auto');
          if (preferredSelection.fellBackToAuto && nextModelId === 'auto') {
            persistLastSelectedModelId('auto');
          }
        }
        modelSelectionInitializedRef.current = true;
      }
      return catalog;
    } catch (err) {
      if (
        requestSeq === modelCatalogRequestSeqRef.current
        && isChatTargetCurrent(targetEpoch)
      ) reportRemoteSessionError(err, setError);
      return null;
    }
  }, [captureChatTargetEpoch, isChatTargetCurrent, sessionId, sessionMgr, setError]);

  const handleSelectModel = useCallback(async (modelId: string) => {
    if (modelUpdating || isStreaming || imageAnalyzing) return;
    const targetEpoch = captureChatTargetEpoch();
    if (targetEpoch === null) return;
    setModelUpdating(true);
    try {
      const selection = modelCatalog?.reasoning_preset_selection_supported === true
        ? await sessionMgr.setSessionModelSelection(sessionId, modelId, null)
        : {
            model_id: await sessionMgr.setSessionModel(sessionId, modelId),
            reasoning_preset: null,
          };
      if (!isChatTargetCurrent(targetEpoch)) return;
      const normalizedModelId = selection.model_id;
      setSelectedModelId(normalizedModelId || 'auto');
      setModelCatalog(current => current ? {
        ...current,
        session_model_id: normalizedModelId,
        session_reasoning_preset: selection.reasoning_preset,
      } : current);
      persistLastSelectedModelId(normalizedModelId || 'auto');
    } catch (err) {
      reportRemoteSessionError(err, setError);
    } finally {
      if (isChatTargetCurrent(targetEpoch)) setModelUpdating(false);
    }
  }, [captureChatTargetEpoch, imageAnalyzing, isChatTargetCurrent, isStreaming, modelCatalog?.reasoning_preset_selection_supported, modelUpdating, sessionId, sessionMgr, setError]);

  const handleSelectReasoningPreset = useCallback(async (reasoningPreset: string | null) => {
    if (
      modelUpdating
      || isStreaming
      || imageAnalyzing
      || modelCatalog?.reasoning_preset_selection_supported !== true
    ) return;
    const targetEpoch = captureChatTargetEpoch();
    if (targetEpoch === null) return;
    const previousReasoningPreset = modelCatalog.session_reasoning_preset ?? null;
    setModelUpdating(true);
    setModelCatalog(current => current ? {
      ...current,
      session_reasoning_preset: reasoningPreset,
    } : current);
    try {
      const selection = await sessionMgr.setSessionModelSelection(
        sessionId,
        selectedModelId,
        reasoningPreset,
      );
      if (!isChatTargetCurrent(targetEpoch)) return;
      setSelectedModelId(selection.model_id || 'auto');
      setModelCatalog(current => current ? {
        ...current,
        session_model_id: selection.model_id,
        session_reasoning_preset: selection.reasoning_preset,
      } : current);
    } catch (err) {
      if (isChatTargetCurrent(targetEpoch)) {
        setModelCatalog(current => current ? {
          ...current,
          session_reasoning_preset: previousReasoningPreset,
        } : current);
        reportRemoteSessionError(err, setError);
      }
    } finally {
      if (isChatTargetCurrent(targetEpoch)) setModelUpdating(false);
    }
  }, [captureChatTargetEpoch, imageAnalyzing, isChatTargetCurrent, isStreaming, modelCatalog?.reasoning_preset_selection_supported, modelUpdating, selectedModelId, sessionId, sessionMgr, setError]);

  useEffect(() => {
    if (!isStreaming) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [isStreaming]);

  useEffect(() => {
    if (!infoToast) return;
    const timer = setTimeout(() => setInfoToast(null), 3200);
    return () => clearTimeout(timer);
  }, [infoToast]);

  const loadMessages = useCallback(async (beforeId?: string) => {
    if (beforeId && (isLoadingMoreRef.current || !hasMoreRef.current)) return;
    const targetEpoch = captureChatTargetEpoch();
    if (targetEpoch === null) return;
    const requestSeq = ++messagesRequestSeqRef.current;
    try {
      isLoadingMoreRef.current = true;
      setIsLoadingMore(true);
      await streamRef.current?.loadOlder();
    } catch (e: any) {
      if (
        requestSeq === messagesRequestSeqRef.current
        && isChatTargetCurrent(targetEpoch)
      ) reportRemoteSessionError(e, setError);
    } finally {
      if (
        requestSeq === messagesRequestSeqRef.current
        && isChatTargetCurrent(targetEpoch)
      ) {
        isLoadingMoreRef.current = false;
        setIsLoadingMore(false);
      }
    }
  }, [cacheScope, captureChatTargetEpoch, getMessages, isChatTargetCurrent, sessionId, sessionMgr, setError, setMessages]);

  // ── Message long-press context menu ──────────────────────────────
  const clearMsgLongPressTimer = () => {
    if (msgLongPressTimerRef.current) {
      clearTimeout(msgLongPressTimerRef.current);
      msgLongPressTimerRef.current = undefined;
    }
  };

  const handleMsgTouchStart = useCallback((m: ChatMessage, e: React.TouchEvent) => {
    if (deletingMsg) return;
    clearMsgLongPressTimer();
    msgLongPressPosRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    msgLongPressTimerRef.current = setTimeout(() => {
      setMenuMessage(m);
      msgLongPressTimerRef.current = undefined;
    }, 500);
  }, [deletingMsg]);

  const handleMsgTouchMove = useCallback((e: React.TouchEvent) => {
    const dx = Math.abs(e.touches[0].clientX - msgLongPressPosRef.current.x);
    const dy = Math.abs(e.touches[0].clientY - msgLongPressPosRef.current.y);
    if (dx > 10 || dy > 10) clearMsgLongPressTimer();
  }, []);

  const handleMsgTouchEnd = useCallback(() => {
    clearMsgLongPressTimer();
  }, []);

  const showMsgToast = useCallback((msg: string) => {
    if (msgToastTimerRef.current) clearTimeout(msgToastTimerRef.current);
    setActionToast(msg);
    msgToastTimerRef.current = setTimeout(() => setActionToast(null), 2000);
  }, []);

  const handleCopyMessage = useCallback(async () => {
    if (!menuMessage) return;
    const text = sanitizeMessageText(menuMessage.content);
    try {
      await copyToClipboard(text);
      showMsgToast(t('chat.messageCopied'));
    } catch {
      showMsgToast(t('chat.copyFailed'));
    }
    setMenuMessage(null);
  }, [menuMessage, showMsgToast, t]);

  const handleResendMessage = useCallback(async () => {
    if (!menuMessage || menuMessage.role !== 'user') return;
    const targetEpoch = captureChatTargetEpoch();
    if (targetEpoch === null) return;
    const text = sanitizeMessageText(menuMessage.content);
    if (!text) return;
    setMenuMessage(null);
    const imageContexts = menuMessage.images?.length
      ? menuMessage.images.map((img, idx) => {
          const mimeType = img.data_url.split(';')[0]?.replace('data:', '') || 'image/png';
          return {
            id: `mobile_resend_${Date.now()}_${idx}`,
            data_url: img.data_url,
            mime_type: mimeType,
            metadata: { name: img.name, source: 'remote' },
          };
        })
      : undefined;
    try {
      await sessionMgr.sendMessage(sessionId, text, sessionAgentType, imageContexts);
      if (!isChatTargetCurrent(targetEpoch)) return;
      streamRef.current?.nudge();
    } catch (e: any) {
      reportRemoteSessionError(e, setError);
    }
  }, [captureChatTargetEpoch, isChatTargetCurrent, menuMessage, sessionAgentType, sessionId, sessionMgr, setError]);

  const handleDeleteMessage = useCallback(async () => {
    if (!menuMessage) return;
    setDeletingMsg(true);
    try {
      useMobileStore.getState().deleteMessage(sessionId, menuMessage.id);
      remoteCache.saveTranscript(
        cacheScope,
        sessionId,
        useMobileStore.getState().getMessages(sessionId),
        hasMoreRef.current,
      );
      showMsgToast(t('chat.messageDeleted'));
    } finally {
      setDeletingMsg(false);
      setMenuMessage(null);
    }
  }, [cacheScope, menuMessage, sessionId, showMsgToast, t]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      clearMsgLongPressTimer();
      if (msgToastTimerRef.current) clearTimeout(msgToastTimerRef.current);
    };
  }, []);

  const isNearBottomRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const lastShowScrollToBottomRef = useRef(false);
  const BOTTOM_THRESHOLD = 80;

  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const gap = container.scrollHeight - container.scrollTop - container.clientHeight;
    const nearBottom = gap < BOTTOM_THRESHOLD;
    isNearBottomRef.current = nearBottom;
    if (nearBottom) {
      programmaticScrollRef.current = false;
    }
    if (!programmaticScrollRef.current) {
      const show = !nearBottom;
      if (show !== lastShowScrollToBottomRef.current) {
        lastShowScrollToBottomRef.current = show;
        setShowScrollToBottom(show);
      }
    }

    if (container.scrollTop < 100 && hasMore && !isLoadingMore) {
      const msgs = getMessages(sessionId);
      if (msgs.length > 0) loadMessages(msgs[0].id);
    }
  }, [hasMore, isLoadingMore, getMessages, sessionId, loadMessages]);

  const scrollToBottom = useCallback(() => {
    programmaticScrollRef.current = true;
    isNearBottomRef.current = true;
    setShowScrollToBottom(false);
    lastShowScrollToBottomRef.current = false;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Initial hydrate and durable stream subscription
  const initialScrollDone = useRef(false);
  const pendingInitialScroll = useRef(false);
  const chatInitSeqRef = useRef(0);
  useEffect(() => {
    modelSelectionInitializedRef.current = false;
    hasMoreRef.current = true;
    isLoadingMoreRef.current = false;
    setHasMore(true);
    setIsLoadingMore(false);
    setModelCatalog(null);
    setSelectedModelId('auto');
  }, [sessionId]);

  useEffect(() => {
    initialScrollDone.current = false;
    pendingInitialScroll.current = false;
    const initSeq = ++chatInitSeqRef.current;
    let cancelled = false;
    const targetEpoch = captureChatTargetEpoch();
    if (targetEpoch === null) return;
    const isInitCurrent = () => (
      !cancelled
      && chatInitSeqRef.current === initSeq
      && isChatTargetCurrent(targetEpoch)
    );
    const initialize = async () => {
      const catalogPromise = loadModelCatalog();
      const cached = await remoteCache.loadTranscript(cacheScope, sessionId);
      if (!isInitCurrent()) return;
      if (cached) {
        setMessages(sessionId, cached.messages);
        setHasMore(cached.hasMore);
        hasMoreRef.current = cached.hasMore;
        pendingInitialScroll.current = true;
      }

      // Always reconcile with the authoritative host. The cached transcript is
      // only an immediate paint and remains isolated to this account/device.
      // Durable records reconcile the cached view through the same stream.
      const initialCatalog = await catalogPromise;
      if (!isInitCurrent()) return;
      const initialMsgCount = useMobileStore.getState().getMessages(sessionId).length;
      pendingInitialScroll.current = true;

      const synchronizer = new SessionSynchronizer(sessionMgr, sessionId, (resp: PollResponse) => {
        if (!isInitCurrent()) return;
        if (resp.message_snapshot) {
          // Completion can grow the content of an already-counted assistant
          // message. Replace from the host's durable transcript; message count
          // alone cannot detect that repair.
          setMessages(sessionId, resp.message_snapshot);
          remoteCache.saveTranscript(
            cacheScope,
            sessionId,
            resp.message_snapshot,
            hasMoreRef.current,
          );
        } else if (resp.new_messages && resp.new_messages.length > 0) {
          appendNewMessages(sessionId, resp.new_messages);
          remoteCache.saveTranscript(
            cacheScope,
            sessionId,
            useMobileStore.getState().getMessages(sessionId),
            hasMoreRef.current,
          );
        }

        if (resp.title) {
          setLiveTitle(resp.title);
          updateSessionName(sessionId, resp.title);
          remoteCache.renameSession(cacheScope, sessionId, resp.title);
        }
        if (resp.model_catalog) {
          setModelCatalog(resp.model_catalog);
          setSelectedModelId(normalizeSelectedModelId(
            resp.model_catalog.session_model_id || 'auto',
            resp.model_catalog,
          ));
        }
        setActiveTurn(resp.active_turn ?? null);
      }, initialCatalog?.version || 0, history => { if(isInitCurrent()){setHasMore(history.hasMore);hasMoreRef.current=history.hasMore;} }, () => { if(isInitCurrent())setMailboxInvalidation(value=>value+1); },
      // Stream failures are stated, not hidden: an older host or a lost
      // connection shows up in the same banner as any other remote error.
      error => { if (isInitCurrent()) reportRemoteSessionError(error, setError); });

      synchronizer.start(initialMsgCount);
      streamRef.current = synchronizer;
    };
    void initialize();

    return () => {
      cancelled = true;
      if (chatInitSeqRef.current === initSeq) chatInitSeqRef.current += 1;
      streamRef.current?.stop();
      streamRef.current = null;
      setActiveTurn(null);
    };
  }, [
    appendNewMessages,
    cacheScope,
    captureChatTargetEpoch,
    isChatTargetCurrent,
    loadMessages,
    loadModelCatalog,
    sessionId,
    sessionMgr,
    setActiveTurn,
    setMessages,
    updateSessionName,
  ]);

  const prevMsgCountRef = useRef(0);

  // Scroll to bottom BEFORE paint on initial message load,
  // so the user never sees the list at scroll-top then flash to bottom.
  useLayoutEffect(() => {
    if (!pendingInitialScroll.current || messages.length === 0) return;
    pendingInitialScroll.current = false;
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
    initialScrollDone.current = true;
    prevMsgCountRef.current = messages.length;
  }, [messages]);

  useEffect(() => {
    if (!initialScrollDone.current) return;
    if (messages.length !== prevMsgCountRef.current) {
      const isNewAppend = messages.length > prevMsgCountRef.current;
      prevMsgCountRef.current = messages.length;
      if (isNewAppend && !isLoadingMore && isNearBottomRef.current) {
        programmaticScrollRef.current = true;
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    }
  }, [messages.length, isLoadingMore]);

  useEffect(() => {
    if (!initialScrollDone.current || !isStreaming) return;
    if (!isNearBottomRef.current) return;
    programmaticScrollRef.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [activeTurn, isStreaming]);

  useEffect(() => {
    if (optimisticMsg) {
      programmaticScrollRef.current = true;
      isNearBottomRef.current = true;
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [optimisticMsg]);

  useEffect(() => {
    if (!initialScrollDone.current || !isStreaming) return;
    const container = messagesContainerRef.current;
    if (!container) return;
    const tid = setInterval(() => {
      if (!isNearBottomRef.current) return;
      const gap = container.scrollHeight - container.scrollTop - container.clientHeight;
      if (gap > 10 && gap < 400) {
        programmaticScrollRef.current = true;
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      }
    }, 300);
    return () => clearInterval(tid);
  }, [isStreaming]);

  const handleSend = useCallback(async () => {
    if (useMobileStore.getState().connectionHealth === 'unreachable') return;
    const text = input.trim();
    const imgs = pendingImages;
    if ((!text && imgs.length === 0) || imageAnalyzing || sendInFlightRef.current) return;
    const targetEpoch = captureChatTargetEpoch();
    if (targetEpoch === null) return;
    const wasStreaming = isStreaming;
    const attempt = Symbol('message submission');
    sendInFlightRef.current = attempt;
    setIsSending(true);
    setError(null);

    const hasImages = imgs.length > 0;
    const imageContexts = hasImages
      ? imgs.map((img, idx) => {
          const mimeType = img.dataUrl.split(';')[0]?.replace('data:', '') || 'image/png';
          return {
            id: `mobile_img_${Date.now()}_${idx}`,
            data_url: img.dataUrl,
            mime_type: mimeType,
            metadata: { name: img.name, source: 'remote' },
          };
        })
      : undefined;

    if (hasImages) {
      setOptimisticMsg({
        id: `opt_${Date.now()}`,
        text: text || '',
        images: imgs.map(i => ({ name: i.name, data_url: i.dataUrl })),
      });
      setImageAnalyzing(true);
    }

    try {
      await sessionMgr.sendMessage(
        sessionId,
        text || t('chat.imageAttachmentFallback'),
        sessionAgentType,
        imageContexts,
      );
      if (!isChatTargetCurrent(targetEpoch)) return;
      // Keep the draft until the host acknowledges it. A failed request must
      // remain retryable, and an acknowledgement must not erase newer typing.
      const draftUnchanged = inputRef.current?.value === input;
      setInput(current => current === input ? '' : current);
      setPendingImages(current => current.filter(image => !imgs.includes(image)));
      if (!wasStreaming && draftUnchanged) setInputExpanded(false);
      streamRef.current?.nudge();
      if (wasStreaming) {
        setInfoToast(t('chat.messageQueued'));
      }
    } catch (e: any) {
      if (!isChatTargetCurrent(targetEpoch)) return;
      reportRemoteSessionError(e, setError);
    } finally {
      if (isChatTargetCurrent(targetEpoch) && sendInFlightRef.current === attempt) {
        sendInFlightRef.current = null;
        setIsSending(false);
        setImageAnalyzing(false);
        setOptimisticMsg(null);
      }
    }
  }, [captureChatTargetEpoch, imageAnalyzing, input, isChatTargetCurrent, isStreaming, pendingImages, sessionAgentType, sessionId, sessionMgr, setError, t]);

  const handleImageSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    const targetEpoch = captureChatTargetEpoch();
    if (targetEpoch === null) return;
    const maxImages = 5;
    const remaining = maxImages - pendingImages.length;
    const { compressImageFile } = await import('../services/imageCompressor');
    for (const file of files.slice(0, remaining)) {
      try {
        const compressed = await compressImageFile(file);
        if (!isChatTargetCurrent(targetEpoch)) return;
        setPendingImages(prev => prev.length >= maxImages ? prev : [...prev, compressed]);
      } catch {
        if (!isChatTargetCurrent(targetEpoch)) return;
        setError(t('chat.imagePreparationFailed'));
      }
    }
  }, [captureChatTargetEpoch, isChatTargetCurrent, pendingImages.length, setError, t]);

  const removeImage = useCallback((idx: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const expandInput = useCallback(() => {
    setInputExpanded(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  useEffect(() => {
    if (autoFocus) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [autoFocus]);

  useEffect(() => {
    if (!inputExpanded) return;
    const handleClickOutside = (e: MouseEvent) => {
      // Portaled composer menus are logically inside the input bar. Collapsing
      // here would unmount their options before the subsequent click arrives.
      if (e.target instanceof Element && e.target.closest('[data-composer-popover]')) return;
      if (inputBarRef.current && !inputBarRef.current.contains(e.target as Node)) {
        if (!input.trim() && pendingImages.length === 0) {
          setInputExpanded(false);
        }
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [inputExpanded, input, pendingImages.length]);

  const isComposingRef = useRef(false);

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(() => {
    // Delay clearing to handle Safari's event ordering where
    // compositionend fires before the final keydown(Enter)
    setTimeout(() => {
      isComposingRef.current = false;
    }, 0);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if ((e.nativeEvent as KeyboardEvent).isComposing || isComposingRef.current) {
        return;
      }
      e.preventDefault();
      handleSend();
    }
  };

  const handleCancel = async () => {
    const targetEpoch = captureChatTargetEpoch();
    if (targetEpoch === null || isCancelling) return;
    setIsCancelling(true);
    try {
      await sessionMgr.cancelTask(sessionId, activeTurn?.turn_id);
    } catch {
      // best effort
      if (isChatTargetCurrent(targetEpoch)) setIsCancelling(false);
    }
  };

  const workspaceName = currentWorkspace?.project_name || currentWorkspace?.path?.split('/').pop() || '';
  const gitBranch = currentWorkspace?.git_branch;
  const displayName = liveTitle || sessionName || t('chat.session');

  return (
    <div className={`chat-page${wideLayout ? ' chat-page--wide' : ''}`} style={{ '--chat-composer-height': `${composerHeight}px` } as React.CSSProperties}>
      <ChatHeader
        deviceName={controlTarget ? controlTarget.deviceName || undefined : undefined}
        displayName={displayName}
        gitBranch={gitBranch}
        isStreaming={isStreaming}
        onBack={onBack}
        onCancel={handleCancel}
        sessionId={sessionId}
        wideLayout={wideLayout}
        workspaceName={workspaceName}
      />

      <PermissionMailbox key={`${sessionId}:${controlTargetEpoch}`} manager={sessionMgr} sessionId={sessionId} invalidation={mailboxInvalidation} />
      {/* Messages */}
      <div className="chat-page__messages" ref={messagesContainerRef} onScroll={handleScroll}>
        {isLoadingMore && (
          <div className="chat-page__load-more-indicator">{t('chat.loadingOlderMessages')}</div>
        )}

        <QuestionInteractionContext.Provider value={handleQuestionInteraction}>
        <ArtifactImageReader.Provider value={readArtifactImage}>
          <ChatTranscript
            key={`${sessionId}:${controlTargetEpoch}`}
            activeTurn={activeTurn}
            expandedMessageIds={expandedMsgIds}
            imageAnalyzing={imageAnalyzing}
            menuMessageId={menuMessage?.id}
            messages={messages}
            now={now}
            optimisticMessage={optimisticMsg}
            onAnswerQuestion={handleAnswerQuestion}
            onApproveTool={handleApproveTool}
            onCancelActiveTool={(toolId) => handleCancelTool(toolId, 'User cancelled')}
            onCancelLegacyTool={handleCancelTool}
            onRejectTool={handleRejectTool}
            onFileDownload={handleFileDownload}
            onGetFileInfo={handleGetFileInfo}
            onMessageContextMenu={(message, event) => {
              event.preventDefault();
              setMenuMessage(message);
            }}
            onMessageTouchEnd={handleMsgTouchEnd}
            onMessageTouchMove={handleMsgTouchMove}
            onMessageTouchStart={handleMsgTouchStart}
            onToggleMessage={(messageId, expanded) => {
              setExpandedMsgIds((previous) => {
                const next = new Set(previous);
                if (expanded) next.add(messageId);
                else next.delete(messageId);
                return next;
              });
            }}
          />
        </ArtifactImageReader.Provider>
        </QuestionInteractionContext.Provider>

        <div ref={messagesEndRef} />

      </div>

      {showScrollToBottom && (
        <MobileIconButton
          appearance="floating"
          className="chat-page__scroll-to-bottom"
          onClick={scrollToBottom}
          aria-label={t('chat.scrollToBottom')}
          icon={<LucideChevronDown aria-hidden="true" focusable="false" width="20" height="20" stroke="currentColor" />}
        />
      )}

      <ChatMessageActions
        deleting={deletingMsg}
        message={menuMessage}
        onClose={() => setMenuMessage(null)}
        onCopy={() => void handleCopyMessage()}
        onDelete={() => void handleDeleteMessage()}
        onResend={() => void handleResendMessage()}
      />

      {/* Floating composer with compact and expanded touch layouts. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/gif,image/webp"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
      <ChatComposerBar
        cancelling={isCancelling}
        containerRef={inputBarRef}
        expanded={inputExpanded}
        imageAnalyzing={imageAnalyzing}
        sending={isSending}
        input={input}
        inputRef={inputRef}
        remoteUnavailable={connectionHealth === 'unreachable'}
        modelControls={(
          <>
            <ModelSelectorPill catalog={modelCatalog} selectedModelId={selectedModelId} disabled={connectionHealth === 'unreachable' || imageAnalyzing || isStreaming || modelUpdating} onSelect={handleSelectModel} onSelectReasoning={handleSelectReasoningPreset} />
          </>
        )}
        onActivate={expandInput}
        onAttach={handleImageSelect}
        onCancel={() => void handleCancel()}
        onChange={setInput}
        onCompositionEnd={handleCompositionEnd}
        onCompositionStart={handleCompositionStart}
        onKeyDown={handleKeyDown}
        onRemoveImage={removeImage}
        onSend={handleSend}
        pendingImages={pendingImages}
        streaming={isStreaming}
      />

      <ChatFeedback
        actionMessage={actionToast}
        errorMessage={error}
        infoMessage={infoToast}
        onDismissError={() => setError(null)}
        onDismissInfo={() => setInfoToast(null)}
      />
    </div>
  );
};

export default ChatPage;
