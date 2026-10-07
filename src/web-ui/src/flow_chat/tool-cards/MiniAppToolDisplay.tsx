import { useToolCardDisclosure } from '../timeline/readerState';
/**
 * MiniAppToolDisplay — InitMiniApp result on the prominent FlowChat framework.
 */
import React, { useCallback, useMemo } from 'react';
import { OverflowText, IconButton, Icon } from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';

import type { ToolCardProps } from '../types/flow-chat';
import { ProminentToolCard, ProminentToolCardSummary, ToolProcessingDots } from '@openbitfun/ui/flow-chat';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import { useSceneManager } from '@/app/hooks/useSceneManager';
import './MiniAppToolDisplay.scss';

export const InitMiniAppDisplay: React.FC<ToolCardProps> = ({ toolItem }) => {
  const { t } = useTranslation('flow-chat');
  const { status, toolResult, partialParams, isParamsStreaming, toolCall } = toolItem;
  const { openScene } = useSceneManager();
  const [isExpanded, setIsExpanded] = useToolCardDisclosure('isExpanded');

  const toolId = toolItem.id ?? toolCall?.id;
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract({
    toolId,
    toolName: toolItem.toolName,
  });

  const name = useMemo(() => {
    if (isParamsStreaming) return (partialParams?.name as string | undefined) || '';
    return (toolCall?.input as Record<string, unknown> | undefined)?.name as string | undefined || '';
  }, [isParamsStreaming, partialParams, toolCall?.input]);

  const appId = toolResult?.result?.app_id as string | undefined;
  const path = toolResult?.result?.path as string | undefined;
  const miniAppFiles = useMemo(() => {
    const files = toolResult?.result?.files;
    if (Array.isArray(files)) {
      return files.filter((filePath): filePath is string => (
        typeof filePath === 'string' && filePath.length > 0
      ));
    }
    return path ? [path] : [];
  }, [path, toolResult?.result?.files]);
  const success = toolResult?.success === true;
  const isLoading = status === 'running' || status === 'streaming' || status === 'preparing';
  const isFailed = status === 'error' || (status === 'completed' && toolResult != null && toolResult.success === false);

  const hasExpandableDetails =
    isFailed || (status === 'completed' && success && Boolean(appId));

  const toggleExpanded = useCallback(() => {
    applyExpandedState(isExpanded, !isExpanded, setIsExpanded);
  }, [applyExpandedState, isExpanded, setIsExpanded]);

  const handleCardClick = useCallback(
    (e: React.MouseEvent) => {
      if (!hasExpandableDetails) return;
      const target = e.target as HTMLElement;
      if (target.closest('.miniapp-action-buttons')) return;
      toggleExpanded();
    },
    [hasExpandableDetails, toggleExpanded]
  );

  const getErrorMessage = () => {
    if (toolResult && 'error' in toolResult && toolResult.error) {
      return String(toolResult.error);
    }
    return t('toolCards.initMiniApp.createFailed');
  };

  const commandText = useMemo(() => {
    if (isLoading) {
      return name || t('toolCards.initMiniApp.creatingShort');
    }
    if (isFailed) {
      return name || t('toolCards.initMiniApp.untitled');
    }
    return name || appId || t('toolCards.initMiniApp.untitled');
  }, [appId, isFailed, isLoading, name, t]);

  const renderStatusIcon = () => {
    if (isLoading) {
      return <ToolProcessingDots size={16} />;
    }
    return null;
  };

  const renderSummary = () => (
    <ProminentToolCardSummary
      icon={<span className="miniapp-icon"><Icon name="mini-app" size="md" /></span>}
      action={`${t('toolCards.initMiniApp.title')}:`}
      content={
        <span data-openbitfun-component="mini-app-tool-display" data-openbitfun-part="info" className="miniapp-tool-info">
          <OverflowText
            data-openbitfun-component="mini-app-tool-display"
            data-openbitfun-part="command"
            className="command-text"
            data-testid="chat-miniapp-title"
            data-app-id={appId || ''}
          >
            {commandText}
          </OverflowText>
        </span>
      }
      extra={
        <>
          {success && appId && status === 'completed' && (
            <OverflowText data-openbitfun-component="mini-app-tool-display" data-openbitfun-part="output" className="output-summary">
              {t('toolCards.initMiniApp.skeletonReady')}
            </OverflowText>
          )}
          {(status === 'cancelled' || status === 'rejected') && (
            <span data-openbitfun-component="mini-app-tool-display" data-openbitfun-part="operation" className="operation-tag">
              {status === 'cancelled' ? t('toolCards.default.cancelled') : t('toolCards.default.rejected')}
            </span>
          )}
          {isFailed && (
            <div data-openbitfun-component="mini-app-tool-display" data-openbitfun-part="errorIndicator" className="error-indicator">
              <span className="error-text">{t('toolCards.initMiniApp.failed')}</span>
            </div>
          )}
        </>
      }
      actions={success && !isFailed && appId && status === 'completed' ? (
        <span data-openbitfun-component="mini-app-tool-display" data-openbitfun-part="actions">
          <IconButton
            variant="quiet" size="sm" icon={<Icon name="arrow-up-right" size="sm" />}
            data-testid="chat-miniapp-open-btn" data-app-id={appId}
            onClick={() => openScene(`miniapp:${appId}`)}
            title={t('toolCards.initMiniApp.openInMiniAppTitle')}
            aria-label={t('toolCards.initMiniApp.openInMiniApp')}
          />
        </span>
      ) : undefined}
      statusIcon={renderStatusIcon()}
    />
  );

  const renderExpandedSuccess = () => {
    if (!appId) return null;
    return (
      <div data-openbitfun-component="mini-app-tool-display" data-openbitfun-part="result" className="miniapp-result-container">
        <div data-openbitfun-component="mini-app-tool-display" data-openbitfun-part="rows" className="miniapp-result-rows" data-testid="chat-miniapp-file-list">
          <div data-openbitfun-component="mini-app-tool-display" data-openbitfun-part="row" className="miniapp-result-row">
            <span data-openbitfun-component="mini-app-tool-display" data-openbitfun-part="label" className="miniapp-result-label">{t('toolCards.initMiniApp.labelAppId')}</span>
            <OverflowText data-openbitfun-component="mini-app-tool-display" data-openbitfun-part="value" className="miniapp-result-value" title={appId}>
              {appId}
            </OverflowText>
          </div>
          {miniAppFiles.map((filePath, index) => (
            <div
              key={filePath}
              data-openbitfun-component="mini-app-tool-display"
              data-openbitfun-part="row"
              className="miniapp-result-row"
              data-testid="chat-miniapp-file-row"
              data-path={filePath}
            >
              <span data-openbitfun-component="mini-app-tool-display" data-openbitfun-part="label" className="miniapp-result-label">{index === 0 ? t('toolCards.initMiniApp.labelPath') : null}</span>
              <span data-openbitfun-component="mini-app-tool-display" data-openbitfun-part="value" className="miniapp-result-value" title={filePath}>
                {filePath}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderExpandedError = () => (
    <div data-openbitfun-component="mini-app-tool-display" data-openbitfun-part="error" className="error-content">
      <div className="error-message">{getErrorMessage()}</div>
      {name ? (
        <div className="error-meta">
          <span className="error-operation">{t('toolCards.initMiniApp.nameLabel', { name })}</span>
        </div>
      ) : null}
    </div>
  );

  const renderDetailsWhenExpanded = (): React.ReactNode => {
    if (isFailed) {
      return renderExpandedError();
    }
    if (success && appId) {
      return renderExpandedSuccess();
    }
    return null;
  };

  return (
    <div data-openbitfun-component="mini-app-tool-display" data-openbitfun-part="root"
      data-openbitfun-state={[isExpanded && 'expanded', isFailed && 'failed', isLoading && 'loading'].filter(Boolean).join(' ')}
      ref={cardRootRef}
      data-testid="chat-miniapp-card"
      data-tool-card-id={toolId ?? ''}
      data-status={status}
      data-app-id={appId || ''}
      data-expanded={isExpanded ? 'true' : 'false'}
    >
      <ProminentToolCard
        status={isFailed ? 'error' : status}
        isExpanded={isExpanded}
        onToggle={hasExpandableDetails ? handleCardClick : undefined}
        className="miniapp-tool-display"
        summary={renderSummary()}
        collapsibleErrorContent
        errorContent={isFailed ? renderExpandedError() : undefined}
        expandedContent={isExpanded && !isFailed ? renderDetailsWhenExpanded() : null}
        summaryExpandAffordance={hasExpandableDetails}
      />
    </div>
  );
};
