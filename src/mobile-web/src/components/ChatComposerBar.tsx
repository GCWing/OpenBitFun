import {
  ArrowUp as LucideArrowUp,
  CornerDownLeft as LucideCornerDownLeft,
  LoaderCircle as LucideLoaderCircle,
  Plus as LucidePlus,
} from 'lucide-react';
import React from 'react';
import { MobileButton, MobileComposer, MobileIconButton } from '@openbitfun/ui/mobile';
import { useI18n } from '../i18n';

interface PendingImage {
  dataUrl: string;
  name: string;
}

interface ChatComposerBarProps {
  cancelling: boolean;
  containerRef: React.Ref<HTMLDivElement>;
  expanded: boolean;
  imageAnalyzing: boolean;
  sending: boolean;
  input: string;
  inputRef: React.Ref<HTMLTextAreaElement>;
  modelControls: React.ReactNode;
  queueContent?: React.ReactNode;
  onActivate: () => void;
  onAttach: () => void;
  onCancel: () => void;
  onChange: (value: string) => void;
  onCompositionEnd: () => void;
  onCompositionStart: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onRemoveImage: (index: number) => void;
  onSend: () => void;
  pendingImages: PendingImage[];
  promptSuggestion?: string | null;
  onAcceptPromptSuggestion?: (suggestion: string) => void;
  remoteUnavailable: boolean;
  streaming: boolean;
}

export default function ChatComposerBar({
  cancelling,
  containerRef,
  expanded,
  imageAnalyzing,
  sending,
  input,
  inputRef,
  modelControls,
  queueContent,
  onActivate,
  onAttach,
  onCancel,
  onChange,
  onCompositionEnd,
  onCompositionStart,
  onKeyDown,
  onRemoveImage,
  onSend,
  pendingImages,
  promptSuggestion,
  onAcceptPromptSuggestion,
  remoteUnavailable,
  streaming,
}: ChatComposerBarProps) {
  const { t } = useI18n();
  const attachDisabled = imageAnalyzing || pendingImages.length >= 5;
  const visibleSuggestion = promptSuggestion && onAcceptPromptSuggestion && !input && !streaming && !sending && !imageAnalyzing && !remoteUnavailable
    ? promptSuggestion
    : null;

  return (
    <div className={`chat-page__input-wrap ${expanded ? 'is-expanded' : ''}`} ref={containerRef}>
      {queueContent}
      {visibleSuggestion ? (
        <MobileButton
          appearance="secondary"
          aria-label={t('chat.promptSuggestionAccept', { suggestion: visibleSuggestion })}
          className="chat-page__prompt-suggestion"
          data-testid="chat-prompt-suggestion"
          onClick={() => onAcceptPromptSuggestion?.(visibleSuggestion)}
          size="sm"
          trailing={<LucideCornerDownLeft width="14" height="14" aria-hidden="true" />}
        >
          {visibleSuggestion}
        </MobileButton>
      ) : null}
      <MobileComposer
        aria-label={t('chat.collapsedInputPlaceholder')}
        className="chat-page__composer"
        endActions={(
          <>
            {imageAnalyzing ? (
              <MobileIconButton
                appearance="plain"
                aria-label={t('chat.imageAnalyzingPlaceholder')}
                className="chat-page__send-btn is-processing"
                disabled
                icon={(
                  <LucideLoaderCircle width="12" height="12" stroke="currentColor" aria-hidden="true" />
                )}
                size="sm"
              />
            ) : null}
            {!imageAnalyzing && (expanded || input.trim() || pendingImages.length > 0) ? (
              <MobileIconButton
                appearance="plain"
                aria-label={t('common.submit')}
                className="chat-page__send-btn"
                disabled={remoteUnavailable || sending || (!input.trim() && pendingImages.length === 0)}
                icon={(
                  <LucideArrowUp width="12" height="12" aria-hidden="true" />
                )}
                onClick={onSend}
                size="sm"
              />
            ) : null}
            {streaming && (
              <MobileIconButton
                appearance="plain"
                aria-label={t('common.stop')}
                className={`chat-page__send-btn is-stop${cancelling ? ' is-cancelling' : ''}`}
                disabled={cancelling}
                icon={cancelling
                  ? <span className="chat-page__stop-spinner" aria-hidden="true" />
                  : <span className="chat-page__stop-glyph" aria-hidden="true" />}
                onClick={onCancel}
                size="sm"
              />
            )}
          </>
        )}
        expanded={expanded}
        leading={(
          <MobileIconButton
            appearance="plain"
            aria-label={t('common.attachImage')}
            className="chat-page__composer-leading"
            disabled={attachDisabled}
            icon={<LucidePlus width="24" height="24" stroke="currentColor" aria-hidden="true" />}
            onClick={() => { onActivate(); onAttach(); }}
          />
        )}
        onActivate={!expanded ? onActivate : undefined}
        startActions={(
          <>
            <MobileIconButton
              appearance="plain"
              aria-label={t('common.attachImage')}
              className="chat-page__action-btn"
              disabled={attachDisabled}
              icon={<LucidePlus width="22" height="22" stroke="currentColor" aria-hidden="true" />}
              onClick={onAttach}
            />
            {modelControls}
          </>
        )}
      >
        <div className="chat-page__input-area">
          {pendingImages.length > 0 && (
            <div className="chat-page__image-preview-row">
              {pendingImages.map((image, index) => (
                <div key={`${image.name}-${index}`} className="chat-page__image-thumb">
                  <img src={image.dataUrl} alt={image.name} />
                  <MobileIconButton appearance="plain" size="sm" aria-label={t('common.close')} className="chat-page__image-remove" icon={<span aria-hidden="true">×</span>} onClick={() => onRemoveImage(index)} />
                </div>
              ))}
            </div>
          )}
          {expanded ? (
            <textarea
              className="chat-page__input"
              disabled={imageAnalyzing}
              onChange={(event) => onChange(event.target.value)}
              onCompositionEnd={onCompositionEnd}
              onCompositionStart={onCompositionStart}
              onKeyDown={onKeyDown}
              placeholder={t('chat.inputPlaceholder')}
              ref={inputRef}
              rows={1}
              value={input}
            />
          ) : (
            <span className="chat-page__input-placeholder">
              {imageAnalyzing
                ? t('chat.imageAnalyzingPlaceholder')
                : streaming
                  ? t('chat.collapsedStreamingPlaceholder')
                  : t('chat.collapsedInputPlaceholder')}
            </span>
          )}
        </div>
      </MobileComposer>
    </div>
  );
}
