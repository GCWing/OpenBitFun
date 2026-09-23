/**
 * Terminal base component built on xterm.js.
 * Optimizations include debounced resize and visibility-aware refresh.
 */

import React, { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import {
  TerminalResizeDebouncer,
  DEFAULT_XTERM_MINIMUM_CONTRAST_RATIO,
} from '../utils';
import type { TerminalPasteDecision } from '../utils';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { xtermAppearanceAdapter } from '@/infrastructure/appearance/adapters/XtermAppearanceAdapter';
import { createLogger } from '@/shared/utils/logger';
import { sendDebugProbe } from '@/shared/utils/debugProbe';
import { nowMs } from '@/shared/utils/timing';
import {
  getTypographyTokenNumber,
  readActiveTypographyTokenValue,
  readActiveTypographyTokenPx,
} from '@/infrastructure/design-system/typographyRuntime';
import { fontPreferenceService } from '@/infrastructure/font-preference';
import '@xterm/xterm/css/xterm.css';
import './Terminal.scss';

const log = createLogger('Terminal');
const MIN_STABLE_TERMINAL_ROWS = 3;
const TERMINAL_FONT_WEIGHT = getTypographyTokenNumber('font.weight.regular');
const TERMINAL_FONT_WEIGHT_BOLD = getTypographyTokenNumber('font.weight.bold');

// Empty xterm buffers start with blank rows. Do not treat those as replayed
// content, otherwise a new terminal can inherit the replay column guard and skip
// its first real fit.
function terminalHasBufferedScreenText(terminal: XTerm): boolean {
  const buffer = terminal.buffer.active;
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index)?.translateToString(true) ?? '';
    if (line.trim().length > 0) {
      return true;
    }
  }
  return false;
}

type TerminalCoreWithMeasurement = XTerm & {
  _core?: {
    _charSizeService?: {
      measure?: () => void;
    };
    _renderService?: {
      handleDevicePixelRatioChange?: () => void;
    };
  };
};

/**
 * Clear xterm texture atlas when supported.
 * Used to force redraws and avoid WebGL cache artifacts.
 */
function clearTextureAtlas(terminal: XTerm): void {
  // clearTextureAtlas is internal; access via a type cast.
  const rawTerminal = terminal as unknown as { _core?: { _renderService?: { _renderer?: { _charAtlasCache?: { clear?: () => void }; clearTextureAtlas?: () => void } } } };
  try {
    rawTerminal._core?._renderService?._renderer?.clearTextureAtlas?.();
  } catch {
    // Ignore if unsupported.
  }
}

function remeasureTerminal(terminal: XTerm): void {
  const rawTerminal = terminal as TerminalCoreWithMeasurement;
  rawTerminal._core?._charSizeService?.measure?.();
  rawTerminal._core?._renderService?.handleDevicePixelRatioChange?.();
}

export interface TerminalOptions {
  fontSize?: number;
  fontFamily?: string;
  lineHeight?: number;
  minimumContrastRatio?: number;
  cursorStyle?: 'block' | 'underline' | 'bar';
  cursorBlink?: boolean;
  scrollback?: number;
  /** Initial columns to avoid early wrapping. */
  cols?: number;
  rows?: number;
}

export interface TerminalProps {
  className?: string;
  /** For context menu identification. */
  terminalId?: string;
  /** For context menu identification. */
  sessionId?: string;
  options?: TerminalOptions;
  autoFocus?: boolean;
  onData?: (data: string) => void;
  onBinary?: (data: string) => void;
  onTitleChange?: (title: string) => void;
  /** Notify backend PTY about size changes. */
  onResize?: (cols: number, rows: number) => void;
  onReady?: (terminal: XTerm) => void;
  /**
   * Keyboard paste shortcut interceptor. Return true when the shortcut was
   * handled without reading clipboard text, for example by sending Ctrl+V to a
   * shell that owns paste behavior.
   */
  onPasteShortcut?: (
    context: { terminal: XTerm; bracketedPasteMode: boolean },
  ) => Promise<boolean> | boolean;
  /**
   * Paste interceptor: return true to allow, false to block, or a decision with
   * modified text. When omitted, paste is allowed and xterm handles normalization.
   */
  onPaste?: (
    text: string,
    context: { terminal: XTerm; bracketedPasteMode: boolean },
  ) => Promise<boolean | TerminalPasteDecision> | boolean | TerminalPasteDecision;
  /**
   * When set to a positive value, doXtermResize skips any resize that would
   * shrink the terminal below this column count. Used during history replay to
   * prevent CSS-animation intermediate sizes from permanently truncating buffered
   * content. Set back to 0 (or leave unset) to restore normal resize behaviour.
   */
  preventShrinkBelowColsRef?: React.MutableRefObject<number>;
  /**
   * Suspend layout-driven resize while the containing panel is animating.
   * xterm.js reflows its buffer on resize, so intermediate transition sizes
   * should be ignored and replaced by one final fit when animation settles.
   */
  resizeSuspended?: boolean;
}

export interface TerminalRef {
  write: (data: string) => void;
  writeln: (data: string) => void;
  clear: () => void;
  reset: () => void;
  focus: () => void;
  paste: (data: string) => void;
  fit: () => void;
  /** Flush pending debounced resize operations. */
  flushResize: () => void;
  /** Force a redraw (clears texture cache). */
  forceRedraw: () => void;
  getTerminal: () => XTerm | null;
  getSize: () => { cols: number; rows: number } | null;
}

/**
 * Read the current xterm appearance synchronously.
 * Calling this at XTerm construction time prevents the initial black-background flash
 * that occurs when the theme is applied asynchronously via useEffect.
 */
function getInitialXtermColors() {
  return xtermAppearanceAdapter.getColors('terminal');
}

function normalizePasteDecision(
  decision: boolean | TerminalPasteDecision | undefined,
  originalText: string,
): TerminalPasteDecision {
  if (decision === false) {
    return { allow: false };
  }

  if (decision === true || decision === undefined) {
    return { allow: true, text: originalText };
  }

  return decision;
}

/**
 * The interactive terminal shares the `xs` code step with chat code blocks so a
 * shell panel never renders larger than the code beside it, and it follows the
 * global font size preference because xterm takes a pixel size instead of a CSS
 * custom property.
 */
const TERMINAL_FONT_SIZE_TOKEN = 'font.size.xs' as const;

function readTerminalFontSize(): number {
  return readActiveTypographyTokenPx(TERMINAL_FONT_SIZE_TOKEN);
}

const DEFAULT_OPTIONS: TerminalOptions = {
  lineHeight: getTypographyTokenNumber('lineHeight.tight'),
  minimumContrastRatio: DEFAULT_XTERM_MINIMUM_CONTRAST_RATIO,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 10000,
};

const Terminal = forwardRef<TerminalRef, TerminalProps>(({
  className = '',
  terminalId,
  sessionId,
  options = {},
  autoFocus = false,
  onData,
  onBinary,
  onTitleChange,
  onResize,
  onReady,
  onPasteShortcut,
  onPaste,
  preventShrinkBelowColsRef,
  resizeSuspended = false,
}, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const intersectionObserverRef = useRef<IntersectionObserver | null>(null);
  const resizeDebouncerRef = useRef<TerminalResizeDebouncer | null>(null);
  const isVisibleRef = useRef(true);
  const wasVisibleRef = useRef(false);
  const lastBackendSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const autoFocusRef = useRef(autoFocus);
  const terminalIdRef = useRef(terminalId);
  const sessionIdRef = useRef(sessionId);
  const onDataRef = useRef(onData);
  const onBinaryRef = useRef(onBinary);
  const onTitleChangeRef = useRef(onTitleChange);
  const onResizeRef = useRef(onResize);
  const onReadyRef = useRef(onReady);
  const onPasteShortcutRef = useRef(onPasteShortcut);
  const onPasteRef = useRef(onPaste);
  const resizeSuspendedRef = useRef(resizeSuspended);
  const pendingFitAfterSuspendRef = useRef(false);
  // Track key-pressed state to mirror xterm's internal _keyDownSeen flag.
  // Used by the input-event safety net (see below).
  const keyDownSeenRef = useRef(false);
  // Track whether keypress already handled the character, mirroring xterm's
  // _keyPressHandled, to avoid duplicates in the safety net.
  const keyPressHandledRef = useRef(false);
  const [isReady, setIsReady] = useState(false);
  const [fontSize, setFontSize] = useState(readTerminalFontSize);
  useEffect(() => {
    const syncFontSize = () => setFontSize(readTerminalFontSize());
    return fontPreferenceService.on('font:after-change', syncFontSize);
  }, []);
  // Merge options. Appearance is resolved at render time so that the
  // initial XTerm instance is created with the correct background color and avoids
  // the black-background flash that occurs when a light theme is active.
  const mergedOptions = {
    ...DEFAULT_OPTIONS,
    fontFamily: readActiveTypographyTokenValue('font.family.mono'),
    fontSize,
    ...options,
    theme: getInitialXtermColors(),
  };
  const mergedOptionsRef = useRef(mergedOptions);
  autoFocusRef.current = autoFocus;
  terminalIdRef.current = terminalId;
  sessionIdRef.current = sessionId;
  onDataRef.current = onData;
  onBinaryRef.current = onBinary;
  onTitleChangeRef.current = onTitleChange;
  onResizeRef.current = onResize;
  onReadyRef.current = onReady;
  onPasteShortcutRef.current = onPasteShortcut;
  onPasteRef.current = onPaste;
  resizeSuspendedRef.current = resizeSuspended;
  mergedOptionsRef.current = mergedOptions;

  // Force refresh for rendering consistency.
  const forceRefresh = useCallback((terminal: XTerm) => {
    const rows = terminal.rows;
    terminal.refresh(0, rows - 1);
    clearTextureAtlas(terminal);
  }, []);

  const doXtermResize = useCallback((cols: number, rows: number): boolean => {
    const terminal = terminalRef.current;
    if (!terminal) return false;

    try {
      if (resizeSuspendedRef.current) {
        pendingFitAfterSuspendRef.current = true;
        return false;
      }

      if (terminal.cols === cols && terminal.rows === rows) {
        return true;
      }

      // While the caller has set a minimum column guard (e.g., during history
      // replay), skip any resize that would shrink below that value.  This
      // prevents CSS open-animation intermediate widths from permanently
      // truncating buffered content that was written at a wider column count.
      const minCols = preventShrinkBelowColsRef?.current ?? 0;
      const hasBufferedScreenText = minCols > 0 ? terminalHasBufferedScreenText(terminal) : false;
      // The guard only protects actual screen text. Applying it to an empty new
      // terminal leaves xterm at 80x24 while the PTY moves to the panel size,
      // which creates blank scrollback during shell startup repaints.
      if (minCols > 0 && cols < minCols && hasBufferedScreenText) {
        return false;
      }

      terminal.resize(cols, rows);

      return true;
    } catch (error) {
      log.warn('Xterm resize error', { cols, rows, error });
      return false;
    }
  }, [preventShrinkBelowColsRef]);

  // Notify backend PTY with deduping.
  const doBackendResize = useCallback((cols: number, rows: number) => {
    if (resizeSuspendedRef.current) {
      pendingFitAfterSuspendRef.current = true;
      return;
    }

    const terminal = terminalRef.current;
    // Keep frontend and PTY dimensions in lockstep. If xterm skipped a resize
    // because of replay protection or panel suspension, sending it to the PTY
    // would make subsequent shell repaint output land in the wrong geometry.
    if (terminal && (terminal.cols !== cols || terminal.rows !== rows)) {
      return;
    }

    const lastSize = lastBackendSizeRef.current;
    if (lastSize && lastSize.cols === cols && lastSize.rows === rows) {
      return;
    }
    
    lastBackendSizeRef.current = { cols, rows };
    
    onResizeRef.current?.(cols, rows);
  }, []);

  // Post-resize fixups (refresh and cursor visibility).
  const handleResizeComplete = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    requestAnimationFrame(() => {
      if (terminalRef.current) {
        forceRefresh(terminalRef.current);
      }
    });
  }, [forceRefresh]);

  const fit = useCallback((immediate = false) => {
    if (!fitAddonRef.current || !terminalRef.current || !containerRef.current) {
      return;
    }

    try {
      if (resizeSuspendedRef.current) {
        pendingFitAfterSuspendRef.current = true;
        return;
      }

      const { clientWidth, clientHeight } = containerRef.current;
      if (clientWidth < 50 || clientHeight < 50) {
        return;
      }

      const dims = fitAddonRef.current.proposeDimensions();
      if (!dims || dims.cols <= 0 || dims.rows <= 0) {
        return;
      }

      // Skip only unusably tiny dimensions. Panel animation and drag resizes are
      // suspended by the parent; the final compact bottom panel still needs to
      // resize to fewer than 10 rows so the prompt remains visible.
      if (dims.cols < 40 || dims.rows < MIN_STABLE_TERMINAL_ROWS) {
        return;
      }

      if (resizeDebouncerRef.current) {
        resizeDebouncerRef.current.resize(dims.cols, dims.rows, immediate);
      } else {
        if (doXtermResize(dims.cols, dims.rows)) {
          doBackendResize(dims.cols, dims.rows);
          handleResizeComplete();
        }
      }
    } catch (error) {
      log.warn('Fit error', error);
    }
  }, [doXtermResize, doBackendResize, handleResizeComplete]);

  const flushResize = useCallback(() => {
    if (resizeSuspendedRef.current) {
      pendingFitAfterSuspendRef.current = true;
      return;
    }
    resizeDebouncerRef.current?.flush();
  }, []);

  const forceRedraw = useCallback(() => {
    const terminal = terminalRef.current;
    if (terminal) {
      forceRefresh(terminal);
    }
  }, [forceRefresh]);
  const doXtermResizeRef = useRef(doXtermResize);
  const doBackendResizeRef = useRef(doBackendResize);
  const handleResizeCompleteRef = useRef(handleResizeComplete);
  const fitRef = useRef(fit);
  const forceRefreshRef = useRef(forceRefresh);

  doXtermResizeRef.current = doXtermResize;
  doBackendResizeRef.current = doBackendResize;
  handleResizeCompleteRef.current = handleResizeComplete;
  fitRef.current = fit;
  forceRefreshRef.current = forceRefresh;

  useEffect(() => {
    if (resizeSuspended) {
      return;
    }

    if (!pendingFitAfterSuspendRef.current) {
      return;
    }

    pendingFitAfterSuspendRef.current = false;
    requestAnimationFrame(() => {
      resizeDebouncerRef.current?.flush();
      fitRef.current(true);
    });
  }, [resizeSuspended]);

  useImperativeHandle(ref, () => ({
    write: (data: string) => {
      terminalRef.current?.write(data);
    },
    writeln: (data: string) => {
      terminalRef.current?.writeln(data);
    },
    clear: () => {
      terminalRef.current?.clear();
    },
    reset: () => {
      terminalRef.current?.reset();
    },
    focus: () => {
      terminalRef.current?.focus();
    },
    paste: (data: string) => {
      terminalRef.current?.paste(data);
    },
    fit: () => fit(false),
    flushResize,
    forceRedraw,
    getTerminal: () => terminalRef.current,
    getSize: () => {
      if (terminalRef.current) {
        return {
          cols: terminalRef.current.cols,
          rows: terminalRef.current.rows,
        };
      }
      return null;
    },
  }), [fit, flushResize, forceRedraw]);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    // Let fit() determine size; backend starts at 80x24 and syncs via resize.
    const terminal = new XTerm({
      fontSize: mergedOptionsRef.current.fontSize,
      fontFamily: mergedOptionsRef.current.fontFamily,
      fontWeight: TERMINAL_FONT_WEIGHT,
      fontWeightBold: TERMINAL_FONT_WEIGHT_BOLD,
      lineHeight: mergedOptionsRef.current.lineHeight,
      minimumContrastRatio: mergedOptionsRef.current.minimumContrastRatio,
      cursorStyle: mergedOptionsRef.current.cursorStyle,
      cursorBlink: mergedOptionsRef.current.cursorBlink,
      scrollback: mergedOptionsRef.current.scrollback,
      theme: mergedOptionsRef.current.theme,
      // Keep the interactive terminal on the opaque WebGL path. Transparent
      // glyph atlases use a different blending/clearing strategy and are much
      // more prone to artifacts on colored cell backgrounds.
      allowTransparency: false,
      // TUI apps usually handle line wrapping.
      convertEol: false,
    });

    const fitAddon = new FitAddon();
    // WebLinksAddon supports Ctrl+click to open URLs.
    let currentHoverTarget: HTMLElement | null = null;
    const webLinksAddon = new WebLinksAddon(
      (event, uri) => {
        if (event.ctrlKey || event.metaKey) {
          systemAPI.openExternal(uri).catch((error) => {
            log.error('Failed to open external link', { uri, error });
          });
        }
      },
      {
        hover: (event, _uri, _range) => {
          const target = event.target as HTMLElement;
          if (target) {
            if (currentHoverTarget && currentHoverTarget !== target) {
              currentHoverTarget.removeAttribute('title');
            }
            currentHoverTarget = target;
            const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
            target.title = isMac ? '\u2318 + click to open link' : 'Ctrl + click to open link';
          }
        },
        leave: (event, _text) => {
          const target = event.target as HTMLElement;
          if (target) {
            target.removeAttribute('title');
          }
          if (currentHoverTarget) {
            currentHoverTarget.removeAttribute('title');
            currentHoverTarget = null;
          }
        },
      }
    );

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);

    terminal.open(container);

    const xtermViewport = container.querySelector<HTMLElement>('.xterm-viewport');
    if (xtermViewport) {
      xtermViewport.dataset.openbitfunComponent = 'terminal-tool';
      xtermViewport.dataset.openbitfunPart = 'output';
    }
    const xtermScreen = container.querySelector<HTMLElement>('.xterm-screen');
    if (xtermScreen) {
      xtermScreen.dataset.openbitfunComponent = 'terminal-tool';
      xtermScreen.dataset.openbitfunPart = 'screen';
    }

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // WebGL renderer must be loaded after terminal.open().
    try {
      const webglAddon = new WebglAddon();
      
      webglAddon.onContextLoss(() => {
        log.warn('WebGL context lost, falling back to canvas');
        webglAddon.dispose();
        webglAddonRef.current = null;
      });
      
      terminal.loadAddon(webglAddon);
      webglAddonRef.current = webglAddon;
    } catch (error) {
      log.debug('WebGL not available, using canvas', error);
    }

    const resizeDebouncer = new TerminalResizeDebouncer({
      getTerminal: () => terminalRef.current,
      isVisible: () => isVisibleRef.current,
      onXtermResize: (cols, rows) => doXtermResizeRef.current(cols, rows),
      onBackendResize: (cols, rows) => doBackendResizeRef.current(cols, rows),
      onFlush: () => {
        if (terminalRef.current) {
          forceRefreshRef.current(terminalRef.current);
        }
      },
      onResizeComplete: () => handleResizeCompleteRef.current(),
    });
    resizeDebouncerRef.current = resizeDebouncer;

    requestAnimationFrame(() => {
      fitRef.current(true);

      setIsReady(true);
      onReadyRef.current?.(terminal);

      if (autoFocusRef.current) {
        terminal.focus();
      }
    });

    let fontLoadCancelled = false;
    if (typeof document !== 'undefined' && 'fonts' in document) {
      const fontSet = document.fonts as FontFaceSet;
      if (fontSet.status !== 'loaded') {
        void fontSet.ready.then(() => {
          if (fontLoadCancelled || !terminalRef.current) {
            return;
          }

          requestAnimationFrame(() => {
            if (!terminalRef.current) return;

            remeasureTerminal(terminalRef.current);
            fitRef.current(true);

            requestAnimationFrame(() => {
              if (!terminalRef.current) return;
              forceRefreshRef.current(terminalRef.current);
            });
          });
        });
      }
    }

    const dataDisposable = terminal.onData((data) => {
      onDataRef.current?.(data);
    });

    const binaryDisposable = terminal.onBinary((data) => {
      onBinaryRef.current?.(data);
    });

    const titleDisposable = terminal.onTitleChange((title) => {
      onTitleChangeRef.current?.(title);
    });

    const pasteText = async (text: string): Promise<void> => {
      if (!text) return;

      const activeTerminal = terminalRef.current ?? terminal;
      let pasteDecision: TerminalPasteDecision = { allow: true, text };
      if (onPasteRef.current) {
        pasteDecision = normalizePasteDecision(
          await onPasteRef.current(text, {
            terminal: activeTerminal,
            bracketedPasteMode: activeTerminal.modes.bracketedPasteMode,
          }),
          text,
        );
      }

      if (!pasteDecision.allow) {
        return;
      }

      activeTerminal.paste(pasteDecision.text);
    };

    const handleNativePaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (!text) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      pasteText(text).catch((err) => {
        log.error('Paste failed', err);
      });
    };

    container.addEventListener('paste', handleNativePaste, true);

    // Intercept paste (Ctrl+V / Ctrl+Shift+V) so callers can apply the same
    // policy as context-menu paste before xterm normalizes/sends the data.
    // Also track key-pressed state and bypass keyCode 229 for the input-event
    // safety net below.
    terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type === 'keydown') {
        keyDownSeenRef.current = true;
      } else if (event.type === 'keyup') {
        keyDownSeenRef.current = false;
        keyPressHandledRef.current = false;
      }

      if (event.type === 'keydown' && event.ctrlKey && (event.key === 'v' || event.key === 'V')) {
        event.preventDefault();
        
        (async () => {
          try {
            const activeTerminal = terminalRef.current ?? terminal;
            if (onPasteShortcutRef.current) {
              const handled = await onPasteShortcutRef.current({
                terminal: activeTerminal,
                bracketedPasteMode: activeTerminal.modes.bracketedPasteMode,
              });
              if (handled) {
                return;
              }
            }

            const text = await navigator.clipboard.readText();
            if (!text) return;

            await pasteText(text);
          } catch (err) {
            log.error('Paste failed', err);
          }
        })();
        
        return false;
      }

      // When an IME is active (even in ASCII mode), keydown events may carry
      // keyCode 229. xterm.js delegates these to _handleAnyTextareaChanges
      // (setTimeout(0) — racy during key rollover) and _inputEvent (skipped
      // when _keyDownSeen is true). Both paths can lose the character.
      //
      // Bypass xterm entirely for keyCode 229: return false without
      // preventDefault(), so the browser inserts the character into the
      // textarea and fires an input event. The safety-net listener below
      // catches that event synchronously — no setTimeout race, no duplicates.
      // During active IME composition, compositionstart/compositionend events
      // still fire and xterm handles them normally; this only affects the
      // non-composition passthrough path.
      if (event.type === 'keydown' && event.keyCode === 229) {
        return false;
      }

      return true;
    });

    // Input-event safety net for key rollover with an active IME.
    //
    // Because we bypass keyCode 229 in the custom key handler above, xterm's
    // _handleAnyTextareaChanges (setTimeout(0)) is never called for those keys.
    // Instead, the browser inserts the character and fires an input event.
    //
    // xterm's own _inputEvent handler skips events where (composed && keyDownSeen)
    // — exactly the key-rollover case. This listener catches those skipped
    // insertText events and forwards them via onData, preventing character loss.
    // It only fires when xterm would skip (composed + keyDownSeen) and keypress
    // didn't already handle the character, so it never causes duplicates.
    const textareaEl = container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    let textareaKeyPressHandler: (() => void) | null = null;
    let textareaInputHandler: ((ev: Event) => void) | null = null;
    if (textareaEl) {
      textareaKeyPressHandler = () => {
        keyPressHandledRef.current = true;
      };
      textareaInputHandler = (ev: Event) => {
        const inputEvent = ev as InputEvent;
        if (
          inputEvent.data &&
          inputEvent.inputType === 'insertText' &&
          inputEvent.composed === true &&
          keyDownSeenRef.current &&
          !keyPressHandledRef.current
        ) {
          // xterm's _inputEvent will skip this (composed + keyDownSeen).
          // Forward the character to prevent loss during key rollover.
          onDataRef.current?.(inputEvent.data);
        }
      };
      textareaEl.addEventListener('keypress', textareaKeyPressHandler);
      textareaEl.addEventListener('input', textareaInputHandler, true);
    }

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        fitRef.current(false);
      });
    });
    resizeObserver.observe(container);
    resizeObserverRef.current = resizeObserver;

    // On visibility change, flush pending resize and refresh.
    const intersectionObserver = new IntersectionObserver((entries) => {
      const entry = entries[0];
      const isVisible = entry.isIntersecting;
      
      isVisibleRef.current = isVisible;

      if (isVisible && !wasVisibleRef.current) {
        const startedAt = nowMs();
        requestAnimationFrame(() => {
          resizeDebouncerRef.current?.flush();
          
          fitRef.current(true);
          
          requestAnimationFrame(() => {
            const term = terminalRef.current;
            if (term) {
              term.refresh(0, term.rows - 1);
              clearTextureAtlas(term);
              if (autoFocusRef.current) {
                term.focus();
              }
            }
            sendDebugProbe(
              'Terminal.tsx:intersectionObserver',
              'Terminal visibility restore completed',
              {
                terminalId: terminalIdRef.current,
                sessionId: sessionIdRef.current,
                autoFocus: autoFocusRef.current,
                cols: term?.cols ?? null,
                rows: term?.rows ?? null,
              },
              { startedAt }
            );
          });
        });
      }
      wasVisibleRef.current = isVisible;
    }, {
      threshold: 0.1
    });
    intersectionObserver.observe(container);
    intersectionObserverRef.current = intersectionObserver;

    return () => {
      dataDisposable.dispose();
      binaryDisposable.dispose();
      titleDisposable.dispose();
      container.removeEventListener('paste', handleNativePaste, true);
      if (textareaEl && textareaKeyPressHandler) {
        textareaEl.removeEventListener('keypress', textareaKeyPressHandler);
      }
      if (textareaEl && textareaInputHandler) {
        textareaEl.removeEventListener('input', textareaInputHandler, true);
      }
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      fontLoadCancelled = true;
      resizeDebouncer.dispose();
      webglAddonRef.current?.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      webglAddonRef.current = null;
      resizeObserverRef.current = null;
      intersectionObserverRef.current = null;
      resizeDebouncerRef.current = null;
      lastBackendSizeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !isReady) return;

    terminal.options.fontSize = mergedOptions.fontSize;
    terminal.options.fontFamily = mergedOptions.fontFamily;
    terminal.options.lineHeight = mergedOptions.lineHeight;
    terminal.options.minimumContrastRatio = mergedOptions.minimumContrastRatio;
    terminal.options.cursorStyle = mergedOptions.cursorStyle;
    terminal.options.cursorBlink = mergedOptions.cursorBlink;
    terminal.options.scrollback = mergedOptions.scrollback;
    terminal.options.theme = mergedOptions.theme;

    fit(true);
  }, [
    mergedOptions.fontSize,
    mergedOptions.fontFamily,
    mergedOptions.lineHeight,
    mergedOptions.minimumContrastRatio,
    mergedOptions.cursorStyle,
    mergedOptions.cursorBlink,
    mergedOptions.scrollback,
    mergedOptions.theme,
    isReady,
    fit,
  ]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !isReady) return;

    const updateXtermTheme = () => {
      (() => {
        terminal.options.theme = xtermAppearanceAdapter.getColors('terminal');

        forceRefresh(terminal);
      })();
    };

    updateXtermTheme();

    const unsubscribe = xtermAppearanceAdapter.subscribe(updateXtermTheme);
    return () => {
      unsubscribe?.();
    };
  }, [isReady, forceRefresh]);

  return (
    <div 
      className={`openbitfun-terminal ${className}`}
      data-openbitfun-component="terminal-tool"
      data-openbitfun-part="root"
      data-shortcut-scope="terminal"
      data-terminal-id={terminalId}
      data-session-id={sessionId}
      data-testid="shell-command-item"
      data-command-id={sessionId}
    >
      <div 
        ref={containerRef} 
        className="openbitfun-terminal__container"
        data-openbitfun-component="terminal-tool"
        data-openbitfun-part="terminal"
        data-testid="shell-command-output"
      />
    </div>
  );
});

Terminal.displayName = 'Terminal';

export default Terminal;
