/**
 * Export dialog turns as long images.
 * Uses React rendering to match FlowChat styles.
 * Uses modern-screenshot (fork of html-to-image with better CSS var / font / CORS handling).
 */

import React, { useState, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { FlowChatStore } from '../../store/FlowChatStore';
import { notificationService } from '@/shared/notification-system';
import { FlowTextBlock } from '../FlowTextBlock';
import { FlowToolCard } from '../FlowToolCard';
import { Button, Card, CardBody, CardHeader, Checkbox, Dialog, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogHeading, DialogTitle, Icon, IconButton, Tooltip } from '@openbitfun/ui';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import type { DialogTurn, FlowTextItem, FlowToolItem, FlowThinkingItem } from '../../types/flow-chat';
import { i18nService, useI18n } from '@/infrastructure/i18n';
import { workspaceAPI } from '@/infrastructure/api';
import { createLogger } from '@/shared/utils/logger';
import { getBuiltinAppearanceThemeToken } from '@/infrastructure/appearance/builtins/catalog';
import { withTimeout } from '@/shared/utils/timing';
import { downloadDir, join } from '@tauri-apps/api/path';
import { writeFile } from '@tauri-apps/plugin-fs';
import { ModelThinkingDisplay } from '../../tool-cards/ModelThinkingDisplay';
import { hasComposerPresentationReferences, parseComposerPresentation } from '../../utils/composerPresentation';
import { UserMessagePresentationContent, UserMessageTextContent } from './UserMessagePresentationContent';
import { captureExportCanvas } from '../../utils/exportImageCapture';
import { readExportImageLayout } from './exportImageLayout';
import './ExportImageButton.scss';

const log = createLogger('ExportImageButton');

/** Minimum time to wait for React render before capture (ms). */
const MIN_RENDER_WAIT_MS = 300;

/** Additional time per model-round item for complex content (ms). */
const PER_ROUND_WAIT_MS = 80;

/** Maximum total render wait time (ms). */
const MAX_RENDER_WAIT_MS = 2_000;

interface ExportImageButtonProps {
  turnId: string;
  className?: string;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  renderTrigger?: (controls: {
    isExporting: boolean;
    onOpenDialog: () => void;
  }) => React.ReactNode;
}

// Exported content renderer.
interface ExportContentProps {
  dialogTurn: DialogTurn;
  expandThinking: boolean;
}

// Marker class on the logo placeholder so we can locate it for canvas compositing.
const LOGO_PLACEHOLDER_CLASS = 'export-content__logo-placeholder';

function ExportImagePreview({ expandThinking }: { expandThinking: boolean }) {
  const answerY = expandThinking ? 88 : 55;

  return (
    <svg
      className="export-image-preview"
      data-openbitfun-product-component="export-image"
      data-openbitfun-product-part="optionPreview"
      data-preview-thinking={expandThinking ? 'expanded' : 'collapsed'}
      viewBox="0 0 180 112"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="18" y="8" width="144" height="96" rx="8" fill="var(--openbitfun-color-surface-scene)" stroke="var(--openbitfun-color-border-default)" strokeWidth="var(--openbitfun-border-width-default)" />
      <g fill="currentColor">
        <circle cx="34" cy="20" r="4" />
        <rect x="43" y="18" width="44" height="3" rx="1.5" fill="var(--openbitfun-color-content-primary)" />
        <rect x="118" y="20" width="32" height="2" rx="1" fill="var(--openbitfun-color-content-muted)" />
        <rect x="91" y="35" width="59" height="12" rx="4" fill="var(--openbitfun-color-action-quiet-hover)" />
        <rect x="99" y="39" width="43" height="2" rx="1" />
        <rect x="99" y="43" width="30" height="2" rx="1" fill="var(--openbitfun-color-content-muted)" />
        {expandThinking && (
          <g>
            <rect x="30" y="51" width="120" height="32" rx="4" fill="var(--openbitfun-color-accent-surface)" stroke="var(--openbitfun-color-accent-border)" strokeWidth="var(--openbitfun-border-width-default)" />
            <rect x="30" y="56" width="2" height="22" rx="1" fill="var(--openbitfun-color-accent-default)" />
            <g fill="var(--openbitfun-color-accent-default)">
              <circle cx="38" cy="57" r="1.5" />
              <circle cx="43" cy="57" r="1.5" />
              <circle cx="48" cy="57" r="1.5" />
            </g>
            <rect x="56" y="56" width="38" height="2" rx="1" fill="var(--openbitfun-color-accent-default)" />
            <g fill="var(--openbitfun-color-content-secondary)">
              <rect x="38" y="63" width="104" height="2" rx="1" />
              <rect x="38" y="69" width="94" height="2" rx="1" />
              <rect x="38" y="75" width="73" height="2" rx="1" />
            </g>
          </g>
        )}
        <g transform={`translate(0 ${answerY})`}>
          <rect x="30" width="48" height="3" rx="1.5" fill="var(--openbitfun-color-content-primary)" />
          <rect x="30" y="6" width="120" height="2" rx="1" />
          <rect x="30" y="11" width="96" height="2" rx="1" />
          {!expandThinking && <g>
            <rect x="30" y="22" width="112" height="2" rx="1" />
            <rect x="30" y="27" width="82" height="2" rx="1" />
          </g>}
        </g>
      </g>
    </svg>
  );
}

export const ExportContent: React.FC<ExportContentProps> = ({ dialogTurn, expandThinking }) => {
  const presentation = parseComposerPresentation(dialogTurn.userMessage?.metadata?.composerPresentation);

  return (
    <div data-openbitfun-product-component="export-image" data-openbitfun-product-part="root" className="export-content">
      <div className="export-content__header" data-openbitfun-product-component="export-image" data-openbitfun-product-part="header">
        {/* Placeholder reserves space for the logo. The actual logo is drawn
            onto the final image via canvas compositing to avoid issues with
            embedding <img>/data URLs inside an SVG foreignObject. */}
        <div
          className={`export-content__logo ${LOGO_PLACEHOLDER_CLASS}`}
          data-openbitfun-product-component="export-image"
          data-openbitfun-product-part="logo"
          aria-label="OpenBitFun"
        />
        <div className="export-content__title" data-openbitfun-product-component="export-image" data-openbitfun-product-part="title">OpenBitFun</div>
        <div className="export-content__timestamp" data-openbitfun-product-component="export-image" data-openbitfun-product-part="timestamp">
          {i18nService.formatDate(new Date())}
        </div>
      </div>

      {dialogTurn.userMessage?.content && (
        <div className="export-content__user-section" data-openbitfun-product-component="export-image" data-openbitfun-product-part="user">
          <div className="export-content__user-bubble">
            {hasComposerPresentationReferences(presentation)
              ? <UserMessagePresentationContent presentation={presentation} />
              : <UserMessageTextContent text={dialogTurn.userMessage.content} />}
          </div>
        </div>
      )}

      <div className="export-content__ai-section" data-openbitfun-product-component="export-image" data-openbitfun-product-part="assistant">
        
        {dialogTurn.modelRounds.map((modelRound) => (
          <div key={modelRound.id} className="export-content__model-round" data-openbitfun-product-component="export-image" data-openbitfun-product-part="round">
            {[...modelRound.items]
              .sort((a, b) => a.timestamp - b.timestamp)
              .map((item) => {
                if (item.type === 'text') {
                  const textItem = item as FlowTextItem;
                  if (textItem.content && textItem.content.trim()) {
                    return (
                      <div data-openbitfun-product-component="export-image" data-openbitfun-product-part="text" key={item.id} className="export-content__text-item">
                        <FlowTextBlock 
                          textItem={{
                            ...textItem,
                            isStreaming: false,
                          }}
                        />
                      </div>
                    );
                  }
                } else if (item.type === 'thinking') {
                  if (!expandThinking) return null;
                  const thinkingItem = item as FlowThinkingItem;
                  return (
                    <div data-openbitfun-product-component="export-image" data-openbitfun-product-part="thinking" key={item.id} className="export-content__thinking-item export-content__thinking-item--expanded">
                      <ModelThinkingDisplay
                        thinkingItem={{
                          ...thinkingItem,
                          isStreaming: false,
                          status: 'completed',
                        }}
                        isLastItem={false}
                        forceExpanded
                      />
                    </div>
                  );
                } else if (item.type === 'tool') {
                  const toolItem = item as FlowToolItem;
                  return (
                    <div data-openbitfun-product-component="export-image" data-openbitfun-product-part="tool" key={item.id} className="export-content__tool-item">
                      <FlowToolCard toolItem={toolItem} />
                    </div>
                  );
                }
                return null;
              })}
          </div>
        ))}
      </div>

      <div className="export-content__footer" data-openbitfun-product-component="export-image" data-openbitfun-product-part="footer">
        <span>{i18nService.t('flow-chat:exportImage.poweredBy')}</span>
        <span className="export-content__footer-brand">OpenBitFun</span>
      </div>
    </div>
  );
};

export const ExportImageButton: React.FC<ExportImageButtonProps> = ({
  turnId,
  className = '',
  triggerRef,
  renderTrigger,
}) => {
  const { t } = useI18n('flow-chat');
  const [isExporting, setIsExporting] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [expandThinking, setExpandThinking] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const compactOptionRef = useRef<HTMLInputElement>(null);
  const thinkingOptionRef = useRef<HTMLInputElement>(null);
  // Ref guard to prevent double-invocation while state update is pending.
  const isExportingRef = useRef(false);

  const openExportDialog = useCallback(() => {
    if (isExportingRef.current) return;
    // Restore to the resident trigger rather than the menu item that is closing.
    (triggerRef ?? buttonRef).current?.focus({ preventScroll: true });
    setExpandThinking(false);
    setIsDialogOpen(true);
  }, [triggerRef]);

  // Resolve the DialogTurn and its session title by turn id.
  const getDialogTurn = useCallback((): { turn: DialogTurn; sessionTitle: string } | null => {
    const flowChatStore = FlowChatStore.getInstance();
    const state = flowChatStore.getState();
    
    for (const [, session] of state.sessions) {
      const turn = session.dialogTurns.find((t: DialogTurn) => t.id === turnId);
      if (turn) return { turn, sessionTitle: session.title?.trim() || '' };
    }
    return null;
  }, [turnId]);

  const handleExport = useCallback(async (expandThinking: boolean) => {
    if (isExportingRef.current) return;
    setIsDialogOpen(false);
    isExportingRef.current = true;
    setIsExporting(true);
    
    // Let animations start rendering.
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Track offscreen DOM so we can clean up on any exit path.
    let root: ReturnType<typeof createRoot> | null = null;
    let wrapper: HTMLDivElement | null = null;
    
    const cleanupDom = () => {
      try {
        if (root) { root.unmount(); root = null; }
        if (wrapper && wrapper.parentNode) { wrapper.parentNode.removeChild(wrapper); wrapper = null; }
      } catch (e) {
        log.warn('DOM cleanup error', e);
      }
    };
    
    try {
      const result = getDialogTurn();
      
      if (!result) {
        notificationService.error(i18nService.t('flow-chat:exportImage.dialogNotFound'));
        return;
      }
      
      const { turn: dialogTurn, sessionTitle } = result;
      const layout = readExportImageLayout(turnId, (triggerRef ?? buttonRef).current);
      
      // Read the resolved appearance background color.
      const computedStyle = getComputedStyle(document.documentElement);
      const bgColor = computedStyle.getPropertyValue('--openbitfun-color-surface-scene').trim()
        || getBuiltinAppearanceThemeToken('--openbitfun-color-surface-scene');

      // Pre-load the logo as an HTMLImageElement. We do NOT try to embed it
      // inside the captured DOM (unreliable with <img>/data URLs inside an
      // SVG foreignObject). Instead we reserve space with a placeholder
      // element and composite the logo onto the final raster via canvas.
      let logoImage: HTMLImageElement | null = null;
      try {
        logoImage = await withTimeout(
          new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new window.Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = reject;
            // Cache-bust to avoid stale decoded copies when re-exporting.
            const colorScheme = document.documentElement.getAttribute('data-color-scheme');
            const logoPath = colorScheme === 'dark'
              ? '/brand/openbitfun-mark-light.png'
              : '/brand/openbitfun-mark-dark.png';
            img.src = `${logoPath}?t=${Date.now()}`;
          }),
          3_000,
          'Logo preload',
        );
      } catch (e) {
        log.warn('Logo preload failed; export will proceed without logo overlay', e);
      }
      
      // Create hidden wrapper for rendering.
      // Keep the staging tree laid out without covering the conversation.
      wrapper = document.createElement('div');
      wrapper.id = 'export-image-wrapper';
      wrapper.className = 'export-image-wrapper';

      wrapper.style.cssText = `
        position: absolute;
        left: -9999px;
        top: 0;
        pointer-events: none;
        background: ${bgColor};
        visibility: visible;
        opacity: 1;
        overflow: visible;
      `;
      if (layout.width) wrapper.style.width = `${layout.width}px`;
      
      // Preserve the column's appearance for layout. Capture serializes only
      // resolved properties, so inherited variables do not bloat the SVG.
      for (const [varName, value] of Object.entries(layout.variables)) {
        wrapper.style.setProperty(varName, value);
      }
      
      document.body.appendChild(wrapper);
      
      // Render export content with React.
      root = createRoot(wrapper);
      root.render(<ExportContent dialogTurn={dialogTurn} expandThinking={expandThinking} />);
      
      // Adaptive render wait: base time + per-round allowance, capped.
      const roundCount = dialogTurn.modelRounds?.length ?? 1;
      const renderWait = Math.min(
        MIN_RENDER_WAIT_MS + roundCount * PER_ROUND_WAIT_MS,
        MAX_RENDER_WAIT_MS,
      );
      await new Promise(resolve => setTimeout(resolve, renderWait));
      
      // Find rendered container.
      const container = wrapper.querySelector<HTMLElement>('.export-content');

      if (!container) {
        throw new Error(i18nService.t('flow-chat:exportImage.containerNotFound'));
      }

      // Yield to the main thread so the browser can finish layout/paint.
      await new Promise(resolve => setTimeout(resolve, 0));

      const captureFilter = (node: Node) => {
        // Filter out action buttons and other non-export elements.
        if (node instanceof HTMLElement) {
          if (node.classList?.contains('model-round-item__footer')) return false;
          if (node.classList?.contains('user-message-item__actions')) return false;
          if (node.classList?.contains('tool-card__actions')) return false;
          if (
            node.matches?.(
              '[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="actionRegion"], '
              + '[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="expanded"]',
            )
          ) return false;
        }
        return true;
      };

      const canvas = await captureExportCanvas(container, bgColor, captureFilter);

      // Capture has settled fonts. Measure the logo against that same layout
      // before removing the staging DOM.
      const containerRect = container.getBoundingClientRect();
      const placeholderEl = container.querySelector(`.${LOGO_PLACEHOLDER_CLASS}`) as HTMLElement | null;
      let logoBox: { x: number; y: number; w: number; h: number; radius: number } | null = null;
      if (placeholderEl) {
        const r = placeholderEl.getBoundingClientRect();
        const radiusStr = getComputedStyle(placeholderEl).getPropertyValue('border-radius');
        const radius = parseFloat(radiusStr) || 0;
        logoBox = {
          x: r.left - containerRect.left,
          y: r.top - containerRect.top,
          w: r.width,
          h: r.height,
          radius,
        };
      }

      cleanupDom();

      // Reuse the verified raster instead of PNG -> Image -> second canvas.
      // The actual dimensions also keep the logo aligned after a scale fallback.
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('No canvas context for compositing');
      if (logoImage && logoBox) {
        const scaleX = canvas.width / containerRect.width;
        const scaleY = canvas.height / containerRect.height;
        ctx.save();
        ctx.scale(scaleX, scaleY);
        const { x, y, w, h, radius } = logoBox;
        if (radius > 0) {
          const path = new Path2D();
          const r = Math.min(radius, w / 2, h / 2);
          path.moveTo(x + r, y);
          path.lineTo(x + w - r, y);
          path.quadraticCurveTo(x + w, y, x + w, y + r);
          path.lineTo(x + w, y + h - r);
          path.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
          path.lineTo(x + r, y + h);
          path.quadraticCurveTo(x, y + h, x, y + h - r);
          path.lineTo(x, y + r);
          path.quadraticCurveTo(x, y, x + r, y);
          path.closePath();
          ctx.clip(path);
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(logoImage, x, y, w, h);
        ctx.restore();
      } else {
        log.warn('Logo overlay skipped', { hasLogo: !!logoImage, hasBox: !!logoBox });
      }
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));

      if (!blob) {
        throw new Error(i18nService.t('flow-chat:exportImage.generateFailed'));
      }

      // Save image to downloads directory.
      const timestampStr = i18nService.formatDate(new Date(), {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).replace(/[/:\s]/g, '-');
      // Sanitize session title for use as filename (replace unsafe chars).
      const safeTitle = sessionTitle
        .replace(/[/\\:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 80);
      const namePrefix = safeTitle || i18nService.t('flow-chat:exportImage.fileNamePrefix');
      const fileName = `${namePrefix}_${timestampStr}.png`;
      const downloadsPath = await downloadDir();
      const filePath = await join(downloadsPath, fileName);

      const arrayBuffer = await blob.arrayBuffer();
      await writeFile(filePath, new Uint8Array(arrayBuffer));

      const plainSuccessMessage = i18nService.t('flow-chat:exportImage.exportSuccess', { filePath });
      const successPrefix = i18nService.t('flow-chat:exportImage.exportSuccessPrefix');

      const revealExportedFile = async () => {
        if (typeof window === 'undefined' || !('__TAURI__' in window)) {
          return;
        }
        try {
          await workspaceAPI.revealInExplorer(filePath);
        } catch (error) {
          log.error('Failed to reveal export path in file manager', { filePath, error });
        }
      };

      notificationService.success(plainSuccessMessage, {
        messageNode: (
          <>
            {successPrefix}
            <Button labelBehavior="static" variant="text"
              type="button"
              className="notification-item__path-link"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void revealExportedFile();
              }}
            >
              {filePath}
            </Button>
          </>
        ),
      });
    } catch (error) {
      // Ensure DOM is always cleaned up on error.
      cleanupDom();
      log.error('Export failed', error);
      notificationService.error(i18nService.t('flow-chat:exportImage.exportFailed'));
    } finally {
      isExportingRef.current = false;
      setIsExporting(false);
    }
  }, [getDialogTurn, triggerRef, turnId]);

  return (
    <>
      {renderTrigger ? renderTrigger({ isExporting, onOpenDialog: openExportDialog }) : (
        <Tooltip content={isExporting ? t('exportImage.exporting') : t('exportImage.exportToImage')} placement="top">
          <IconButton
            ref={buttonRef}
            className={`model-round-item__action-btn model-round-item__export-btn ${className}`}
            data-openbitfun-product-component="export-image"
            data-openbitfun-product-part="trigger"
            data-openbitfun-state={isExporting ? 'exporting' : undefined}
            onClick={openExportDialog}
            loading={isExporting}
            aria-haspopup="dialog"
            aria-expanded={isDialogOpen}
            aria-label={isExporting ? t('exportImage.exporting') : t('exportImage.exportToImage')}
            icon={<Icon name="image" size="sm" />}
          />
        </Tooltip>
      )}
      <Dialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        size="md"
        initialFocusRef={compactOptionRef}
        portalTarget={getAppearanceOverlayHost()}
        data-testid="export-image-dialog"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{t('exportImage.exportToImage')}</DialogTitle>
          </DialogHeading>
          <DialogClose aria-label={t('common:actions.close')} />
        </DialogHeader>
        <DialogBody>
          <div
            className="export-image-options"
            data-openbitfun-product-component="export-image"
            data-openbitfun-product-part="options"
            role="group"
            aria-label={t('exportImage.exportToImage')}
            onKeyDown={event => {
              let next: boolean;
              if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) next = !expandThinking;
              else if (event.key === 'Home') next = false;
              else if (event.key === 'End') next = true;
              else return;
              event.preventDefault();
              setExpandThinking(next);
              (next ? thinkingOptionRef : compactOptionRef).current?.focus({ preventScroll: true });
            }}
          >
            <Card
              className="export-image-option-card"
              appearance="neutral"
              padding="sm"
              data-openbitfun-product-component="export-image"
              data-openbitfun-product-part="optionCard"
              onClick={() => {
                setExpandThinking(false);
                compactOptionRef.current?.focus({ preventScroll: true });
              }}
            >
              <CardHeader actions={(
                <Checkbox
                  ref={compactOptionRef}
                  checked={!expandThinking}
                  aria-label={t('exportImage.collapsedThinking')}
                  onCheckedChange={() => setExpandThinking(false)}
                  data-testid="export-image-compact"
                />
              )} />
              <CardBody align="center" className="export-image-option-content" data-openbitfun-product-component="export-image" data-openbitfun-product-part="optionContent">
                <ExportImagePreview expandThinking={false} />
                <span className="export-image-option-label" data-openbitfun-product-component="export-image" data-openbitfun-product-part="optionLabel">{t('exportImage.collapsedThinking')}</span>
              </CardBody>
            </Card>
            <Card
              className="export-image-option-card"
              appearance="neutral"
              padding="sm"
              data-openbitfun-product-component="export-image"
              data-openbitfun-product-part="optionCard"
              onClick={() => {
                setExpandThinking(true);
                thinkingOptionRef.current?.focus({ preventScroll: true });
              }}
            >
              <CardHeader actions={(
                <Checkbox
                  ref={thinkingOptionRef}
                  checked={expandThinking}
                  aria-label={t('exportImage.expandedThinking')}
                  onCheckedChange={() => setExpandThinking(true)}
                  data-testid="export-image-thinking"
                />
              )} />
              <CardBody align="center" className="export-image-option-content" data-openbitfun-product-component="export-image" data-openbitfun-product-part="optionContent">
                <ExportImagePreview expandThinking />
                <span className="export-image-option-label" data-openbitfun-product-component="export-image" data-openbitfun-product-part="optionLabel">{t('exportImage.expandedThinking')}</span>
              </CardBody>
            </Card>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="fill" onClick={() => setIsDialogOpen(false)} data-testid="export-image-cancel">
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void handleExport(expandThinking)} disabled={isExporting} data-testid="export-image-confirm">
            {t('common:actions.export')}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
};

ExportImageButton.displayName = 'ExportImageButton';
