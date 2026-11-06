/**
 * BrowserPanel — embeds a browser into the AuxPane right panel.
 *
 * Presents a retained Tauri browser as a native child or an offscreen canvas.
 */

import React, { useCallback } from 'react';
import { OverflowText, Icon, IconButton, Input } from '@openbitfun/ui';
import { AlertTriangle, LoaderCircle, MousePointer2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { createLogger } from '@/shared/utils/logger';
import { useBrowserInspector } from './useBrowserInspector';
import { useEmbeddedBrowserWebview } from './useEmbeddedBrowserWebview';
import { BrowserPreview } from './BrowserPreview';
import { BrowserOffscreenSurface } from './BrowserOffscreenSurface';
import './BrowserPanel.scss';

const log = createLogger('BrowserPanel');
const DEFAULT_URL = 'https://openbitfun.com/';

export interface BrowserPanelProps {
  /** Whether this panel is the active tab in the EditorGroup */
  isActive: boolean;
  /** Optional initial URL (falls back to DEFAULT_URL) */
  initialUrl?: string;
  /** Correlates a host open request with this exact native WebView target. */
  openRequestId?: string;
  /** Native target retained by the session while this panel is unmounted. */
  targetId?: string;
  conversationId?: string;
}

const BrowserPanel: React.FC<BrowserPanelProps> = ({ isActive, initialUrl, openRequestId, targetId, conversationId }) => {
  const { t } = useTranslation('common');
  const browser = useEmbeddedBrowserWebview({
    defaultUrl: DEFAULT_URL,
    initialUrl,
    isVisible: isActive,
    labelPrefix: 'embedded-browser-panel-view',
    log,
    openRequestId,
    targetId,
    conversationId,
  });

  const {
    currentUrl,
    error,
    goBack,
    goForward,
    inputValue,
    isLoading,
    isTauri,
    loadUrl,
    reload,
    setInputValue,
    stopLoading,
    viewportRef,
    webviewLabel,
  } = browser;

  const { isInspectorActive, handleInspector, stopInspector } = useBrowserInspector(browser, isActive);
  const handleSubmit = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    stopInspector();
    void loadUrl(inputValue);
  }, [inputValue, loadUrl, stopInspector]);

  return (
    <div data-openbitfun-component="browser-panel" data-openbitfun-part="root" data-openbitfun-state={isLoading ? 'loading' : ''} className="browser-panel" data-testid="browser-panel">
      <form data-openbitfun-component="browser-panel" data-openbitfun-part="toolbar" className="browser-panel__toolbar" onSubmit={handleSubmit} data-testid="browser-panel-title">
        <IconButton
          type="button"
          size="sm"
          onClick={() => { stopInspector(); goBack(); }}
          aria-label={t('nav.back')}
          icon={<Icon name="chevron-left" size="lg" />}
          data-testid="browser-back-button"
        />
        <IconButton
          type="button"
          size="sm"
          onClick={() => { stopInspector(); goForward(); }}
          aria-label={t('nav.forward')}
          icon={<Icon name="chevron-right" size="lg" />}
          data-testid="browser-forward-button"
        />
        <IconButton
          type="button"
          size="sm"
          onClick={() => {
            stopInspector();
            (isLoading ? stopLoading : reload)();
          }}
          aria-label={isLoading ? t('browserView.stopLoading') : t('actions.refresh')}
          icon={<Icon name={isLoading ? 'xmark' : 'refresh'} size="lg" />}
          data-testid="browser-refresh-button"
        />
        <div data-openbitfun-component="browser-panel" data-openbitfun-part="address" className="browser-panel__address">
          <Input
            className="browser-panel__address-field"
            type="text"
            value={inputValue}
            onValueChange={setInputValue}
            leading={isLoading
              ? <Icon glyph={LoaderCircle} size="md" className="browser-panel__spinning" data-testid="browser-loading-indicator" />
              : <Icon name="browser" size="md" />}
            placeholder={t('browserView.addressPlaceholder', { exampleUrl: 'https://example.com' })}
            spellCheck={false}
            data-testid="browser-url-input"
          />
        </div>
        {isTauri && (
          <IconButton
            type="button"
            size="sm"
            onClick={() => void handleInspector()}
            aria-label={isInspectorActive ? t('browserView.stopElementSelection') : t('browserView.startElementSelection')}
            aria-pressed={isInspectorActive}
            className={isInspectorActive ? 'browser-panel__inspector-btn--active' : undefined}
            icon={<MousePointer2 />}
          />
        )}
      </form>

      {error ? (
        <div data-openbitfun-component="browser-panel" data-openbitfun-part="error" className="browser-panel__error" data-testid="browser-error-message">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      ) : null}

      <div data-openbitfun-component="browser-panel" data-openbitfun-part="content" className="browser-panel__content" data-testid="browser-page-frame">
        {!isTauri ? (
          <iframe
            data-openbitfun-component="browser-panel"
            data-openbitfun-part="iframe"
            className="browser-panel__iframe"
            src={currentUrl}
            title="Embedded Browser Panel"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
          />
        ) : (
          <div
            ref={viewportRef}
            data-openbitfun-component="browser-panel"
            data-openbitfun-part="webviewHost"
            className="browser-panel__webview-host"
            data-webview-label={webviewLabel}
          >
            {!browser.previewUrl && !browser.offscreenLabel && (
              <div data-openbitfun-component="browser-panel" data-openbitfun-part="placeholder" className="browser-panel__webview-placeholder">
                <Icon name="browser" size="lg" />
                <OverflowText data-testid="browser-current-url">{currentUrl}</OverflowText>
              </div>
            )}
            {browser.offscreenLabel ? (
              <BrowserOffscreenSurface
                key={browser.offscreenLabel}
                label={browser.offscreenLabel}
                sharedTexture={browser.offscreenGpu}
                title={currentUrl}
                active={isActive && browser.offscreenVisible}
                inspecting={isInspectorActive}
                onCancelInspection={stopInspector}
                onError={browser.reportPresentationError}
              />
            ) : <BrowserPreview src={browser.previewUrl} bounds={browser.previewBounds} />}
          </div>
        )}
      </div>
    </div>
  );
};

export default BrowserPanel;
