import { ArrowUp as LucideArrowUp, PencilLine as LucidePencilLine, X as LucideX } from 'lucide-react';
import { OverflowText, Menu, MenuItem, ScrollArea } from '@openbitfun/ui';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { emit, listen } from '@tauri-apps/api/event';
import { cursorPosition, getCurrentWindow } from '@tauri-apps/api/window';
import { aiExperienceConfigService, type AgentCompanionPetSelection, type AIExperienceSettings } from '@/infrastructure/config/services/AIExperienceConfigService';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { AgentCompanionPet, type AgentCompanionPetMood } from '@/flow_chat/components/AgentCompanionPet';
import type { AgentCompanionMood } from '@/flow_chat/utils/agentCompanionMood';
import type {
  AgentCompanionActivityPayload,
  AgentCompanionTaskState,
  AgentCompanionTaskStatus,
} from '@/flow_chat/utils/agentCompanionActivity';
import type { AgentCompanionPetCommand } from '@/app/services/agentCompanionPetCommands';
import { createLogger } from '@/shared/utils/logger';
import { isImeOwnedKeyboardEvent } from '@/shared/utils/ime';
import { isReducedMotionPreferred } from '@/shared/utils/motionPreference';
import { getPetLookDirection } from '@/infrastructure/config/services/agentCompanionPetSprite';
import { startAgentCompanionDrag } from '@/infrastructure/config/services/AgentCompanionDragService';
import { prepareAgentCompanionPointerDrag, type CompanionPointerDrag } from '@/infrastructure/config/services/AgentCompanionPointerDragService';
import './AgentCompanionDesktopPet.scss';

const log = createLogger('AgentCompanionDesktopPet');
const DEFAULT_PET_SIZE = 96;
const DEFAULT_PETDEX_DISPLAY_SIZE = { width: 96, height: 104 };
const PETDEX_DESKTOP_SCALE = 0.5;
const WINDOW_MAX_WIDTH = 360;
const WINDOW_MAX_HEIGHT = 240;
const WINDOW_HORIZONTAL_GAP = 8;
const MAX_VISIBLE_BUBBLES = 2;
const BUBBLE_GAP = 6;
const BUBBLE_WIDTH = 180;
const BUBBLE_OUTPUT_TYPEWRITER_INTERVAL_MS = 28;
const WINDOW_EDGE_BUFFER = 4;
/**
 * Room kept above and below the dock. A bubble lifts on hover and pulses on
 * attention, so its own box must stay that far away from the window edge or the
 * border gets clipped.
 */
const WINDOW_VERTICAL_BUFFER = 3;
const POINTER_HOVER_POLL_INTERVAL_MS = 120;
const PET_LOOK_HOLD_MS = 960;
/** Clicks shorter/smaller than this use `show_main_window`; beyond it we start dragging. */
const PET_DRAG_THRESHOLD_PX = 8;
const IS_WINDOWS_WEBVIEW = /\bWindows\b/i.test(window.navigator.userAgent);
const IS_MACOS_WEBVIEW = /\bMacintosh\b/i.test(window.navigator.userAgent);
// AppKit's native drag returns immediately and may consume mouse-up. Keep pointer
// capture on macOS too, so running direction and drag lifetime follow the pointer.
const USE_CONTROLLED_PET_DRAG = IS_WINDOWS_WEBVIEW || IS_MACOS_WEBVIEW;
const PET_COMMAND_EVENT = 'agent-companion://pet-command';
const MAIN_WINDOW_STATE_EVENT = 'agent-companion://main-window-state';
const MENU_EDGE_MARGIN = 4;

interface TypewriterOutputState {
  target: string;
  visible: string;
}

/**
 * Which surface is layered above the pet dock. Only one may be open at a time so
 * the window never has to grow for two panels.
 */
type PetOverlayState =
  | { kind: 'pet-menu' }
  | { kind: 'bubble-menu'; sessionId: string }
  | { kind: 'composer'; sessionId: string }
  | null;

/**
 * Bubbles are derived from live session activity, so "close this bubble" cannot
 * simply delete an item. It records which kind of bubble was dismissed instead:
 * silencing a working bubble keeps it hidden while the task runs, but a later
 * notice (needs input / finished / failed) still gets through.
 */
type BubbleDismissBucket = 'active' | 'notice';

/**
 * Where a context menu was opened, measured from the window's bottom-right
 * corner. The host keeps that corner fixed while the window grows to make room
 * for the menu, so this anchor survives the resize while `clientX`/`clientY`
 * would not.
 */
interface MenuAnchor {
  right: number;
  bottom: number;
}

function menuAnchorFromEvent(event: React.MouseEvent): MenuAnchor {
  return {
    right: Math.max(0, window.innerWidth - event.clientX),
    bottom: Math.max(0, window.innerHeight - event.clientY),
  };
}

function bubbleDismissBucket(state: AgentCompanionTaskState): BubbleDismissBucket {
  return state === 'running' || state === 'waiting' ? 'active' : 'notice';
}

function isAcknowledgeableTaskState(state: AgentCompanionTaskState): boolean {
  return state === 'completed' || state === 'error' || state === 'interrupted';
}

function rectContainsPoint(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left
    && x <= rect.right
    && y >= rect.top
    && y <= rect.bottom;
}

function seedTypewriterOutput(target: string): string {
  if (target.length <= 1) {
    return '';
  }

  return target.slice(0, -1);
}

function advanceTypewriterOutput(visible: string, target: string): string {
  if (visible === target) {
    return visible;
  }

  if (!target.startsWith(visible)) {
    return target;
  }

  const gap = target.length - visible.length;
  const step = Math.max(1, Math.floor(gap / 8));
  return target.slice(0, visible.length + step);
}

export const AgentCompanionDesktopPet: React.FC = () => {
  const { t } = useTranslation('flow-chat');
  const [pet, setPet] = useState<AgentCompanionPetSelection | null>(
    () => aiExperienceConfigService.getSettings().agent_companion_pet ?? null,
  );
  const [mood, setMood] = useState<AgentCompanionMood>('rest');
  const [tasks, setTasks] = useState<AgentCompanionTaskStatus[]>([]);
  const previousTasksRef = useRef<AgentCompanionTaskStatus[] | null>(null);
  const [reaction, setReaction] = useState<{ action: 'jumping' | 'waving' } | null>(null);
  useEffect(() => {
    if (!previousTasksRef.current) return;
    const previousTasks = previousTasksRef.current;
    const isActive = (task: AgentCompanionTaskStatus) => task.state === 'running' || task.state === 'waiting' || task.state === 'attention';
    const started = tasks.some(task => isActive(task)
      && !previousTasks.some(previous => previous.sessionId === task.sessionId && isActive(previous)));
    const completed = tasks.find(task => task.state === 'completed'
      && previousTasks.some(previous => previous.sessionId === task.sessionId && isActive(previous)));
    previousTasksRef.current = tasks;
    if (completed) setReaction({ action: 'waving' });
    else if (started) setReaction({ action: 'jumping' });
    else if (tasks.some(task => (task.state === 'error' || task.state === 'interrupted')
      && previousTasks.some(previous => previous.sessionId === task.sessionId && isActive(previous)))) setReaction(null);
  }, [tasks]);
  useEffect(() => {
    if (!reaction) return;
    const timer = window.setTimeout(() => setReaction(null), 1200);
    return () => window.clearTimeout(timer);
  }, [reaction]);
  const [typedOutputBySessionId, setTypedOutputBySessionId] = useState<Record<string, TypewriterOutputState>>({});
  const [isHoveringPet, setIsHoveringPet] = useState(false);
  const [lookDirection, setLookDirection] = useState<number | null>(null);
  const trackPetLook = mood === 'rest' && pet != null && (
    pet.spriteVersionNumber === 2 || (pet.source === 'user' && pet.spriteVersionNumber == null)
  );
  const [isDraggingPet, setIsDraggingPet] = useState(false);
  const [dragDirection, setDragDirection] = useState<'left' | 'right'>('right');
  const stopDragRef = useRef<(() => void) | null>(null);
  const pointerDragRef = useRef<CompanionPointerDrag | null>(null);
  useEffect(() => () => {
    stopDragRef.current?.();
    pointerDragRef.current?.cancel();
  }, []);
  const [petFrameSize, setPetFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [overlay, setOverlay] = useState<PetOverlayState>(null);
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);
  const [menuPosition, setMenuPosition] = useState<MenuAnchor | null>(null);
  const [isMainWindowFocused, setIsMainWindowFocused] = useState(false);
  const [dismissedBubbles, setDismissedBubbles] = useState<Record<string, BubbleDismissBucket>>({});
  const [composerValue, setComposerValue] = useState('');
  const [isSendingComposer, setIsSendingComposer] = useState(false);
  const [hoveredBubbleSessionId, setHoveredBubbleSessionId] = useState<string | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const bubblesRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLInputElement>(null);
  const composerCompositionActiveRef = useRef(false);
  const outputRefs = useRef<Map<string, HTMLSpanElement>>(new Map());
  const lastActivitySequenceRef = useRef(0);
  const lastActivityEmittedAtRef = useRef(0);
  const petPointerSessionRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    dragStarted: boolean;
  } | null>(null);
  const visibleTasks = useMemo(
    () => tasks.filter(task => dismissedBubbles[task.sessionId] !== bubbleDismissBucket(task.state)),
    [dismissedBubbles, tasks],
  );
  // Memoized so a focused main window (empty bubble list) does not hand the
  // layout effect below a fresh array identity on every render.
  const bubbleTasks = useMemo(
    () => (isMainWindowFocused ? [] : visibleTasks),
    [isMainWindowFocused, visibleTasks],
  );
  const displayTasks = [...bubbleTasks].reverse();
  const activePetSize = pet && petFrameSize
    ? petFrameSize
    : pet
      ? DEFAULT_PETDEX_DISPLAY_SIZE
      : { width: DEFAULT_PET_SIZE, height: DEFAULT_PET_SIZE };

  useEffect(() => {
    let disposed = false;
    document.documentElement.classList.add('openbitfun-agent-companion-window-root');
    document.body.classList.add('openbitfun-agent-companion-window-body');

    const hidePetWindowForInactiveSettings = () => {
      void getCurrentWindow().hide().catch(error => {
        log.warn('Failed to hide inactive Agent companion window', error);
      });
    };

    const applySettings = (settings: AIExperienceSettings) => {
      setPet(settings.agent_companion_pet ?? null);
      setPetFrameSize(null);
      if (!settings.enable_agent_companion) {
        hidePetWindowForInactiveSettings();
      }
    };

    void aiExperienceConfigService.getSettingsAsync()
      .then(settings => {
        if (!disposed) {
          applySettings(settings);
        }
      })
      .catch(error => {
        if (!disposed) {
          log.warn('Failed to load Agent companion settings', error);
        }
      });

    let removeTauriListener: (() => void) | null = null;
    const settingsListenerReady = listen<AIExperienceSettings>('agent-companion://settings-updated', event => {
      applySettings(event.payload);
    }).then(unlisten => {
      if (disposed) {
        unlisten();
        return false;
      }
      removeTauriListener = unlisten;
      return true;
    }).catch(error => {
      log.warn('Failed to listen for Agent companion settings updates', error);
      return false;
    });

    let removeActivityListener: (() => void) | null = null;
    let removeMainWindowStateListener: (() => void) | null = null;
    const mainWindowStateListenerReady = listen<{ focused: boolean }>(MAIN_WINDOW_STATE_EVENT, event => {
      setIsMainWindowFocused(event.payload.focused);
    }).then(unlisten => {
      if (disposed) {
        unlisten();
        return false;
      }
      removeMainWindowStateListener = unlisten;
      return true;
    }).catch(error => {
      log.warn('Failed to listen for main window state updates', error);
      return false;
    });

    const activityListenerReady = listen<AgentCompanionActivityPayload>('agent-companion://activity-updated', event => {
      const emittedAt = event.payload.emittedAt ?? 0;
      const sequence = event.payload.sequence ?? 0;
      if (
        emittedAt < lastActivityEmittedAtRef.current
        || (emittedAt === lastActivityEmittedAtRef.current && sequence <= lastActivitySequenceRef.current)
      ) {
        return;
      }
      lastActivityEmittedAtRef.current = emittedAt;
      lastActivitySequenceRef.current = sequence;
      setMood(event.payload.mood);
      // The first snapshot is hydration, not a new request.
      if (previousTasksRef.current === null) previousTasksRef.current = event.payload.tasks;
      setTasks(event.payload.tasks);
    }).then(unlisten => {
      if (disposed) {
        unlisten();
        return false;
      }
      removeActivityListener = unlisten;
      return true;
    }).catch(error => {
      log.warn('Failed to listen for Agent companion activity updates', error);
      return false;
    });

    void Promise.all([settingsListenerReady, activityListenerReady, mainWindowStateListenerReady])
      .then(([settingsReady, activityReady, mainWindowStateReady]) => {
        if (!disposed && settingsReady && activityReady && mainWindowStateReady) {
          void emit('agent-companion://ready');
        }
      })
      .catch(error => {
        if (!disposed) {
          log.warn('Failed to request Agent companion startup sync', error);
        }
      });

    return () => {
      disposed = true;
      removeTauriListener?.();
      removeActivityListener?.();
      removeMainWindowStateListener?.();
      document.documentElement.classList.remove('openbitfun-agent-companion-window-root');
      document.body.classList.remove('openbitfun-agent-companion-window-body');
    };
  }, []);

  // Drop dismissals whose bubble kind changed (a silenced task now needs
  // attention or finished) or whose session left the activity payload.
  useEffect(() => {
    setDismissedBubbles(previous => {
      const previousSessionIds = Object.keys(previous);
      if (previousSessionIds.length === 0) {
        return previous;
      }

      const next: Record<string, BubbleDismissBucket> = {};
      tasks.forEach(task => {
        const dismissedBucket = previous[task.sessionId];
        if (dismissedBucket && dismissedBucket === bubbleDismissBucket(task.state)) {
          next[task.sessionId] = dismissedBucket;
        }
      });

      // Kept entries always carry the same bucket, so the count is enough.
      return Object.keys(next).length === previousSessionIds.length ? previous : next;
    });
  }, [tasks]);

  // Never leave a bubble menu or composer floating over a bubble that is gone.
  useEffect(() => {
    setOverlay(previous => {
      if (!previous || previous.kind === 'pet-menu') {
        return previous;
      }
      return visibleTasks.some(task => task.sessionId === previous.sessionId) ? previous : null;
    });
    setHoveredBubbleSessionId(previous => (
      previous && !visibleTasks.some(task => task.sessionId === previous)
        ? null
        : previous
    ));
  }, [visibleTasks]);

  useEffect(() => {
    setTypedOutputBySessionId(previous => {
      const next: Record<string, TypewriterOutputState> = {};

      visibleTasks.forEach(task => {
        if (!task.latestOutput) {
          return;
        }

        const previousOutput = previous[task.sessionId];
        next[task.sessionId] = previousOutput
          ? { ...previousOutput, target: task.latestOutput }
          : {
            target: task.latestOutput,
            visible: seedTypewriterOutput(task.latestOutput),
          };
      });

      return next;
    });
  }, [visibleTasks]);

  // rAF-driven typewriter. The effect only depends on the derived boolean
  // "is anything still typing", so the ticking loop is NOT torn down and
  // rebuilt on every tick (the previous interval version re-ran the effect
  // ~36x/second because it depended on the state it was writing).
  const hasTypingOutput = useMemo(
    () => Object.values(typedOutputBySessionId)
      .some(output => output.visible !== output.target),
    [typedOutputBySessionId],
  );

  useEffect(() => {
    if (!hasTypingOutput) {
      return;
    }

    let frameId: number | null = null;
    let lastTickAt = 0;

    const tick = (now: number) => {
      frameId = requestAnimationFrame(tick);
      if (now - lastTickAt < BUBBLE_OUTPUT_TYPEWRITER_INTERVAL_MS) {
        return;
      }
      lastTickAt = now;

      setTypedOutputBySessionId(previous => {
        let changed = false;
        const next: Record<string, TypewriterOutputState> = {};

        Object.entries(previous).forEach(([sessionId, output]) => {
          const visible = advanceTypewriterOutput(output.visible, output.target);
          if (visible !== output.visible) {
            changed = true;
          }
          next[sessionId] = { ...output, visible };
        });

        return changed ? next : previous;
      });
    };

    frameId = requestAnimationFrame(tick);

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [hasTypingOutput]);

  // Bumped whenever dock layout may have changed; lets the pointer poll reuse
  // cached getBoundingClientRect results between layout changes.
  const layoutEpochRef = useRef(0);

  useLayoutEffect(() => {
    // Typewriter output grows the bubbles (and shifts the ones below them), so
    // any cached bubble rect must be invalidated on every typed-output flush.
    layoutEpochRef.current += 1;
    outputRefs.current.forEach(element => {
      element.scrollTop = element.scrollHeight;
    });
  }, [typedOutputBySessionId]);

  const visibleTaskCountRef = useRef(0);

  useLayoutEffect(() => {
    // Written here (not during render) so an abandoned/double render cannot
    // leave the count out of sync with the committed layout epoch.
    visibleTaskCountRef.current = visibleTasks.length;
    layoutEpochRef.current += 1;
    const bubbleCount = bubbleTasks.length;
    const bubbleElements = Array.from(bubblesRef.current?.children ?? [])
      .slice(0, MAX_VISIBLE_BUBBLES);
    // Sum of the bubbles themselves: the slot's own vertical buffer is chrome
    // the component adds back below, so it must not be measured twice.
    const visibleBubbleHeight = bubbleElements.reduce(
      (sum, child) => sum + child.getBoundingClientRect().height,
      0,
    ) + Math.max(0, bubbleElements.length - 1) * BUBBLE_GAP;
    const targetBubbleHeight = bubbleCount === 1
      ? activePetSize.height
      : visibleBubbleHeight;
    // The buffer is chrome around the content, so it is added after clamping:
    // the window still never exceeds WINDOW_MAX_HEIGHT.
    const nextHeight = (bubbleCount > 0
      ? Math.max(
        activePetSize.height,
        Math.min(WINDOW_MAX_HEIGHT - WINDOW_VERTICAL_BUFFER * 2, targetBubbleHeight),
      )
      : activePetSize.height) + WINDOW_VERTICAL_BUFFER * 2;
    const measuredBubbleWidth = bubbleCount > 0 ? BUBBLE_WIDTH : 0;
    const measuredDockWidth = bubbleCount > 0
      ? measuredBubbleWidth + WINDOW_HORIZONTAL_GAP + activePetSize.width + WINDOW_EDGE_BUFFER
      : Math.max(
        activePetSize.width,
        dockRef.current?.scrollWidth ?? 0,
        dockRef.current?.getBoundingClientRect().width ?? 0,
      );
    const nextWidth = Math.max(
      activePetSize.width,
      Math.min(WINDOW_MAX_WIDTH, Math.ceil(measuredDockWidth)),
    );

    if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight)) {
      log.warn('Skipped invalid Agent companion window resize', {
        width: nextWidth,
        height: nextHeight,
      });
      return;
    }

    void api.invoke('resize_agent_companion_desktop_pet', {
        width: nextWidth,
        height: nextHeight,
      })
      .catch(error => {
        log.warn('Failed to resize Agent companion window', error);
      });
  }, [activePetSize.height, activePetSize.width, overlay, bubbleTasks, visibleTasks.length]);

  useEffect(() => {
    if (IS_WINDOWS_WEBVIEW && !trackPetLook) {
      return;
    }

    const tauriWindow = getCurrentWindow();
    let disposed = false;
    let windowPosition: { x: number; y: number } | null = null;
    let scaleFactor = 1;
    let pointerPollInFlight = false;
    let lastPointer: { x: number; y: number } | null = null;
    let lastPointerMovedAt = 0;
    let removeWindowMovedListener: (() => void) | null = null;
    let removeScaleChangedListener: (() => void) | null = null;

    void tauriWindow.outerPosition()
      .then(position => {
        windowPosition = position;
      })
      .catch(error => {
        log.warn('Failed to read Agent companion window position', error);
      });

    void tauriWindow.scaleFactor()
      .then(rawScaleFactor => {
        const nextScaleFactor = Number(rawScaleFactor);
        scaleFactor = Number.isFinite(nextScaleFactor) && nextScaleFactor > 0 ? nextScaleFactor : 1;
      })
      .catch(error => {
        log.warn('Failed to read Agent companion window scale factor', error);
      });

    void tauriWindow.onMoved(event => {
      if (!USE_CONTROLLED_PET_DRAG && petPointerSessionRef.current?.dragStarted && windowPosition && event.payload.x !== windowPosition.x) {
        setDragDirection(event.payload.x > windowPosition.x ? 'right' : 'left');
      }
      windowPosition = event.payload;
    }).then(unlisten => {
      if (disposed) {
        unlisten();
      } else {
        removeWindowMovedListener = unlisten;
      }
    }).catch(error => {
      log.warn('Failed to listen for Agent companion window moves', error);
    });

    void tauriWindow.onScaleChanged(event => {
      const nextScaleFactor = Number(event.payload.scaleFactor);
      scaleFactor = Number.isFinite(nextScaleFactor) && nextScaleFactor > 0 ? nextScaleFactor : 1;
    }).then(unlisten => {
      if (disposed) {
        unlisten();
      } else {
        removeScaleChangedListener = unlisten;
      }
    }).catch(error => {
      log.warn('Failed to listen for Agent companion scale changes', error);
    });

    // Rect cache: getBoundingClientRect results are reused until the dock
    // layout changes (layoutEpochRef bump) or the window resizes, instead of
    // re-reading layout on every 120ms poll tick.
    let rectCacheEpoch = -1;
    let cachedHitboxRect: DOMRect | null = null;
    let cachedBubbleRects: Array<{ sessionId: string | null; rect: DOMRect }> = [];

    const invalidateRectCache = () => {
      rectCacheEpoch = -1;
    };
    window.addEventListener('resize', invalidateRectCache);

    const refreshRectCacheIfNeeded = () => {
      if (rectCacheEpoch === layoutEpochRef.current) {
        return;
      }
      const dock = dockRef.current;
      const hitbox = dock?.querySelector<HTMLElement>('.openbitfun-agent-companion-window__pet-hitbox') ?? null;
      cachedHitboxRect = hitbox?.getBoundingClientRect() ?? null;
      cachedBubbleRects = visibleTaskCountRef.current > 0
        ? Array.from(
          dock?.querySelectorAll<HTMLElement>('[data-agent-companion-session-id]') ?? [],
        ).map(element => ({
          sessionId: element.dataset.agentCompanionSessionId ?? null,
          rect: element.getBoundingClientRect(),
        }))
        : [];
      rectCacheEpoch = layoutEpochRef.current;
    };

    const pollPointerHover = async () => {
      if (pointerPollInFlight) {
        return;
      }
      pointerPollInFlight = true;
      try {
        if (!windowPosition) {
          windowPosition = await tauriWindow.outerPosition();
        }

        const pointer = await cursorPosition();
        if (disposed) {
          return;
        }

        refreshRectCacheIfNeeded();
        if (!cachedHitboxRect) {
          setIsHoveringPet(false);
        }

        const safeScaleFactor = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
        const pointerX = (pointer.x - windowPosition.x) / safeScaleFactor;
        const pointerY = (pointer.y - windowPosition.y) / safeScaleFactor;
        const now = performance.now();
        if (!lastPointer || pointer.x !== lastPointer.x || pointer.y !== lastPointer.y) {
          lastPointerMovedAt = now;
          lastPointer = { x: pointer.x, y: pointer.y };
        }
        setLookDirection(cachedHitboxRect && now - lastPointerMovedAt < PET_LOOK_HOLD_MS && !isReducedMotionPreferred()
          ? getPetLookDirection(
            pointerX - (cachedHitboxRect.left + cachedHitboxRect.width / 2),
            pointerY - (cachedHitboxRect.top + cachedHitboxRect.height / 2),
          )
          : null);
        // Windows uses native pointer events for hover. Poll only supplies the off-window look target.
        if (IS_WINDOWS_WEBVIEW) return;
        const isPointerInsideHitbox = cachedHitboxRect
          ? rectContainsPoint(cachedHitboxRect, pointerX, pointerY)
          : false;
        const hoveredBubble = cachedBubbleRects.find(({ rect }) => rectContainsPoint(
          rect,
          pointerX,
          pointerY,
        ));

        setIsHoveringPet(isPointerInsideHitbox);
        setHoveredBubbleSessionId(hoveredBubble?.sessionId ?? null);
      } catch (error) {
        log.warn('Failed to poll Agent companion pointer hover state', error);
      } finally {
        pointerPollInFlight = false;
      }
    };

    const intervalId = window.setInterval(() => {
      // Pause the IPC poll while the pet window is not visible.
      if (document.visibilityState === 'hidden') {
        return;
      }
      void pollPointerHover();
    }, POINTER_HOVER_POLL_INTERVAL_MS);
    void pollPointerHover();

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      window.removeEventListener('resize', invalidateRectCache);
      removeWindowMovedListener?.();
      removeScaleChangedListener?.();
    };
  }, [trackPetLook]);

  const showMainWindowFromPet = useCallback(async () => {
    try {
      await api.invoke('show_main_window');
    } catch (error) {
      log.warn('Failed to show main window from Agent companion pet', error);
    }
  }, []);

  const onContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
  }, []);

  const closeOverlay = useCallback(() => {
    setOverlay(null);
  }, []);

  const sendPetCommand = useCallback(async (command: AgentCompanionPetCommand) => {
    await emit(PET_COMMAND_EVENT, command);
  }, []);

  const onPetContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setMenuAnchor(menuAnchorFromEvent(event));
    setOverlay(previous => (previous?.kind === 'pet-menu' ? null : { kind: 'pet-menu' }));
  }, []);

  const onBubbleContextMenu = useCallback((event: React.MouseEvent, sessionId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setMenuAnchor(menuAnchorFromEvent(event));
    setOverlay(previous => (
      previous?.kind === 'bubble-menu' && previous.sessionId === sessionId
        ? null
        : { kind: 'bubble-menu', sessionId }
    ));
  }, []);

  const closeDesktopPet = useCallback(() => {
    setOverlay(null);
    void sendPetCommand({ type: 'close-desktop-pet' })
      .catch(error => {
        log.warn('Failed to request Agent companion desktop pet close', error);
      });
  }, [sendPetCommand]);

  const openPetSettings = useCallback(() => {
    setOverlay(null);
    void sendPetCommand({ type: 'open-pet-settings' })
      .catch(error => {
        log.warn('Failed to request Agent companion pet settings', error);
      });
  }, [sendPetCommand]);

  const closeBubble = useCallback((task: AgentCompanionTaskStatus) => {
    setOverlay(null);
    setDismissedBubbles(previous => ({
      ...previous,
      [task.sessionId]: bubbleDismissBucket(task.state),
    }));

    if (!isAcknowledgeableTaskState(task.state)) {
      return;
    }
    // Finished / failed / interrupted bubbles are pure "unread" notices, so tell
    // the main window the user has seen this one.
    void sendPetCommand({ type: 'dismiss-task', sessionId: task.sessionId })
      .catch(error => {
        log.warn('Failed to acknowledge Agent companion task', {
          sessionId: task.sessionId,
          error,
        });
      });
  }, [sendPetCommand]);

  const openBubbleComposer = useCallback((sessionId: string) => {
    setComposerValue('');
    setIsSendingComposer(false);
    setOverlay({ kind: 'composer', sessionId });
    void getCurrentWindow().setFocus()
      .catch(error => {
        log.warn('Failed to focus Agent companion window for composer', error);
      });
  }, []);

  const cancelBubbleComposer = useCallback(() => {
    setComposerValue('');
    setOverlay(null);
  }, []);

  const submitBubbleComposer = useCallback(async () => {
    const sessionId = overlay?.kind === 'composer' ? overlay.sessionId : null;
    const message = composerValue.trim();
    if (!sessionId || !message || isSendingComposer) {
      return;
    }

    setIsSendingComposer(true);
    try {
      await sendPetCommand({ type: 'send-message', sessionId, message });
      setComposerValue('');
      setOverlay(null);
    } catch (error) {
      log.warn('Failed to send Agent companion message from pet composer', {
        sessionId,
        error,
      });
    } finally {
      setIsSendingComposer(false);
    }
  }, [composerValue, isSendingComposer, overlay, sendPetCommand]);

  const onComposerKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (
      (event.key === 'Enter' || event.key === 'Escape')
      && isImeOwnedKeyboardEvent(event, composerCompositionActiveRef.current)
    ) {
      event.stopPropagation();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelBubbleComposer();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      void submitBubbleComposer();
    }
  }, [cancelBubbleComposer, submitBubbleComposer]);

  useEffect(() => {
    if (overlay?.kind !== 'composer') {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      composerInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [overlay]);

  const isMenuOverlay = overlay?.kind === 'pet-menu' || overlay?.kind === 'bubble-menu';

  // Place the menu at the cursor, kept fully inside the window. The window is
  // deliberately not resized for a menu: growing it moves every anchored
  // element for a frame, which reads as the whole pet flashing.
  useLayoutEffect(() => {
    if (!isMenuOverlay || !menuAnchor) {
      setMenuPosition(null);
      return;
    }

    const placeMenu = () => {
      // Fractional sizes matter here: rounding up can push the menu a pixel
      // outside the window.
      const menuBox = menuRef.current?.getBoundingClientRect();
      const menuWidth = menuBox?.width ?? 0;
      const menuHeight = menuBox?.height ?? 0;
      const right = Math.min(
        Math.max(menuAnchor.right, MENU_EDGE_MARGIN),
        Math.max(0, window.innerWidth - menuWidth),
      );
      const bottom = Math.min(
        Math.max(menuAnchor.bottom, MENU_EDGE_MARGIN),
        Math.max(0, window.innerHeight - menuHeight),
      );
      setMenuPosition(previous => (
        previous && previous.right === right && previous.bottom === bottom
          ? previous
          : { right, bottom }
      ));
    };

    placeMenu();
    // A bubble arriving while the menu is open still resizes the window.
    window.addEventListener('resize', placeMenu);
    return () => window.removeEventListener('resize', placeMenu);
  }, [isMenuOverlay, menuAnchor]);

  const clearPetPointerSession = (target: HTMLDivElement, pointerId: number) => {
    const session = petPointerSessionRef.current;
    if (!session || session.pointerId !== pointerId) {
      return;
    }
    petPointerSessionRef.current = null;
    pointerDragRef.current?.cancel();
    pointerDragRef.current = null;
    stopDragRef.current?.();
    stopDragRef.current = null;
    setIsDraggingPet(false);
    try {
      target.releasePointerCapture(pointerId);
    } catch {
      /* already released */
    }
  };

  const onPetPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    // WebKit can start a native text/image selection before our drag threshold
    // is reached. Cancel that default at pointer-down, while retaining capture.
    event.preventDefault();
    // The bubble composer stays interactive while open (it lives inside a
    // bubble), so touching the pet is what dismisses it.
    if (overlay?.kind === 'composer') {
      setOverlay(null);
    }
    petPointerSessionRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragStarted: false,
    };
    if (IS_MACOS_WEBVIEW) {
      const target = event.currentTarget;
      const session = petPointerSessionRef.current;
      pointerDragRef.current?.cancel();
      pointerDragRef.current = prepareAgentCompanionPointerDrag(
        { x: event.screenX, y: event.screenY },
        setDragDirection,
        error => {
          log.warn('Failed to move Agent companion window', error);
          if (petPointerSessionRef.current === session) clearPetPointerSession(target, session.pointerId);
        },
      );
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onPetPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const session = petPointerSessionRef.current;
    if (!session || event.pointerId !== session.pointerId) {
      return;
    }
    if (session.dragStarted) {
      pointerDragRef.current?.move({ x: event.screenX, y: event.screenY });
      return;
    }
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    if (dx * dx + dy * dy < PET_DRAG_THRESHOLD_PX * PET_DRAG_THRESHOLD_PX) {
      return;
    }
    session.dragStarted = true;
    event.preventDefault();
    setDragDirection(dx < 0 ? 'left' : 'right');
    setIsDraggingPet(true);
    setReaction(null);
    if (IS_MACOS_WEBVIEW) {
      pointerDragRef.current?.move({ x: event.screenX, y: event.screenY });
      return;
    }
    if (IS_WINDOWS_WEBVIEW) {
      const target = event.currentTarget;
      stopDragRef.current = startAgentCompanionDrag(setDragDirection, error => {
        log.warn('Failed to move Agent companion window', error);
        clearPetPointerSession(target, session.pointerId);
      });
      return;
    }
    void getCurrentWindow().startDragging()
      .catch(error => {
        log.warn('Failed to start Agent companion window drag', error);
        if (petPointerSessionRef.current === session) petPointerSessionRef.current = null;
      })
      .finally(() => {
        if (petPointerSessionRef.current === session) {
          petPointerSessionRef.current = null;
          setReaction({ action: 'waving' });
        }
        setIsDraggingPet(false);
      });
  };

  const onPetPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const session = petPointerSessionRef.current;
    if (!session || event.pointerId !== session.pointerId) {
      return;
    }
    const shouldShowMain = !session.dragStarted;
    if (session.dragStarted && pointerDragRef.current) {
      pointerDragRef.current.move({ x: event.screenX, y: event.screenY });
      pointerDragRef.current.finish();
      pointerDragRef.current = null;
    }
    clearPetPointerSession(event.currentTarget, event.pointerId);
    if (session.dragStarted) setReaction({ action: 'waving' });
    if (shouldShowMain) {
      void showMainWindowFromPet();
    }
  };

  const onPetPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    const session = petPointerSessionRef.current;
    if (!session || event.pointerId !== session.pointerId) {
      return;
    }
    clearPetPointerSession(event.currentTarget, event.pointerId);
  };

  const displayMood: AgentCompanionPetMood = isDraggingPet
    ? 'dragging'
    : isHoveringPet
      ? 'hover'
      : mood;

  const openTaskSession = async (task: AgentCompanionTaskStatus) => {
    try {
      await emit('agent-companion://open-session', { sessionId: task.sessionId });
      await api.invoke('show_main_window');
    } catch (error) {
      log.warn('Failed to open Agent companion task session', {
        sessionId: task.sessionId,
        error,
      });
    }
  };

  const handlePetFrameSizeChange = useCallback((size: { width: number; height: number } | null) => {
    setPetFrameSize(size);
  }, []);

  const dockVars = {
    '--openbitfun-agent-companion-pet-width': `${activePetSize.width}px`,
    '--openbitfun-agent-companion-pet-height': `${activePetSize.height}px`,
    '--openbitfun-agent-companion-gap': `${WINDOW_HORIZONTAL_GAP}px`,
    '--openbitfun-agent-companion-vertical-buffer': `${WINDOW_VERTICAL_BUFFER}px`,
  } as React.CSSProperties;
  const isSingleTask = bubbleTasks.length === 1;
  const hasAttentionTask = bubbleTasks.some(task => task.state === 'attention');
  const overlayTask = overlay && overlay.kind !== 'pet-menu'
    ? bubbleTasks.find(task => task.sessionId === overlay.sessionId) ?? null
    : null;
  const menuItems = overlay?.kind === 'pet-menu'
    ? [
      { key: 'switch-pet', label: t('agentCompanion.menu.switchPet'), onClick: openPetSettings },
      { key: 'close-pet', label: t('agentCompanion.menu.closePet'), onClick: closeDesktopPet },
    ]
    : overlay?.kind === 'bubble-menu' && overlayTask
      ? [{
        key: 'close-bubble',
        label: t('agentCompanion.menu.closeBubble'),
        onClick: () => closeBubble(overlayTask),
      }]
      : [];

  return (
    <main
      className={`openbitfun-agent-companion-window${isMenuOverlay ? ' openbitfun-agent-companion-window--menu-open' : ''}${IS_WINDOWS_WEBVIEW ? ' openbitfun-agent-companion-window--native-hover' : ''}`}
      onContextMenu={onContextMenu}
      data-openbitfun-component="agent-companion-desktop-pet"
      data-openbitfun-part="root"
    >
      {overlay && (
        <div
          className="openbitfun-agent-companion-window__backdrop"
          onPointerDown={closeOverlay}
        />
      )}
      {menuItems.length > 0 && (
        <Menu
          ref={menuRef}
          className="openbitfun-agent-companion-window__overlay openbitfun-agent-companion-window__overlay--anchored"
          style={{
            right: `${menuPosition?.right ?? MENU_EDGE_MARGIN}px`,
            bottom: `${menuPosition?.bottom ?? MENU_EDGE_MARGIN}px`,
            visibility: menuPosition ? 'visible' : 'hidden',
          }}
          autoFocusFirstItem
        >
          {menuItems.map(menuItem => (
            <MenuItem
              key={menuItem.key}
              tone={menuItem.key === 'close-pet' ? 'danger' : 'neutral'}
              onClick={menuItem.onClick}
            >
              {menuItem.label}
            </MenuItem>
          ))}
        </Menu>
      )}
      <div className="openbitfun-agent-companion-window__stack" style={dockVars}>
        <div
          ref={dockRef}
          className="openbitfun-agent-companion-window__dock"
         data-openbitfun-component="agent-companion-desktop-pet" data-openbitfun-part="dock">
          {bubbleTasks.length > 0 && (
            <ScrollArea
              ref={bubblesRef}
              className={`openbitfun-agent-companion-window__bubbles${isSingleTask ? ' openbitfun-agent-companion-window__bubbles--single' : ''}`}
              aria-live="polite"
              onDoubleClick={event => event.stopPropagation()}
             data-openbitfun-component="agent-companion-desktop-pet" data-openbitfun-part="bubbles">
              {displayTasks.map(task => {
                const isComposingTask = overlay?.kind === 'composer'
                  && overlay.sessionId === task.sessionId;
                const isHoveredTask = hoveredBubbleSessionId === task.sessionId;
                const bubbleClassName = `openbitfun-agent-companion-window__bubble openbitfun-agent-companion-window__bubble--${task.state}${isSingleTask ? ' openbitfun-agent-companion-window__bubble--single' : ''}${isComposingTask ? ' openbitfun-agent-companion-window__bubble--composing' : ''}`;
                const bubbleBody = (
                  <>
                    <OverflowText className="openbitfun-agent-companion-window__bubble-title" data-openbitfun-component="agent-companion-desktop-pet" data-openbitfun-part="bubbleTitle">
                      {task.title}
                    </OverflowText>
                    <OverflowText className="openbitfun-agent-companion-window__bubble-status" data-openbitfun-component="agent-companion-desktop-pet" data-openbitfun-part="bubbleStatus">
                      {t(task.labelKey, { defaultValue: task.defaultLabel })}
                    </OverflowText>
                    {isSingleTask && task.latestOutput && (() => {
                      const typedOutput = typedOutputBySessionId[task.sessionId];
                      const visibleOutput = typedOutput?.visible ?? seedTypewriterOutput(task.latestOutput);
                      const targetOutput = typedOutput?.target ?? task.latestOutput;
                      const isTyping = visibleOutput !== targetOutput;
                      const sessionId = task.sessionId;

                      return (
                        <span
                          ref={element => {
                            if (element) {
                              outputRefs.current.set(sessionId, element);
                            } else {
                              outputRefs.current.delete(sessionId);
                            }
                          }}
                          className={`openbitfun-agent-companion-window__bubble-output${isTyping ? ' openbitfun-agent-companion-window__bubble-output--typing' : ''}`}
                         data-openbitfun-component="agent-companion-desktop-pet" data-openbitfun-part="bubbleOutput" data-openbitfun-state={isTyping ? 'typing' : undefined}>
                          {visibleOutput}
                        </span>
                      );
                    })()}
                  </>
                );

                return (
                  <div
                    key={task.sessionId}
                    data-agent-companion-session-id={task.sessionId}
                    className={`openbitfun-agent-companion-window__bubble-shell${isSingleTask ? ' openbitfun-agent-companion-window__bubble-shell--single' : ''}${isHoveredTask ? ' openbitfun-agent-companion-window__bubble-shell--hovered' : ''}`}
                    onContextMenu={event => onBubbleContextMenu(event, task.sessionId)}
                  >
                    {isComposingTask ? (
                      // The bubble itself becomes the composer: no extra panel,
                      // and the window keeps its size.
                      <div className={bubbleClassName} data-openbitfun-component="agent-companion-desktop-pet" data-openbitfun-part="bubble">
                        {bubbleBody}
                        <div className="openbitfun-agent-companion-window__bubble-composer">
                          <input
                            ref={composerInputRef}
                            type="text"
                            className="openbitfun-agent-companion-window__bubble-composer-input"
                            value={composerValue}
                            placeholder={t('agentCompanion.composer.placeholder')}
                            aria-label={t('agentCompanion.composer.ariaLabel')}
                            onChange={event => setComposerValue(event.target.value)}
                            onKeyDown={onComposerKeyDown}
                            onCompositionStart={() => {
                              composerCompositionActiveRef.current = true;
                            }}
                            onCompositionEnd={() => {
                              composerCompositionActiveRef.current = false;
                            }}
                          />
                          <button
                            type="button"
                            className="openbitfun-agent-companion-window__bubble-composer-cancel"
                            title={t('agentCompanion.composer.cancel')}
                            aria-label={t('agentCompanion.composer.cancel')}
                            onClick={cancelBubbleComposer}
                          >
                            <LucideX width="11" height="11" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="openbitfun-agent-companion-window__bubble-composer-send"
                            title={t('agentCompanion.composer.send')}
                            aria-label={t('agentCompanion.composer.send')}
                            disabled={!composerValue.trim() || isSendingComposer}
                            onClick={() => void submitBubbleComposer()}
                          >
                            <LucideArrowUp width="11" height="11" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className={bubbleClassName}
                        onClick={() => void openTaskSession(task)}
                        data-openbitfun-component="agent-companion-desktop-pet"
                        data-openbitfun-part="bubble"
                      >
                        {bubbleBody}
                      </button>
                    )}
                    {task.canReply !== false && !isComposingTask && (
                      <button
                        type="button"
                        className="openbitfun-agent-companion-window__bubble-compose"
                        title={t('agentCompanion.composer.openTitle')}
                        aria-label={t('agentCompanion.composer.openTitle')}
                        onClick={() => openBubbleComposer(task.sessionId)}
                      >
                        <LucidePencilLine width="11" height="11" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                );
              })}
            </ScrollArea>
          )}
          <div
            className={`openbitfun-agent-companion-window__pet-hitbox${hasAttentionTask ? ' openbitfun-agent-companion-window__pet-hitbox--needs-attention' : ''}`}
            onPointerEnter={() => setIsHoveringPet(true)}
            onPointerLeave={() => setIsHoveringPet(false)}
            onPointerDown={onPetPointerDown}
            onPointerMove={onPetPointerMove}
            onPointerUp={onPetPointerUp}
            onPointerCancel={onPetPointerCancel}
            onLostPointerCapture={onPetPointerCancel}
            onContextMenu={onPetContextMenu}
           data-openbitfun-component="agent-companion-desktop-pet" data-openbitfun-part="hitbox" data-openbitfun-state={hasAttentionTask ? 'attention' : undefined}>
            <AgentCompanionPet
              mood={displayMood}
              dragDirection={dragDirection}
              action={!isDraggingPet
                ? mood === 'rest' && visibleTasks.some(task => task.state === 'error') ? 'failed' : reaction?.action ?? null
                : null}
              pet={pet}
              lookDirection={trackPetLook && !isDraggingPet ? lookDirection : null}
              nativePetdexSize
              petdexScale={PETDEX_DESKTOP_SCALE}
              onPetFrameSizeChange={handlePetFrameSizeChange}
              className="openbitfun-agent-companion-window__pet"
             data-openbitfun-component="agent-companion-desktop-pet" data-openbitfun-part="pet"/>
          </div>
        </div>
      </div>
    </main>
  );
};

export default AgentCompanionDesktopPet;
