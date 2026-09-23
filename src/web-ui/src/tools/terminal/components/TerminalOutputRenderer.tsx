/**
 * Terminal output renderer based on xterm.js (read-only).
 * Uses TerminalActionManager to avoid per-instance EventBus listeners.
 */
import { forwardRef, memo, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { registerTerminalActions, unregisterTerminalActions } from '../services/TerminalActionManager';
import { xtermAppearanceAdapter } from '@/infrastructure/appearance/adapters/XtermAppearanceAdapter';
import {
  DEFAULT_XTERM_MINIMUM_CONTRAST_RATIO,
} from '../utils';
import {
  calculateTerminalOutputHeight,
  getEstimatedTerminalOutputRowHeight,
  prepareReadOnlyTerminalOutput,
  readTerminalOutputFontFamily,
  TERMINAL_OUTPUT_FONT_SIZE,
  TERMINAL_OUTPUT_FONT_WEIGHT,
  TERMINAL_OUTPUT_FONT_WEIGHT_BOLD,
  TERMINAL_OUTPUT_LINE_HEIGHT,
  type TerminalOutputFallbackModel,
} from './terminalOutputPresentation';
import '@xterm/xterm/css/xterm.css';

export interface TerminalOutputRendererProps {
  /** Output content to render. */
  content: string;
  /** Optional class name. */
  className?: string;
  /** Terminal ID for context menus; auto-generated if omitted. */
  terminalId?: string;
  /** Minimum height. */
  minHeight?: number;
  /** Maximum height. */
  maxHeight?: number;
  /** Maximum visible terminal rows. Takes precedence over maxHeight. */
  maxRows?: number;
  /** Plain-text preview retained until xterm has rendered its first content frame. */
  initialFallback?: TerminalOutputFallbackModel;
}

export interface TerminalOutputRendererHandle {
  getVisibleText: () => string;
}

function getTerminalVisibleText(terminal: XTerm | null): string {
  if (!terminal) {
    return '';
  }

  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  const endRow = Math.min(buffer.viewportY + terminal.rows, buffer.length);

  for (let row = buffer.viewportY; row < endRow; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
  }

  while (lines.length > 0 && !lines[lines.length - 1].trim()) {
    lines.pop();
  }

  return lines.join('\n');
}

function hasScrollableTerminalBuffer(terminal: XTerm | null): boolean {
  const buffer = terminal?.buffer.active;
  if (!terminal || !buffer) {
    return false;
  }

  return buffer.baseY > 0 || buffer.length > terminal.rows;
}

/**
 * xterm.js read-only output renderer.
 */
const TerminalOutputRendererComponent = forwardRef<TerminalOutputRendererHandle, TerminalOutputRendererProps>(({
  content,
  className = '',
  terminalId: propTerminalId,
  minHeight = getEstimatedTerminalOutputRowHeight(),
  maxHeight = 300,
  maxRows,
  initialFallback,
}, ref) => {
  const autoId = useId();
  const terminalId = propTerminalId || `terminal-output-${autoId}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const lastRenderedContentRef = useRef<string>('');
  const revealInitialFallbackOnRenderRef = useRef(false);
  const initialRenderReadyRef = useRef(initialFallback == null);
  const [rowHeight, setRowHeight] = useState(getEstimatedTerminalOutputRowHeight);
  const [hasScrollableBuffer, setHasScrollableBuffer] = useState(false);
  const [isInitialRenderReady, setIsInitialRenderReady] = useState(initialFallback == null);
  const preparedContent = prepareReadOnlyTerminalOutput(content);

  useImperativeHandle(ref, () => ({
    getVisibleText: () => getTerminalVisibleText(terminalRef.current),
  }), []);

  const height = calculateTerminalOutputHeight(preparedContent, {
    rowHeight,
    minHeight,
    maxHeight,
    maxRows,
  });
  const updateScrollableBufferState = useCallback(() => {
    setHasScrollableBuffer(hasScrollableTerminalBuffer(terminalRef.current));
  }, []);

  useLayoutEffect(() => {
    if (!containerRef.current) return;

    const terminal = new XTerm({
      disableStdin: true,       // Disable input for read-only rendering.
      cursorBlink: false,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      fontSize: TERMINAL_OUTPUT_FONT_SIZE,
      fontFamily: readTerminalOutputFontFamily(),
      fontWeight: TERMINAL_OUTPUT_FONT_WEIGHT,
      fontWeightBold: TERMINAL_OUTPUT_FONT_WEIGHT_BOLD,
      lineHeight: TERMINAL_OUTPUT_LINE_HEIGHT,
      minimumContrastRatio: DEFAULT_XTERM_MINIMUM_CONTRAST_RATIO,
      scrollback: 5000,
      convertEol: true,
      allowTransparency: false,
      theme: xtermAppearanceAdapter.getColors('output'),
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    const renderDisposable = terminal.onRender(() => {
      if (!revealInitialFallbackOnRenderRef.current || initialRenderReadyRef.current) {
        return;
      }

      revealInitialFallbackOnRenderRef.current = false;
      initialRenderReadyRef.current = true;
      setIsInitialRenderReady(true);
    });

    try {
      const nextRowHeight = terminal.dimensions?.css.cell.height;
      if (typeof nextRowHeight === 'number' && nextRowHeight > 0) {
        setRowHeight(nextRowHeight);
      }
      fitAddon.fit();
      updateScrollableBufferState();
    } catch {
      // Ignore fit errors.
    }

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          // The observed cell height depends on this container's current
          // rounded height. Writing it back here feeds xterm's fit result into
          // React's height calculation, which can oscillate between rows.
          fitAddon.fit();
          updateScrollableBufferState();
        } catch {
          // Ignore fit errors.
        }
      });
    });
    resizeObserver.observe(containerRef.current);
    resizeObserverRef.current = resizeObserver;

    return () => {
      renderDisposable.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      resizeObserverRef.current = null;
    };
  }, [updateScrollableBufferState]);

  // Register with TerminalActionManager to avoid per-instance EventBus listeners.
  useEffect(() => {
    registerTerminalActions(terminalId, {
      getTerminal: () => terminalRef.current,
      isReadOnly: true,
    });

    return () => {
      unregisterTerminalActions(terminalId);
    };
  }, [terminalId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const updateTheme = () => {
      terminal.options.theme = xtermAppearanceAdapter.getColors('output');
      terminal.refresh(0, terminal.rows - 1);
    };

    updateTheme();

    const unsubscribe = xtermAppearanceAdapter.subscribe(updateTheme);
    return () => {
      unsubscribe?.();
    };
  }, []);

  // Incremental write when content extends existing output.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const lastRenderedContent = lastRenderedContentRef.current;
    
    // Compare the normalized read-only text for incremental detection so the
    // height estimate and xterm buffer receive the same content.
    const revealInitialFallbackAfterRender = () => {
      if (initialRenderReadyRef.current) {
        return;
      }

      revealInitialFallbackOnRenderRef.current = true;
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
    };

    if (preparedContent.startsWith(lastRenderedContent) && lastRenderedContent.length > 0) {
      const newPart = preparedContent.slice(lastRenderedContent.length);
      if (newPart) {
        terminal.write(newPart, revealInitialFallbackAfterRender);
      }
    } else {
      terminal.clear();
      terminal.reset();
      if (preparedContent) {
        terminal.write(preparedContent, revealInitialFallbackAfterRender);
      } else if (!initialRenderReadyRef.current) {
        initialRenderReadyRef.current = true;
        setIsInitialRenderReady(true);
      }
    }
    updateScrollableBufferState();
    
    lastRenderedContentRef.current = preparedContent;

    requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit();
        updateScrollableBufferState();
      } catch {
        // Ignore fit errors.
      }
    });
  }, [preparedContent, updateScrollableBufferState]);

  return (
    <div
      className={`terminal-output-renderer ${className} ${hasScrollableBuffer ? 'terminal-output-renderer--scrollable' : 'terminal-output-renderer--no-scroll'}`}
      data-openbitfun-component="terminal-tool"
      data-openbitfun-part="output"
      data-terminal-id={terminalId}
      data-readonly="true"
      style={{
        height: `${height}px`,
        width: '100%',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <div
        ref={containerRef}
        className="terminal-output-renderer__xterm-host"
        aria-hidden={!isInitialRenderReady}
        style={{
          height: '100%',
          width: '100%',
          opacity: isInitialRenderReady ? 1 : 0,
        }}
      />
      {!isInitialRenderReady && initialFallback && (
        <pre
          className="terminal-output-pre terminal-output-renderer__initial-fallback"
          style={{
            position: 'absolute',
            inset: 0,
            height: '100%',
            maxHeight: '100%',
            overflow: 'hidden',
          }}
        >
          {initialFallback.content}
        </pre>
      )}
    </div>
  );
});

TerminalOutputRendererComponent.displayName = 'TerminalOutputRenderer';

export const TerminalOutputRenderer = memo(TerminalOutputRendererComponent);

export default TerminalOutputRenderer;
