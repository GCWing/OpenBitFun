import { getAdditionalModePromptReferenceMatches } from './additionalModePromptReference';
import { getMcpPromptReferenceMatches } from './mcpPromptReference';
import { getSkillPromptReferenceMatches } from './skillPromptReference';
import { getWidgetPromptReferenceMatches } from '@/tools/generative-widget/widgetPromptReference';

/**
 * Composer clipboard payload.
 *
 * The user-visible flavor stays human readable, while the matching text/html
 * flavor carries the canonical editor text in an attribute. An in-app paste
 * rebuilds inline capsules (skill, widget, additional mode, MCP) from that
 * payload instead of leaving their source text behind.
 */

const CLIPBOARD_MARKER_ATTRIBUTE = 'data-openbitfun-composer-clipboard';
const CLIPBOARD_TOKEN_ATTRIBUTE = 'data-openbitfun-composer-clipboard-tokens';
const CLIPBOARD_PAYLOAD_VERSION = '1';

export interface ComposerInlineTokenMatch {
  token: string;
  start: number;
  end: number;
}

export interface ComposerClipboardPayload {
  /** Human-readable value read by other applications. */
  text: string;
  /** Canonical editor text used to rebuild capsules on an in-app paste. */
  tokens: string;
  /** Optional readable body for rich-text consumers. */
  body?: Node;
}

/** Inline token families the editor can render back into capsules. */
export function getComposerInlineTokenMatches(text: string): ComposerInlineTokenMatch[] {
  return [
    ...getWidgetPromptReferenceMatches(text),
    ...getSkillPromptReferenceMatches(text),
    ...getMcpPromptReferenceMatches(text),
    ...getAdditionalModePromptReferenceMatches(text),
  ]
    .map(match => ({ token: match.token, start: match.start, end: match.end }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
}

function buildPayloadHtml(payload: ComposerClipboardPayload): string {
  const container = document.createElement('div');
  container.setAttribute(CLIPBOARD_MARKER_ATTRIBUTE, CLIPBOARD_PAYLOAD_VERSION);
  container.setAttribute(CLIPBOARD_TOKEN_ATTRIBUTE, payload.tokens);
  if (payload.body) {
    container.appendChild(payload.body);
    return container.outerHTML;
  }

  // Keep the readable line structure for rich-text consumers.
  payload.text.split('\n').forEach((line, index) => {
    if (index > 0) container.appendChild(document.createElement('br'));
    container.appendChild(document.createTextNode(line));
  });
  return container.outerHTML;
}

/**
 * Reads the canonical text of an in-app payload. Foreign HTML is ignored and
 * never inserted into the editor.
 */
export function readComposerClipboardTokens(html: string): string | null {
  if (!html || !html.includes(CLIPBOARD_MARKER_ATTRIBUTE)) {
    return null;
  }

  const template = document.createElement('template');
  template.innerHTML = html;
  const payload = template.content.querySelector(`[${CLIPBOARD_MARKER_ATTRIBUTE}]`);
  return payload?.getAttribute(CLIPBOARD_TOKEN_ATTRIBUTE) ?? null;
}

/** Writes both clipboard flavors from a synchronous copy event. */
export function writeComposerClipboardData(
  clipboardData: DataTransfer,
  payload: ComposerClipboardPayload,
): boolean {
  try {
    clipboardData.setData('text/plain', payload.text);
    clipboardData.setData('text/html', buildPayloadHtml(payload));
    return true;
  } catch {
    return false;
  }
}

/** Writes both clipboard flavors, falling back to plain text where unsupported. */
export async function writeComposerClipboardPayload(
  payload: ComposerClipboardPayload,
): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function') {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([payload.text], { type: 'text/plain' }),
          'text/html': new Blob([buildPayloadHtml(payload)], { type: 'text/html' }),
        }),
      ]);
      return;
    } catch {
      // Fall through so the copy still lands as plain text.
    }
  }

  await navigator.clipboard.writeText(payload.text);
}
