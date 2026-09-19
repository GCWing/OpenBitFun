import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { subscribeOverlayInteraction, Tooltip, Icon } from '@openbitfun/ui';
import type { ToolCardProps } from '../types/flow-chat';
import { ProminentToolCard, ProminentToolCardSummary, ToolProcessingDots } from '@openbitfun/ui/flow-chat';
import { useTranslation } from 'react-i18next';
import GenerativeWidgetFrame, {
  type WidgetContextMenuMessage,
  type WidgetMessage,
} from '@/tools/generative-widget/GenerativeWidgetFrame';
import GenerativeWidgetStaticRenderer from '@/tools/generative-widget/GenerativeWidgetStaticRenderer';
import { handleWidgetBridgeEvent } from '@/tools/generative-widget/widgetInteraction';
import { useGenerativeWidgetPromptMenu } from '@/tools/generative-widget/useGenerativeWidgetPromptMenu';
import { useContextMenuStore } from '@/shared/context-menu-system/store/ContextMenuStore';
import { captureElementToDownloadsPng } from '../utils/captureElementToDownloadsPng';
import { createLogger } from '@/shared/utils/logger';
import { isImeOwnedKeyboardEvent } from '@/shared/utils/ime';
import { createTab } from '@/shared/utils/tabUtils';
import { notificationService } from '@/shared/notification-system';
import './GenerativeWidgetToolCard.scss';

const log = createLogger('GenerativeWidgetToolCard');

type WidgetResult = {
  widget_id?: string;
  title?: string;
  widget_code?: string;
  width?: number;
  height?: number;
  is_svg?: boolean;
};

function parseWidgetResult(raw: unknown): WidgetResult | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as WidgetResult;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') {
    return raw as WidgetResult;
  }
  return null;
}

export const GenerativeWidgetToolCard: React.FC<ToolCardProps> = ({ toolItem, sessionId }) => {
  const { t } = useTranslation('flow-chat');
  const { status, toolCall, toolResult, partialParams, isParamsStreaming } = toolItem;
  const previewRef = useRef<HTMLDivElement | null>(null);
  const captureRootRef = useRef<HTMLDivElement | null>(null);
  const exportPreviewRef = useRef<HTMLDivElement | null>(null);
  const resultData = useMemo(() => parseWidgetResult(toolResult?.result), [toolResult?.result]);
  const openPromptMenu = useGenerativeWidgetPromptMenu('tool-card');
  const hideMenu = useContextMenuStore(state => state.hideMenu);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [menuSelectionActive, setMenuSelectionActive] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [shouldRenderExportClone, setShouldRenderExportClone] = useState(false);
  const [exportWidth, setExportWidth] = useState<number | null>(null);
  /** The failure body is toggled separately and starts collapsed on error. */
  const [failedBodyExpanded, setFailedBodyExpanded] = useState(false);

  const liveParams = isParamsStreaming ? partialParams : toolCall?.input;
  const widgetCode = useMemo(() => {
    const fromStreaming = liveParams?.widget_code;
    if (typeof fromStreaming === 'string' && fromStreaming.length > 0) {
      return fromStreaming;
    }

    const fromResult = resultData?.widget_code;
    if (typeof fromResult === 'string' && fromResult.length > 0) {
      return fromResult;
    }

    const fromInput = toolCall?.input?.widget_code;
    return typeof fromInput === 'string' ? fromInput : '';
  }, [liveParams, resultData?.widget_code, toolCall?.input]);

  const title = useMemo(() => {
    const fromStreaming = liveParams?.title;
    if (typeof fromStreaming === 'string' && fromStreaming.trim().length > 0) {
      return fromStreaming.trim();
    }

    const fromResult = resultData?.title;
    if (typeof fromResult === 'string' && fromResult.trim().length > 0) {
      return fromResult.trim();
    }

    const fromInput = toolCall?.input?.title;
    if (typeof fromInput === 'string' && fromInput.trim().length > 0) {
      return fromInput.trim();
    }

    return 'Generative UI';
  }, [liveParams, resultData?.title, toolCall?.input]);

  const isLoading =
    status === 'preparing' || status === 'streaming' || status === 'running' || status === 'pending';
  const isFailed = status === 'error' || toolResult?.success === false;
  const widgetId = resultData?.widget_id || toolCall?.id || toolItem.id;
  const isClickable = status === 'completed' && widgetCode.trim().length > 0;
  const hasRenderableWidget = widgetCode.trim().length > 0 && !isFailed;

  useEffect(() => {
    if (isFailed) {
      setFailedBodyExpanded(false);
    }
  }, [isFailed]);

  const isCardExpanded = !isFailed || failedBodyExpanded;
  const showFailedErrorPanel = isFailed && failedBodyExpanded;

  const handleOpenPanel = useCallback(() => {
    if (!isClickable) {
      return;
    }

    const duplicateCheckKey = `generative-widget-${toolCall?.id || toolItem.id}`;
    createTab({
      type: 'generative-widget',
      title,
      data: {
        widgetId,
        widgetCode,
        _source: {
          type: 'tool-call',
          toolName: 'GenerativeUI',
          sessionId,
          toolCallId: toolCall?.id,
          toolItemId: toolItem.id,
        },
      },
      metadata: {
        duplicateCheckKey,
        fromTool: true,
        toolName: 'GenerativeUI',
      },
      checkDuplicate: true,
      duplicateCheckKey,
      replaceExisting: true,
      mode: 'agent',
    });
  }, [isClickable, sessionId, title, toolCall?.id, toolItem.id, widgetCode, widgetId]);

  const handleCardClick = useCallback(
    (e: React.MouseEvent) => {
      if (isFailed) {
        e.preventDefault();
        setFailedBodyExpanded((v) => !v);
        return;
      }
      handleOpenPanel();
    },
    [handleOpenPanel, isFailed],
  );

  const handleWidgetEvent = useCallback((event: WidgetMessage) => {
    if (event.type === 'openbitfun-widget:context-menu') {
      setMenuSelectionActive(true);
      openPromptMenu(event as WidgetContextMenuMessage, previewRef.current);
      return;
    }
    if (event.type === 'openbitfun-widget:selection-cleared') {
      setMenuSelectionActive(false);
      hideMenu();
      return;
    }
    if (
      event.type === 'openbitfun-widget:ready' ||
      event.type === 'openbitfun-widget:resize' ||
      event.type === 'openbitfun-widget:clear-selection'
    ) {
      return;
    }
    handleWidgetBridgeEvent(event, 'tool-card');
  }, [hideMenu, openPromptMenu]);

  useEffect(() => {
    if (!menuSelectionActive) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isImeOwnedKeyboardEvent(event)) {
        return;
      }
      setMenuSelectionActive(false);
      hideMenu();
      setSelectionRevision((value) => value + 1);
    };

    return subscribeOverlayInteraction(previewRef, 'keydown', handleEscape);
  }, [hideMenu, menuSelectionActive]);

  const handleExportImage = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const fallbackRoot = captureRootRef.current;
      if (!fallbackRoot) {
        notificationService.error(t('exportImage.containerNotFound'));
        return;
      }

      setIsExporting(true);
      try {
        let target = fallbackRoot;

        if (hasRenderableWidget) {
          const nextWidth = captureRootRef.current?.clientWidth || 720;
          setExportWidth(nextWidth);
          setShouldRenderExportClone(true);
          await new Promise((resolve) => setTimeout(resolve, 180));
          if (exportPreviewRef.current) {
            target = exportPreviewRef.current;
          }
        } else {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        await captureElementToDownloadsPng(
          target,
          t('toolCards.generativeWidget.exportFileNamePrefix'),
        );
      } catch (error) {
        log.error('Generative UI export image failed', error);
        notificationService.error(t('exportImage.exportFailed'));
      } finally {
        setShouldRenderExportClone(false);
        setIsExporting(false);
      }
    },
    [hasRenderableWidget, t],
  );

  const statusText = isFailed
    ? t('toolCards.default.failed')
    : isLoading
      ? t('toolCards.generativeUI.streamingPreview')
      : t('toolCards.generativeUI.openSource');

  const summary = (
    <ProminentToolCardSummary
      icon={<span className="generative-widget-card__icon"><Icon name="spark" size="md" /></span>}
      action={t('toolCards.generativeUI.action')}
      content={<span data-openbitfun-component="generative-widget-tool-card" data-openbitfun-part="title" className="generative-widget-card__title">{title}</span>}
      extra={(
        <div data-openbitfun-component="generative-widget-tool-card" data-openbitfun-part="extra" className="generative-widget-card__extra">
          <span
            data-openbitfun-component="generative-widget-tool-card"
            data-openbitfun-part="status"
            className={`generative-widget-card__status ${isFailed ? 'generative-widget-card__status--error' : ''}`.trim()}
          >
            {statusText}
          </span>
        </div>
      )}
      actions={(
        <Tooltip
          content={isExporting ? t('exportImage.exporting') : t('exportImage.exportToImage')}
          placement="top"
        >
          <button
            data-openbitfun-component="generative-widget-tool-card"
            data-openbitfun-part="exportAction"
            data-openbitfun-state={isExporting ? 'exporting' : undefined}
            type="button"
            className="generative-widget-card__export-image-btn"
            onClick={handleExportImage}
            disabled={isExporting}
            aria-label={t('exportImage.exportToImage')}
          >
            {isExporting ? <Loader2 size={14} className="spinning" /> : <Icon name="image" size="sm" />}
          </button>
        </Tooltip>
      )}
      statusIcon={isLoading ? <ToolProcessingDots size={16} /> : null}
    />
  );

  const previewInner = isFailed ? (
    <div data-openbitfun-component="generative-widget-tool-card" data-openbitfun-part="placeholder" data-openbitfun-state="failed" className="generative-widget-card__placeholder generative-widget-card__placeholder--error">
      {toolResult?.error || t('toolCards.generativeUI.renderFailed')}
    </div>
  ) : widgetCode.trim().length > 0 ? (
    <div data-openbitfun-component="generative-widget-tool-card" data-openbitfun-part="preview" ref={previewRef} className="generative-widget-card__preview">
      <GenerativeWidgetFrame
        widgetId={widgetId}
        title={title}
        widgetCode={widgetCode}
        executeScripts={status === 'completed'}
        selectionRevision={selectionRevision}
        onWidgetEvent={handleWidgetEvent}
      />
    </div>
  ) : (
    <div data-openbitfun-component="generative-widget-tool-card" data-openbitfun-part="placeholder" className="generative-widget-card__placeholder">
      {t('toolCards.generativeUI.waitingForContent')}
    </div>
  );

  const expandedBody = (
    <div data-openbitfun-component="generative-widget-tool-card" data-openbitfun-part="captureRoot" ref={captureRootRef} className="generative-widget-card__capture-root">
      {previewInner}
    </div>
  );

  return (
    <>
      <div data-openbitfun-component="generative-widget-tool-card" data-openbitfun-part="root" data-openbitfun-state={isFailed ? 'failed' : undefined}>
        <ProminentToolCard
        status={status}
        isExpanded={isCardExpanded}
        onToggle={isFailed || isClickable ? handleCardClick : undefined}
        className={`generative-widget-card ${isClickable || isFailed ? 'clickable' : ''}`.trim()}
        summary={summary}
        expandedContent={expandedBody}
        errorContent={showFailedErrorPanel ? expandedBody : undefined}
        isFailed={isFailed}
        summaryExpandAffordance={isClickable || isFailed}
        summaryAffordanceKind={isFailed ? 'expand' : 'open-panel-right'}
        />
      </div>
      {shouldRenderExportClone && hasRenderableWidget && (
        <div
          className="generative-widget-card__export-stage"
          data-openbitfun-component="generative-widget-tool-card"
          data-openbitfun-part="exportStage"
        >
          <div
            ref={exportPreviewRef}
            className="generative-widget-card__export-stage-inner"
            style={{ width: exportWidth ? `${exportWidth}px` : '720px' }}
          >
            <div className="generative-widget-card__preview generative-widget-card__preview--export">
              <GenerativeWidgetStaticRenderer widgetCode={widgetCode} />
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default GenerativeWidgetToolCard;
