/**
 * BrowserPanel — embeds a browser into the AuxPane right panel.
 *
 * Uses a Tauri native Webview overlay positioned over the panel's DOM element.
 * The webview is kept attached to the main window and reused across navigations
 * so video/WebRTC surfaces are not repeatedly torn down or reparented.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { OverflowText, Icon, IconButton, Input } from '@openbitfun/ui';
import { AlertTriangle, LoaderCircle, MousePointer2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { createLogger } from '@/shared/utils/logger';
import { useContextStore } from '@/shared/context-system';
import type { WebElementContext } from '@/shared/types/context';
import { createInspectorScript, CANCEL_INSPECTOR_SCRIPT } from './browserInspectorScript';
import { useEmbeddedBrowserWebview } from './useEmbeddedBrowserWebview';
import { BrowserPreview } from './BrowserPreview';
import './BrowserPanel.scss';

const log = createLogger('BrowserPanel');
const DEFAULT_URL = 'https://openbitfun.com/';

interface InspectorElementData {
  tagName: string;
  path: string;
  attributes: Record<string, string>;
  textContent: string;
  outerHTML: string;
}

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
  const addContext = useContextStore((s) => s.addContext);
  const inspectorUnlistenRef = useRef<(() => void) | null>(null);
  const [isInspectorActive, setIsInspectorActive] = useState(false);

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
    evalInWebview,
    getCurrentUrl,
    getWebviewLabel,
    goBack,
    goForward,
    hasWebview,
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

  const stopInspector = useCallback(() => {
    if (getWebviewLabel()) {
      void evalInWebview(CANCEL_INSPECTOR_SCRIPT).catch(() => {});
    }
    inspectorUnlistenRef.current?.();
    inspectorUnlistenRef.current = null;
    setIsInspectorActive(false);
  }, [evalInWebview, getWebviewLabel]);

  const loadPanelUrl = useCallback(async (rawUrl: string) => {
    stopInspector();
    await loadUrl(rawUrl);
  }, [loadUrl, stopInspector]);

  useEffect(() => () => {
    stopInspector();
  }, [stopInspector]);

  const handleSubmit = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void loadPanelUrl(inputValue);
  }, [inputValue, loadPanelUrl]);

  const handleInspector = useCallback(async () => {
    if (!isTauri || !hasWebview()) return;

    if (isInspectorActive) {
      stopInspector();
      return;
    }

    const label = getWebviewLabel();
    if (!label) return;

    try {
      const { listen } = await import('@tauri-apps/api/event');

      const eventSelected = `browser-inspector-element-selected-${label}`;
      const eventCancelled = `browser-inspector-cancelled-${label}`;

      const unlistenSelected = await listen<InspectorElementData>(
        eventSelected,
        (event) => {
          const data = event.payload;
          const context: WebElementContext = {
            id: `web-element-${Date.now()}`,
            type: 'web-element',
            timestamp: Date.now(),
            tagName: data.tagName,
            path: data.path,
            attributes: data.attributes,
            textContent: data.textContent,
            outerHTML: data.outerHTML,
            sourceUrl: getCurrentUrl(),
          };

          addContext(context);
          window.dispatchEvent(
            new CustomEvent('insert-context-tag', { detail: { context } }),
          );
        },
      );

      const unlistenCancelled = await listen(
        eventCancelled,
        () => {
          unlistenSelected();
          unlistenCancelled();
          inspectorUnlistenRef.current = null;
          setIsInspectorActive(false);
        },
      );

      inspectorUnlistenRef.current = () => {
        unlistenSelected();
        unlistenCancelled();
      };

      await evalInWebview(createInspectorScript(label));
      setIsInspectorActive(true);
    } catch (inspectorError) {
      log.error('Start inspector failed', inspectorError);
      setIsInspectorActive(false);
    }
  }, [addContext, evalInWebview, getCurrentUrl, getWebviewLabel, hasWebview, isInspectorActive, isTauri, stopInspector]);

  return (
    <div data-openbitfun-component="browser-panel" data-openbitfun-part="root" data-openbitfun-state={isLoading ? 'loading' : ''} className="browser-panel" data-testid="browser-panel">
      <form data-openbitfun-component="browser-panel" data-openbitfun-part="toolbar" className="browser-panel__toolbar" onSubmit={handleSubmit} data-testid="browser-panel-title">
        <IconButton
          type="button"
          size="sm"
          onClick={goBack}
          aria-label={t('nav.back')}
          icon={<Icon name="chevron-left" size="lg" />}
          data-testid="browser-back-button"
        />
        <IconButton
          type="button"
          size="sm"
          onClick={goForward}
          aria-label={t('nav.forward')}
          icon={<Icon name="chevron-right" size="lg" />}
          data-testid="browser-forward-button"
        />
        <IconButton
          type="button"
          size="sm"
          onClick={isLoading ? stopLoading : reload}
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
            {!browser.previewUrl && (
              <div data-openbitfun-component="browser-panel" data-openbitfun-part="placeholder" className="browser-panel__webview-placeholder">
                <Icon name="browser" size="lg" />
                <OverflowText data-testid="browser-current-url">{currentUrl}</OverflowText>
              </div>
            )}
            <BrowserPreview src={browser.previewUrl} bounds={browser.previewBounds} />
          </div>
        )}
      </div>
    </div>
  );
};

export default BrowserPanel;
