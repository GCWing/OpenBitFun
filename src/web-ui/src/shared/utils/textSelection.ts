 

import type { MouseEvent as ReactMouseEvent } from 'react';
import { writeNativeClipboardText } from '@/shared/utils/nativeClipboard';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('TextSelection');

export interface TextSelection {
  text: string;
  element: HTMLElement;
  range?: Range;
}

 
export const getSelectedText = (): TextSelection | null => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const text = range.toString().trim();
  
  if (!text) {
    return null;
  }

  const commonAncestor = range.commonAncestorContainer;
  const element = commonAncestor.nodeType === Node.ELEMENT_NODE 
    ? commonAncestor as HTMLElement 
    : commonAncestor.parentElement;

  if (!element) {
    return null;
  }

  return {
    text,
    element,
    range
  };
};

export const shouldIgnoreCardToggleClick = (
  event: ReactMouseEvent<Element>,
  root: HTMLElement | null = typeof HTMLElement !== 'undefined' && event.currentTarget instanceof HTMLElement
    ? event.currentTarget
    : null,
): boolean => {
  if (event.defaultPrevented || event.button !== 0) {
    return true;
  }

  const target = typeof Element !== 'undefined' && event.target instanceof Element ? event.target : null;
  if (target?.closest('button,a,input,textarea,select,[contenteditable="true"],[data-flow-card-ignore-toggle]')) {
    return true;
  }

  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) {
    return false;
  }

  if (!root) {
    return true;
  }

  const anchorInside = selection.anchorNode ? root.contains(selection.anchorNode) : false;
  const focusInside = selection.focusNode ? root.contains(selection.focusNode) : false;
  return anchorInside || focusInside;
};

 
export const clearSelection = (): void => {
  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
  }
};

 
export const copyTextToClipboard = async (text: string): Promise<boolean> => {
  if (await writeNativeClipboardText(text)) {
    return true;
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      // WebView clipboard permission can be denied even when the API exists.
      // Fall through to the selection-based copy path before reporting failure.
      log.warn('Clipboard API copy failed; trying fallback', error);
    }
  }

  const textArea = document.createElement('textarea');
  try {
    textArea.value = text;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    return document.execCommand('copy');
  } catch (error) {
    log.error('Failed to copy text to clipboard', error);
    return false;
  } finally {
    if (textArea.isConnected) {
      document.body.removeChild(textArea);
    }
  }
};

 
export const getElementText = (element: HTMLElement): string => {
  
  if (element.tagName === 'PRE' || element.tagName === 'CODE') {
    return element.textContent || '';
  }
  
  
  return element.innerText || element.textContent || '';
};

 
export const isInFlowChat = (element: HTMLElement): boolean => {
  return element.closest('.flow-chat-container') !== null;
};

 
export const getFlowChatContext = (element: HTMLElement) => {
  const flowChatContainer = element.closest('.flow-chat-container');
  if (!flowChatContainer) {
    return null;
  }

  const dialogTurn = element.closest('.flow-chat-dialog-turn');
  const modelRound = element.closest('.model-round');
  const textBlock = element.closest('.flow-text-block');
  const toolCard = element.closest('.flow-tool-card');
  const userMessage = element.closest('.user-message');

  return {
    container: flowChatContainer as HTMLElement,
    dialogTurn: dialogTurn as HTMLElement | null,
    modelRound: modelRound as HTMLElement | null,
    textBlock: textBlock as HTMLElement | null,
    toolCard: toolCard as HTMLElement | null,
    userMessage: userMessage as HTMLElement | null
  };
};
