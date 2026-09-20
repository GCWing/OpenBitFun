/**
 * Export dialog turns as long images.
 * Uses React rendering to match FlowChat styles.
 * Uses modern-screenshot (fork of html-to-image with better CSS var / font / CORS handling).
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { FlowChatStore } from '../../store/FlowChatStore';
import { notificationService } from '@/shared/notification-system';
import { FlowTextBlock } from '../FlowTextBlock';
import { FlowToolCard } from '../FlowToolCard';
import { subscribeOverlayInteraction, createOverlayPortal, Button, Icon, IconButton, Menu, MenuItem, Tooltip } from '@openbitfun/ui';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import type { DialogTurn, FlowTextItem, FlowToolItem, FlowThinkingItem } from '../../types/flow-chat';
import { i18nService, useI18n } from '@/infrastructure/i18n';
import { workspaceAPI } from '@/infrastructure/api';
import { createLogger } from '@/shared/utils/logger';
import { getBuiltinAppearanceThemeToken } from '@/infrastructure/appearance/builtins/catalog';
import { withTimeout } from '@/shared/utils/timing';
import { downloadDir, join } from '@tauri-apps/api/path';
import { writeFile } from '@tauri-apps/plugin-fs';
import { ModelThinkingDisplay } from '../../tool-cards/ModelThinkingDisplay';
import './ExportImageButton.scss';

const log = createLogger('ExportImageButton');

// Lazy-load modern-screenshot.
const loadModernScreenshot = () => import('modern-screenshot');

/** Maximum time to wait for capture before aborting (ms). */
const CAPTURE_TIMEOUT_MS = 15_000;

/** Minimum time to wait for React render before capture (ms). */
const MIN_RENDER_WAIT_MS = 300;

/** Additional time per model-round item for complex content (ms). */
const PER_ROUND_WAIT_MS = 80;

/** Maximum total render wait time (ms). */
const MAX_RENDER_WAIT_MS = 2_000;

/** Collect ALL CSS custom properties from document :root so the offscreen
 *  render inherits the full appearance (fonts, radii, shadows, spacing, etc.).
 *  modern-screenshot resolves var() by cloning computed styles, but
 *  variables used inside the captured subtree must still be available on
 *  the wrapper element for correct initial layout. */
function collectAllCssVariables(): Record<string, string> {
  const vars: Record<string, string> = {};
  const computedStyle = getComputedStyle(document.documentElement);
  for (let i = 0; i < computedStyle.length; i++) {
    const prop = computedStyle[i];
    if (prop.startsWith('--')) {
      const value = computedStyle.getPropertyValue(prop).trim();
      if (value) {
        vars[prop] = value;
      }
    }
  }
  return vars;
}

/** Validate that a data-URL is not blank/corrupt. */
function validateDataUrl(dataUrl: string): void {
  if (!dataUrl || dataUrl === 'data:,' || dataUrl.length < 100) {
    throw new Error('Capture returned empty or corrupt image data');
  }
}

interface ExportImageButtonProps {
  turnId: string;
  className?: string;
}

// Exported content renderer.
interface ExportContentProps {
  dialogTurn: DialogTurn;
  expandThinking: boolean;
}

// Marker class on the logo placeholder so we can locate it for canvas compositing.
const LOGO_PLACEHOLDER_CLASS = 'export-content__logo-placeholder';

const ExportContent: React.FC<ExportContentProps> = ({ dialogTurn, expandThinking }) => {
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
        <div className="export-content__title-group" data-openbitfun-product-component="export-image" data-openbitfun-product-part="title">
          <div className="export-content__title">OpenBitFun</div>
          <div className="export-content__subtitle">{i18nService.t('flow-chat:exportImage.subtitle').replace(/ /g, '\u00A0')}</div>
        </div>
        <div className="export-content__timestamp" data-openbitfun-product-component="export-image" data-openbitfun-product-part="timestamp">
          {i18nService.formatDate(new Date())}
        </div>
      </div>

      {dialogTurn.userMessage?.content && (
        <div className="export-content__user-section" data-openbitfun-product-component="export-image" data-openbitfun-product-part="user">
          <div className="export-content__user-bubble">
            {dialogTurn.userMessage.content}
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
                  const thinkingItem = item as FlowThinkingItem;
                  return (
                    <div data-openbitfun-product-component="export-image" data-openbitfun-product-part="thinking" key={item.id} className={`export-content__thinking-item${expandThinking ? ' export-content__thinking-item--expanded' : ''}`}>
                      <ModelThinkingDisplay 
                        thinkingItem={{
                          ...thinkingItem,
                          isStreaming: false,
                        }}
                        isLastItem={false}
                        forceExpanded={expandThinking}
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
        <span>{i18nService.t('flow-chat:exportImage.poweredBy').replace(/ /g, '\u00A0')}</span>
        <span className="export-content__footer-brand">OpenBitFun</span>
        <span>•</span>
        <span>{i18nService.t('flow-chat:exportImage.aiAssistant').replace(/ /g, '\u00A0')}</span>
      </div>
    </div>
  );
};

export const ExportImageButton: React.FC<ExportImageButtonProps> = ({
  turnId,
  className = ''
}) => {
  const { t } = useI18n('flow-chat');
  const [isExporting, setIsExporting] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuLayout = useAnchoredPopoverPosition({
    open: isMenuOpen,
    anchorRef: buttonRef,
    popoverRef: menuRef,
    preferredPlacement: 'top',
    alignment: 'end',
    gap: 4,
  });

  useEffect(() => {
    if (!isMenuOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setIsMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsMenuOpen(false);
    };
    const removeOverlayMousedown0 = subscribeOverlayInteraction(menuRef, 'mousedown', handleClickOutside);
    const removeOverlayKeydown1 = subscribeOverlayInteraction(menuRef, 'keydown', handleKeyDown);
    return () => {
      removeOverlayMousedown0?.();
      removeOverlayKeydown1?.();
    };
  }, [isMenuOpen]);
  // Ref guard to prevent double-invocation while state update is pending.
  const isExportingRef = useRef(false);

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
    setIsMenuOpen(false);
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
      // Use left: -9999px (not z-index: -9999) so elements remain visible to capture.
      wrapper = document.createElement('div');
      wrapper.id = 'export-image-wrapper';
      wrapper.className = 'export-image-wrapper';

      // Measure the actual chat pane width so the exported image uses the
      // exact same text-wrap width as the live chat. Fallback to 1200px.
      const chatPane = document.querySelector('.openbitfun-chat-pane__content');
      const chatWidth = chatPane?.getBoundingClientRect().width || 1200;

      wrapper.style.cssText = `
        position: absolute;
        left: -9999px;
        top: 0;
        z-index: -9999;
        pointer-events: none;
        background: ${bgColor};
        visibility: visible;
        opacity: 1;
        overflow: visible;
        width: ${chatWidth}px;
      `;
      
      // Copy ALL CSS variables for consistent styling.
      const allVars = collectAllCssVariables();
      for (const [varName, value] of Object.entries(allVars)) {
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
      const container = wrapper.querySelector('.export-content') as HTMLElement;

      // Match the export width exactly to the live chat pane so text wrapping
      // is identical. SCSS sets a fixed width; override it here dynamically.
      container.style.width = `${chatWidth}px`;
      container.style.maxWidth = 'none';
      
      if (!container) {
        throw new Error(i18nService.t('flow-chat:exportImage.containerNotFound'));
      }
      
      // Yield to the main thread so the browser can finish layout/paint.
      await new Promise(resolve => setTimeout(resolve, 0));

      // Capture the logo placeholder position (relative to the container)
      // BEFORE the DOM is torn down, so we can composite the logo precisely
      // onto the final image.
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

      // Generate image via modern-screenshot with timeout guard.
      const modernScreenshot = await loadModernScreenshot();
      
      // Yield again before capture.
      await new Promise(resolve => setTimeout(resolve, 0));
      
      const pixelRatio = 2;
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

      const captureOptions = {
        quality: 1,
        scale: pixelRatio,
        backgroundColor: bgColor,
        fetch: {
          bypassingCache: true,
        } as const,
        filter: captureFilter,
        // Disable font embedding to avoid cross-origin stylesheet issues;
        // the offscreen DOM already has system fonts available.
        font: false as const,
        features: {
          removeControlCharacter: true,
          fixSvgXmlDecode: true,
        } as const,
      };

      let baseDataUrl: string;

      // Strategy 1: domToPng (primary)
      try {
        baseDataUrl = await withTimeout(
          modernScreenshot.domToPng(container, captureOptions),
          CAPTURE_TIMEOUT_MS,
          'domToPng capture',
          cleanupDom,
        );
        validateDataUrl(baseDataUrl);
      } catch (e1) {
        log.warn('domToPng failed, trying domToBlob fallback', e1);
        // Ensure DOM is still alive for fallback.
        if (!wrapper || !wrapper.parentNode) {
          throw new Error('DOM was cleaned up before fallback could run');
        }

        // Strategy 2: domToBlob (fallback)
        try {
          const fallbackBlob = await withTimeout(
            modernScreenshot.domToBlob(container, { ...captureOptions, type: 'image/png' }),
            CAPTURE_TIMEOUT_MS,
            'domToBlob capture',
            cleanupDom,
          );
          if (!fallbackBlob) throw new Error(i18nService.t('flow-chat:exportImage.generateFailed'));
          baseDataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(fallbackBlob);
          });
          validateDataUrl(baseDataUrl);
        } catch (e2) {
          log.warn('domToBlob fallback also failed, trying reduced scale', e2);
          // Ensure DOM is still alive for second fallback.
          if (!wrapper || !wrapper.parentNode) {
            throw new Error('DOM was cleaned up before reduced-scale fallback could run');
          }

          // Strategy 3: domToPng with scale=1 (reduced memory for large DOMs)
          const reducedOptions = { ...captureOptions, scale: 1 };
          baseDataUrl = await withTimeout(
            modernScreenshot.domToPng(container, reducedOptions),
            CAPTURE_TIMEOUT_MS,
            'domToPng reduced-scale capture',
            cleanupDom,
          );
          validateDataUrl(baseDataUrl);
        }
      }

      // Cleanup the offscreen DOM as soon as we have the base capture.
      cleanupDom();

      // Composite the logo onto the captured image so it always appears,
      // regardless of capture library behavior with <img> elements.
      const blob: Blob | null = await new Promise<Blob | null>((resolve, reject) => {
        const baseImg = new window.Image();
        baseImg.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = baseImg.naturalWidth;
            canvas.height = baseImg.naturalHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) { reject(new Error('no canvas ctx for compositing')); return; }
            ctx.drawImage(baseImg, 0, 0);

            if (logoImage && logoBox) {
              const dx = logoBox.x * pixelRatio;
              const dy = logoBox.y * pixelRatio;
              const dw = logoBox.w * pixelRatio;
              const dh = logoBox.h * pixelRatio;
              const dr = logoBox.radius * pixelRatio;

              ctx.save();
              if (dr > 0) {
                const path = new Path2D();
                const r = Math.min(dr, dw / 2, dh / 2);
                path.moveTo(dx + r, dy);
                path.lineTo(dx + dw - r, dy);
                path.quadraticCurveTo(dx + dw, dy, dx + dw, dy + r);
                path.lineTo(dx + dw, dy + dh - r);
                path.quadraticCurveTo(dx + dw, dy + dh, dx + dw - r, dy + dh);
                path.lineTo(dx + r, dy + dh);
                path.quadraticCurveTo(dx, dy + dh, dx, dy + dh - r);
                path.lineTo(dx, dy + r);
                path.quadraticCurveTo(dx, dy, dx + r, dy);
                path.closePath();
                ctx.clip(path);
              }
              ctx.imageSmoothingEnabled = true;
              ctx.imageSmoothingQuality = 'high';
              ctx.drawImage(logoImage, dx, dy, dw, dh);
              ctx.restore();
            } else {
              log.warn('Logo overlay skipped', { hasLogo: !!logoImage, hasBox: !!logoBox });
            }

            canvas.toBlob((b) => resolve(b), 'image/png');
          } catch (err) {
            reject(err);
          }
        };
        baseImg.onerror = reject;
        baseImg.src = baseDataUrl;
      });

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
  }, [getDialogTurn]);

  return (
    <>
      <Tooltip content={isExporting ? i18nService.t('flow-chat:exportImage.exporting') : i18nService.t('flow-chat:exportImage.exportToImage')} placement="top">
        <IconButton
          ref={buttonRef}
          className={`model-round-item__action-btn model-round-item__export-btn ${className}`}
          data-openbitfun-product-component="export-image"
          data-openbitfun-product-part="trigger"
          data-openbitfun-state={isExporting ? 'exporting' : undefined}
          onClick={() => setIsMenuOpen(current => !current)}
          disabled={isExporting}
          aria-haspopup="menu"
          aria-expanded={isMenuOpen}
          aria-label={isExporting
            ? i18nService.t('flow-chat:exportImage.exporting')
            : i18nService.t('flow-chat:exportImage.exportToImage')}
          icon={isExporting
            ? <Icon name="progress-25" size="sm" className="spinning" />
            : <Icon name="image" size="sm" />}
        />
      </Tooltip>
      {isMenuOpen && createOverlayPortal(
        <Menu
          ref={menuRef}
          className="export-image-menu"
          data-openbitfun-placement={menuLayout?.placement ?? 'top'}
          style={{
            top: `${menuLayout?.top ?? 0}px`,
            left: `${menuLayout?.left ?? 0}px`,
            visibility: menuLayout ? 'visible' : 'hidden',
          }}
        >
          <MenuItem type="button" onClick={() => void handleExport(false)}>
            {t('exportImage.collapsedThinking')}
          </MenuItem>
          <MenuItem type="button" onClick={() => void handleExport(true)}>
            {t('exportImage.expandedThinking')}
          </MenuItem>
        </Menu>,
        getAppearanceOverlayHost(),
      )}
    </>
  );
};

ExportImageButton.displayName = 'ExportImageButton';
