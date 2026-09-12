/**
 * Rich text input component.
 * Supports inline context tags and the @ chat context picker trigger.
 */

import { Button, Dialog, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogHeading, DialogTitle, Icon, Textarea } from '@openbitfun/ui';
import React, { useRef, useEffect, useCallback, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageCircle, Plug } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ContextItem } from '../../shared/types/context';
import { getRichTextExternalSyncAction } from './richTextInputSync';
import {
  getWidgetPromptReferenceMatches,
  parseWidgetPromptReferenceToken,
} from '@/tools/generative-widget/widgetPromptReference';
import {
  getSkillPromptReferenceMatches,
  parseSkillPromptReferenceToken,
} from '../utils/skillPromptReference';
import { getMcpPromptReferenceMatches, parseMcpPromptReference } from '../utils/mcpPromptReference';
import {
  getAdditionalModePromptReferenceMatches,
  parseAdditionalModePromptReferenceToken,
} from '../utils/additionalModePromptReference';
import {
  appendComposerTextSegment,
  COMPOSER_PRESENTATION_VERSION,
  type ComposerPresentation,
  type ComposerPresentationSegment,
} from '../utils/composerPresentation';
import './RichTextInput.scss';

const SKILL_REFERENCE_BADGE_ICON = renderToStaticMarkup(
  <Icon name="extension" size="xs" aria-hidden="true" />,
);
const SESSION_REFERENCE_BADGE_ICON = renderToStaticMarkup(
  <MessageCircle size={12} strokeWidth={2.2} aria-hidden="true" />,
);
const MCP_REFERENCE_BADGE_ICON = renderToStaticMarkup(
  <Plug size={12} strokeWidth={2.2} aria-hidden="true" />,
);
const EMPTY_PENDING_LARGE_PASTES: Record<string, string> = Object.freeze({});
const LARGE_PASTE_CARET_ANCHOR = '\u200B';

function getEditorBoundaryOffset(editor: HTMLElement, container: Node, offset: number): number | null {
  if (container === editor) {
    return offset >= 0 && offset <= editor.childNodes.length ? offset : null;
  }
  if (container.parentNode !== editor || container.nodeType !== Node.TEXT_NODE) {
    return null;
  }
  const childIndex = Array.prototype.indexOf.call(editor.childNodes, container) as number;
  if (childIndex < 0) return null;
  if (offset === 0) return childIndex;
  if (offset === (container.textContent?.length ?? 0)) return childIndex + 1;
  return null;
}

function normalizeEquivalentCaretRange(editor: HTMLElement, range: Range): Range {
  if (range.collapsed) return range;
  const startOffset = getEditorBoundaryOffset(editor, range.startContainer, range.startOffset);
  const endOffset = getEditorBoundaryOffset(editor, range.endContainer, range.endOffset);
  if (startOffset === null || startOffset !== endOffset) return range;
  const caretRange = editor.ownerDocument.createRange();
  caretRange.setStart(editor, startOffset);
  caretRange.collapse(true);
  return caretRange;
}

/** State of the @ trigger that opens the chat context picker. */
export interface ContextTriggerState {
  isActive: boolean;
  query: string;
  startOffset: number;
}

export interface InlineTriggerState {
  isActive: boolean;
  trigger: '/' | '$' | null;
  query: string;
  startOffset: number;
}

export type RichTextInputElement = HTMLDivElement & {
  getComposerPresentation?: () => ComposerPresentation | null;
  restoreComposerPresentation?: (presentation: ComposerPresentation) => void;
  insertTag?: (context: ContextItem) => void;
  insertContextTagReplacingTrigger?: (context: ContextItem) => void;
  replaceActiveContextTrigger?: (replacementText: string) => void;
  replaceActiveInlineTrigger?: (replacementText: string) => void;
  appendInlineTokenAtEnd?: (token: string) => void;
  openContextPicker?: () => void;
  closeContextPicker?: () => void;
  closeInlineTrigger?: () => void;
};

export interface ClipboardFilePaste {
  fallbackImages: File[];
  hasNonImageFiles: boolean;
}

export interface RichTextInputProps
  extends Omit<
    React.HTMLAttributes<HTMLDivElement>,
    'onChange' | 'onFocus' | 'onBlur' | 'onCompositionStart' | 'onCompositionEnd'
  > {
  value: string;
  onChange: (value: string, contexts: ContextItem[]) => void;
  onLargePaste?: (text: string) => string | null;
  onPasteFiles?: (paste: ClipboardFilePaste) => void | Promise<void>;
  pendingLargePastes?: Record<string, string>;
  skillReferenceNames?: Readonly<Record<string, string>>;
  onUpdateLargePaste?: (placeholder: string, text: string) => string;
  onRemoveLargePaste?: (placeholder: string) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  onCompositionStart?: () => void;
  onCompositionEnd?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  contexts: ContextItem[];
  onRemoveContext: (id: string) => void;
  /** Callback when the @ context-picker trigger changes. */
  onContextTriggerStateChange?: (state: ContextTriggerState) => void;
  /** Callback when inline trigger state changes for / or $ */
  onInlineTriggerStateChange?: (state: InlineTriggerState) => void;
}

function isWhitespaceCharacter(char: string | undefined): boolean {
  return !char || /\s/.test(char);
}

function trimEdgeLineBreaks(text: string): string {
  return text.replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, '');
}

function getContextDisplayName(context: ContextItem): string {
  switch (context.type) {
    case 'file': return context.fileName;
    case 'directory': return context.directoryName;
    case 'session-reference': return context.sessionName;
    case 'code-snippet': return `${context.fileName}:${context.startLine}-${context.endLine}`;
    case 'pull-request': return context.label;
    case 'image': return context.imageName;
    case 'terminal-command': return context.command;
    case 'git-ref': return context.refValue;
    case 'url': return context.title || context.url;
    case 'mermaid-node': return context.nodeText;
    case 'mermaid-diagram': return context.diagramTitle || 'Mermaid diagram';
    case 'web-element': {
      const label = typeof context.metadata?.label === 'string' ? context.metadata.label.trim() : '';
      return label || context.textContent || context.tagName;
    }
    default: {
      const exhaustive: never = context;
      return String(exhaustive);
    }
  }
}

function getContextTagFormat(context: ContextItem): string {
  switch (context.type) {
    case 'file': return `#file:${context.fileName}`;
    case 'directory': return `#dir:${context.directoryName}`;
    case 'session-reference': return `[session: ${context.sessionName}]`;
    case 'code-snippet': return `#code:${context.fileName}:${context.startLine}-${context.endLine}`;
    case 'pull-request': return `#pr:${context.label.replace(/\s+/g, '_')}`;
    case 'image': return `#img:${context.imageName}`;
    case 'terminal-command': return `#cmd:${context.command}`;
    case 'git-ref': return `#git:${context.refValue}`;
    case 'url': return `#link:${context.title || context.url}`;
    case 'mermaid-node': return `#chart:${context.nodeText}`;
    case 'mermaid-diagram': return `#mermaid:${context.diagramTitle || 'Mermaid diagram'}`;
    case 'web-element': {
      const label = typeof context.metadata?.label === 'string' ? context.metadata.label.trim() : context.tagName;
      return `#element:${label.replace(/\s+/g, '_')}`;
    }
    default: {
      const exhaustive: never = context;
      return String(exhaustive);
    }
  }
}

function getContextFullPath(context: ContextItem): string {
  switch (context.type) {
    case 'file':
      return context.filePath;
    case 'directory':
      return context.directoryPath + (context.recursive ? ' (recursive)' : '');
    case 'session-reference':
      return `${context.workspaceLabel} · ${context.workspacePath}`;
    case 'code-snippet':
      return `${context.filePath} (lines ${context.startLine}-${context.endLine})`;
    case 'pull-request':
      return [
        context.repository,
        context.remoteId ? `remote:${context.remoteId}` : null,
        context.pullRequestNumber ? `PR #${context.pullRequestNumber}` : null,
        context.section,
        context.sourceUrl,
      ].filter(Boolean).join(' · ') || context.label;
    case 'image':
      return context.imagePath;
    case 'terminal-command':
      return context.workingDirectory ? `${context.command} @ ${context.workingDirectory}` : context.command;
    case 'git-ref':
      return `Git ${context.refType}: ${context.refValue}`;
    case 'url':
      return context.url;
    case 'mermaid-node':
      return context.diagramTitle ? `${context.diagramTitle} - ${context.nodeText}` : context.nodeText;
    case 'mermaid-diagram':
      return `Mermaid diagram${context.diagramTitle ? ': ' + context.diagramTitle : ''} (${context.diagramCode.length} chars)`;
    case 'web-element':
      return context.sourceUrl ? `${context.sourceUrl} · ${context.path}` : context.path;
    default: {
      const exhaustive: never = context;
      return String(exhaustive);
    }
  }
}

export const RichTextInput = React.forwardRef<HTMLDivElement, RichTextInputProps>(({
  value,
  onChange,
  onLargePaste,
  onPasteFiles,
  pendingLargePastes = EMPTY_PENDING_LARGE_PASTES,
  skillReferenceNames,
  onUpdateLargePaste,
  onRemoveLargePaste,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  onFocus,
  onBlur,
  placeholder = 'Describe your request...',
  disabled = false,
  className = '',
  contexts,
  onRemoveContext,
  onContextTriggerStateChange,
  onInlineTriggerStateChange,
  ...restProps
}, ref) => {
  const { t } = useTranslation('flow-chat');
  const editorRef = useRef<HTMLDivElement>(null);
  const largePasteTextareaRef = useRef<HTMLTextAreaElement>(null);
  const largePasteValuesRef = useRef(pendingLargePastes);
  largePasteValuesRef.current = pendingLargePastes;
  const internalRef = (ref as React.RefObject<HTMLDivElement>) || editorRef;
  const [isFocused, setIsFocused] = useState(false);
  const [activeLargePaste, setActiveLargePaste] = useState<{
    placeholder: string;
    sourceText: string;
    draft: string;
  } | null>(null);
  const [largePasteCopied, setLargePasteCopied] = useState(false);
  const isComposingRef = useRef(false);
  const lastContextIdsRef = useRef<Set<string>>(new Set());
  const contextTriggerStateRef = useRef<ContextTriggerState>({ isActive: false, query: '', startOffset: 0 });
  const inlineTriggerStateRef = useRef<InlineTriggerState>({
    isActive: false,
    trigger: null,
    query: '',
    startOffset: 0,
  });
  const triggerSyncRef = useRef<(() => void) | null>(null);

  const closeContextPicker = useCallback(() => {
    if (!contextTriggerStateRef.current.isActive) {
      return;
    }

    contextTriggerStateRef.current = { isActive: false, query: '', startOffset: 0 };
    onContextTriggerStateChange?.({ isActive: false, query: '', startOffset: 0 });
  }, [onContextTriggerStateChange]);

  const closeInlineTrigger = useCallback(() => {
    if (!inlineTriggerStateRef.current.isActive) {
      return;
    }

    inlineTriggerStateRef.current = {
      isActive: false,
      trigger: null,
      query: '',
      startOffset: 0,
    };
    onInlineTriggerStateChange?.({
      isActive: false,
      trigger: null,
      query: '',
      startOffset: 0,
    });
  }, [onInlineTriggerStateChange]);

  // Create tag element with pill style
  const createTagElement = useCallback((context: ContextItem): HTMLSpanElement => {
    const tag = document.createElement('span');
    tag.className = 'rich-text-tag-pill';
    tag.dataset.openbitfunComponent = 'rich-text-input';
    tag.dataset.openbitfunPart = 'contextTag';
    tag.dataset.openbitfunContextType = context.type;
    tag.contentEditable = 'false';
    tag.dataset.contextId = context.id;
    tag.dataset.contextType = context.type;
    // Store full tag format for text extraction
    tag.dataset.tagFormat = getContextTagFormat(context);
    tag.title = getContextFullPath(context);

    if (context.type === 'session-reference') {
      tag.classList.add('rich-text-tag-pill--session-reference');
      const badge = document.createElement('span');
      badge.className = 'rich-text-tag-pill__badge rich-text-tag-pill__badge--icon';
      badge.dataset.openbitfunComponent = 'rich-text-input';
      badge.dataset.openbitfunPart = 'tagBadge';
      badge.innerHTML = SESSION_REFERENCE_BADGE_ICON;
      tag.appendChild(badge);
    }
    
    const text = document.createElement('span');
    text.className = 'rich-text-tag-pill__text';
    text.dataset.openbitfunComponent = 'rich-text-input';
    text.dataset.openbitfunPart = 'tagText';
    // Show name only, no # prefix
    text.textContent = getContextDisplayName(context);
    
    const remove = document.createElement('button');
    remove.className = 'rich-text-tag-pill__remove';
    remove.dataset.openbitfunComponent = 'rich-text-input';
    remove.dataset.openbitfunPart = 'tagRemove';
    remove.textContent = '×';
    remove.title = 'Remove';
    remove.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      onRemoveContext(context.id);
    };
    
    tag.appendChild(text);
    tag.appendChild(remove);
    
    return tag;
  }, [onRemoveContext]);

  const removeInlineTokenElement = useCallback((element: HTMLElement) => {
    const nextSibling = element.nextSibling;
    if (
      nextSibling
      && nextSibling.nodeType === Node.TEXT_NODE
      && (nextSibling.textContent === ' ' || nextSibling.textContent === LARGE_PASTE_CARET_ANCHOR)
    ) {
      nextSibling.remove();
    }
    element.remove();
  }, []);

  const createLargePasteElement = useCallback((placeholder: string): HTMLSpanElement => {
    const capsule = document.createElement('span');
    capsule.className = 'rich-text-large-paste';
    capsule.contentEditable = 'false';
    capsule.setAttribute('contenteditable', 'false');
    capsule.dataset.openbitfunComponent = 'rich-text-input';
    capsule.dataset.openbitfunPart = 'contextTag';
    capsule.dataset.openbitfunContextType = 'large-paste';
    capsule.dataset.largePastePlaceholder = placeholder;
    capsule.dataset.tagFormat = placeholder;
    capsule.tabIndex = 0;
    capsule.setAttribute('role', 'button');
    capsule.setAttribute('aria-label', t('input.largePasteOpen', { placeholder }));

    const label = document.createElement('span');
    label.className = 'rich-text-large-paste__label';
    label.textContent = placeholder;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'rich-text-large-paste__remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', t('input.largePasteRemove'));
    remove.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      onRemoveLargePaste?.(placeholder);
      removeInlineTokenElement(capsule);
      triggerSyncRef.current?.();
    };

    const open = () => {
      const text = largePasteValuesRef.current[placeholder];
      if (text === undefined) return;
      setLargePasteCopied(false);
      setActiveLargePaste({ placeholder, sourceText: text, draft: text });
    };
    capsule.onclick = open;
    capsule.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    };
    capsule.append(label, remove);
    return capsule;
  }, [onRemoveLargePaste, removeInlineTokenElement, t]);

  const createWidgetReferenceElement = useCallback((token: string): HTMLSpanElement | null => {
    const payload = parseWidgetPromptReferenceToken(token);
    if (!payload) {
      return null;
    }

    const tag = document.createElement('span');
    tag.className = 'rich-text-tag-pill rich-text-tag-pill--widget-ref';
    tag.dataset.openbitfunComponent = 'rich-text-input';
    tag.dataset.openbitfunPart = 'contextTag';
    tag.dataset.openbitfunContextType = 'widget-reference';
    tag.contentEditable = 'false';
    tag.dataset.tagFormat = token;
    tag.dataset.inlineTokenType = 'widget-ref';
    tag.title = payload.promptText;

    const badge = document.createElement('span');
    badge.className = 'rich-text-tag-pill__badge';
    badge.dataset.openbitfunComponent = 'rich-text-input';
    badge.dataset.openbitfunPart = 'tagBadge';
    badge.textContent = 'UI';

    const text = document.createElement('span');
    text.className = 'rich-text-tag-pill__text rich-text-tag-pill__text--widget-ref';
    text.dataset.openbitfunComponent = 'rich-text-input';
    text.dataset.openbitfunPart = 'tagText';
    text.textContent = payload.displayText;

    const remove = document.createElement('button');
    remove.className = 'rich-text-tag-pill__remove';
    remove.dataset.openbitfunComponent = 'rich-text-input';
    remove.dataset.openbitfunPart = 'tagRemove';
    remove.textContent = '×';
    remove.title = 'Remove';
    remove.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeInlineTokenElement(tag);
      requestAnimationFrame(() => {
        internalRef.current?.focus();
        triggerSyncRef.current?.();
      });
    };

    tag.appendChild(badge);
    tag.appendChild(text);
    tag.appendChild(remove);

    return tag;
  }, [internalRef, removeInlineTokenElement]);

  const createSkillStyledReferenceElement = useCallback((options: {
    token: string;
    contextType: 'skill-reference' | 'additional-mode-reference' | 'mcp-reference';
    inlineTokenType: 'skill-ref' | 'additional-mode-ref' | 'mcp-ref';
    title: string;
    displayText: string;
    modifierClass?: string;
    badgeIcon?: string;
  }): HTMLSpanElement => {
    const tag = document.createElement('span');
    tag.className = [
      'rich-text-tag-pill',
      'rich-text-tag-pill--skill-ref',
      options.modifierClass,
    ].filter(Boolean).join(' ');
    tag.dataset.openbitfunComponent = 'rich-text-input';
    tag.dataset.openbitfunPart = 'contextTag';
    tag.dataset.openbitfunContextType = options.contextType;
    tag.contentEditable = 'false';
    tag.setAttribute('contenteditable', 'false');
    tag.dataset.tagFormat = options.token;
    tag.dataset.inlineTokenType = options.inlineTokenType;
    tag.title = options.title;

    const badge = document.createElement('span');
    badge.className = 'rich-text-tag-pill__badge rich-text-tag-pill__badge--icon';
    badge.dataset.openbitfunComponent = 'rich-text-input';
    badge.dataset.openbitfunPart = 'tagBadge';
    badge.innerHTML = options.badgeIcon ?? SKILL_REFERENCE_BADGE_ICON;

    const text = document.createElement('span');
    text.className = 'rich-text-tag-pill__text rich-text-tag-pill__text--skill-ref';
    text.dataset.openbitfunComponent = 'rich-text-input';
    text.dataset.openbitfunPart = 'tagText';
    text.textContent = options.displayText;

    const remove = document.createElement('button');
    remove.className = 'rich-text-tag-pill__remove';
    remove.dataset.openbitfunComponent = 'rich-text-input';
    remove.dataset.openbitfunPart = 'tagRemove';
    remove.textContent = '×';
    remove.title = 'Remove';
    remove.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeInlineTokenElement(tag);
      requestAnimationFrame(() => {
        internalRef.current?.focus();
        triggerSyncRef.current?.();
      });
    };

    tag.appendChild(badge);
    tag.appendChild(text);
    tag.appendChild(remove);

    return tag;
  }, [internalRef, removeInlineTokenElement]);

  const createSkillReferenceElement = useCallback((token: string): HTMLSpanElement | null => {
    const payload = parseSkillPromptReferenceToken(token);
    return payload
      ? createSkillStyledReferenceElement({
          token,
          contextType: 'skill-reference',
          inlineTokenType: 'skill-ref',
          title: '',
          displayText: (payload.skillKey && skillReferenceNames?.[payload.skillKey]) || payload.skillName,
        })
      : null;
  }, [createSkillStyledReferenceElement, skillReferenceNames]);

  const createAdditionalModeReferenceElement = useCallback((token: string): HTMLSpanElement | null => {
    const payload = parseAdditionalModePromptReferenceToken(token);
    return payload
      ? createSkillStyledReferenceElement({
          token,
          contextType: 'additional-mode-reference',
          inlineTokenType: 'additional-mode-ref',
          title: `Additional mode: ${payload.displayText}`,
          displayText: payload.displayText,
          modifierClass: 'rich-text-tag-pill--additional-mode-ref',
        })
      : null;
  }, [createSkillStyledReferenceElement]);

  const createMcpReferenceElement = useCallback((token: string): HTMLSpanElement | null => {
    const payload = parseMcpPromptReference(token);
    return payload ? createSkillStyledReferenceElement({
      token,
      contextType: 'mcp-reference',
      inlineTokenType: 'mcp-ref',
      displayText: payload.serverName,
      title: `MCP: ${payload.serverName}`,
      modifierClass: 'rich-text-tag-pill--mcp-ref',
      badgeIcon: MCP_REFERENCE_BADGE_ICON,
    }) : null;
  }, [createSkillStyledReferenceElement]);

  const createInlineTokenElement = useCallback((token: string): HTMLSpanElement | null => {
    return createWidgetReferenceElement(token)
      ?? createAdditionalModeReferenceElement(token)
      ?? createMcpReferenceElement(token)
      ?? createSkillReferenceElement(token);
  }, [createAdditionalModeReferenceElement, createMcpReferenceElement, createSkillReferenceElement, createWidgetReferenceElement]);

  const buildComposerPresentation = useCallback((): ComposerPresentation | null => {
    const editor = internalRef.current;
    if (!editor) {
      return null;
    }

    const contextsById = new Map(contexts.map(context => [context.id, context]));
    const segments: ComposerPresentationSegment[] = [];
    const appendText = (text: string) => appendComposerTextSegment(segments, sanitizeText(text));
    const traverse = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        appendText(node.textContent || '');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        return;
      }

      const element = node as HTMLElement;
      const isBlock = element.tagName === 'DIV' || element.tagName === 'P';
      const previous = segments[segments.length - 1];
      if (isBlock && segments.length > 0 && !(previous?.kind === 'text' && previous.text.endsWith('\n'))) {
        appendText('\n');
      }

      const largePastePlaceholder = element.dataset.largePastePlaceholder;
      if (largePastePlaceholder) {
        appendText(largePastePlaceholder);
        return;
      }

      const contextId = element.dataset.contextId;
      if (contextId) {
        const context = contextsById.get(contextId);
        if (context && context.type !== 'image') {
          segments.push({
            kind: 'context',
            context,
            tag: getContextTagFormat(context),
            label: getContextDisplayName(context),
            title: getContextFullPath(context),
          });
          return;
        }
        appendText(element.dataset.tagFormat || '');
        return;
      }

      const inlineToken = element.dataset.inlineTokenType;
      const token = element.dataset.tagFormat;
      if (inlineToken && token) {
        if (parseMcpPromptReference(token)) {
          // Preserve the existing text wire shape so older hosts can read it.
          appendText(token);
          return;
        }
        const additionalMode = parseAdditionalModePromptReferenceToken(token);
        if (additionalMode) {
          appendText(token);
          return;
        }
        const skill = parseSkillPromptReferenceToken(token);
        if (skill) {
          segments.push({
            kind: 'inline-token',
            token,
            tokenType: 'skill',
            label: element.querySelector('[data-openbitfun-part="tagText"]')?.textContent || skill.skillName,
          });
          return;
        }
        const widget = parseWidgetPromptReferenceToken(token);
        if (widget) {
          segments.push({
            kind: 'inline-token',
            token,
            tokenType: 'widget',
            label: widget.displayText,
          });
          return;
        }
      }

      if (element.tagName === 'BR') {
        appendText('\n');
        return;
      }
      node.childNodes.forEach(traverse);
    };

    editor.childNodes.forEach(traverse);
    return {
      version: COMPOSER_PRESENTATION_VERSION,
      segments,
    };
  }, [contexts, internalRef]);

  const restoreComposerPresentation = useCallback((presentation: ComposerPresentation) => {
    const editor = internalRef.current;
    if (!editor || presentation.version !== COMPOSER_PRESENTATION_VERSION) {
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const segment of presentation.segments) {
      if (segment.kind === 'text') {
        let cursor = 0;
        for (const match of getMcpPromptReferenceMatches(segment.text)) {
          fragment.appendChild(document.createTextNode(segment.text.slice(cursor, match.start)));
          fragment.appendChild(createMcpReferenceElement(match.token) ?? document.createTextNode(match.token));
          cursor = match.end;
        }
        fragment.appendChild(document.createTextNode(segment.text.slice(cursor)));
      } else if (segment.kind === 'context') {
        fragment.appendChild(createTagElement(segment.context));
      } else {
        fragment.appendChild(createInlineTokenElement(segment.token) ?? document.createTextNode(segment.token));
      }
    }
    editor.replaceChildren(fragment);

    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }, [createInlineTokenElement, createMcpReferenceElement, createTagElement, internalRef]);

  const renderValueWithInlineTokens = useCallback((editor: HTMLElement, text: string) => {
    const fragment = document.createDocumentFragment();
    const largePasteMatches = Object.keys(pendingLargePastes).flatMap((placeholder) => {
      const matches: Array<{
        start: number;
        end: number;
        token: string;
        kind: 'large-paste';
      }> = [];
      let start = text.indexOf(placeholder);
      while (start !== -1) {
        matches.push({
          start,
          end: start + placeholder.length,
          token: placeholder,
          kind: 'large-paste',
        });
        start = text.indexOf(placeholder, start + placeholder.length);
      }
      return matches;
    });
    const matches = [
      ...largePasteMatches,
      ...getWidgetPromptReferenceMatches(text).map(match => ({
        ...match,
        kind: 'widget-ref' as const,
      })),
      ...getSkillPromptReferenceMatches(text).map(match => ({
        ...match,
        kind: 'skill-ref' as const,
      })),
      ...getMcpPromptReferenceMatches(text).map(match => ({
        ...match,
        kind: 'mcp-ref' as const,
      })),
      ...getAdditionalModePromptReferenceMatches(text).map(match => ({
        ...match,
        kind: 'additional-mode-ref' as const,
      })),
    ].sort((a, b) => a.start - b.start || b.end - a.end);

    if (matches.length === 0) {
      editor.textContent = text;
      return;
    }

    let cursor = 0;
    for (const match of matches) {
      if (match.start < cursor) continue;
      if (match.start > cursor) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, match.start)));
      }

      const tokenElement = match.kind === 'large-paste'
        ? createLargePasteElement(match.token)
        : match.kind === 'widget-ref'
          ? createWidgetReferenceElement(match.token)
          : match.kind === 'additional-mode-ref'
            ? createAdditionalModeReferenceElement(match.token)
            : match.kind === 'mcp-ref'
              ? createMcpReferenceElement(match.token)
              : createSkillReferenceElement(match.token);
      fragment.appendChild(tokenElement ?? document.createTextNode(match.token));
      cursor = match.end;
    }

    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }

    editor.replaceChildren(fragment);
  }, [
    createAdditionalModeReferenceElement,
    createLargePasteElement,
    createMcpReferenceElement,
    createSkillReferenceElement,
    createWidgetReferenceElement,
    pendingLargePastes,
  ]);

  /** Map textContent offsets to a DOM Range to replace only the @ span. */
  const getRangeByTextOffsets = useCallback((root: Node, start: number, end: number): Range | null => {
    let current = 0;
    let startNode: Node | null = null;
    let startOffset = 0;
    let endNode: Node | null = null;
    let endOffset = 0;

    const walk = (node: Node): boolean => {
      if (node.nodeType === Node.TEXT_NODE) {
        const len = (node.textContent || '').length;
        if (startNode === null && start < current + len) {
          startNode = node;
          startOffset = Math.min(start - current, len);
        }
        if (endNode === null && end <= current + len) {
          endNode = node;
          endOffset = Math.min(end - current, len);
          return true;
        }
        current += len;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        for (const child of Array.from(node.childNodes)) {
          if (walk(child)) return true;
        }
      }
      return false;
    };
    walk(root);
    if (startNode && endNode) {
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      return range;
    }
    return null;
  }, []);

  function sanitizeText(text: string): string {
    // Strip zero-width and control characters that WebKit/WebView may inject
    // (e.g. from dead-key sequences, function keys, arrow keys, etc.)
    // Preserve normal whitespace: space (0x20), tab (0x09), newline (0x0A), carriage return (0x0D).
    // eslint-disable-next-line no-control-regex -- This intentionally removes specific ASCII control-character ranges.
    return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u200B-\u200F\u2028\u2029\uFEFF\u2060\u00AD]/g, '');
  }

  // Extract plain text including # tag format
  const extractTextContent = useCallback((): string => {
    if (!internalRef.current) return '';
    
    let text = '';
    const traverse = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent || '';
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as HTMLElement;
        
        const isBlock = element.tagName === 'DIV' || element.tagName === 'P';
        if (isBlock && text.length > 0 && !text.endsWith('\n')) {
          text += '\n';
        }
        
        // For tag elements, use the stored full format with # prefix
        if (element.hasAttribute('data-tag-format')) {
          const tagFormat = element.getAttribute('data-tag-format');
          if (tagFormat) {
            text += tagFormat;
          }
        } else if (element.tagName === 'BR') {
          text += '\n';
        } else {
          node.childNodes.forEach(traverse);
        }
      }
    };
    
    internalRef.current.childNodes.forEach(traverse);
    const sanitizedText = sanitizeText(text);
    const extractedText = sanitizedText.startsWith('/')
      ? trimEdgeLineBreaks(sanitizedText)
      : sanitizedText.trim();
    return extractedText;
  }, [internalRef]);

  // Detect the @ context trigger plus inline / and $ triggers near the caret.
  const detectActiveTrigger = useCallback(() => {
    if (!internalRef.current) return;
    
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      closeContextPicker();
      closeInlineTrigger();
      return;
    }
    
    const range = selection.getRangeAt(0);
    if (!range.collapsed) {
      closeContextPicker();
      closeInlineTrigger();
      return;
    }
    
    // Full editor text
    const fullText = internalRef.current.textContent || '';
    
    // Compute cursor position in full text
    let cursorPosition = 0;
    const traverseForPosition = (node: Node): boolean => {
      if (node === range.startContainer) {
        if (node.nodeType === Node.TEXT_NODE) {
          cursorPosition += range.startOffset;
        }
        return true;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        cursorPosition += (node.textContent || '').length;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        for (const child of Array.from(node.childNodes)) {
          if (traverseForPosition(child)) return true;
        }
      }
      return false;
    };
    
    traverseForPosition(internalRef.current);
    
    const textBeforeCursor = fullText.slice(0, cursorPosition);
    
    const candidates = ['@', '/', '$'] as const;
    let selectedTrigger: (typeof candidates)[number] | null = null;
    let selectedIndex = -1;

    for (const trigger of candidates) {
      const index = textBeforeCursor.lastIndexOf(trigger);
      if (index > selectedIndex) {
        selectedIndex = index;
        selectedTrigger = trigger;
      }
    }

    if (selectedTrigger !== null && selectedIndex !== -1) {
      const charBeforeTrigger = textBeforeCursor[selectedIndex - 1];
      const query = textBeforeCursor.slice(selectedIndex + 1);

      if (
        isWhitespaceCharacter(charBeforeTrigger) &&
        !query.includes(' ') &&
        !query.includes('\n')
      ) {
        if (selectedTrigger === '@') {
          const newState: ContextTriggerState = {
            isActive: true,
            query,
            startOffset: selectedIndex,
          };

          if (
            !contextTriggerStateRef.current.isActive ||
            contextTriggerStateRef.current.query !== query ||
            contextTriggerStateRef.current.startOffset !== selectedIndex
          ) {
            contextTriggerStateRef.current = newState;
            onContextTriggerStateChange?.(newState);
          }
          closeInlineTrigger();
          return;
        }

        closeContextPicker();
        const nextInlineTriggerState: InlineTriggerState = {
          isActive: true,
          trigger: selectedTrigger,
          query,
          startOffset: selectedIndex,
        };
        const currentInlineTriggerState = inlineTriggerStateRef.current;
        if (
          currentInlineTriggerState.isActive !== nextInlineTriggerState.isActive ||
          currentInlineTriggerState.trigger !== nextInlineTriggerState.trigger ||
          currentInlineTriggerState.query !== nextInlineTriggerState.query ||
          currentInlineTriggerState.startOffset !== nextInlineTriggerState.startOffset
        ) {
          inlineTriggerStateRef.current = nextInlineTriggerState;
          onInlineTriggerStateChange?.(nextInlineTriggerState);
        }
        return;
      }
    }

    closeContextPicker();
    closeInlineTrigger();
  }, [closeContextPicker, closeInlineTrigger, internalRef, onContextTriggerStateChange, onInlineTriggerStateChange]);

  /** Compute the cursor's character offset within the editor. */
  const getCursorOffset = useCallback((editor: HTMLElement): number => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return -1;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return -1;
    const preRange = document.createRange();
    preRange.selectNodeContents(editor);
    preRange.setEnd(range.startContainer, range.startOffset);
    return preRange.toString().length;
  }, []);

  /** Restore the cursor to a character offset within the editor. */
  const setCursorOffset = useCallback((editor: HTMLElement, offset: number) => {
    let remaining = offset;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const len = (node.textContent || '').length;
      if (remaining <= len) {
        const sel = window.getSelection();
        if (sel) {
          sel.collapse(node, remaining);
        }
        return;
      }
      remaining -= len;
    }
    // Offset past all text – place cursor at end
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }, []);

  const handleInput = useCallback(() => {
    if (isComposingRef.current) return;

    const editor = internalRef.current;

    // Scrub any invisible characters the browser may have inserted.
    // Save and restore the cursor (as a character offset) so cleaning
    // never disturbs the caret position.
    if (editor) {
      const cursorOffset = getCursorOffset(editor);
      let didClean = false;
      let removedBeforeCursor = 0;

      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let charsSoFar = 0;
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const original = node.textContent || '';
        const previousSibling = node.previousSibling;
        const preservesLargePasteCaretAnchor = original.startsWith(LARGE_PASTE_CARET_ANCHOR)
          && previousSibling instanceof HTMLElement
          && previousSibling.hasAttribute('data-large-paste-placeholder');
        const sanitizeNodeText = (value: string) => (
          preservesLargePasteCaretAnchor && value.startsWith(LARGE_PASTE_CARET_ANCHOR)
            ? `${LARGE_PASTE_CARET_ANCHOR}${sanitizeText(value.slice(1))}`
            : sanitizeText(value)
        );
        const cleaned = sanitizeNodeText(original);
        if (cleaned !== original) {
          // Count how many invisible chars were removed before the cursor
          if (cursorOffset >= 0) {
            if (cursorOffset > charsSoFar) {
              const relevantSlice = original.slice(0, Math.min(cursorOffset - charsSoFar, original.length));
              removedBeforeCursor += relevantSlice.length - sanitizeNodeText(relevantSlice).length;
            }
          }
          node.textContent = cleaned;
          didClean = true;
        }
        charsSoFar += original.length;
      }

      if (didClean && cursorOffset >= 0) {
        setCursorOffset(editor, Math.max(cursorOffset - removedBeforeCursor, 0));
      }
    }

    const textContent = extractTextContent();
    const visibleContextIds = new Set(
      Array.from(internalRef.current?.querySelectorAll<HTMLElement>('[data-context-id]') ?? [])
        .map(element => element.dataset.contextId)
        .filter((id): id is string => !!id)
    );
    const visibleContexts = contexts.filter(context => visibleContextIds.has(context.id));

    onChange(textContent, visibleContexts);
    
    // Ensure detection runs after DOM updates
    requestAnimationFrame(() => {
      detectActiveTrigger();
    });
  }, [contexts, detectActiveTrigger, extractTextContent, getCursorOffset, internalRef, onChange, setCursorOffset]);

  triggerSyncRef.current = handleInput;

  const handleBeforeInput = useCallback((e: React.FormEvent<HTMLDivElement>) => {
    const inputEvent = e.nativeEvent as InputEvent;
    const inputType = inputEvent.inputType;

    // Only act on insertText – block attempts to insert purely-invisible content.
    // We intentionally avoid a blanket whitelist so that we never accidentally
    // block browser-internal input types (cursor movement, spellcheck, etc.).
    if (inputType === 'insertText' && inputEvent.data != null) {
      const cleaned = sanitizeText(inputEvent.data);
      if (cleaned.length === 0) {
        e.preventDefault();
      }
    }
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    
    const items = Array.from(e.clipboardData.items);
    const containsFiles = items.some(item => item.kind === 'file')
      || Array.from(e.clipboardData.types ?? []).includes('Files');
    if (containsFiles) {
      const fallbackImages = items
        .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
        .map(item => item.getAsFile())
        .filter((file): file is File => Boolean(file));
      const hasNonImageFiles = items.some(
        item => item.kind === 'file' && !item.type.startsWith('image/'),
      );

      if (onPasteFiles) {
        void onPasteFiles({ fallbackImages, hasNonImageFiles });
      } else {
        // Preserve the standalone editor fallback when no host owns native
        // clipboard path resolution.
        for (const file of fallbackImages) {
          internalRef.current?.dispatchEvent(new CustomEvent('imagePaste', {
            detail: { file },
            bubbles: true,
          }));
        }
      }
      return;
    }
    
    // Plain text paste - close active triggers so pasted marker characters do not immediately reopen pickers
    closeContextPicker();
    closeInlineTrigger();
    
    const text = e.clipboardData.getData('text/plain');
    const largePastePlaceholder = onLargePaste?.(text);
    if (largePastePlaceholder && internalRef.current) {
      const selection = window.getSelection();
      const selectedRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const range = selectedRange && internalRef.current.contains(selectedRange.commonAncestorContainer)
        ? selectedRange
        : document.createRange();
      if (!selectedRange || !internalRef.current.contains(selectedRange.commonAncestorContainer)) {
        range.selectNodeContents(internalRef.current);
        range.collapse(false);
      }
      range.deleteContents();
      const capsule = createLargePasteElement(largePastePlaceholder);
      range.insertNode(capsule);
      // A caret placed directly between a non-editable inline capsule and the
      // trailing <br> is painted at the start of the visual line by Chromium.
      // Keep it inside a sanitized zero-width text anchor so its visual and
      // logical positions both remain after the capsule.
      const caretAnchor = document.createTextNode(LARGE_PASTE_CARET_ANCHOR);
      capsule.after(caretAnchor);
      range.setStart(caretAnchor, caretAnchor.length);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
      handleInput();
    } else {
      document.execCommand('insertText', false, text);
    }
    
    // Mark that we just pasted to prevent trigger detection in the next input event
    isComposingRef.current = true;
    requestAnimationFrame(() => {
      isComposingRef.current = false;
    });
  }, [closeContextPicker, closeInlineTrigger, createLargePasteElement, handleInput, internalRef, onLargePaste, onPasteFiles]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const nativeEvent = e.nativeEvent as KeyboardEvent;
    const composing = nativeEvent.isComposing || isComposingRef.current || nativeEvent.keyCode === 229;
    
    if (!composing && e.key === 'Backspace' && internalRef.current) {
      const selection = window.getSelection();
      if (selection) {
        let range = selection.getRangeAt(0);
        const normalizedRange = normalizeEquivalentCaretRange(internalRef.current, range);
        if (normalizedRange !== range) {
          selection.removeAllRanges();
          selection.addRange(normalizedRange);
          range = normalizedRange;
        }

        if (range.collapsed) {
          const isTokenSeparator = (node: Node | null): node is Text => node?.nodeType === Node.TEXT_NODE
            && (node.textContent === ' ' || node.textContent === LARGE_PASTE_CARET_ANCHOR);
          let nodeBeforeCaret: Node | null = null;
          if (range.startContainer.nodeType === Node.TEXT_NODE) {
            const isAtTrailingTokenSeparator = isTokenSeparator(range.startContainer)
              && range.startOffset === (range.startContainer.textContent?.length ?? 0);
            if (isAtTrailingTokenSeparator || range.startOffset === 0) {
              nodeBeforeCaret = range.startContainer.previousSibling;
            }
          } else if (range.startContainer.nodeType === Node.ELEMENT_NODE && range.startOffset > 0) {
            const childBeforeCaret = range.startContainer.childNodes.item(range.startOffset - 1);
            nodeBeforeCaret = isTokenSeparator(childBeforeCaret)
              ? childBeforeCaret.previousSibling
              : childBeforeCaret;
          }
          const tokenElement = nodeBeforeCaret instanceof HTMLElement && nodeBeforeCaret.hasAttribute('data-tag-format')
            ? nodeBeforeCaret
            : null;
          if (tokenElement) {
            e.preventDefault();
            const contextId = tokenElement.dataset.contextId;
            const largePastePlaceholder = tokenElement.dataset.largePastePlaceholder;
            if (contextId) {
              const parent = tokenElement.parentNode;
              const tokenIndex = parent
                ? Array.prototype.indexOf.call(parent.childNodes, tokenElement) as number
                : -1;
              removeInlineTokenElement(tokenElement);
              if (parent?.isConnected && tokenIndex >= 0) {
                selection.collapse(parent, Math.min(tokenIndex, parent.childNodes.length));
              }
              onRemoveContext(contextId);
              handleInput();
            } else {
              const previousCaretAnchor = largePastePlaceholder
                && tokenElement.previousSibling?.nodeType === Node.TEXT_NODE
                && tokenElement.previousSibling.textContent?.startsWith(LARGE_PASTE_CARET_ANCHOR)
                ? tokenElement.previousSibling
                : null;
              if (largePastePlaceholder) {
                onRemoveLargePaste?.(largePastePlaceholder);
              }
              removeInlineTokenElement(tokenElement);
              if (largePastePlaceholder) {
                if (previousCaretAnchor?.isConnected) {
                  selection.collapse(previousCaretAnchor, previousCaretAnchor.textContent?.length ?? 0);
                } else {
                  selection.collapse(internalRef.current, 0);
                }
              }
              handleInput();
            }
            return;
          }
        }
      }
    }
    
    if (composing && (e.key === 'Enter' || e.key === 'Escape')) {
      e.stopPropagation();
      return;
    }

    onKeyDown?.(e);
  }, [handleInput, internalRef, onKeyDown, onRemoveContext, onRemoveLargePaste, removeInlineTokenElement]);

  // Insert tag at cursor
  const insertTagAtCursor = useCallback((context: ContextItem) => {
    if (!internalRef.current) return;
    
    internalRef.current.focus();
    const selection = window.getSelection();
    
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      
      const tag = createTagElement(context);
      const space = document.createTextNode(' ');
      
      range.insertNode(space);
      range.insertNode(tag);
      
      range.setStartAfter(space);
      range.setEndAfter(space);
      selection.removeAllRanges();
      selection.addRange(range);
      
      handleInput();
    } else {
      const tag = createTagElement(context);
      const space = document.createTextNode(' ');
      internalRef.current.appendChild(tag);
      internalRef.current.appendChild(space);
      handleInput();
    }
  }, [createTagElement, handleInput, internalRef]);

  // Replace the active @ trigger with a context tag, preserving existing tags.
  const insertContextTagReplacingTrigger = useCallback((context: ContextItem) => {
    if (!internalRef.current || !contextTriggerStateRef.current.isActive) {
      insertTagAtCursor(context);
      return;
    }

    const editor = internalRef.current;
    const triggerStart = contextTriggerStateRef.current.startOffset;
    const triggerEnd = triggerStart + 1 + contextTriggerStateRef.current.query.length;

    const range = getRangeByTextOffsets(editor, triggerStart, triggerEnd);
    if (range) {
      range.deleteContents();
      const tag = createTagElement(context);
      const space = document.createTextNode(' ');
      range.insertNode(space);
      range.insertNode(tag);

      const selection = window.getSelection();
      if (selection) {
        const newRange = document.createRange();
        newRange.setStartAfter(space);
        newRange.setEndAfter(space);
        selection.removeAllRanges();
        selection.addRange(newRange);
      }
      editor.focus();
      closeContextPicker();
      handleInput();
      return;
    }

    // Fallback to cursor insertion if range cannot be found
    insertTagAtCursor(context);
    closeContextPicker();
  }, [closeContextPicker, createTagElement, getRangeByTextOffsets, handleInput, insertTagAtCursor, internalRef]);

  const replaceActiveTextTrigger = useCallback((
    trigger: { startOffset: number; query: string },
    replacementText: string,
    closeTrigger: () => void,
  ) => {
    if (!internalRef.current) return;
    const editor = internalRef.current;
    const triggerStart = trigger.startOffset;
    const triggerEnd = triggerStart + 1 + trigger.query.length;
    const range = getRangeByTextOffsets(editor, triggerStart, triggerEnd);
    if (!range) {
      return;
    }

    range.deleteContents();
    const selection = window.getSelection();
    if (replacementText) {
      const inlineTokenElement = createInlineTokenElement(replacementText);
      const replacementNode = inlineTokenElement ?? document.createTextNode(replacementText);
      const trailingSpace = document.createTextNode(' ');
      const fragment = document.createDocumentFragment();
      fragment.appendChild(replacementNode);
      fragment.appendChild(trailingSpace);
      range.insertNode(fragment);

      if (selection) {
        const newRange = document.createRange();
        newRange.setStartAfter(trailingSpace);
        newRange.setEndAfter(trailingSpace);
        selection.removeAllRanges();
        selection.addRange(newRange);
      }
    } else if (selection) {
      const newRange = document.createRange();
      newRange.setStart(range.startContainer, range.startOffset);
      newRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(newRange);
    }

    editor.focus();
    closeTrigger();
    handleInput();
  }, [createInlineTokenElement, getRangeByTextOffsets, handleInput, internalRef]);

  const replaceActiveContextTrigger = useCallback((replacementText: string) => {
    if (!contextTriggerStateRef.current.isActive) return;
    replaceActiveTextTrigger(
      contextTriggerStateRef.current,
      replacementText,
      closeContextPicker,
    );
  }, [closeContextPicker, replaceActiveTextTrigger]);

  const replaceActiveInlineTrigger = useCallback((replacementText: string) => {
    if (!inlineTriggerStateRef.current.isActive) return;
    replaceActiveTextTrigger(
      inlineTriggerStateRef.current,
      replacementText,
      closeInlineTrigger,
    );
  }, [closeInlineTrigger, replaceActiveTextTrigger]);

  const appendInlineTokenAtEnd = useCallback((token: string) => {
    if (!internalRef.current) {
      return;
    }

    const editor = internalRef.current;
    const currentTextContent = extractTextContent();
    if (!currentTextContent) {
      editor.replaceChildren();
    }
    editor.focus();

    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);

    const fragment = document.createDocumentFragment();
    if (currentTextContent) {
      fragment.appendChild(document.createTextNode(' '));
    }

    const inlineTokenElement = createInlineTokenElement(token);
    fragment.appendChild(inlineTokenElement ?? document.createTextNode(token));

    const trailingSpace = document.createTextNode(' ');
    fragment.appendChild(trailingSpace);
    range.insertNode(fragment);

    const selection = window.getSelection();
    if (selection) {
      const newRange = document.createRange();
      newRange.setStartAfter(trailingSpace);
      newRange.setEndAfter(trailingSpace);
      selection.removeAllRanges();
      selection.addRange(newRange);
    }

    handleInput();
  }, [createInlineTokenElement, extractTextContent, handleInput, internalRef]);

  /** Insert @ at the caret and open the chat context picker. */
  const openContextPicker = useCallback(() => {
    const editor = internalRef.current;
    if (!editor) return;

    editor.focus();
    const sel = window.getSelection();
    let range: Range | null = null;
    if (sel && sel.rangeCount > 0) {
      range = sel.getRangeAt(0);
    }
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }

    const cursorOffset = getCursorOffset(editor);
    const textBeforeCursor = cursorOffset >= 0
      ? (editor.textContent || '').slice(0, cursorOffset)
      : (editor.textContent || '');
    const charBeforeCursor = textBeforeCursor[textBeforeCursor.length - 1];
    const contextTriggerText = isWhitespaceCharacter(charBeforeCursor) ? '@' : ' @';

    document.execCommand('insertText', false, contextTriggerText);
    requestAnimationFrame(() => {
      detectActiveTrigger();
    });
  }, [detectActiveTrigger, getCursorOffset, internalRef]);

  // Expose methods to parent
  useEffect(() => {
    if (internalRef.current) {
      (internalRef.current as any).insertTag = insertTagAtCursor;
      (internalRef.current as any).insertContextTagReplacingTrigger = insertContextTagReplacingTrigger;
      (internalRef.current as any).replaceActiveContextTrigger = replaceActiveContextTrigger;
      (internalRef.current as any).replaceActiveInlineTrigger = replaceActiveInlineTrigger;
      (internalRef.current as any).appendInlineTokenAtEnd = appendInlineTokenAtEnd;
      (internalRef.current as any).openContextPicker = openContextPicker;
      (internalRef.current as any).closeContextPicker = closeContextPicker;
      (internalRef.current as any).closeInlineTrigger = closeInlineTrigger;
      (internalRef.current as RichTextInputElement).getComposerPresentation = buildComposerPresentation;
      (internalRef.current as RichTextInputElement).restoreComposerPresentation = restoreComposerPresentation;
    }
  }, [appendInlineTokenAtEnd, buildComposerPresentation, closeContextPicker, closeInlineTrigger, insertContextTagReplacingTrigger, insertTagAtCursor, openContextPicker, replaceActiveContextTrigger, replaceActiveInlineTrigger, restoreComposerPresentation, internalRef]);

  // Initialize and sync value changes from external sources.
  // This editor is effectively controlled by comparing the parent's value
  // with the current DOM content, rather than tracking a "skip next sync" flag.
  useEffect(() => {
    const editor = internalRef.current;
    if (!editor) return;

    if (isComposingRef.current) return;
    
    // Detect template fill mode via placeholder elements
    const hasPlaceholders = editor.querySelector('.rich-text-placeholder') !== null;
    if (hasPlaceholders) {
      // Skip value sync; template rendering owns the content
      return;
    }
    
    const currentContent = extractTextContent();
    const syncAction = getRichTextExternalSyncAction(value, currentContent);
    
    if (syncAction === 'noop') {
      return;
    }

    if (syncAction === 'clear') {
      editor.textContent = '';
      return;
    }
    
    if (syncAction === 'replace') {
      renderValueWithInlineTokens(editor, value);
      
      // Restore cursor to the end
      requestAnimationFrame(() => {
        if (editor.childNodes.length > 0) {
          const range = document.createRange();
          const sel = window.getSelection();
          range.selectNodeContents(editor);
          range.collapse(false);
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
        editor.focus();
      });
    }
  }, [extractTextContent, internalRef, renderValueWithInlineTokens, value]);

  // Remove tags for deleted contexts
  useEffect(() => {
    const editor = internalRef.current;
    if (!editor) return;

    const currentContextIds = new Set(contexts.map(c => c.id));
    const previousContextIds = lastContextIdsRef.current;

    const deletedIds = Array.from(previousContextIds).filter(id => !currentContextIds.has(id));

    deletedIds.forEach(id => {
      const tagElement = editor.querySelector(`[data-context-id="${id}"]`);
      if (tagElement) {
        const nextSibling = tagElement.nextSibling;
        if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE && nextSibling.textContent === ' ') {
          nextSibling.remove();
        }
        tagElement.remove();
      }
    });

    if (deletedIds.length > 0) {
      triggerSyncRef.current?.();
    }

    lastContextIdsRef.current = currentContextIds;
  }, [contexts, internalRef]);

  const handleFocus = useCallback(() => {
    setIsFocused(true);
    onFocus?.();
  }, [onFocus]);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    // Delay closing to allow picker clicks
    setTimeout(() => {
      closeContextPicker();
      closeInlineTrigger();
    }, 200);
    onBlur?.();
  }, [closeContextPicker, closeInlineTrigger, onBlur]);

  // Handle IME composition
  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
    onCompositionStart?.();
  }, [onCompositionStart]);

  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false;
    onCompositionEnd?.();
    handleInput();
  }, [handleInput, onCompositionEnd]);

  useEffect(() => {
    if (
      activeLargePaste
      && pendingLargePastes[activeLargePaste.placeholder] !== activeLargePaste.sourceText
    ) {
      setActiveLargePaste(null);
    }
  }, [activeLargePaste, pendingLargePastes]);

  const handleSaveLargePaste = useCallback(() => {
    if (!activeLargePaste) return;
    const capsule = Array.from(
      internalRef.current?.querySelectorAll<HTMLElement>('[data-large-paste-placeholder]') ?? [],
    ).find(element => element.dataset.largePastePlaceholder === activeLargePaste.placeholder);
    if (!capsule) {
      setActiveLargePaste(null);
      return;
    }

    if (activeLargePaste.draft.length === 0) {
      onRemoveLargePaste?.(activeLargePaste.placeholder);
      removeInlineTokenElement(capsule);
    } else {
      const nextPlaceholder = onUpdateLargePaste?.(
        activeLargePaste.placeholder,
        activeLargePaste.draft,
      ) ?? activeLargePaste.placeholder;
      capsule.replaceWith(createLargePasteElement(nextPlaceholder));
    }
    setActiveLargePaste(null);
    handleInput();
    internalRef.current?.focus();
  }, [
    activeLargePaste,
    createLargePasteElement,
    handleInput,
    internalRef,
    onRemoveLargePaste,
    onUpdateLargePaste,
    removeInlineTokenElement,
  ]);

  const handleCopyLargePaste = useCallback(async () => {
    if (!activeLargePaste) return;
    try {
      await navigator.clipboard.writeText(activeLargePaste.draft);
      setLargePasteCopied(true);
    } catch {
      setLargePasteCopied(false);
    }
  }, [activeLargePaste]);

  return (
    <>
      <div
        data-openbitfun-component="rich-text-input"
        data-openbitfun-part="root"
        data-openbitfun-state={[isFocused ? 'focused' : '', disabled ? 'disabled' : ''].filter(Boolean).join(' ') || undefined}
        {...restProps}
        ref={internalRef}
        className={`rich-text-input ${isFocused ? 'rich-text-input--focused' : ''} ${className}`}
        contentEditable={!disabled}
        onBeforeInput={handleBeforeInput}
        onInput={handleInput}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        data-placeholder={placeholder}
        suppressContentEditableWarning
      />
      <Dialog
        initialFocusRef={largePasteTextareaRef}
        onOpenChange={(open) => {
          if (!open) setActiveLargePaste(null);
        }}
        open={activeLargePaste !== null}
        size="md"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{t('input.largePasteDialogTitle')}</DialogTitle>
          </DialogHeading>
          <DialogClose />
        </DialogHeader>
        <DialogBody>
          <Textarea
            ref={largePasteTextareaRef}
            className="rich-text-large-paste-dialog__textarea"
            label={t('input.largePasteContentLabel')}
            value={activeLargePaste?.draft ?? ''}
            onChange={(event) => {
              const draft = event.target.value;
              setLargePasteCopied(false);
              setActiveLargePaste(current => current ? { ...current, draft } : null);
            }}
            rows={12}
            spellCheck={false}
          />
        </DialogBody>
        <DialogFooter>
          <Button type="button" size="sm" variant="outline" onClick={() => void handleCopyLargePaste()}>
            {largePasteCopied ? t('input.largePasteCopied') : t('input.largePasteCopy')}
          </Button>
          <Button type="button" size="sm" variant="fill" onClick={() => setActiveLargePaste(null)}>
            {t('input.largePasteCancel')}
          </Button>
          <Button type="button" size="sm" variant="primary" onClick={handleSaveLargePaste}>
            {t('input.largePasteSave')}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
});

RichTextInput.displayName = 'RichTextInput';

export default RichTextInput;
