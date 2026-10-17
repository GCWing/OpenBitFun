/**
 * Registers the Cangjie grammar on the lazily loaded Prism highlighter.
 *
 * Markdown code fences are rendered by `react-syntax-highlighter`'s
 * `prism-async-light`, which only knows the languages listed in its own
 * refractor loader map. Cangjie is not one of them, and unknown languages
 * degrade to plain text, so the grammar built for the editor is registered on
 * the loaded instance instead of adding a dependency on refractor.
 */

import { createLogger } from '@/shared/utils/logger';
import { cangjiePrismGrammar } from '@/tools/editor/languages/cangjie.language';

const log = createLogger('cangjiePrismLanguage');

interface AsyncHighlighterRegistrar {
  registerLanguage?: (name: string, grammar: unknown) => void;
}

const PRISM_LANGUAGE_ID = 'cangjie';
let registered = false;

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
    registerLanguage.call(highlighter, PRISM_LANGUAGE_ID, cangjiePrismGrammar);
    registered = true;
  } catch (error) {
    log.warn('Failed to register Cangjie Prism grammar', error);
  }
}
