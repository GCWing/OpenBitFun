import React, { useCallback } from 'react';
import { OverflowText, Icon, IconButton, Input } from '@openbitfun/ui';
import { AlertTriangle, LoaderCircle, MousePointer2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { createLogger } from '@/shared/utils/logger';
import { useSceneStore } from '@/app/stores/sceneStore';
import { useBrowserInspector } from './useBrowserInspector';
import { useEmbeddedBrowserWebview } from './useEmbeddedBrowserWebview';
import { BrowserOffscreenSurface } from './BrowserOffscreenSurface';
import { BrowserPreview } from './BrowserPreview';
import './BrowserScene.scss';

const log = createLogger('BrowserScene');
const DEFAULT_URL = 'https://openbitfun.com/';

const BrowserScene: React.FC = () => {
  const { t } = useTranslation('common');
  const activeTabId = useSceneStore((state) => state.activeTabId);
  const isActive = activeTabId === 'browser';
  const browser = useEmbeddedBrowserWebview({
    defaultUrl: DEFAULT_URL,
    isVisible: isActive,
    labelPrefix: 'embedded-browser-view',
    log,
  });

  const { isInspectorActive, handleInspector, stopInspector } = useBrowserInspector(browser, isActive);
  const handleSubmit = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    stopInspector();
    void browser.loadUrl(browser.inputValue);
  }, [browser, stopInspector]);

  return (
    <div
      className="browser-scene"
      data-testid="browser-panel"
      data-openbitfun-scene="browser"
      data-openbitfun-part="root"
      data-openbitfun-state={browser.isLoading ? 'loading' : undefined}
    >
      <form
        className="browser-scene__toolbar"
        onSubmit={handleSubmit}
        data-testid="browser-panel-title"
        data-openbitfun-scene="browser"
        data-openbitfun-part="toolbar"
      >
        <IconButton
          type="button"
          size="sm"
          onClick={() => { stopInspector(); browser.goBack(); }}
          aria-label={t('nav.back')}
          icon={<Icon name="chevron-left" size="lg" />}
          data-testid="browser-back-button"
        />
        <IconButton
          type="button"
          size="sm"
          onClick={() => { stopInspector(); browser.goForward(); }}
          aria-label={t('nav.forward')}
          icon={<Icon name="chevron-right" size="lg" />}
          data-testid="browser-forward-button"
        />
        <IconButton
          type="button"
          size="sm"
          onClick={() => {
            stopInspector();
            (browser.isLoading ? browser.stopLoading : browser.reload)();
          }}
          aria-label={browser.isLoading ? t('browserView.stopLoading') : t('actions.refresh')}
          icon={<Icon name={browser.isLoading ? 'xmark' : 'refresh'} size="lg" />}
          data-testid="browser-refresh-button"
        />
        <div className="browser-scene__address">
          <Input
            className="browser-scene__address-field"
            type="text"
            value={browser.inputValue}
            onValueChange={browser.setInputValue}
            leading={browser.isLoading
              ? <Icon glyph={LoaderCircle} size="md" className="browser-scene__spinning" data-testid="browser-loading-indicator" />
              : <Icon name="browser" size="md" />}
            placeholder={t('browserView.addressPlaceholder', { exampleUrl: 'https://example.com' })}
            spellCheck={false}
            data-testid="browser-url-input"
          />
        </div>
        {browser.isTauri && (
          <IconButton
            type="button"
            size="sm"
            onClick={() => void handleInspector()}
            aria-label={isInspectorActive ? t('browserView.stopElementSelection') : t('browserView.startElementSelection')}
            aria-pressed={isInspectorActive}
            icon={<MousePointer2 />}
          />
        )}
      </form>

      {browser.error ? (
        <div className="browser-scene__error" data-testid="browser-error-message" data-openbitfun-scene="browser" data-openbitfun-part="error">
          <AlertTriangle size={16} />
          <span>{browser.error}</span>
        </div>
      ) : null}

      <div className="browser-scene__content" data-testid="browser-page-frame" data-openbitfun-scene="browser" data-openbitfun-part="content">
        {!browser.isTauri ? (
          <iframe
            className="browser-scene__iframe"
            src={browser.currentUrl}
            title="Embedded Browser"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
          />
        ) : (
          <div
            ref={browser.viewportRef}
            className="browser-scene__webview-host"
            data-webview-label={browser.webviewLabel}
          >
            {!browser.previewUrl && !browser.offscreenLabel && (
              <div className="browser-scene__webview-placeholder">
                <Icon name="browser" size="lg" />
                <OverflowText data-testid="browser-current-url">{browser.currentUrl}</OverflowText>
              </div>
            )}
            {browser.offscreenLabel ? (
              <BrowserOffscreenSurface
                key={browser.offscreenLabel}
                label={browser.offscreenLabel}
                sharedTexture={browser.offscreenGpu}
                title={browser.currentUrl}
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

export default BrowserScene;
