import type { TerminalOutputHost } from '@openbitfun/flow-chat-presentation/terminal';
import { xtermAppearanceAdapter } from '@/infrastructure/appearance/adapters/XtermAppearanceAdapter';
import { fontPreferenceService } from '@/infrastructure/font-preference';
import { registerTerminalActions, unregisterTerminalActions } from '../services/TerminalActionManager';

export const terminalOutputHost: TerminalOutputHost = {
  getColors: () => xtermAppearanceAdapter.getColors('output'),
  subscribe(listener) {
    const unsubscribeAppearance = xtermAppearanceAdapter.subscribe(listener);
    const unsubscribeFont = fontPreferenceService.on('font:after-change', listener);
    return () => { unsubscribeAppearance(); unsubscribeFont(); };
  },
  registerActions(id, getTerminal) {
    registerTerminalActions(id, { getTerminal, isReadOnly: true });
    return () => unregisterTerminalActions(id);
  },
};
