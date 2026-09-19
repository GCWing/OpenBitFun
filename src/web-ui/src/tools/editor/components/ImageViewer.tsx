import { useEditorDocument } from '../services/EditorDocument';
import { standaloneEditorFileAccess } from '../services/editorFileAccess';
/**
 * Image Viewer Component
 * 
 * Previews image files in the editor.
 * @module components/ImageViewer
 */

import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { ZoomIn, ZoomOut, RotateCw, Maximize2 } from 'lucide-react';
import { Portal, OverflowText, Button, Icon, IconButton, Toolbar, ToolbarGroup, ToolbarSeparator, Tooltip } from '@openbitfun/ui';
import { createLogger } from '@/shared/utils/logger';

import { useI18n } from '@/infrastructure/i18n';
import { formatBytes } from '@/shared/utils/format';
import './ImageViewer.scss';

const log = createLogger('ImageViewer');

export interface ImageViewerProps {
  /** Image file path */
  filePath: string;
  isActiveTab?: boolean;
  /** File name */
  fileName?: string;
  /** Owning workspace ID for viewers rendered without an EditorDocument. */
  workspaceId?: string;
  /** Workspace path (for relative path resolution) */
  workspacePath?: string;
  /** CSS class name */
  className?: string;
  /** Immutable bytes supplied by a session provider; never read filePath locally. */
  imageSource?: { dataUrl: string; size: number };
}

export const ImageViewer: React.FC<ImageViewerProps> = ({
  filePath,
  fileName,
  imageSource,
  workspaceId,
  isActiveTab = true,
  className = ''
}) => {
  const documentSession = useEditorDocument();
  const standaloneFiles = useMemo(() => standaloneEditorFileAccess(workspaceId), [workspaceId]);
  const documentFiles = documentSession?.files ?? standaloneFiles;
  const { t } = useI18n('tools');
  const [retryKey, setRetryKey] = useState(0);
  const [imageUrl, setImageUrl] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const expanded = isFullscreen && isActiveTab;
  const wasExpanded = useRef(false);
  useLayoutEffect(() => {
    if (wasExpanded.current && !expanded && isActiveTab) fullscreenButtonRef.current?.focus({ preventScroll: true });
    wasExpanded.current = expanded;
  }, [expanded, isActiveTab]);
  const [loadedOrigin, setLoadedOrigin] = useState<{ filePath: string; imageSource: typeof imageSource; documentSession: typeof documentSession }>();
  const originCurrent = loadedOrigin?.filePath === filePath && loadedOrigin.imageSource === imageSource && loadedOrigin.documentSession === documentSession;
  const [fileSize, setFileSize] = useState<number>(0);

  const getMimeType = useCallback((path: string): string => {
    const ext = path.toLowerCase().split('.').pop();
    const mimeTypes: Record<string, string> = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'bmp': 'image/bmp',
      'webp': 'image/webp',
      'svg': 'image/svg+xml',
      'ico': 'image/x-icon',
      'avif': 'image/avif'
    };
    return mimeTypes[ext || ''] || 'image/jpeg';
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadedOrigin({ filePath, imageSource, documentSession });
    setImageUrl('');
    setImageDimensions(null);
    if (imageSource) {
      setImageUrl(imageSource.dataUrl);
      setFileSize(imageSource.size);
      setError(null);
      setLoading(false);
      return;
    }
    if (filePath.startsWith('dispatch-file://')) {
      setImageUrl('');
      setError(t('editor.imageViewer.filePathEmpty'));
      setLoading(false);
      return;
    }
    const loadImage = async () => {
      if (!filePath) {
        setError(t('editor.imageViewer.filePathEmpty'));
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);

        const result = await documentFiles.readFileContent(filePath);

        if (cancelled) return;
        const mimeType = getMimeType(filePath);

        const dataUrl = `data:${mimeType};base64,${result}`;
        
        setImageUrl(dataUrl);
        setFileSize(Math.floor(result.length * 3 / 4) - (result.endsWith('==') ? 2 : result.endsWith('=') ? 1 : 0));
        setLoading(false);
        
      } catch (err) {
        if (cancelled) return;
        log.error('Failed to load image', err);
        setError(t('editor.imageViewer.loadImageFailedWithMessage', { message: String(err) }));
        setLoading(false);
      }
    };

    void loadImage();
    return () => { cancelled = true; };
  }, [filePath, getMimeType, imageSource, t, documentFiles, documentSession, retryKey]);

  const errorRef = useRef(error);
  errorRef.current = error;
  useEffect(() => {
    // Retry on reactivation, not on each failure (which would loop forever).
    if (isActiveTab && errorRef.current && documentSession?.isCurrent()) setRetryKey(key => key + 1);
  }, [documentSession, isActiveTab]);

  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    
    setImageDimensions({
      width: img.naturalWidth,
      height: img.naturalHeight
    });
  }, []);

  const handleImageError = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    log.error('Image load error', { filePath, srcLength: e.currentTarget.src.length });
    setError(t('editor.imageViewer.decodeFailed'));
    setLoading(false);
  }, [filePath, t]);

  const handleZoomIn = useCallback(() => {
    setZoom(prev => Math.min(prev + 25, 500));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom(prev => Math.max(prev - 25, 25));
  }, []);

  const handleZoomReset = useCallback(() => {
    setZoom(100);
  }, []);

  const handleRotate = useCallback(() => {
    setRotation(prev => (prev + 90) % 360);
  }, []);

  const handleDownload = useCallback(async () => {
    try {
      const name = fileName || filePath.split(/[/\\]/).pop() || 'image';
      const link = document.createElement('a');
      link.href = imageUrl;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      log.error('Failed to download image', err);
    }
  }, [imageUrl, fileName, filePath]);

  const handleToggleFullscreen = useCallback(() => {
    setIsFullscreen(prev => !prev);
  }, []);

  const content = (
    <div
      ref={surfaceRef}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded || undefined}
      aria-label={expanded ? fileName || filePath : undefined}
      tabIndex={expanded ? -1 : undefined}
      data-openbitfun-native-webview-occlusion={expanded || undefined}
      className={`openbitfun-image-viewer ${className} ${expanded ? 'fullscreen' : ''}`}
      data-openbitfun-component="image-viewer"
      data-openbitfun-part="root"
      data-openbitfun-state={expanded ? 'fullscreen' : undefined}
    >
      <Toolbar
        className="openbitfun-image-viewer__toolbar"
        leading={
          <div data-openbitfun-component="image-viewer" data-openbitfun-part="info" className="openbitfun-image-viewer__info">
            <OverflowText className="openbitfun-image-viewer__filename">{fileName || filePath.split(/[/\\]/).pop()}</OverflowText>
            {originCurrent && imageDimensions && (
              <span className="openbitfun-image-viewer__dimensions">
                {imageDimensions.width} × {imageDimensions.height}
              </span>
            )}
            {originCurrent && fileSize > 0 && (
              <span className="openbitfun-image-viewer__filesize">
                {formatBytes(fileSize)}
              </span>
            )}
          </div>
        }
        trailing={
          <>
            <ToolbarGroup>
              <Tooltip content={t('editor.imageViewer.zoomOut')} placement="top">
                <IconButton
                  aria-label={t('editor.imageViewer.zoomOut')}
                  size="sm"
                  variant="quiet"
                  icon={<ZoomOut size={14} />}
                  onClick={handleZoomOut}
                  disabled={zoom <= 25}
                />
              </Tooltip>
              <Tooltip content={t('editor.imageViewer.zoomReset')} placement="top">
                <Button
                  size="sm"
                  variant="text"
                  className="openbitfun-image-viewer__zoom-display"
                  onClick={handleZoomReset}
                >
                  {zoom}%
                </Button>
              </Tooltip>
              <Tooltip content={t('editor.imageViewer.zoomIn')} placement="top">
                <IconButton
                  aria-label={t('editor.imageViewer.zoomIn')}
                  size="sm"
                  variant="quiet"
                  icon={<ZoomIn size={14} />}
                  onClick={handleZoomIn}
                  disabled={zoom >= 500}
                />
              </Tooltip>
            </ToolbarGroup>
            <ToolbarSeparator />
            <ToolbarGroup>
              <Tooltip content={t('editor.imageViewer.rotate90')} placement="top">
                <IconButton
                  aria-label={t('editor.imageViewer.rotate90')}
                  size="sm"
                  variant="quiet"
                  icon={<RotateCw size={14} />}
                  onClick={handleRotate}
                />
              </Tooltip>
              <Tooltip content={t('editor.imageViewer.download')} placement="top">
                <IconButton
                  aria-label={t('editor.imageViewer.download')}
                  size="sm"
                  variant="quiet"
                  icon={<Icon name="arrow-down" size="sm" />}
                  onClick={handleDownload}
                  disabled={!originCurrent || loading || Boolean(error) || !imageUrl}
                />
              </Tooltip>
              <Tooltip
                content={isFullscreen ? t('editor.imageViewer.exitFullscreen') : t('editor.imageViewer.enterFullscreen')}
                placement="top"
              >
                <IconButton
                  ref={fullscreenButtonRef}
                  aria-label={isFullscreen ? t('editor.imageViewer.exitFullscreen') : t('editor.imageViewer.enterFullscreen')}
                  size="sm"
                  variant="quiet"
                  icon={<Maximize2 size={14} />}
                  onClick={handleToggleFullscreen}
                />
              </Tooltip>
            </ToolbarGroup>
          </>
        }
      />

      <div data-openbitfun-component="image-viewer" data-openbitfun-part="container" className="openbitfun-image-viewer__container">
        {(!originCurrent || loading) && (
          <div data-openbitfun-component="image-viewer" data-openbitfun-part="loading" className="openbitfun-image-viewer__loading">
            <div className="openbitfun-image-viewer__spinner" />
            <p>{t('editor.common.loading')}</p>
          </div>
        )}

        {originCurrent && error && (
          <div data-openbitfun-component="image-viewer" data-openbitfun-part="error" className="openbitfun-image-viewer__error">
            <p>{error}</p>
            <p className="openbitfun-image-viewer__error-path">{filePath}</p>
          </div>
        )}

        {originCurrent && !loading && !error && imageUrl && (
          <div data-openbitfun-component="image-viewer" data-openbitfun-part="imageWrapper" className="openbitfun-image-viewer__image-wrapper">
            <img
              src={imageUrl}
              alt={fileName || filePath}
              className="openbitfun-image-viewer__image"
              data-openbitfun-component="image-viewer"
              data-openbitfun-part="image"
              style={{
                transform: `scale(${zoom / 100}) rotate(${rotation}deg)`,
              }}
              onLoad={handleImageLoad}
              onError={handleImageError}
            />
          </div>
        )}
        
        {originCurrent && !loading && !error && !imageUrl && (
          <div data-openbitfun-component="image-viewer" data-openbitfun-part="error" className="openbitfun-image-viewer__error">
            <p>{t('editor.imageViewer.imageUrlEmpty')}</p>
          </div>
        )}
      </div>
    </div>
  );
  return expanded ? <Portal modal surfaceRef={surfaceRef} onDismiss={() => setIsFullscreen(false)}>{content}</Portal> : content;
};

export default ImageViewer;
