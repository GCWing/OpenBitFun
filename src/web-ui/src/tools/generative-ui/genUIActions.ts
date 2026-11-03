import { defineAction, type ActionEvent } from '@openuidev/react-lang';
import { z } from 'zod/v4';

/**
 * Open Intelligent UI's small host action surface. Actions are deliberately
 * separate from pure library functions: they run only after a user gesture
 * and are delivered through the owning host callback.
 */
export const copyToClipboardAction = defineAction({
  name: 'CopyToClipboard',
  description: 'Copy text to the clipboard, for example a list built with @Join',
  params: z.object({ text: z.string() }),
});

export const genUIActions = [copyToClipboardAction];

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the compatibility path used by WebViews without the
    // Clipboard API or without a secure origin.
  }
  const textarea = document.createElement('textarea');
  try {
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(textarea);
    textarea.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

/** Runs a product action and returns null for actions owned by the caller. */
export function runGenUIAction(event: Pick<ActionEvent, 'type' | 'params'>): Promise<boolean> | null {
  if (event.type !== copyToClipboardAction.name) return null;
  const text = event.params?.text;
  return typeof text === 'string' ? copyText(text) : Promise.resolve(false);
}
