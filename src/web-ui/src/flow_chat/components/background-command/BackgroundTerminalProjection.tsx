import { useId, useLayoutEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { xtermAppearanceAdapter } from '@/infrastructure/appearance/adapters/XtermAppearanceAdapter';
import { registerTerminalActions, unregisterTerminalActions } from '@/tools/terminal/services/TerminalActionManager';
import {
  readTerminalOutputFontFamily, TERMINAL_OUTPUT_FONT_SIZE, TERMINAL_OUTPUT_FONT_WEIGHT,
  TERMINAL_OUTPUT_FONT_WEIGHT_BOLD, TERMINAL_OUTPUT_LINE_HEIGHT,
} from '@/tools/terminal/components/terminalOutputPresentation';
import type { TerminalProjection } from './backgroundTerminalReplay';
import { fitProjectionRows } from './terminalProjectionGeometry';
import '@xterm/xterm/css/xterm.css';

/** Displays only parsed cells and SGR styles, never source cursor instructions. */
export default function BackgroundTerminalProjection({ projection }: {
  projection: TerminalProjection;
}) {
  const id = useId();
  const terminalId = `background-output-${id}`;
  const host = useRef<HTMLDivElement>(null);
  const paint = useRef<() => void>(() => {});
  const current = useRef(projection);
  current.current = projection;

  useLayoutEffect(() => {
    const element = host.current!;
    const terminal = new Terminal({
      disableStdin: true, cursorBlink: false, cursorInactiveStyle: 'none',
      fontFamily: readTerminalOutputFontFamily(), fontSize: TERMINAL_OUTPUT_FONT_SIZE,
      fontWeight: TERMINAL_OUTPUT_FONT_WEIGHT, fontWeightBold: TERMINAL_OUTPUT_FONT_WEIGHT_BOLD,
      lineHeight: TERMINAL_OUTPUT_LINE_HEIGHT, scrollback: 5000, convertEol: true,
      theme: xtermAppearanceAdapter.getColors('output'),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    registerTerminalActions(terminalId, { getTerminal: () => terminal, isReadOnly: true });
    let disposed = false;
    let writing = false;
    let pending = false;
    let frame = 0;
    let lastContent = '';
    let lastCols = 0;
    const render = () => {
      if (disposed) return;
      if (writing) { pending = true; return; }
      const snapshot = current.current;
      // Leave the trailing reset out of the append comparison. It belongs to
      // the snapshot boundary, not to the terminal's visible content.
      const content = snapshot.ansi.endsWith('\x1b[0m') ? snapshot.ansi.slice(0, -4) : snapshot.ansi;
      const cellWidth = terminal.dimensions?.css.cell.width ?? 0;
      element.style.minWidth = snapshot.screenCols && cellWidth
        ? `${Math.ceil(snapshot.screenCols * cellWidth + 16)}px` : '0';
      const dimensions = fit.proposeDimensions();
      if (!dimensions) return;
      const cols = snapshot.screenCols ?? dimensions.cols;
      const view = element.ownerDocument.defaultView!;
      const rows = fitProjectionRows(
        Number.parseFloat(view.getComputedStyle(element).height),
        terminal.dimensions?.device.cell.height ?? 0,
        view.devicePixelRatio,
      ) ?? dimensions.rows;
      const resized = terminal.cols !== cols || terminal.rows !== rows;
      if (resized) terminal.resize(cols, rows);
      if (content === lastContent && cols === lastCols) return;
      const follow = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
      const viewport = terminal.buffer.active.viewportY;
      writing = true;
      const append = lastContent.length > 0 && lastCols === cols && content.startsWith(lastContent);
      const update = append ? content.slice(lastContent.length) : `\x1bc${content}`;
      lastContent = content;
      lastCols = cols;
      // Reset and repaint are in the same write queue, so an old frame cannot
      // finish after a newer snapshot or leak cursor/style state into it.
      terminal.write(update, () => {
        writing = false;
        if (disposed) return;
        if (follow) terminal.scrollToBottom();
        else terminal.scrollToLine(viewport);
        if (pending) { pending = false; render(); }
      });
    };
    paint.current = render;
    const scheduleRender = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(render);
    };
    const observer = new ResizeObserver(scheduleRender);
    observer.observe(element);
    // Font/DPR changes can alter cell geometry without resizing the CSS host.
    const renderSubscription = terminal.onRender(scheduleRender);
    const unsubscribe = xtermAppearanceAdapter.subscribe(() => {
      terminal.options.theme = xtermAppearanceAdapter.getColors('output');
    });
    render();
    return () => {
      disposed = true;
      paint.current = () => {};
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderSubscription.dispose();
      unsubscribe();
      unregisterTerminalActions(terminalId);
      terminal.dispose();
    };
  }, [terminalId]);

  useLayoutEffect(() => { paint.current(); }, [projection]);

  return <div className="background-command-output-panel__projection"
    data-terminal-id={terminalId} data-readonly="true"
    data-openbitfun-component="background-command-output-panel" data-openbitfun-part="terminal">
    <div ref={host} className="background-command-output-panel__projection-host" />
  </div>;
}
