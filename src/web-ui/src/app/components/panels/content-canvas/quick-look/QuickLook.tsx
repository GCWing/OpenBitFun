/**
 * QuickLook component.
 * Preview popup for quick file inspection.
 *
 * Triggers:
 * - Cmd/Ctrl + hover file link
 * - F12 Go to Definition
 * - Space on selected file in tree
 *
 * Interactions:
 * - Esc / click outside -> close
 * - Enter / click pin button -> pin as a tab
 * - Edit in preview -> auto pin as tab
 */

import React, { useEffect, useRef, useCallback, useState } from 'react';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useTranslation } from 'react-i18next';

import FlexiblePanel from '../../base/FlexiblePanel';
import type { PanelContent } from '../types';
import './QuickLook.scss';
import { createOverlayPortal, OverflowText, Icon, Tooltip, useDismissibleLayer } from '@openbitfun/ui';

export interface QuickLookProps {
  /** Whether visible */
  isOpen: boolean;
  /** Preview content */
  content: PanelContent | null;
  /** Position */
  position: { x: number; y: number };
  /** Close callback */
  onClose: () => void;
  /** Pin as tab callback */
  onPin: () => void;
  /** Content change callback */
  onContentChange?: (content: PanelContent) => void;
  /** Workspace path */
  workspacePath?: string;
}

export const QuickLook: React.FC<QuickLookProps> = ({
  isOpen,
  content,
  position,
  onClose,
  onPin,
  onContentChange,
  workspacePath,
}) => {
  const { t } = useTranslation('components');
  const containerRef = useRef<HTMLDivElement>(null);
  const [adjustedPosition, setAdjustedPosition] = useState(position);
  const [hasEdited, setHasEdited] = useState(false);

  useDismissibleLayer({
    enabled: isOpen,
    layerRef: containerRef,
    scope: 'canvas',
    onDismiss: onClose,
  });

  // Adjust position to stay within viewport
  useEffect(() => {
    if (!isOpen || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = 16;

    let x = position.x;
    let y = position.y;

    // Horizontal adjustment
    if (x + rect.width > viewportWidth - padding) {
      x = viewportWidth - rect.width - padding;
    }
    if (x < padding) {
      x = padding;
    }

    // Vertical adjustment
    if (y + rect.height > viewportHeight - padding) {
      y = position.y - rect.height - 10; // Render above
    }
    if (y < padding) {
      y = padding;
    }

    setAdjustedPosition({ x, y });
  }, [isOpen, position]);

  useEffect(() => {
    if (!isOpen) return;
    containerRef.current?.focus({ preventScroll: true });
  }, [isOpen]);

  // Content change handling
  const handleContentChange = useCallback((newContent: PanelContent | null) => {
    if (newContent && onContentChange) {
      onContentChange(newContent);
      
      // Auto-pin if edited
      if (!hasEdited) {
        setHasEdited(true);
        // Pin shortly after
        setTimeout(() => {
          onPin();
        }, 100);
      }
    }
  }, [onContentChange, hasEdited, onPin]);

  // Reset edit state
  useEffect(() => {
    if (!isOpen) {
      setHasEdited(false);
    }
  }, [isOpen]);

  if (!isOpen || !content) {
    return null;
  }

  return createOverlayPortal(
    <div data-overflow-trigger
      ref={containerRef}
      className="canvas-quick-look"
      data-shortcut-scope="canvas"
      data-openbitfun-component="content-canvas"
      data-openbitfun-part="quickLook"
      data-openbitfun-state="open"
      tabIndex={-1}
      style={{
        left: `${adjustedPosition.x}px`,
        top: `${adjustedPosition.y}px`,
      }}
    >
      {/* Header */}
      <div className="canvas-quick-look__header" data-openbitfun-component="content-canvas" data-openbitfun-part="quickLookHeader">
        <div className="canvas-quick-look__title" data-openbitfun-component="content-canvas" data-openbitfun-part="quickLookTitle">
          <OverflowText>{content.title}</OverflowText>
          {content.data?.filePath && (
            <Tooltip content={t('canvas.openFileLocation')}>
              <button className="canvas-quick-look__open-btn">
                <Icon name="arrow-up-right" size="xs" />
              </button>
            </Tooltip>
          )}
        </div>
        
        <div className="canvas-quick-look__actions" data-openbitfun-component="content-canvas" data-openbitfun-part="quickLookActions">
          <Tooltip content={t('canvas.pinAsTab')}>
            <button
              className="canvas-quick-look__action-btn canvas-quick-look__pin-btn"
              onClick={onPin}
            >
              <Icon name="pin" size="sm" />
            </button>
          </Tooltip>
          
          <Tooltip content={t('canvas.closeEsc')}>
            <button
              className="canvas-quick-look__action-btn canvas-quick-look__close-btn"
              onClick={onClose}
            >
              <Icon name="xmark" size="sm" />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Content */}
      <div className="canvas-quick-look__content" data-openbitfun-component="content-canvas" data-openbitfun-part="quickLookContent">
        <FlexiblePanel
          content={content}
          onContentChange={handleContentChange}
          workspacePath={workspacePath}
        />
      </div>

      {/* Footer hint */}
      <div className="canvas-quick-look__footer" data-openbitfun-component="content-canvas" data-openbitfun-part="quickLookFooter">
        <span>{t('canvas.enterToPin')}</span>
        <span className="canvas-quick-look__separator">|</span>
        <span>{t('canvas.escToClose')}</span>
      </div>
    </div>,
    getAppearanceOverlayHost()
  );
};

QuickLook.displayName = 'QuickLook';

export default QuickLook;
