/**
 * EmptyState component.
 * Empty state display.
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
;

import './EmptyState.scss';
import { Icon, Tooltip } from '@openbitfun/ui';

export interface EmptyStateProps {
  onClose?: () => void;
  toolbarActions?: React.ReactNode;
  children?: React.ReactNode;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ onClose, toolbarActions, children }) => {
  const { t } = useTranslation('components');
  const hasEmbeddedContent = children !== undefined && children !== null;

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onClose?.();
  }, [onClose]);

  return (
    <div data-openbitfun-component="content-canvas" data-openbitfun-part="empty" data-openbitfun-state="empty" className="canvas-empty-state">
      {(toolbarActions !== undefined || onClose) && (
        <div className="canvas-empty-state__toolbar" data-openbitfun-component="content-canvas" data-openbitfun-part="emptyToolbar">
          {toolbarActions !== undefined ? toolbarActions : <Tooltip content={t('tabs.close')}>
            <button
              className="canvas-empty-state__close-btn"
              onClick={handleClose}
            >
              <Icon name="xmark" size="sm" />
            </button>
          </Tooltip>}
        </div>
      )}
      <div
        className={`canvas-empty-state__content${hasEmbeddedContent ? ' canvas-empty-state__content--embedded' : ''}`}
        data-openbitfun-component="content-canvas"
        data-openbitfun-part="emptyContent"
      >
        {hasEmbeddedContent ? children : (
          <div className="canvas-empty-state__message">
            <p>{t('canvas.noContentOpen')}</p>
          </div>
        )}
      </div>
    </div>
  );
};

EmptyState.displayName = 'EmptyState';

export default EmptyState;
