import { File as LucideFile } from 'lucide-react';
import React, { useCallback, useRef } from 'react';
import { createOverlayPortal, OverflowText, Button, Icon, IconButton, Tooltip } from '@openbitfun/ui';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { RetainedMountBoundary } from '@/shared/presence';
import { useI18n } from '@/infrastructure/i18n';
import { DiffEditor } from '../../../tools/editor';
import './DiffFullscreenViewer.css';

interface DiffFullscreenViewerProps {
  isOpen: boolean;
  onClose: () => void;
  filePath: string;
  originalContent: string;
  modifiedContent: string;
  onAcceptFile: () => void;
  onRejectFile: () => void;
  onAcceptBlock: (blockId: string) => void;
  onRejectBlock: (blockId: string) => void;
  loading?: boolean;
}

export const DiffFullscreenViewer: React.FC<DiffFullscreenViewerProps> = ({
  isOpen,
  onClose,
  filePath,
  originalContent,
  modifiedContent,
  onAcceptFile,
  onRejectFile,
  onAcceptBlock: _onAcceptBlock,
  onRejectBlock: _onRejectBlock,
  loading = false
}) => {
  const { t } = useI18n('components');
  const surfaceRef = useRef<HTMLDivElement>(null);
  const retainedContentRef = useRef({
    filePath,
    originalContent,
    modifiedContent,
    loading,
  });

  if (isOpen) {
    retainedContentRef.current = {
      filePath,
      originalContent,
      modifiedContent,
      loading,
    };
  }

  const retainedContent = retainedContentRef.current;
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  }, [onClose]);

  const fileName = retainedContent.filePath.split(/[/\\]/).pop() || retainedContent.filePath;

  const fullscreenContent = (
    <div data-overflow-trigger
      className="diff-fullscreen-overlay"
      data-state={isOpen ? 'open' : 'closed'}
      aria-hidden={!isOpen}
      {...(!isOpen ? { inert: '' } : {})}
      onClick={handleBackdropClick}
      data-openbitfun-component="diff-fullscreen-viewer"
      data-openbitfun-part="overlay"
    >
      <div ref={surfaceRef} role="dialog" aria-modal="true" aria-label={fileName} tabIndex={-1} className="diff-fullscreen-container" data-openbitfun-component="diff-fullscreen-viewer" data-openbitfun-part="container">
        {/* Top toolbar */}
        <div className="diff-fullscreen-header" data-openbitfun-component="diff-fullscreen-viewer" data-openbitfun-part="header">
          <div className="file-info" data-openbitfun-component="diff-fullscreen-viewer" data-openbitfun-part="fileInfo">
            <div className="file-icon">
              <LucideFile width="16" height="16" stroke="currentColor" aria-hidden="true" />
            </div>
            <div className="file-details">
              <div className="file-name"><OverflowText>{fileName}</OverflowText></div>
              <div className="file-path-full"><OverflowText>{retainedContent.filePath}</OverflowText></div>
            </div>
          </div>

          <div className="header-actions" data-openbitfun-component="diff-fullscreen-viewer" data-openbitfun-part="actions">
            <Tooltip content={t('diffFullscreen.acceptFileTooltip')}>
              <Button
                variant="primary"
                size="sm"
                leadingIcon={<Icon name="check-circle" size="lg" />}
                onClick={onAcceptFile}
                disabled={retainedContent.loading}
              >
                {t('diffFullscreen.acceptFile')}
              </Button>
            </Tooltip>
            
            <Tooltip content={t('diffFullscreen.rejectFileTooltip')}>
              <Button
                variant="fill"
                size="sm"
                leadingIcon={<Icon name="xmark" size="lg" />}
                onClick={onRejectFile}
                disabled={retainedContent.loading}
              >
                {t('diffFullscreen.rejectFile')}
              </Button>
            </Tooltip>

            <div className="header-divider" />

            <Tooltip content={t('tooltip.close')}>
              <IconButton
                size="sm"
                aria-label={t('tooltip.close')}
                icon={<Icon name="xmark" size="lg" />}
                onClick={onClose}
              />
            </Tooltip>
          </div>
        </div>

        {/* Diff content */}
        <div className="diff-fullscreen-content" data-openbitfun-component="diff-fullscreen-viewer" data-openbitfun-part="content">
          <DiffEditor
            originalContent={retainedContent.originalContent}
            modifiedContent={retainedContent.modifiedContent}
            filePath={retainedContent.filePath}
            readOnly={false}
            renderSideBySide={true}
            showMinimap={false}
          />
        </div>

        {/* Loading overlay */}
        {retainedContent.loading && (
          <div className="fullscreen-loading-overlay" data-openbitfun-component="diff-fullscreen-viewer" data-openbitfun-part="loading">
            <div className="loading-spinner" />
            <span>{t('diffFullscreen.processing')}</span>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <RetainedMountBoundary present={isOpen}>
      {createOverlayPortal(fullscreenContent, getAppearanceOverlayHost(), null, {
        modal: true, open: isOpen, surfaceRef, onDismiss: onClose,
      })}
    </RetainedMountBoundary>
  );
};
