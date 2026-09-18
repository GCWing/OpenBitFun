import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Composer, ComposerToolbar, IconButton, Icon } from '@openbitfun/ui';
import { useImeOwnedKeyGuard } from '@/flow_chat/hooks/useImeOwnedKeyGuard';
import type { ContextItem } from '@/shared/types/context';
import { ConversationExcerptAttachments } from '../../selection/ConversationExcerptAttachments';
import { ChatContextPicker } from '../ChatContextPicker';
import {
  RichTextInput,
  type ContextTriggerState,
  type RichTextInputElement,
} from '../RichTextInput';
import {
  COMPOSER_PRESENTATION_VERSION,
  composerPresentationContexts,
  withConversationExcerpts,
  type ComposerPresentation,
} from '../../utils/composerPresentation';
import { getMcpPromptReferenceMatches } from '../../utils/mcpPromptReference';
import { getSkillPromptReferenceMatches } from '../../utils/skillPromptReference';
import { getAdditionalModePromptReferenceMatches } from '../../utils/additionalModePromptReference';
import { getWidgetPromptReferenceMatches } from '@/tools/generative-widget/widgetPromptReference';

interface UserMessageEditComposerProps {
  value: string;
  isSubmitting?: boolean;
  submitLabel: string;
  cancelLabel: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onSubmit: (presentation?: ComposerPresentation) => void | Promise<void>;
  onCancel: () => void;
  presentation?: ComposerPresentation | null;
  workspacePath?: string;
  workspaceId?: string;
  remoteConnectionId?: string;
  excludeSessionId?: string;
}

type RichUserMessageEditComposerProps = UserMessageEditComposerProps;

function hasEditableInlineReference(value: string): boolean {
  return getMcpPromptReferenceMatches(value).length > 0
    || getSkillPromptReferenceMatches(value).length > 0
    || getWidgetPromptReferenceMatches(value).length > 0
    || getAdditionalModePromptReferenceMatches(value).length > 0;
}

const RichUserMessageEditComposer: React.FC<RichUserMessageEditComposerProps> = ({
  value,
  isSubmitting = false,
  submitLabel,
  cancelLabel,
  placeholder,
  onChange,
  onSubmit,
  onCancel,
  presentation,
  workspacePath,
  workspaceId,
  remoteConnectionId,
  excludeSessionId,
}) => {
  const editorRef = useRef<RichTextInputElement>(null);
  const contextPickerAnchorRef = useRef<HTMLDivElement>(null);
  const [contexts, setContexts] = useState<ContextItem[]>(() => (
    presentation ? composerPresentationContexts(presentation) : []
  ));
  const [contextTriggerState, setContextTriggerState] = useState<ContextTriggerState>({
    isActive: false,
    query: '',
    startOffset: 0,
  });
  const canSubmit = value.trim().length > 0 && !isSubmitting;

  useEffect(() => {
    setContexts(presentation ? composerPresentationContexts(presentation) : []);
    const frame = requestAnimationFrame(() => {
      if (presentation) {
        editorRef.current?.restoreComposerPresentation?.(presentation);
      }
      editorRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [presentation]);

  const capturePresentation = useCallback(() => (
    withConversationExcerpts(
      editorRef.current?.getComposerPresentation?.()
        ?? presentation
        ?? { version: COMPOSER_PRESENTATION_VERSION, segments: [{ kind: 'text', text: value }] },
      contexts,
      value,
    )
  ), [contexts, presentation, value]);

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    void onSubmit(capturePresentation());
  }, [canSubmit, capturePresentation, onSubmit]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (contextTriggerState.isActive) {
        editorRef.current?.closeContextPicker?.();
      } else {
        onCancel();
      }
      return;
    }

    if (
      event.key === 'Enter' &&
      !contextTriggerState.isActive &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      event.preventDefault();
      handleSubmit();
    }
  }, [contextTriggerState.isActive, handleSubmit, onCancel]);

  const handleRemoveContext = useCallback((id: string) => {
    setContexts(current => current.filter(context => context.id !== id));
  }, []);

  const handleSelectContext = useCallback((context: ContextItem) => {
    setContexts(current => (
      current.some(item => item.id === context.id) ? current : [...current, context]
    ));
    requestAnimationFrame(() => {
      editorRef.current?.insertContextTagReplacingTrigger?.(context);
      editorRef.current?.focus();
    });
  }, []);

  const handleComposerMouseDown = useCallback((event: React.MouseEvent<HTMLFieldSetElement>) => {
    if (isSubmitting) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, input, textarea, select, a, label, [contenteditable]')) return;
    editorRef.current?.focus();
  }, [isSubmitting]);

  return (
    <Composer
      className="user-message-edit-composer"
      data-openbitfun-product-component="user-message-edit-composer"
      data-openbitfun-product-part="root"
      data-openbitfun-mode="rich"
      data-openbitfun-state={isSubmitting ? 'submitting' : undefined}
      disabled={isSubmitting}
      onMouseDown={handleComposerMouseDown}
      toolbar={(
        <ComposerToolbar
          className="user-message-edit-composer__actions"
          data-openbitfun-product-component="user-message-edit-composer"
          data-openbitfun-product-part="actions"
          trailing={(
            <>
              <IconButton
                aria-label={cancelLabel}
                data-openbitfun-action="cancel"
                data-openbitfun-product-component="user-message-edit-composer"
                data-openbitfun-product-part="action"
                icon={<Icon name="xmark" size="sm" />}
                onClick={onCancel}
                size="xs"
                title={cancelLabel}
                variant="quiet"
              />
              <IconButton
                aria-busy={isSubmitting || undefined}
                aria-label={submitLabel}
                data-openbitfun-action="submit"
                data-openbitfun-product-component="user-message-edit-composer"
                data-openbitfun-product-part="action"
                disabled={!canSubmit}
                icon={isSubmitting ? (
                  <Loader2
                    className="user-message-edit-composer__spinner"
                    data-openbitfun-product-component="user-message-edit-composer"
                    data-openbitfun-product-part="spinner"
                    size={14}
                  />
                ) : <Icon name="check-line" size="sm" />}
                onClick={handleSubmit}
                size="xs"
                title={submitLabel}
                variant="primary"
              />
            </>
          )}
        />
      )}
    >
      <div
        ref={contextPickerAnchorRef}
        className="user-message-edit-composer__rich-input"
        data-openbitfun-product-component="user-message-edit-composer"
        data-openbitfun-product-part="input"
      >
        <ConversationExcerptAttachments contexts={contexts} onRemove={handleRemoveContext}
          onUpdate={(id, comment) => setContexts(current => current.map(context =>
            context.id === id && context.type === 'conversation-excerpt' ? { ...context, comment } : context))} />
        <RichTextInput
          ref={editorRef}
          value={value}
          onChange={(nextValue) => onChange(nextValue)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={isSubmitting}
          contexts={contexts}
          onRemoveContext={handleRemoveContext}
          onContextTriggerStateChange={setContextTriggerState}
        />
        <ChatContextPicker
          isOpen={contextTriggerState.isActive}
          searchQuery={contextTriggerState.query}
          workspacePath={workspacePath}
          workspaceId={workspaceId}
          remoteConnectionId={remoteConnectionId}
          excludeSessionId={excludeSessionId}
          anchorRef={contextPickerAnchorRef}
          entryView="files"
          onSelectContext={handleSelectContext}
          onClose={() => editorRef.current?.closeContextPicker?.()}
        />
      </div>
    </Composer>
  );
};

export const UserMessageEditComposer: React.FC<UserMessageEditComposerProps> = ({
  value,
  isSubmitting = false,
  submitLabel,
  cancelLabel,
  placeholder,
  onChange,
  onSubmit,
  onCancel,
  presentation,
  workspacePath,
  workspaceId,
  remoteConnectionId,
  excludeSessionId,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { isImeOwnedKey, handleCompositionStart, handleCompositionEnd } = useImeOwnedKeyGuard();
  const trimmedValue = value.trim();
  const canSubmit = trimmedValue.length > 0 && !isSubmitting;

  const resizeTextarea = useCallback((textarea: HTMLTextAreaElement | null) => {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  useLayoutEffect(() => {
    resizeTextarea(textareaRef.current);
  }, [resizeTextarea, value]);

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    void onSubmit();
  }, [canSubmit, onSubmit]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.key === 'Enter' || event.key === 'Escape') && isImeOwnedKey(event)) {
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit, isImeOwnedKey, onCancel]);

  const handleComposerMouseDown = useCallback((event: React.MouseEvent<HTMLFieldSetElement>) => {
    if (isSubmitting) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, input, textarea, select, a, label, [contenteditable]')) return;
    textareaRef.current?.focus();
  }, [isSubmitting]);

  if (presentation || hasEditableInlineReference(value)) {
    return (
      <RichUserMessageEditComposer
        value={value}
        isSubmitting={isSubmitting}
        submitLabel={submitLabel}
        cancelLabel={cancelLabel}
        placeholder={placeholder}
        onChange={onChange}
        onSubmit={onSubmit}
        onCancel={onCancel}
        presentation={presentation}
        workspacePath={workspacePath}
        workspaceId={workspaceId}
        remoteConnectionId={remoteConnectionId}
        excludeSessionId={excludeSessionId}
      />
    );
  }

  return (
    <Composer
      className="user-message-edit-composer"
      data-openbitfun-product-component="user-message-edit-composer"
      data-openbitfun-product-part="root"
      data-openbitfun-mode="plain"
      data-openbitfun-state={isSubmitting ? 'submitting' : undefined}
      disabled={isSubmitting}
      onMouseDown={handleComposerMouseDown}
      toolbar={(
        <ComposerToolbar
          className="user-message-edit-composer__actions"
          data-openbitfun-product-component="user-message-edit-composer"
          data-openbitfun-product-part="actions"
          trailing={(
            <>
              <IconButton
                aria-label={cancelLabel}
                data-openbitfun-action="cancel"
                data-openbitfun-product-component="user-message-edit-composer"
                data-openbitfun-product-part="action"
                icon={<Icon name="xmark" size="sm" />}
                onClick={onCancel}
                size="xs"
                title={cancelLabel}
                variant="quiet"
              />
              <IconButton
                aria-busy={isSubmitting || undefined}
                aria-label={submitLabel}
                data-openbitfun-action="submit"
                data-openbitfun-product-component="user-message-edit-composer"
                data-openbitfun-product-part="action"
                disabled={!canSubmit}
                icon={isSubmitting ? (
                  <Loader2
                    className="user-message-edit-composer__spinner"
                    data-openbitfun-product-component="user-message-edit-composer"
                    data-openbitfun-product-part="spinner"
                    size={14}
                  />
                ) : <Icon name="check-line" size="sm" />}
                onClick={handleSubmit}
                size="xs"
                title={submitLabel}
                variant="primary"
              />
            </>
          )}
        />
      )}
    >
      <textarea
        data-openbitfun-product-component="user-message-edit-composer"
        data-openbitfun-product-part="input"
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        placeholder={placeholder}
        disabled={isSubmitting}
        className="user-message-edit-composer__textarea"
      />
    </Composer>
  );
};

UserMessageEditComposer.displayName = 'UserMessageEditComposer';
