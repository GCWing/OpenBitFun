/**
 * Registers the Cangjie grammar on the lazily loaded Prism highlighter.
 *
 * Markdown code fences are rendered by `react-syntax-highlighter`'s
 * `prism-async-light`, which only knows the languages listed in its own
 * refractor loader map. Cangjie is not one of them, and unknown languages
 * degrade to plain text, so the grammar built for the editor is registered on
 * the loaded instance instead of adding a dependency on refractor.
 */

import type * as Prism from 'prismjs';
import { createLogger } from '@/shared/utils/logger';
import { cangjiePrismGrammar } from '@/tools/editor/languages/cangjie.language';

const log = createLogger('cangjiePrismLanguage');

interface AsyncHighlighterRegistrar {
  registerLanguage?: (name: string, grammar: typeof registerCangjiePrismGrammar) => void;
}

const PRISM_LANGUAGE_ID = 'cangjie';
let registered = false;

// Refractor accepts language modules, rather than Prism grammar objects.
function registerCangjiePrismGrammar(prism: typeof Prism): void {
  prism.languages[PRISM_LANGUAGE_ID] = cangjiePrismGrammar;
}
registerCangjiePrismGrammar.displayName = PRISM_LANGUAGE_ID;

/** Idempotently register the Cangjie Prism grammar on a loaded highlighter. */
export function ensureCangjiePrismLanguage(highlighter: unknown): void {
  if (registered) {
    return;
  }

  const registerLanguage = (highlighter as AsyncHighlighterRegistrar | null | undefined)?.registerLanguage;
  if (typeof registerLanguage !== 'function') {
    log.warn('Prism highlighter does not expose registerLanguage; Cangjie fences stay plain');
    return;
  }

  try {
    registerLanguage.call(highlighter, PRISM_LANGUAGE_ID, registerCangjiePrismGrammar);
    registered = true;
  } catch (error) {
    log.warn('Failed to register Cangjie Prism grammar', error);
  }
}
