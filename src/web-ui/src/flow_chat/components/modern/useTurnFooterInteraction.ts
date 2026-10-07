import { useLayoutEffect, useMemo, type FocusEvent } from 'react';
import { useFlowChatReaderStore } from '../../timeline/readerState';

/** Release each row's leases on recycling, session switching, and pointer/focus exit. */
export function useTurnFooterInteraction(turnId: string) {
  const reader = useFlowChatReaderStore();
  const interaction = useMemo(() => {
    let releasePointer: (() => void) | undefined;
    let releaseFocus: (() => void) | undefined;
    const leavePointer = () => { releasePointer?.(); releasePointer = undefined; };
    const leaveFocus = () => { releaseFocus?.(); releaseFocus = undefined; };
    return {
      handlers: {
        onPointerEnter: () => { releasePointer ??= reader?.holdTurnInteraction(turnId); },
        onPointerLeave: leavePointer,
        onFocusCapture: () => { releaseFocus ??= reader?.holdTurnInteraction(turnId); },
        onBlurCapture: (event: FocusEvent<HTMLDivElement>) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) leaveFocus();
        },
      },
      dispose: () => { leavePointer(); leaveFocus(); },
    };
  }, [reader, turnId]);
  useLayoutEffect(() => interaction.dispose, [interaction]);
  return interaction.handlers;
}
